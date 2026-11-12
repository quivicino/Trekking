# Qui-Trekking

Web app per il telefono che mostra i **sentieri** vicino a te, con lo stesso aspetto e funzionamento di
[Qui-Pets](https://github.com/quivicino/Pets) e [Distributori](https://github.com/quivicino/Distributori):

- sentieri escursionistici di OpenStreetMap (relazioni `route=hiking`), colorati secondo la **difficoltà CAI**
  (`cai_scale`: T, E, EE, EEA, EAI; se manca, `sac_scale` convertita), con **numero** (`ref`) e **segnavia**
  (`osmc:symbol`, disegnato in SVG; per i sentieri CAI senza simbolo il classico bianco e rosso);
- **lunghezza** (tag `distance` o calcolata dalla traccia), **dislivello** in salita e discesa (tag `ascent`/`descent`
  oppure stimato dalle quote del terreno di [Open-Meteo](https://open-meteo.com/en/docs/elevation-api), con profilo
  altimetrico), quota minima e massima, **tempo di percorrenza** (tag `duration` o stima CAI/CAS: 4 km/h in piano,
  300 m/h in salita, 500 m/h in discesa);
- **rifugi** (`tourism=alpine_hut`), **bivacchi** e ricoveri (`tourism=wilderness_hut`, `amenity=shelter`),
  **fontanelle** (`amenity=drinking_water`, `water_point`, fontane potabili) e **sorgenti** (`natural=spring`);
- **bar e ristoranti** (`amenity=restaurant|cafe|bar|pub`) e **agriturismi** (`agriturismo=yes` o `guest_house=agritourism`),
  solo quelli a meno di **300 m** da un sentiero (in Italia sono più di 150.000, quasi tutti in città): il filtro si fa una volta sola
  quando si preparano i dati (in `osm_italia.py` sul computer, con `around` nella query di Overpass e di nuovo nella creazione delle tessere).
  Voce «Bar e ristoranti» nel menu, spenta all'inizio; nella scheda di ogni sentiero l'elenco dei locali lungo il percorso con la distanza.

## Come funziona

- **Dati salvati nel sito per Lombardia, Valle d'Aosta e Sardegna.** Ogni lunedì GitHub esegue `aggiorna_sentieri.js`
  (workflow `.github/workflows/pubblica.yml`): scarica da Overpass sentieri e punti di Lombardia, Valle d'Aosta e Sardegna allargate di 15 km,
  a blocchi di mezzo grado (35 richieste), unisce i pezzi dei sentieri tagliati tra un blocco e l'altro e li salva nella
  cartella `dati/` del sito, divisi in tessere da 0,1°. Ogni sentiero è salvato una volta sola (nella tessera dove inizia;
  le altre tessere che attraversa dicono dov'è) e la traccia tiene un punto ogni circa 5 metri.
  In queste regioni l'app legge da lì; fuori interroga i server pubblici di Overpass (2–25 km intorno a te, di solito 15).
- Come in Qui-Pets i dati **non** stanno nel repository, solo nel sito pubblicato: a ogni altra pubblicazione,
  o se Overpass non risponde, si ricopiano quelli già pubblicati. Per riscaricarli subito: Actions →
  *Pubblica sito e aggiorna sentieri* → *Run workflow*.
- Alla fine dello scaricamento arriva una notifica sull'iPhone con l'app **ntfy** (✅ / ⚠️ / ❌) se nel repository c'è
  il secret `NTFY_TOPIC` con il nome del canale (Settings → Secrets and variables → Actions).
- L'ultima risposta resta sul telefono (IndexedDB): in montagna senza campo l'app usa quella.
  Anche le quote calcolate e le foto delle fontanelle restano sul telefono.
- Toccando un sentiero o un punto si apre la sua **scheda**, una pagina a tutto schermo (non un riquadro sulla mappa).
  Per un sentiero la mappa inquadra sempre il **sentiero intero** e lo lascia evidenziato; nella scheda il pulsante
  **Invia a un amico con WhatsApp** manda un link (`?s=sentiero&c=centro&v=lat,lon,zoom&r=raggio&k=cosa mostrare&f=filtri&o=ordine&b=mappa`)
  che apre Trekking con la stessa mappa, le stesse impostazioni e la stessa scheda.
- A ogni avvio la **lettura vocale** è spenta e l'**auto-refresh** è a 0: l'app riparte dall'**ultima posizione** guardata
  (salvata sul telefono) e il GPS non sposta la mappa finché non si tocca il pulsante della posizione.
- Pulsanti in basso: **rifugio** più vicino (aperto, se gli orari lo dicono) e **fontanella** più vicina.
- Mappe: topografica (OpenTopoMap, predefinita), stradale, stradale con nomi grandi, satellite.
- Nell'elenco c'è il pulsante per chiamare il **112** (soccorso alpino).
- Statistiche d'uso anonime, senza cookie, con [GoatCounter](https://www.goatcounter.com): si vedono su
  https://trekking.goatcounter.com (stesso login delle altre app).

## Pubblicazione

Impostazioni del repository → Pages → Source: **GitHub Actions**. A ogni modifica su `main` il workflow
`.github/workflows/pubblica.yml` pubblica il sito su `https://quivicino.github.io/Trekking/`.

## File

- `index.html`, `style.css`: interfaccia (stessi stili di Qui-Pets, barra verde bosco)
- `core.js`: logica (difficoltà, segnavia, unione dei tratti, lunghezza, dislivello, orari dei rifugi, query Overpass);
  si può usare anche da Node (`require("./core.js")`)
- `app.js`: mappa, GPS, sentieri, elenco, impostazioni
- `config.js`: impostazioni iniziali e numero di versione
- `sw.js`, `manifest.webmanifest`: installazione come app
- `installa.js`: riquadro «Metti Qui-Trekking sul telefono» (poco dopo l'avvio, solo se aperta nel browser; «Più tardi» lo nasconde per 5 giorni) e voce «Installa l'app» nella pagina Elenco. Android/Chrome: pulsante che apre l'installazione; iPhone: i passaggi di Safari; dentro WhatsApp/Facebook: come aprire la pagina nel browser
- `aggiorna_sentieri.js`, `.github/workflows/pubblica.yml`: scaricamento settimanale di Lombardia, Valle d'Aosta e Sardegna e pubblicazione. Se si aggiunge una regione, la prima pubblicazione riscarica subito tutto; i blocchi che Overpass non dà finiscono in `mancanti` nell'indice e lì l'app interroga Overpass
- `aggiorna_cai.js`: (Lombardia, Valle d'Aosta e Sardegna) percorribilità (con nota e data), tempi e dislivelli dal Catasto sentieri CAI (OSM2CAI) in `dati/cai.json`.
  OSM2CAI accetta 60 richieste al minuto e va interrogato un sentiero alla volta: si riparte dal file pubblicato e si chiedono
  solo i sentieri nuovi o cambiati (al massimo 45 minuti per giro; la prima volta servono due o tre giri per tutti i ~4.000)
- `aggiorna_res.js`: (Sardegna) sentieri e cammini della Rete Escursionistica della Sardegna (Agenzia Forestas,
  [Sardegna Sentieri](https://www.sardegnasentieri.it), licenza CC BY-NC-SA) che OpenStreetMap non ha: li prende dal servizio
  della loro mappa (Webmapp, app 32), uno al secondo e solo quelli nuovi o cambiati (si riparte da `dati/res/tutti.json` pubblicato),
  scarta quelli che per l'80% coincidono con un sentiero di OpenStreetMap e salva le tessere in `dati/res/` (id `f` + numero Forestas).
  Va eseguito dopo `aggiorna_sentieri.js`
- `dati/`: sentieri e punti, creata da GitHub solo nel sito pubblicato (non sta nel repository)
- `icon-*.png`, `favicon-64.png`, `apple-touch-icon.png`: logo Qui con le montagne
