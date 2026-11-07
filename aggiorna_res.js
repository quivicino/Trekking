#!/usr/bin/env node
/*
 * Qui-Trekking – sentieri della Rete Escursionistica della Sardegna (Agenzia Forestas, https://www.sardegnasentieri.it).
 * In Sardegna su OpenStreetMap ci sono pochi sentieri: qui si aggiungono quelli del catalogo Sardegna Sentieri
 * che OpenStreetMap non ha ancora. Licenza dei dati: Creative Commons BY-NC-SA (vedi le note legali del sito).
 *
 * I tracciati vengono dal servizio della mappa di Sardegna Sentieri (Webmapp, app 32):
 * - elenco:   https://geohub.webmapp.it/api/app/webapp/32/tracks_list  → { id: data ultima modifica }
 * - tracciato: https://geohub.webmapp.it/api/ec/track/{id}            → GeoJSON con nome, tempi, stato…
 * Si chiede un tracciato al secondo e solo quelli nuovi o cambiati: si riparte da dati/res/tutti.json
 * del sito pubblicato (al massimo MINUTI_MAX minuti per giro; i mancanti si prendono la settimana dopo).
 *
 * Va eseguito DOPO aggiorna_sentieri.js: i tracciati che coincidono con un sentiero già presente
 * (da OpenStreetMap) si scartano, per non mostrarli due volte.
 *
 * Scrive in dati/res/: tutti.json (tutti i tracciati, per il giro dopo), indice.json e le tessere t_i_j.json
 * con lo stesso formato di quelle di OpenStreetMap (sentieri con id "f" + numero Forestas).
 *
 * Uso: node aggiorna_res.js   (variabili d'ambiente: SITO, MINUTI_MAX=30, MAX=20 o IDS=83455,89829 per provare con pochi tracciati)
 */
"use strict";
const fs = require("fs");
const path = require("path");
const QT = require("./core.js");

const ELENCO = "https://geohub.webmapp.it/api/app/webapp/32/tracks_list";
const TRACCIATO = (id) => `https://geohub.webmapp.it/api/ec/track/${id}`;
const CARTELLA = path.join(__dirname, "dati");
const CARTELLA_RES = path.join(CARTELLA, "res");
const PASSO = 0.1;            // come le tessere di OpenStreetMap
const METRI_TRA_PUNTI = 5;    // semplificazione della traccia
const VICINO_M = 40;          // un punto è "già su OpenStreetMap" se un sentiero OSM passa a meno di 40 m
const QUOTA_DOPPIO = 0.8;     // se l'80% della traccia è già su OpenStreetMap, il tracciato si scarta
const USER_AGENT = "Qui-Trekking/1.0 (https://github.com/quivicino/Trekking)";
const LIVELLI = [245, 638];   // livelli della mappa Sardegna Sentieri: Sentieri, Cammini
const FONTE = "© Agenzia Forestas – Sardegna Sentieri (CC BY-NC-SA)";

