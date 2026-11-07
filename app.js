/*
 * Qui-Trekking – interfaccia: mappa, posizione, caricamento di sentieri e punti, elenco.
 * Stessa struttura di Qui-Pets e Distributori.
 */
(function () {
  "use strict";
  const cfg = window.QT_CONFIG;
  const $ = (id) => document.getElementById(id);
  const PREF = "trekking.";
  const leggiPref = (k, def) => { try { const v = localStorage.getItem(PREF + k); return v === null ? def : v; } catch (e) { return def; } };
  const salvaPref = (k, v) => { try { localStorage.setItem(PREF + k, String(v)); } catch (e) { /* ignora */ } };

  const RAGGI = [2000, 5000, 10000, 15000, 25000];
  const stato = {
    gps: null,          // ultima posizione GPS {lat, lon, acc}
    centro: null,       // punto della ricerca {lat, lon, daGps}
    raggio: +leggiPref("raggio", cfg.raggioMetri || 15000),
    categorie: null,    // Set di cosa mostrare: "D" + difficoltà per i sentieri, codice del tipo per i punti
    ordine: leggiPref("ordine", "distanza"),
    sentieri: [],       // sentieri scaricati intorno al centro
    punti: [],          // punti scaricati intorno al centro
    viciniS: [],        // sentieri entro il raggio, con distanza
    viciniP: [],        // punti entro il raggio, con distanza e apertura
    filtri: new Set(),
    caricando: false,
    seguiGps: true
  };
  if (!RAGGI.includes(stato.raggio)) stato.raggio = 15000;
  const CHIAVI_DIFF = QT.ORDINE_DIFF.map((d) => "D" + d);
  const CATEGORIE_INIZIO = cfg.categorie || CHIAVI_DIFF.concat(["R", "B", "W"]);
  {
    const scelti = leggiPref("categorie", CATEGORIE_INIZIO.join(","));
    stato.categorie = new Set(scelti.split(",").filter((k) => QT.TIPI[k] || CHIAVI_DIFF.includes(k)));
  }
  if (!["distanza", "nome", "lunghezza"].includes(stato.ordine)) stato.ordine = "distanza";

  // ---------- Link condiviso su WhatsApp ----------
  // ?s=sentiero&c=centro della ricerca&v=vista della mappa (lat,lon,zoom)&r=raggio&k=cosa mostrare&f=filtri&o=ordine&b=mappa
  // Chi lo apre vede la stessa mappa con la scheda dello stesso sentiero. Le scelte del link non si salvano sul telefono.
  const link = (() => {
    const q = new URLSearchParams(location.search);
    const numeri = (x, n) => { const v = String(x || "").split(",").map(Number); return v.length === n && v.every(isFinite) ? v : null; };
    const c = numeri(q.get("c"), 2), v = numeri(q.get("v"), 3);
    if (!c && !v && !q.get("s")) return null;
    return {
      sentiero: q.get("s"), centro: c, vista: v, raggio: +q.get("r"), sfondo: q.get("b"),
      categorie: q.has("k") ? q.get("k").split(",") : null, filtri: q.get("f"), ordine: q.get("o")
    };
  })();
  if (link) {
    if (RAGGI.includes(link.raggio)) stato.raggio = link.raggio;
    if (link.categorie) stato.categorie = new Set(link.categorie.filter((k) => QT.TIPI[k] || CHIAVI_DIFF.includes(k)));
    if (link.filtri) link.filtri.split(",").filter((f) => f === "cai" || f === "aperti").forEach((f) => stato.filtri.add(f));
    if (["distanza", "nome", "lunghezza"].includes(link.ordine)) stato.ordine = link.ordine;
    // l'indirizzo torna pulito: ricaricando la pagina si riparte dall'ultima posizione
    try { history.replaceState(null, "", location.pathname); } catch (e) { /* ignora */ }
  }

  // ---------- Mappa ----------
  const mappa = L.map("mappa", { zoomControl: false, attributionControl: true, preferCanvas: false })
    .setView([45.9, 10.5], 7);
  // Le linee dei sentieri su canvas (più veloce) con un margine di tocco largo, per prenderle col dito
  const tela = L.canvas({ padding: 0.3, tolerance: 10 });
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  const OSM = 'Mappa e dati © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
  const sfondi = {
    topo: L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
      maxZoom: 17, subdomains: "abc",
      attribution: 'Mappa © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA) · Dati © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }),
    stradale: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: OSM }),
    // Stessa cartina, ma ogni tessera è disegnata grande il doppio: i nomi si leggono meglio
    grande: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, tileSize: 512, zoomOffset: -1, attribution: OSM }),
    satellite: L.layerGroup([
      L.tileLayer(ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19, maxNativeZoom: 19,
        attribution: "Immagini: Esri, Vantor, Earthstar Geographics, GIS User Community · Strade: Esri, HERE, Garmin · Dati © OpenStreetMap"
      }),
      L.tileLayer(ESRI + "Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, opacity: .8 }),
      L.tileLayer(ESRI + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 })
    ])
  };
  let sfondoAttivo = link && sfondi[link.sfondo] ? link.sfondo : leggiPref("sfondo", "topo");
  if (!sfondi[sfondoAttivo]) sfondoAttivo = "topo";
  function impostaSfondo(nome, salva) {
    Object.values(sfondi).forEach((l) => mappa.removeLayer(l));
    sfondoAttivo = sfondi[nome] ? nome : "topo";
    sfondi[sfondoAttivo].addTo(mappa);
    // la topografica arriva solo al 17: oltre si ingrandiscono le sue tessere
    mappa.setMaxZoom(19);
    $("mappa").classList.toggle("satellite", sfondoAttivo === "satellite");
    if (salva !== false) salvaPref("sfondo", sfondoAttivo);
  }
  sfondi.topo.options.maxNativeZoom = 17;
  sfondi.topo.options.maxZoom = 19;
  impostaSfondo(sfondoAttivo, !link);

  const livelli = {
    raggio: L.layerGroup().addTo(mappa),
    sentieri: L.layerGroup().addTo(mappa),
    etichette: L.layerGroup().addTo(mappa),
    punti: L.layerGroup().addTo(mappa),
    scelto: L.layerGroup().addTo(mappa),   // sentiero scelto che non è tra quelli disegnati
    guida: L.layerGroup().addTo(mappa),   // linea tratteggiata da te al sentiero scelto
    io: L.layerGroup().addTo(mappa)
  };
  const markerPerId = new Map();
  const lineePerId = new Map();   // id sentiero → { linee: [...], bordo: [...], etichetta }
  mappa.on("dragstart", () => { stato.seguiGps = false; });
  // L'ultima vista resta sul telefono: all'avvio l'app riparte da lì
  mappa.on("moveend", () => {
    if (!stato.centro) return;
    const c = mappa.getCenter();
    salvaPref("vista", JSON.stringify({ lat: +c.lat.toFixed(5), lon: +c.lng.toFixed(5), z: mappa.getZoom(),
      clat: +stato.centro.lat.toFixed(5), clon: +stato.centro.lon.toFixed(5) }));
  });
  const zoomBasso = () => $("mappa").classList.toggle("zoom-basso", mappa.getZoom() < 12);
  mappa.on("zoomend", zoomBasso);
  zoomBasso();

  // Simbolo dentro il segnaposto, uno per tipo
  const svg = (corpo, n) => `<svg viewBox="0 0 24 24" width="${n || 18}" height="${n || 18}" aria-hidden="true">${corpo}</svg>`;
  const RIFUGIO = svg('<path d="M2.5 12.5 12 4l9.5 8.5-1.5 1.6L12 7 4 14.1Z" fill="currentColor"/><path d="M5.5 13.5 12 8l6.5 5.5V21h-4.5v-5h-4v5H5.5Z" fill="currentColor"/>', 17);
  const BIVACCO = svg('<path d="M12 4 2.5 20h19Z" fill="currentColor"/><path d="M12 11l-3.2 9h6.4Z" fill="rgba(0,0,0,.35)"/>', 17);
  const GOCCIA = svg('<path d="M12 2.5C9 7 5.8 10.6 5.8 14.6a6.2 6.2 0 0 0 12.4 0C18.2 10.6 15 7 12 2.5Z" fill="currentColor"/>', 15);
  const SORGENTE = svg('<path d="M3 15c2 0 2-1.6 4.5-1.6S9.5 15 12 15s2.5-1.6 4.5-1.6S19 15 21 15M3 19.5c2 0 2-1.6 4.5-1.6s2 1.6 4.5 1.6 2.5-1.6 4.5-1.6 2.5 1.6 4.5 1.6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M12 2.5c-1.6 2.4-3.2 4.3-3.2 6.3a3.2 3.2 0 0 0 6.4 0c0-2-1.6-3.9-3.2-6.3Z" fill="currentColor"/>', 16);
  const SIMBOLO = { R: RIFUGIO, B: BIVACCO, W: GOCCIA, S: SORGENTE };
  const icona = (cls, html) => L.divIcon({ className: "", html: `<div class="mk ${cls}">${html ?? ""}</div>`, iconSize: null });
  const classiApertura = (d) => !d.apertura ? "" : d.apertura.aperto ? " aperto" : " chiuso";
  const classiMarker = (d) => `tipo-${d.k}${classiApertura(d)}`;
  const coloreDiff = (d) => getComputedStyle(document.documentElement).getPropertyValue("--d-" + d).trim() || "#8a8f99";
  const pastiglia = (d, grande) => `<span class="diff d-${d}${grande ? " grande" : ""}">${QT.DIFFICOLTA[d].sigla}</span>`;
  const simboloDi = (s) => s.sim ? QT.leggiSimbolo(s.sim) : s.cai ? QT.SIMBOLO_CAI : null;
  // segnavia col numero: quello di OSM se ha già un testo, altrimenti si scrive il numero del sentiero
  const segnavia = (s, n) => {
    const sim = simboloDi(s) || { ...QT.SIMBOLO_CAI, sfondo: "#ffffff", colore: coloreDiff(s.d), forma: "bar" };
    return QT.svgSimbolo(sim, n, sim.testo || (s.r || "").slice(0, 4));
  };

  // ---------- Utilità UI ----------
  function messaggio(testo, errore) {
    const el = $("stato");
    el.textContent = testo;
    el.classList.toggle("errore", !!errore);
    if (errore && $("pannello").hidden) toast(testo);
  }
  let timerToast;
  function toast(testo) {
    const t = $("toast");
    t.textContent = testo;
    t.hidden = false;
    clearTimeout(timerToast);
    timerToast = setTimeout(() => { t.hidden = true; }, 3600);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const attr = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const linkNavigazione = (lat, lon) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`;
  const linkOsm = (d) => {
    const tipo = { n: "node", w: "way", r: "relation" }[d.i[0]];
    return tipo ? `https://www.openstreetmap.org/${tipo}/${d.i.slice(1)}` : `https://www.openstreetmap.org/?mlat=${d.la}&mlon=${d.lo}#map=19/${d.la}/${d.lo}`;
  };
  const sitoWeb = (w) => /^https?:\/\//i.test(w) ? w : "https://" + w;
  const telefoni = (t) => String(t || "").split(/[;,]/).map((x) => x.trim()).filter(Boolean);
  const aPiedi = (m) => "circa " + QT.formattaOre(m / 4000 * 60) + " a piedi in piano";

  // Scarica e legge il JSON entro "ms" millisecondi in tutto (risposta + dati)
  async function fetchJson(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }
  // ---------- Catasto sentieri CAI (OSM2CAI) ----------
  // Percorribilità (con nota e data della segnalazione), tempi e dislivelli del CAI, scaricati il lunedì
  // con gli altri dati. Chiave: numero della relazione OpenStreetMap. Se il file non c'è, se ne fa a meno.
  let cai = {};
  const salvati = new Map();   // sentieri salvati per l'uso senza rete: id → { s, cai, tessere, mappa, quando }
  const datoCai = (s) => (s && s.i && s.i[0] === "r" ? cai[s.i.slice(1)] || (salvati.has(s.i) && salvati.get(s.i).cai) || null : null);
  const PERCORRIBILITA = { ok: "Percorribile", parz: "Percorribile in parte", no: "Non percorribile" };
  const avvisoCai = (s) => { const c = datoCai(s); return c && (c.s === "no" || c.s === "parz") ? c.s : null; };
  function boxCai(c) {
    const quando = c.d ? " · segnalazione del " + c.d.split("-").reverse().join("/") : "";
    return `<div class="cai-stato cai-${c.s}"><b>${c.s === "ok" ? "✓" : "⚠"} ${PERCORRIBILITA[c.s]}</b>` +
      `<span>secondo il Catasto sentieri CAI${quando}</span>${c.n ? `<p>${esc(c.n)}</p>` : ""}</div>`;
  }
  fetchJson("dati/cai.json", {}, 30000)
    .then((d) => { cai = (d && d.sentieri) || {}; if (stato.centro) render(); })
    .catch(() => {});


  // ---------- Memoria sul telefono (IndexedDB): ultimi dati scaricati, quote dei sentieri, foto ----------
  const Memoria = (() => {
    let db = null;
    function apri() {
      if (db) return db;
      db = new Promise((ok, ko) => {
        if (!window.indexedDB) return ko(new Error("no idb"));
        const r = indexedDB.open("trekking", 2);
        r.onupgradeneeded = () => {
          ["foto", "dati", "quote", "salvati"].forEach((n) => { if (!r.result.objectStoreNames.contains(n)) r.result.createObjectStore(n); });
        };
        r.onsuccess = () => ok(r.result);
        r.onerror = () => ko(r.error);
      });
      db.catch(() => { db = null; });
      return db;
    }
    function op(store, modo, fn) {
      return apri().then((b) => new Promise((ok, ko) => {
        const t = b.transaction(store, modo);
        const r = fn(t.objectStore(store));
        t.oncomplete = () => ok(r.result);
        t.onerror = () => ko(t.error);
      }));
    }
    return {
      leggi: (store, id) => op(store, "readonly", (s) => s.get(id)),
      salva: (store, id, v) => op(store, "readwrite", (s) => s.put(v, id)),
      togli: (store, id) => op(store, "readwrite", (s) => s.delete(id)),
      tutti: (store) => op(store, "readonly", (s) => s.getAll())
    };
  })();

  // ---------- Dati ----------
  // L'app chiede a Overpass (OpenStreetMap) sentieri e punti in un riquadro un po' più largo del raggio.
  // L'ultima risposta resta sul telefono: senza campo, se copre la zona, si usa quella.
  let ultimo = null;   // { lat, lon, raggio, sentieri, punti, quando }
  const copre = (u, lat, lon, raggio) => u && QT.distanza(lat, lon, u.lat, u.lon) + raggio <= u.raggio;

  async function daOverpass(lat, lon, raggio) {
    const largo = Math.min(raggio * 1.25 + 1000, 33000);
    const query = QT.queryOverpass(QT.riquadro(lat, lon, largo), 90);
    let ultimoErrore;
    for (const url of cfg.overpass || []) {
      try {
        const dati = await fetchJson(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query)
        }, 100000);   // i server di Overpass a volte impiegano più di un minuto
        if (dati.remark && /error|runtime/i.test(dati.remark)) throw new Error(dati.remark);
        const { sentieri, punti } = QT.leggiRisposta(dati);
        return { lat, lon, raggio: largo, sentieri, punti, quando: Date.now() };
      } catch (e) {
        ultimoErrore = e;
        console.warn("Overpass", url, e);
      }
    }
    throw ultimoErrore || new Error("nessun server Overpass");
  }

  // ---------- Dati salvati nel sito ----------
  // Ogni lunedì GitHub scarica sentieri e punti di Lombardia, Valle d'Aosta e Sardegna (più 15 km oltre i confini) e li
  // salva nella cartella "dati" del sito, divisi in tessere. In queste regioni l'app li legge da lì, senza dipendere da Overpass.
  // Ogni sentiero è salvato una volta sola, nella sua tessera "di casa": le altre tessere che attraversa
  // dicono solo dov'è, e quella tessera si scarica in un secondo momento.
  let indiceSito = null, indiceLetto = 0;
  const tessereSito = new Map();   // nome → contenuto
  async function leggiIndice(forza) {
    if (!forza && indiceSito && Date.now() - indiceLetto < 30 * 60000) return indiceSito;
    try {
      const nuovo = await fetchJson("dati/indice.json", { cache: "no-cache" }, 10000);
      if (!indiceSito || nuovo.aggiornato !== indiceSito.aggiornato) tessereSito.clear();   // dati nuovi
      indiceSito = nuovo;
      indiceLetto = Date.now();
    } catch (e) { indiceSito = null; }
    return indiceSito;
  }
  async function leggiTessere(nomi) {
    const mancanti = nomi.filter((t) => !tessereSito.has(t));
    const parti = await Promise.all(mancanti.map((t) => fetchJson("dati/" + t, {}, 30000)));
    mancanti.forEach((t, i) => tessereSito.set(t, parti[i]));
    return nomi.map((t) => tessereSito.get(t));
  }
  async function dalSito(lat, lon, raggio, forza) {
    const ind = await leggiIndice(forza);
    if (!ind || !(ind.zone || ind.zona) || !ind.tessere) return null;
    // più regioni (Lombardia, Valle d'Aosta, Sardegna…); i dati più vecchi hanno un solo riquadro in "zona"
    const zone = ind.zone || [ind.zona];
    const dentro = ([zs, zw, zn, ze]) => lat >= zs && lat <= zn && lon >= zw && lon <= ze;
    if (!zone.some(dentro)) return null;
    // blocchi che GitHub non è riuscito a scaricare (per esempio una regione appena aggiunta): meglio Overpass
    if ((ind.mancanti || []).some(dentro)) return null;
    const passo = ind.passo || 0.1;
    const esistenti = new Set(ind.tessere);
    const [s, w, n, e] = QT.riquadro(lat, lon, raggio);
    const nomi = [];
    for (let i = Math.floor(s / passo); i <= Math.floor(n / passo); i++) {
      for (let j = Math.floor(w / passo); j <= Math.floor(e / passo); j++) {
        const t = `t_${i}_${j}.json`;
        if (esistenti.has(t)) nomi.push(t);
      }
    }
    const vicine = await leggiTessere(nomi);
    // sentieri che passano di qui ma sono salvati in altre tessere
    const altrove = new Set();
    for (const c of vicine) for (const casa of Object.values(c.r || {})) if (!nomi.includes(casa) && esistenti.has(casa)) altrove.add(casa);
    const lontane = await leggiTessere([...altrove]);
    const servono = new Set(vicine.flatMap((c) => [...(c.s || []).map((x) => x.i), ...Object.keys(c.r || {})]));
    return {
      lat, lon, raggio,
      // filtro: una volta sola per sentiero (dopo un aggiornamento parziale può stare in due tessere)
      sentieri: vicine.concat(lontane).flatMap((c) => c.s || []).filter((x) => servono.delete(x.i)),
      punti: vicine.flatMap((c) => c.p || []),
      quando: Date.parse(ind.aggiornato) || Date.now()
    };
  }

  async function caricaDati(lat, lon, raggio, forza) {
    if (!forza && ultimo && Date.now() - (ultimo.letto || ultimo.quando) < 60 * 60000 && copre(ultimo, lat, lon, raggio)) {
      return { ...ultimo, fonte: ultimo.fonte === "sito" ? "sito" : "memoria" };
    }
    // 1. Nelle regioni salvate: i dati del sito
    try {
      const sito = await dalSito(lat, lon, raggio, forza);
      if (sito) {
        ultimo = { ...sito, fonte: "sito", letto: Date.now() };
        Memoria.salva("dati", "ultimo", ultimo).catch(() => {});
        return ultimo;
      }
    } catch (e) { console.warn("Dati del sito non disponibili", e); }
    // 2. Fuori da queste regioni (o sito senza dati): i server pubblici di OpenStreetMap
    try {
      ultimo = await daOverpass(lat, lon, raggio);
      Memoria.salva("dati", "ultimo", ultimo).catch(() => {});
      return { ...ultimo, fonte: "overpass" };
    } catch (e) {
      // senza rete: gli ultimi dati salvati sul telefono, se coprono la zona
      const salvato = await Memoria.leggi("dati", "ultimo").catch(() => null);
      if (salvato && copre(salvato, lat, lon, Math.min(raggio, salvato.raggio))) {
        ultimo = salvato;
        return { ...salvato, fonte: "salvati" };
      }
      throw e;
    }
  }

  // ---------- Suoni ----------
  let audio = null;
  let suoniAttivi = leggiPref("suoni", "1") !== "0";
  function sbloccaAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state !== "running") audio.resume();
    } catch (e) { /* audio non disponibile */ }
  }
  document.addEventListener("pointerdown", sbloccaAudio, { passive: true });
  document.addEventListener("touchend", sbloccaAudio, { passive: true });
  // L'iPhone fa parlare l'app solo dopo che la voce è partita una volta da un tocco
  let voceSbloccata = false;
  function sbloccaVoce() {
    const s = window.speechSynthesis;
    if (voceSbloccata || !s) return;
    voceSbloccata = true;
    const u = new SpeechSynthesisUtterance(" ");
    u.lang = "it-IT";
    u.volume = 0;
    const v = vocItaliana();
    if (v) u.voice = v;
    s.speak(u);
  }
  document.addEventListener("touchend", sbloccaVoce, { passive: true });
  document.addEventListener("click", sbloccaVoce, { passive: true });
  function suona(note, volume) {
    if (!suoniAttivi || !audio || document.hidden) return;
    if (audio.state !== "running") { audio.resume().catch(() => {}); if (audio.state !== "running") return; }
    const t0 = audio.currentTime + 0.02;
    for (const [freq, inizio, durata] of note) {
      const osc = audio.createOscillator(), g = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + inizio);
      g.gain.exponentialRampToValueAtTime(volume || 0.35, t0 + inizio + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + inizio + durata);
      osc.connect(g).connect(audio.destination);
      osc.start(t0 + inizio);
      osc.stop(t0 + inizio + durata + 0.05);
    }
  }
  const SUONO = {
    aggiornato: () => suona([[1318.5, 0, 0.6], [2637, 0, 0.25]], 0.3),   // "bing"
    errore: () => suona([[392, 0, 0.25], [311, 0.22, 0.45]], 0.3)        // due note che scendono
  };

  // ---------- Caricamento ----------
  let giroCarica = 0, fonteDati = null, quandoDati = null;
  async function carica(forza, silenzioso) {
    if (!stato.centro) return;
    const giro = ++giroCarica;
    stato.caricando = true;
    $("btn-aggiorna").classList.add("gira");
    const { lat, lon } = stato.centro;
    if (!silenzioso) messaggio("Cerco sentieri, rifugi e fontanelle entro " + QT.formattaDistanza(stato.raggio) + "…");
    if (!silenzioso && !stato.sentieri.length) toast("Scarico i sentieri…");
    let errore = null;
    try {
      const r = await caricaDati(lat, lon, stato.raggio, forza);
      if (giro !== giroCarica) return;
      stato.sentieri = r.sentieri;
      stato.punti = r.punti;
      fonteDati = r.fonte;
      quandoDati = r.quando;
      stato.tentativi = 0;
    } catch (e) {
      errore = e;
      console.warn("Dati non disponibili", e);
    }
    if (giro !== giroCarica) return;
    stato.caricando = false;
    $("btn-aggiorna").classList.remove("gira");
    ricalcola();

    clearTimeout(stato.timerRiprova);
    if (errore) {
      const attese = [30, 60, 120, 300];
      const sec = attese[Math.min(stato.tentativi || 0, attese.length - 1)];
      stato.tentativi = (stato.tentativi || 0) + 1;
      stato.timerRiprova = setTimeout(() => carica(true), sec * 1000);
      SUONO.errore();
      messaggio(`Non riesco a scaricare i dati. Riprovo da solo tra ${sec >= 60 ? sec / 60 + " min" : sec + " secondi"}.`, true);
      return;
    }
    SUONO.aggiornato();
    if ($("toast").textContent.startsWith("Scarico")) $("toast").hidden = true;
    aggiornaMessaggio();
    if (fonteDati === "salvati") toast("Niente rete: uso i dati salvati sul telefono.");
  }

  function aggiornaMessaggio() {
    const ora = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    const dove = stato.centro.daGps ? "dalla tua posizione" : stato.centro.ultima ? "dall'ultima posizione"
      : stato.centro.condiviso ? "dal punto del link ricevuto" : "dal punto cercato";
    let dati = "";
    if (quandoDati) {
      const d = new Date(quandoDati);
      const oggi = d.toDateString() === new Date().toDateString();
      dati = (fonteDati === "sito" ? " · dati OpenStreetMap salvati nel sito, aggiornati " : " · dati OpenStreetMap scaricati ") + (oggi ? "alle " + d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })
        : "il " + d.toLocaleDateString("it-IT", { day: "numeric", month: "long" }));
      if (fonteDati === "salvati") dati += " (salvati sul telefono, senza rete)";
    }
    messaggio(`Entro ${QT.formattaDistanza(stato.raggio)} ${dove}${dati} · aggiornato alle ${ora}`);
  }

  // Ricalcola distanze, aperture e filtri senza riscaricare (cambio categoria, filtri, orologio)
  function ricalcola() {
    if (!stato.centro) return;
    const { lat, lon } = stato.centro;
    stato.viciniS = QT.prepareSentieri(stato.sentieri, lat, lon, stato.raggio, stato.categorie)
      .filter((s) => !stato.filtri.has("cai") || s.cai);
    stato.viciniP = QT.preparaPunti(stato.punti, lat, lon, stato.raggio, stato.categorie)
      .filter((d) => !stato.filtri.has("aperti") || (d.apertura && d.apertura.aperto));
    render();
  }

  // ---------- Schede (pagina a tutto schermo che si apre toccando un sentiero o un punto) ----------
  function distanzaParlata(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " metri";
    return (m / 1000).toFixed(1).replace(".", ",") + " chilometri";
  }

  const BOTTONE_MAPPA = '<button type="button" class="pop-vai pop-mappa">Vedi sulla mappa</button>';
  const BOTTONE_CAMMINA = '<button type="button" class="pop-vai pop-mappa">Cammina sul sentiero</button>';

  function popupPunto(d) {
    const tit = QT.titolo(d);
    const tipo = QT.nomeTipo(d);
    const voce = [tit + "."];
    const righe = [];
    if (tit.toLowerCase() !== tipo.toLowerCase()) voce.push(tipo + ".");
    const dett = [tit.toLowerCase() !== tipo.toLowerCase() ? tipo : "", d.q ? "quota " + QT.formattaQuota(+d.q) : ""].filter(Boolean).join(" · ");
    if (dett) righe.push(`<p class="pop-tipo">${esc(dett)}</p>`);
    if (d.q) voce.push("Quota " + d.q + " metri.");
    if (d.x) righe.push(`<p>${esc(d.x.charAt(0).toUpperCase() + d.x.slice(1))}</p>`);
    if (d.o) righe.push(`<p>Gestito da ${esc(d.o)}</p>`);
    if (d.p) righe.push(`<p>Posti letto: ${esc(d.p)}</p>`);
    if (d.apertura) {
      const t = QT.testoApertura(d.apertura);
      righe.push(`<p class="pop-apertura ${d.apertura.aperto ? "aperto" : "chiuso"}">${esc(t)}</p>`);
      voce.push(t.replace(" · ", ", ") + ".");
    }
    const orari = QT.orariLeggibili(d.h);
    if (orari.length) {
      righe.push(`<div class="pop-orari"><b>Orari</b>${orari.map((o) => `<span>${esc(o)}</span>`).join("")}</div>`);
      if (!d.apertura) righe.push('<p class="fonte">Orari scritti in un modo che l\'app non sa interpretare: leggili qui sopra.</p>');
    }
    if (d.k === "R") righe.push('<p class="fonte">Per mangiare o dormire telefona prima: gli orari cambiano con la stagione.</p>');
    if (d.k === "S" && !/potabile/.test(d.x || "")) righe.push('<p class="avviso">Non è indicato se l\'acqua è potabile.</p>');
    const tel = telefoni(d.t);
    if (tel.length) righe.push(`<p>Tel. ${tel.map((n) => `<a href="tel:${attr(n.replace(/[^\d+]/g, ""))}">${esc(n)}</a>`).join(" · ")}</p>`);
    if (d.w) righe.push(`<p><a href="${attr(sitoWeb(d.w))}" target="_blank" rel="noopener">Sito web</a></p>`);
    righe.push(`<p>${QT.formattaDistanza(d.distanza)} in linea d'aria</p>`);
    voce.push(distanzaParlata(d.distanza) + " in linea d'aria.");
    righe.push(`<p class="fonte">Fonte: OpenStreetMap · <a href="${attr(linkOsm(d))}" target="_blank" rel="noopener">Vedi su OpenStreetMap</a></p>`);
    if (d.k === "W" || d.k === "S") righe.push(`<div class="pop-foto" data-id="${attr(d.i)}"></div>`);
    const pulsanti = [`<a class="pop-vai" href="${linkNavigazione(d.la, d.lo)}" target="_blank" rel="noopener">Portami qui</a>`];
    if (tel.length) pulsanti.push(`<a class="pop-vai pop-chiama" href="tel:${attr(tel[0].replace(/[^\d+]/g, ""))}">Chiama</a>`);
    pulsanti.push(BOTTONE_MAPPA);
    return `<div class="pop" data-voce="${attr(voce.join(" "))}"><h3>${esc(tit)}</h3>${righe.join("")}
      <div class="pop-pulsanti">${pulsanti.join("")}</div></div>`;
  }

  // Estremità del sentiero più vicina a te (o al punto cercato): dove attaccare il sentiero
  function attacco(s) {
    const c = stato.gps || stato.centro || { lat: mappa.getCenter().lat, lon: mappa.getCenter().lng };
    return QT.estremita(s).sort((a, b) => QT.distanza(c.lat, c.lon, a[0], a[1]) - QT.distanza(c.lat, c.lon, b[0], b[1]))[0];
  }

  // Sentiero ritagliato sulla zona ("parz"): senza i tag di OpenStreetMap, lunghezza, dislivello e tempo
  // si possono calcolare solo per il tratto in zona, e lo si dice.
  function numeriSentiero(s, q) {
    const c = datoCai(s);
    const daCai = s.su == null && !!c && c.su != null;
    const daTag = s.su != null || daCai;
    const su = s.su != null ? s.su : daCai ? c.su : q && q.su;
    const giu = s.su != null ? s.giu : daCai ? (c.giu != null ? c.giu : null) : q && q.giu;
    const zona = s.parz ? ", tratto in zona" : "";
    const stima = !daTag && q ? " <i>stima" + zona + "</i>" : daCai ? " (CAI)" : "";
    const lung = s.parz && !s.lt ? ["≥ " + QT.formattaKm(s.l), "lunghezza (qui solo il tratto in zona)"]
      : [QT.formattaKm(s.l), "lunghezza" + (s.anello ? " (ad anello)" : s.parz ? " totale" : "")];
    const caselle = [lung];
    if (su != null) {
      caselle.push([`↗ ${su} m`, "salita" + stima]);
      if (giu != null) caselle.push([`↘ ${giu} m`, "discesa" + stima]);
    }
    else caselle.push(["…", "dislivello: calcolo"]);
    if (q && q.max != null) caselle.push([`${q.min}–${QT.formattaQuota(q.max)}`, "quota min–max" + zona]);
    // con il dislivello stimato sul tratto in zona, anche il tempo vale per quel tratto
    if (c && c.af) {
      // tempi del Catasto CAI: andata (da partenza ad arrivo) e ritorno
      caselle.push([QT.formattaOre(c.af), "tempo CAI" + (c.ar && c.ar !== c.af ? " andata" : "")]);
      if (c.ar && c.ar !== c.af) caselle.push([QT.formattaOre(c.ar), "tempo CAI ritorno"]);
    } else {
      const min = s.t || (su != null ? QT.tempoStimato(daTag ? s.l : s.lv || s.l, su, giu) : null);
      if (min) caselle.push([QT.formattaOre(min), s.t ? "tempo indicato" : "tempo <i>stima" + (daTag ? "" : zona) + "</i>"]);
    }
    return caselle.map(([b, t]) => `<div><b>${b}</b><span>${t}</span></div>`).join("");
  }

  function profiloSvg(q) {
    if (!q || !q.serie || q.serie.length < 3) return "";
    const v = q.serie, min = Math.min(...v), max = Math.max(...v), W = 300, H = 64;
    const x = (i) => (i / (v.length - 1)) * W, y = (h) => H - 4 - ((h - min) / Math.max(max - min, 1)) * (H - 10);
    const linea = v.map((h, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(h).toFixed(1)).join("");
    return `<svg class="profilo" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-label="Profilo altimetrico">` +
      `<path class="area" d="${linea}L${W} ${H}L0 ${H}Z"/><path class="linea" d="${linea}"/></svg>`;
  }

  function popupSentiero(s) {
    const diff = QT.DIFFICOLTA[s.d];
    const tit = QT.titoloSentiero(s);
    const sotto = QT.sottotitoloSentiero(s);
    const q = quoteCalcolate.get(s.i);
    const voce = [tit + ".", s.r ? "Sentiero numero " + s.r + "." : "", "Difficoltà " + diff.nome + ".",
      "Lunghezza " + distanzaParlata(s.l) + ".", s.su != null ? "Salita " + s.su + " metri." : ""].filter(Boolean);
    const righe = [];
    if (sotto && sotto !== tit) righe.push(`<p class="pop-tipo">${esc(sotto)}</p>`);
    righe.push(`<div class="pop-diff">${pastiglia(s.d, true)}<span>${esc(diff.nome)}</span></div>`);
    righe.push(`<p class="pop-spiega">${esc(diff.spiega)}</p>`);
    const c = datoCai(s);
    if (c && c.s) {
      righe.push(boxCai(c));
      voce.push(PERCORRIBILITA[c.s] + " secondo il CAI." + (c.n ? " " + c.n : ""));
    }
    righe.push(`<div class="pop-num" data-num="${attr(s.i)}">${numeriSentiero(s, q)}</div>`);
    righe.push(`<div class="pop-profilo" data-prof="${attr(s.i)}">${profiloSvg(q)}</div>`);
    if (s.o) righe.push(`<p>Gestito da ${esc(s.o)}</p>`);
    if (s.nota) righe.push(`<p>${esc(s.nota)}</p>`);
    righe.push(`<p>Il punto più vicino è a ${QT.formattaDistanza(s.distanza)} in linea d'aria</p>`);
    voce.push("Il punto più vicino è a " + distanzaParlata(s.distanza) + ".");
    righe.push(`<p class="fonte">Fonte: <a href="https://www.openstreetmap.org/relation/${attr(s.i.slice(1))}" target="_blank" rel="noopener">OpenStreetMap</a>` + (s.su == null && !(c && c.su != null) ? "; quote: Copernicus DEM (Open-Meteo)" : "") +
      (c ? `; percorribilità e tempi: <a href="https://osm2cai.cai.it/hiking-route/id/${attr(c.id)}" target="_blank" rel="noopener">Catasto sentieri CAI</a>` : "") + "</p>");
    const a = attacco(s);
    const pulsanti = [`<a class="pop-vai" href="${linkNavigazione(a[0], a[1])}" target="_blank" rel="noopener">In auto al sentiero</a>`, BOTTONE_CAMMINA];
    const sv = streetView(s);
    const invia = `<a class="pop-vai pop-whatsapp" href="${attr(linkWhatsApp(s))}" target="_blank" rel="noopener">${ICONA_WA}Invia Sentiero con WhatsApp</a>`;
    const waymarked = `<a class="pop-link" href="https://hiking.waymarkedtrails.org/#route?id=${attr(s.i.slice(1))}" target="_blank" rel="noopener">Profilo e dettagli su Waymarked Trails</a>`;
    const testa = `<div class="pop-testa">${segnavia(s, 30)}<h3>${esc(tit)}</h3></div>`;
    return `<div class="pop pop-sentiero" data-voce="${attr(voce.join(" "))}" data-sentiero="${attr(s.i)}">${testa}${righe.join("")}
      <div class="pop-pulsanti">${pulsanti.join("")}</div>${sv}<div class="pop-offline"></div>${scaricaHtml(s)}${invia}${waymarked}</div>`;
  }

  // ---------- Scarica il percorso (GPX, KML, GeoJSON) ----------
  // Il tracciato intero e in ordine viene da Waymarked Trails (lo stesso dei loro file "Ottieni file"),
  // chiesto appena si apre la scheda così il file è pronto al tocco. Se non risponde, si usa la traccia
  // dell'app (semplificata, e per le alte vie solo il tratto in zona).
  const dettagliWmt = new Map();
  function dettaglioWmt(s) {
    if (!dettagliWmt.has(s.i)) {
      const p = fetchJson(`https://hiking.waymarkedtrails.org/api/v1/details/relation/${s.i.slice(1)}`, {}, 15000)
        .then((d) => { p.valore = d; return d; })
        .catch((e) => { dettagliWmt.delete(s.i); throw e; });
      p.catch(() => {});
      dettagliWmt.set(s.i, p);
    }
    return dettagliWmt.get(s.i);
  }
  function scaricaHtml(s) {
    const [a, b] = QT.capiPercorso(s, null);
    const formati = [["gpx", "GPX"], ["kml", "KML"], ["geojson", "GeoJSON"]].map(([v, t], i) =>
      `<label><input type="radio" name="scarica-formato" value="${v}"${i ? "" : " checked"}> ${t}</label>`).join("");
    const dir = [[1, `${esc(a)} → ${esc(b)}`], [-1, `${esc(b)} → ${esc(a)}`], [0, "entrambe le direzioni"]].map(([v, t], i) =>
      `<label><input type="radio" name="scarica-dir" value="${v}"${i ? "" : " checked"}> <span>${t}</span></label>`).join("");
    // chiuso in un pulsante con lo stesso nome; si apre toccandolo e si richiude uscendo dalla scheda
    return `<button type="button" class="pop-vai pop-apri-scarica">${ICONA_SCARICA}Scarica il percorso</button>
      <div class="pop-scarica" hidden><b>Scarica il percorso</b>
      <p class="pop-scarica-spiega">Per aprirlo in un'app di navigazione (Komoot, Gaia GPS, OsmAnd, Google Earth…).</p>
      <fieldset><legend>Formato</legend><div class="pop-scelte">${formati}</div></fieldset>
      <fieldset><legend>Direzione</legend><div class="pop-scelte pop-scelte-col">${dir}</div></fieldset>
      <button type="button" class="pop-vai pop-ottieni">${ICONA_SCARICA}Salva il file</button>
      <p class="pop-scarica-spiega">Poi apri l'app <b>File</b>, cartella <b>Download</b>: tocca il file (o tienilo premuto → Condividi)
        e scegli l'app, per esempio OsmAnd.</p></div>`;
  }
  const ICONA_SCARICA = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3v12m0 0-5-5m5 5 5-5M4 20h16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function preparaScarica(corpo, s) {
    const box = corpo.querySelector(".pop-scarica");
    if (!box) return;
    const apri = corpo.querySelector(".pop-apri-scarica");
    if (apri) apri.addEventListener("click", () => {
      apri.hidden = true;
      box.hidden = false;
      box.scrollIntoView({ block: "nearest", behavior: "smooth" });
    });
    // con l'itinerario di Waymarked Trails i nomi dei due capi sono più precisi
    dettaglioWmt(s).then((d) => {
      const [a, b] = QT.capiPercorso(s, d);
      const et = box.querySelectorAll('input[name="scarica-dir"] + span');
      if (et.length === 3) { et[0].textContent = `${a} → ${b}`; et[1].textContent = `${b} → ${a}`; }
    }).catch(() => {});
    box.querySelector(".pop-ottieni").addEventListener("click", async () => {
      const formato = box.querySelector('input[name="scarica-formato"]:checked').value;
      const dir = +box.querySelector('input[name="scarica-dir"]:checked').value;
      const p = dettaglioWmt(s);
      let d = p.valore, linee = null, ridotto = false;
      if (!d) { toast("Preparo il file…"); try { d = await p; } catch (e) { d = null; } }
      if (d) linee = QT.tracciaWmt(d, dir);
      if (!linee || !linee.length) {
        // ripiego: la traccia dell'app, nell'ordine in cui è salvata
        linee = s.g.map((l) => l.slice());
        if (dir === -1) linee = linee.reverse().map((l) => l.reverse());
        ridotto = true;
      }
      const nome = QT.titoloSentiero(s);
      const testo = QT.fileTraccia(linee, nome, formato, {
        fonte: "Dati © OpenStreetMap (ODbL)" + (ridotto ? "" : " via Waymarked Trails"),
        osm: "https://www.openstreetmap.org/relation/" + s.i.slice(1)
      });
      const nomeF = QT.nomeFile(nome, formato);
      consegnaFile(testo, nomeF, QT.FORMATI[formato].tipo);
      if (ridotto) toast(s.parz ? "Waymarked Trails non risponde: file con il solo tratto in zona" : "Waymarked Trails non risponde: file con la traccia semplificata dell'app");
      if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: "scarica-" + formato, title: "Scarica percorso " + formato.toUpperCase(), event: true });
    });
  }
  // Download del file. (Il menu Condividi con il file è stato tolto: sull'iPhone non offriva OsmAnd.)
  async function consegnaFile(testo, nome, tipo) {
    // Sull'iPhone, con il service worker attivo, il file diventa un indirizzo vero del sito (…/scarica/nome.gpx):
    // i download "blob:" lì spesso non arrivano in File. Chrome invece riscarica dal sito, quindi lì si usa il blob.
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (ios && navigator.serviceWorker && navigator.serviceWorker.controller && window.caches) {
      try {
        const indirizzo = new URL("scarica/" + encodeURIComponent(nome), location.href).href;
        const c = await caches.open("file-percorsi");
        for (const vecchio of await c.keys()) await c.delete(vecchio);
        await c.put(indirizzo, new Response(testo, { headers: {
          "Content-Type": tipo, "Content-Disposition": `attachment; filename="${nome}"`
        } }));
        apriLink(indirizzo, nome);
        return;
      } catch (e) { /* si ripiega sul blob */ }
    }
    const url = URL.createObjectURL(new Blob([testo], { type: tipo }));
    apriLink(url, nome);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }
  function apriLink(url, nome) {
    const a = document.createElement("a");
    a.href = url; a.download = nome; a.rel = "noopener";
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- Salva per l'uso senza rete ----------
  // Il sentiero (traccia, numeri, dati CAI), le sue quote e la mappa topografica intorno al percorso restano sul telefono:
  // senza campo lo si apre dalla pagina Elenco e la guida sul sentiero funziona con il solo GPS.
  // Le tessere della mappa (OpenTopoMap) vanno nella cache "mappe-salvate", da cui le prende il service worker.
  const CACHE_MAPPE = "mappe-salvate";
  const ICONA_SALVA = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 3h12v18l-6-4.5L6 21Z" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>';
  const urlTessera = (z, x, y) => `https://${"abc"[(x + y) % 3]}.tile.opentopomap.org/${z}/${x}/${y}.png`;   // come Leaflet
  // Tessere entro "margine" metri dal percorso, dallo zoom 12 al 17 (più vicino si ingrandiscono quelle del 17)
  function tessereSentiero(s) {
    const punti = [];
    for (const l of s.g) for (let i = 0; i < l.length; i++) {
      punti.push(l[i]);
      if (i === l.length - 1) continue;
      const [a, b] = [l[i], l[i + 1]];
      const passi = Math.floor(QT.distanza(a[0], a[1], b[0], b[1]) / 60);   // un punto ogni 60 m
      for (let k = 1; k <= passi; k++) punti.push([a[0] + (b[0] - a[0]) * k / (passi + 1), a[1] + (b[1] - a[1]) * k / (passi + 1)]);
    }
    // per i sentieri lunghi (alte vie) si rinuncia agli zoom più vicini: troppe tessere
    let out;
    for (const zMax of [17, 16, 15]) {
      out = tessereZoom(punti, zMax);
      if (out.size <= 1500) break;
    }
    return [...out];
  }
  function tessereZoom(punti, zMax) {
    const out = new Set();
    for (let z = 12; z <= zMax; z++) {
      const n = 2 ** z;
      const margine = z >= 17 ? 200 : 400;
      for (const [la, lo] of punti) {
        const r = la * Math.PI / 180;
        const x = (lo + 180) / 360 * n, y = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n;
        const m = margine / (40075016 * Math.cos(r) / n);
        for (let tx = Math.floor(x - m); tx <= Math.floor(x + m); tx++) {
          for (let ty = Math.floor(y - m); ty <= Math.floor(y + m); ty++) out.add(urlTessera(z, tx, ty));
        }
      }
    }
    return out;
  }
  Memoria.tutti("salvati").then((lista) => {
    (lista || []).forEach((r) => { if (r && r.s) salvati.set(r.s.i, r); });
    renderSalvati();
  }).catch(() => {});
  let salvaInCorso = null, salvaTesto = "";   // sentiero che si sta salvando e a che punto è
  let salvaUI = null;                            // riquadro "Salva" della scheda aperta: { id, box, disegna }
  async function salvaSentiero(s, avanzamento) {
    const pulito = { ...s };
    delete pulito.distanza; delete pulito.vicino;
    // quote (per dislivello e profilo senza rete): restano nella memoria del telefono
    if (s.su == null || !quoteCalcolate.has(s.i)) await calcolaQuote(s).catch(() => null);
    const tessere = tessereSentiero(s);
    let ok = 0, fatte = 0;
    if (window.caches) {
      const c = await caches.open(CACHE_MAPPE);
      let i = 0;
      const lavora = async () => {
        while (i < tessere.length) {
          const url = tessere[i++];
          try {
            if (await c.match(url)) ok++;
            else {
              const r = await fetch(url, { mode: "cors" });
              if (r.ok) { await c.put(url, r); ok++; }
            }
          } catch (e) { /* tessera mancante: si va avanti */ }
          avanzamento(++fatte / tessere.length);
        }
      };
      await Promise.all([lavora(), lavora(), lavora(), lavora()]);
    }
    const rec = { s: pulito, cai: datoCai(s), tessere, mappa: { ok, tot: tessere.length }, quando: Date.now() };
    await Memoria.salva("salvati", s.i, rec);
    salvati.set(s.i, rec);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
    renderSalvati();
    return rec;
  }
  async function togliSentiero(id) {
    const rec = salvati.get(id);
    salvati.delete(id);
    await Memoria.togli("salvati", id).catch(() => {});
    if (rec && window.caches) {
      // si cancellano solo le tessere che non servono ad altri sentieri salvati
      const usate = new Set();
      for (const r of salvati.values()) (r.tessere || []).forEach((u) => usate.add(u));
      const c = await caches.open(CACHE_MAPPE);
      await Promise.all((rec.tessere || []).filter((u) => !usate.has(u)).map((u) => c.delete(u).catch(() => {})));
    }
    renderSalvati();
  }
  function preparaSalva(corpo, s) {
    const box = corpo.querySelector(".pop-offline");
    if (!box) return;
    const disegna = () => {
      const rec = salvati.get(s.i);
      if (salvaInCorso === s.i) {
        box.innerHTML = `<button type="button" class="pop-vai pop-salva" disabled>${ICONA_SALVA}<span class="pop-salva-testo">${salvaTesto || "Salvo sul telefono…"}</span></button>`;
      } else if (rec) {
        const quando = new Date(rec.quando).toLocaleDateString("it-IT", { day: "numeric", month: "long" });
        const mappa = rec.mappa && rec.mappa.tot && rec.mappa.ok < rec.mappa.tot * 0.95
          ? `mappa salvata in parte (${Math.round(rec.mappa.ok / rec.mappa.tot * 100)}%): risalvalo con la connessione`
          : "con la mappa topografica intorno al percorso";
        box.innerHTML = `<div class="salvato-box"><b>✓ Salvato per l'uso senza rete</b>
          <span>Il ${quando}, ${mappa}. Senza campo lo trovi nella pagina Elenco, in alto.</span>
          <div class="salvato-azioni">${rec.mappa && rec.mappa.ok < rec.mappa.tot * 0.95 ? '<button type="button" class="pop-risalva">Salva di nuovo</button>' : ""}
          <button type="button" class="pop-togli">Togli dai salvati</button></div></div>`;
      } else {
        box.innerHTML = `<button type="button" class="pop-vai pop-salva">${ICONA_SALVA}<span class="pop-salva-testo">Salva per l'uso senza rete</span></button>`;
      }
      const salva = box.querySelector(".pop-salva:not([disabled]), .pop-risalva");
      if (salva) salva.addEventListener("click", avvia);
      const togli = box.querySelector(".pop-togli");
      if (togli) togli.addEventListener("click", () => {
        togliSentiero(s.i).then(() => { disegna(); toast("Tolto dai sentieri salvati."); });
      });
    };
    const avvia = async () => {
      if (navigator.onLine === false) { toast("Serve la connessione per salvare il sentiero."); return; }
      if (salvaInCorso) { toast("Sto già salvando un altro sentiero: aspetta che finisca."); return; }
      salvaInCorso = s.i;
      salvaTesto = "";
      disegna();
      // la scheda può essere chiusa e riaperta mentre salva: si aggiorna quella aperta adesso
      const ui = () => (salvaUI && salvaUI.id === s.i && salvaUI.box.isConnected ? salvaUI : null);
      try {
        const rec = await salvaSentiero(s, (f) => {
          salvaTesto = `Salvo la mappa… ${Math.round(f * 100)}%`;
          const t = ui() && ui().box.querySelector(".pop-salva-testo");
          if (t) t.textContent = salvaTesto;
        });
        toast(rec.mappa.ok < rec.mappa.tot * 0.95 ? "Sentiero salvato, ma la mappa solo in parte." : "Sentiero salvato: lo trovi anche senza rete.");
        if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: "salva-offline", title: "Salva sentiero senza rete", event: true });
      } catch (e) {
        console.warn("Salvataggio non riuscito", e);
        toast("Non sono riuscito a salvare il sentiero: c'è abbastanza spazio sul telefono?");
      }
      salvaInCorso = null;
      if (ui()) ui().disegna();
    };
    salvaUI = { id: s.i, box, disegna };
    disegna();
  }
  // Elenco: i sentieri salvati, in alto, con la distanza da te
  function renderSalvati() {
    const sez = $("salvati"), ol = $("lista-salvati");
    if (!sez || !ol) return;
    sez.hidden = !salvati.size;
    ol.innerHTML = "";
    const c = stato.gps || stato.centro || { lat: mappa.getCenter().lat, lon: mappa.getCenter().lng };
    [...salvati.values()].map((r) => {
      const v = QT.puntoPiuVicino(r.s, c.lat, c.lon);
      return { ...r.s, distanza: v.distanza, vicino: v.punto };
    }).sort((a, b) => a.distanza - b.distanza).forEach((s) => ol.appendChild(voceSentiero(s)));
  }

  // Street View di Google Maps ai due estremi del sentiero (i più lontani tra loro); per un anello uno solo.
  // Google Maps cerca la foto sferica più vicina al punto: in montagna spesso è quella di un escursionista.
  const linkStreetView = (p) => `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p[0]},${p[1]}`;
  function streetView(s) {
    const e = QT.estremita(s);
    let a = e[0], b = e[e.length - 1], max = -1;
    for (let i = 0; i < e.length; i++) for (let j = i + 1; j < e.length; j++) {
      const d = QT.distanza(e[i][0], e[i][1], e[j][0], e[j][1]);
      if (d > max) { max = d; a = e[i]; b = e[j]; }
    }
    // l'estremo indicato come partenza su OpenStreetMap non si conosce: si mette prima quello più vicino a te
    const c = stato.gps || stato.centro;
    if (c && QT.distanza(c.lat, c.lon, b[0], b[1]) < QT.distanza(c.lat, c.lon, a[0], a[1])) [a, b] = [b, a];
    const vai = (p, testo) => `<a class="pop-vai pop-sv" href="${attr(linkStreetView(p))}" target="_blank" rel="noopener">${ICONA_SV}${esc(testo)}</a>`;
    const due = max > 150;
    return `<div class="pop-streetview"><b>Street View agli estremi</b><div class="pop-pulsanti">` +
      (due ? vai(a, "Estremo più vicino") + vai(b, "Estremo più lontano") : vai(a, s.anello ? "Partenza e arrivo" : "Estremo")) + `</div></div>`;
  }
  const ICONA_SV = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><circle cx="12" cy="5" r="2.6" fill="currentColor"/><path d="M9.5 9h5l.8 6h-1.8l-.5 5h-2l-.5-5H8.7Z" fill="currentColor"/><ellipse cx="12" cy="20.5" rx="8" ry="2" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';

  // Link che apre Trekking con la stessa mappa, le stesse impostazioni e la scheda di questo sentiero
  const ICONA_WA = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M12 3a9 9 0 0 0-7.8 13.5L3 21l4.6-1.2A9 9 0 1 0 12 3Z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8.6 8.4c.2-.5.5-.5.8-.5h.5c.2 0 .4 0 .5.4l.7 1.6c.1.2 0 .4-.1.6l-.5.6c-.1.1-.2.3 0 .5.6 1 1.4 1.8 2.4 2.4.2.1.4.1.5 0l.6-.7c.2-.2.4-.2.6-.1l1.6.7c.3.1.4.3.4.5v.5c0 .3-.1.7-.6.9-.5.3-1.4.5-2.6.1a9 9 0 0 1-4.6-4.3c-.6-1.2-.4-2.2-.2-2.7Z" fill="currentColor"/></svg>';
  function linkCondiviso(s) {
    const c = mappa.getCenter();
    const q = new URLSearchParams({
      ref: "whatsapp", s: s.i,
      c: stato.centro.lat.toFixed(5) + "," + stato.centro.lon.toFixed(5),
      v: c.lat.toFixed(5) + "," + c.lng.toFixed(5) + "," + mappa.getZoom(),
      r: stato.raggio, k: [...stato.categorie].join(","), o: stato.ordine, b: sfondoAttivo
    });
    if (stato.filtri.size) q.set("f", [...stato.filtri].join(","));
    return location.origin + location.pathname + "?" + q.toString().replace(/%2C/g, ",");
  }
  function linkWhatsApp(s) {
    const diff = QT.DIFFICOLTA[s.d];
    const dati = [diff.sigla !== "?" ? diff.nome : "", QT.formattaKm(s.l), s.su != null ? "↗ " + s.su + " m" : ""].filter(Boolean).join(", ");
    return "https://wa.me/?text=" + encodeURIComponent(
      `Guarda questo sentiero su Qui-Trekking: ${QT.titoloSentiero(s)}${dati ? " (" + dati + ")" : ""}. ` + linkCondiviso(s));
  }

  // ---------- Dislivello dalle quote del terreno ----------
  // Quando OpenStreetMap non ha salita e discesa, si chiedono a Open-Meteo le quote di 100 punti lungo il sentiero.
  const quoteCalcolate = new Map();
  async function calcolaQuote(s) {
    if (quoteCalcolate.has(s.i)) return quoteCalcolate.get(s.i);
    const salvate = await Memoria.leggi("quote", s.i).catch(() => null);
    if (salvate && salvate.l === (s.lv || s.l)) { quoteCalcolate.set(s.i, salvate); return salvate; }
    const c = QT.campioni(s, 100);
    if (c.length < 2) return null;
    const url = cfg.quote + "?latitude=" + c.map((p) => p.la.toFixed(5)).join(",") + "&longitude=" + c.map((p) => p.lo.toFixed(5)).join(",");
    const r = await fetchJson(url, {}, 15000);
    const quote = r.elevation || [];
    const d = QT.dislivello(quote, c.map((p) => p.tratto));
    if (!d) return null;
    // per il disegno del profilo si usa solo il tratto più lungo (il primo)
    d.serie = quote.filter((h, i) => c[i].tratto === 0 && isFinite(h)).map((h) => Math.round(h));
    d.l = s.lv || s.l;
    quoteCalcolate.set(s.i, d);
    Memoria.salva("quote", s.i, d).catch(() => {});
    return d;
  }
  function riempiQuote(el, s) {
    const scrivi = (q) => {
      const num = el.querySelector(`[data-num="${CSS.escape(s.i)}"]`);
      if (num) num.innerHTML = numeriSentiero(s, q);
      const prof = el.querySelector(`[data-prof="${CSS.escape(s.i)}"]`);
      if (prof) prof.innerHTML = profiloSvg(q);
    };
    calcolaQuote(s).then((q) => scrivi(q || null)).catch(() => {
      const num = el.querySelector(`[data-num="${CSS.escape(s.i)}"]`);
      if (num && s.su == null) num.innerHTML = numeriSentiero(s, null).replace("dislivello: calcolo", "dislivello non disponibile").replace("<b>…</b>", "<b>–</b>");
    });
  }

  // ---------- Foto delle fontanelle e sorgenti ----------
  // Il sito non ha un server: la foto resta nel telefono (IndexedDB), ridotta per non occupare spazio.
  function riduciFoto(file) {
    return new Promise((ok, ko) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const max = 1280, sc = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * sc);
        c.height = Math.round(img.naturalHeight * sc);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? ok(b) : ko(new Error("foto"))), "image/jpeg", 0.75);
      };
      img.onerror = () => { URL.revokeObjectURL(url); ko(new Error("foto")); };
      img.src = url;
    });
  }

  let urlFoto = null;
  function mostraFoto(box) {
    const id = box.dataset.id;
    Memoria.leggi("foto", id).then((blob) => {
      if (!box.isConnected) return;
      if (urlFoto) { URL.revokeObjectURL(urlFoto); urlFoto = null; }
      if (blob) {
        urlFoto = URL.createObjectURL(blob);
        box.innerHTML = `<img src="${urlFoto}" alt="La tua foto">
          <div class="pop-foto-azioni"><button type="button" class="pop-rifai">Rifai la foto</button></div>
          <input type="file" accept="image/*" capture="environment" class="pop-file" tabindex="-1" aria-hidden="true">`;
      } else {
        box.innerHTML = `<button type="button" class="pop-scatta">📷 Scatta una foto</button>
          <input type="file" accept="image/*" capture="environment" class="pop-file" tabindex="-1" aria-hidden="true">`;
      }
      const file = box.querySelector(".pop-file");
      box.querySelector(".pop-scatta, .pop-rifai").addEventListener("click", () => file.click());
      file.addEventListener("change", () => {
        const f = file.files && file.files[0];
        if (!f) return;
        box.innerHTML = '<p class="fonte">Salvo la foto…</p>';
        riduciFoto(f).then((b) => Memoria.salva("foto", id, b))
          .then(() => {
            if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
            mostraFoto(box);
          })
          .catch(() => { toast("Non sono riuscito a salvare la foto."); mostraFoto(box); });
      });
    }).catch(() => { box.hidden = true; });
  }

  // ---------- Sentiero evidenziato ----------
  // Il sentiero scelto resta evidenziato, intero, anche dopo aver chiuso la scheda; si toglie solo con Esci nel riquadro di navigazione.
  let evidenziato = null, scelto = null;
  function evidenzia(id) {
    if (evidenziato === id) return;
    evidenziato = id;
    for (const [k, v] of lineePerId) {
      const su = k === id;
      const opaco = id && !su;
      v.linee.forEach((l) => l.setStyle({ weight: su ? 7 : 4.5, opacity: opaco ? .35 : 1 }));
      v.bordo.forEach((l) => l.setStyle({ weight: su ? 11 : 7.5, opacity: opaco ? .2 : .85 }));
      if (su) { v.bordo.forEach((l) => l.bringToFront()); v.linee.forEach((l) => l.bringToFront()); }
    }
  }
  // Con un sentiero scelto si è "in navigazione": si esce solo con il pulsante Esci del riquadro (esci = true),
  // non toccando la mappa né aprendo un punto. Scegliere un altro sentiero passa a quello.
  function scegliSentiero(s, esci) {
    if (!s && scelto && !esci) return;
    scelto = s || null;
    livelli.scelto.clearLayers();
    // non disegnato (fuori dalle difficoltà scelte o dai filtri): lo si disegna a parte
    if (s && !lineePerId.has(s.i)) {
      s.g.forEach((l) => L.polyline(l, { renderer: tela, color: "#ffffff", weight: 11, opacity: .85, interactive: false }).addTo(livelli.scelto));
      s.g.forEach((l) => L.polyline(l, { renderer: tela, color: coloreDiff(s.d), weight: 7, interactive: false }).addTo(livelli.scelto));
    }
    evidenziato = undefined;
    evidenzia(s ? s.i : null);
    aggiornaGuida();
  }
  mappa.on("click", () => scegliSentiero(null));


  // ---------- Anteprima: toccando un sentiero sulla mappa ----------
  // Un fumetto con il segnavia e il nome, e il sentiero evidenziato; toccando il fumetto si apre la scheda,
  // toccando un punto vuoto della mappa il fumetto si chiude e torna la mappa com'era.
  let anteprima = null, anteprimaId = null;
  function apriAnteprima(s, dove) {
    const div = document.createElement("div");
    div.className = "anteprima";
    div.setAttribute("role", "button");
    div.tabIndex = 0;
    div.innerHTML = `${segnavia(s, 30)}<span class="ant-nome">${esc(QT.titoloSentiero(s))}${avvisoCai(s) ? `<small class="ant-cai cai-${avvisoCai(s)}">⚠ ${PERCORRIBILITA[avvisoCai(s)]}</small>` : ""}</span><span class="ant-vai" aria-hidden="true">›</span>`;
    const apri = () => { chiudiAnteprima(); mostraSentiero(s); };
    div.addEventListener("click", (e) => { e.stopPropagation(); apri(); });
    div.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apri(); } });
    L.DomEvent.disableClickPropagation(div);
    chiudiAnteprima();
    evidenziato = undefined;
    evidenzia(s.i);
    anteprima = L.popup({ closeButton: false, autoPan: true, className: "pop-anteprima", maxWidth: 300, offset: [0, -4] })
      .setLatLng(dove).setContent(div).openOn(mappa);
    anteprimaId = s.i;
    anteprima.on("remove", () => { anteprima = null; anteprimaId = null; evidenziato = undefined; evidenzia(scelto ? scelto.i : null); });
  }
  function chiudiAnteprima() { if (anteprima) mappa.closePopup(anteprima); }

  // ---------- Scheda: la terza pagina, dopo la mappa e l'elenco ----------
  const schedaAperta = () => !$("scheda").hidden;
  function apriScheda(html, titolo, s) {
    const corpo = $("scheda-contenuto");
    corpo.innerHTML = html;
    $("scheda-titolo").textContent = titolo;
    $("scheda").hidden = false;
    $("scheda").querySelector(".pannello-corpo").scrollTop = 0;
    const box = corpo.querySelector(".pop-foto");
    if (box) mostraFoto(box);
    if (s) {
      if (s.su == null || !quoteCalcolate.has(s.i)) riempiQuote(corpo, s);
      preparaScarica(corpo, s);
      preparaSalva(corpo, s);
      const wa = corpo.querySelector(".pop-whatsapp");
      // il link si prepara al momento del tocco, con la mappa com'è adesso
      if (wa) wa.addEventListener("click", () => {
        wa.href = linkWhatsApp(s);
        if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: "invia-sentiero-whatsapp", title: "Invia sentiero su WhatsApp", event: true });
      });
    }
    $("btn-chiudi-scheda").focus();
    if (letturaAttiva) leggi(corpo.firstElementChild && corpo.firstElementChild.dataset.voce);
  }
  function chiudiScheda() {
    if (!schedaAperta()) return false;
    $("scheda").hidden = true;
    $("scheda-contenuto").innerHTML = "";
    if (sintesi) sintesi.cancel();
    return true;
  }
  $("btn-chiudi-scheda").addEventListener("click", chiudiScheda);
  $("scheda-contenuto").addEventListener("click", (e) => { if (e.target.closest(".pop-mappa")) chiudiScheda(); });

  // ---------- Rendering ----------
  // Ordine sulla mappa: rifugi sopra, poi bivacchi, poi l'acqua; gli aperti sopra i chiusi
  const PESO = { R: 900, B: 700, W: 500, S: 300 };

  function render() {
    livelli.raggio.clearLayers();
    livelli.sentieri.clearLayers();
    livelli.etichette.clearLayers();
    livelli.punti.clearLayers();
    markerPerId.clear();
    lineePerId.clear();
    evidenziato = null;
    if (!stato.centro) return;
    const { lat, lon } = stato.centro;

    L.circle([lat, lon], {
      radius: stato.raggio, color: getComputedStyle(document.documentElement).getPropertyValue("--blu").trim() || "#2f6b2a",
      weight: 1.5, opacity: .6, fillOpacity: .03, dashArray: "6 6", interactive: false
    }).addTo(livelli.raggio);
    if (!stato.centro.daGps) {
      L.circleMarker([lat, lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#172033", fillOpacity: 1 }).addTo(livelli.raggio);
    }

    // Sentieri: prima i facili, così i difficili restano sopra
    const ordineDiff = (s) => QT.ORDINE_DIFF.indexOf(s.d === "ND" ? "T" : s.d);
    const sentieri = stato.viciniS.slice().sort((a, b) => ordineDiff(a) - ordineDiff(b));
    for (const s of sentieri) {
      const colore = coloreDiff(s.d);
      const apri = () => mostraSentiero(s);
      const tocca = (e) => apriAnteprima(s, e.latlng);
      const bordo = s.g.map((l) => L.polyline(l, { renderer: tela, color: "#ffffff", weight: 7.5, opacity: .85, interactive: false }).addTo(livelli.sentieri));
      const linee = s.g.map((l) => L.polyline(l, {
        renderer: tela, color: colore, weight: 4.5, opacity: 1, lineCap: "round", lineJoin: "round",
        dashArray: s.d === "EEA" ? "10 6" : s.d === "ND" ? "2 7" : null,
        bubblingMouseEvents: false   // il tocco sulla linea non arriva alla mappa (che toglierebbe l'evidenziato)
      }).on("click", tocca).addTo(livelli.sentieri));
      // segnavia col numero a metà del tratto più lungo
      let etichetta = null;
      if (s.r || s.sim) {
        const l = s.g[0];
        const m = l[Math.floor(l.length / 2)];
        etichetta = L.marker(m, {
          icon: L.divIcon({ className: "", html: `<div class="lbl-sentiero">${segnavia(s, 22)}</div>`, iconSize: null, iconAnchor: [14, 11] }),
          title: QT.titoloSentiero(s), zIndexOffset: -500
        }).on("click", tocca).addTo(livelli.etichette);
      }
      // non percorribile (o solo in parte) secondo il CAI: un avviso sul sentiero
      const av = avvisoCai(s);
      if (av) {
        const l = s.g.reduce((a, b) => (b.length > a.length ? b : a));
        const m = l[Math.floor(l.length * (etichetta ? 0.25 : 0.5))];
        L.marker(m, {
          icon: L.divIcon({ className: "", html: `<div class="avviso-cai cai-${av}">!</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }),
          title: PERCORRIBILITA[av] + " (CAI)", zIndexOffset: -400
        }).on("click", tocca).addTo(livelli.etichette);
      }
      lineePerId.set(s.i, { linee, bordo, etichetta, apri });
    }
    if (scelto) scegliSentiero(stato.viciniS.find((x) => x.i === scelto.i) || scelto);
    if (anteprimaId) { evidenziato = undefined; evidenzia(anteprimaId); }   // il fumetto aperto resta evidenziato

    const daMostrare = stato.viciniP.slice().sort((a, b) => a.distanza - b.distanza).slice(0, cfg.maxSegnaposto || 800);
    for (const d of daMostrare) {
      const z = (PESO[d.k] || 0) + (d.apertura && !d.apertura.aperto ? -100 : 0);
      const m = L.marker([d.la, d.lo], { icon: icona(classiMarker(d), SIMBOLO[d.k]), title: QT.titolo(d), zIndexOffset: z })
        .on("click", () => mostra(d)).addTo(livelli.punti);
      markerPerId.set(d.i, m);
    }
    if (stato.viciniP.length > daMostrare.length) {
      toast(`Sulla mappa i ${daMostrare.length} punti più vicini su ${stato.viciniP.length}: togli qualche tipo o riduci il raggio.`);
    }

    const tuttiP = QT.preparaPunti(stato.punti, lat, lon, stato.raggio, null);
    const acqua = tuttiP.filter((d) => d.k === "W").sort((a, b) => a.distanza - b.distanza)[0];
    $("k-n").textContent = stato.viciniS.length;
    $("k-rif").textContent = tuttiP.filter((d) => d.k === "R" || d.k === "B").length;
    $("k-acqua").textContent = acqua ? QT.formattaDistanza(acqua.distanza) : "–";
    const n = stato.viciniS.length + stato.viciniP.length;
    const badge = $("badge-elenco");
    badge.hidden = !n;
    badge.textContent = n > 999 ? "999+" : n;

    renderLista();
  }

  function voceSentiero(s) {
    const li = document.createElement("li");
    li.className = "voce";
    li.tabIndex = 0;
    const meta = [pastiglia(s.d), `<span>${QT.formattaKm(s.l)}</span>`];
    const av = avvisoCai(s);
    if (av) meta.unshift(`<span class="tag cai-${av}">⚠ ${PERCORRIBILITA[av]}</span>`);
    const c = datoCai(s), su = s.su != null ? s.su : c && c.su;
    if (su != null) meta.push(`<span>↗ ${su} m</span>`);
    const sotto = QT.sottotitoloSentiero(s);
    if (sotto && sotto !== QT.titoloSentiero(s)) meta.push(`<span>${esc(sotto)}</span>`);
    li.innerHTML = `
      <div class="icona-tipo">${segnavia(s, 26)}</div>
      <div class="voce-testo">
        <div class="voce-titolo">${esc(QT.titoloSentiero(s))}</div>
        <div class="voce-meta">${meta.join("")}</div>
      </div>
      <div class="voce-dist"><b>${QT.formattaDistanza(s.distanza)}</b><small>il punto più vicino</small></div>`;
    const apri = () => { chiudiElenco(); mostraSentiero(s); };
    li.addEventListener("click", apri);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apri(); } });
    return li;
  }

  function vocePunto(d) {
    const li = document.createElement("li");
    li.className = "voce";
    li.tabIndex = 0;
    const meta = [];
    if (QT.titolo(d) !== QT.nomeTipo(d)) meta.push(`<span>${esc(QT.nomeTipo(d))}</span>`);
    if (d.q) meta.push(`<span>${QT.formattaQuota(+d.q)}</span>`);
    if (d.x) meta.push(`<span>${esc(d.x)}</span>`);
    if (d.apertura) meta.push(`<span class="tag ${d.apertura.aperto ? "aperto" : "chiuso"}">${esc(QT.testoApertura(d.apertura))}</span>`);
    li.innerHTML = `
      <div class="icona-tipo"><span class="mk ${classiMarker(d)}">${SIMBOLO[d.k]}</span></div>
      <div class="voce-testo">
        <div class="voce-titolo">${esc(QT.titolo(d))}</div>
        <div class="voce-meta">${meta.join("")}</div>
      </div>
      <div class="voce-dist"><b>${QT.formattaDistanza(d.distanza)}</b><small>in linea d'aria</small></div>`;
    const apri = () => { chiudiElenco(); mostra(d); };
    li.addEventListener("click", apri);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apri(); } });
    return li;
  }

  function renderLista() {
    renderSalvati();
    const ol = $("lista");
    ol.innerHTML = "";
    const nome = (x) => x.g ? QT.titoloSentiero(x) : QT.titolo(x);
    const lista = [...stato.viciniS, ...stato.viciniP].sort((a, b) => {
      if (stato.ordine === "nome") return nome(a).localeCompare(nome(b), "it", { numeric: true }) || a.distanza - b.distanza;
      if (stato.ordine === "lunghezza") return (a.g ? 0 : 1) - (b.g ? 0 : 1) || (a.l || 0) - (b.l || 0) || a.distanza - b.distanza;
      return a.distanza - b.distanza;
    });
    if (!lista.length) {
      const li = document.createElement("li");
      li.className = "vuoto";
      li.textContent = stato.caricando ? "Scarico i dati…" : stato.filtri.size
        ? "Niente con questi filtri. Prova a toglierne uno o ad allargare il raggio."
        : "Nessun sentiero o punto scelto in questo raggio. Prova ad allargarlo o a scegliere altro in “Cosa mostrare”.";
      ol.appendChild(li);
      return;
    }
    lista.slice(0, 250).forEach((x) => ol.appendChild(x.g ? voceSentiero(x) : vocePunto(x)));
  }

  // Punto: la mappa va sul punto e si apre la sua scheda
  function mostra(d) {
    if (!d) return;
    stato.seguiGps = false;
    scegliSentiero(null);
    mappa.setView([d.la, d.lo], Math.max(mappa.getZoom(), 15));
    if (!markerPerId.has(d.i)) {
      // fuori dai tipi scelti: segnaposto temporaneo
      const m = L.marker([d.la, d.lo], { icon: icona(classiMarker(d), SIMBOLO[d.k]), zIndexOffset: 2000 })
        .on("click", () => mostra(d)).addTo(livelli.punti);
      markerPerId.set(d.i, m);
    }
    apriScheda(popupPunto(d), QT.nomeTipo(d));
  }

  // Sentiero: la mappa mostra sempre il sentiero intero, evidenziato, e si apre la sua scheda.
  // "vista" = [lat, lon, zoom] per rimettere la mappa com'era (link condiviso) invece di inquadrare il sentiero.
  function mostraSentiero(s, vista) {
    stato.seguiGps = false;
    if (s.distanza == null && stato.centro) {
      const v = QT.puntoPiuVicino(s, stato.centro.lat, stato.centro.lon);
      s = { ...s, distanza: v.distanza, vicino: v.punto };
    }
    if (vista) mappa.setView([vista[0], vista[1]], vista[2], { animate: false });
    else mappa.fitBounds(L.latLngBounds(s.g.flat()), { padding: [30, 30], maxZoom: 16, animate: false });
    scegliSentiero(s);
    apriScheda(popupSentiero(s), "Sentiero", s);
  }

  // ---------- Posizione ----------
  let marcatoreIo, cerchioPrecisione;

  function impostaCentro(lat, lon, daGps) {
    const prima = stato.centro;
    stato.centro = { lat, lon, daGps };
    const spostato = !prima || prima.daGps !== daGps ||
      QT.distanza(prima.lat, prima.lon, lat, lon) > (cfg.ricaricaDopoMetri || 500);
    if (spostato) {
      mappa.fitBounds(L.latLng(lat, lon).toBounds(stato.raggio * 2.1));
      carica();
    }
  }

  // Velocità e rotta: dal GPS quando le dà, altrimenti dalle ultime due posizioni
  let ultimaFix = null, velocita = null, rottaMoto = null;
  function calcolaMoto(p) {
    const { latitude: lat, longitude: lon, accuracy: acc, speed, heading } = p.coords;
    const t = p.timestamp || Date.now();
    let v = null;
    if (speed != null && isFinite(speed) && speed >= 0) v = speed;
    if (ultimaFix) {
      const dt = (t - ultimaFix.t) / 1000, d = QT.distanza(ultimaFix.lat, ultimaFix.lon, lat, lon);
      if (v == null && dt >= 1) v = d > Math.max(acc, ultimaFix.acc) / 2 ? d / dt : 0;
      if (d >= Math.max(8, acc / 2)) rottaMoto = QT.rotta(ultimaFix.lat, ultimaFix.lon, lat, lon);
    }
    if (heading != null && isFinite(heading) && v != null && v > 0.5) rottaMoto = heading;
    if (v != null) velocita = velocita == null ? v : velocita * 0.5 + v * 0.5;   // un po' smorzata
    if (!ultimaFix || QT.distanza(ultimaFix.lat, ultimaFix.lon, lat, lon) >= Math.max(8, acc / 2) || t - ultimaFix.t > 15000) {
      ultimaFix = { lat, lon, acc, t };
    }
  }

  // ---------- Guida sul sentiero scelto: velocità e freccia ----------
  // Con un sentiero scelto e il GPS acceso: in alto a sinistra la velocità e una freccia (nord in alto, come la mappa).
  // Lontano dal sentiero la freccia punta al suo punto più vicino (con una linea tratteggiata sulla mappa);
  // sul sentiero punta lungo il sentiero, nel senso in cui stai camminando.
  function aggiornaGuida() {
    const box = $("guida-rotta");
    livelli.guida.clearLayers();
    if (!scelto) { box.hidden = true; return; }
    box.hidden = false;
    const g = stato.gps && QT.guidaSentiero(scelto, stato.gps.lat, stato.gps.lon, rottaMoto);
    if (!g) {
      $("guida-velocita").textContent = "– km/h";
      $("guida-freccia").style.visibility = "hidden";
      $("guida-testo").textContent = "Aspetto la posizione dal GPS…";
      box.classList.remove("fuori");
      return;
    }
    const { lat, lon, acc } = stato.gps;
    const soglia = Math.max(25, Math.min(acc || 0, 60));
    const sopra = g.distanza <= soglia;
    const dir = sopra ? g.lungoSentiero : g.versoSentiero;
    const kmh = velocita == null ? null : velocita * 3.6;
    $("guida-velocita").textContent = kmh == null ? "– km/h" : (kmh < 0.5 ? "0" : kmh.toFixed(1).replace(".", ",")) + " km/h";
    $("guida-freccia").style.transform = "rotate(" + Math.round(dir || 0) + "deg)";
    $("guida-freccia").style.visibility = dir == null ? "hidden" : "visible";
    const card = dir == null ? "" : " (" + QT.puntoCardinale(dir) + ")";
    $("guida-testo").textContent = sopra ? "Sei sul sentiero: segui la freccia" + card
      : "Sentiero a " + QT.formattaDistanza(g.distanza) + ": vai verso la freccia" + card;
    box.classList.toggle("fuori", !sopra);
    if (!sopra) {
      L.polyline([[lat, lon], g.punto], { renderer: tela, color: "#2f7cf6", weight: 3, dashArray: "6 8", interactive: false }).addTo(livelli.guida);
      L.circleMarker(g.punto, { renderer: tela, radius: 6, color: "#fff", weight: 2, fillColor: "#2f7cf6", fillOpacity: 1, interactive: false }).addTo(livelli.guida);
    }
  }

  $("guida-esci").addEventListener("click", (e) => { e.stopPropagation(); scegliSentiero(null, true); });
  L.DomEvent.disableClickPropagation($("guida-rotta"));

  function suPosizione(p) {
    const { latitude: lat, longitude: lon, accuracy: acc } = p.coords;
    stato.gps = { lat, lon, acc };
    calcolaMoto(p);
    if (!marcatoreIo) {
      marcatoreIo = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="io-box"><div class="io-cono" hidden></div><div class="io"></div></div>', iconSize: [18, 18] }), zIndexOffset: 3000, interactive: false }).addTo(livelli.io);
      cerchioPrecisione = L.circle([lat, lon], { radius: acc, color: "#2f7cf6", weight: 0, fillOpacity: .12, interactive: false }).addTo(livelli.io);
    } else {
      marcatoreIo.setLatLng([lat, lon]);
      cerchioPrecisione.setLatLng([lat, lon]).setRadius(acc);
    }
    if (stato.seguiGps) impostaCentro(lat, lon, true);
    aggiornaGuida();
    disegnaCono();
  }

  // ---------- Cono dell'orientamento sul pallino azzurro ----------
  // Come in Google Maps, ma lungo il doppio: punta dove è rivolto il telefono (bussola).
  // Android: evento deviceorientationabsolute, senza permessi. iPhone: serve il permesso «Movimento e orientamento»,
  // chiesto al tocco del pulsante della posizione (e poi al primo tocco, se già concesso una volta).
  // Senza bussola, mentre cammini il cono segue la direzione di marcia del GPS.
  let bussola = null, bussolaT = 0, conoFrame = 0;
  function angoloSchermo() {
    const o = screen.orientation && screen.orientation.angle;
    return isFinite(o) ? o : (isFinite(window.orientation) ? +window.orientation : 0);
  }
  function suBussola(e) {
    let h = null;
    if (e.webkitCompassHeading != null && isFinite(e.webkitCompassHeading)) h = e.webkitCompassHeading + angoloSchermo();
    else if ((e.absolute || e.type === "deviceorientationabsolute") && e.alpha != null && isFinite(e.alpha)) h = 360 - e.alpha + angoloSchermo();
    if (h == null) return;
    h = ((h % 360) + 360) % 360;
    // smorzata, tenendo conto del passaggio 359° → 0°
    if (bussola == null) bussola = h;
    else bussola = (bussola + ((((h - bussola) % 360) + 540) % 360 - 180) * 0.3 + 360) % 360;
    bussolaT = Date.now();
    if (!conoFrame) conoFrame = requestAnimationFrame(() => { conoFrame = 0; disegnaCono(); });
  }
  function disegnaCono() {
    const cono = marcatoreIo && marcatoreIo.getElement() && marcatoreIo.getElement().querySelector(".io-cono");
    if (!cono) return;
    let dir = Date.now() - bussolaT < 3000 ? bussola : null;
    if (dir == null && velocita != null && velocita > 0.5 && rottaMoto != null) dir = rottaMoto;
    cono.hidden = dir == null;
    if (dir != null) cono.style.transform = "rotate(" + Math.round(dir) + "deg)";
  }
  function avviaBussola(chiedi) {
    const D = window.DeviceOrientationEvent;
    if (!D) return;
    if ("ondeviceorientationabsolute" in window) {
      // Android (Chrome, Samsung…): la bussola arriva senza chiedere niente
      window.addEventListener("deviceorientationabsolute", suBussola, true);
    } else if (typeof D.requestPermission === "function") {
      if (!chiedi) return;
      D.requestPermission().then((r) => {
        if (r !== "granted") return;
        salvaPref("bussola", "1");
        window.addEventListener("deviceorientation", suBussola, true);
      }).catch(() => {});
    } else {
      window.addEventListener("deviceorientation", suBussola, true);
    }
  }
  avviaBussola(false);
  const bussolaIphone = !("ondeviceorientationabsolute" in window) && window.DeviceOrientationEvent && typeof DeviceOrientationEvent.requestPermission === "function";
  if (bussolaIphone) {
    let chiesta = false;
    const alTocco = () => { if (!chiesta) { chiesta = true; avviaBussola(true); } };
    $("btn-centra").addEventListener("click", alTocco);
    if (leggiPref("bussola", "0") === "1") document.addEventListener("touchend", alTocco, { once: true, passive: true });
  }

  function erroreGps(e) {
    const testi = {
      1: "Posizione non autorizzata. Consenti l'accesso alla posizione oppure cerca un luogo.",
      2: "Posizione non disponibile. Cerca un luogo qui sopra.",
      3: "Il GPS non risponde. Cerca un luogo qui sopra."
    };
    if (!stato.gps) messaggio(testi[e.code] || testi[2], true);
  }

  function avviaGps() {
    if (!("geolocation" in navigator)) {
      messaggio("Questo browser non fornisce la posizione. Cerca un luogo qui sopra.", true);
      return;
    }
    if (!window.isSecureContext) {
      messaggio("Il GPS funziona solo su HTTPS. Pubblica l'app su un sito https o cerca un luogo.", true);
    }
    navigator.geolocation.watchPosition(suPosizione, erroreGps, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }

  // ---------- Ricerca luogo ----------
  $("form-cerca").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("cerca-indirizzo").value.trim();
    if (!q) return;
    messaggio("Cerco “" + q + "”…");
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=it,ch,fr,at,si,sm,va&accept-language=it&q=" + encodeURIComponent(q);
      const [primo] = await fetchJson(url, { headers: { Accept: "application/json" } }, 12000);
      if (!primo) { messaggio("Luogo non trovato. Prova ad aggiungere il comune o la provincia.", true); return; }
      stato.seguiGps = false;
      $("cerca-indirizzo").blur();
      impostaCentro(+primo.lat, +primo.lon, false);
    } catch (err) {
      messaggio("Ricerca non riuscita. Controlla la connessione.", true);
    }
  });

  // ---------- Controlli ----------
  $("btn-centra").addEventListener("click", () => {
    stato.seguiGps = true;
    if (stato.gps) {
      impostaCentro(stato.gps.lat, stato.gps.lon, true);
      mappa.fitBounds(L.latLng(stato.gps.lat, stato.gps.lon).toBounds(stato.raggio * 2.1));
    } else toast("Posizione non ancora disponibile.");
  });
  $("btn-aggiorna").addEventListener("click", () => carica(true));
  // I pulsanti in basso cercano tra tutti i punti nel raggio, qualunque cosa sia scelta in alto
  const tuttiNelRaggio = () => stato.centro ? QT.preparaPunti(stato.punti, stato.centro.lat, stato.centro.lon, stato.raggio, null) : [];
  $("btn-rifugio").addEventListener("click", () => {
    const rif = tuttiNelRaggio().filter((x) => x.k === "R").sort((a, b) => a.distanza - b.distanza);
    const aperto = rif.find((x) => x.apertura && x.apertura.aperto);
    if (aperto) { mostra(aperto); return; }
    if (rif[0]) { mostra(rif[0]); if (rif.some((x) => x.apertura)) toast("Nessun rifugio risulta aperto adesso: ecco il più vicino. Telefona prima."); return; }
    const biv = tuttiNelRaggio().filter((x) => x.k === "B").sort((a, b) => a.distanza - b.distanza)[0];
    if (biv) { mostra(biv); toast("Nessun rifugio nel raggio: ecco il bivacco più vicino."); return; }
    toast(`Nessun rifugio entro ${QT.formattaDistanza(stato.raggio)}: allarga il raggio.`);
  });
  $("btn-acqua").addEventListener("click", () => {
    const tutti = tuttiNelRaggio();
    const d = tutti.filter((x) => x.k === "W" && !/non potabile/.test(x.x || "")).sort((a, b) => a.distanza - b.distanza)[0];
    if (d) { mostra(d); return; }
    const s = tutti.filter((x) => x.k === "S").sort((a, b) => a.distanza - b.distanza)[0];
    if (s) { mostra(s); toast("Nessuna fontanella nel raggio: ecco la sorgente più vicina. Non è detto che sia potabile."); return; }
    toast(`Nessuna fontanella entro ${QT.formattaDistanza(stato.raggio)}: allarga il raggio.`);
  });

  $("raggio").value = String(stato.raggio);
  $("raggio").addEventListener("change", (e) => {
    stato.raggio = +e.target.value;
    salvaPref("raggio", stato.raggio);
    if (stato.centro) {
      mappa.fitBounds(L.latLng(stato.centro.lat, stato.centro.lon).toBounds(stato.raggio * 2.1));
      carica();
    }
  });

  // Cosa mostrare: caselle per le difficoltà dei sentieri e per i tipi di punti; la mappa cambia subito
  const BREVE = { R: "Rifugi", B: "Bivacchi", W: "Fontanelle", S: "Sorgenti" };
  $("cat-sentieri").innerHTML = QT.ORDINE_DIFF.map((d) =>
    `<label class="cat-voce"><input type="checkbox" value="D${d}"${stato.categorie.has("D" + d) ? " checked" : ""}>` +
    `${pastiglia(d)}<span>${esc(QT.DIFFICOLTA[d].nome)}</span></label>`).join("");
  $("cat-voci").innerHTML = Object.entries(QT.TIPI).map(([k, t]) =>
    `<label class="cat-voce"><input type="checkbox" value="${k}"${stato.categorie.has(k) ? " checked" : ""}>` +
    `<span class="mk tipo-${k}">${SIMBOLO[k]}</span><span>${esc(t.plurale)}</span></label>`).join("");
  function scriviCategorie() {
    const diff = CHIAVI_DIFF.filter((k) => stato.categorie.has(k));
    const punti = Object.keys(QT.TIPI).filter((k) => stato.categorie.has(k));
    const parti = [];
    if (diff.length === CHIAVI_DIFF.length) parti.push(punti.length ? "Sentieri +" + punti.length : "Sentieri");
    else if (diff.length) parti.push(diff.map((k) => QT.DIFFICOLTA[k.slice(1)].sigla).join(" "));
    if (diff.length === CHIAVI_DIFF.length && punti.length) { /* già scritto */ }
    else if (punti.length === 1) parti.push(BREVE[punti[0]]);
    else if (punti.length) parti.push(punti.length + " punti");
    $("categoria-testo").textContent = parti.length ? parti.join(" + ") : "Nessuno";
  }
  scriviCategorie();
  function cambiaCategoria(e) {
    const k = e.target.value;
    if (e.target.checked) stato.categorie.add(k); else stato.categorie.delete(k);
    salvaPref("categorie", [...stato.categorie].join(","));
    scriviCategorie();
    ricalcola();
  }
  $("cat-sentieri").addEventListener("change", cambiaCategoria);
  $("cat-voci").addEventListener("change", cambiaCategoria);
  function apriCategorie(apri) {
    $("cat-menu").hidden = !apri;
    $("categoria").setAttribute("aria-expanded", String(apri));
    if (!apri && !stato.categorie.size) toast("Niente di scelto: la mappa resta vuota");
  }
  $("categoria").addEventListener("click", () => apriCategorie($("cat-menu").hidden));
  $("cat-ok").addEventListener("click", () => { apriCategorie(false); $("categoria").focus(); });
  document.addEventListener("pointerdown", (e) => {
    if (!$("cat-menu").hidden && !$("cat-box").contains(e.target)) apriCategorie(false);
  });
  function aggiornaChipOrdine() {
    document.querySelectorAll(".chip.ordine").forEach((c) => c.setAttribute("aria-pressed", String(c.dataset.ordine === stato.ordine)));
  }
  aggiornaChipOrdine();
  document.querySelectorAll(".chip.ordine").forEach((c) => c.addEventListener("click", () => {
    stato.ordine = c.dataset.ordine;
    salvaPref("ordine", stato.ordine);
    aggiornaChipOrdine();
    renderLista();
  }));
  document.querySelectorAll(".chip.filtro").forEach((c) => c.addEventListener("click", () => {
    const f = c.dataset.filtro;
    const on = !stato.filtri.has(f);
    on ? stato.filtri.add(f) : stato.filtri.delete(f);
    c.setAttribute("aria-pressed", String(on));
    ricalcola();
  }));
  document.querySelectorAll(".chip.filtro").forEach((c) => c.setAttribute("aria-pressed", String(stato.filtri.has(c.dataset.filtro))));
  function apriElenco() {
    $("pannello").hidden = false;
    $("btn-elenco").setAttribute("aria-expanded", "true");
    $("btn-chiudi").focus();
  }
  function chiudiElenco() {
    if ($("pannello").hidden) return;
    $("pannello").hidden = true;
    $("btn-elenco").setAttribute("aria-expanded", "false");
    $("btn-elenco").focus();
  }
  // Condividi su WhatsApp: messaggio già scritto con il link all'app (?ref=whatsapp per GoatCounter)
  const linkApp = location.origin + location.pathname + "?ref=whatsapp";
  $("btn-condividi").href = "https://wa.me/?text=" + encodeURIComponent(
    "Ti consiglio Qui-Trekking: trovi sentieri CAI con difficoltà, lunghezza e dislivello, rifugi e fontanelle vicino a te. " +
    "Gratis e senza registrazione: " + linkApp);
  $("btn-condividi").addEventListener("click", () => {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: "condividi-whatsapp", title: "Condividi su WhatsApp", event: true });
  });
  $("btn-elenco").addEventListener("click", apriElenco);
  $("btn-chiudi").addEventListener("click", chiudiElenco);

  // ---------- Guida ----------
  $("g-diff").innerHTML = QT.ORDINE_DIFF.map((d) =>
    `<li><span class="g-segno">${pastiglia(d, true)}</span><div><b>${esc(QT.DIFFICOLTA[d].nome)}</b>: ${esc(QT.DIFFICOLTA[d].spiega.charAt(0).toLowerCase() + QT.DIFFICOLTA[d].spiega.slice(1))}` +
    (d === "EEA" ? " Sulla mappa la linea è tratteggiata." : d === "ND" ? " Sulla mappa la linea è a puntini." : "") + `</div></li>`).join("") +
    `<li><span class="g-segno">${QT.svgSimbolo(QT.SIMBOLO_CAI, 28, "123")}</span><div><b>Segnavia</b>: il simbolo dipinto lungo il sentiero, con il suo numero. Quello bianco e rosso è il segnavia del CAI.</div></li>`;
  $("g-legenda").innerHTML = Object.entries(QT.TIPI).map(([k, t]) =>
    `<li><span class="g-segno"><span class="mk tipo-${k}">${SIMBOLO[k]}</span></span><div><b>${esc(t.nome)}</b>${{
      R: ": rifugio custodito, dove mangiare e dormire nella stagione di apertura.",
      B: ": bivacco o ricovero sempre aperto, senza gestore: riparo d'emergenza.",
      W: ": fontanella di acqua potabile.",
      S: ": sorgente naturale. Si vedono solo scegliendo “Sorgenti” nel menu: l'acqua spesso non è controllata."
    }[k] || "."}</div></li>`).join("");

  let tornaA = null;
  function apriGuida(e) {
    tornaA = e && e.currentTarget ? e.currentTarget : $("btn-guida");
    $("guida").hidden = false;
    $("guida").querySelector(".pannello-corpo").scrollTop = 0;
    $("btn-guida").setAttribute("aria-expanded", "true");
    $("btn-chiudi-guida").focus();
  }
  function chiudiGuida() {
    if ($("guida").hidden) return false;
    $("guida").hidden = true;
    $("btn-guida").setAttribute("aria-expanded", "false");
    if (tornaA && tornaA.offsetParent) tornaA.focus();
    return true;
  }
  $("btn-guida").addEventListener("click", apriGuida);
  $("btn-chiudi-guida").addEventListener("click", chiudiGuida);
  $("guida").querySelectorAll(".g-indice a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const dest = $("guida").querySelector(a.getAttribute("href"));
    if (dest) dest.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("guida-versione").textContent = "Versione " + (cfg.versione || "");
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("cat-menu").hidden) { apriCategorie(false); $("categoria").focus(); return; }
    if (!chiudiGuida() && !chiudiScheda()) chiudiElenco();
  });

  // ---------- Lettura vocale dei riquadri ----------
  // All'avvio la lettura vocale è sempre spenta: si accende dalla pagina Elenco, per questa volta
  let letturaAttiva = false;
  const sintesi = window.speechSynthesis;
  function vocItaliana() {
    const voci = sintesi ? sintesi.getVoices() : [];
    return voci.find((v) => /^it[-_]IT/i.test(v.lang) && v.localService) || voci.find((v) => /^it/i.test(v.lang)) || null;
  }
  function leggi(testo) {
    if (!sintesi || !testo) return;
    sintesi.cancel();
    const u = new SpeechSynthesisUtterance(testo);
    u.lang = "it-IT";
    const v = vocItaliana();
    if (v) u.voice = v;
    u.rate = 1;
    sintesi.speak(u);
  }
  if (!sintesi) { $("riga-lettura").hidden = true; }
  $("lettura").value = letturaAttiva ? "1" : "0";
  $("lettura").addEventListener("change", (e) => {
    letturaAttiva = e.target.value === "1";
    if (letturaAttiva) leggi("Lettura vocale attiva.");
    else if (sintesi) sintesi.cancel();
  });

  // ---------- Auto-refresh ----------
  // Ogni N secondi torna sulla tua posizione e ricalcola sentieri e punti vicini (riscarica solo se ti sei spostato molto).
  let timerAuto;
  function autoAggiorna() {
    if (document.hidden || !stato.gps) return;
    stato.seguiGps = true;
    stato.centro = { lat: stato.gps.lat, lon: stato.gps.lon, daGps: true };
    if (!schedaAperta()) mappa.setView([stato.gps.lat, stato.gps.lon], Math.max(mappa.getZoom(), 13));
    carica(false, true);
  }
  function impostaAuto(sec) {
    clearInterval(timerAuto);
    if (sec > 0) timerAuto = setInterval(autoAggiorna, sec * 1000);
    autoAttivo = sec > 0;
    aggiornaSchermoAcceso();
  }

  // ---------- Schermo sempre acceso (Wake Lock) ----------
  let autoAttivo = false, bloccoSchermo = null, richiestaInCorso = false;
  function mostraOcchio() { $("occhio").hidden = !bloccoSchermo; }
  async function aggiornaSchermoAcceso() {
    const vuole = autoAttivo && document.visibilityState === "visible";
    if (!vuole) {
      if (bloccoSchermo) { const b = bloccoSchermo; bloccoSchermo = null; b.release().catch(() => {}); }
      mostraOcchio();
      return;
    }
    if (bloccoSchermo || richiestaInCorso || !("wakeLock" in navigator)) { mostraOcchio(); return; }
    richiestaInCorso = true;
    try {
      const b = await navigator.wakeLock.request("screen");
      b.addEventListener("release", () => { if (bloccoSchermo === b) { bloccoSchermo = null; mostraOcchio(); } });
      if (autoAttivo && document.visibilityState === "visible") bloccoSchermo = b;
      else b.release().catch(() => {});
    } catch (e) { /* non supportato o negato: l'app funziona lo stesso */ }
    richiestaInCorso = false;
    mostraOcchio();
  }
  document.addEventListener("visibilitychange", aggiornaSchermoAcceso);
  document.addEventListener("pointerdown", () => { if (autoAttivo && !bloccoSchermo) aggiornaSchermoAcceso(); }, { passive: true });

  // All'avvio l'auto-refresh è sempre quello di config.js (0 = spento): l'app riparte dall'ultima posizione e non la sposta
  const secAuto = [0, 30, 60, 120].includes(+cfg.autoRefreshSecondi) ? +cfg.autoRefreshSecondi : 0;
  $("auto-refresh").value = String(secAuto);
  impostaAuto(secAuto);
  $("auto-refresh").addEventListener("change", (e) => {
    impostaAuto(+e.target.value);
    toast(+e.target.value ? `Auto-refresh ogni ${e.target.value} secondi` : "Auto-refresh disattivato");
  });
  $("sfondo").value = sfondoAttivo;
  $("sfondo").addEventListener("change", (e) => impostaSfondo(e.target.value));
  $("suoni").value = suoniAttivi ? "1" : "0";
  $("suoni").addEventListener("change", (e) => {
    suoniAttivi = e.target.value === "1";
    salvaPref("suoni", suoniAttivi ? "1" : "0");
    sbloccaAudio();
    if (suoniAttivi) setTimeout(SUONO.aggiornato, 150); // prova
  });

  // Ogni minuto ricalcola chi è aperto (se non stai guardando un riquadro)
  setInterval(() => { if (stato.centro && !stato.caricando && !document.hidden && $("pannello").hidden && !schedaAperta()) ricalcola(); }, 60000);

  // Numero di versione nell'ultima riga della pagina Elenco
  $("elenco-versione").textContent = "Versione " + (cfg.versione || "");

  // ---------- Avvio ----------
  // Con un link condiviso: la stessa mappa e la scheda dello stesso sentiero. Altrimenti si riparte dall'ultima vista
  // salvata sul telefono: il GPS mostra dove sei ma non sposta la mappa finché non tocchi "Torna alla mia posizione"
  // (o accendi l'auto-refresh). Al primo avvio, senza una vista salvata, si parte dal GPS.
  let vistaSalvata = null;
  try { vistaSalvata = JSON.parse(leggiPref("vista", "null")); } catch (e) { /* ignora */ }
  if (!vistaSalvata || ![vistaSalvata.lat, vistaSalvata.lon, vistaSalvata.z, vistaSalvata.clat, vistaSalvata.clon].every(isFinite)) vistaSalvata = null;
  let attesa = null;
  if (link && (link.centro || link.vista)) {
    const c = link.centro || link.vista;
    stato.seguiGps = false;
    stato.centro = { lat: c[0], lon: c[1], daGps: false, condiviso: true };
    if (link.vista) mappa.setView([link.vista[0], link.vista[1]], link.vista[2]);
    else mappa.fitBounds(L.latLng(c[0], c[1]).toBounds(stato.raggio * 2.1));
    attesa = carica();
  } else if (vistaSalvata) {
    stato.seguiGps = false;
    stato.centro = { lat: vistaSalvata.clat, lon: vistaSalvata.clon, daGps: false, ultima: true };
    mappa.setView([vistaSalvata.lat, vistaSalvata.lon], vistaSalvata.z);
    carica();
  }
  avviaGps();
  if (attesa && link.sentiero) attesa.then(() => {
    const s = stato.viciniS.find((x) => x.i === link.sentiero) || stato.sentieri.find((x) => x.i === link.sentiero);
    if (s) mostraSentiero(s, link.vista);
    else toast("Non trovo il sentiero del link: forse è cambiato su OpenStreetMap.");
  });

  if ("serviceWorker" in navigator && window.isSecureContext) {
    const cerano = !!navigator.serviceWorker.controller;
    let ricaricata = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (cerano && !ricaricata) { ricaricata = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {});
  }
})();
