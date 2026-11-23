/*
 * Qui-Parking – cono azzurro dell'orientamento sul pallino della posizione, come in Google Maps.
 * Punta dove è rivolto il telefono (bussola). Android: evento deviceorientationabsolute, senza permessi.
 * iPhone: serve il permesso «Movimento e orientamento», chiesto al tocco del pulsante della posizione
 * (e poi al primo tocco, se già concesso una volta). Senza bussola, in movimento segue la direzione del GPS
 * (app.js chiama QuiBussola.gps con le coordinate di ogni posizione).
 */
(function () {
  "use strict";
  const PREF = "postolibero.bussola";
  let bussola = null, bussolaT = 0, rottaGps = null, rottaT = 0, frame = 0;

  function angoloSchermo() {
    const o = screen.orientation && screen.orientation.angle;
    return isFinite(o) ? o : (isFinite(window.orientation) ? +window.orientation : 0);
  }
  function direzione() {
    let dir = Date.now() - bussolaT < 3000 ? bussola : null;
    if (dir == null && Date.now() - rottaT < 10000) dir = rottaGps;
    return dir;
  }
  function disegna() {
    const cono = document.querySelector(".io-cono");
    if (!cono) return;
    const dir = direzione();
    cono.hidden = dir == null;
    if (dir != null) cono.style.transform = "rotate(" + Math.round(dir) + "deg)";
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
    if (!frame) frame = requestAnimationFrame(() => { frame = 0; disegna(); });
  }

  const D = window.DeviceOrientationEvent;
  const assoluto = "ondeviceorientationabsolute" in window;
  const conPermesso = !assoluto && D && typeof D.requestPermission === "function";
  if (assoluto) window.addEventListener("deviceorientationabsolute", suBussola, true);
  else if (D && !conPermesso) window.addEventListener("deviceorientation", suBussola, true);
  let chiedi = () => {};
  if (conPermesso) {
    let chiesta = false;
    chiedi = () => {
      if (chiesta) return;
      chiesta = true;
      D.requestPermission().then((r) => {
        if (r !== "granted") return;
        try { localStorage.setItem(PREF, "1"); } catch (e) { /* ignora */ }
        window.addEventListener("deviceorientation", suBussola, true);
      }).catch(() => {});
    };
    const btn = document.getElementById("btn-centra");
    if (btn) btn.addEventListener("click", chiedi);
    let gia = false;
    try { gia = localStorage.getItem(PREF) === "1"; } catch (e) { /* ignora */ }
    if (gia) document.addEventListener("touchend", chiedi, { once: true, passive: true });
  }

  window.QuiBussola = {
    direzione,                       // gradi da nord (bussola, o direzione del GPS in movimento), null se non nota
    permesso() { chiedi(); },        // iPhone: chiede il permesso (va chiamato dentro un tocco)
    gps(c) {
      if (c && c.heading != null && isFinite(c.heading) && c.speed != null && c.speed > 0.7) { rottaGps = c.heading; rottaT = Date.now(); }
      disegna();
    }
  };
})();
