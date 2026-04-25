importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');
importScripts('./firebase-config.js');

// ── 캐싱 (sw.js 통합) ──────────────────────────────────────────────
const CACHE = 'jamite-v248';
const BASE = self.location.pathname.startsWith('/tennis-tournament') ? '/tennis-tournament' : '';

// 아이콘만 캐시 — 팀 사진/영상/HTML은 교체 즉시 반영되도록 제외
const ASSETS = [
  BASE + '/images/icon-192.png',
  BASE + '/images/icon-512.png',
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
      Promise.all(keys.filter(k => k !== CACHE && k !== 'jamite-nav').map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.url.includes('firebaseio.com') || e.request.url.includes('googleapis.com')) return;

  // HTML → 네트워크 우선 (배포 즉시 반영)
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // 팀 사진/영상/로고 → 항상 네트워크 (HTTP 캐시도 무시하고 교체 즉시 반영)
  if (/\/(team\d\.(jpeg|jpg|png|mp4)|logo)/.test(e.request.url)) {
    e.respondWith(fetch(e.request, { cache: 'reload' }).catch(() => caches.match(e.request)));
    return;
  }

  // 아이콘 등 고정 자산 → 캐시 우선
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});

// ── Firebase Messaging ────────────────────────────────────────────
// firebaseConfig 는 importScripts('./firebase-config.js') 에서 로드됩니다
firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

messaging.onBackgroundMessage(payload => {
  const n = payload.notification || {};
  const d = payload.data || {};
  const title = n.title || d.title || '자미터 테니스';
  const body  = n.body  || d.body  || '';
  const tab      = d.tab      || 'checkin';
  const commentId = d.commentId || '';
  const betId    = d.betId    || '';
  const isWinner = d.isWinner || '';
  self.registration.showNotification(title, {
    body,
    icon: BASE + '/images/icon-192.png',
    badge: BASE + '/images/icon-192.png',
    data: { tab, commentId, betId, isWinner }
  });
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const tab       = (e.notification.data && e.notification.data.tab)       || 'checkin';
  const commentId = (e.notification.data && e.notification.data.commentId) || '';
  const betId     = (e.notification.data && e.notification.data.betId)     || '';
  const isWinner  = (e.notification.data && e.notification.data.isWinner)  || '';
  let url = self.location.origin + BASE + '/?tab=' + tab;
  if (commentId) url += '&commentId=' + commentId;
  if (betId) url += '&betId=' + betId;
  if (isWinner) url += '&isWinner=' + isWinner;

  // iOS PWA는 openWindow URL 대신 start_url로 열리므로 Cache에 탭 정보 저장
  const navPayload = new Response(JSON.stringify({ tab, commentId, betId, isWinner, ts: Date.now() }));

  e.waitUntil(
    caches.open('jamite-nav')
      .then(c => c.put('/pending-nav', navPayload))
      .then(() => clients.matchAll({ type: 'window', includeUncontrolled: true }))
      .then(list => {
        for (const client of list) {
          if (client.url.startsWith(self.location.origin + BASE) && 'focus' in client) {
            client.postMessage({ type: 'NAVIGATE_TAB', tab, commentId, betId, isWinner });
            return client.focus();
          }
        }
        return clients.openWindow(url);
      })
  );
});
