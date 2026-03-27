importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// ── 캐싱 (sw.js 통합) ──────────────────────────────────────────────
const CACHE = 'jamite-v6';
const BASE = self.location.pathname.startsWith('/tennis-tournament') ? '/tennis-tournament' : '';
const ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/images/icon-192.png',
  BASE + '/images/icon-512.png',
  BASE + '/images/team1.jpeg',
  BASE + '/images/team2.jpeg',
  BASE + '/images/team3.jpeg',
  BASE + '/images/team1.mp4',
  BASE + '/images/team2.mp4',
  BASE + '/images/team3.mp4',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(ASSETS.map(url => c.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('firebaseio.com') || e.request.url.includes('googleapis.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Firebase Messaging ────────────────────────────────────────────
firebase.initializeApp({
  apiKey:            "AIzaSyB0zkRmUfVrI7TOI4LIN2gu2KRcYlHIt14",
  authDomain:        "jamite-tennis.firebaseapp.com",
  databaseURL:       "https://jamite-tennis-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "jamite-tennis",
  storageBucket:     "jamite-tennis.firebasestorage.app",
  messagingSenderId: "1023676041344",
  appId:             "1:1023676041344:web:d9a9fcf47f3b280bcbfe65"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || d.title || '자미터 테니스';
  const body  = n.body  || d.body  || '';
  const tab   = d.tab   || 'checkin';
  self.registration.showNotification(title, {
    body,
    icon: BASE + '/images/icon-192.png',
    badge: BASE + '/images/icon-192.png',
    data: { tab }
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tab = (e.notification.data && e.notification.data.tab) || 'checkin';
  const url = self.location.origin + BASE + '/?tab=' + tab;
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin + BASE) && 'focus' in client) {
          client.postMessage({ type: 'NAVIGATE_TAB', tab });
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
