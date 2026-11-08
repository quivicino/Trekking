/*
 * Qui-Trekking – dati del Catasto sentieri CAI (OSM2CAI, https://osm2cai.cai.it) per Lombardia, Valle d'Aosta e Sardegna.
 * Per ogni sentiero (chiave = numero della relazione OpenStreetMap): percorribilità con nota e data,
 * tempi di percorrenza nei due sensi, salita e discesa. Scrive dati/cai.json, letto dall'app nella scheda.
 *
 * OSM2CAI va interrogato un sentiero alla volta: si riparte dal file già pubblicato sul sito e si
 * richiedono solo i sentieri nuovi o cambiati (l'elenco dice quando è cambiato ciascuno).
 * Se OSM2CAI non risponde resta il file pubblicato; se manca anche quello, l'app fa a meno di questi dati.
 *
 * Uso: node aggiorna_cai.js   (variabili d'ambiente: SITO, MINUTI_MAX=45)
 */
"use strict";
const fs = require("fs");
const path = require("path");

const API = "https://osm2cai.cai.it/api";
// Regioni nella numerazione di OSM2CAI (trovate interrogando l'API il 6/11/2026):
// A Friuli Venezia Giulia, B Veneto, C Trentino-Alto Adige, D Lombardia, E Piemonte, F Valle d'Aosta,
// G Liguria, H Emilia-Romagna, L Toscana, M Marche, N Umbria, O Lazio, P Abruzzo, Q Molise,
// R Puglia, S Campania, T Basilicata, U Calabria, V Sicilia, Z Sardegna
// Tutta l'Italia, come i sentieri (copia del computer di paolo). La prima volta servono più giri:
// ogni giro chiede al massimo MINUTI_MAX minuti di sentieri, i mancanti si prendono la volta dopo.
const REGIONI = ["A", "B", "C", "D", "E", "F", "G", "H", "L", "M", "N", "O", "P", "Q", "R", "S", "T", "U", "V", "Z"];
const STATI = [1, 2, 3, 4];       // stato di accatastamento: 4 = validato dal CAI
const CARTELLA = path.join(__dirname, "dati");
const FILE = path.join(CARTELLA, "cai.json");
const USER_AGENT = "Qui-Trekking/1.0 (https://github.com/quivicino/Trekking)";
// OSM2CAI accetta 60 richieste al minuto: una alla volta, poco più di una al secondo.
// La prima volta (circa 4.000 sentieri) ci vogliono più giri; poi solo i pochi cambiati.
const PAUSA_MS = 1050;
const scadenza = Date.now() + (+process.env.MINUTI_MAX || 45) * 60000;
const attendi = (ms) => new Promise((r) => setTimeout(r, ms));

async function json(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || 30000);
  try {
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: ctrl.signal });
    if (r.status === 429) { const e = new Error("HTTP 429"); e.attesa = (+r.headers.get("retry-after") || 30) * 1000; throw e; }
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// "percorribile", "non percorribile", "percorribile parzialmente", "sconosciuto" → ok / no / parz / (niente)
function stato(t) {
  t = String(t || "").toLowerCase();
  if (t.includes("non")) return "no";
  if (t.includes("parz")) return "parz";
  if (t.includes("percorribile")) return "ok";
  return null;
}
const minuti = (v) => (isFinite(+v) && +v > 0 ? Math.round(+v) : undefined);
const metri = (v) => (v != null && v !== "" && isFinite(+v) ? Math.round(+v) : undefined);

function riduci(id, agg, p) {
  const v = { id: +id, u: agg };
  const s = stato(p.issues_status);
  if (s) v.s = s;
  const nota = String(p.issues_description || "").trim();
  if (nota && s && s !== "ok") v.n = nota.slice(0, 400);
  if (s && p.issues_last_update) v.d = String(p.issues_last_update).slice(0, 10);
  v.af = minuti(p.duration_forward);
  v.ar = minuti(p.duration_backward);
  v.su = metri(p.ascent);
  v.giu = metri(p.descent);
  if (+p.sda === 4) v.val = 1;
  for (const k of Object.keys(v)) if (v[k] === undefined) delete v[k];
  return v;
}

let vecchi = {};
const scrivi = (sentieri, aggiornato) =>
  fs.writeFileSync(FILE, JSON.stringify({ fonte: "OSM2CAI – Catasto sentieri CAI", aggiornato, sentieri }));

