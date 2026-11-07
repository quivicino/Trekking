/*
 * Qui-Trekking – configurazione
 */
window.QT_CONFIG = {
  // Versione dell'app, mostrata in fondo alla pagina Elenco. Aumentala a ogni aggiornamento.
  versione: "25",

  // Raggio di ricerca iniziale in metri (modificabile anche dall'app)
  raggioMetri: 15000,

  // Ricentra e ricalcola quando ti sposti di più di questi metri
  ricaricaDopoMetri: 500,

  // Cosa mostrare all'inizio: sentieri per difficoltà (DT turistici, DE escursionistici, DEE per esperti,
  // DEEA attrezzati, DEAI su neve, DND difficoltà non indicata) e punti (R rifugi, B bivacchi, W fontanelle, S sorgenti)
  categorie: ["DT", "DE", "DEE", "DEEA", "DEAI", "DND", "R", "B"],

  // Massimo di segnaposto sulla mappa (i più vicini): oltre, la mappa diventa lenta sul telefono
  maxSegnaposto: 800,

  // Server Overpass (OpenStreetMap), in ordine di preferenza
  overpass: [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter"
  ],

  // Quote del terreno per calcolare il dislivello quando su OpenStreetMap manca (Open-Meteo, gratuito)
  quote: "https://api.open-meteo.com/v1/elevation",

  // Auto-refresh a ogni avvio, in secondi (0 = spento: l'app riparte dall'ultima posizione). Si cambia dalla pagina elenco, solo per quella volta.
  autoRefreshSecondi: 0
};
