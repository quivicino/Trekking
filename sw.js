// Qui-Trekking – service worker: rende l'app installabile e apribile offline.
// Cambia il nome della cache a ogni aggiornamento: così l'iPhone capisce che c'è una versione nuova.
const CACHE = "trekking-27";
// Leaflet viene da unpkg: lo si tiene anche lui, se no senza rete la mappa non parte
const ESTERNI = ["https://unpkg.com/leaflet@1.9.4/dist/leaflet.js", "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css"];
// Tessere della mappa salvate con «Salva per l'uso senza rete» (le mette l'app)
const MAPPE = "mappe-salvate";
const FILE = ["./", "index.html", "style.css", "config.js", "core.js", "app.js", "installa.js", "favicon-64.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  // "reload": scarica i file dal sito, non dalla memoria del browser
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILE.map((f) => new Request(f, { cache: "reload" })))
      .then(() => c.addAll(ESTERNI).catch(() => {})))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== CACHE && x.startsWith("trekking-")).map((x) => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) {
    // mappa topografica: prima le tessere salvate, poi la rete
    if (/(^|\.)tile\.opentopomap\.org$/.test(url.hostname)) {
      e.respondWith(caches.open(MAPPE).then((c) => c.match(e.request.url)).then((r) => r || fetch(e.request)));
    } else if (ESTERNI.includes(e.request.url)) {
      e.respondWith(fetch(e.request).catch(() => caches.match(e.request.url)));
    }
    return;
  }
  // File di percorso preparati dall'app («Salva il file»): un indirizzo vero del sito, così l'iPhone
  // lo scarica come un file qualsiasi (anche dall'app installata, dove i download "blob:" non vanno).
  if (url.pathname.includes("/scarica/")) {
    e.respondWith(caches.open("file-percorsi").then((c) => c.match(e.request, { ignoreSearch: true }))
      .then((r) => r || new Response("File non più disponibile: tocca di nuovo «Salva il file».", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8" } })));
    return;
  }
  // Sempre dalla rete chiedendo al sito se il file è cambiato ("no-cache"),
  // la copia salvata (anche dei dati) serve solo senza connessione.
  const richiesta = e.request.mode === "navigate"
    ? new Request(url.href, { cache: "no-cache", credentials: "same-origin" })
    : new Request(e.request, { cache: "no-cache" });
  e.respondWith(
    fetch(richiesta).then((r) => {
      if (r.ok) {
        const copia = r.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copia));
      }
      return r;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