async function main() {
  fs.mkdirSync(CARTELLA, { recursive: true });
  const sito = process.env.SITO;
  if (sito) {
    try {
      const pubblicato = await json(sito.replace(/\/?$/, "/") + "dati/cai.json", 30000);
      vecchi = pubblicato.sentieri || {};
      vecchi.__aggiornato = pubblicato.aggiornato;
      console.log(`Dati CAI già pubblicati: ${Object.keys(vecchi).length} sentieri`);
    } catch (e) {
      console.log(`Nessun dato CAI pubblicato (${e.message}): li scarico tutti.`);
    }
  }

  // elenco: id OSM2CAI → data dell'ultima modifica
  const elenco = {};
  // con tutte le regioni sono 80 richieste: anche queste una al secondo, e se OSM2CAI dice "troppe" (429) si aspetta
  for (const reg of REGIONI) {
    for (const sda of STATI) {
      for (let prova = 1; ; prova++) {
        const t0 = Date.now();
        try {
          Object.assign(elenco, await json(`${API}/v2/hiking-routes/region/${reg}/${sda}`, 120000));
          await attendi(Math.max(0, PAUSA_MS - (Date.now() - t0)));
          break;
        } catch (e) {
          if (!e.attesa || prova >= 5) throw e;
          console.log(`  elenco ${reg}/${sda}: troppe richieste, aspetto ${Math.round(e.attesa / 1000)} s`);
          await attendi(e.attesa);
        }
      }
    }
  }
  const ids = Object.keys(elenco);
  console.log(`OSM2CAI: ${ids.length} sentieri nelle regioni ${REGIONI.join(", ")}`);

  const quandoVecchi = vecchi.__aggiornato;
  delete vecchi.__aggiornato;
  const perId = new Map(Object.entries(vecchi).map(([rel, v]) => [String(v.id), [rel, v]]));
  const sentieri = {};
  const daChiedere = [];
  for (const id of ids) {
    const prima = perId.get(id);
    if (prima && prima[1].u === elenco[id]) sentieri[prima[0]] = prima[1];
    else daChiedere.push(id);
  }
  console.log(`  da richiedere (nuovi o cambiati): ${daChiedere.length}`);

  let fatti = 0, errori = 0;
  while (daChiedere.length && Date.now() < scadenza) {
    const id = daChiedere[0];
    const t0 = Date.now();
    try {
      const p = (await json(`${API}/v2/hiking-route/${id}`, 30000)).properties || {};
      const rel = p.relation_id || p.osm_id;
      if (rel) sentieri[rel] = riduci(id, elenco[id], p);
      daChiedere.shift();
      fatti++;
    } catch (e) {
      if (e.attesa) { await attendi(e.attesa); continue; }   // troppe richieste: aspetto e riprovo lo stesso
      daChiedere.shift();
      errori++;
      const prima = perId.get(id);
      if (prima) sentieri[prima[0]] = prima[1];   // tengo il dato vecchio
    }
    if ((fatti + errori) % 500 === 0) console.log(`  … ${fatti + errori}`);
    await attendi(Math.max(0, PAUSA_MS - (Date.now() - t0)));
  }
  // quelli rimasti per mancanza di tempo: resta il dato vecchio, il prossimo giro li riprende
  for (const id of daChiedere) { const prima = perId.get(id); if (prima) sentieri[prima[0]] = prima[1]; }

  const n = Object.keys(sentieri).length;
  if (!n) throw new Error("nessun dato CAI");
  scrivi(sentieri, fatti ? new Date().toISOString() : quandoVecchi || new Date().toISOString());
  const conta = (s) => Object.values(sentieri).filter((v) => v.s === s).length;
  console.log(`Scritto dati/cai.json: ${n} sentieri (richiesti ${fatti}, errori ${errori}, rimandati ${daChiedere.length}); ` +
    `percorribili ${conta("ok")}, in parte ${conta("parz")}, non percorribili ${conta("no")}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.log(`Dati CAI non aggiornati: ${e.message}`);
    // OSM2CAI non risponde: si ripubblica il file della settimana prima, se c'era
    const agg = vecchi.__aggiornato; delete vecchi.__aggiornato;
    if (Object.keys(vecchi).length) { scrivi(vecchi, agg); console.log("  ripubblico i dati CAI precedenti"); }
    process.exitCode = 1;
  });
}
module.exports = { stato, riduci };
