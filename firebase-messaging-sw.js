importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// ── 캐싱 (sw.js 통합) ──────────────────────────────────────────────
const CACHE = 'jamite-v10';
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
  apiKey:            "AIzaSyDgGhjMh5_wFCbb45p5kAkDJaLOJJAFDhI",
  authDomain:        "jamite-dev.firebaseapp.com",
  databaseURL:       "https://jamite-dev-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId:         "jamite-dev",
  storageBucket:     "jamite-dev.firebasestorage.app",
  messagingSenderId: "168236820456",
  appId:             "1:168236820456:web:32fab6a04d85702055e65d"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || d.title || '자미터 테니스';
  const body  = n.body  || d.body  || '';
  const tab   = d.tab   || 'checkin';
  const commentId = d.commentId || '';
  self.registration.showNotification(title, {
    body,
    icon: BASE + '/images/icon-192.png',
    badge: BASE + '/images/icon-192.png',
    data: { tab, commentId }
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tab       = (e.notification.data && e.notification.data.tab)       || 'checkin';
  const commentId = (e.notification.data && e.notification.data.commentId) || '';
  let url = self.location.origin + BASE + '/?tab=' + tab;
  if (commentId) url += '&commentId=' + commentId;

  // iOS PWA는 openWindow URL 대신 start_url로 열리므로 Cache에 탭 정보 저장
  const navPayload = new Response(JSON.stringify({ tab, commentId, ts: Date.now() }));

  e.waitUntil(
    caches.open('jamite-nav')
      .then(c => c.put('/pending-nav', navPayload))
      .then(() => clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(list => {
        for (const client of list) {
          if (client.url.startsWith(self.location.origin + BASE) && 'focus' in client) {
            client.postMessage({ type: 'NAVIGATE_TAB', tab, commentId });
            return client.focus();
          }
        }
        return clients.openWindow(url);
      })
  );
});
