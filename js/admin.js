(() => {
  'use strict';

  const BACKEND = window.PaviaBackend;
  const PAYLOAD = window.PAVIA_ADMIN_PAYLOAD;
  const ADMIN_USERNAME = 'admin';
  const textEncoder = new TextEncoder();
  const state = {
    backendReady: false,
    unlocked: false,
    inactivityTimer: 0,
    failedAttempts: 0,
    injectedScript: null,
  };

  const $ = (selector, scope = document) => scope.querySelector(selector);
  const $$ = (selector, scope = document) => Array.from(scope.querySelectorAll(selector));

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
    element.classList.toggle('show', Boolean(message));
  }

  function updateAuthState() {
    const uid = BACKEND?.authUid || '';
    $$('[data-admin-uid]').forEach((element) => { element.textContent = uid || 'Unavailable'; });
    const provider = state.backendReady ? (BACKEND?.provider || 'local') : 'initializing';
    $('[data-auth-provider]').textContent = provider;
    $('[data-auth-state]').textContent = provider === 'initializing' ? 'Checking access' : 'Ready for password';
    $('#unlockPanel').hidden = provider === 'initializing';
    const notAuthorized = $('#notAuthorizedPanel');
    if (notAuthorized) notAuthorized.hidden = true;
  }

  function clearSensitiveInputs() {
    const password = $('#loginPass');
    if (password) password.value = '';
  }

  function resetInactivityTimer() {
    clearTimeout(state.inactivityTimer);
    if (!state.unlocked) return;
    const minutes = Number(PAYLOAD?.lockAfterMinutes) || 15;
    state.inactivityTimer = window.setTimeout(() => {
      lockDashboard('Locked after inactivity. Enter the admin credentials again.');
    }, minutes * 60 * 1000);
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
    $('#lockBtn').hidden = false;
  }

  function lockDashboard(message = '') {
    state.unlocked = false;
    BACKEND?.setAdminUnlocked?.(false);
    window.PaviaDriveImages?.disconnect?.();
    clearTimeout(state.inactivityTimer);
    const mount = $('#adminPayloadMount');
    mount.hidden = true;
    mount.replaceChildren();
    state.injectedScript?.remove();
    state.injectedScript = null;
    $('#lockBtn').hidden = true;
    $('#adminGate').hidden = false;
    clearSensitiveInputs();
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

    const password = $('#loginPass').value;
    const delay = Math.min(state.failedAttempts * 900, 4500);
    if (delay) await new Promise((resolve) => window.setTimeout(resolve, delay));

    try {
      const payload = await decryptPayload(ADMIN_USERNAME, password);
      if (!payload?.html || !payload?.code) throw new Error('Invalid admin payload.');
      state.failedAttempts = 0;
      state.unlocked = true;
      BACKEND?.setAdminUnlocked?.(true);
      window.PaviaDriveImages?.setPassword?.(password);
      clearSensitiveInputs();
      injectDashboard(payload.html, payload.code);
      resetInactivityTimer();
    } catch (error) {
      state.failedAttempts += 1;
      clearSensitiveInputs();
      console.warn('Admin unlock failed.', error);
      setMessage('Invalid password.', 'error');
    }
  }

  async function initializeAuthGate() {
    $('#adminGate').hidden = false;
    updateAuthState();
    $('#loginForm').addEventListener('submit', handleUnlock);
    $('#resetIdentityBtn')?.addEventListener('click', async () => {
      const confirmed = window.confirm(
        'Resetting this anonymous identity signs this browser out and reloads admin. Continue?',
      );
      if (!confirmed) return;
      await BACKEND?.signOut?.();
      window.location.reload();
    });
    $('#lockBtn')?.addEventListener('click', () => lockDashboard('Locked. Enter the admin credentials again.'));
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
