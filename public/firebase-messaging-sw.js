/* Firebase Cloud Messaging service worker.
 * Lives in /public so CRA copies it to the site root at build time.
 * The hard-coded firebase config below is fine — these values are public
 * (they're shipped in the bundle anyway).
 */
/* eslint-disable no-undef */
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js');

// NOTE: keep these in sync with src/utils/firebase.ts.
// They are the same values exposed via REACT_APP_FIREBASE_* env vars.
firebase.initializeApp({
  apiKey: 'AIzaSyCzwhp8OWzSdBTBSTkVaeYglKxcCjjrrCA',
  authDomain: 'soccer-team-app-7f6b4.firebaseapp.com',
  projectId: 'soccer-team-app-7f6b4',
  storageBucket: 'soccer-team-app-7f6b4.firebasestorage.app',
  messagingSenderId: '320764293456',
  appId: '1:320764293456:web:efe8ed6f26fa85992f3c55',
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const title = (payload.notification && payload.notification.title) || 'GoalKickr';
  const body  = (payload.notification && payload.notification.body)  || '';
  const icon  = (payload.notification && payload.notification.icon)  || '/images/logo.png';
  const url   = (payload.data && payload.data.url) || '/';
  self.registration.showNotification(title, {
    body,
    icon,
    badge: '/images/logo.png',
    data: { url },
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) { w.navigate(url); return w.focus(); }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
