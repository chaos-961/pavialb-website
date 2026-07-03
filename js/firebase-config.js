// Public Firebase web configuration. Firebase web config identifies the
// project; it is not a service-account credential or payment secret.
//
// Project: pavia-leb (new, independent of the retired/suspended pavia-lb and of
// the separate lebanesewebsites project). Realtime Database + Email/Password
// admin + anonymous shopper auth.
window.PAVIA_FIREBASE_CONFIG = Object.freeze({
  environment: 'production',
  useEmulators: false,
  app: Object.freeze({
    apiKey: 'AIzaSyBqNkAjjQQQVA9J7l5H92n9lvGdTmbyidg',
    authDomain: 'pavia-leb.firebaseapp.com',
    databaseURL: 'https://pavia-leb-default-rtdb.europe-west1.firebasedatabase.app',
    projectId: 'pavia-leb',
    appId: '1:467464935987:web:3595310850e8ee8a81a146',
  }),
  emulators: Object.freeze({
    authHost: '127.0.0.1',
    authPort: 9099,
    databaseHost: '127.0.0.1',
    databasePort: 9000,
  }),
});
