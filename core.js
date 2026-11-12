/*
 * Qui-Trekking – logica pura (nessun accesso a DOM o rete).
 * Funziona sia nel browser (window.QT) sia in Node (module.exports), così si può provare con node.
 */
(function (root) {
  "use strict";

  const R_TERRA = 6371000;

  function distanza(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const dLat = (lat2 - lat1) * rad;
    const dLon = (lon2 - lon1) * rad;
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
    return 2 * R_TERRA * Math.asin(Math.sqrt(a));
  }

  function formattaDistanza(m) {
    if (m < 1000) return Math.round(m / 10) * 10 + " m";
    return (m / 1000).toFixed(1).replace(".", ",") + " km";
  }
  const formattaKm = (m) => (m / 1000).toFixed(m < 10000 ? 1 : 0).replace(".", ",") + " km";
  const formattaQuota = (m) => Math.round(m).toLocaleString("it-IT") + " m";
  function formattaOre(min) {
    min = Math.round(min / 5) * 5;
    const h = Math.floor(min / 60), m = min % 60;
    return h ? h + " h" + (m ? " " + String(m).padStart(2, "0") : "") : m + " min";
  }

  // ---------- Difficoltà dei sentieri (scala CAI) ----------
  // Su OpenStreetMap è nel tag cai_scale; se manca si usa sac_scale (scala svizzera) convertita.
  const DIFFICOLTA = {
    T: { nome: "Turistico", sigla: "T", spiega: "Stradine, mulattiere e sentieri larghi e facili, vicino a paesi o rifugi. Adatto a tutti, anche ai bambini." },
    E: { nome: "Escursionistico", sigla: "E", spiega: "Sentieri segnalati anche ripidi, su terreni vari (pascoli, detriti, pietraie). Servono scarponi, allenamento e un po' di senso dell'orientamento." },
    EE: { nome: "Escursionisti esperti", sigla: "EE", spiega: "Sentieri a volte poco tracciati, con passaggi esposti, ghiaioni o brevi tratti di roccia facile. Servono esperienza, piede fermo e niente vertigini." },
    EEA: { nome: "Esperti con attrezzatura", sigla: "EEA", spiega: "Vie ferrate e sentieri attrezzati con cavi, scale e pioli. Obbligatori imbrago, set da ferrata e casco." },
    EAI: { nome: "In ambiente innevato", sigla: "EAI", spiega: "Percorsi su neve con racchette o ramponi. Servono attrezzatura invernale e conoscenza del pericolo valanghe." },
    ND: { nome: "Difficoltà non indicata", sigla: "?", spiega: "Su OpenStreetMap la difficoltà di questo sentiero non è ancora scritta." }
  };
  const ORDINE_DIFF = ["T", "E", "EE", "EEA", "EAI", "ND"];
  const DA_SAC = {
    hiking: "T", mountain_hiking: "E", demanding_mountain_hiking: "EE",
    alpine_hiking: "EE", demanding_alpine_hiking: "EEA", difficult_alpine_hiking: "EEA"
  };

  function difficolta(t) {
    t = t || {};
    const c = String(t.cai_scale || "").trim().toUpperCase().replace(/\s+/g, "");
    if (/^EAI/.test(c)) return "EAI";
    if (/^EEA/.test(c)) return "EEA";
    if (/^EE/.test(c)) return "EE";
    if (/^E/.test(c)) return "E";
    if (/^T/.test(c)) return "T";
    return DA_SAC[t.sac_scale] || "ND";
  }

  // ---------- Tipi di punti ----------
  // Ogni punto ha un codice "k". L'ordine qui è quello del menu e della guida.
  const TIPI = {
    R: { nome: "Rifugio", plurale: "Rifugi" },
    B: { nome: "Bivacco", plurale: "Bivacchi e ricoveri" },
    W: { nome: "Fontanella", plurale: "Fontanelle" },
    S: { nome: "Sorgente", plurale: "Sorgenti" },
    C: { nome: "Bar o ristorante", plurale: "Bar e ristoranti" }
  };
  // Bar, ristoranti e agriturismi: si tengono solo quelli a meno di RAGGIO_RISTORO metri da un sentiero
  // (in Italia sono più di 150.000, quasi tutti in città). "y" = che locale è.
  const RAGGIO_RISTORO = 300;
  const LOCALI = { r: "Ristorante", b: "Bar", c: "Caffè", p: "Pub", a: "Agriturismo" };
  const DA_AMENITY = { restaurant: "r", bar: "b", cafe: "c", pub: "p" };
  function tipoLocale(t) {
    if (t.agriturismo === "yes" || t.guest_house === "agritourism") return "a";
    return DA_AMENITY[t.amenity] || null;
  }

  /** Codice del tipo di punto a partire dai tag OSM, oppure null se non interessa. */
  function tipoDaTag(t) {
    t = t || {};
    if (t.tourism === "alpine_hut") return "R";
    if (t.tourism === "wilderness_hut" || (t.amenity === "shelter" && /^(basic_hut|lean_to|rock_shelter)$/.test(t.shelter_type || ""))) return "B";
    if (t.amenity === "drinking_water" || (t.amenity === "fountain" && t.drinking_water === "yes") ||
        (t.amenity === "water_point" && t.drinking_water !== "no")) return "W";
    if (t.natural === "spring") return "S";
    if (tipoLocale(t)) return "C";
    return null;
  }

  // Punto compatto: solo i campi che servono all'app
  function compatta(el) {
    const t = el.tags || {};
    const k = tipoDaTag(t);
    if (!k) return null;
    const la = el.lat ?? (el.center && el.center.lat);
    const lo = el.lon ?? (el.center && el.center.lon);
    if (la == null || lo == null) return null;
    const p = { i: el.type[0] + el.id, k, la: +la.toFixed(6), lo: +lo.toFixed(6) };
    const metti = (chiave, v) => { v = String(v ?? "").trim(); if (v) p[chiave] = v; };
    metti("n", t.name || t["name:it"]);
    metti("q", parseFloat(String(t.ele || "").replace(",", ".")) ? Math.round(parseFloat(String(t.ele).replace(",", "."))) : "");
    metti("h", t.opening_hours);
    metti("t", t.phone || t["contact:phone"] || t["contact:mobile"]);
    metti("w", t.website || t["contact:website"] || t.url);
    metti("o", t.operator);
    if (k !== "C") metti("p", t.beds || t.capacity);
    if (k === "C") metti("y", tipoLocale(t));
    const info = [];
    if (k === "R" || k === "B") {
      if (t.fireplace === "yes") info.push("con stufa o camino");
      if (t.drinking_water === "yes") info.push("acqua potabile");
      if (t.reservation === "required") info.push("prenotazione obbligatoria");
    }
    if (k === "W" || k === "S") {
      if (k === "S" && t.drinking_water === "yes") info.push("acqua potabile");
      if (t.drinking_water === "no") info.push("acqua non potabile");
      if (t.drinking_water === "conditional" || t["drinking_water:legal"] === "no") info.push("potabilità non garantita");
      if (t.seasonal === "yes" || t.seasonal === "summer") info.push("solo in alcuni mesi");
      if (t.intermittent === "yes") info.push("a volte asciutta");
    }
    if (k === "C") {
      if (t.outdoor_seating === "yes") info.push("posti all'aperto");
      if (t.cuisine === "regional" || t.cuisine === "italian;regional") info.push("cucina regionale");
      if (t.cuisine === "pizza") info.push("pizzeria");
    }
    if (info.length) p.x = info.join(", ");
    return p;
  }

  // ---------- Simbolo del sentiero (osmc:symbol) ----------
  // Formato: colore_via:sfondo[_forma]:disegno[:testo:colore_testo], es. "red:white:red_bar:123:black"
  const COLORI = {
    red: "#d52b1e", white: "#ffffff", yellow: "#f6c700", blue: "#1f5bd6", green: "#1d8a3c", black: "#111111",
    orange: "#f28a1a", purple: "#7a3fb2", brown: "#7a4a1d", gray: "#888888", grey: "#888888"
  };
  function leggiSimbolo(s) {
    const parti = String(s || "").split(":");
    if (parti.length < 2) return null;
    const [, sfondo = "", disegno = "", testo = "", coloreTesto = ""] = parti;
    const [colSf, formaSf] = sfondo.split("_");
    const m = disegno.match(/^([a-z]+)_(.+)$/);
    return {
      sfondo: COLORI[colSf] || null,
      formaSfondo: formaSf || "",
      colore: m ? COLORI[m[1]] || null : null,
      forma: m ? m[2] : "",
      testo: testo.slice(0, 4),
      coloreTesto: COLORI[coloreTesto] || "#111111"
    };
  }
  // Senza osmc:symbol, i sentieri CAI hanno il segnavia bianco e rosso
  const SIMBOLO_CAI = { sfondo: "#d52b1e", formaSfondo: "", colore: "#ffffff", forma: "bar", testo: "", coloreTesto: "#111111" };

  /** Segnavia disegnato in SVG (lato "n" pixel). */
  function svgSimbolo(sim, n, testo) {
    n = n || 28;
    sim = sim || SIMBOLO_CAI;
    const txt = (testo ?? sim.testo) || "";
    const larghezza = txt.length > 2 ? 34 : 24;
    const W = larghezza, H = 24;
    const c = sim.colore || "#ffffff";
    const forme = {
      bar: `<rect x="0" y="8" width="${W}" height="8" fill="${c}"/>`,
      stripe: `<rect x="${W / 2 - 4}" y="0" width="8" height="${H}" fill="${c}"/>`,
      cross: `<path d="M${W / 2 - 2.5} 4h5v5.5h5.5v5H${W / 2 + 2.5}V20h-5v-5.5H${W / 2 - 8}v-5h5.5z" fill="${c}"/>`,
      x: `<path d="M${W / 2 - 8} 4l16 16M${W / 2 + 8} 4L${W / 2 - 8} 20" stroke="${c}" stroke-width="4"/>`,
      dot: `<circle cx="${W / 2}" cy="12" r="6.5" fill="${c}"/>`,
      circle: `<circle cx="${W / 2}" cy="12" r="6" fill="none" stroke="${c}" stroke-width="3"/>`,
      triangle: `<path d="M${W / 2} 4l8 15H${W / 2 - 8}z" fill="${c}"/>`,
      diamond: `<path d="M${W / 2} 3l8 9-8 9-8-9z" fill="${c}"/>`,
      lower: `<rect x="0" y="12" width="${W}" height="12" fill="${c}"/>`,
      corner: `<path d="M0 0h${W}L0 ${H}z" fill="${c}"/>`,
      rectangle: `<rect x="${W / 2 - 7}" y="5" width="14" height="14" fill="${c}"/>`,
      fork: `<path d="M${W / 2} 22V12M${W / 2} 12L${W / 2 - 7} 3M${W / 2} 12l7-9" stroke="${c}" stroke-width="3.5" fill="none"/>`,
      arch: `<path d="M${W / 2 - 8} 20a8 8 0 0 1 16 0" stroke="${c}" stroke-width="4" fill="none"/>`,
      hiker: `<circle cx="${W / 2}" cy="5" r="2.5" fill="${c}"/><path d="M${W / 2} 8v7l-3 6M${W / 2} 15l3 6M${W / 2 - 3} 11h6" stroke="${c}" stroke-width="2.4" fill="none"/>`
    };
    const disegno = forme[sim.forma.replace(/_line$/, "")] || "";
    const sfondo = sim.sfondo || "#ffffff";
    const cornice = sim.formaSfondo === "frame" ? `<rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" fill="none" stroke="${sfondo}" stroke-width="3"/>` : "";
    const fondo = sim.formaSfondo === "frame" ? "#ffffff" : sim.formaSfondo === "circle" ? "#ffffff" : sfondo;
    const tondo = sim.formaSfondo === "circle" ? `<circle cx="${W / 2}" cy="12" r="10" fill="none" stroke="${sfondo}" stroke-width="3"/>` : "";
    // il testo su fondo scuro va in bianco se il colore indicato non si leggerebbe
    const col = sim.coloreTesto || "#111111";
    const scritta = txt ? `<text x="${W / 2}" y="16.2" text-anchor="middle" font-family="Barlow Semi Condensed, Arial Narrow, sans-serif" font-weight="700" font-size="${txt.length > 3 ? 10 : 11.5}" fill="${col}" stroke="#ffffff" stroke-width="2.2" paint-order="stroke">${esc(txt)}</text>` : "";
    return `<svg class="segnavia" viewBox="0 0 ${W} ${H}" width="${Math.round(n * W / 24)}" height="${Math.round(n)}" aria-hidden="true">` +
      `<rect width="${W}" height="${H}" rx="2" fill="${fondo}"/>${cornice}${tondo}${disegno}${scritta}` +
      `<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="2" fill="none" stroke="rgba(0,0,0,.35)"/></svg>`;
  }
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ---------- Sentieri (relazioni route=hiking) ----------
  // Le vie di un sentiero non sono sempre in ordine: si uniscono in tratti continui attaccando le vie che
  // hanno un'estremità in comune (stesse coordinate). Con un indice delle estremità resta veloce anche per
  // le alte vie con centinaia di pezzi.
  function unisciTratti(vie) {
    const pezzi = vie.filter((v) => v.length > 1);
    const chiave = (p) => p[0] + "," + p[1];
    const estremi = new Map();
    pezzi.forEach((v, i) => {
      for (const k of [chiave(v[0]), chiave(v[v.length - 1])]) {
        if (!estremi.has(k)) estremi.set(k, []);
        estremi.get(k).push(i);
      }
    });
    const usato = new Array(pezzi.length).fill(false);
    // un pezzo libero che tocca il punto p, già girato in modo da partire da p
    const seguente = (p) => {
      for (const j of estremi.get(chiave(p)) || []) {
        if (usato[j]) continue;
        usato[j] = true;
        const v = pezzi[j];
        return chiave(v[0]) === chiave(p) ? v : v.slice().reverse();
      }
      return null;
    };
    const tratti = [];
    pezzi.forEach((v, i) => {
      if (usato[i]) return;
      usato[i] = true;
      let linea = v.slice(), n;
      while ((n = seguente(linea[linea.length - 1]))) linea = linea.concat(n.slice(1));
      while ((n = seguente(linea[0]))) linea = n.slice().reverse().concat(linea.slice(1));
      tratti.push(linea);
    });
    return tratti.sort((x, y) => lunghezzaLinea(y) - lunghezzaLinea(x));
  }
  function lunghezzaLinea(l) {
    let s = 0;
    for (let i = 1; i < l.length; i++) s += distanza(l[i - 1][0], l[i - 1][1], l[i][0], l[i][1]);
    return s;
  }
  const numero = (v) => { const x = parseFloat(String(v || "").replace(",", ".")); return isFinite(x) ? x : null; };
  // "distance" può essere in km ("12.5", "12,5 km") o in metri ("800 m")
  function metriDaTag(v) {
    const s = String(v || "").trim().toLowerCase();
    const x = numero(s);
    if (x == null) return null;
    if (/\bm$/.test(s) && !/km$/.test(s)) return x;
    if (/mi$/.test(s)) return x * 1609;
    return x * 1000;
  }
  // "duration" come "3:30", "03:30", "3h30", "PT3H30M" o "3"
  function minutiDaTag(v) {
    const s = String(v || "").trim();
    let m = s.match(/^(\d{1,2})[:.h](\d{1,2})/i) || s.match(/^PT(?:(\d+)H)?(?:(\d+)M)?$/i);
    if (m) return (+(m[1] || 0)) * 60 + (+(m[2] || 0));
    m = s.match(/^(\d+(?:[.,]\d+)?)\s*h?$/i);
    if (m) return Math.round(parseFloat(m[1].replace(",", ".")) * 60);
    return null;
  }

  /**
   * Sentiero compatto da una relazione Overpass "out geom(riquadro)": la traccia arriva ritagliata sulla zona
   * (i punti fuori sono null), così le alte vie lunghe centinaia di km non pesano. Se è ritagliata, "parz" = 1:
   * la lunghezza calcolata ("lv") è solo quella del tratto in zona.
   */
  function compattaSentiero(el) {
    const t = el.tags || {};
    if (el.type !== "relation") return null;
    let parz = false;
    const vie = [];
    for (const m of el.members || []) {
      if (m.type !== "way" || /^(alternative|excursion|approach|connection|guidepost|platform)$/.test(m.role || "")) continue;
      if (!m.geometry) { parz = true; continue; }
      let pezzo = [];
      for (const g of m.geometry) {
        if (!g) { parz = true; if (pezzo.length) vie.push(pezzo); pezzo = []; continue; }
        pezzo.push([+g.lat.toFixed(5), +g.lon.toFixed(5)]);
      }
      if (pezzo.length) vie.push(pezzo);
    }
    const tratti = unisciTratti(vie);
    if (!tratti.length) return null;
    const lunghezzaCalcolata = Math.round(tratti.reduce((s, l) => s + lunghezzaLinea(l), 0));
    const daTag = metriDaTag(t.distance);
    const s = {
      i: "r" + el.id,
      g: tratti,
      d: difficolta(t),
      l: Math.round(daTag || lunghezzaCalcolata),
      lv: lunghezzaCalcolata
    };
    if (parz) s.parz = 1;
    if (daTag) s.lt = 1;
    const metti = (chiave, v) => { v = String(v ?? "").trim(); if (v) s[chiave] = v; };
    metti("r", t.ref);
    metti("n", t.name || t["name:it"]);
    metti("da", t.from);
    metti("a", t.to);
    metti("o", t.operator);
    metti("rete", t.network);
    metti("c", t.cai_scale);
    metti("sim", t["osmc:symbol"]);
    metti("w", t.website);
    metti("nota", t.description || t.note_it || "");
    const salita = numero(t.ascent), discesa = numero(t.descent);
    if (salita != null) s.su = Math.round(salita);
    if (discesa != null) s.giu = Math.round(discesa);
    const durata = minutiDaTag(t.duration);
    if (durata) s.t = durata;
    if (t.roundtrip === "yes") s.anello = 1;
    // sentiero CAI: gestito dal CAI o col segnavia bianco e rosso
    if (/\bcai\b|club alpino/i.test([t.operator, t.network, t.name].join(" ")) || /^red:(red|white)/.test(t["osmc:symbol"] || "")) s.cai = 1;
    return s;
  }

  // Punto del sentiero più vicino a (lat, lon), con la sua distanza
  function puntoPiuVicino(s, lat, lon) {
    let best = null, dmin = Infinity;
    for (const l of s.g) for (const p of l) {
      const d = distanza(lat, lon, p[0], p[1]);
      if (d < dmin) { dmin = d; best = p; }
    }
    return { punto: best, distanza: dmin };
  }

  // ---------- Distanza dalla traccia ----------
  // Distanza in metri del punto (lat, lon) dal segmento a-b (coordinate piane locali: va bene per poche centinaia di metri)
  function distanzaSegmento(lat, lon, a, b) {
    const kx = 111320 * Math.cos(lat * Math.PI / 180), ky = 110540;
    const ax = (a[1] - lon) * kx, ay = (a[0] - lat) * ky, bx = (b[1] - lon) * kx, by = (b[0] - lat) * ky;
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
    return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
  }
  /** Distanza dalla traccia (lista di linee [[lat, lon], ...]) e metri dall'inizio del punto più vicino ("km"). */
  function distanzaDaTraccia(lat, lon, linee) {
    let best = Infinity, km = 0, fatto = 0;
    for (const l of linee || []) {
      for (let i = 0; i < l.length; i++) {
        const b = l[i], a = i ? l[i - 1] : b;
        const seg = i ? distanza(a[0], a[1], b[0], b[1]) : 0;
        const r = distanzaSegmento(lat, lon, a, b);
        if (r.d < best) { best = r.d; km = fatto + r.t * seg; }
        fatto += seg;
      }
    }
    return { distanza: best, km };
  }
  /**
   * Id dei punti a meno di "metri" da almeno una delle linee. Si indicizzano i punti in una griglia
   * e si scorrono le linee una volta sola: va bene anche per tutta l'Italia (milioni di segmenti).
   * punti: [{i, la, lo}], linee: iterabile di [[lat, lon], ...]
   */
  function vicinoAiSentieri(punti, linee, metri) {
    metri = metri || RAGGIO_RISTORO;
    const CELLA = 0.01;   // circa 1,1 × 0,8 km
    const griglia = new Map();
    for (const p of punti) {
      const c = Math.floor(p.la / CELLA) + ":" + Math.floor(p.lo / CELLA);
      if (!griglia.has(c)) griglia.set(c, []);
      griglia.get(c).push(p);
    }
    const vicini = new Set();
    if (!griglia.size) return vicini;
    const mLat = metri / 110540;
    for (const l of linee) {
      for (let i = 0; i < l.length; i++) {
        const a = l[i ? i - 1 : 0], b = l[i];
        const mLon = metri / (111320 * Math.cos(b[0] * Math.PI / 180));
        const i0 = Math.floor((Math.min(a[0], b[0]) - mLat) / CELLA), i1 = Math.floor((Math.max(a[0], b[0]) + mLat) / CELLA);
        const j0 = Math.floor((Math.min(a[1], b[1]) - mLon) / CELLA), j1 = Math.floor((Math.max(a[1], b[1]) + mLon) / CELLA);
        for (let ci = i0; ci <= i1; ci++) {
          for (let cj = j0; cj <= j1; cj++) {
            const lista = griglia.get(ci + ":" + cj);
            if (!lista) continue;
            for (const p of lista) if (!vicini.has(p.i) && distanzaSegmento(p.la, p.lo, a, b).d <= metri) vicini.add(p.i);
          }
        }
      }
    }
    return vicini;
  }

  // ---------- Guida sul sentiero ----------
  /** Rotta (gradi da nord, in senso orario) da (lat1, lon1) a (lat2, lon2). */
  function rotta(lat1, lon1, lat2, lon2) {
    const rad = Math.PI / 180;
    const y = Math.sin((lon2 - lon1) * rad) * Math.cos(lat2 * rad);
    const x = Math.cos(lat1 * rad) * Math.sin(lat2 * rad) - Math.sin(lat1 * rad) * Math.cos(lat2 * rad) * Math.cos((lon2 - lon1) * rad);
    return (Math.atan2(y, x) / rad + 360) % 360;
  }
  /** Differenza tra due rotte, da 0 a 180 gradi. */
  function scartoRotte(a, b) { const d = Math.abs(((a - b) % 360 + 360) % 360); return d > 180 ? 360 - d : d; }
  const PUNTI_CARDINALI = ["N", "NE", "E", "SE", "S", "SO", "O", "NO"];
  const puntoCardinale = (g) => PUNTI_CARDINALI[Math.round(((g % 360) + 360) % 360 / 45) % 8];
  /**
   * Dove andare per restare sul sentiero, da (lat, lon). "verso" = rotta in cui ti stai muovendo (o null).
   * Proietta la posizione su ogni tratto della traccia (non solo sui vertici) e restituisce:
   * distanza dal sentiero, punto più vicino, rotta verso quel punto e rotta lungo il sentiero
   * (nel senso in cui stai camminando; senza "verso", nel senso in cui è disegnato).
   */
  function guidaSentiero(s, lat, lon, verso) {
    const k = Math.PI / 180 * R_TERRA, c = Math.cos(lat * Math.PI / 180);
    const xy = (p) => [(p[1] - lon) * c * k, (p[0] - lat) * k];
    let best = null;
    for (const l of s.g) {
      if (l.length === 1) {
        const [x, y] = xy(l[0]), d = Math.hypot(x, y);
        if (!best || d < best.d) best = { d, p: l[0], a: null, b: null };
        continue;
      }
      for (let i = 1; i < l.length; i++) {
        const [ax, ay] = xy(l[i - 1]), [bx, by] = xy(l[i]);
        const dx = bx - ax, dy = by - ay, q = dx * dx + dy * dy;
        const t = q ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / q)) : 0;
        const px = ax + t * dx, py = ay + t * dy, d = Math.hypot(px, py);
        if (!best || d < best.d) best = { d, p: [lat + py / k, lon + px / (c * k)], a: l[i - 1], b: l[i] };
      }
    }
    if (!best) return null;
    let lungo = best.a ? rotta(best.a[0], best.a[1], best.b[0], best.b[1]) : null;
    if (lungo != null && verso != null && isFinite(verso) && scartoRotte(lungo, verso) > 90) lungo = (lungo + 180) % 360;
    return {
      distanza: best.d,
      punto: best.p,
      versoSentiero: best.d > 0.5 ? rotta(lat, lon, best.p[0], best.p[1]) : lungo,
      lungoSentiero: lungo
    };
  }

  // Estremità del sentiero (inizio e fine dei tratti), per "Portami all'attacco"
  function estremita(s) {
    return s.g.flatMap((l) => [l[0], l[l.length - 1]]);
  }

  /** Campioni (al massimo "max") distribuiti lungo i tratti, per chiedere le quote. */
  function campioni(s, max) {
    max = max || 100;
    const tot = s.g.reduce((a, l) => a + lunghezzaLinea(l), 0);
    if (!tot) return [];
    const passo = Math.max(tot / (max - s.g.length), 20);
    const out = [];
    s.g.forEach((l, it) => {
      let resto = 0;
      out.push({ la: l[0][0], lo: l[0][1], tratto: it, km: 0 });
      let km = 0;
      for (let i = 1; i < l.length; i++) {
        const [a1, o1] = l[i - 1], [a2, o2] = l[i];
        const d = distanza(a1, o1, a2, o2);
        let x = passo - resto;
        while (x <= d) {
          const f = x / d;
          out.push({ la: a1 + (a2 - a1) * f, lo: o1 + (o2 - o1) * f, tratto: it, km: km + x });
          x += passo;
        }
        resto = d - (x - passo);
        km += d;
      }
      const ul = l[l.length - 1];
      out.push({ la: ul[0], lo: ul[1], tratto: it, km });
    });
    return out.slice(0, max);
  }

  /** Dislivello da una serie di quote: si ignorano le variazioni sotto "soglia" metri (rumore del modello). */
  function dislivello(quote, tratti, soglia) {
    soglia = soglia ?? 8;
    let su = 0, giu = 0, min = Infinity, max = -Infinity;
    let rif = null, trattoPrec = null;
    quote.forEach((q, i) => {
      if (q == null || !isFinite(q)) return;
      min = Math.min(min, q); max = Math.max(max, q);
      const tr = tratti ? tratti[i] : 0;
      if (rif === null || tr !== trattoPrec) { rif = q; trattoPrec = tr; return; }
      if (q - rif >= soglia) { su += q - rif; rif = q; }
      else if (rif - q >= soglia) { giu += rif - q; rif = q; }
    });
    if (min === Infinity) return null;
    return { su: Math.round(su), giu: Math.round(giu), min: Math.round(min), max: Math.round(max) };
  }

  // Tempo di percorrenza stimato (formula usata dal CAI e dal Club alpino svizzero):
  // 4 km/h in piano, 300 m/h in salita, 500 m/h in discesa; si somma il maggiore con metà del minore.
  function tempoStimato(metri, su, giu) {
    const orizz = metri / 4000 * 60;
    const vert = (su || 0) / 300 * 60 + (giu || 0) / 500 * 60;
    return Math.max(orizz, vert) + Math.min(orizz, vert) / 2;
  }

  function titoloSentiero(s) {
    if (s.n) return s.n;
    if (s.r) return (s.cai ? "Sentiero CAI " : "Sentiero ") + s.r;
    return "Sentiero senza nome";
  }
  function sottotitoloSentiero(s) {
    const p = [];
    if (s.r && s.n) p.push((s.cai ? "Sentiero CAI " : "Sentiero ") + s.r);
    if (s.da && s.a) p.push(s.da + " → " + s.a);
    return p.join(" · ");
  }

  // ---------- Orari di apertura (opening_hours di OSM), come in Qui-Pets ----------
  const GIORNI = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
  const GIORNI_IT = ["lunedì", "martedì", "mercoledì", "giovedì", "venerdì", "sabato", "domenica"];
  const GIORNI_BREVI = ["Lun", "Mar", "Mer", "Gio", "Ven", "Sab", "Dom"];
  const MESI = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MESI_IT = ["gen", "feb", "mar", "apr", "mag", "giu", "lug", "ago", "set", "ott", "nov", "dic"];
  const RE_GIORNO = "(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)";

  // I rifugi hanno quasi sempre orari stagionali: "Jun 15-Sep 20" o "Jun-Sep: 08:00-22:00". Si capisce se oggi
  // è nel periodo; quello che segue i mesi si legge come un orario normale.
  function periodoMesi(testo, quando) {
    const s = String(testo || "").trim();
    const m = s.match(/^((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s*\d{1,2})?)\s*-\s*((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)(?:\s*\d{1,2})?)\s*:?\s*(.*)$/);
    if (!m) return null;
    const leggi = (x, fine) => {
      const [, mese, g] = x.match(/^(\w{3})\s*(\d{1,2})?$/);
      const i = MESI.indexOf(mese);
      return i * 100 + (g ? +g : fine ? 31 : 1);
    };
    const ini = leggi(m[1], false), fin = leggi(m[2], true);
    const ora = quando ? new Date(quando) : new Date();
    const oggi = ora.getMonth() * 100 + ora.getDate();
    const dentro = ini <= fin ? oggi >= ini && oggi <= fin : oggi >= ini || oggi <= fin;
    return { dentro, resto: m[3].trim() };
  }

  function leggiOrari(testo) {
    let s = String(testo || "").trim();
    if (!s) return null;
    if (/^24\/7$/.test(s) || /^Mo-Su 00:00-24:00$/.test(s)) return GIORNI.map(() => [[0, 1440]]);
    if (/["\[\]|]|sunrise|sunset|dawn|dusk|easter|week|\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b|\d\+/i.test(s)) return null;
    s = s.replace(/[–—]/g, "-").replace(/\s+/g, " ");
    const regole = s.split(";").flatMap((r) =>
      r.split(new RegExp("(?<=\\d|off|closed)\\s*,\\s*(?=" + RE_GIORNO + "\\b)"))).map((r) => r.trim()).filter(Boolean);
    const settimana = GIORNI.map(() => []);
    for (let regola of regole) {
      if (/^24\/7\b/.test(regola)) regola = regola.replace(/^24\/7/, "Mo-Su 00:00-24:00");
      const m = regola.match(new RegExp("^(" + RE_GIORNO + "(?:-" + RE_GIORNO + ")?(?:\\s*,\\s*" + RE_GIORNO + "(?:-" + RE_GIORNO + ")?)*)?\\s*(.*)$"));
      if (!m) return null;
      let giorni;
      if (m[1]) {
        giorni = new Set();
        let soloFestivi = true;
        for (const parte of m[1].split(/\s*,\s*/)) {
          const [a, b] = parte.split("-");
          if (a === "PH" || a === "SH") continue;
          soloFestivi = false;
          const i = GIORNI.indexOf(a), j = b ? GIORNI.indexOf(b) : i;
          if (i < 0 || j < 0) return null;
          for (let g = i; ; g = (g + 1) % 7) { giorni.add(g); if (g === j) break; }
        }
        if (soloFestivi) continue;
      } else {
        giorni = new Set([0, 1, 2, 3, 4, 5, 6]);
      }
      const corpo = m[2].trim();
      let fasce;
      if (/^(off|closed)$/i.test(corpo)) fasce = [];
      else if (corpo === "" || /^open$/i.test(corpo)) fasce = [[0, 1440]];
      else {
        fasce = [];
        for (const f of corpo.split(/\s*,\s*/)) {
          const t = f.match(/^(\d{1,2})[:.](\d{2})\s*-\s*(\d{1,2})[:.](\d{2})$/);
          if (!t) return null;
          const ini = +t[1] * 60 + +t[2];
          let fin = +t[3] * 60 + +t[4];
          if (ini > 1440 || fin > 1440 * 2) return null;
          if (fin <= ini) fin += 1440;
          fasce.push([ini, fin]);
        }
      }
      for (const g of giorni) settimana[g] = fasce.slice();
    }
    return settimana;
  }

  const giornoSettimana = (data) => (data.getDay() + 6) % 7;
  const hhmm = (min) => { min = ((min % 1440) + 1440) % 1440; return Math.floor(min / 60) + ":" + String(min % 60).padStart(2, "0"); };

  function statoApertura(orari, quando) {
    const periodo = periodoMesi(orari, quando);
    if (periodo) {
      if (!periodo.dentro) return { aperto: false, stagione: true };
      if (!periodo.resto) return { aperto: true, stagione: true };
      orari = periodo.resto;
    }
    const sett = leggiOrari(orari);
    if (!sett) return null;
    const ora = quando ? new Date(quando) : new Date();
    const g = giornoSettimana(ora), min = ora.getHours() * 60 + ora.getMinutes();
    if (sett.every((f) => f.length === 1 && f[0][0] === 0 && f[0][1] >= 1440)) return { aperto: true, sempre: !periodo, stagione: !!periodo };
    const candidati = [
      ...sett[g].map(([a, b]) => [a, b]),
      ...sett[(g + 6) % 7].filter(([, b]) => b > 1440).map(([a, b]) => [a - 1440, b - 1440])
    ];
    for (const [a, b] of candidati) if (min >= a && min < b) return { aperto: true, chiude: b };
    for (let d = 0; d < 8; d++) {
      const fasce = sett[(g + d) % 7].filter(([a]) => d > 0 || a > min).sort((x, y) => x[0] - y[0]);
      if (fasce.length) return { aperto: false, apre: { giorni: d, giorno: (g + d) % 7, min: fasce[0][0] } };
    }
    return { aperto: false, apre: null };
  }

  function testoApertura(st) {
    if (!st) return "";
    if (st.aperto) {
      if (st.sempre) return "Aperto 24 ore su 24";
      if (st.chiude != null) return "Aperto ora · chiude alle " + hhmm(st.chiude);
      return "Aperto in questa stagione";
    }
    if (st.stagione && !st.apre) return "Chiuso in questa stagione";
    if (!st.apre) return "Chiuso";
    const { giorni, giorno, min } = st.apre;
    const q = giorni === 0 ? "alle " : giorni === 1 ? "domani alle " : GIORNI_IT[giorno] + " alle ";
    return "Chiuso · apre " + q + hhmm(min);
  }

  function orariLeggibili(testo) {
    const s = String(testo || "").trim();
    if (!s) return [];
    if (s === "24/7") return ["Sempre aperto"];
    const mese = (x) => MESI_IT[MESI.indexOf(x)];
    return s.split(";").map((r) => r.trim()).filter(Boolean).map((r) => r
      // "Jun 15-Sep 20" → "dal 15 giu al 20 set"
      .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\s*-\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2})\b/g,
        (x, m1, g1, m2, g2) => `dal ${g1} ${mese(m1)} al ${g2} ${mese(m2)}`)
      .replace(/\b(Mo|Tu|We|Th|Fr|Sa|Su)\b/g, (x) => GIORNI_BREVI[GIORNI.indexOf(x)])
      .replace(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g, (x) => MESI_IT[MESI.indexOf(x)])
      .replace(/\bPH\b/g, "festivi").replace(/\bSH\b/g, "vacanze scolastiche")
      .replace(/\b(off|closed)\b/gi, "chiuso").replace(/(\d)\s*-\s*(\d)/g, "$1–$2")
      .replace(/,(?=\S)/g, ", "));
  }

  // ---------- Overpass ----------
  // Riquadro (sud, ovest, nord, est) che contiene il cerchio di ricerca
  function riquadro(lat, lon, raggio) {
    const dLat = raggio / 111320, dLon = raggio / (111320 * Math.cos(lat * Math.PI / 180));
    return [lat - dLat, lon - dLon, lat + dLat, lon + dLon].map((x) => +x.toFixed(5));
  }
  // Sentieri escursionistici (esclusi i grandi itinerari europei, lunghissimi) e punti utili, in un riquadro
  // Bar, ristoranti e agriturismi solo a meno di RAGGIO_RISTORO metri dalle vie dei sentieri (around).
  function queryOverpass(bbox, timeout) {
    const b = `(${bbox.join(",")})`;
    const vicino = `${b}(around.vie:${RAGGIO_RISTORO})`;
    return `[out:json][timeout:${timeout || 90}][maxsize:200000000];` +
      `relation${b}[route=hiking][type=route][network!=iwn]->.sentieri;.sentieri out geom${b};` +
      `way(r.sentieri)->.vie;` +
      `nwr[amenity~"^(restaurant|cafe|bar|pub)$"]${vicino};out center tags;` +
      `nwr[agriturismo=yes]${vicino};out center tags;` +
      `nwr[guest_house=agritourism]${vicino};out center tags;` +
      `(nwr${b}[tourism~"^(alpine_hut|wilderness_hut)$"];` +
      `nwr${b}[amenity=shelter][shelter_type~"^(basic_hut|lean_to|rock_shelter)$"];` +
      `node${b}[amenity=drinking_water];` +
      `node${b}[amenity=water_point];` +
      `node${b}[amenity=fountain][drinking_water=yes];` +
      `node${b}[natural=spring];` +
      `);out center tags;`;
  }

  /** Divide la risposta di Overpass in sentieri e punti. */
  function leggiRisposta(dati) {
    const sentieri = [], punti = [];
    for (const el of (dati && dati.elements) || []) {
      if (el.type === "relation" && el.tags && el.tags.route === "hiking") {
        const s = compattaSentiero(el);
        if (s) sentieri.push(s);
      } else {
        const p = compatta(el);
        if (p) punti.push(p);
      }
    }
    return { sentieri, punti };
  }

  // ---------- Vicini ----------
  function preparaPunti(lista, lat, lon, raggio, scelti, quando) {
    const out = [], visti = new Set();
    for (const d of lista || []) {
      if (visti.has(d.i)) continue;
      visti.add(d.i);
      if (scelti && !scelti.has(d.k)) continue;
      const dist = distanza(lat, lon, d.la, d.lo);
      if (dist > raggio) continue;
      out.push({ ...d, distanza: dist, apertura: d.h ? statoApertura(d.h, quando) : null });
    }
    return out;
  }
  function prepareSentieri(lista, lat, lon, raggio, scelti) {
    const out = [], visti = new Set();
    for (const s of lista || []) {
      if (visti.has(s.i)) continue;
      visti.add(s.i);
      if (scelti && !scelti.has("D" + s.d)) continue;
      const v = puntoPiuVicino(s, lat, lon);
      if (v.distanza > raggio) continue;
      out.push({ ...s, distanza: v.distanza, vicino: v.punto });
    }
    return out;
  }

  // ---------- Testi ----------
  function capitalizza(s) {
    s = String(s || "").trim();
    if (s && s === s.toUpperCase() && /[A-Z]/.test(s)) {
      const minuscole = /^(di|de|del|dei|degli|della|delle|dello|da|dal|dalla|al|alla|e|ed|in|sul|sulla|per)$/;
      return s.toLowerCase().replace(/(^|[\s'’.\-/(])([a-zà-ù])/g, (m, a, b) => a + b.toUpperCase())
        .replace(/(\s)([A-ZÀ-Ù][a-zà-ù]*)(?=\s)/g, (m, sp, w) => minuscole.test(w.toLowerCase()) ? sp + w.toLowerCase() : m);
    }
    return s;
  }
  const nomeTipo = (d) => (d.k === "C" && LOCALI[d.y]) || TIPI[d.k].nome;
  const titolo = (d) => capitalizza(d.n) || nomeTipo(d);


  // ---------- File di navigazione (GPX, KML, GeoJSON) ----------
  // Dal dettaglio di Waymarked Trails (api/v1/details/relation/ID): le vie del percorso nell'ordine della
  // relazione, in coordinate EPSG:3857. "dir" della via: 0 = in tutte e due le direzioni, 1 = solo andata,
  // -1 = solo ritorno. Come fa Waymarked Trails: si tengono le vie della direzione scelta e,
  // per il ritorno, si capovolge tutto. Le varianti ("appendices") non si includono.
  function daMercatore(x, y) {
    const lon = x / R_TERRA * 180 / Math.PI;
    const lat = (2 * Math.atan(Math.exp(y / R_TERRA)) - Math.PI / 2) * 180 / Math.PI;
    return [+lat.toFixed(6), +lon.toFixed(6)];
  }
  function tratteWmt(nodo, out) {
    if (!nodo) return out;
    if (nodo.route_type === "route") for (const n of nodo.main || []) tratteWmt(n, out);
    else if (nodo.route_type === "split") {
      for (const n of nodo.forward || []) tratteWmt(n, out);
      for (const n of nodo.backward || []) tratteWmt(n, out);
    }
    else if (nodo.route_type === "linear" && nodo.ways && nodo.ways.length) {
      let c = [];
      for (const w of nodo.ways) { c.pop(); c = c.concat(w.geometry.coordinates); }
      out.push({ dir: nodo.ways[0].direction || 0, punti: c });
    }
    return out;
  }
  /** Linee [[lat,lon],…] nella direzione scelta (1 andata, -1 ritorno, 0 entrambe), unendo i pezzi contigui. */
  function tracciaWmt(dettaglio, direzione) {
    const tratte = tratteWmt(dettaglio && dettaglio.route, []);
    const linee = [];
    let cur = null, ultimo = null, dirCur = null;
    for (const t of tratte) {
      if (direzione !== 0 && t.dir !== 0 && t.dir !== direzione) continue;
      const primo = t.punti[0];
      const attacca = cur && ultimo && primo[0] === ultimo[0] && primo[1] === ultimo[1] && (direzione !== 0 || dirCur === t.dir);
      if (attacca) cur.push(...t.punti.slice(1));
      else { cur = t.punti.slice(); linee.push(cur); }
      ultimo = t.punti[t.punti.length - 1];
      dirCur = t.dir;
    }
    let out = linee.map((l) => l.map((p) => daMercatore(p[0], p[1])));
    if (direzione === -1) out = out.reverse().map((l) => l.reverse());
    return out.filter((l) => l.length > 1);
  }
  /** I due capi del percorso per le scelte di direzione: itinerario di Waymarked Trails, poi from/to. */
  function capiPercorso(s, dettaglio) {
    const it = dettaglio && dettaglio.itinerary;
    if (it && it.length >= 2) return [it[0], it[it.length - 1]];
    if (s && s.da && s.a) return [s.da, s.a];
    return ["Inizio", "Fine"];
  }
  const xml = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
  const FORMATI = {
    gpx: { est: "gpx", tipo: "application/gpx+xml" },
    kml: { est: "kml", tipo: "application/vnd.google-earth.kml+xml" },
    geojson: { est: "geojson", tipo: "application/geo+json" }
  };
  /** Testo del file: linee [[lat,lon],…], nome del percorso, formato "gpx" | "kml" | "geojson". */
  function fileTraccia(linee, nome, formato, info) {
    info = info || {};
    if (formato === "geojson") {
      return JSON.stringify({
        type: "FeatureCollection",
        features: [{
          type: "Feature",
          properties: Object.assign({ name: nome }, info.osm ? { osm: info.osm } : {}, info.fonte ? { source: info.fonte } : {}),
          geometry: { type: "MultiLineString", coordinates: linee.map((l) => l.map((p) => [p[1], p[0]])) }
        }]
      });
    }
    if (formato === "kml") {
      const ls = linee.map((l) => "<LineString><tessellate>1</tessellate><coordinates>" +
        l.map((p) => p[1] + "," + p[0]).join(" ") + "</coordinates></LineString>").join("");
      return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document>' +
        `<name>${xml(nome)}</name><Style id="t"><LineStyle><color>ff0000e6</color><width>4</width></LineStyle></Style>` +
        `<Placemark><name>${xml(nome)}</name>${info.fonte ? `<description>${xml(info.fonte)}</description>` : ""}<styleUrl>#t</styleUrl>` +
        `<MultiGeometry>${ls}</MultiGeometry></Placemark></Document></kml>\n`;
    }
    const segs = linee.map((l) => "<trkseg>" + l.map((p) => `<trkpt lat="${p[0]}" lon="${p[1]}"/>`).join("") + "</trkseg>").join("\n");
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<gpx version="1.1" creator="Qui-Trekking" xmlns="http://www.topografix.com/GPX/1/1">\n' +
      `<metadata><name>${xml(nome)}</name>${info.fonte ? `<copyright author="${xml(info.autore || "OpenStreetMap")}"><license>${xml(info.licenza || "https://opendatacommons.org/licenses/odbl/")}</license></copyright>` : ""}` +
      `${info.osm ? `<link href="${xml(info.osm)}"><text>${xml(info.etichetta || "OpenStreetMap")}</text></link>` : ""}</metadata>\n` +
      `<trk><name>${xml(nome)}</name>\n${segs}\n</trk>\n</gpx>\n`;
  }
  /** Nome del file senza caratteri vietati */
  function nomeFile(nome, formato) {
    const base = String(nome || "sentiero").normalize("NFD").replace(/[̀-ͯ]/g, "")
      .replace(/[^\w\- ]+/g, " ").trim().replace(/\s+/g, "_").slice(0, 60) || "sentiero";
    return base + "." + FORMATI[formato].est;
  }

  const API = {
    distanza, formattaDistanza, formattaKm, formattaQuota, formattaOre, DIFFICOLTA, ORDINE_DIFF, difficolta,
    TIPI, RAGGIO_RISTORO, LOCALI, tipoDaTag, compatta, distanzaDaTraccia, vicinoAiSentieri, leggiSimbolo, svgSimbolo, SIMBOLO_CAI, unisciTratti, lunghezzaLinea, metriDaTag, minutiDaTag,
    compattaSentiero, puntoPiuVicino, rotta, scartoRotte, puntoCardinale, guidaSentiero, estremita, campioni, dislivello, tempoStimato, titoloSentiero, sottotitoloSentiero,
    leggiOrari, statoApertura, testoApertura, orariLeggibili, riquadro, queryOverpass, leggiRisposta,
    preparaPunti, prepareSentieri, capitalizza, nomeTipo, titolo,
    daMercatore, tracciaWmt, capiPercorso, fileTraccia, nomeFile, FORMATI
  };
  if (typeof module !== "undefined" && module.exports) module.exports = API;
  else root.QT = API;
})(typeof window !== "undefined" ? window : globalThis);
