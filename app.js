/*
 * Qui-Parking – interfaccia: mappa, posizione, caricamento dati, elenco.
 */
(function () {
  "use strict";
  const cfg = window.POSTOLIBERO_CONFIG;
  const $ = (id) => document.getElementById(id);

  const stato = {
    gps: null,          // ultima posizione GPS {lat, lon, acc}
    centro: null,       // punto della ricerca {lat, lon, daGps}
    raggio: cfg.raggioMetri || 1000,
    osm: [], reale: [], segn: [],
    filtri: new Set(),
    caricando: false,
    ultimaSegnalazione: 0,
    seguiGps: true
  };

  // ---------- Mappa ----------
  const mappa = L.map("mappa", { zoomControl: false, attributionControl: true })
    .setView([41.9, 12.5], 6);
  // Sfondo della mappa: stradale (OpenStreetMap) oppure satellite (Esri World Imagery)
  // con sopra i nomi di strade e località per orientarsi.
  const ESRI = "https://server.arcgisonline.com/ArcGIS/rest/services/";
  const sfondi = {
    stradale: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }),
    // Stessa cartina, ma ogni tessera è disegnata grande il doppio (si usa quella del livello di zoom
    // precedente): così i nomi delle vie si leggono meglio. L'immagine è un po' meno nitida.
    grande: L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, tileSize: 512, zoomOffset: -1,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }),
    satellite: L.layerGroup([
      L.tileLayer(ESRI + "World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        maxZoom: 19, maxNativeZoom: 19,
        attribution: "Immagini: Esri, Vantor, Earthstar Geographics, GIS User Community · Strade: Esri, HERE, Garmin, © OpenStreetMap"
      }),
      L.tileLayer(ESRI + "Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, opacity: .8 }),
      L.tileLayer(ESRI + "Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19 })
    ])
  };
  let sfondoAttivo = "stradale";
  try { const salvato = localStorage.getItem("postolibero.sfondo"); if (sfondi[salvato]) sfondoAttivo = salvato; } catch (e) { /* ignora */ }
  function impostaSfondo(nome) {
    Object.values(sfondi).forEach((l) => mappa.removeLayer(l));
    sfondoAttivo = sfondi[nome] ? nome : "stradale";
    sfondi[sfondoAttivo].addTo(mappa);
    document.getElementById("mappa").classList.toggle("satellite", sfondoAttivo === "satellite");
    try { localStorage.setItem("postolibero.sfondo", sfondoAttivo); } catch (e) { /* ignora */ }
  }
  impostaSfondo(sfondoAttivo);

  const livelli = {
    raggio: L.layerGroup().addTo(mappa),
    ztl: L.layerGroup().addTo(mappa),
    varchi: L.layerGroup(),
    strade: L.layerGroup().addTo(mappa),
    stalli: L.layerGroup(),
    numeriStrade: L.layerGroup(),
    luoghi: L.layerGroup().addTo(mappa),
    segn: L.layerGroup().addTo(mappa),
    io: L.layerGroup().addTo(mappa)
  };
  const markerPerId = new Map();
  // "La tua auto" (sezione più sotto): segnaposto vuoto finché la sezione non è pronta
  let Auto = { posizione() {}, salva() {}, perElenco() { return null; }, marker() { return null; } };

  // Da zoom 17 i singoli stalli, da zoom 18 il numero di posti stimato sulle strade
  const ZOOM_NUMERI_STRADE = 18;
  function aggiornaVisibilitaStalli() {
    if (mappa.getZoom() >= 17) livelli.stalli.addTo(mappa);
    else livelli.stalli.remove();
    if (mappa.getZoom() >= ZOOM_NUMERI_STRADE) livelli.numeriStrade.addTo(mappa);
    else livelli.numeriStrade.remove();
    if (mappa.getZoom() >= 15) livelli.varchi.addTo(mappa);
    else livelli.varchi.remove();
  }
  mappa.on("zoomend", aggiornaVisibilitaStalli);
  mappa.on("dragstart", () => { stato.seguiGps = false; });

  const icona = (cls, html) => L.divIcon({ className: "", html: `<div class="mk ${cls}">${html ?? ""}</div>`, iconSize: null });

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
    timerToast = setTimeout(() => { t.hidden = true; }, 3200);
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const linkNavigazione = (lat, lon) =>
    `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}&travelmode=driving`;

  // ---------- Caricamento dati ----------
  const cacheOsm = new Map();

  async function fetchConTimeout(url, opts, ms) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
    finally { clearTimeout(t); }
  }

  // Scarica e legge il JSON entro "ms" millisecondi in tutto (risposta + dati).
  // "segnale" esterno opzionale per annullare la richiesta da fuori.
  async function fetchJson(url, opts, ms, segnale) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    const annulla = () => ctrl.abort();
    if (segnale) segnale.addEventListener("abort", annulla);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } finally {
      clearTimeout(t);
      if (segnale) segnale.removeEventListener("abort", annulla);
    }
  }

  // Copia di riserva sul telefono: i parcheggi non cambiano spesso, quindi se tutti
  // i server OpenStreetMap sono fuori uso mostriamo l'ultimo risultato salvato per la zona.
  const CHIAVE_RISERVA = "postolibero.osm";
  function leggiRiserva() {
    try { return JSON.parse(localStorage.getItem(CHIAVE_RISERVA) || "[]"); } catch (e) { return []; }
  }
  function salvaRiserva(lat, lon, raggio, json) {
    let lista = leggiRiserva().filter((x) => PL.distanza(x.lat, x.lon, lat, lon) > 300);
    lista.unshift({ lat, lon, raggio, t: Date.now(), json: { elements: json.elements } });
    lista = lista.slice(0, 12);
    // Se la memoria del telefono è piena, toglie le zone più vecchie finché ci sta
    while (lista.length) {
      try { localStorage.setItem(CHIAVE_RISERVA, JSON.stringify(lista)); return; }
      catch (e) { lista.pop(); }
    }
  }
  // Unisce tutte le zone salvate vicine (anche se coprono solo in parte il raggio attuale)
  function cercaRiserva(lat, lon, raggio) {
    const zone = leggiRiserva().filter((x) =>
      PL.distanza(x.lat, x.lon, lat, lon) < x.raggio + raggio &&
      Date.now() - x.t < 30 * 86400000);
    if (!zone.length) return null;
    const visti = new Set(), elementi = [];
    for (const z of zone) {
      for (const el of z.json.elements || []) {
        const id = el.type + el.id;
        if (!visti.has(id)) { visti.add(id); elementi.push(el); }
      }
    }
    return { t: Math.min(...zone.map((z) => z.t)), json: { elements: elementi } };
  }

  // Ordine dei server: prima quello che ha funzionato l'ultima volta
  function serverInOrdine() {
    let ultimo = null;
    try { ultimo = localStorage.getItem("postolibero.overpass"); } catch (e) { /* ignora */ }
    const lista = cfg.overpass.slice();
    const i = lista.indexOf(ultimo);
    if (i > 0) { lista.splice(i, 1); lista.unshift(ultimo); }
    return lista;
  }

  // ---------- Parcheggi salvati nel sito ----------
  // Ogni settimana GitHub scarica i parcheggi di tutta la Lombardia (una zona per provincia)
  // e li salva nella cartella "osm" del sito, divisi in tessere di 0,02 gradi.
  // Lì l'app li legge dal sito, senza dipendere dai server pubblici di OpenStreetMap.
  let indiceSito = null, indiceLetto = 0;
  async function leggiIndice() {
    if (indiceSito && Date.now() - indiceLetto < 3600000) return indiceSito;
    try {
      indiceSito = await fetchJson("osm/indice.json", {}, 8000);
      indiceLetto = Date.now();
    } catch (e) { indiceSito = null; }
    return indiceSito;
  }
  function riquadro(lat, lon, raggio) {
    const dLat = raggio / 111320, dLon = raggio / (111320 * Math.cos(lat * Math.PI / 180));
    return { s: lat - dLat, n: lat + dLat, w: lon - dLon, e: lon + dLon };
  }
  // Come in Trekking: ogni zona (una per provincia della Lombardia) è scaricata allargata di qualche km,
  // quindi se il punto è dentro il riquadro di una zona, quella zona copre tutto il cerchio di ricerca.
  // completa = false (server di OpenStreetMap fuori uso): basta che il punto sia nell'area scaricata.
  async function caricaDalSito(lat, lon, raggio, completa) {
    const ind = await leggiIndice();
    if (!ind || !ind.zone) return null;
    const r = riquadro(lat, lon, raggio);
    const dentro = ([s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e;
    const zona = Object.values(ind.zone).find((z) => {
      if (!z.cartella) {   // vecchio formato (tessere direttamente in osm/), finché GitHub non riscarica
        const [s, w, n, e] = z.bbox;
        return completa ? (r.s >= s && r.n <= n && r.w >= w && r.e <= e) : dentro(z.bbox);
      }
      return dentro(completa ? z.bbox : (z.scaricata || z.bbox));
    });
    if (!zona) return null;
    const passo = ind.passo || 0.02;
    const esistenti = new Set(zona.tessere || []);
    const nomi = [];
    for (let i = Math.floor(r.s / passo); i <= Math.floor(r.n / passo); i++) {
      for (let j = Math.floor(r.w / passo); j <= Math.floor(r.e / passo); j++) {
        const t = `t_${i}_${j}.json`;
        if (esistenti.has(t)) nomi.push(t);
      }
    }
    const cartella = zona.cartella ? zona.cartella + "/" : "";
    const parti = await Promise.all(nomi.map((t) => fetchJson("osm/" + cartella + t, {}, 12000)));
    const elementi = parti.flatMap((p) => p.elements || []);
    return { json: { elements: elementi }, aggiornato: zona.aggiornato };
  }

  async function caricaOsm(lat, lon, raggio) {
    const chiave = `${lat.toFixed(3)},${lon.toFixed(3)},${raggio}`;
    const c = cacheOsm.get(chiave);
    if (c && Date.now() - c.t < 10 * 60000) return PL.analizzaOverpass(c.json, lat, lon, raggio);

    // 1. Prima i parcheggi salvati nel sito, se la zona è coperta
    try {
      const sito = await caricaDalSito(lat, lon, raggio + 150, true);
      if (sito) {
        cacheOsm.set(chiave, { t: Date.now(), json: sito.json });
        stato.osmDaSito = sito.aggiornato;
        stato.osmDaRiserva = null;
        return PL.analizzaOverpass(sito.json, lat, lon, raggio);
      }
    } catch (e) { console.warn("Parcheggi del sito non disponibili", e); }
    stato.osmDaSito = null;
    // 2. Altrimenti (fuori zona) dai server pubblici di OpenStreetMap
    const query = PL.queryOverpass(lat, lon, raggio + 150);
    const fine = new AbortController();

    // Il server preferito parte subito. Il successivo parte dopo 4 secondi, oppure subito
    // se uno dei server già avviati risponde con un errore. Vince la prima risposta valida.
    const lista = serverInOrdine();
    const prova = async (url) => {
      const json = await fetchJson(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query)
      }, 25000, fine.signal);
      // Un server sovraccarico risponde "200 OK" ma con un errore in "remark" e nessun dato
      if (!json || !Array.isArray(json.elements)) throw new Error("Risposta non valida");
      if (json.remark && /error|timed out|out of memory|rate/i.test(json.remark)) throw new Error(json.remark);
      return { url, json };
    };
    const risultato = new Promise((ok, ko) => {
      let prossimo = 0, inCorso = 0, timer, finito = false;
      const avvia = () => {
        clearTimeout(timer);
        if (finito || prossimo >= lista.length) return;
        const url = lista[prossimo++];
        inCorso++;
        prova(url).then((r) => {
          if (finito) return;
          finito = true; clearTimeout(timer);
          fine.abort(); // ferma le richieste ancora in corso
          ok(r);
        }, (e) => {
          inCorso--;
          if (finito) return;
          console.warn("Overpass", url, e && e.message);
          if (prossimo < lista.length) avvia();
          else if (inCorso === 0) { finito = true; ko(e); }
        });
        if (prossimo < lista.length) timer = setTimeout(avvia, 4000);
      };
      avvia();
    });

    try {
      const { url, json } = await risultato;
      cacheOsm.set(chiave, { t: Date.now(), json });
      salvaRiserva(lat, lon, raggio + 150, json);
      try { localStorage.setItem("postolibero.overpass", url); } catch (e) { /* ignora */ }
      stato.osmDaRiserva = null;
      return PL.analizzaOverpass(json, lat, lon, raggio);
    } catch (e) {
      // 3. Server non disponibili: dati del sito anche se coprono solo in parte il cerchio
      try {
        const sito = await caricaDalSito(lat, lon, raggio + 150, false);
        if (sito) {
          stato.osmDaSito = sito.aggiornato;
          stato.osmDaRiserva = null;
          return PL.analizzaOverpass(sito.json, lat, lon, raggio);
        }
      } catch (err) { /* niente */ }
      const riserva = cercaRiserva(lat, lon, raggio);
      if (riserva) {
        stato.osmDaRiserva = riserva.t;
        return PL.analizzaOverpass(riserva.json, lat, lon, raggio);
      }
      throw new Error("OpenStreetMap non raggiungibile");
    }
  }

  function fontiVicine(lat, lon, statiche) {
    return (cfg.openData || []).filter((f) => f.attivo &&
      (f.type === "statico") === statiche &&
      (!f.centro || PL.distanza(lat, lon, f.centro[0], f.centro[1]) <= (f.entroKm || 20) * 1000));
  }

  // Scarica il primo URL che risponde (accetta una stringa o un elenco)
  async function scaricaJson(url) {
    let ultimo;
    for (const u of [].concat(url)) {
      try {
        return await fetchJson(u, {}, 15000);
      } catch (e) { ultimo = e; }
    }
    throw ultimo;
  }

  const fontiAttive = { reale: [], comunali: [] };
  function aggiornaFonti() {
    const parti = [];
    const uniq = (a) => [...new Set(a)];
    if (fontiAttive.reale.length) parti.push("tempo reale: " + uniq(fontiAttive.reale).join(", "));
    if (fontiAttive.comunali.length) parti.push("parcheggi comunali: " + uniq(fontiAttive.comunali).join(", "));
    $("fonti-extra").textContent = parti.length ? ", " + parti.join(", ") : "";
  }

  async function caricaOpenData(lat, lon, raggio) {
    const fonti = fontiVicine(lat, lon, false);
    const risultati = await Promise.allSettled(fonti.map(async (f) =>
      PL.analizzaOpenData(await scaricaJson(f.url), f, lat, lon, raggio)));
    fontiAttive.reale = fonti.filter((_, i) => risultati[i].status === "fulfilled").map((f) => f.nome);
    aggiornaFonti();
    return risultati.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  // I dati comunali statici si scaricano una volta sola per sessione
  const cacheComunali = new Map();
  async function caricaComunali(lat, lon, raggio) {
    const fonti = fontiVicine(lat, lon, true);
    const risultati = await Promise.allSettled(fonti.map(async (f) => {
      const chiave = [].concat(f.url).join("|");
      if (!cacheComunali.has(chiave)) cacheComunali.set(chiave, scaricaJson(f.url));
      try {
        return PL.analizzaStatico(await cacheComunali.get(chiave), f, lat, lon, raggio);
      } catch (e) { cacheComunali.delete(chiave); throw e; }
    }));
    fontiAttive.comunali = fonti.filter((_, i) => risultati[i].status === "fulfilled").map((f) => f.nome);
    aggiornaFonti();
    return risultati.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
  }

  // ---------- Zone a traffico limitato ----------
  // ztl.json è preparato ogni settimana da GitHub (aggiorna_ztl.py): open data dei Comuni
  // (Milano, Bergamo, Cremona), mappa dei varchi di Pavia e OpenStreetMap per le altre città.
  let ztl = { aree: [], varchi: [] }, ztlVersione = 0;
  async function caricaZtl() {
    try {
      const d = await fetchJson(cfg.ztl || "ztl.json", {}, 15000);
      ztl = { aree: d.aree || [], varchi: d.varchi || [] };
      ztlVersione++;
      disegnaZtl();
      render();
    } catch (e) { /* senza file ZTL l'app funziona come prima */ }
  }
  function dentroAnello(lat, lon, anello) {
    let dentro = false;
    for (let i = 0, j = anello.length - 1; i < anello.length; j = i++) {
      const [xi, yi] = anello[i], [xj, yj] = anello[j];
      if ((yi > lat) !== (yj > lat) && lon < (xj - xi) * (lat - yi) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  }
  const PRIORITA_ZONA = { pedonale: 3, ztl: 2, area_c: 1 };
  // La zona più restrittiva che contiene il punto (o null)
  function zonaDi(lat, lon) {
    let migliore = null;
    for (const a of ztl.aree) {
      const b = a.bbox;
      if (lat < b[0] || lat > b[2] || lon < b[1] || lon > b[3]) continue;
      const dentro = a.poligoni.some((poli) => dentroAnello(lat, lon, poli[0]) && !poli.slice(1).some((buco) => dentroAnello(lat, lon, buco)));
      if (dentro && (!migliore || PRIORITA_ZONA[a.tipo] > PRIORITA_ZONA[migliore.tipo])) migliore = a;
    }
    return migliore;
  }
  function zonaLuogo(l) {
    if (l._zv !== ztlVersione) { l._zona = zonaDi(l.lat, l.lon); l._zv = ztlVersione; }
    return l._zona;
  }
  const zonaChiusa = (z) => z && (z.tipo === "ztl" || z.tipo === "pedonale");
  function classeZona(l) {
    const z = zonaLuogo(l);
    return !z ? "" : z.tipo === "area_c" ? " in-areac" : " in-ztl";
  }
  // Nome leggibile: "ZTL di Pavia", "ZTL «Brera»", "area pedonale «Piazza Duomo»"
  function nomeZona(z) {
    const generico = !z.nome || /^(z\.?\s*t\.?\s*l\.?|zona a traffico limitato)[\s\-–.z]*(t\.?\s*l\.?)?$/i.test(z.nome.trim()) ||
      /zona a traffico limitato\s*-?\s*z\.?t\.?l\.?$/i.test(z.nome.trim());
    const nome = generico ? "" : z.nome.replace(/^z\.?t\.?l\.?\s*/i, "").trim();
    if (z.tipo === "pedonale") return "area pedonale" + (nome ? " «" + nome + "»" : "");
    if (z.tipo === "area_c") return "Area C";
    return "ZTL" + (nome ? " «" + nome + "»" : z.citta ? " di " + z.citta : "");
  }
  function avvisoZona(z) {
    if (z.tipo === "area_c") return { testo: "Dentro Area C: si entra pagando il ticket di Area C (o con i permessi previsti)", voce: "Attenzione: è dentro Area C, si entra con il ticket." };
    if (z.tipo === "pedonale") return { testo: "Dentro un'" + nomeZona(z) + ": accesso vietato ai veicoli salvo autorizzazione", voce: "Attenzione: è in area pedonale, accesso solo con autorizzazione." };
    return { testo: "Dentro la " + nomeZona(z) + ": accesso solo con contrassegno", voce: "Attenzione: è dentro la ZTL, accesso solo con contrassegno." };
  }
  // Le ZTL si disegnano una volta sola, tutte, e restano sempre visibili sulla mappa
  function disegnaZtl() {
    livelli.ztl.clearLayers();
    livelli.varchi.clearLayers();
    if (!ztl.aree.length && !ztl.varchi.length) return;
    const vicino = () => true;
    const css = getComputedStyle(document.documentElement);
    const rosso = css.getPropertyValue("--pieno").trim() || "#c23a2f";
    const arancio = css.getPropertyValue("--attenzione").trim() || "#b87900";
    const ordine = { area_c: 0, ztl: 1, pedonale: 2 };
    for (const a of ztl.aree.filter((x) => vicino(x.bbox)).sort((x, y) => ordine[x.tipo] - ordine[y.tipo])) {
      const forme = a.poligoni.map((poli) => poli.map((anello) => anello.map(([x, y]) => [y, x])));
      const stile = a.tipo === "area_c"
        ? { color: arancio, weight: 2, dashArray: "8 6", fillOpacity: 0.04, opacity: 0.8 }
        : { color: rosso, weight: 2, fillColor: rosso, fillOpacity: a.tipo === "pedonale" ? 0.18 : 0.12, opacity: 0.8 };
      const av = avvisoZona(a);
      const testo = `<div class="pop" data-voce="${attr(av.voce)}"><h3>${esc(a.tipo === "area_c" ? "Area C" : a.tipo === "pedonale" ? "Area pedonale" : "ZTL")}${a.citta ? " · " + esc(a.citta) : ""}</h3>` +
        (a.nome && a.tipo !== "area_c" ? `<p>${esc(a.nome)}</p>` : "") +
        `<p class="avviso">${esc(av.testo)}</p>` +
        (a.orari ? `<p>Orari: ${esc(a.orari)}</p>` : "") +
        (a.deroghe ? `<p>Deroghe: ${esc(a.deroghe)}</p>` : "") +
        `<p class="fonte">Fonte: ${esc(a.fonte)}. Fa sempre fede la segnaletica.</p></div>`;
      L.polygon(forme, stile).bindPopup(testo, OPZ_POPUP).addTo(livelli.ztl);
    }
    for (const v of ztl.varchi) {
      if (!vicino([v.lat, v.lon, v.lat, v.lon])) continue;
      L.marker([v.lat, v.lon], { icon: icona("varco"), title: v.nome, zIndexOffset: -200 })
        .bindPopup(`<div class="pop" data-voce="${attr("Varco della ZTL. " + v.nome + ".")}"><h3>Varco ZTL</h3><p>${esc(v.nome)}</p><p class="fonte">Fonte: ${esc(v.fonte)}</p></div>`, OPZ_POPUP)
        .addTo(livelli.varchi);
    }
  }

  // ---------- Suoni ----------
  // Suoni sintetizzati (nessun file da scaricare). Su iPhone il browser li permette solo
  // dopo il primo tocco sullo schermo, quindi l'audio si "sblocca" al primo tocco.
  let audio = null;
  let suoniAttivi = true;
  try { suoniAttivi = localStorage.getItem("postolibero.suoni") !== "0"; } catch (e) { /* ignora */ }
  function sbloccaAudio() {
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state !== "running") audio.resume();
    } catch (e) { /* audio non disponibile */ }
  }
  document.addEventListener("pointerdown", sbloccaAudio, { passive: true });
  document.addEventListener("touchend", sbloccaAudio, { passive: true });

  // L'iPhone fa parlare l'app solo dopo che la voce è partita una volta da un tocco:
  // al primo tocco qualsiasi la sblocchiamo in silenzio, così la lettura vocale funziona subito.
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

  // note: elenco di [frequenza Hz, inizio s, durata s]
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
    errore: () => suona([[392, 0, 0.25], [311, 0.22, 0.45]], 0.3),             // due note che scendono
    nuovoPosto: () => suona([[784, 0, 0.18], [1046.5, 0.15, 0.18], [1568, 0.3, 0.5]], 0.32) // tre note che salgono
  };

  async function caricaSegnalazioni() {
    if (!stato.centro) return;
    const { lat, lon } = stato.centro;
    try {
      const lista = await Segnalazioni.carica(lat, lon, stato.raggio, cfg.durataSegnalazioneMinuti);
      stato.segn = PL.filtraSegnalazioni(lista, lat, lon, stato.raggio, cfg.durataSegnalazioneMinuti);
      // Suono quando compare un posto libero nuovo segnalato da qualcun altro
      const visti = stato.segnViste || (stato.segnViste = new Set());
      const primaVolta = !stato.segnCaricate;
      let nuovo = false;
      for (const x of stato.segn) {
        const id = String(x.id);
        if (visti.has(id)) continue;
        visti.add(id);
        const mia = stato.miaSegnalazione &&
          PL.distanza(x.lat, x.lon, stato.miaSegnalazione.lat, stato.miaSegnalazione.lon) < 20 &&
          Math.abs(x.ts - stato.miaSegnalazione.t) < 120000;
        if (!primaVolta && x.stato === "libero" && !mia) nuovo = true;
      }
      stato.segnCaricate = true;
      if (nuovo) { SUONO.nuovoPosto(); stato.suonoNuovo = Date.now(); }
    } catch (e) {
      console.warn(e);
    }
  }

  let giroCarica = 0;
  async function carica(forza) {
    if (!stato.centro) return;
    const giro = ++giroCarica; // se parte un nuovo caricamento, quello vecchio non aggiorna più la schermata
    stato.caricando = true;
    $("btn-aggiorna").classList.add("gira");
    const { lat, lon } = stato.centro;
    if (forza) cacheOsm.clear();
    messaggio("Cerco parcheggi entro " + PL.formattaDistanza(stato.raggio) + "…");

    let osmLista = null, comunaliLista = [];
    const aggiornaOsm = () => {
      if (giro !== giroCarica) return;
      stato.osm = PL.unisciStatici(osmLista || [], comunaliLista);
      render();
    };

    const pOsm = caricaOsm(lat, lon, stato.raggio).then((l) => { osmLista = l; aggiornaOsm(); });
    const pCom = caricaComunali(lat, lon, stato.raggio).then((l) => { comunaliLista = l; aggiornaOsm(); });
    const pReale = caricaOpenData(lat, lon, stato.raggio).then((l) => {
      if (giro === giroCarica) { stato.reale = l; render(); }
    });
    const pSegn = caricaSegnalazioni().then(() => { if (giro === giroCarica) render(); });

    const [osm] = await Promise.allSettled([pOsm, pCom, pReale, pSegn]);
    if (giro !== giroCarica) return;
    stato.caricando = false;
    $("btn-aggiorna").classList.remove("gira");
    aggiornaOsm();

    const ora = new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    clearTimeout(stato.timerRiprova);
    if (osm.status === "rejected" || stato.osmDaRiserva) {
      // Riprova da sola: dopo 30 s, poi 1 min, poi 2 min, poi ogni 5 min
      const attese = [30, 60, 120, 300];
      const sec = attese[Math.min(stato.tentativiOsm || 0, attese.length - 1)];
      stato.tentativiOsm = (stato.tentativiOsm || 0) + 1;
      stato.timerRiprova = setTimeout(() => carica(true), sec * 1000);
    } else {
      stato.tentativiOsm = 0;
    }
    // Suono di fine aggiornamento (non se è appena suonato quello del nuovo posto libero)
    if (Date.now() - (stato.suonoNuovo || 0) > 3000) {
      (osm.status === "rejected" || stato.osmDaRiserva) ? SUONO.errore() : SUONO.aggiornato();
    }
    const riprovo = (s) => s >= 60 ? `tra ${s / 60} min` : `tra ${s} secondi`;
    const prossima = [30, 60, 120, 300][Math.min((stato.tentativiOsm || 1) - 1, 3)];
    if (osm.status === "rejected") {
      messaggio(`I server di OpenStreetMap sono sovraccarichi. Riprovo da solo ${riprovo(prossima)}.`, true);
    } else if (stato.osmDaRiserva) {
      const quando = new Date(stato.osmDaRiserva).toLocaleDateString("it-IT", { day: "numeric", month: "long" });
      messaggio(`OpenStreetMap non risponde: mostro i parcheggi salvati il ${quando}. Riprovo ${riprovo(prossima)}.`, true);
    } else {
      const dove = stato.centro.daGps ? "dalla tua posizione" : "dal punto cercato";
      const parcheggiDel = stato.osmDaSito
        ? " · parcheggi del " + new Date(stato.osmDaSito).toLocaleDateString("it-IT", { day: "numeric", month: "long" })
        : "";
      messaggio(`Entro ${PL.formattaDistanza(stato.raggio)} ${dove} · aggiornato alle ${ora}${parcheggiDel}` +
        (Segnalazioni.condiviso ? "" : " · segnalazioni solo su questo dispositivo"));
    }
  }

  // ---------- Rendering ----------
  // Tipo di parcheggio per il menu dei tipi da mostrare
  const TIPI_COPERTI = ["multi-storey", "underground", "rooftop"];
  const TIPI_GARAGE = ["carports", "garage_boxes"];
  function tipoLuogo(l) {
    if (l.fonte === "opendata" || l.categoria === "tempo-reale") return "reale";
    if (l.categoria === "strada") return "strada";
    const p = (l.tags && l.tags.parking) || "";
    if (l.categoria === "stallo") return (l.disabili > 0 || (l.tags && l.tags.parking_space === "disabled")) ? "disabili" : "strada";
    if (TIPI_COPERTI.includes(p)) return "multipiano";
    if (TIPI_GARAGE.includes(p)) return "garage";
    if (p === "street_side" || p === "lane") return "strada";
    if (!p && l.coperto) return "multipiano";
    return "aperto";
  }
  // Si vede se il suo tipo è spuntato e anche la sua tariffa; con la tariffa non indicata
  // basta che almeno una delle due tariffe sia spuntata.
  function passaFiltri(l) {
    const tolti = stato.filtri;
    const tipo = tipoLuogo(l);
    if (tolti.has(tipo)) return false;
    if (tolti.has("ztl") && zonaChiusa(zonaLuogo(l))) return false;
    if (tipo === "reale") return true;
    if (l.tariffa === "gratuito") return !tolti.has("gratuito");
    if (l.tariffa === "pagamento") return !tolti.has("pagamento");
    return !(tolti.has("gratuito") && tolti.has("pagamento"));
  }

  // Forma e colore del segnaposto:
  //   quadrato verde = posti liberi ora (con il numero), rosso = pieno,
  //   quadrato blu con il numero = fino a 6 posti, quadrato blu con "N" = posti non indicati,
  //   rettangolo blu (largo il doppio) con il numero dei posti = più di 6 posti
  function coloreLuogo(l) {
    if (l.fonte === "opendata") return l.liberi > 0 ? "verde" : "pieno";
    // il colore dice il tipo di parcheggio (vedi il menu dei tipi), la forma i posti
    const tipo = "t-" + tipoLuogo(l);
    if (l.capienza == null || l.capienza <= 6) return tipo;
    return tipo + " largo";
  }
  function testoLuogo(l) {
    if (l.fonte === "opendata") return String(l.liberi);
    if (l.capienza == null) return "N";
    return String(l.capienza);
  }

  // Testi per la lettura vocale
  function distanzaParlata(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " metri";
    return (m / 1000).toFixed(1).replace(".", ",") + " chilometri";
  }
  function minutiParlati(m) {
    const n = PL.minutiA_piedi(m);
    return n === 1 ? "1 minuto a piedi" : n + " minuti a piedi";
  }
  const attr = (t) => String(t).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const OPZ_POPUP = { maxWidth: 360, minWidth: 260, autoPanPadding: [16, 90] };

  function popupLuogo(l) {
    const righe = [], voce = [];
    const titolo = l.nome || l.via || l.tipo;
    voce.push(titolo + ".");
    if (l.tipo && l.tipo !== titolo) voce.push(l.tipo + ".");
    if (l.fonte === "opendata") {
      righe.push(`<b style="color:var(--libero)">${l.liberi} posti liberi</b>${l.capienza ? " su " + l.capienza : ""}`);
      voce.push(l.liberi > 0 ? `${l.liberi} posti liberi${l.capienza ? " su " + l.capienza : ""}.` : "Pieno.");
      if (l.aggiornato) righe.push("Dato del " + esc(new Date(l.aggiornato).toLocaleString("it-IT")));
      righe.push("Fonte: " + esc(l.fonteNome));
    } else {
      if (l.capienza) {
        righe.push((l.capienzaStimata ? "circa " : "") + l.capienza + " posti");
        voce.push((l.capienzaStimata ? "Circa " : "") + l.capienza + (l.capienza === 1 ? " posto." : " posti."));
      }
      if (l.tariffa === "gratuito") { righe.push("Gratuito"); voce.push("Gratuito."); }
      else if (l.tariffa === "pagamento") { righe.push("A pagamento"); voce.push("A pagamento."); }
      if (l.disabili) { righe.push(l.disabili + " posti disabili"); voce.push(l.disabili + " posti per disabili."); }
      if (l.maxstay) righe.push("Sosta max: " + esc(l.maxstay));
      if (l.orari) righe.push("Orari: " + esc(l.orari));
      if (l.note) righe.push(esc(l.note));
      if (l.fonteNome) righe.push("Fonte: " + esc(l.fonteNome));
      else if (l.fonte === "osm") righe.push(`Fonte: OpenStreetMap · <a href="https://www.openstreetmap.org/${attr(l.id)}" target="_blank" rel="noopener">Vedi su OpenStreetMap</a>`);
    }
    const zona = zonaLuogo(l);
    if (zona) {
      const av = avvisoZona(zona);
      righe.push(`<span class="avviso">${esc(av.testo)}</span>`);
      voce.push(av.voce);
    }
    righe.push(PL.formattaDistanza(l.distanza) + " · " + PL.minutiA_piedi(l.distanza) + " min a piedi");
    voce.push(distanzaParlata(l.distanza) + ", " + minutiParlati(l.distanza) + ".");
    return `<div class="pop" data-voce="${attr(voce.join(" "))}"><h3>${esc(titolo)}</h3>
      <p>${esc(l.tipo)}</p>${righe.map((r) => "<p>" + r + "</p>").join("")}
      <a class="pop-vai" href="${linkNavigazione(l.lat, l.lon)}" target="_blank" rel="noopener">Portami qui</a></div>`;
  }

  function render() {
    Object.entries(livelli).forEach(([k, g]) => { if (k !== "io" && k !== "ztl" && k !== "varchi") g.clearLayers(); });
    markerPerId.clear();
    if (!stato.centro) return;
    const { lat, lon } = stato.centro;

    L.circle([lat, lon], {
      radius: stato.raggio, color: getComputedStyle(document.documentElement).getPropertyValue("--blu").trim() || "#1b4f9c",
      weight: 1.5, opacity: .6, fillOpacity: .04, dashArray: "6 6", interactive: false
    }).addTo(livelli.raggio);
    if (!stato.centro.daGps) {
      L.circleMarker([lat, lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#172033", fillOpacity: 1 }).addTo(livelli.io);
    }

    const osm = stato.osm.filter(passaFiltri);
    const reale = stato.reale.filter(passaFiltri);
    const segnVisibili = stato.filtri.has("reale") ? [] : stato.segn;

    // Strade con sosta
    for (const l of osm.filter((x) => x.categoria === "strada")) {
      const linea = L.polyline(l.geom.map((p) => [p.lat, p.lon]), { color: getComputedStyle(document.documentElement).getPropertyValue("--t-strada").trim() || "#a8541a", weight: 6, opacity: .7 })
        .bindPopup(popupLuogo(l), OPZ_POPUP).addTo(livelli.strade);
      markerPerId.set(l.id, linea);
      // segnaposto con il numero di posti a metà della strada (visibile da zoom 18)
      L.marker([l.lat, l.lon], { icon: icona(coloreLuogo(l) + classeZona(l), testoLuogo(l)), title: l.nome || l.tipo })
        .bindPopup(popupLuogo(l), OPZ_POPUP).addTo(livelli.numeriStrade);
    }
    // Stalli singoli (visibili da zoom 17)
    for (const l of osm.filter((x) => x.categoria === "stallo")) {
      const m = L.marker([l.lat, l.lon], { icon: icona("stallo " + coloreLuogo(l)) })
        .bindPopup(popupLuogo(l), OPZ_POPUP).addTo(livelli.stalli);
      markerPerId.set(l.id, m);
    }
    aggiornaVisibilitaStalli();
    // Parcheggi
    for (const l of osm.filter((x) => x.categoria === "parcheggio")) {
      const m = L.marker([l.lat, l.lon], { icon: icona(coloreLuogo(l) + classeZona(l), testoLuogo(l)), title: l.nome || l.tipo })
        .bindPopup(popupLuogo(l), OPZ_POPUP).addTo(livelli.luoghi);
      markerPerId.set(l.id, m);
    }
    // Tempo reale
    for (const l of reale) {
      const s = PL.statoDisponibilita(l.liberi, l.capienza);
      const m = L.marker([l.lat, l.lon], { icon: icona("reale " + coloreLuogo(l) + classeZona(l), l.liberi), zIndexOffset: 500, title: l.nome })
        .bindPopup(popupLuogo(l), OPZ_POPUP).addTo(livelli.luoghi);
      markerPerId.set(l.id, m);
    }
    // Segnalazioni
    for (const s of segnVisibili) {
      // Accanto al pallino verde: da quanti minuti è stato segnalato
      const etichetta = s.stato === "libero"
        ? `<span class="segn-eta">${s.eta < 1 ? "ora" : s.eta + " min"}</span>` : "";
      const m = L.marker([s.lat, s.lon], {
        icon: L.divIcon({ className: "", iconSize: null,
          html: `<div class="segn-box"><div class="mk segn ${s.stato}"></div>${etichetta}</div>` }),
        opacity: s.freschezza, zIndexOffset: 800
      }).bindPopup(`<div class="pop" data-voce="${attr((s.stato === "libero" ? "Posto segnalato libero, " : "Posto appena occupato, ") +
            (s.eta < 1 ? "adesso" : s.eta === 1 ? "1 minuto fa" : s.eta + " minuti fa") + ". " + distanzaParlata(s.distanza) + ".")}">
          <h3>${s.stato === "libero" ? "Posto segnalato libero" : "Posto appena occupato"}</h3>
          <p>${PL.formattaEta(s.eta)} · ${PL.formattaDistanza(s.distanza)}</p>
          ${s.stato === "libero" ? `<a class="pop-vai" href="${linkNavigazione(s.lat, s.lon)}" target="_blank" rel="noopener">Portami qui</a>` : ""}</div>`, OPZ_POPUP)
        .addTo(livelli.segn);
      markerPerId.set("segn/" + s.id, m);
    }

    // KPI
    $("k-reale").textContent = stato.reale.length ? stato.reale.reduce((t, l) => t + (l.liberi || 0), 0) : "n/d";
    $("k-segn").textContent = stato.segn.filter((s) => s.stato === "libero").length;
    const certi = stato.segn.filter((s) => s.stato === "libero").length + stato.reale.filter((l) => l.liberi > 0).length;
    $("badge-elenco").textContent = certi > 99 ? "99+" : String(certi);
    $("badge-elenco").hidden = certi === 0;
    $("k-osm").textContent = stato.osm.filter((l) => l.categoria === "parcheggio" || l.categoria === "strada").length;

    renderLista(osm, reale, segnVisibili);
  }

  function voce(l, opts) {
    const li = document.createElement("li");
    li.className = "voce";
    li.tabIndex = 0;
    li.innerHTML = `
      <div class="icona ${opts.classe}">${opts.icona}</div>
      <div class="voce-testo">
        <div class="voce-titolo">${esc(opts.titolo)}</div>
        <div class="voce-meta">${opts.meta.join("")}</div>
      </div>
      <div class="voce-dist"><b>${PL.formattaDistanza(l.distanza)}</b><small>${PL.minutiA_piedi(l.distanza)} min a piedi</small></div>`;
    const apri = () => {
      const m = markerPerId.get(opts.id) || (opts.id === "auto-mia" ? Auto.marker() : null);
      stato.seguiGps = false;
      mappa.setView([l.lat, l.lon], Math.max(mappa.getZoom(), l.categoria === "strada" ? ZOOM_NUMERI_STRADE : 17));
      if (m) setTimeout(() => m.openPopup(), 250);
      chiudiElenco();
    };
    li.addEventListener("click", apri);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); apri(); } });
    return li;
  }

  function tagZona(l) {
    const z = zonaLuogo(l);
    if (!z) return "";
    return z.tipo === "area_c" ? '<span class="tag area-c">Area C</span>'
      : `<span class="tag ztl">${z.tipo === "pedonale" ? "Area pedonale" : "ZTL"}</span>`;
  }

  function renderLista(osm, reale, segn) {
    const ol = $("lista");
    ol.innerHTML = "";
    const voci = [];

    const mia = Auto.perElenco();
    if (mia) voci.push({ p: -1, d: 0, el: mia });
    for (const s of segn.filter((x) => x.stato === "libero")) {
      voci.push({ p: 0, d: s.distanza, el: voce(s, {
        id: "segn/" + s.id, classe: "segnalato", icona: "",
        titolo: "Posto libero segnalato",
        meta: [`<span class="tag reale">${PL.formattaEta(s.eta)}</span>`]
      }) });
    }
    for (const l of reale) {
      const st = PL.statoDisponibilita(l.liberi, l.capienza);
      voci.push({ p: st === "pieno" ? 2 : 0, d: l.distanza, el: voce(l, {
        id: l.id, classe: coloreLuogo(l) + classeZona(l), icona: `<span class="num">${l.liberi}</span>`,
        titolo: l.nome,
        meta: [`<span class="tag ${st === "pieno" ? "pieno" : "reale"}">${st === "pieno" ? "Pieno" : l.liberi + " liberi ora"}</span>`,
          l.capienza ? `<span>${l.capienza} posti</span>` : "", tagZona(l)]
      }) });
    }
    // Nell'elenco gli stalli singoli compaiono solo quelli per disabili (gli altri sono troppi)
    const mostraStalli = (l) => tipoLuogo(l) === "disabili";
    for (const l of osm) {
      if (l.categoria === "ingresso") continue;
      if (l.categoria === "stallo" && !mostraStalli(l)) continue;
      const meta = [`<span>${esc(l.tipo)}</span>`];
      if (l.capienza) meta.push(`<span>${l.capienzaStimata ? "~" : ""}${l.capienza} posti</span>`);
      if (l.tariffa === "gratuito") meta.push('<span class="tag gratis">Gratuito</span>');
      else if (l.tariffa === "pagamento") meta.push("<span>A pagamento</span>");
      if (l.disabili) meta.push(`<span>♿ ${l.disabili}</span>`);
      meta.push(tagZona(l));
      voci.push({ p: 1, d: l.distanza, el: voce(l, {
        id: l.id, classe: coloreLuogo(l) + classeZona(l),
        icona: testoLuogo(l), titolo: l.nome || l.via || (l.categoria === "strada" ? "Sosta su strada" : l.tipo), meta
      }) });
    }

    voci.sort((a, b) => a.p - b.p || a.d - b.d);
    if (!voci.length) {
      const li = document.createElement("li");
      li.className = "vuoto";
      li.textContent = stato.filtri.size
        ? "Nessun parcheggio dei tipi scelti. Rimetti qualche spunta nel menu in alto o allarga il raggio."
        : "Nessuna area di sosta mappata qui. Prova ad allargare il raggio.";
      ol.appendChild(li);
      return;
    }
    voci.slice(0, 150).forEach((v) => ol.appendChild(v.el));
  }

  // ---------- Posizione ----------
  let marcatoreIo, cerchioPrecisione;

  function impostaCentro(lat, lon, daGps) {
    const prima = stato.centro;
    stato.centro = { lat, lon, daGps };
    const spostato = !prima || prima.daGps !== daGps ||
      PL.distanza(prima.lat, prima.lon, lat, lon) > (cfg.ricaricaDopoMetri || 200);
    if (spostato) {
      mappa.fitBounds(L.latLng(lat, lon).toBounds(stato.raggio * 2.1));
      carica();
    }
  }

  function suPosizione(p) {
    const { latitude: lat, longitude: lon, accuracy: acc } = p.coords;
    stato.gps = { lat, lon, acc };
    if (!marcatoreIo) {
      marcatoreIo = L.marker([lat, lon], { icon: L.divIcon({ className: "", html: '<div class="io-box"><div class="io-cono" hidden></div><div class="io"></div></div>', iconSize: [18, 18] }), zIndexOffset: 1000, interactive: false }).addTo(livelli.io);
      cerchioPrecisione = L.circle([lat, lon], { radius: acc, color: "#2f7cf6", weight: 0, fillOpacity: .12, interactive: false }).addTo(livelli.io);
    } else {
      marcatoreIo.setLatLng([lat, lon]);
      cerchioPrecisione.setLatLng([lat, lon]).setRadius(acc);
    }
    if (window.QuiBussola) QuiBussola.gps(p.coords);   // cono dell'orientamento (bussola.js)
    Auto.posizione(p);   // salva da solo il parcheggio (sezione "La tua auto")
    $("btn-libero").disabled = false;
    $("btn-parcheggiato").disabled = false;
    if (stato.seguiGps) impostaCentro(lat, lon, true);
  }

  function erroreGps(e) {
    const testi = {
      1: "Posizione non autorizzata. Consenti l'accesso alla posizione oppure cerca un indirizzo.",
      2: "Posizione non disponibile. Cerca un indirizzo qui sopra.",
      3: "Il GPS non risponde. Cerca un indirizzo qui sopra."
    };
    if (!stato.gps) messaggio(testi[e.code] || testi[2], true);
  }

  function avviaGps() {
    if (!("geolocation" in navigator)) {
      messaggio("Questo browser non fornisce la posizione. Cerca un indirizzo qui sopra.", true);
      return;
    }
    if (!window.isSecureContext) {
      messaggio("Il GPS funziona solo su HTTPS. Pubblica l'app su un sito https o cerca un indirizzo.", true);
    }
    navigator.geolocation.watchPosition(suPosizione, erroreGps, { enableHighAccuracy: true, maximumAge: 10000, timeout: 20000 });
  }

  // ---------- Ricerca indirizzo ----------
  $("form-cerca").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("cerca-indirizzo").value.trim();
    if (!q) return;
    messaggio("Cerco “" + q + "”…");
    try {
      const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&accept-language=it&q=" + encodeURIComponent(q);
      const [primo] = await fetchJson(url, { headers: { Accept: "application/json" } }, 12000);
      if (!primo) { messaggio("Indirizzo non trovato. Prova ad aggiungere la città.", true); return; }
      stato.seguiGps = false;
      $("cerca-indirizzo").blur();
      impostaCentro(+primo.lat, +primo.lon, false);
    } catch (err) {
      messaggio("Ricerca non riuscita. Controlla la connessione.", true);
    }
  });

  // ---------- Segnalazioni ----------
  async function segnala(tipo) {
    if (!stato.gps) { toast("Serve la tua posizione GPS per segnalare."); return; }
    if (stato.gps.acc > 60) { toast("Posizione poco precisa (±" + Math.round(stato.gps.acc) + " m). Riprova all'aperto."); return; }
    if (Date.now() - stato.ultimaSegnalazione < 30000) { toast("Hai appena segnalato. Attendi qualche secondo."); return; }
    try {
      stato.miaSegnalazione = { lat: stato.gps.lat, lon: stato.gps.lon, t: Date.now() };
      await Segnalazioni.invia(stato.gps.lat, stato.gps.lon, tipo);
      stato.ultimaSegnalazione = Date.now();
      toast(tipo === "libero" ? "Grazie! Posto libero segnalato." : "Segnato come occupato. Buona sosta!");
      await caricaSegnalazioni();
      render();
    } catch (e) {
      toast("Invio non riuscito. Riprova.");
    }
  }
  $("btn-libero").addEventListener("click", () => segnala("libero"));
  $("btn-parcheggiato").addEventListener("click", () => {
    if (stato.gps) Auto.salva(stato.gps.lat, stato.gps.lon, "manuale");
    segnala("occupato");
  });

  // ---------- Controlli ----------
  $("btn-centra").addEventListener("click", () => {
    stato.seguiGps = true;
    if (stato.gps) impostaCentro(stato.gps.lat, stato.gps.lon, true);
    if (stato.gps) mappa.setView([stato.gps.lat, stato.gps.lon], 16);
    else toast("Posizione non ancora disponibile.");
  });
  $("btn-aggiorna").addEventListener("click", () => carica(true));
  $("raggio").value = String(stato.raggio);
  $("raggio").addEventListener("change", (e) => {
    stato.raggio = +e.target.value;
    if (stato.centro) {
      mappa.fitBounds(L.latLng(stato.centro.lat, stato.centro.lon).toBounds(stato.raggio * 2.1));
      carica();
    }
  });
  // ---------- Tipi di parcheggio da mostrare: menu a discesa a scelte multiple nella barra in alto ----------
  // stato.filtri contiene le voci TOLTE (senza spunta). All'inizio sono tutte spuntate tranne
  // "Dentro le ZTL" (i parcheggi raggiungibili solo con il contrassegno partono nascosti).
  const caselleFiltri = [...document.querySelectorAll("#filtri-lista input[data-voce]")];
  const INIZIALE = new Map(caselleFiltri.map((c) => [c.dataset.voce, c.checked]));
  function aggiornaFiltri() {
    stato.filtri = new Set(caselleFiltri.filter((c) => !c.checked).map((c) => c.dataset.voce));
    const n = caselleFiltri.filter((c) => c.checked !== INIZIALE.get(c.dataset.voce)).length;
    $("filtri-num").textContent = n;
    $("filtri-num").hidden = n === 0;
    $("btn-filtri").classList.toggle("attivi", n > 0);
    $("filtri-azzera").disabled = n === 0;
    try { localStorage.setItem("postolibero.tipi", [...stato.filtri].join(",")); } catch (e) { /* ignora */ }
    render();
  }
  function apriFiltri(apri) {
    $("filtri-lista").hidden = !apri;
    $("btn-filtri").setAttribute("aria-expanded", String(apri));
  }
  try {
    const salvato = localStorage.getItem("postolibero.tipi");
    if (salvato !== null) {
      const tolti = salvato.split(",");
      caselleFiltri.forEach((c) => { c.checked = !tolti.includes(c.dataset.voce); });
    }
    localStorage.removeItem("postolibero.filtri");   // vecchi filtri a esclusione
  } catch (e) { /* ignora */ }
  caselleFiltri.forEach((c) => c.addEventListener("change", aggiornaFiltri));
  $("btn-filtri").addEventListener("click", (e) => { e.stopPropagation(); apriFiltri($("filtri-lista").hidden); });
  $("filtri-azzera").addEventListener("click", () => { caselleFiltri.forEach((c) => { c.checked = INIZIALE.get(c.dataset.voce); }); aggiornaFiltri(); });
  // si chiude toccando fuori dal menu
  document.addEventListener("pointerdown", (e) => { if (!$("filtri-menu").contains(e.target)) apriFiltri(false); });
  aggiornaFiltri();
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
    "Ti consiglio Qui-Parking: trovi parcheggi e posti auto liberi vicino a te. " +
    "Gratis e senza registrazione: " + linkApp);
  $("btn-condividi").addEventListener("click", () => {
    if (window.goatcounter && window.goatcounter.count) window.goatcounter.count({ path: "condividi-whatsapp", title: "Condividi su WhatsApp", event: true });
  });
  $("btn-elenco").addEventListener("click", apriElenco);
  $("btn-chiudi").addEventListener("click", chiudiElenco);

  // ---------- Guida ----------
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
  // I link dell'indice scorrono dentro la guida
  $("guida").querySelectorAll(".g-indice a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const dest = $("guida").querySelector(a.getAttribute("href"));
    if (dest) dest.scrollIntoView({ behavior: "smooth", block: "start" });
  }));
  $("guida-versione").textContent = "Versione " + (cfg.versione || "");
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("filtri-lista").hidden) { apriFiltri(false); return; }
    if (!chiudiGuida()) chiudiElenco();
  });

  // ---------- Lettura vocale dei riquadri ----------
  let letturaAttiva = true;
  try { letturaAttiva = localStorage.getItem("postolibero.lettura") !== "0"; } catch (e) { /* ignora */ }
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
  mappa.on("popupopen", (e) => {
    if (!letturaAttiva) return;
    const el = e.popup.getElement && e.popup.getElement();
    const pop = el ? el.querySelector(".pop") : null;
    if (pop) leggi(pop.dataset.voce);
  });
  mappa.on("popupclose", () => { if (sintesi) sintesi.cancel(); });
  if (!sintesi) { $("riga-lettura").hidden = true; }
  $("lettura").value = letturaAttiva ? "1" : "0";
  $("lettura").addEventListener("change", (e) => {
    letturaAttiva = e.target.value === "1";
    try { localStorage.setItem("postolibero.lettura", letturaAttiva ? "1" : "0"); } catch (err) { /* ignora */ }
    if (letturaAttiva) leggi("Lettura vocale attiva.");
    else if (sintesi) sintesi.cancel();
  });

  // ---------- Auto-refresh ----------
  // Ogni N secondi fa come premere "posizione" e poi "aggiorna".
  // I parcheggi di OpenStreetMap vengono riscaricati solo se ti sei spostato o dopo 10 minuti,
  // per non sovraccaricare i server pubblici; segnalazioni e posti in tempo reale ogni volta.
  let timerAuto;
  function autoAggiorna() {
    if (document.hidden || !stato.gps) return;
    stato.seguiGps = true;
    stato.centro = { lat: stato.gps.lat, lon: stato.gps.lon, daGps: true };
    mappa.setView([stato.gps.lat, stato.gps.lon], 16);
    carica(false);
  }
  function impostaAuto(sec) {
    clearInterval(timerAuto);
    if (sec > 0) timerAuto = setInterval(autoAggiorna, sec * 1000);
    autoAttivo = sec > 0;
    aggiornaSchermoAcceso();
    try { localStorage.setItem("postolibero.auto", String(sec)); } catch (e) { /* ignora */ }
  }

  // ---------- Schermo sempre acceso (Wake Lock) ----------
  // Con l'auto-refresh attivo il telefono non va in standby. Il browser toglie il blocco da solo
  // quando l'app va in secondo piano o il telefono viene bloccato: al ritorno lo si richiede.
  let autoAttivo = false, bloccoSchermo = null, richiestaInCorso = false;
  let schermoPerSalvaschermo = false;   // il salvaschermo è aperto o sta per aprirsi da solo
  function mostraOcchio() { $("occhio").hidden = !bloccoSchermo; }
  async function aggiornaSchermoAcceso() {
    const vuole = (autoAttivo || schermoPerSalvaschermo) && document.visibilityState === "visible";
    if (!vuole) {
      if (bloccoSchermo) { const b = bloccoSchermo; bloccoSchermo = null; b.release().catch(() => {}); }
      mostraOcchio();
      return;
    }
    if (!("wakeLock" in navigator)) {
      avvisaSchermo("Questo browser non permette di tenere lo schermo acceso (serve iOS 16.4 o più recente).");
      mostraOcchio();
      return;
    }
    if (bloccoSchermo || richiestaInCorso) { mostraOcchio(); return; }
    richiestaInCorso = true;
    try {
      const b = await navigator.wakeLock.request("screen");
      b.addEventListener("release", () => { if (bloccoSchermo === b) { bloccoSchermo = null; mostraOcchio(); } });
      if ((autoAttivo || schermoPerSalvaschermo) && document.visibilityState === "visible") bloccoSchermo = b;
      else b.release().catch(() => {});
    } catch (e) {
      // Spesso il primo tentativo fallisce finché non si tocca lo schermo: l'avviso solo dopo un tocco
      if (toccato) avvisaSchermo("Il telefono non permette di tenere lo schermo acceso" +
        (e && e.name ? " (" + e.name + (e.message ? ": " + e.message : "") + ")" : "") + ".");
    }
    richiestaInCorso = false;
    mostraOcchio();
  }
  // Spiega una sola volta perché lo schermo non resta acceso, e lo scrive anche nella pagina Elenco
  let avvisoSchermoDato = false, toccato = false;
  function avvisaSchermo(testo) {
    $("nota-schermo").textContent = testo;
    $("nota-schermo").hidden = false;
    if (!avvisoSchermoDato) { avvisoSchermoDato = true; toast(testo); }
  }
  document.addEventListener("visibilitychange", aggiornaSchermoAcceso);
  // Alcuni browser concedono il blocco solo dopo un tocco: si riprova al primo tocco
  document.addEventListener("pointerdown", () => { toccato = true; if ((autoAttivo || schermoPerSalvaschermo) && !bloccoSchermo) aggiornaSchermoAcceso(); }, { passive: true });
  let secAuto = cfg.autoRefreshSecondi ?? 120;
  try {
    const salvato = localStorage.getItem("postolibero.auto");
    if (salvato !== null && ["0", "30", "60", "120"].includes(salvato)) secAuto = +salvato;
  } catch (e) { /* ignora */ }
  $("auto-refresh").value = String(secAuto);
  impostaAuto(secAuto);
  $("sfondo").value = sfondoAttivo;
  $("sfondo").addEventListener("change", (e) => impostaSfondo(e.target.value));
  $("suoni").value = suoniAttivi ? "1" : "0";
  $("suoni").addEventListener("change", (e) => {
    suoniAttivi = e.target.value === "1";
    try { localStorage.setItem("postolibero.suoni", suoniAttivi ? "1" : "0"); } catch (err) { /* ignora */ }
    sbloccaAudio();
    if (suoniAttivi) setTimeout(SUONO.aggiornato, 150); // prova
  });
  $("auto-refresh").addEventListener("change", (e) => {
    impostaAuto(+e.target.value);
    toast(+e.target.value ? `Auto-refresh ogni ${e.target.value} secondi` : "Auto-refresh disattivato");
  });

  // Aggiornamenti periodici: segnalazioni ogni minuto, tutto ogni 3 minuti
  setInterval(async () => { await caricaSegnalazioni(); render(); }, 60000);
  setInterval(async () => {
    if (!stato.centro || stato.caricando) return;
    stato.reale = await caricaOpenData(stato.centro.lat, stato.centro.lon, stato.raggio).catch(() => stato.reale);
    render();
  }, 180000);

  // Numero di versione nell'ultima riga della pagina Elenco
  $("elenco-versione").textContent = "Versione " + (cfg.versione || "");

  $("btn-libero").disabled = true;
  $("btn-parcheggiato").disabled = true;

  // ---------- La tua auto: parcheggio salvato da solo ----------
  // 1. Con l'app aperta: se si va oltre guidaKmh per almeno guidaSecondi e poi si resta fermi
  //    (entro sostaMetri) per sostaSecondi, il punto della sosta viene salvato da solo e compare
  //    "Parcheggio salvato · Annulla".
  // 2. Alla riapertura: se l'ultima posizione registrata era in auto (da meno di dedottoOre) e ora
  //    si è fermi o a piedi lì vicino, l'auto viene messa in quell'ultimo punto.
  // L'utente corregge solo se serve: trascina il segnaposto o usa "Sposta dove sono".
  Auto = (function () {
    const C = Object.assign({ guidaKmh: 20, guidaSecondi: 45, sostaSecondi: 90, sostaMetri: 40, dedottoOre: 8, dedottoMetri: 2000, liberaKmh: 50, liberaSecondi: 4, liberaMetri: 3000, liberaDopoMinuti: 3 }, cfg.parcheggioAuto || {});
    const K_AUTO = "postolibero.auto.posto", K_GUIDA = "postolibero.auto.guida", K_ATTIVO = "postolibero.auto.attivo";
    const leggi = (k) => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } };
    const scrivi = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignora */ } };
    let attivo = true;
    try { attivo = localStorage.getItem(K_ATTIVO) !== "0"; } catch (e) { /* ignora */ }
    let posto = leggi(K_AUTO);          // { lat, lon, t, modo: "auto" | "manuale" | "dedotto" | "corretto" }
    let precedente = null;              // per "Annulla"
    let prima = null;                   // fix precedente, per calcolare la velocità
    let inizioGuida = null, inGuida = false, sosta = null, ultimaScrittura = 0, controllatoAvvio = false;
    let veloceDa = null, liberato = null, pausaFino = 0;
    let ultimaV = null, ultimaVT = 0, ultimoPasso = 0;   // per il salvaschermo   // ripartenza: oltre liberaKmh il vecchio posto diventa libero
    const strato = L.layerGroup().addTo(mappa);
    let marker = null;

    function velocitaKmh(p) {
      if (p.coords.speed != null && p.coords.speed >= 0) return p.coords.speed * 3.6 <= 200 ? p.coords.speed * 3.6 : null;
      if (!prima) return null;
      const dt = (p.timestamp - prima.t) / 1000;
      if (dt < 2) return null;
      // posizioni poco precise o salti impossibili (un fix sbagliato del GPS) non contano come velocità
      if (p.coords.accuracy > 50) return null;
      const v = PL.distanza(prima.lat, prima.lon, p.coords.latitude, p.coords.longitude) / dt * 3.6;
      return v <= 200 ? v : null;
    }

    function posizione(p) {
      const lat = p.coords.latitude, lon = p.coords.longitude, t = p.timestamp || Date.now();
      const v = velocitaKmh(p);
      if (v != null) { ultimaV = v; ultimaVT = Date.now(); if (v >= 2 && v < 9) ultimoPasso = Date.now(); }
      if (!controllatoAvvio) { controllatoAvvio = true; deduciAllAvvio(lat, lon, t, v); }
      // Auto salvata (a mano o da sola) e ora si viaggia oltre i 50 km/h: il posto è stato lasciato
      if (posto && t > pausaFino && v != null && v >= C.liberaKmh) {
        if (veloceDa == null) veloceDa = t;
        if (t - veloceDa >= C.liberaSecondi * 1000) { veloceDa = null; lasciaLibero(lat, lon, t); }
      } else if (v != null) veloceDa = null;   // un fix senza velocità non azzera il conteggio
      if (!attivo) { if (!prima || t - prima.t >= 2000) prima = { lat, lon, t }; return; }
      if (v != null && v >= C.guidaKmh) {
        if (inizioGuida == null) inizioGuida = t;
        if (t - inizioGuida >= C.guidaSecondi * 1000) inGuida = true;
        sosta = null;
        if (inGuida && t - ultimaScrittura > 15000) { scrivi(K_GUIDA, { lat, lon, t }); ultimaScrittura = t; }
      } else if (v != null && v < 6) {
        if (!inGuida) inizioGuida = null;
        if (inGuida) {
          if (!sosta || PL.distanza(sosta.lat, sosta.lon, lat, lon) > C.sostaMetri) sosta = { lat, lon, t };
          else if (t - sosta.t >= C.sostaSecondi * 1000) {
            salva(sosta.lat, sosta.lon, "auto");
            inGuida = false; inizioGuida = null; sosta = null;
            scrivi(K_GUIDA, null);
          }
        }
      }
      // il punto di riferimento per la velocità avanza solo ogni 2 secondi o più
      if (!prima || t - prima.t >= 2000) prima = { lat, lon, t };
    }

    // Alla riapertura: l'app era stata chiusa mentre si guidava
    function deduciAllAvvio(lat, lon, t, v) {
      const g = leggi(K_GUIDA);
      if (!attivo || !g) return;
      scrivi(K_GUIDA, null);
      const recente = t - g.t < C.dedottoOre * 3600000;
      const giaSalvato = posto && posto.t >= g.t;
      const vicino = PL.distanza(g.lat, g.lon, lat, lon) <= C.dedottoMetri;
      const aPiedi = v == null || v < 8;
      if (recente && !giaSalvato && vicino && aPiedi) salva(g.lat, g.lon, "dedotto");
    }

    function salva(lat, lon, modo) {
      precedente = posto; liberato = null; pausaFino = 0;
      posto = { lat: +lat.toFixed(6), lon: +lon.toFixed(6), t: Date.now(), modo };
      scrivi(K_AUTO, posto);
      disegna();
      if (modo !== "manuale") {
        avviso(modo === "dedotto" ? "Auto lasciata qui? L'ho segnata sulla mappa" : "Parcheggio salvato", true);
        if (modo === "auto") parla("Parcheggio salvato");
      }
    }
    // Ripartenza: toglie l'auto dalla mappa e segnala libero il posto dove era parcheggiata
    async function lasciaLibero(lat, lon, t) {
      const p = posto;
      precedente = p; posto = null; liberato = null;
      scrivi(K_AUTO, null);
      disegna();
      if (attivo) { inGuida = true; inizioGuida = t; }   // si sta guidando: alla prossima sosta salva di nuovo
      const daMinuti = (Date.now() - p.t) / 60000;
      if (daMinuti < C.liberaDopoMinuti || PL.distanza(p.lat, p.lon, lat, lon) > C.liberaMetri) {
        // sosta troppo breve (un semaforo, una coda) o auto lasciata lontano da qui: nessuna segnalazione
        avviso("Sei ripartito: auto tolta dalla mappa", true);
        return;
      }
      try {
        await Segnalazioni.invia(p.lat, p.lon, "libero");
        liberato = p;
        stato.miaSegnalazione = { lat: p.lat, lon: p.lon, t: Date.now() };
        stato.ultimaSegnalazione = Date.now();
        avviso("Sei ripartito: il tuo posto è segnalato libero", true);
        parla("Posto lasciato libero");
        await caricaSegnalazioni();
        render();
      } catch (e) {
        avviso("Sei ripartito: auto tolta dalla mappa (segnalazione non inviata)", true);
      }
    }
    function annulla() {
      if (precedente && !posto) pausaFino = Date.now() + 30 * 60000;   // annullata una ripartenza: per 30 minuti non ripete
      if (liberato) {   // non era la mia auto a partire: annulla anche il "libero" appena inviato
        const p = liberato; liberato = null;
        Segnalazioni.invia(p.lat, p.lon, "occupato").then(caricaSegnalazioni).then(render).catch(() => {});
      }
      posto = precedente; precedente = null;
      scrivi(K_AUTO, posto);
      disegna();
      $("avviso-auto").hidden = true;
      toast("Parcheggio annullato");
    }
    function cancella() {
      precedente = posto; posto = null;
      scrivi(K_AUTO, null);
      mappa.closePopup();
      disegna();
      avviso("Auto tolta dalla mappa", true);
    }
    function spostaQui() {
      if (!stato.gps) { toast("Posizione non ancora disponibile."); return; }
      precedente = posto;
      posto = { lat: stato.gps.lat, lon: stato.gps.lon, t: Date.now(), modo: "corretto" };
      scrivi(K_AUTO, posto);
      mappa.closePopup();
      disegna();
      avviso("Auto spostata dove sei", true);
    }

    let timerAvviso;
    function avviso(testo, conAnnulla) {
      $("avviso-auto-testo").textContent = testo;
      $("avviso-auto-annulla").hidden = !conAnnulla;
      $("avviso-auto").hidden = false;
      clearTimeout(timerAvviso);
      timerAvviso = setTimeout(() => { $("avviso-auto").hidden = true; }, 12000);
    }
    function parla(testo) {
      const s = window.speechSynthesis;
      if (!s || !suoniAttivi || document.hidden || s.speaking) return;
      const u = new SpeechSynthesisUtterance(testo);
      u.lang = "it-IT";
      const v = vocItaliana();
      if (v) u.voice = v;
      s.speak(u);
    }

    const ICONA = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 16.5V12l1.8-4.6A2 2 0 0 1 8.7 6h6.6a2 2 0 0 1 1.9 1.4L19 12v4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M4 12.2h16v4.3H4z" fill="currentColor"/><path d="M6.5 16.5v2M17.5 16.5v2" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>';
    const MODI = { auto: "salvata da sola", manuale: "salvata da te", dedotto: "posizione dedotta", corretto: "corretta da te" };
    const ora = (t) => new Date(t).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
    const giorno = (t) => new Date(t).toDateString() === new Date().toDateString() ? "oggi" : new Date(t).toLocaleDateString("it-IT", { day: "numeric", month: "long" });
    function testoPopup() {
      const d = stato.gps ? PL.distanza(stato.gps.lat, stato.gps.lon, posto.lat, posto.lon) : null;
      const voce = "La tua auto. " + (d != null ? distanzaParlata(d) + ", " + minutiParlati(d) + "." : "");
      return `<div class="pop" data-voce="${attr(voce)}"><h3>La tua auto</h3>
        <p>${giorno(posto.t)} alle ${ora(posto.t)} · ${MODI[posto.modo] || ""}</p>
        ${d != null ? `<p>${PL.formattaDistanza(d)} · ${PL.minutiA_piedi(d)} min a piedi</p>` : ""}
        <p class="fonte">Non è il posto giusto? Trascina il segnaposto dove hai lasciato l'auto.</p>
        <a class="pop-vai" href="https://www.google.com/maps/dir/?api=1&destination=${posto.lat},${posto.lon}&travelmode=walking" target="_blank" rel="noopener">Portami all'auto</a>
        <div class="pop-azioni"><button type="button" data-auto="qui">Sposta dove sono</button><button type="button" data-auto="via">Cancella</button></div></div>`;
    }
    function disegna() {
      strato.clearLayers();
      marker = null;
      if (!posto) { render(); return; }
      marker = L.marker([posto.lat, posto.lon], {
        icon: L.divIcon({ className: "", html: `<div class="mk-auto">${ICONA}</div>`, iconSize: [38, 38], iconAnchor: [19, 19] }),
        draggable: true, zIndexOffset: 900, title: "La tua auto", autoPan: true
      }).bindPopup(testoPopup, OPZ_POPUP).addTo(strato);
      marker.on("dragend", () => {
        const ll = marker.getLatLng();
        precedente = posto;
        posto = { lat: +ll.lat.toFixed(6), lon: +ll.lng.toFixed(6), t: posto.t, modo: "corretto" };
        scrivi(K_AUTO, posto);
        avviso("Posizione dell'auto corretta", true);
        render();
      });
      render();
    }
    // pulsanti dentro il riquadro dell'auto
    mappa.on("popupopen", (e) => {
      const el = e.popup.getElement && e.popup.getElement();
      if (!el) return;
      el.querySelectorAll("[data-auto]").forEach((b) => b.addEventListener("click", () => (b.dataset.auto === "qui" ? spostaQui() : cancella())));
    });
    $("avviso-auto-annulla").addEventListener("click", annulla);
    $("parcheggio-auto").value = attivo ? "1" : "0";
    $("parcheggio-auto").addEventListener("change", (e) => {
      attivo = e.target.value === "1";
      try { localStorage.setItem(K_ATTIVO, attivo ? "1" : "0"); } catch (err) { /* ignora */ }
      inGuida = false; inizioGuida = null; sosta = null;
      toast(attivo ? "L'app salverà da sola dove parcheggi" : "Salvataggio del parcheggio spento");
    });

    function perElenco() {
      if (!posto) return null;
      const d = stato.gps ? PL.distanza(stato.gps.lat, stato.gps.lon, posto.lat, posto.lon) : 0;
      const li = voce({ lat: posto.lat, lon: posto.lon, distanza: d }, {
        id: "auto-mia", classe: "auto-mia", icona: ICONA, titolo: "La tua auto",
        meta: [`<span>${giorno(posto.t)} alle ${ora(posto.t)}</span>`, `<span>${MODI[posto.modo] || ""}</span>`]
      });
      return li;
    }
    setTimeout(disegna, 0);
    function info() {
      const recente = Date.now() - ultimaVT < 10000;
      return { posto, attivo, inGuida, v: recente ? ultimaV : null, aPiedi: Date.now() - ultimoPasso < 30000 };
    }
    return { posizione, salva, perElenco, info, marker: () => marker };
  })();

  // ---------- Salvaschermo ----------
  // Schermo nero con pochi elementi grandi. Con l'auto salvata: freccia verso l'auto e distanza.
  // In guida: velocità e posti liberi segnalati vicino. Salvataggio e "posto lasciato libero"
  // continuano a funzionare (modulo Auto). Si apre col pulsante con la luna oppure da solo dopo
  // dopoSecondi senza toccare lo schermo, se si sta guidando o si va a piedi verso l'auto.
  // Si chiude con un tocco. Lo schermo resta acceso (Wake Lock) finché è aperto.
  const Salvaschermo = (function () {
    const el = $("salvaschermo");
    const K = "postolibero.salvaschermo";
    const SECONDI = (cfg.salvaschermo && cfg.salvaschermo.dopoSecondi) || 60;
    let dopo = SECONDI, aperto = false, ultimoTocco = Date.now(), angolo = null, timer = null;
    try { if (localStorage.getItem(K) === "0") dopo = 0; } catch (e) { /* ignora */ }
    $("salvaschermo-dopo").value = dopo ? "1" : "0";
    $("salvaschermo-dopo").addEventListener("change", (e) => {
      dopo = e.target.value === "1" ? SECONDI : 0;
      try { localStorage.setItem(K, dopo ? "1" : "0"); } catch (err) { /* ignora */ }
      toast(dopo ? "Il salvaschermo si apre da solo dopo 1 minuto senza tocchi, in auto o andando all'auto" : "Il salvaschermo si apre solo col pulsante con la luna");
    });

    const NOMI = ["nord", "nord-est", "est", "sud-est", "sud", "sud-ovest", "ovest", "nord-ovest"];
    function rotta(la1, lo1, la2, lo2) {
      const r = Math.PI / 180, dl = (lo2 - lo1) * r;
      const y = Math.sin(dl) * Math.cos(la2 * r);
      const x = Math.cos(la1 * r) * Math.sin(la2 * r) - Math.sin(la1 * r) * Math.cos(la2 * r) * Math.cos(dl);
      return (Math.atan2(y, x) / r + 360) % 360;
    }
    const due = (n) => String(n).padStart(2, "0");
    const oraDi = (t) => { const d = new Date(t); return due(d.getHours()) + ":" + due(d.getMinutes()); };
    function ruota(gradi) {   // gira la freccia per la via più breve (359° → 1° non fa il giro intero)
      if (angolo == null) angolo = gradi;
      else angolo += ((((gradi - angolo) % 360) + 540) % 360) - 180;
      $("ss-freccia").style.transform = "rotate(" + angolo.toFixed(1) + "deg)";
    }
    function mostra({ freccia = null, alNord = false, icona = "", grande = "", sotto = "", stato: st = "" }) {
      $("ss-freccia").hidden = freccia == null;
      document.querySelector(".ss-segno").classList.toggle("al-nord", alNord && freccia != null);   // "N" fermo in alto
      if (freccia != null) ruota(freccia);
      $("ss-icona").hidden = freccia != null;
      $("ss-icona").className = "ss-icona " + icona;
      $("ss-grande").innerHTML = grande;
      $("ss-sotto").innerHTML = sotto;
      $("ss-stato").textContent = st;
    }
    function postiVicini(lat, lon) {
      const liberi = [];
      for (const x of stato.segn || []) if (x.stato === "libero") liberi.push(PL.distanza(lat, lon, x.lat, x.lon));
      for (const l of stato.reale || []) if (l.liberi > 0 && isFinite(l.lat)) liberi.push(PL.distanza(lat, lon, l.lat, l.lon));
      const vicini = liberi.filter((d) => d <= 1000).sort((a, b) => a - b);
      return vicini;
    }

    function aggiorna() {
      if (!aperto) return;
      $("ss-ora").textContent = oraDi(Date.now());
      const g = stato.gps, a = Auto.info();
      if (!g) { mostra({ icona: "", grande: "…", sotto: "In attesa della posizione GPS" }); return; }
      const v = a.v;
      if (a.inGuida || (v != null && v >= 15)) {
        const vicini = postiVicini(g.lat, g.lon);
        mostra({
          icona: "guida",
          grande: (v != null ? Math.round(v) : "–") + "<small>km/h</small>",
          sotto: vicini.length
            ? `<b>${vicini.length === 1 ? "1 posto libero" : vicini.length + " posti liberi"}</b> segnalat${vicini.length === 1 ? "o" : "i"} entro 1 km · il più vicino a ${PL.formattaDistanza(vicini[0])}`
            : "Nessun posto libero segnalato entro 1 km",
          stato: a.attivo ? "In guida · quando parcheggi salvo il posto da solo" : "In guida"
        });
        return;
      }
      if (a.posto) {
        const d = PL.distanza(g.lat, g.lon, a.posto.lat, a.posto.lon);
        const salvata = "La tua auto · salvata alle " + oraDi(a.posto.t);
        if (d <= Math.max(15, Math.min(40, g.acc || 15))) {
          mostra({ icona: "arrivato", grande: "Sei arrivato", sotto: "La tua auto è qui intorno", stato: salvata });
          return;
        }
        const b = rotta(g.lat, g.lon, a.posto.lat, a.posto.lon);
        const h = window.QuiBussola ? QuiBussola.direzione() : null;
        mostra({
          freccia: h != null ? b - h : b,
          alNord: h == null,
          grande: PL.formattaDistanza(d),
          sotto: `${PL.minutiA_piedi(d)} min a piedi · verso ${NOMI[Math.round(b / 45) % 8]}`,
          stato: h != null ? salvata : salvata + " · bussola non disponibile: la freccia è rispetto al nord (N in alto)"
        });
        return;
      }
      mostra({ icona: "", grande: "Nessuna auto", sotto: a.attivo ? "Quando parcheggi salvo il posto da solo" : "Tocca e usa «Ho parcheggiato» per salvare l'auto", stato: "" });
    }

    function apri() {
      if (aperto) return;
      aperto = true; angolo = null;
      el.hidden = false;
      schermoPerSalvaschermo = true; aggiornaSchermoAcceso();
      aggiorna();
      clearInterval(timer);
      timer = setInterval(aggiorna, 500);
    }
    function chiudi() {
      if (!aperto) return;
      aperto = false;
      el.hidden = true;
      clearInterval(timer);
      ultimoTocco = Date.now();
      controlla();
    }
    // Ogni minuto il contenuto si sposta di pochi pixel: lo schermo non si "stampa" (burn-in)
    setInterval(() => {
      if (!aperto) return;
      const dx = Math.round(Math.random() * 24 - 12), dy = Math.round(Math.random() * 24 - 12);
      $("ss-contenuto").style.transform = `translate(${dx}px, ${dy}px)`;
    }, 60000);

    // Apertura da sola: dopo "dopo" secondi senza tocchi, in guida o a piedi verso l'auto salvata
    function situazione() {
      const a = Auto.info();
      return a.inGuida || (a.v != null && a.v >= 15) || (!!a.posto && a.aPiedi);
    }
    function controlla() {
      const serve = dopo > 0 && !aperto && situazione() && document.visibilityState === "visible";
      // lo schermo resta acceso già prima che si apra, altrimenti il telefono si spegnerebbe prima del minuto
      const vuole = aperto || serve;
      if (vuole !== schermoPerSalvaschermo) { schermoPerSalvaschermo = vuole; aggiornaSchermoAcceso(); }
      if (serve && Date.now() - ultimoTocco >= dopo * 1000) apri();
    }
    setInterval(controlla, 5000);

    const tocco = () => { ultimoTocco = Date.now(); };
    ["pointerdown", "keydown", "wheel"].forEach((ev) => document.addEventListener(ev, tocco, { passive: true, capture: true }));
    el.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); chiudi(); });   // click, non pointerdown: il tocco non arriva ai pulsanti sotto
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") chiudi(); });
    $("btn-salvaschermo").addEventListener("click", () => {
      if (window.QuiBussola) QuiBussola.permesso();   // iPhone: permesso della bussola al tocco
      apri();
    });
    return { apri, chiudi, aggiorna, aperto: () => aperto };
  })();

  avviaGps();
  caricaZtl();

  if ("serviceWorker" in navigator && window.isSecureContext) {
    // Quando arriva una versione nuova dell'app, la pagina si ricarica da sola una volta
    const cerano = !!navigator.serviceWorker.controller;
    let ricaricata = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (cerano && !ricaricata) { ricaricata = true; location.reload(); }
    });
    navigator.serviceWorker.register("sw.js").then((reg) => reg.update()).catch(() => {});
  }
})();
