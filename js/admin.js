(() => {
  'use strict';

  const BACKEND = window.PaviaBackend;
  const PAYLOAD = window.PAVIA_ADMIN_PAYLOAD;
  const ADMIN_USERNAME = 'admin';
  const WARN_SECONDS = 60; // show the "stay signed in" prompt this long before locking
  const textEncoder = new TextEncoder();
  const state = {
    backendReady: false,
    unlocked: false,
    inactivityTimer: 0,
    warnTimer: 0,
    warnInterval: 0,
    failedAttempts: 0,
    injectedScript: null,
  };

  const $ = (selector, scope = document) => scope.querySelector(selector);

  function bytesFromBase64(value) {
    const binary = atob(value || '');
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }

  function withTimeout(promise, timeoutMs, message) {
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        window.setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  }

  function setMessage(message, type = 'info') {
    const element = $('#loginError');
    if (!element) return;
    element.textContent = message || '';
    element.dataset.type = type;
    element.classList.toggle('is-error', type === 'error' && Boolean(message));
  }

  function updateAuthState() {
    const provider = state.backendReady ? (BACKEND?.provider || 'local') : 'initializing';
    // Keep the submit disabled until the backend is ready to accept the password.
    const submit = $('#adminSubmit');
    if (submit && !state.unlocked) submit.disabled = provider === 'initializing';
  }

  function clearSensitiveInputs() {
    const password = $('#loginPass');
    if (password) password.value = '';
  }

  function setLoginBusy(busy) {
    $('#loginForm')?.classList.toggle('is-busy', busy);
    const submit = $('#adminSubmit');
    if (submit) submit.disabled = busy;
    const password = $('#loginPass');
    if (password) password.disabled = busy;
  }

  function resetPasswordVisibility() {
    const password = $('#loginPass');
    const toggle = $('#adminPasswordToggle');
    if (password && password.type === 'text') password.type = 'password';
    if (toggle) {
      toggle.textContent = 'Show';
      toggle.setAttribute('aria-pressed', 'false');
      toggle.setAttribute('aria-label', 'Show password');
    }
  }

  function clearLockWarning() {
    if (state.warnInterval) { clearInterval(state.warnInterval); state.warnInterval = 0; }
    document.getElementById('adminLockWarning')?.remove();
  }

  function showLockWarning() {
    if (!state.unlocked || document.getElementById('adminLockWarning')) return;
    let left = WARN_SECONDS;
    const banner = document.createElement('div');
    banner.id = 'adminLockWarning';
    banner.setAttribute('role', 'alertdialog');
    banner.setAttribute('aria-live', 'assertive');
    banner.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:9999;'
      + 'display:flex;align-items:center;gap:14px;padding:12px 16px;border-radius:12px;'
      + 'background:#1a1a1a;color:#fafafa;font:500 14px/1.4 system-ui,-apple-system,sans-serif;'
      + 'box-shadow:0 10px 30px rgba(0,0,0,.28);max-width:92vw;';
    banner.innerHTML = '<span>Locking in <b id="adminLockCount">' + left + '</b>s for inactivity.</span>';
    const stay = document.createElement('button');
    stay.type = 'button';
    stay.textContent = 'Stay signed in';
    stay.style.cssText = 'background:#3a3a3a;color:#fafafa;border:none;border-radius:8px;'
      + 'padding:8px 14px;font:600 13px system-ui,-apple-system,sans-serif;cursor:pointer;';
    stay.addEventListener('click', resetInactivityTimer);
    banner.appendChild(stay);
    document.body.appendChild(banner);
    state.warnInterval = window.setInterval(() => {
      left -= 1;
      const count = document.getElementById('adminLockCount');
      if (count) count.textContent = String(Math.max(0, left));
      if (left <= 0) { clearInterval(state.warnInterval); state.warnInterval = 0; }
    }, 1000);
  }

  function resetInactivityTimer() {
    clearTimeout(state.inactivityTimer);
    clearTimeout(state.warnTimer);
    clearLockWarning();
    if (!state.unlocked) return;
    const minutes = Number(PAYLOAD?.lockAfterMinutes) || 15;
    const totalMs = minutes * 60 * 1000;
    state.warnTimer = window.setTimeout(showLockWarning, Math.max(0, totalMs - WARN_SECONDS * 1000));
    state.inactivityTimer = window.setTimeout(() => {
      lockDashboard('Locked after inactivity. Enter the admin credentials again.');
    }, totalMs);
  }

  function bindInactivityEvents() {
    ['click', 'keydown', 'pointermove', 'scroll', 'touchstart'].forEach((eventName) => {
      window.addEventListener(eventName, resetInactivityTimer, { passive: true });
    });
  }

  function injectDashboard(html, code) {
    const mount = $('#adminPayloadMount');
    mount.innerHTML = html;
    const script = document.createElement('script');
    script.textContent = code;
    state.injectedScript = script;
    document.body.appendChild(script);
    document.dispatchEvent(new Event('DOMContentLoaded'));
    $('#adminGate').hidden = true;
    mount.hidden = false;
  }

  function lockDashboard(message = '') {
    state.unlocked = false;
    BACKEND?.setAdminUnlocked?.(false);
    // Drop the Firebase admin credential and fall back to an anonymous session.
    void BACKEND?.lockAdmin?.();
    window.PaviaImageStore?.disconnect?.();
    clearTimeout(state.inactivityTimer);
    clearTimeout(state.warnTimer);
    clearLockWarning();
    const mount = $('#adminPayloadMount');
    mount.hidden = true;
    mount.replaceChildren();
    state.injectedScript?.remove();
    state.injectedScript = null;
    $('#adminGate').hidden = false;
    clearSensitiveInputs();
    resetPasswordVisibility();
    setLoginBusy(false);
    if (message) setMessage(message, 'info');
    updateAuthState();
  }

  window.PaviaAdminShell = Object.freeze({
    lock: lockDashboard,
  });

  async function deriveKey(username, password, salt) {
    const keyMaterial = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(`${username}\u0000${password}`),
      'PBKDF2',
      false,
      ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt,
        iterations: Number(PAYLOAD.iterations) || 600000,
      },
      keyMaterial,
      { name: 'AES-GCM', length: 256 },
      false,
      ['decrypt'],
    );
  }

  async function decryptPayload(username, password) {
    if (!PAYLOAD?.ciphertext || !PAYLOAD?.salt || !PAYLOAD?.iv) {
      throw new Error('The encrypted admin payload is missing. Regenerate it before deployment.');
    }
    const salt = bytesFromBase64(PAYLOAD.salt);
    const iv = bytesFromBase64(PAYLOAD.iv);
    const key = await deriveKey(username, password, salt);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: textEncoder.encode(`pavia-admin:${username}:v${PAYLOAD.version || 1}`),
      },
      key,
      bytesFromBase64(PAYLOAD.ciphertext),
    );
    return JSON.parse(new TextDecoder().decode(plaintext));
  }

  async function handleUnlock(event) {
    event.preventDefault();
    setMessage('');

    // Password-only sign-in: the admin identity is the fixed ADMIN_USERNAME
    // const, baked into the payload key derivation and the backend account.
    const password = $('#loginPass').value;
    setLoginBusy(true);
    setMessage('Signing in…', 'info');

    const delay = Math.min(state.failedAttempts * 900, 4500);
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));

    try {
      const payload = await decryptPayload(ADMIN_USERNAME, password);
      if (!payload?.html || !payload?.code) throw new Error('Invalid admin payload.');
      // Authenticate to Firebase as the admin so the database rules grant
      // admin writes. The same password must match the Firebase account.
      await BACKEND?.signInAdmin?.(password);
      state.failedAttempts = 0;
      state.unlocked = true;
      BACKEND?.setAdminUnlocked?.(true);
      // imgbb uploads use a config API key (no per-session token); this is a
      // no-op kept for interface parity in case the image provider is swapped later.
      window.PaviaImageStore?.setToken?.(password);
      clearSensitiveInputs();
      resetPasswordVisibility();
      injectDashboard(payload.html, payload.code);
      resetInactivityTimer();
    } catch (error) {
      state.failedAttempts += 1;
      clearSensitiveInputs();
      resetPasswordVisibility();
      setLoginBusy(false);
      $('#loginPass')?.focus();
      console.warn('Admin unlock failed.', error);
      const code = String(error?.code || '');
      if (code === 'auth/network-request-failed') {
        setMessage('Network error reaching Firebase. Check your connection and retry.', 'error');
      } else if (code.startsWith('auth/')) {
        setMessage('Password accepted locally, but Firebase admin sign-in failed. Confirm the admin account exists with a matching password.', 'error');
      } else {
        setMessage('Invalid password.', 'error');
      }
    }
  }

  async function initializeAuthGate() {
    $('#adminGate').hidden = false;
    updateAuthState();
    $('#loginForm').addEventListener('submit', handleUnlock);
    const passwordToggle = $('#adminPasswordToggle');
    passwordToggle?.addEventListener('click', () => {
      const password = $('#loginPass');
      if (!password) return;
      const reveal = password.type === 'password';
      password.type = reveal ? 'text' : 'password';
      passwordToggle.textContent = reveal ? 'Hide' : 'Show';
      passwordToggle.setAttribute('aria-pressed', String(reveal));
      passwordToggle.setAttribute('aria-label', reveal ? 'Hide password' : 'Show password');
      password.focus();
    });
    bindInactivityEvents();

    if (BACKEND) {
      await withTimeout(
        BACKEND.init({ defaultProducts: window.PAVIA_DEFAULT_PRODUCTS || [] }),
        12000,
        'Admin backend initialization timed out. Check Firebase configuration and network access.',
      );
      state.backendReady = true;
      BACKEND.onAuthChanged?.(() => {
        const wasUnlocked = state.unlocked;
        if (wasUnlocked && !BACKEND.authUid) {
          lockDashboard('Firebase sign-in was lost. Enter the admin password again.');
        }
        updateAuthState();
      });
    } else {
      state.backendReady = true;
    }

    updateAuthState();
  }

  document.addEventListener('DOMContentLoaded', () => {
    void initializeAuthGate().catch((error) => {
      console.error(error);
      setMessage(error.message || 'Admin initialization failed.', 'error');
      updateAuthState();
      $('#adminGate').hidden = false;
    });
  });
})();
