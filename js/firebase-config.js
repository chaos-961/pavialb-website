// Public Firebase web configuration. Replace the app values for a real
// development, staging, or production project before selecting Firebase as
// the default backend. The demo values are restricted to localhost emulators.
window.PAVIA_FIREBASE_CONFIG = Object.freeze({
  environment: 'development',
  useEmulators: true,
  app: Object.freeze({
    apiKey: 'demo-pavia-local',
    authDomain: 'demo-pavia-local.firebaseapp.com',
    databaseURL: 'https://demo-pavia-local-default-rtdb.firebaseio.com',
    projectId: 'demo-pavia-local',
    appId: '1:000000000000:web:pavia-local',
  }),
  emulators: Object.freeze({
    authHost: '127.0.0.1',
    authPort: 9099,
    databaseHost: '127.0.0.1',
    databasePort: 9000,
  }),
});
