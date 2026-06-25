/* Pavia "under construction" gate (storefront only).
 *
 * Intentionally simple and NOT secure: it just keeps the general public from
 * seeing the site before launch. The password is in plain source on purpose —
 * anyone reading devtools can bypass it, which the owner accepts. Once entered
 * correctly it is remembered on the device (localStorage) so the gate does not
 * reappear on every visit. Runs as early as possible; the gate is shown by CSS
 * from first paint, so this script only needs to remove it (or wire the form).
 */
(function () {
  'use strict';
  var KEY = 'pavia_uc_ok';
  var PASS = 'tab2026';
  var gate = document.getElementById('ucGate');
  if (!gate) return;

  function unlock(persist) {
    if (persist) { try { localStorage.setItem(KEY, '1'); } catch (e) { /* private mode */ } }
    document.documentElement.classList.remove('uc-locked');
    if (gate.parentNode) gate.parentNode.removeChild(gate);
  }

  // Already unlocked on this device — drop the gate immediately, no flash.
  try { if (localStorage.getItem(KEY) === '1') { unlock(false); return; } } catch (e) { /* ignore */ }

  document.documentElement.classList.add('uc-locked');

  var form = document.getElementById('ucForm');
  var input = document.getElementById('ucInput');
  var error = document.getElementById('ucError');

  if (form) {
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      if (input && input.value === PASS) {
        unlock(true);
        return;
      }
      if (error) error.hidden = false;
      if (input) { input.value = ''; input.focus(); }
      gate.classList.add('uc-shake');
      window.setTimeout(function () { gate.classList.remove('uc-shake'); }, 400);
    });
  }
  if (input) {
    try { input.focus(); } catch (e) { /* ignore */ }
  }
})();
