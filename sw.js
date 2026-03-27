const CACHE = 'jamite-v1';
const BASE = self.location.hostname === 'localhost' ? '' : '/tennis-tournament';
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
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
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
  // Firebase 요청은 캐시 제외
  if (e.request.url.includes('firebaseio.com') || e.request.url.includes('googleapis.com')) return;
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
