// Public Firebase web configuration. Firebase web config identifies the
// project; it is not a service-account credential or payment secret.
window.PAVIA_FIREBASE_CONFIG = Object.freeze({
  environment: 'production',
  useEmulators: false,
  app: Object.freeze({
    apiKey: 'AIzaSyAyF7TIFDM37bo10a0qTShPxEPxvIlSpHY',
    authDomain: 'pavia-lb.firebaseapp.com',
    databaseURL: 'https://pavia-lb-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'pavia-lb',
    appId: '1:571393548009:web:5e8122a40e791eaeb11a78',
  }),
  emulators: Object.freeze({
    authHost: '127.0.0.1',
    authPort: 9099,
    databaseHost: '127.0.0.1',
    databasePort: 9000,
  }),
});
