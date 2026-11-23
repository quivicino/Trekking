/*
 * Qui-Parking – configurazione
 * Modifica questo file per attivare le segnalazioni condivise e le fonti open data.
 */
window.POSTOLIBERO_CONFIG = {
  // Versione dell'app, mostrata in fondo alla pagina Elenco. Aumentala a ogni aggiornamento.
  versione: "39",

  // Raggio di ricerca iniziale in metri (modificabile anche dall'app)
  raggioMetri: 1000,

  // Ricarica i dati quando ti sposti di più di questi metri
  ricaricaDopoMetri: 200,

  // Server Overpass (OpenStreetMap). Se il primo non risponde si prova il successivo.
  // L'app ricorda quello che ha funzionato l'ultima volta e lo prova per primo.
  overpass: [
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter"
  ],

  // Segnalazioni degli utenti (crowdsourcing).
  // Crea un progetto gratuito su https://supabase.com, esegui supabase.sql
  // e incolla qui URL e "anon public key" (Project Settings → API).
  // Se lasci vuoto, le segnalazioni restano solo su questo dispositivo.
  supabase: {
    url: "https://hjaqdjmoajeztqflyeus.supabase.co",
    anonKey: "sb_publishable_AWGYr2EPmOG9W-qu9UwK0A_S0sAa0Aj"
  },

  // Dopo quanti minuti una segnalazione non viene più mostrata
  durataSegnalazioneMinuti: 120,

  // Auto-refresh predefinito in secondi (0 = spento). Si cambia anche dalla pagina elenco.
  autoRefreshSecondi: 120,

  // "La tua auto": parcheggio salvato da solo quando, con l'app aperta, si passa dalla guida
  // a una sosta. guidaKmh = velocità oltre la quale si è in auto; guidaSecondi = per quanto tempo
  // almeno; sostaSecondi/sostaMetri = fermi entro questo cerchio per questo tempo = parcheggiato.
  // dedottoOre: alla riapertura, se l'ultima posizione registrata era in auto da meno di queste ore
  // e ora sei a piedi lì vicino (entro dedottoMetri), l'app deduce dove hai lasciato l'auto.
  // Salvaschermo: si apre da solo dopo questi secondi senza tocchi (in guida o andando all'auto)
  salvaschermo: { dopoSecondi: 60 },
  parcheggioAuto: { guidaKmh: 20, guidaSecondi: 45, sostaSecondi: 90, sostaMetri: 40, dedottoOre: 8, dedottoMetri: 2000, liberaKmh: 50, liberaSecondi: 4, liberaMetri: 3000, liberaDopoMinuti: 3 },

  // Fonti open data con posti liberi in tempo reale.
  // type "opendatasoft": portali Opendatasoft (usati da molti comuni).
  // I nomi dei campi vengono riconosciuti automaticamente; se il comune usa nomi
  // diversi, indicali in "campi".
  openData: [
    {
      nome: "Comune di Bologna",
      type: "opendatasoft",
      attivo: true,
      // Il dataset viene interrogato solo se sei entro questa distanza (km) dal centro città
      centro: [44.4949, 11.3426],
      entroKm: 15,
      url: "https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/disponibilita-parcheggi-vigente/records?limit=100",
      campi: {
        // nome: "parcheggio", liberi: "posti_liberi", totali: "posti_totali",
        // posizione: "coordinate", aggiornato: "data"
      }
    },

    // --- Parcheggi comunali senza posti in tempo reale (type "statico", formato GeoJSON) ---
    // Mostrano nome ufficiale e numero di posti. Se un parcheggio è già su OpenStreetMap
    // i dati vengono uniti, senza doppioni. "url" può essere un elenco: si prova in ordine.
    {
      nome: "Comune di Milano",
      etichetta: "Parcheggio pubblico",
      type: "statico",
      attivo: true,
      centro: [45.4642, 9.19],
      entroKm: 25,
      url: [
        "milano-parcheggi-pubblici.geojson",
        "https://dati.comune.milano.it/dataset/2f4246df-2949-4530-909a-9016652cc8f9/resource/5d418fa5-a0a0-4fd8-92f2-006f1fa6e0df/download/park_pub.geojson"
      ]
    },
    {
      nome: "Comune di Milano",
      etichetta: "Parcheggio di interscambio",
      type: "statico",
      attivo: true,
      centro: [45.4642, 9.19],
      entroKm: 30,
      url: [
        "milano-interscambio.geojson",
        "https://dati.comune.milano.it/dataset/411cdd38-56f9-4ff1-b369-a2ed04778d84/resource/63c3e729-55e4-4134-a890-6fb900d7920a/download/park_interscambio.geojson"
      ]
    }
    // Pavia: i dataset regionali "COMUNE PAVIA Parcheggi" e "Aree di sosta per disabili"
    // (dati.lombardia.it) non contengono coordinate, quindi non si possono mettere in mappa.
    // A Pavia l'app usa OpenStreetMap e le segnalazioni.

    // Aggiungi qui altre città, ad esempio:
    // {
    //   nome: "Mia Città", type: "json", attivo: true,
    //   centro: [lat, lon], entroKm: 15,
    //   url: "https://.../parcheggi.json",
    //   campi: { nome: "name", liberi: "free", totali: "total", lat: "lat", lon: "lon", aggiornato: "updated" }
    // }
  ]
};
