/* Pavia gate — an UNDER-CONSTRUCTION launch gate.
 *
 * The site is NOT public yet: this covers the whole storefront on load and holds
 * until the preview password is entered. The password is plain in source on
 * purpose — this is a soft "not public yet" screen, not real security.
 *
 * The unlock IS remembered (localStorage), so once a previewer/the owner enters
 * the password the gate stays open for them across reloads and return visits.
 * Clearing site data (or the `pavia:preview-unlocked` key) re-locks it.
 */
(function () {
  'use strict';
  var PASS = 'tab2026';
  var STORAGE_KEY = 'pavia:preview-unlocked';
  var gate = document.getElementById('ucGate');
  if (!gate) return;

  var form = document.getElementById('ucForm');
  var input = document.getElementById('ucInput');
  var error = document.getElementById('ucError');
  var wired = false;
  var visible = false;

  // Remembered across reloads: once the password is entered the gate stays open.
  var unlocked = false;
  try { unlocked = window.localStorage.getItem(STORAGE_KEY) === '1'; } catch (e) { /* ignore */ }

  function hide() {
    visible = false;
    gate.classList.remove('is-active');
    document.documentElement.classList.remove('uc-locked');
  }

  function show() {
    if (unlocked) return;
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
        try { window.localStorage.setItem(STORAGE_KEY, '1'); } catch (e) { /* ignore */ }
        hide();
        // Previewer is in — let the app react (e.g. retry a load it deferred).
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
    // hide() is only honoured once the previewer has unlocked. app.js calls
    // hide() on a healthy render; the launch gate must NOT be dropped by that —
    // only the correct password opens it.
    hide: function () { if (unlocked) hide(); },
    isVisible: function () { return visible; },
  });

  // Launch gate: cover the site on load until the preview password is entered.
  if (!unlocked) show();
})();
