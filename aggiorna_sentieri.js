#!/usr/bin/env node
/*
 * Qui-Trekking – scarica da OpenStreetMap (Overpass) sentieri, rifugi, bivacchi, fontanelle e sorgenti di tutta
 * la Lombardia, la Valle d'Aosta e la Sardegna (più 15 km oltre i confini) e li salva nel sito, divisi in "tessere" da 0,1 gradi.
 * Dentro queste regioni l'app legge da qui e non dipende dai server pubblici di OpenStreetMap, spesso lenti o fuori uso.
 *
 * Lo esegue GitHub (vedi .github/workflows/pubblica.yml): ogni lunedì riscarica tutto, a blocchi di mezzo grado
 * per non chiedere troppo in una volta sola a Overpass. I dati NON vengono salvati nel repository, finiscono solo
 * nel sito pubblicato (come in Qui-Pets): nelle altre pubblicazioni, o se Overpass non risponde, si ricopiano
 * quelli già pubblicati.
 *
 * Per risparmiare spazio:
 * - ogni sentiero è salvato una volta sola, nella tessera dove inizia ("casa"); le altre tessere che attraversa
 *   ne hanno solo il numero e la tessera di casa, e l'app la scarica quando serve;
 * - la traccia è semplificata: si tiene un punto ogni circa 5 metri.
 *
 * Uso: node aggiorna_sentieri.js   (variabili d'ambiente: SITO, FORZA=1, ESITO, MINUTI_MAX=270, BLOCCHI=21,22 per provare con pochi blocchi)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const QT = require("./core.js");

// Regioni salvate nel sito (riquadri che le contengono) e quanto prendere oltre i confini
const LOMBARDIA = [44.68, 8.50, 46.64, 11.43];
const VALLE_AOSTA = [45.46, 6.80, 45.99, 7.94];
const SARDEGNA = [38.85, 8.12, 41.32, 9.84];   // con le isole minori (Asinara, La Maddalena, San Pietro)
const ZONE = [LOMBARDIA, VALLE_AOSTA, SARDEGNA];   // zone scaricate da Overpass (riserva)
// Con la copia del computer di paolo (PBF Italia di Geofabrik) si salva tutta l'Italia
const ITALIA = [35.28, 6.62, 47.10, 18.53];
const COPIA_PC = process.env.COPIA_PC || "https://github.com/quivicino/Trekkiing/releases/download/dati-osm/trekking.json.gz";
const GIORNI_COPIA = 3;      // la copia vale se i dati OSM hanno meno di 3 giorni
const MARGINE_KM = 15;
const BLOCCO = 0.5;          // lato dei blocchi chiesti a Overpass, in gradi
const PASSO = 0.1;           // lato delle tessere del sito, in gradi (circa 11 × 8 km)
const METRI_TRA_PUNTI = 5;   // semplificazione della traccia
const ORE_VALIDI = 6 * 24;   // i dati pubblicati da meno di 6 giorni non si riscaricano (salvo FORZA)
// Da aumentare quando cambia il formato dei file: i dati pubblicati con un'altra versione si riscaricano subito
const VERSIONE_DATI = 2;
const CARTELLA = path.join(__dirname, "dati");
const USER_AGENT = "Qui-Trekking/1.0 (https://github.com/quivicino/Trekking)";
const SERVER = [
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter"
];

const attendi = (ms) => new Promise((r) => setTimeout(r, ms));

function allarga([s, w, n, e]) {
  const dLat = MARGINE_KM / 111.32;
  const dLon = MARGINE_KM / (111.32 * Math.cos(((s + n) / 2) * Math.PI / 180));
  return [s - dLat, w - dLon, n + dLat, e + dLon].map((x) => +x.toFixed(4));
}

function blocchi([s, w, n, e]) {
  const out = [];
  for (let la = s; la < n; la += BLOCCO) {
    for (let lo = w; lo < e; lo += BLOCCO) {
      out.push([la, lo, Math.min(la + BLOCCO, n), Math.min(lo + BLOCCO, e)].map((x) => +x.toFixed(4)));
    }
  }
  return out;
}

async function scarica(url, opz, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { ...opz, headers: { "User-Agent": USER_AGENT, ...(opz && opz.headers) }, signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r;
  } finally {
    clearTimeout(t);
  }
}

// Prova i server a turno (2 giri). Si ferma prima se si supera "scadenza" (ora limite in millisecondi).
async function daOverpass(query, scadenza) {
  let ultimo;
  for (let giro = 0; giro < 2; giro++) {
    for (const url of SERVER) {
      const resta = (scadenza || Infinity) - Date.now();
      if (resta < 60000) throw new Error("tempo massimo superato");
      try {
        const r = await scarica(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: "data=" + encodeURIComponent(query)
        }, Math.min(4 * 60000, resta));
        const dati = await r.json();
        if (!Array.isArray(dati.elements)) throw new Error("risposta senza elementi");
        if (dati.remark && /error|timed out|out of memory|rate/i.test(dati.remark)) throw new Error(dati.remark);
        console.log(`  ok da ${url}: ${dati.elements.length} elementi`);
        return dati.elements;
      } catch (e) {
        ultimo = e;
        console.log(`  ${url}: ${e.message}`);
      }
    }
    if (giro === 0) await attendi(30000);
  }
  throw new Error("nessun server ha risposto: " + (ultimo && ultimo.message));
}

// Un sentiero che attraversa più blocchi arriva ritagliato in ogni blocco: la traccia di ogni via ha null nei
// punti fuori dal blocco. Si uniscono le vie punto per punto, così la traccia torna intera.
function unisciBlocchi(raccolta, elementi) {
  for (const el of elementi) {
    if (el.type === "relation") {
      let r = raccolta.rel.get(el.id);
      if (!r) { r = { tags: el.tags, membri: [] }; raccolta.rel.set(el.id, r); }
      (el.members || []).forEach((m, i) => {
        if (m.type !== "way") return;
        const k = i + ":" + m.ref;
        let v = r.membri.find((x) => x.k === k);
        if (!v) { v = { k, type: "way", ref: m.ref, role: m.role, geometry: null }; r.membri.push(v); }
        if (!m.geometry) return;
        if (!v.geometry) v.geometry = m.geometry.slice();
        else m.geometry.forEach((g, j) => { if (g && !v.geometry[j]) v.geometry[j] = g; });
      });
    } else {
      const p = QT.compatta(el);
      if (p) raccolta.punti.set(p.i, p);
    }
  }
}

// Tiene un punto ogni METRI_TRA_PUNTI metri (sempre il primo e l'ultimo)
function semplifica(l) {
  if (l.length < 3) return l;
  const out = [l[0]];
  for (let i = 1; i < l.length - 1; i++) {
    const u = out[out.length - 1];
    if (QT.distanza(u[0], u[1], l[i][0], l[i][1]) >= METRI_TRA_PUNTI) out.push(l[i]);
  }
  out.push(l[l.length - 1]);
  return out;
}

const nomeTessera = (lat, lon) => `t_${Math.floor(lat / PASSO)}_${Math.floor(lon / PASSO)}.json`;

function salva(raccolta, zona, zone = ZONE, datiOsm = null) {
  const tessere = new Map();
  const prendi = (t) => { if (!tessere.has(t)) tessere.set(t, { s: [], r: {}, p: [] }); return tessere.get(t); };
  let nSentieri = 0, puntiPrima = 0, puntiDopo = 0;
  for (const [id, r] of raccolta.rel) {
    const s = QT.compattaSentiero({ type: "relation", id, tags: r.tags, members: r.membri });
    if (!s) continue;
    for (const l of s.g) puntiPrima += l.length;
    s.g = s.g.map(semplifica);
    for (const l of s.g) puntiDopo += l.length;
    const casa = nomeTessera(s.g[0][0][0], s.g[0][0][1]);
    prendi(casa).s.push(s);
    const attraversate = new Set();
    for (const l of s.g) for (const [la, lo] of l) attraversate.add(nomeTessera(la, lo));
    attraversate.delete(casa);
    for (const t of attraversate) prendi(t).r[s.i] = casa;
    nSentieri++;
  }
  for (const p of raccolta.punti.values()) prendi(nomeTessera(p.la, p.lo)).p.push(p);
  console.log(`Traccia semplificata: ${puntiPrima} → ${puntiDopo} punti`);

  fs.rmSync(CARTELLA, { recursive: true, force: true });
  fs.mkdirSync(CARTELLA, { recursive: true });
  let byte = 0;
  for (const [t, cont] of tessere) {
    const testo = JSON.stringify(cont);
    byte += testo.length;
    fs.writeFileSync(path.join(CARTELLA, t), testo);
  }
  const indice = {
    versioneDati: VERSIONE_DATI,
    passo: PASSO,
    zona: LOMBARDIA,        // per le versioni dell'app che conoscono un solo riquadro
    zone,                   // dentro questi riquadri l'app usa i dati del sito
    datiOsm,                // data dei dati della copia del computer (null = da Overpass)
    scaricata: zona,
    mancanti: [],           // blocchi non scaricati e senza dati vecchi: lì l'app chiede a Overpass
    aggiornato: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    sentieri: nSentieri,
    punti: raccolta.punti.size,
    tessere: [...tessere.keys()].sort(),
    fonte: "© OpenStreetMap contributors (ODbL)",
    licenza: "Open Database License (ODbL) 1.0",
    licenzaUrl: "https://opendatacommons.org/licenses/odbl/1-0/",
    generatoDa: "https://github.com/quivicino/Trekking"
  };
  scriviIndice(indice);
  console.log(`Salvati ${nSentieri} sentieri e ${raccolta.punti.size} punti in ${tessere.size} tessere (${(byte / 1048576).toFixed(1)} MB)`);
}

const scriviIndice = (indice) => fs.writeFileSync(path.join(CARTELLA, "indice.json"), JSON.stringify(indice, null, 1));

// Scarica i blocchi uno dopo l'altro. Un blocco che non risponde viene saltato; superato il tempo massimo
// (MINUTI_MAX) si saltano i rimanenti. Restituisce i blocchi mancanti.
async function scaricaTutto() {
  const scadenza = Date.now() + (+process.env.MINUTI_MAX || 270) * 60000;
  const zona = ZONE.map(allarga);
  let lista = zona.flatMap(blocchi);
  // per provare: BLOCCHI=21,22 scarica solo quei blocchi
  if (process.env.BLOCCHI) lista = process.env.BLOCCHI.split(",").map((i) => lista[+i]).filter(Boolean);
  const raccolta = { rel: new Map(), punti: new Map() };
  const falliti = [];
  for (const [i, b] of lista.entries()) {
    console.log(`Blocco ${i + 1} di ${lista.length}: ${b.join(", ")}`);
    try {
      unisciBlocchi(raccolta, await daOverpass(QT.queryOverpass(b, 180), scadenza));
    } catch (e) {
      console.log(`  blocco saltato: ${e.message}`);
      falliti.push(b);
    }
  }
  if (falliti.length === lista.length) throw new Error("nessun blocco scaricato");
  salva(raccolta, zona);
  segnaMancanti(falliti);
  if (falliti.length) console.log(`Blocchi mancanti: ${falliti.length} di ${lista.length}`);
  return falliti;
}

// Scrive nell'indice i blocchi senza dati: lì l'app non usa il sito ma chiede direttamente a Overpass
function segnaMancanti(blocchi) {
  const indice = JSON.parse(fs.readFileSync(path.join(CARTELLA, "indice.json"), "utf8"));
  indice.mancanti = blocchi;
  scriviIndice(indice);
}

// Per i blocchi non scaricati rimette le tessere della pubblicazione precedente (se c'è ed è della stessa versione)
async function riempiBuchi(falliti, sito) {
  const { base, indice: vecchio } = await indicePubblicato(sito);
  if (vecchio.versioneDati !== VERSIONE_DATI) throw new Error("i dati pubblicati sono di un'altra versione");
  const dentro = (t) => {
    const [, i, j] = t.match(/^t_(-?\d+)_(-?\d+)\.json$/).map(Number);
    const la = (i + 0.5) * PASSO, lo = (j + 0.5) * PASSO;
    return falliti.some(([s, w, n, e]) => la >= s && la < n && lo >= w && lo < e);
  };
  const indice = JSON.parse(fs.readFileSync(path.join(CARTELLA, "indice.json"), "utf8"));
  const tessere = new Set(indice.tessere);
  let n = 0;
  for (const t of vecchio.tessere.filter(dentro)) {
    try {
      const r = await scarica(base + t, {}, 60000);
      fs.writeFileSync(path.join(CARTELLA, t), Buffer.from(await r.arrayBuffer()));
      tessere.add(t);
      n++;
    } catch (e) {
      console.log(`  ${t}: ${e.message}`);
    }
  }
  indice.tessere = [...tessere].sort();
  // i blocchi fuori dalla zona scaricata la volta prima (per esempio una regione appena aggiunta) restano senza dati
  const vecchiaZona = Array.isArray(vecchio.scaricata && vecchio.scaricata[0]) ? vecchio.scaricata : [vecchio.scaricata || []];
  const coperto = ([s, w, n, e]) => vecchiaZona.some(([zs, zw, zn, ze]) => s >= zs && n <= zn && w >= zw && e <= ze);
  indice.mancanti = falliti.filter((b) => !coperto(b));
  scriviIndice(indice);
  console.log(`Rimesse ${n} tessere della pubblicazione del ${vecchio.aggiornato} nei blocchi mancanti`);
}

// ---------- Dati già pubblicati ----------
async function indicePubblicato(sito) {
  if (!sito) throw new Error("indirizzo del sito non indicato");
  const base = sito.replace(/\/?$/, "/") + "dati/";
  const r = await scarica(base + "indice.json", {}, 20000);
  return { base, indice: await r.json() };
}

async function recuperaDalSito(sito) {
  const { base, indice } = await indicePubblicato(sito);
  if (indice.versioneDati !== VERSIONE_DATI) throw new Error("i dati pubblicati sono di un'altra versione");
  console.log(`Ricopio i dati già pubblicati da ${base} (aggiornati ${indice.aggiornato}) …`);
  fs.rmSync(CARTELLA, { recursive: true, force: true });
  fs.mkdirSync(CARTELLA, { recursive: true });
  const coda = indice.tessere.slice();
  async function lavoratore() {
    while (coda.length) {
      const t = coda.shift();
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        try {
          const r = await scarica(base + t, {}, 60000);
          fs.writeFileSync(path.join(CARTELLA, t), Buffer.from(await r.arrayBuffer()));
          ok = true;
        } catch (e) {
          console.log(`  ${t}: ${e.message}`);
          await attendi(3000);
        }
      }
      if (!ok) throw new Error(`tessera ${t} non recuperata`);
    }
  }
  await Promise.all(Array.from({ length: 8 }, lavoratore));
  scriviIndice(indice);
  console.log(`  ricopiate ${indice.tessere.length} tessere`);
}

// Riga "stato;aggiornato;sentieri" per la notifica sull'iPhone:
// nuovi = riscaricati, parziale = riscaricati in parte (alcuni blocchi non hanno risposto),
// recenti = ricopiati perché non serviva riscaricarli, ripiego = Overpass non ha risposto
function scriviEsito(stato) {
  if (!process.env.ESITO) return;
  let indice = {};
  try { indice = JSON.parse(fs.readFileSync(path.join(CARTELLA, "indice.json"), "utf8")); } catch (e) { /* nessun indice */ }
  fs.writeFileSync(process.env.ESITO, `${stato};${indice.aggiornato || ""};${indice.sentieri || ""}\n`);
}

