const CACHE = 'jamite-v5';
const BASE = self.location.hostname === 'localhost' ? '' : '/tennis-tournament';

// 아이콘만 캐시 — 팀 사진/영상은 교체 가능성 있으므로 캐시 제외
const ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/images/icon-192.png',
  BASE + '/images/icon-512.png',
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
  // Firebase / ESPN API 요청은 캐시 제외
  if (e.request.url.includes('firebaseio.com') ||
      e.request.url.includes('googleapis.com') ||
      e.request.url.includes('espn.com')) return;

  // HTML 페이지 → 네트워크 우선 (배포 즉시 반영)
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // 팀 사진/영상 → 항상 네트워크 (교체 즉시 반영)
  if (/\/(team\d\.(jpeg|jpg|png|mp4)|logo)/.test(e.request.url)) {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  // 아이콘 등 고정 자산 → 캐시 우선
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
