/* Branded loading splash (Pavia).
 *
 * Renders instantly from inline markup + inline CSS in index.html (so it never
 * flickers), then this script drives the progress bar from REAL load milestones
 * (DOM ready, fonts ready, window load) and finishes when the storefront signals
 * first paint via the `pavia:ready` event. A hard time cap reveals the site no
 * matter what, and a pure-CSS keyframe (paviaSplashCap) is the final backstop if
 * this script never runs — the splash can never trap the visitor.
 */
(function () {
  var splash = document.getElementById('pavia-splash');
  if (!splash) return;
  var bar = document.getElementById('pavia-splash-bar');
  var done = false;
  var progress = 8;
  var start = Date.now();
  var MIN_VISIBLE = 500; // keep it on screen briefly so a warm cache doesn't flash
  var HARD_CAP = 5000;   // reveal the site after 5s regardless of load state
  var raf = 0;

  function paint() { if (bar) bar.style.width = progress.toFixed(1) + '%'; }
  function floor(p) { if (progress < p) { progress = p; paint(); } }

  // Ease asymptotically toward 90%; the last 10% only lands on a real signal,
  // which is the classic "almost there" loader feel without faking completion.
  function tick() {
    if (done) return;
    progress += (90 - progress) * 0.05;
    paint();
    raf = requestAnimationFrame(tick);
  }
  raf = requestAnimationFrame(tick);

  // Real load anchors.
  if (document.readyState !== 'loading') floor(35);
  document.addEventListener('DOMContentLoaded', function () { floor(42); });
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () { floor(60); }).catch(function () {});
  }
  window.addEventListener('load', function () { floor(85); finish(350); });

  // The storefront app says real content is on screen.
  window.addEventListener('pavia:ready', function () { finish(0); });

  // Hard cap — never wait longer than this.
  window.setTimeout(function () { finish(0); }, HARD_CAP);

  function finish(extraDelay) {
    if (done) return;
    done = true;
    if (raf) cancelAnimationFrame(raf);
    splash.style.animation = 'none'; // cancel the CSS backstop — we own the fade now
    var wait = Math.max(0, MIN_VISIBLE - (Date.now() - start), extraDelay || 0);
    window.setTimeout(function () {
      progress = 100;
      paint();
      window.setTimeout(function () {
        splash.classList.add('is-hidden');
        window.setTimeout(function () {
          if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
        }, 600);
      }, 160);
    }, wait);
  }
})();
