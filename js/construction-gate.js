/* Pavia gate — an ERROR-FALLBACK screen, NOT a launch gate.
 *
 * The storefront is public by default: this script shows nothing on load. It
 * only exposes window.PaviaGate.show()/.hide(); js/app.js calls show() when
 * Firebase has a major error and there is no catalog to display, so shoppers see
 * a calm "back soon" screen instead of a broken page.
 *
 * The unlock is NEVER remembered (no localStorage): every time the gate appears
 * the password must be entered again, by design. The password is plain in source
 * on purpose — this is a soft screen, not real security. Only the owner needs it,
 * to look past the gate and check the site while the backend is misbehaving.
 */
(function () {
  'use strict';
  var PASS = 'tab2026';
  var gate = document.getElementById('ucGate');
  if (!gate) return;

  var form = document.getElementById('ucForm');
  var input = document.getElementById('ucInput');
  var error = document.getElementById('ucError');
  var wired = false;
  var visible = false;
  // In-memory only (reset on every page load). Once the owner enters the password
  // this stays true so a still-failing retry can't slam the gate back over them —
  // but a reload clears it, so a fresh visit during an outage asks again.
  var unlocked = false;

  function hide() {
    if (!visible) return;
    visible = false;
    gate.classList.remove('is-active');
    document.documentElement.classList.remove('uc-locked');
  }

  function show() {
    if (visible || unlocked) return;
    visible = true;
    wire();
    gate.classList.add('is-active');
    document.documentElement.classList.add('uc-locked');
    if (error) error.hidden = true;
    if (input) { input.value = ''; try { input.focus(); } catch (e) { /* ignore */ } }
  }

  function wire() {
    if (wired || !form) return;
    wired = true;
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (input && input.value === PASS) {
        unlocked = true;
        hide();
        // Owner is in — ask the app to retry the load that failed. The gate is
        // not remembered, so it returns on the next reload if Firebase is still
        // down (that is the requested behaviour).
        try { window.dispatchEvent(new Event('pavia:gate-unlocked')); } catch (e) { /* ignore */ }
        return;
      }
      if (error) error.hidden = false;
      if (input) { input.value = ''; input.focus(); }
      gate.classList.add('uc-shake');
      window.setTimeout(function () { gate.classList.remove('uc-shake'); }, 400);
    });
  }

  window.PaviaGate = Object.freeze({
    show: show,
    hide: hide,
    isVisible: function () { return visible; },
  });
})();