// ---------- Copia del computer di paolo ----------
// osm_italia.py estrae ogni giorno dal PBF Italia gli stessi oggetti della query Overpass e li carica
// sulla release dati-osm. Le tracce sono complete, quindi basta unirle come un unico grande blocco.
async function daCopiaPc() {
  console.log(`Scarico la copia del computer: ${COPIA_PC} …`);
  const r = await scarica(COPIA_PC, {}, 10 * 60000);
  const dati = JSON.parse(require("zlib").gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8"));
  const base = dati.osm3s && dati.osm3s.timestamp_osm_base;
  const giorni = (Date.now() - Date.parse(base)) / 86400000;
  if (!(giorni < GIORNI_COPIA)) throw new Error(`copia troppo vecchia (dati OSM del ${base})`);
  const n = (dati.elements || []).length;
  if (n < 5000) throw new Error(`troppo pochi elementi (${n}): copia incompleta?`);
  console.log(`  ${n} elementi, dati OSM del ${base}`);
  return { elementi: dati.elements, base };
}

// "fatto" = dati pubblicati; "no" = copia non disponibile
async function usaCopiaPc(sito, pubblicato) {
  let copia;
  try {
    copia = await daCopiaPc();
  } catch (e) {
    console.log(`Copia del computer non disponibile (${e.message}).`);
    return "no";
  }
  if (pubblicato && pubblicato.datiOsm === copia.base && pubblicato.versioneDati === VERSIONE_DATI) {
    try {
      console.log("I dati della copia sono già pubblicati: li ricopio dal sito.");
      await recuperaDalSito(sito);
      scriviEsito("recenti");
      return "fatto";
    } catch (e) { /* si rifanno dalla copia */ }
  }
  const raccolta = { rel: new Map(), punti: new Map() };
  unisciBlocchi(raccolta, copia.elementi);
  salva(raccolta, [ITALIA], [ITALIA], copia.base);
  scriviEsito("nuovi");
  return "fatto";
}

async function main() {
  const sito = process.env.SITO;
  const forza = process.env.FORZA === "1" || process.env.FORZA === "true";
  let pubblicato = null;
  try { pubblicato = (await indicePubblicato(sito)).indice; } catch (e) { /* nessun dato pubblicato */ }
  if (await usaCopiaPc(sito, pubblicato) === "fatto") return;
  // Copia non disponibile ma sul sito ci sono già i dati di tutta l'Italia presi dal computer:
  // si tengono quelli (riscaricare da Overpass solo tre regioni ridurrebbe la zona coperta).
  if (pubblicato && pubblicato.datiOsm && !forza) {
    try {
      console.log(`Tengo i dati pubblicati (copia del computer del ${pubblicato.datiOsm}).`);
      await recuperaDalSito(sito);
      scriviEsito("ripiego");
      return;
    } catch (e) {
      console.log(`Dati pubblicati non ricopiabili (${e.message}): uso Overpass.`);
    }
  }
  if (!forza) {
    try {
      const { indice } = await indicePubblicato(sito);
      const ore = (Date.now() - Date.parse(indice.aggiornato)) / 3600000;
      if (indice.versioneDati !== VERSIONE_DATI) {
        console.log("I dati pubblicati sono di una versione precedente: li riscarico da Overpass.");
      } else if (JSON.stringify(indice.zone) !== JSON.stringify(ZONE)) {
        console.log("Le regioni salvate sono cambiate: riscarico i dati da Overpass.");
      } else if (ore < ORE_VALIDI) {
        console.log(`Dati pubblicati ${ore.toFixed(1)} ore fa: non serve riscaricarli.`);
        await recuperaDalSito(sito);
        scriviEsito("recenti");
        return;
      }
    } catch (e) {
      console.log(`Dati pubblicati non disponibili (${e.message}): li scarico da Overpass.`);
    }
  }
  let falliti;
  try {
    falliti = await scaricaTutto();
  } catch (e) {
    console.log(`Overpass non disponibile: ${e.message}`);
    try {
      await recuperaDalSito(sito);
      scriviEsito("ripiego");
    } catch (e2) {
      console.log(`Nessun dato disponibile: ${e2.message}. L'app userà Overpass direttamente.`);
      process.exitCode = 1;
    }
    return;
  }
  if (falliti.length) {
    try {
      await riempiBuchi(falliti, sito);
    } catch (e) {
      console.log(`Blocchi mancanti lasciati vuoti (${e.message}): lì l'app userà Overpass direttamente.`);
    }
  }
  scriviEsito(falliti.length ? "parziale" : "nuovi");
}

if (require.main === module) main();
else module.exports = { ITALIA, daCopiaPc, LOMBARDIA, VALLE_AOSTA, SARDEGNA, ZONE, allarga, blocchi, unisciBlocchi, semplifica, salva, riempiBuchi };