const attendi = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 60000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: ctrl.signal });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// ---------- Dal GeoJSON di Webmapp al formato dell'app ----------
const testo = (html) => String(html || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

// La descrizione è HTML con titoletti: "Stato di validazione:", "Difficoltà:", "Descrizione:"
function sezioni(html) {
  const out = {};
  const parti = String(html || "").split(/<h3>/i);
  for (const p of parti) {
    const m = p.match(/^\s*([^<:]+):?\s*<\/h3>([\s\S]*)$/i);
    if (m) out[m[1].trim().toLowerCase()] = testo(m[2].replace(/<a [^>]*>Maggiori info<\/a>/gi, ""));
  }
  return out;
}

function statoDa(t) {
  t = (t || "").toLowerCase();
  if (/^percorribile/.test(t)) return "ok";
  if (/non percorribile|chius/.test(t)) return "no";
  if (/parzial/.test(t)) return "parz";
  return "ver";   // in revisione, in pre-accatastamento o manutenzione, non verificato
}

function difficoltaDa(t) {
  t = (t || "").toLowerCase();
  if (/attrezz/.test(t)) return "EEA";
  if (/esperti/.test(t)) return "EE";
  if (/escursionistic/.test(t)) return "E";
  if (/turistic/.test(t)) return "T";
  return "ND";
}

// "Correboi - Bruncu Spina (T 710)" → nome "Correboi - Bruncu Spina", numero "T 710"
function nomeENumero(nome, ref) {
  let n = String(nome || "").trim(), r = "";
  const m = n.match(/^(.*?)\s*\(([A-Z]{1,3}[ -]?\d{1,4}\s?[A-Z]?)\)\s*$/);
  if (m) { n = m[1].trim(); r = m[2].replace("-", " ").replace(/(\d)\s+([A-Z])$/, "$1$2"); }
  else if (ref && !/^Z-/.test(ref)) r = ref;
  else if (ref) r = ref.replace(/^Z-[A-Z]{2}-/, "").replace("-", " ").replace(/-/g, "");
  return { n, r };
}

function semplifica(linea) {
  if (linea.length <= 2) return linea;
  const out = [linea[0]];
  for (let i = 1; i < linea.length - 1; i++) {
    const u = out[out.length - 1];
    if (QT.distanza(u[0], u[1], linea[i][0], linea[i][1]) >= METRI_TRA_PUNTI) out.push(linea[i]);
  }
  out.push(linea[linea.length - 1]);
  return out;
}

function compatta(f) {
  const p = f.properties || {}, g = f.geometry || {};
  const linee = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates : [];
  const tratti = linee.map((l) => semplifica(l.filter((c) => c && c.length >= 2).map((c) => [+(+c[1]).toFixed(5), +(+c[0]).toFixed(5)])))
    .filter((l) => l.length >= 2);
  if (!tratti.length) return null;
  // solo i livelli "Sentieri" (245) e "Cammini" (638): gli "Itinerari" (244) sono giri fatti con quei sentieri
  const livelli = p.layers || [];
  if (livelli.length && !livelli.some((l) => LIVELLI.includes(l))) return null;
  const att = ((p.taxonomy && p.taxonomy.activity) || []).map((a) => (a.name && a.name.it) || "").join(" ");
  // solo escursionismo (si scartano i tracciati solo per bici o cavallo)
  if (att && !/escursion|trekking|walking|passegg/i.test(att)) return null;
  const sez = sezioni(p.description && p.description.it);
  const lunghezza = Math.round(tratti.reduce((s, l) => s + QT.lunghezzaLinea(l), 0));
  const { n, r } = nomeENumero(p.name && p.name.it, p.ref);
  const s = { i: "f" + p.id, g: tratti, d: difficoltaDa(sez["difficoltà"]), l: p.distance ? Math.round(p.distance * 1000) : lunghezza, lv: lunghezza };
  if (p.distance) s.lt = 1;
  if (r) s.r = r;
  if (n) s.n = n;
  if (p.from && p.to) { s.da = testo(p.from); s.a = testo(p.to); }
  if (p.ascent != null) s.su = Math.round(p.ascent);
  if (p.descent != null) s.giu = Math.round(p.descent);
  if (p.roundtrip) s.anello = 1;
  s.o = "Agenzia Forestas – Rete Escursionistica della Sardegna";
  // stato, tempi e scheda: nello stesso posto dei dati del Catasto CAI, così la scheda li mostra allo stesso modo
  const x = { s: statoDa(sez["stato di validazione"]), st: sez["stato di validazione"] || "" };
  if (p.duration_forward) x.af = p.duration_forward;
  if (p.duration_backward) x.ar = p.duration_backward;
  const scheda = p.related_url && Object.values(p.related_url)[0];
  if (scheda) x.u = scheda;
  s.x = x;
  const descr = sez["descrizione"];
  if (descr) s.nota = descr.length > 400 ? descr.slice(0, 397).replace(/\s+\S*$/, "") + "…" : descr;
  return s;
}

// ---------- Già su OpenStreetMap? ----------
// Griglia dei punti dei sentieri OSM (celle di circa 0,0005°) per sapere in fretta se un punto ha un sentiero vicino.
function grigliaOsm() {
  const griglia = new Set();
  let indice;
  try { indice = JSON.parse(fs.readFileSync(path.join(CARTELLA, "indice.json"), "utf8")); } catch (e) { return null; }
  const C = 0.0005;
  for (const t of indice.tessere || []) {
    let cont;
    try { cont = JSON.parse(fs.readFileSync(path.join(CARTELLA, t), "utf8")); } catch (e) { continue; }
    for (const s of cont.s || []) for (const l of s.g) {
      for (let k = 0; k < l.length; k++) {
        griglia.add(Math.floor(l[k][0] / C) + "_" + Math.floor(l[k][1] / C));
        // tra due punti lontani si aggiungono punti intermedi
        if (k) {
          const [a, b] = [l[k - 1], l[k]];
          const passi = Math.floor(QT.distanza(a[0], a[1], b[0], b[1]) / 25);
          for (let j = 1; j < passi; j++) {
            const la = a[0] + (b[0] - a[0]) * j / passi, lo = a[1] + (b[1] - a[1]) * j / passi;
            griglia.add(Math.floor(la / C) + "_" + Math.floor(lo / C));
          }
        }
      }
    }
  }
  // un punto è vicino a un sentiero OSM se la sua cella o una delle 8 intorno ha un punto OSM (~40-55 m)
  return (la, lo) => {
    const i = Math.floor(la / C), j = Math.floor(lo / C);
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (griglia.has((i + di) + "_" + (j + dj))) return true;
    return false;
  };
}

function quotaSuOsm(s, vicino) {
  let tot = 0, su = 0;
  for (const l of s.g) {
    let ultimo = null;
    for (const p of l) {
      if (ultimo && QT.distanza(ultimo[0], ultimo[1], p[0], p[1]) < 50) continue;   // un punto ogni 50 m circa
      ultimo = p;
      tot++;
      if (vicino(p[0], p[1])) su++;
    }
  }
  return tot ? su / tot : 0;
}

// ---------- Tessere ----------
const nomeTessera = (lat, lon) => `t_${Math.floor(lat / PASSO)}_${Math.floor(lon / PASSO)}.json`;

function scriviTessere(sentieri, tutti) {
  const tessere = new Map();
  const prendi = (t) => { if (!tessere.has(t)) tessere.set(t, { s: [], r: {} }); return tessere.get(t); };
  for (const s of sentieri) {
    const casa = nomeTessera(s.g[0][0][0], s.g[0][0][1]);
    prendi(casa).s.push(s);
    const attraversate = new Set();
    for (const l of s.g) for (const [la, lo] of l) attraversate.add(nomeTessera(la, lo));
    attraversate.delete(casa);
    for (const t of attraversate) prendi(t).r[s.i] = casa;
  }
  fs.rmSync(CARTELLA_RES, { recursive: true, force: true });
  fs.mkdirSync(CARTELLA_RES, { recursive: true });
  for (const [t, c] of tessere) fs.writeFileSync(path.join(CARTELLA_RES, t), JSON.stringify(c));
  fs.writeFileSync(path.join(CARTELLA_RES, "tutti.json"), JSON.stringify(tutti));
  fs.writeFileSync(path.join(CARTELLA_RES, "indice.json"), JSON.stringify({
    passo: PASSO,
    aggiornato: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    sentieri: sentieri.length,
    tessere: [...tessere.keys()].sort(),
    fonte: FONTE,
    licenza: "Creative Commons Attribuzione - Non commerciale - Condividi allo stesso modo",
    licenzaUrl: "https://www.sardegnasentieri.it/pagina-base/note-legali",
    sito: "https://www.sardegnasentieri.it",
    generatoDa: "https://github.com/quivicino/Trekking"
  }, null, 1));
  return tessere.size;
}

// ---------- Giro ----------
async function main() {
  const sito = process.env.SITO;
  const scadenza = Date.now() + (+process.env.MINUTI_MAX || 30) * 60000;

  // tracciati già scaricati la volta prima (pubblicati nel sito)
  let vecchi = {};
  if (sito) {
    try {
      vecchi = await json(sito.replace(/\/?$/, "/") + "dati/res/tutti.json", 60000);
      console.log(`Ripartito da ${Object.keys(vecchi).length} tracciati già pubblicati`);
    } catch (e) {
      console.log(`Nessun tracciato pubblicato (${e.message}): li scarico tutti`);
    }
  }

  let elenco;
  try {
    elenco = await json(ELENCO, 60000);
  } catch (e) {
    console.log(`Elenco di Sardegna Sentieri non disponibile (${e.message}): tengo quelli già pubblicati`);
    elenco = Object.fromEntries(Object.entries(vecchi).map(([id, v]) => [id, v.agg]));
  }
  // per provare: IDS=83455,89829 scarica solo quei tracciati
  const ids = process.env.IDS ? process.env.IDS.split(",").filter((id) => id in elenco) : Object.keys(elenco);
  console.log(`Sardegna Sentieri: ${ids.length} tracciati nell'elenco`);

  const tutti = {};   // id → { agg, s (null se scartato perché non escursionistico) }
  let nuovi = 0, errori = 0, rimandati = 0;
  const max = +process.env.MAX || Infinity;
  for (const id of ids) {
    const v = vecchi[id];
    if (v && v.agg === elenco[id]) { tutti[id] = v; continue; }
    if (Date.now() > scadenza || nuovi >= max) { if (v) tutti[id] = v; rimandati++; continue; }
    try {
      const f = await json(TRACCIATO(id), 60000);
      tutti[id] = { agg: elenco[id], s: compatta(f) };
      nuovi++;
    } catch (e) {
      console.log(`  tracciato ${id}: ${e.message}`);
      if (v) tutti[id] = v;
      errori++;
    }
    await attendi(1000);   // un tracciato al secondo, per non pesare sul servizio
  }
  console.log(`Scaricati ${nuovi} tracciati nuovi o cambiati` + (errori ? `, ${errori} non riusciti` : "") + (rimandati ? `, ${rimandati} rimandati al prossimo giro` : ""));

  const vicino = grigliaOsm();
  if (!vicino) console.log("Dati di OpenStreetMap non trovati in dati/: non scarto i tracciati doppi");
  const tenuti = [];
  let doppi = 0;
  for (const { s } of Object.values(tutti)) {
    if (!s) continue;
    if (vicino && quotaSuOsm(s, vicino) >= QUOTA_DOPPIO) { doppi++; continue; }
    tenuti.push(s);
  }
  const n = scriviTessere(tenuti, tutti);
  console.log(`Tenuti ${tenuti.length} tracciati (${doppi} già su OpenStreetMap) in ${n} tessere`);
}

if (require.main === module) {
  main().catch((e) => { console.log(`Sardegna Sentieri non aggiornato: ${e.message}`); process.exitCode = 1; });
} else module.exports = { compatta, sezioni, nomeENumero, statoDa, difficoltaDa, quotaSuOsm };
