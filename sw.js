const CACHE = 'jamite-v1';
const ASSETS = [
  '/tennis-tournament/',
  '/tennis-tournament/index.html',
  '/tennis-tournament/manifest.json',
  '/tennis-tournament/images/icon-192.png',
  '/tennis-tournament/images/icon-512.png',
  '/tennis-tournament/images/team1.jpeg',
  '/tennis-tournament/images/team2.jpeg',
  '/tennis-tournament/images/team3.jpeg',
  '/tennis-tournament/images/team1.mp4',
  '/tennis-tournament/images/team2.mp4',
  '/tennis-tournament/images/team3.mp4',
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
