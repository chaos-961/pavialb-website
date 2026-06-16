// Copy this file to firebase-config.js for local Firebase provider work.
// Firebase web configuration identifies a Firebase project; it is not a
// service-account credential. Never put Admin SDK or payment secrets here.
window.PAVIA_FIREBASE_CONFIG = Object.freeze({
  environment: 'development',
  useEmulators: true,
  app: Object.freeze({
    apiKey: 'replace-with-dev-web-api-key',
    authDomain: 'replace-with-dev-project.firebaseapp.com',
    databaseURL: 'https://replace-with-dev-project-default-rtdb.firebaseio.com',
    projectId: 'demo-pavia-local',
    appId: 'replace-with-dev-web-app-id',
  }),
  emulators: Object.freeze({
    authHost: '127.0.0.1',
    authPort: 9099,
    databaseHost: '127.0.0.1',
    databasePort: 9000,
  }),
});
