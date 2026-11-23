// Qui-Parking – service worker: rende l'app installabile e apribile offline.
// I dati (parcheggi, segnalazioni) vengono sempre scaricati dalla rete.
// Cambia il nome della cache a ogni aggiornamento: così l'iPhone capisce che c'è una versione nuova.
const CACHE = "postolibero-41";
const FILE = ["./", "index.html", "style.css", "config.js", "core.js", "segnalazioni.js", "app.js", "installa.js", "bussola.js", "favicon-64.png", "apple-touch-icon.png", "icon-192.png", "icon-512.png", "icon-maskable-512.png", "guida.html", "manifest.webmanifest"];

self.addEventListener("install", (e) => {
  // "reload": scarica i file dal sito, non dalla memoria del browser
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILE.map((f) => new Request(f, { cache: "reload" }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((x) => x !== CACHE).map((x) => caches.delete(x)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Sempre dalla rete chiedendo al sito se il file è cambiato ("no-cache"),
  // la copia salvata serve solo senza connessione.
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
