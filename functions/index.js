const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onValueWritten, onValueCreated } = require('firebase-functions/v2/database');
const { onCall } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

initializeApp();
setGlobalOptions({ maxInstances: 5, region: 'asia-southeast1' });

const db  = getDatabase();
const fcm = getMessaging();

// ── 유틸: 전체 FCM 토큰 목록 ───────────────────────────────────────
async function getAllTokens() {
  const snap = await db.ref('jmt/fcmTokens').once('value');
  const data = snap.val();
  if (!data) return [];
  return Object.values(data).map(v => v.token).filter(Boolean);
}

// ── 유틸: 특정 이름들의 FCM 토큰 ──────────────────────────────────
async function getTokensByNames(names) {
  const snap = await db.ref('jmt/fcmTokens').once('value');
  const data = snap.val();
  if (!data) return [];
  return Object.values(data)
    .filter(v => names.includes(v.name) && v.token)
    .map(v => v.token);
}

// ── 유틸: FCM 멀티캐스트 발송 ─────────────────────────────────────
async function sendPush(tokens, title, body, tab = 'checkin', commentId = '', betId = '', extraData = {}) {
  if (!tokens || tokens.length === 0) return;
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));
  for (const chunk of chunks) {
    const data = { title, body, tab, ...extraData };
    if (commentId) data.commentId = commentId;
    if (betId) data.betId = betId;
    await fcm.sendEachForMulticast({
      tokens: chunk,
      data,
      webpush: { headers: { Urgency: 'high' } }
    });
  }
}

// ── 유틸: 자미톡 전용 개별 발송 (사용자별 미읽음 뱃지 포함) ────────
async function sendBanzigePushWithBadge(entries, title, body, extraData = {}) {
  if (!entries || entries.length === 0) return;
  // 사용자별 미읽음 수 계산 — lastRead 이후 메시지 수
  const [lastReadSnap, msgsSnap] = await Promise.all([
    db.ref('jmt/banzige/lastRead').once('value'),
    db.ref('jmt/banzige/current/messages').orderByChild('ts').limitToLast(200).once('value'),
  ]);
  const lastReadMap = lastReadSnap.val() || {};
  const msgs = [];
  msgsSnap.forEach(c => { const v = c.val(); if (v && v.ts) msgs.push(v); });

  const messages = entries.map(({ name, token }) => {
    const lastRead = lastReadMap[name] || 0;
    const unread = msgs.filter(m => m.ts > lastRead).length;
    const badgeCount = Math.max(unread, 1); // 최소 1 (방금 수신한 메시지 포함)
    return {
      token,
      data: { title, body, tab: 'matches', ...extraData, badgeCount: String(badgeCount) },
      webpush: { headers: { Urgency: 'high' } },
    };
  });
  for (let i = 0; i < messages.length; i += 500) {
    await fcm.sendEach(messages.slice(i, i + 500));
  }
}

// ══ 0. 월요일 오전 8:30 — pollState 자동 오픈 ════════════════════
exports.autoOpenCheckin = onSchedule(
  { schedule: '0 0 * * 1', timeZone: 'Asia/Seoul' },
  async () => {
    // 이번 주 토요일 날짜 계산 (월요일 기준 +5일, KST)
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const sat = new Date(now);
    sat.setDate(now.getDate() + 5);
    const satDate = sat.toISOString().split('T')[0];
    const weekId = satDate;

    await db.ref('jmt/pollState').set({
      status: 'open',
      weekId,
      satDate,
      openedAt: new Date().toISOString(),
    });
  }
);

// ══ 1. 월요일 오전 9시 — 출첵 오픈 알림 ══════════════════════════
exports.notifyCheckinOpen = onSchedule(
  { schedule: '0 9 * * 1', timeZone: 'Asia/Seoul' },
  async () => {
    const tokens = await getAllTokens();
    await sendPush(tokens, '🎾 자미터 테니스 출첵 오픈!', '이번 주 토요일 모임 출첵을 해주세요 ✋');
  }
);

// ══ 2. 금요일 11시 30분 — 미출첵자 알림 ══════════════════════════
exports.notifyCheckinReminder = onSchedule(
  { schedule: '30 11 * * 5', timeZone: 'Asia/Seoul' },
  async () => {
    const pollStateSnap = await db.ref('jmt/pollState').once('value');
    const pollState = pollStateSnap.val();
    if (!pollState || pollState.status !== 'open') return;

    const weekId = pollState.weekId;
    const pollSnap = await db.ref(`jmt/poll/${weekId}/votes`).once('value');
    const votes = pollSnap.val() || {};
    const voted = new Set(Object.values(votes).map(v => v.name));

    const membersSnap = await db.ref('jmt/members').once('value');
    const members = Object.values(membersSnap.val() || {});
    const unvotedNames = members.map(m => m.name).filter(n => !voted.has(n));

    const tokens = await getTokensByNames(unvotedNames);
    await sendPush(tokens, '⏰ 출첵 마감 30분 전!', '아직 출첵을 안 하셨어요. 지금 바로 참석 여부를 알려주세요!');
  }
);

// ══ 2a. 화요일 오후 3시 — 미출첵자 리마인드 ══════════════════════
exports.notifyCheckinReminderTue = onSchedule(
  { schedule: '0 15 * * 2', timeZone: 'Asia/Seoul' },
  async () => {
    const pollStateSnap = await db.ref('jmt/pollState').once('value');
    const pollState = pollStateSnap.val();
    if (!pollState || pollState.status !== 'open') return;

    const weekId = pollState.weekId;
    const pollSnap = await db.ref(`jmt/poll/${weekId}/votes`).once('value');
    const votes = pollSnap.val() || {};
    const voted = new Set(Object.values(votes).map(v => v.name));

    const membersSnap = await db.ref('jmt/members').once('value');
    const members = Object.values(membersSnap.val() || {});
    const unvotedNames = members.map(m => m.name).filter(n => !voted.has(n));

    const tokens = await getTokensByNames(unvotedNames);
    await sendPush(tokens, '🎾 이번 주 출첵 하셨나요?', '아직 출첵을 안 하셨어요. 지금 바로 참석 여부를 알려주세요!');
  }
);

// ══ 2b. 수요일 정오 — 미출첵자 중간 리마인드 ══════════════════════
exports.notifyCheckinReminderWed = onSchedule(
  { schedule: '0 12 * * 3', timeZone: 'Asia/Seoul' },
  async () => {
    const pollStateSnap = await db.ref('jmt/pollState').once('value');
    const pollState = pollStateSnap.val();
    if (!pollState || pollState.status !== 'open') return;

    const weekId = pollState.weekId;
    const pollSnap = await db.ref(`jmt/poll/${weekId}/votes`).once('value');
    const votes = pollSnap.val() || {};
    const voted = new Set(Object.values(votes).map(v => v.name));

    const membersSnap = await db.ref('jmt/members').once('value');
    const members = Object.values(membersSnap.val() || {});
    const unvotedNames = members.map(m => m.name).filter(n => !voted.has(n));

    const tokens = await getTokensByNames(unvotedNames);
    await sendPush(tokens, '🎾 이번 주 출첵 하셨나요?', '아직 출첵을 안 하셨어요. 지금 바로 참석 여부를 알려주세요!');
  }
);

// ══ 2c. 목요일 정오 — 미출첵자 리마인드 ══════════════════════════
exports.notifyCheckinReminderThu = onSchedule(
  { schedule: '0 12 * * 4', timeZone: 'Asia/Seoul' },
  async () => {
    const pollStateSnap = await db.ref('jmt/pollState').once('value');
    const pollState = pollStateSnap.val();
    if (!pollState || pollState.status !== 'open') return;

    const weekId = pollState.weekId;
    const pollSnap = await db.ref(`jmt/poll/${weekId}/votes`).once('value');
    const votes = pollSnap.val() || {};
    const voted = new Set(Object.values(votes).map(v => v.name));

    const membersSnap = await db.ref('jmt/members').once('value');
    const members = Object.values(membersSnap.val() || {});
    const unvotedNames = members.map(m => m.name).filter(n => !voted.has(n));

    const tokens = await getTokensByNames(unvotedNames);
    await sendPush(tokens, '🎾 내일이 출첵 마감이에요!', '아직 출첵을 안 하셨어요. 지금 바로 참석 여부를 알려주세요!');
  }
);

// ══ 3. 금요일 정오 — 출첵 자동 마감 + 전체 알림 ════════════════
exports.notifyCheckinClose = onSchedule(
  { schedule: '0 12 * * 5', timeZone: 'Asia/Seoul' },
  async () => {
    const snap = await db.ref('jmt/pollState').once('value');
    const ps = snap.val();
    if (ps && ps.status === 'open') {
      await db.ref('jmt/pollState').update({ status: 'closed', closedAt: new Date().toISOString() });
    }
    const tokens = await getAllTokens();
    await sendPush(tokens, '🔴 출첵이 마감되었습니다', '이번 주 출첵이 마감되었습니다. 참석 인원을 확인해 주세요.', 'checkin');
  }
);

// ══ 4. 댓글 작성 알림 — DB 트리거 (전체) ═════════════════════════
exports.notifyNewComment = onValueCreated(
  { ref: 'jmt/poll/{weekId}/comments/{commentId}', region: 'asia-southeast1' },
  async (event) => {
    const comment = event.data.val();
    if (!comment) return;
    const { author, text } = comment;
    if (!author) return;
    const tokens = await getAllTokens();
    // 작성자 본인 제외
    const snap = await db.ref('jmt/fcmTokens').once('value');
    const data = snap.val() || {};
    const otherTokens = Object.values(data)
      .filter(v => v.name !== author && v.token)
      .map(v => v.token);
    await sendPush(otherTokens, `💬 ${author}님이 댓글을 달았습니다`, text, 'checkin', event.params.commentId);
  }
);

// ══ 자만추 사진/영상 업로드 알림 — DB 트리거 ══════════════════════
exports.notifyPhotoUploaded = onValueCreated(
  { ref: 'jmt/photos/{photoId}', region: 'asia-southeast1' },
  async (event) => {
    const photo = event.data.val();
    if (!photo) return;
    const { uploader, type, members } = photo;
    if (!uploader) return;

    // 1분 쿨다운 — 업로더별 마지막 푸시 시각 확인
    const cooldownRef = db.ref(`jmt/photoPushCooldown/${uploader}`);
    const cooldownSnap = await cooldownRef.once('value');
    const lastTs = cooldownSnap.val() || 0;
    if (Date.now() - lastTs < 60000) return; // 1분 이내면 생략
    await cooldownRef.set(Date.now());

    // FCM 토큰 전체 조회
    const tokenSnap = await db.ref('jmt/fcmTokens').once('value');
    const tokenData = tokenSnap.val() || {};
    const allEntries = Object.values(tokenData).filter(v => v.token);

    const isVideo = type === 'video';
    const taggedMembers = Array.isArray(members) ? members : [];

    // 태그된 멤버 → 태그 알림 (업로더 본인 제외)
    const tagTargets = taggedMembers.filter(name => name !== uploader);
    if (tagTargets.length > 0) {
      const tagTokens = allEntries.filter(v => tagTargets.includes(v.name)).map(v => v.token);
      if (tagTokens.length > 0) {
        const tagTitle = isVideo ? `🎬 ${uploader}님이 영상에 나를 태그했어요` : `🏷️ ${uploader}님이 사진에 나를 태그했어요`;
        await sendPush(tagTokens, tagTitle, '자만추 탭에서 확인해 보세요!', 'matches');
      }
    }

    // 나머지 멤버 → 업로드 알림 (업로더 본인 + 태그된 멤버 제외)
    const excludeNames = new Set([uploader, ...tagTargets]);
    const otherTokens = allEntries.filter(v => !excludeNames.has(v.name)).map(v => v.token);
    if (otherTokens.length > 0) {
      const uploadTitle = isVideo ? `🎬 ${uploader}님이 영상을 올렸어요` : `📸 ${uploader}님이 사진을 올렸어요`;
      await sendPush(otherTokens, uploadTitle, '자만추 탭에서 확인해 보세요!', 'matches');
    }
  }
);

// ══ 6. 답글 알림 — DB 트리거 ══════════════════════════════════════
exports.notifyCommentReply = onValueCreated(
  { ref: 'jmt/poll/{weekId}/comments/{commentId}/replies/{replyId}', region: 'asia-southeast1' },
  async (event) => {
    const reply = event.data.val();
    if (!reply) return;
    const { commentAuthor, author, text } = reply;
    if (!commentAuthor || commentAuthor === author) return;
    const commentId = event.params.commentId;
    const tokens = await getTokensByNames([commentAuthor]);
    await sendPush(tokens, `💬 ${author}님이 답글을 달았습니다`, text, 'checkin', commentId);
  }
);

// ══ 9. 베팅 댓글 알림 — DB 트리거 (전체) ════════════════════════
exports.notifyBetNewComment = onValueCreated(
  { ref: 'jmt/atpBets/{betId}/comments/{commentId}', region: 'asia-southeast1' },
  async (event) => {
    const comment = event.data.val();
    if (!comment) return;
    const { author, text } = comment;
    if (!author) return;
    const betId = event.params.betId;
    const snap = await db.ref('jmt/fcmTokens').once('value');
    const data = snap.val() || {};
    const otherTokens = Object.values(data)
      .filter(v => v.name !== author && v.token)
      .map(v => v.token);
    await sendPush(otherTokens, `💬 ${author}님이 댓글을 달았습니다`, text, 'atp', '', betId);
  }
);

// ══ 10. 베팅 답글 알림 — DB 트리거 ══════════════════════════════
exports.notifyBetCommentReply = onValueCreated(
  { ref: 'jmt/atpBets/{betId}/comments/{commentId}/replies/{replyId}', region: 'asia-southeast1' },
  async (event) => {
    const reply = event.data.val();
    if (!reply) return;
    const { author, text } = reply;
    if (!author) return;
    const { betId, commentId } = event.params;
    // 부모 댓글에서 commentAuthor 조회
    const parentSnap = await db.ref(`jmt/atpBets/${betId}/comments/${commentId}`).once('value');
    const parentComment = parentSnap.val();
    const commentAuthor = parentComment && parentComment.author;
    if (!commentAuthor || commentAuthor === author) return;
    const tokens = await getTokensByNames([commentAuthor]);
    await sendPush(tokens, `💬 ${author}님이 답글을 달았습니다`, text, 'atp', '', betId);
  }
);

// ── 토너먼트 티어 판별 ────────────────────────────────────────────
const ATP1000_CITIES = new Set([
  'indian wells','miami','monte carlo','monaco','madrid','rome','roma',
  'toronto','montreal','cincinnati','shanghai','paris'
]);
const ATP500_CITIES = new Set([
  'rotterdam','rio','dubai','acapulco','barcelona','hamburg',
  'washington','vienna','basel','tokyo','beijing','astana'
]);

function getVenueCity(ev) {
  const firstComp = ((ev.groupings || [])[0]?.competitions || [])[0];
  if (!firstComp?.venue) return '';
  const fullName = firstComp.venue.fullName || '';
  return fullName.split(',')[0].trim().toLowerCase();
}

function getTournamentTier(ev) {
  if (ev.major) return 'grandslam';
  const city = getVenueCity(ev);
  if (ATP1000_CITIES.has(city)) return 'atp1000';
  if (ATP500_CITIES.has(city)) return 'atp500';
  // venue/event 이름에 도시명 포함 여부로 fallback (예: "Monte-Carlo Country Club")
  const firstComp = ((ev.groupings || [])[0]?.competitions || [])[0];
  const venueStr = (firstComp?.venue?.fullName || '').toLowerCase();
  const evStr    = (ev.name || ev.shortName || '').toLowerCase();
  const combined = venueStr + ' ' + evStr;
  // 알파벳·숫자만 남겨 비교 — 하이픈/공백/특수문자 제거 후 포함 여부
  const toAlnum = s => s.replace(/[^a-z0-9]/g, '');
  const alnumCombined = toAlnum(combined);
  for (const c of ATP1000_CITIES) { if (alnumCombined.includes(toAlnum(c))) return 'atp1000'; }
  for (const c of ATP500_CITIES)  { if (alnumCombined.includes(toAlnum(c))) return 'atp500';  }
  return 'atp250';
}

const TIER_ORDER = { grandslam: 0, atp1000: 1, atp500: 2, atp250: 3 };

function selectTournament(events) {
  if (!events.length) return null;
  return events.reduce((best, ev) => {
    if (!best) return ev;
    const bTier = TIER_ORDER[getTournamentTier(best)] ?? 99;
    const eTier = TIER_ORDER[getTournamentTier(ev)]  ?? 99;
    return eTier < bTier ? ev : best;
  }, null);
}

// ── ESPN 파싱 공통 함수 ────────────────────────────────────────────
async function fetchAndParseAtpData() {
  const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard');
  const json = await res.json();
  const events = json.events || [];

  const ev = selectTournament(events);
  if (!ev) return { tournamentInfo: null, matches: [] };

  // venue 정보
  const firstGrouping = (ev.groupings || [])[0];
  const firstComp = (firstGrouping?.competitions || [])[0];
  let venueFullName = '', venueCity = '', venueCountry = '';
  if (firstComp?.venue) {
    venueFullName = firstComp.venue.fullName || '';
    const parts = venueFullName.split(',').map(s => s.trim());
    venueCity    = parts[0] || '';
    venueCountry = parts[1] || '';
  }

  const tier = getTournamentTier(ev);
  // displayName: "ESPN명 · 도시명" (도시가 이름에 이미 포함된 경우 도시만)
  const displayName = venueCity
    ? `${ev.name || ''} · ${venueCity}`
    : (ev.name || '');

  const tournamentInfo = {
    id:           ev.id        || '',
    name:         ev.name      || '',
    shortName:    ev.shortName || '',
    displayName,
    tier,
    venueName:    venueFullName,
    venueCity,
    venueCountry,
    startDate:    ev.date      || '',
    endDate:      ev.endDate   || '',
    updatedAt:    new Date().toISOString(),
  };

  // 선택된 토너먼트의 경기만 추출
  const matches = [];
  for (const grp of (ev.groupings || [])) {
    // 복합(ATP+WTA) 대회 대응: grouping 이름으로 성별 판별
    const grpName = (grp.displayName || '').toLowerCase();
    const isWomens = grpName.includes('women') || grpName.includes('female');
    for (const comp of (grp.competitions || [])) {
      const c = comp.competitors || [];
      const p1 = c[0] || {}, p2 = c[1] || {};
      const st = comp.status || {};
      matches.push({
        id:             comp.id,
        roundName:      comp.round?.displayName || grp.displayName || '',
        date:           comp.date || '',
        status:         st.type?.name || '',
        gender:         isWomens ? 'women' : 'men',
        player1Id:      p1.athlete?.id           || '',
        player1Name:    p1.athlete?.displayName  || '',
        player1Country: p1.athlete?.flag?.alt    || '',
        player1Score:   (p1.linescores || []).map(s => s.value).join(' '),
        player1Winner:  p1.winner || false,
        player2Id:      p2.athlete?.id           || '',
        player2Name:    p2.athlete?.displayName  || '',
        player2Country: p2.athlete?.flag?.alt    || '',
        player2Score:   (p2.linescores || []).map(s => s.value).join(' '),
        player2Winner:  p2.winner || false,
      });
    }
  }

  return { tournamentInfo, matches, isGrandSlam: tier === 'grandslam', ev };
}

// ── Grand Slam 저장 헬퍼 ─────────────────────────────────────────
async function saveGrandSlamIfNeeded(tournamentInfo, matches, isGrandSlam) {
  if (!isGrandSlam || !tournamentInfo || !tournamentInfo.id) return;
  const key = tournamentInfo.id;
  await db.ref(`jmt/lastGrandSlam/${key}`).set({
    tournamentInfo,
    matches,
    savedAt: new Date().toISOString(),
  });
}

// ── ATP 데이터 저장 공통 (토너먼트 변경 시 베팅 보호 후 초기화) ──
async function saveAtpData(tournamentInfo, matches, isGrandSlam) {
  const updatedAt = new Date().toISOString();

  const currentSnap = await db.ref('jmt/atpData/tournamentInfo').once('value');
  const current = currentSnap.val();
  const tournamentChanged = !!(current && current.id && tournamentInfo && tournamentInfo.id
    && current.id !== tournamentInfo.id);

  if (tournamentChanged) {
    // 대회가 바뀌었을 때: 오픈 베팅 또는 close 후 24시간 미만이면 업데이트 차단
    const betsSnap = await db.ref('jmt/atpBets').once('value');
    const bets = Object.values(betsSnap.val() || {});
    const now = Date.now();
    const HOURS_24 = 24 * 60 * 60 * 1000;

    const hasOpenBet = bets.some(b => b.open === true);
    if (hasOpenBet) {
      console.log(`saveAtpData: tournament changed (${current.id} → ${tournamentInfo.id}) but open bet exists — skipping update`);
      return;
    }

    const hasRecentClosedBet = bets.some(b => b.closedAt
      && now - new Date(b.closedAt).getTime() < HOURS_24);
    if (hasRecentClosedBet) {
      console.log(`saveAtpData: tournament changed but bet closed within 24h — skipping update`);
      return;
    }

    console.log(`Tournament changed: ${current.id} → ${tournamentInfo.id}. Clearing bets.`);
    await db.ref('jmt/atpBets').remove();
  }

  await db.ref('jmt/atpData').set({ tournamentInfo, matches, updatedAt });
  await saveGrandSlamIfNeeded(tournamentInfo, matches, isGrandSlam);
  await autoProcessWinnerBet(matches);
  // 뉴스는 fetchAtpNews(asia-southeast1)에서만 처리 — fetchAtpData(us-central1)에서 호출 시 ESPN 미국 캐시 기사로 덮어쓰는 문제 방지
}

// ── ATP 뉴스 fetch + 번역 + Firebase 저장 ─────────────────────────
async function fetchAndSaveNews() {
  try {
    const res = await fetch('https://site.api.espn.com/apis/site/v2/sports/tennis/atp/news?limit=10');
    const json = await res.json();
    const articles = (json.articles || []).slice(0, 10).map(a => ({
      headline:    a.headline || '',
      description: a.description || '',
      published:   a.published || '',
      url:         (a.links && a.links.web && a.links.web.href) || '',
    })).filter(a => a.headline);
    if (!articles.length) return;

    const TRANS_URL = 'https://script.google.com/macros/s/AKfycbwfF6W1xll0ooa0g4Gb57dnVnknXbZxKM1au3YlY52oGsrDIqHPty4q6fh6mWW0SXI00w/exec';
    const toTrans = articles.flatMap(a => [a.headline, a.description]);
    const tRes = await fetch(`${TRANS_URL}?texts=${encodeURIComponent(JSON.stringify(toTrans))}`);
    const tJson = await tRes.json();
    const tr = tJson.translated || [];
    if (tr.length === 0) { console.warn('fetchAndSaveNews: translation empty'); return; }

    articles.forEach((a, i) => {
      a.headlineKo    = tr[i * 2]     || a.headline;
      a.descriptionKo = tr[i * 2 + 1] || a.description;
    });
    await db.ref('jmt/atpNews').set({ articles, updatedAt: new Date().toISOString() });
    console.log(`fetchAndSaveNews: saved ${articles.length} articles`);
  } catch (e) {
    console.warn('fetchAndSaveNews error:', e.message);
  }
}

// ── 베팅 자동 처리 (경기 시작 시 close, 종료 시 결과 처리) ──────────
async function autoProcessWinnerBet(matches) {
  const matchList = matches || [];
  const now = new Date().toISOString();

  // TBD가 아닌 실제 남자부 결승 경기 (WTA 복합 대회에서 여자부 우승자로 처리되는 버그 방지)
  const allRealFinals = matchList.filter(m => {
    const rn = (m.roundName || '').toLowerCase();
    return (rn === 'final' || rn === 'the final')
      && !rn.includes('semi') && !rn.includes('qualify')
      && m.player1Name && m.player1Name !== 'TBD'
      && m.player2Name && m.player2Name !== 'TBD'
      && m.gender !== 'women';  // WTA 결승 제외
  });

  // 아직 시작 안 한 실제 결승이 있으면 winner 베팅 처리 보류
  // (예: Madrid Open처럼 ATP/WTA 복합 대회에서 여자 결승이 먼저 끝나도 남자 결승 대기)
  const hasPendingFinal = allRealFinals.some(m =>
    m.status !== 'STATUS_IN_PROGRESS' && m.status !== 'STATUS_FINAL'
  );

  // 진행중이거나 완료된 결승 중 가장 늦게 예정된 경기 선택
  const finalStarted = hasPendingFinal ? null : allRealFinals
    .filter(m => m.status === 'STATUS_IN_PROGRESS' || m.status === 'STATUS_FINAL')
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))[0] || null;

  // Final 경기: 완료된 것 (winner 베팅 결과 처리용)
  const finalDone = finalStarted && finalStarted.status === 'STATUS_FINAL'
    && (finalStarted.player1Winner === true || finalStarted.player2Winner === true)
    ? finalStarted : null;

  const betsSnap = await db.ref('jmt/atpBets').once('value');
  const bets = betsSnap.val() || {};

  for (const [betId, bet] of Object.entries(bets)) {
    if (bet.result) continue; // 이미 결과 처리됨

    let targetMatch = null;
    if (bet.type !== 'winner') {
      if (!bet.matchId) continue;
      targetMatch = matchList.find(m => m.id === bet.matchId);
      if (!targetMatch) continue;
    }

    // 1. 경기 시작(IN_PROGRESS) 또는 종료(FINAL) 시 open 베팅 자동 close
    if (bet.open) {
      const shouldClose = bet.type === 'winner'
        ? !!finalStarted
        : !!(targetMatch.status === 'STATUS_IN_PROGRESS' || targetMatch.status === 'STATUS_FINAL');
      if (shouldClose) {
        console.log(`autoCloseBet: betId=${betId}, type=${bet.type||'match'}`);
        await db.ref(`jmt/atpBets/${betId}`).update({ open: false, closedAt: now });
      }
    }

    // 2. 경기 종료(FINAL) 시 결과 처리 — open/close 무관 (관리자 수동 close도 포함)
    let winnerName = null;
    let winnerId = null;

    if (bet.type === 'winner') {
      if (!finalDone) continue;
      winnerName = finalDone.player1Winner ? finalDone.player1Name : finalDone.player2Name;
      winnerId   = finalDone.player1Winner ? finalDone.player1Id   : finalDone.player2Id;
    } else {
      if (targetMatch.status !== 'STATUS_FINAL'
        || (!targetMatch.player1Winner && !targetMatch.player2Winner)) continue;
      winnerName = targetMatch.player1Winner ? targetMatch.player1Name : targetMatch.player2Name;
      winnerId   = targetMatch.player1Winner ? targetMatch.player1Id   : targetMatch.player2Id;
    }

    if (!winnerName) continue;

    console.log(`autoProcessBet: betId=${betId}, type=${bet.type||'match'}, winner=${winnerName}`);
    await db.ref(`jmt/atpBets/${betId}/result`).set({
      winnerName,
      winnerId: winnerId || '',
      setAt: now,
      auto: true,
    });
    // 결과 처리 시점에도 아직 open이면 close (혹시 STATUS_IN_PROGRESS fetch를 건너뛴 경우)
    if (bet.open) {
      await db.ref(`jmt/atpBets/${betId}`).update({ open: false, closedAt: now });
    }
  }
}

// ══ 8. 2시간마다 — ESPN ATP 데이터 fetch ══════════════════════════
exports.fetchAtpData = onSchedule(
  { schedule: '0 */2 * * *', timeZone: 'Asia/Seoul' },
  async () => {
    try {
      const { tournamentInfo, matches, isGrandSlam } = await fetchAndParseAtpData();
      await saveAtpData(tournamentInfo, matches, isGrandSlam);
      await _botReportAtpResults(matches, tournamentInfo).catch(e => console.error('_botReportAtpResults error:', e));
      // 랭킹이 7일 이상 됐으면 자동 갱신 (폴백 데이터 의존 방지)
      const rankMeta = await db.ref('jmt/atpRankings/updatedAt').once('value');
      const rankAge  = Date.now() - new Date(rankMeta.val() || 0).getTime();
      if (rankAge > 7 * 24 * 60 * 60 * 1000) {
        await _fetchAndSaveAtpRankings().catch(e => console.error('auto-rankRefresh error:', e));
      }
    } catch (e) {
      console.error('fetchAtpData error:', e);
    }
  }
);

// ══ 8b. ATP top 5 결과 다이제스트 (핵심 로직) ════════════════════
const _FAKE_ATP_DATA = {
  tournamentInfo: { tier: 'grandslam', displayName: 'Roland Garros (테스트)' },
  matches: {
    'fake-qf-1': { id: 'fake-qf-1', status: 'STATUS_FINAL', roundName: 'Quarterfinals',
      player1Name: 'Jannik Sinner',        player1Score: '6 7 6', player1Winner: true,
      player2Name: 'Novak Djokovic',       player2Score: '4 5 3', player2Winner: false },
    'fake-qf-2': { id: 'fake-qf-2', status: 'STATUS_FINAL', roundName: 'Quarterfinals',
      player1Name: 'Carlos Alcaraz',       player1Score: '6 4 6', player1Winner: true,
      player2Name: 'Alexander Zverev',     player2Score: '3 6 2', player2Winner: false },
    'fake-r4-1': { id: 'fake-r4-1', status: 'STATUS_FINAL', roundName: '4th Round',
      player1Name: 'Taylor Fritz',         player1Score: '3 4 3', player1Winner: false,
      player2Name: 'Felix Auger-Aliassime',player2Score: '6 6 6', player2Winner: true },
  },
};

async function _runAtpDailyDigest(overrideData = null) {
  let tournamentInfo, matches;
  const isDryRun = !!overrideData;
  if (overrideData) {
    ({ tournamentInfo, matches } = overrideData);
  } else {
    const snap = await db.ref('jmt/atpData').once('value');
    const atpData = snap.val();
    if (!atpData || !atpData.matches || !atpData.tournamentInfo) return '데이터 없음';
    ({ tournamentInfo, matches } = atpData);
  }

  if (tournamentInfo.tier !== 'grandslam') return '그랜드슬램 아님 — 발송 생략';

  const rankSnap = await db.ref('jmt/atpRankings').once('value');
  const rankPlayers = ((rankSnap.val() || {}).players || []).length
    ? (rankSnap.val().players)
    : _ATP_FALLBACK_RANKINGS;
  const rankMap = {};
  for (const p of rankPlayers) {
    if (p.name) rankMap[p.name.toLowerCase()] = p.rank;
  }
  const getRank = (name) => {
    if (!name) return null;
    const key = name.toLowerCase();
    if (rankMap[key]) return rankMap[key];
    for (const [rn, rank] of Object.entries(rankMap)) {
      if (key.includes(rn) || rn.includes(key)) return rank;
    }
    return null;
  };

  const reportedSnap = await db.ref('jmt/botReportedMatches').once('value');
  const reported = reportedSnap.val() || {};

  const CIRCLE = ['', '①', '②', '③', '④', '⑤'];
  const ROUND_ORDER = { '1st round':1, '2nd round':2, '3rd round':3, '4th round':4, 'round of 128':1, 'round of 64':2, 'round of 32':3, 'round of 16':4, 'quarterfinals':5, 'semifinals':6, 'final':7 };
  const ROUND_LABEL = { '1st round':'1R', '2nd round':'2R', '3rd round':'3R', '4th round':'4R', 'round of 128':'1R', 'round of 64':'2R', 'round of 32':'3R', 'round of 16':'4R', 'quarterfinals':'QF', 'semifinals':'SF', 'final':'F' };
  const toKSTDate = iso => new Date(iso).toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' });

  const newResults = [];
  const nowTs = Date.now();
  for (const m of Object.values(matches)) {
    if (!m.id || m.status !== 'STATUS_FINAL') continue;
    if (reported[m.id]) continue;
    const r1 = getRank(m.player1Name);
    const r2 = getRank(m.player2Name);
    if (!((r1 && r1 <= 5) || (r2 && r2 <= 5))) continue;
    if (!m.player1Winner && !m.player2Winner) continue;
    newResults.push({ m, r1, r2 });
  }

  if (!newResults.length) return '미보고 결과 없음 — 발송 생략';

  newResults.sort((a, b) => (ROUND_ORDER[(a.m.roundName || '').toLowerCase()] || 0) - (ROUND_ORDER[(b.m.roundName || '').toLowerCase()] || 0));

  const groups = {};
  for (const item of newResults) {
    const rk = (item.m.roundName || '').toLowerCase();
    (groups[rk] = groups[rk] || []).push(item);
  }

  const yesterday = new Date(nowTs - 86400000);
  const monthDay = `${yesterday.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric' }).replace('월', '').trim()}.${yesterday.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', day: 'numeric' }).replace('일', '').trim()}`;
  const tName = tournamentInfo.displayName || '';
  const ROUND_FULL = { '1st round':'Round 1', '2nd round':'Round 2', '3rd round':'Round 3', '4th round':'Round 4', 'round of 128':'Round 1', 'round of 64':'Round 2', 'round of 32':'Round 3', 'round of 16':'Round 4', 'quarterfinals':'QF', 'semifinals':'SF', 'final':'Final' };
  const lines = [`[ Daily Top5 Report ] ${monthDay}`, ``, `🎾 ${tName}`];

  for (const [roundKey, items] of Object.entries(groups)) {
    lines.push(``, `${ROUND_FULL[roundKey] || roundKey}`, ``);
    for (const { m, r1, r2 } of items) {
      const isP1Win = m.player1Winner;
      const wName  = isP1Win ? m.player1Name : m.player2Name;
      const lName  = isP1Win ? m.player2Name : m.player1Name;
      const wRank  = isP1Win ? r1 : r2;
      const lRank  = isP1Win ? r2 : r1;
      const wScore = (isP1Win ? m.player1Score : m.player2Score || '').split(' ').filter(Boolean);
      const lScore = (isP1Win ? m.player2Score : m.player1Score || '').split(' ').filter(Boolean);
      const wSets  = wScore.filter((s, i) => parseInt(s) > parseInt(lScore[i] || 0)).length;
      const lSets  = lScore.filter((s, i) => parseInt(s) > parseInt(wScore[i] || 0)).length;
      const setScores = wScore.map((w, i) => `${w}-${lScore[i] || 0}`).join(', ');
      const wLabel = wRank && wRank <= 5 ? `${wName}(${wRank})` : wName;
      const lLabel = lRank && lRank <= 5 ? `${lName}(${lRank})` : lName;
      lines.push(`• ${wLabel} vs ${lLabel} ${wSets}-${lSets}`);
      lines.push(`  ${setScores}`);
    }
  }

  await _postBotMsg({ text: lines.join('\n') });

  // isDryRun(가짜 데이터)이면 DB 기록 생략
  if (!isDryRun) {
    const updates = {};
    for (const { m } of newResults) updates[m.id] = nowTs;
    await db.ref('jmt/botReportedMatches').update(updates);
  }
  return `완료 — ${newResults.length}경기 발송${isDryRun ? ' (테스트)' : ''}`;
}

// 스케줄 함수 (매일 8시 KST)
exports.botAtpDailyDigest = onSchedule(
  { schedule: '0 8 * * *', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => {
    try { await _runAtpDailyDigest(); } catch (e) { console.error('botAtpDailyDigest error:', e); }
  }
);

// 테스트용 callable (관리자 전용 — 앱 콘솔에서 호출)
// useFakeData:true → 가짜 top5 경기 데이터로 실행 (DB botReportedMatches 기록 안 함)
exports.testBotAtpDigest = onCall({ region: 'asia-southeast1' }, async (req) => {
  if (!_BOT_MANAGERS.includes(req.data.senderName || '')) throw new Error('권한 없음');
  const result = await _runAtpDailyDigest(req.data.useFakeData ? _FAKE_ATP_DATA : null);
  return { result };
});

// ATP 랭킹 즉시 갱신 callable (관리자 전용)
exports.refreshAtpRankings = onCall({ region: 'asia-southeast1' }, async (req) => {
  if (!_BOT_MANAGERS.includes(req.data.senderName || '')) throw new Error('권한 없음');
  const ok = await _fetchAndSaveAtpRankings();
  return { ok };
});

// ══ 9. ATP 베팅 오픈 시 전체 알림 (DB 트리거) ═════════════════════
exports.notifyAtpBetOpen = onValueCreated(
  { ref: 'jmt/atpBets/{betId}', region: 'asia-southeast1' },
  async (event) => {
    const bet = event.data.val();
    if (!bet || !bet.open) return;
    const tokens = await getAllTokens();
    const matchName = bet.matchName || '경기';
    const stake = bet.stake || '';
    await sendPush(tokens, '🎯 ATP 베팅 오픈!',
      `${matchName} 베팅이 시작됐습니다${stake ? ` · ${stake}` : ''}`, 'atp');
  }
);

// ══ 9b. 베팅 결과 확정 시 전체 알림 (DB 트리거) ═══════════════════
exports.notifyBetResult = onValueCreated(
  { ref: 'jmt/atpBets/{betId}/result', region: 'asia-southeast1' },
  async (event) => {
    const result = event.data.val();
    if (!result || !result.winnerName) return;
    const betId = event.params.betId;

    const betSnap = await db.ref(`jmt/atpBets/${betId}`).once('value');
    const bet = betSnap.val();
    if (!bet) return;

    const winnerName = result.winnerName;
    const winnerId = result.winnerId || '';
    const bets = bet.bets || {};

    // 맞춘 멤버 / 틀린 멤버 분리
    const winnerMemberNames = Object.entries(bets)
      .filter(([, b]) => b.playerName === winnerName || (winnerId && b.playerId === winnerId))
      .map(([k]) => k.replace(/_/g, ' '));
    const loserMemberNames = Object.entries(bets)
      .filter(([, b]) => b.playerName !== winnerName && !(winnerId && b.playerId === winnerId))
      .map(([k]) => k.replace(/_/g, ' '));

    // 위너 푸시
    if (winnerMemberNames.length > 0) {
      const winnerTokens = await getTokensByNames(winnerMemberNames);
      const winnerBody = `🏆 ${winnerName} 우승! 🎊 ${winnerMemberNames.join(', ')}님 정답입니다!`;
      await sendPush(winnerTokens, '🎯 베팅 결과 발표!', winnerBody, 'atp', '', betId, { isWinner: 'true' });
    }

    // 루저 + 미참여자 푸시 (나머지 전체 토큰에서 위너 제외)
    const allTokensSnap = await db.ref('jmt/fcmTokens').once('value');
    const allTokensData = allTokensSnap.val() || {};
    const nonWinnerTokens = Object.values(allTokensData)
      .filter(v => v.token && !winnerMemberNames.includes(v.name))
      .map(v => v.token);
    const loserBody = loserMemberNames.length > 0
      ? `🏆 ${winnerName} 우승! 아쉽게도 이번엔 틀렸네요 😅`
      : `🏆 ${winnerName} 우승! 베팅 결과를 확인하세요`;
    await sendPush(nonWinnerTokens, '🎯 베팅 결과 발표!', loserBody, 'atp', '', betId, { isWinner: 'false' });
  }
);

// ══ 9b. 베팅 자동 처리만 실행 (클라이언트 새로고침 후 호출용) ═════
exports.processBets = onCall(
  { region: 'asia-southeast1' },
  async () => {
    try {
      const snap = await db.ref('jmt/atpData').once('value');
      const data = snap.val();
      if (!data || !data.matches) return { success: false, error: 'no data' };
      await autoProcessWinnerBet(data.matches);
      return { success: true };
    } catch (e) {
      console.error('processBets error:', e);
      return { success: false, error: e.message };
    }
  }
);

// ══ 10. ATP 데이터 수동 갱신 (클라이언트 호출용) ══════════════════
exports.refreshAtpData = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    try {
      const { tournamentInfo, matches, isGrandSlam } = await fetchAndParseAtpData();
      await saveAtpData(tournamentInfo, matches, isGrandSlam);
      return { success: true };
    } catch (e) {
      console.error('refreshAtpData error:', e);
      return { success: false, error: e.message };
    }
  }
);

// ══ 10b. 특정 날짜 ATP 데이터 로드 (관리자 전용) ══════════════════
exports.loadAtpDataByDate = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    const { date } = request.data || {};  // 'YYYYMMDD' 형식
    if (!date || !/^\d{8}$/.test(date)) return { success: false, error: 'date must be YYYYMMDD' };
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/tennis/atp/scoreboard?dates=${date}`);
      const json = await res.json();
      const events = json.events || [];
      const ev = events.reduce((best, e) => {
        if (!best) return e;
        const TIER_O = { grandslam:0, atp1000:1, atp500:2, atp250:3 };
        return (TIER_O[getTournamentTier(e)]??99) < (TIER_O[getTournamentTier(best)]??99) ? e : best;
      }, null);
      if (!ev) return { success: false, error: 'no events found' };

      const tier = getTournamentTier(ev);
      const fc   = ((ev.groupings||[])[0]?.competitions||[])[0];
      let venueFullName='', venueCity='', venueCountry='';
      if (fc?.venue) {
        venueFullName = fc.venue.fullName||'';
        const parts = venueFullName.split(',').map(s=>s.trim());
        venueCity = parts[0]||''; venueCountry = parts[1]||'';
      }
      const displayName = venueCity ? `${ev.name||''} · ${venueCity}` : (ev.name||'');
      const tournamentInfo = {
        id: ev.id||'', name: ev.name||'', shortName: ev.shortName||'',
        displayName, tier, venueName: venueFullName, venueCity, venueCountry,
        startDate: ev.date||'', endDate: ev.endDate||'',
        updatedAt: new Date().toISOString(),
      };
      const matches = [];
      for (const grp of (ev.groupings||[])) {
        for (const comp of (grp.competitions||[])) {
          const c=comp.competitors||[], p1=c[0]||{}, p2=c[1]||{}, st=comp.status||{};
          matches.push({
            id: comp.id,
            roundName: comp.round?.displayName || grp.displayName || '',
            date: comp.date||'', status: st.type?.name||'',
            player1Id: p1.athlete?.id||'', player1Name: p1.athlete?.displayName||'',
            player1Country: p1.athlete?.flag?.alt||'',
            player1Score: (p1.linescores||[]).map(s=>s.value).join(' '),
            player1Winner: p1.winner||false,
            player2Id: p2.athlete?.id||'', player2Name: p2.athlete?.displayName||'',
            player2Country: p2.athlete?.flag?.alt||'',
            player2Score: (p2.linescores||[]).map(s=>s.value).join(' '),
            player2Winner: p2.winner||false,
          });
        }
      }
      await saveAtpData(tournamentInfo, matches, tier === 'grandslam');
      return { success: true, tournament: displayName, tier, matchCount: matches.length };
    } catch (e) {
      console.error('loadAtpDataByDate error:', e);
      return { success: false, error: e.message };
    }
  }
);

// ══ 11. 베팅 미참여자 독촉 알림 (클라이언트 호출용) ══════════════
// ══ 베팅 미참여자 자동 푸시 (매일 오후 2시) ══════════════════════
exports.notifyBetReminderScheduled = onSchedule(
  { schedule: '0 14 * * *', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => {
    try {
      const betsSnap = await db.ref('jmt/atpBets').once('value');
      const bets = betsSnap.val() || {};
      const openBets = Object.entries(bets).filter(([, b]) =>
        b.open && (!b.deadlineAt || new Date(b.deadlineAt) > new Date())
      );
      if (!openBets.length) { console.log('notifyBetReminderScheduled: 오픈 베팅 없음'); return; }

      const membersSnap = await db.ref('jmt/members').once('value');
      const members = Object.values(membersSnap.val() || {});
      const allNames = members.map(m => m.name);

      for (const [, bet] of openBets) {
        const participated = new Set(Object.keys(bet.bets || {}).map(k => k.replace(/_/g, ' ')));
        const unparticipated = allNames.filter(n => !participated.has(n));
        if (!unparticipated.length) continue;

        const tokens = await getTokensByNames(unparticipated);
        if (tokens.length) {
          const title = bet.tournamentName || bet.matchName || '베팅';
          await sendPush(tokens, '🎯 베팅 미참여 알림', `${title} 베팅에 아직 참여하지 않으셨어요! 지금 바로 참여하세요.`, 'atp');
          console.log(`notifyBetReminderScheduled: ${unparticipated.length}명에게 발송`);
        }
      }
    } catch (e) {
      console.error('notifyBetReminderScheduled error:', e);
    }
  }
);

exports.notifyBetReminder = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    const { names, betTitle } = request.data || {};
    if (!names || !names.length) return { success: false, error: 'no names' };
    const tokens = await getTokensByNames(names);
    if (tokens.length) {
      await sendPush(tokens, '🎯 베팅에 참여해주세요!', `${betTitle} 베팅이 진행 중입니다. 지금 바로 참여하세요!`, 'atp');
    }
    return { success: true, sent: tokens.length };
  }
);

// ══ 범찾게 푸시 ═══════════════════════════════════════════════════
exports.sendBanzigePush = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    const { alias, text, type, senderRealName, replyToRealName, replyToAlias, replierRealName, mentionedNames, excludeNames } = request.data || {};
    if (!alias || !text) return { success: false, error: 'missing params' };

    // 한글 조사 유틸 (이/가)
    const _korIga = (name) => {
      const code = name.charCodeAt(name.length - 1);
      return (code >= 0xAC00 && code <= 0xD7A3 && (code - 0xAC00) % 28 !== 0) ? '이' : '가';
    };

    // fcmTokens 전체 로드 (세 케이스 공통 활용)
    const tokenSnap = await db.ref('jmt/fcmTokens').once('value');
    const allEntries = Object.values(tokenSnap.val() || {}).filter(v => v.token && v.name);

    // @멘션 — 언급된 멤버에게만 타겟 푸시 ("유지원이 나를 언급했어요" 형태)
    if (type === 'mention') {
      if (!mentionedNames || !mentionedNames.length) return { success: false, error: 'no mentionedNames' };
      const targetNames = new Set(mentionedNames);
      if (senderRealName) targetNames.delete(senderRealName);
      const targetEntries = allEntries.filter(v => targetNames.has(v.name));
      if (targetEntries.length) {
        const snippet = text.length > 50 ? text.slice(0, 50) + '…' : text;
        const senderLabel = senderRealName || alias;
        const mentionBody = `${senderLabel}${_korIga(senderLabel)} 나를 언급했어요\n${snippet}`;
        await sendBanzigePushWithBadge(targetEntries, `📢 자미톡 — ${alias}`, mentionBody, { subScreen: 'banzige' });
      }
      return { success: true, sent: targetEntries.length };
    }

    // 답글 — 대상자에게만 타겟 푸시
    if (type === 'reply') {
      if (!replyToRealName) return { success: false, error: 'missing replyToRealName' };
      const targetNames = new Set([replyToRealName]);
      // 가명이 실제 멤버 이름이라면 그 멤버도 포함
      if (replyToAlias && replyToAlias !== replyToRealName && allEntries.some(v => v.name === replyToAlias)) {
        targetNames.add(replyToAlias);
      }
      // 답글 보낸 사람 본인은 제외
      if (replierRealName) targetNames.delete(replierRealName);
      const targetEntries = allEntries.filter(v => targetNames.has(v.name));
      if (targetEntries.length) {
        await sendBanzigePushWithBadge(targetEntries, `↩ 자미톡 — ${alias}`, text, { subScreen: 'banzige' });
      }
      return { success: true, sent: targetEntries.length };
    }

    // 채팅 메시지(start 타입) — 멤버별 2분 쿨다운
    const isChat = type === 'start' && !text.includes('사진을 보냈어요');
    if (isChat && senderRealName) {
      const cooldownRef = db.ref(`jmt/banzigePushCooldown/${senderRealName}`);
      const snap = await cooldownRef.once('value');
      const lastTs = snap.val() || 0;
      if (lastTs && Date.now() - lastTs < 2 * 60 * 1000) {
        return { success: false, skipped: 'cooldown' };
      }
      await cooldownRef.set(Date.now());
    }

    const titleMap = {
      start:    `🗣️ 자미톡 — ${alias}`,
      guessing: `🎯 자미톡 — ${alias}`,
      reveal:   `🔓 자미톡 — ${alias}`,
      manual:   `🗣️ 자미톡 — ${alias}`,
    };
    const title = titleMap[type] || `🗣️ 자미톡 — ${alias}`;
    // 멘션 대상은 전체 푸시에서 제외 (별도 멘션 푸시로 수신)
    let targetEntries = allEntries;
    if (excludeNames && excludeNames.length) {
      const excludeSet = new Set(excludeNames);
      targetEntries = targetEntries.filter(e => !excludeSet.has(e.name));
    }
    if (targetEntries.length) {
      await sendBanzigePushWithBadge(targetEntries, title, text, { subScreen: 'banzige' });
    }
    return { success: true, sent: targetEntries.length };
  }
);

// ══ 7. 대진 생성/수정 감지 — DB 트리거 ═══════════════════════════
exports.notifyBracketUpdate = onValueWritten(
  { ref: 'jmt/activeState', region: 'asia-southeast1' },
  async (event) => {
    const after = event.data.after.val();
    if (!after) return;

    let parsed;
    try { parsed = typeof after === 'string' ? JSON.parse(after) : after; }
    catch (e) { return; }

    if (parsed.finished) return;
    if (!parsed.tournaments) return;

    const hasTournament = parsed.tournaments.mixed || parsed.tournaments.mens || parsed.tournaments.womens;
    if (!hasTournament) return;

    const before = event.data.before.val();
    let parsedBefore = null;
    try { parsedBefore = before ? (typeof before === 'string' ? JSON.parse(before) : before) : null; }
    catch (e) {}

    const hadTournament = parsedBefore && parsedBefore.tournaments &&
      (parsedBefore.tournaments.mixed || parsedBefore.tournaments.mens || parsedBefore.tournaments.womens);

    // 참가자 이름 추출 (selectedIds → 멤버이름 + guests)
    const participantNames = [];
    if (parsed.selectedIds && parsed.selectedIds.length) {
      const membersSnap = await db.ref('jmt/members').once('value');
      const members = Object.values(membersSnap.val() || {});
      const selectedSet = new Set(parsed.selectedIds.map(String));
      members.filter(m => selectedSet.has(String(m.id))).forEach(m => { if (m.name) participantNames.push(m.name); });
    }
    if (parsed.guests && parsed.guests.length) {
      parsed.guests.forEach(g => { if (g.name) participantNames.push(g.name); });
    }
    const tokens = participantNames.length ? await getTokensByNames(participantNames) : await getAllTokens();
    if (!hadTournament) {
      await sendPush(tokens, '🎾 대진표가 생성되었습니다!', '경기 진행 탭에서 이번 주 대진표를 확인하세요.', 'setup');
    } else {
      await sendPush(tokens, '🔄 대진표가 수정되었습니다!', '경기 진행 탭에서 변경된 대진표를 확인하세요.', 'setup');
    }
  }
);

// ══ 사다리 복식 대진표 생성 알림 ════════════════════════════════════
exports.notifyLadderBracket = onValueWritten(
  { ref: 'jmt/ladderState', region: 'asia-southeast1' },
  async (event) => {
    const after = event.data.after.val();
    if (!after) return; // 대회 종료 — 알림 없음

    let parsed;
    try { parsed = typeof after === 'string' ? JSON.parse(after) : after; }
    catch (e) { return; }

    if (!parsed.tournaments_ladder) return; // 대진표 없는 상태 (사다리 게임만)

    // 이미 대진표 있었으면 재구성 — 중복 알림 방지
    const before = event.data.before.val();
    if (before) {
      try {
        const pb = typeof before === 'string' ? JSON.parse(before) : before;
        if (pb && pb.tournaments_ladder) return;
      } catch (e) {}
    }

    // 참가자 이름 (사다리 게임 스냅샷)
    const participants = parsed.ladderGameSnapshot && parsed.ladderGameSnapshot.participants;
    if (!participants || !participants.length) return;

    const tokens = await getTokensByNames(participants);
    if (!tokens.length) return;
    const nameStr = participants.length <= 6 ? participants.join(', ') : `${participants.slice(0, 6).join(', ')} 외 ${participants.length - 6}명`;
    await sendPush(tokens, '🪜 사다리 복식 대진표 생성!', `${nameStr} — 경기 진행 탭에서 확인하세요.`, 'setup');
  }
);

// ══ 12. 관리자 수동 출첵 압박 푸시 (callable) ══════════════════════
exports.sendCheckinPressure = onCall(
  { region: 'asia-southeast1' },
  async () => {
    const pollStateSnap = await db.ref('jmt/pollState').once('value');
    const pollState = pollStateSnap.val();
    if (!pollState || pollState.status !== 'open') return { success: false, error: '출첵이 열려있지 않습니다.' };

    const weekId = pollState.weekId;
    const pollSnap = await db.ref(`jmt/poll/${weekId}/votes`).once('value');
    const voted = new Set(Object.values(pollSnap.val() || {}).map(v => v.name));

    const membersSnap = await db.ref('jmt/members').once('value');
    const unvotedNames = Object.values(membersSnap.val() || {}).map(m => m.name).filter(n => !voted.has(n));
    if (!unvotedNames.length) return { success: true, sent: 0 };

    const tokens = await getTokensByNames(unvotedNames);
    if (tokens.length) {
      await sendPush(tokens, '📣 출첵하세요!', '아직 이번 주 출첵을 안 하셨어요. 지금 바로 참석 여부를 알려주세요!', 'checkin');
    }
    return { success: true, sent: tokens.length, unvoted: unvotedNames };
  }
);

// ── 유틸: 정회원 이름 목록 ────────────────────────────────────────
async function getMemberNames() {
  const snap = await db.ref('jmt/members').once('value');
  const data = snap.val();
  if (!data) return [];
  return Object.values(data).map(m => m.name).filter(Boolean);
}

// ══ 13. 개인 랭킹 1~3위 변동 감지 ════════════════════════════════
function computePlayerTop3(stats, memberNames) {
  const effWr = (w, d, l) => { const t = w+(d||0)+l; return t ? ((w+(d||0)*0.5)/t*100) : 0; };
  const players = Object.entries(stats || {})
    .map(([name, v]) => ({ name, wins: v.wins||0, draws: v.draws||0, losses: v.losses||0 }))
    .filter(p => p.wins+p.draws+p.losses >= 1 && memberNames.includes(p.name));
  const avg = players.reduce((s, p) => s+p.wins+p.draws+p.losses, 0) / (players.length||1);
  const thresh = avg * 0.5;
  return players
    .filter(p => p.wins+p.draws+p.losses >= thresh)
    .sort((a, b) => effWr(b.wins,b.draws,b.losses) - effWr(a.wins,a.draws,a.losses) || b.wins-a.wins)
    .slice(0, 3).map(p => p.name);
}

exports.notifyPlayerRankingChange = onValueWritten(
  { ref: 'jmt/playerStats/{year}', region: 'asia-southeast1' },
  async (event) => {
    const year = event.params.year;
    if (year !== new Date().getFullYear().toString()) return;
    const memberNames = await getMemberNames();
    const before = computePlayerTop3(event.data.before.val(), memberNames);
    const after  = computePlayerTop3(event.data.after.val(), memberNames);
    const medals = ['🥇','🥈','🥉'];
    const changes = [];
    for (let i = 0; i < 3; i++) {
      if (after[i] && after[i] !== before[i]) {
        const action = !before[i] ? '진입' : before.includes(after[i]) ? '탈환' : '진입';
        changes.push(`${after[i]} ${i+1}위 ${action}`);
      }
    }
    if (!changes.length) return;
    const tokens = await getAllTokens();
    await sendPush(tokens, `${medals[changes[0].includes('1위')?0:changes[0].includes('2위')?1:2]} 개인 랭킹 변동!`, changes.join(' · '), 'history');
  }
);

// ══ 14. 팀페어 랭킹 1~3위 변동 감지 ══════════════════════════════
function computePairTop3(stats, memberNames) {
  const effWr = (w, d, l) => { const t = w+(d||0)+l; return t ? ((w+(d||0)*0.5)/t*100) : 0; };
  const pairs = Object.entries(stats || {})
    .map(([key, v]) => ({ key, wins: v.wins||0, draws: v.draws||0, losses: v.losses||0, nickname: v.nickname, players: v.players||key.split('_') }))
    .filter(p => p.wins+p.draws+p.losses >= 1 && p.players.every(n => memberNames.includes(n)));
  const avg = pairs.reduce((s, p) => s+p.wins+p.draws+p.losses, 0) / (pairs.length||1);
  const thresh = avg * 0.5;
  return pairs
    .filter(p => p.wins+p.draws+p.losses >= thresh)
    .sort((a, b) => effWr(b.wins,b.draws,b.losses) - effWr(a.wins,a.draws,a.losses) || b.wins-a.wins)
    .slice(0, 3)
    .map(p => p.nickname || ((p.players[0]||'?')[0]+(p.players[1]||'?')[0]+'팀'));
}

exports.notifyPairRankingChange = onValueWritten(
  { ref: 'jmt/pairStats/{year}', region: 'asia-southeast1' },
  async (event) => {
    const year = event.params.year;
    if (year !== new Date().getFullYear().toString()) return;
    const memberNames = await getMemberNames();
    const before = computePairTop3(event.data.before.val(), memberNames);
    const after  = computePairTop3(event.data.after.val(), memberNames);
    const medals = ['🥇','🥈','🥉'];
    const changes = [];
    for (let i = 0; i < 3; i++) {
      if (after[i] && after[i] !== before[i]) {
        const action = !before[i] ? '진입' : before.includes(after[i]) ? '탈환' : '진입';
        changes.push(`${after[i]} ${i+1}위 ${action}`);
      }
    }
    if (!changes.length) return;
    const tokens = await getAllTokens();
    await sendPush(tokens, `${medals[changes[0].includes('1위')?0:changes[0].includes('2위')?1:2]} 팀페어 랭킹 변동!`, changes.join(' · '), 'history');
  }
);

// ══ 15. 새 대회 개막 감지 ═════════════════════════════════════════
exports.notifyTournamentChange = onValueWritten(
  { ref: 'jmt/atpData', region: 'asia-southeast1' },
  async (event) => {
    const tBefore = event.data.before.val()?.tournamentInfo;
    const tAfter  = event.data.after.val()?.tournamentInfo;
    if (!tAfter || !tAfter.name) return;
    const idChanged   = !tBefore || tBefore.id   !== tAfter.id;
    const tierChanged = !tBefore || tBefore.tier  !== tAfter.tier;
    if (!idChanged && !tierChanged) return; // 대회/티어 변경 없음
    const tier = tAfter.tier || 'atp250';
    const tierLabel = tier === 'grandslam' ? ' [Grand Slam 🏆]' : tier === 'atp1000' ? ' [ATP 1000 ⭐]' : '';
    const name = tAfter.displayName || tAfter.name;
    const tokens = await getAllTokens();
    const msg = idChanged
      ? `${name}${tierLabel} 대회가 시작되었습니다.`
      : `${name}${tierLabel} 대회 정보가 업데이트되었습니다.`;
    await sendPush(tokens, '🎾 새 대회 개막!', msg, 'atp');
  }
);

// ══ 16. 관심선수 경기 시작 감지 ══════════════════════════════════
exports.notifyFavPlayerMatch = onValueWritten(
  { ref: 'jmt/atpData', region: 'asia-southeast1' },
  async (event) => {
    const before = event.data.before.val();
    const after  = event.data.after.val();
    if (!after) return;

    const matchesBefore = (before?.matches || []).reduce((m, x) => { m[x.id] = x; return m; }, {});
    const justStarted = (after.matches || []).filter(m =>
      m.status === 'STATUS_IN_PROGRESS' &&
      (!matchesBefore[m.id] || matchesBefore[m.id].status !== 'STATUS_IN_PROGRESS')
    );
    if (!justStarted.length) return;

    const favSnap = await db.ref('jmt/favPlayers').once('value');
    const favData = favSnap.val() || {};
    const fcmSnap = await db.ref('jmt/fcmTokens').once('value');
    const fcmData = fcmSnap.val() || {};

    for (const [memberName, favList] of Object.entries(favData)) {
      if (!Array.isArray(favList) || !favList.length) continue;
      const favNames = favList.map(f => f.name.toLowerCase());
      const myMatches = justStarted.filter(m =>
        favNames.some(fn => (m.player1Name||'').toLowerCase().includes(fn) || (m.player2Name||'').toLowerCase().includes(fn))
      );
      if (!myMatches.length) continue;
      const tokens = Object.values(fcmData).filter(v => v.name === memberName && v.token).map(v => v.token);
      if (!tokens.length) continue;
      const body = myMatches.map(m => `${m.player1Name} vs ${m.player2Name} 경기가 시작되었습니다.`).join(' ');
      await sendPush(tokens, '⭐ 관심선수 경기 시작!', body, 'atp');
    }
  }
);

// ── ATP 랭킹 fetch 공통 함수 ──────────────────────────────────────
async function _fetchAndSaveAtpRankings() {
  const url = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings?limit=100';
  const res  = await fetch(url);
  const json = await res.json();
  const entries = (json.rankings && json.rankings[0] && json.rankings[0].ranks) || [];
  const players = entries.map(e => ({
    rank:    e.current || 0,
    name:    e.athlete ? `${e.athlete.firstName || ''} ${e.athlete.lastName || ''}`.trim() : '',
    country: e.athlete?.flag?.alt || e.athlete?.flag?.href || '',
  })).filter(p => p.name && p.rank);
  if (!players.length) { console.warn('fetchAtpRankings: empty result'); return false; }
  await db.ref('jmt/atpRankings').set({ players, updatedAt: new Date().toISOString() });
  console.log(`fetchAtpRankings: saved ${players.length} players`);
  return true;
}

// ══ ATP 세계 랭킹 — 매주 월요일 오전 6시 정기 업데이트 ══════════
exports.fetchAtpRankings = onSchedule(
  { schedule: '0 6 * * 1', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => {
    try { await _fetchAndSaveAtpRankings(); }
    catch (e) { console.error('fetchAtpRankings error:', e); }
  }
);

// ══ 주간 MVP 시상 — 매주 토요일 오후 12:30 KST ══════════════════════

async function _runWeeklyMvp(isDryRun = false) {
  const now = Date.now();

  // ── 날짜 범위 계산 ───────────────────────────────────────────────
  // 이번 주 토요일 00:00 KST
  const todayKST = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  todayKST.setHours(0, 0, 0, 0);
  const thisWeekStart = todayKST.toISOString().split('T')[0];
  // 2주 전 토요일 00:00 KST
  const twoWeeksAgo = new Date(todayKST); twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);
  const twoWeeksStart = twoWeeksAgo.toISOString().split('T')[0];
  // 3주 전 (개근왕용)
  const threeWeeksAgo = new Date(todayKST); threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);

  // ── 경기 데이터 로드 ─────────────────────────────────────────────
  const snap = await db.ref('jmt/matches').orderByChild('date').limitToLast(500).once('value');
  const allRaw = snap.val() || {};
  const toArr = v => Array.isArray(v) ? v : Object.values(v || {});

  // 이번 주 경기 (source=daily, winner 확정)
  const thisWeekMatches = Object.values(allRaw).filter(m =>
    m.source === 'daily' && m.sets && m.winner !== undefined && m.winner !== -1
    && (m.date || '') >= thisWeekStart
  );

  // 최소 발송 조건 확인
  const thisWeekPlayers = new Set();
  thisWeekMatches.forEach(m => {
    toArr(m.team0).forEach(p => thisWeekPlayers.add(p));
    toArr(m.team1).forEach(p => thisWeekPlayers.add(p));
  });
  if (thisWeekMatches.length < 5 || thisWeekPlayers.size < 4) {
    return `발송 생략 — 이번 주 경기 ${thisWeekMatches.length}개, 참여 ${thisWeekPlayers.size}명 (최소 5경기/4명 필요)`;
  }

  // 2주치 경기
  const twoWeekMatches = Object.values(allRaw).filter(m =>
    m.source === 'daily' && m.sets && m.winner !== undefined && m.winner !== -1
    && (m.date || '') >= twoWeeksStart
  );

  // 시즌 전체 경기 (개인 누적 승률용)
  const year = new Date().getFullYear().toString();
  const statsSnap = await db.ref(`jmt/playerStats/${year}`).once('value');
  const seasonStats = statsSnap.val() || {};

  // ── 선수별 이번 주 집계 ──────────────────────────────────────────
  const weeklyStats = {}; // name → { wins, total }
  const getWS = n => (weeklyStats[n] = weeklyStats[n] || { wins: 0, total: 0 });
  thisWeekMatches.forEach(m => {
    const t0 = toArr(m.team0), t1 = toArr(m.team1);
    const winners = m.winner === 0 ? t0 : t1;
    const losers  = m.winner === 0 ? t1 : t0;
    winners.forEach(p => { getWS(p).wins++; getWS(p).total++; });
    losers.forEach(p => { getWS(p).total++; });
  });

  // ── 🥇 MVP — 이번 주 승률 1위 (최소 2경기) ──────────────────────
  const mvpCandidates = Object.entries(weeklyStats)
    .filter(([, s]) => s.total >= 2)
    .map(([name, s]) => ({ name, rate: s.wins / s.total, wins: s.wins, total: s.total }))
    .sort((a, b) => b.rate - a.rate || b.wins - a.wins || b.total - a.total);
  const mvpRate = mvpCandidates[0]?.rate;
  const mvpList = mvpCandidates.filter(p => p.rate === mvpRate && p.wins === mvpCandidates[0].wins);

  // ── 🤝 최강 듀오 — 2주 합산 (최소 3경기 함께) ───────────────────
  const pairStats = {}; // 'A+B' → { wins, total }
  const getPS = k => (pairStats[k] = pairStats[k] || { wins: 0, total: 0, names: [] });
  twoWeekMatches.forEach(m => {
    const t0 = toArr(m.team0), t1 = toArr(m.team1);
    [[t0, m.winner === 0], [t1, m.winner === 1]].forEach(([team, won]) => {
      if (team.length === 2) {
        const key = [team[0], team[1]].sort().join('+');
        const ps = getPS(key);
        if (!ps.names.length) ps.names = [team[0], team[1]].sort();
        ps.total++;
        if (won) ps.wins++;
      }
    });
  });
  const duoCandidates = Object.entries(pairStats)
    .filter(([, s]) => s.total >= 3)
    .map(([, s]) => ({ ...s, rate: s.wins / s.total }))
    .sort((a, b) => b.rate - a.rate || b.wins - a.wins || b.total - a.total);
  const duoRate = duoCandidates[0]?.rate;
  const duoList = duoRate != null
    ? duoCandidates.filter(d => d.rate === duoRate && d.wins === duoCandidates[0].wins)
    : [];

  // ── 🔥 뒤집기 왕 — 타이브레이크 승리 (7-6 또는 6-7 세트 포함 + 승리) ──
  const tbWins = {}; // name → count
  thisWeekMatches.forEach(m => {
    const sets = toArr(m.sets);
    const hasTB = sets.some(s => {
      const arr = toArr(s);
      return (arr[0] === 7 && arr[1] === 6) || (arr[0] === 6 && arr[1] === 7);
    });
    if (!hasTB) return;
    const winners = m.winner === 0 ? toArr(m.team0) : toArr(m.team1);
    winners.forEach(p => { tbWins[p] = (tbWins[p] || 0) + 1; });
  });
  const tbMax = Math.max(0, ...Object.values(tbWins));
  const tbList = tbMax > 0
    ? Object.entries(tbWins).filter(([, c]) => c === tbMax).map(([name, count]) => ({ name, count }))
    : [];

  // ── 🌟 다크호스 — 시즌 평균 대비 이번 주 상승폭 최대 ───────────
  const darkCandidates = Object.entries(weeklyStats)
    .filter(([name, s]) => {
      const ss = seasonStats[name];
      if (!ss) return false;
      const sTotal = (ss.wins || 0) + (ss.losses || 0) + (ss.draws || 0);
      return s.total >= 2 && sTotal >= 5;
    })
    .map(([name, s]) => {
      const ss = seasonStats[name];
      const sTotal = (ss.wins || 0) + (ss.losses || 0) + (ss.draws || 0);
      const seasonRate = sTotal ? (ss.wins || 0) / sTotal : 0;
      const weekRate = s.wins / s.total;
      return { name, weekRate, seasonRate, diff: weekRate - seasonRate, weekW: s.wins, weekT: s.total };
    })
    .filter(d => d.diff > 0)
    .sort((a, b) => b.diff - a.diff || b.weekRate - a.weekRate);
  const darkMax = darkCandidates[0]?.diff;
  const darkList = darkMax != null
    ? darkCandidates.filter(d => Math.abs(d.diff - darkMax) < 0.001)
    : [];

  // ── 🏃 개근왕 — 최근 N주 연속 참석 (최소 3주) ──────────────────
  // 주차 경계: 토요일 기준 7일 단위
  const getWeekKey = dateStr => {
    const d = new Date(dateStr + 'T00:00:00+09:00');
    const sat = new Date(d); sat.setDate(d.getDate() - ((d.getDay() + 1) % 7));
    return sat.toISOString().split('T')[0];
  };
  const playerWeeks = {}; // name → Set of weekKeys
  Object.values(allRaw).filter(m => m.source === 'daily' && m.date && new Date(m.date) >= threeWeeksAgo)
    .forEach(m => {
      const wk = getWeekKey(m.date);
      toArr(m.team0).concat(toArr(m.team1)).forEach(p => {
        if (!playerWeeks[p]) playerWeeks[p] = new Set();
        playerWeeks[p].add(wk);
      });
    });
  // 이번 주 포함 연속 주 수 계산
  const thisWeekKey = getWeekKey(thisWeekStart);
  const attendList = [];
  for (const [name, weeks] of Object.entries(playerWeeks)) {
    if (!weeks.has(thisWeekKey)) continue; // 이번 주 불참이면 제외
    let streak = 0;
    let checkDate = new Date(todayKST);
    while (true) {
      const wk = getWeekKey(checkDate.toISOString().split('T')[0]);
      if (!weeks.has(wk)) break;
      streak++;
      checkDate.setDate(checkDate.getDate() - 7);
      if (streak > 52) break; // 안전장치
    }
    if (streak >= 3) attendList.push({ name, streak });
  }
  attendList.sort((a, b) => b.streak - a.streak || a.name.localeCompare(b.name));
  const maxStreak = attendList[0]?.streak;
  const attendWinners = maxStreak ? attendList.filter(a => a.streak === maxStreak) : [];

  // ── 메시지 생성 ─────────────────────────────────────────────────
  const todayStr = `${todayKST.getMonth() + 1}.${todayKST.getDate()}`;
  const lines = [
    `[ 이번 주 경기 결과 ] ${todayStr}`,
    ``,
    `이번 주 총 ${thisWeekMatches.length}경기 · 참여 ${thisWeekPlayers.size}명`,
    ``,
  ];

  // 🥇 MVP
  lines.push(`🥇 MVP`);
  mvpList.forEach(p => {
    lines.push(`  ${p.name} · ${p.wins}전 ${p.wins}승${p.total > p.wins ? ` ${p.total - p.wins}패` : ''} (${Math.round(p.rate * 100)}%)`);
  });
  if (mvpList.length > 1) lines.push(`  ※ 공동 수상`);

  // 🤝 최강 듀오
  lines.push(``, `🤝 최강 듀오 (2주 합산)`);
  if (duoList.length) {
    duoList.forEach(d => {
      lines.push(`  ${d.names.join(' + ')} · ${d.wins}승 ${d.total - d.wins}패 (${Math.round(d.rate * 100)}%)`);
    });
    if (duoList.length > 1) lines.push(`  ※ 공동 수상`);
  } else {
    lines.push(`  해당 없음 (2주간 함께 3경기 이상 출전 팀 없음)`);
  }

  // 🔥 뒤집기 왕
  if (tbList.length) {
    lines.push(``, `🔥 뒤집기 왕`);
    tbList.forEach(p => {
      lines.push(`  ${p.name} · 타이브레이크 ${p.count}승`);
    });
    if (tbList.length > 1) lines.push(`  ※ 공동 수상`);
  }

  // 🌟 다크호스
  if (darkList.length) {
    lines.push(``, `🌟 다크호스`);
    darkList.forEach(d => {
      lines.push(`  ${d.name} · 시즌 ${Math.round(d.seasonRate * 100)}% → 이번 주 ${Math.round(d.weekRate * 100)}% (+${Math.round(d.diff * 100)}%p)`);
    });
    if (darkList.length > 1) lines.push(`  ※ 공동 수상`);
  }

  // 🏃 개근왕
  if (attendWinners.length) {
    lines.push(``, `🏃 개근왕`);
    attendWinners.forEach(a => {
      lines.push(`  ${a.name} · ${a.streak}주 연속 개근${a.streak >= 5 ? ' 🔥' : ''}`);
    });
    if (attendWinners.length > 1) lines.push(`  ※ 공동 수상`);
  }

  // ── 발송 ────────────────────────────────────────────────────────
  if (!isDryRun) {
    // 말풍선 ① — 예고 + 전체 푸시
    await _postBotMsg({ text: '이번 주 경기 결과를 발표하겠습니다 🏆' });
    const allTokens = await getAllTokens();
    await sendPush(allTokens, '🏆 이번 주 경기 결과 발표', '자미터 채팅방을 확인하세요!', 'banzige');
    // 3초 딜레이 후 말풍선 ②
    await new Promise(r => setTimeout(r, 3000));
    await _postBotMsg({ text: lines.join('\n') });
  }

  return `완료 — ${lines.join('\n')}`;
}

// ── 스케줄 함수 (매주 토요일 12:30 KST) ─────────────────────────
exports.weeklyMvpReport = onSchedule(
  { schedule: '30 12 * * 6', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => {
    try { await _runWeeklyMvp(); }
    catch (e) { console.error('weeklyMvpReport error:', e); }
  }
);

// ── 테스트 callable (관리자 전용) ────────────────────────────────
exports.testWeeklyMvp = onCall({ region: 'asia-southeast1' }, async (req) => {
  if (!_BOT_MANAGERS.includes(req.data.senderName || '')) throw new Error('권한 없음');
  const result = await _runWeeklyMvp(true); // isDryRun=true → 발송 안 함, 결과만 반환
  return { result };
});

const TRANSLATE_URL = 'https://script.google.com/macros/s/AKfycbwfF6W1xll0ooa0g4Gb57dnVnknXbZxKM1au3YlY52oGsrDIqHPty4q6fh6mWW0SXI00w/exec';

async function translateTexts(texts) {
  try {
    const encoded = encodeURIComponent(JSON.stringify(texts));
    const res  = await fetch(`${TRANSLATE_URL}?texts=${encoded}`);
    const json = await res.json();
    const result = json.translated;
    if (!result || result.length === 0) return null; // 번역 실패 시 null
    return result;
  } catch(e) {
    console.warn('translateTexts error:', e.message);
    return null; // 번역 실패 시 null
  }
}

// ══ 머든 정하기 푸시 ══════════════════════════════════════════════

// 날짜 포맷 헬퍼
function fmtDate(dateStr) {
  const weekDays = ['일','월','화','수','목','금','토'];
  const o = new Date(dateStr + 'T00:00:00');
  return `${o.getMonth()+1}월 ${o.getDate()}일(${weekDays[o.getDay()]})`;
}

// 투표 생성 시 전체 알림
exports.notifyMeetingPollOpen = onValueCreated(
  { ref: 'jmt/meetingPolls/{pollId}/status', region: 'asia-southeast1' },
  async (event) => {
    if (event.data.val() !== 'open') return;
    const pollId = event.params.pollId;
    const pollSnap = await db.ref(`jmt/meetingPolls/${pollId}`).once('value');
    const poll = pollSnap.val();
    if (!poll) return;
    const tokens = await getAllTokens();
    await sendPush(tokens, '🗳️ 머든 정하기 투표 오픈!', `"${poll.title||'머든 정하기'}" 투표에 참여해 주세요!`, 'setup');
  }
);

// 투표 마감 시 전체 알림
exports.notifyMeetingPollClosed = onValueWritten(
  { ref: 'jmt/meetingPolls/{pollId}/status', region: 'asia-southeast1' },
  async (event) => {
    if (event.data.after.val() !== 'closed') return;
    const pollId = event.params.pollId;
    const pollSnap = await db.ref(`jmt/meetingPolls/${pollId}`).once('value');
    const poll = pollSnap.val();
    if (!poll) return;

    const title = poll.title || '머든 정하기';
    const votes = poll.votes || {};
    const parts = [];

    if (poll.type === 'date' || poll.type === 'both') {
      const dateCounts = {};
      (poll.dates || []).forEach(d => { dateCounts[d] = 0; });
      Object.values(votes).forEach(v => {
        if (!v.dates) return;
        Object.keys(v.dates).forEach(dk => { if (v.dates[dk] && dateCounts.hasOwnProperty(dk)) dateCounts[dk]++; });
      });
      const mx = Math.max(...Object.values(dateCounts), 0);
      const winners = Object.entries(dateCounts).filter(([,c]) => c === mx && mx > 0).map(([d]) => d).sort();
      if (winners.length) parts.push(winners.map(fmtDate).join(', '));
    }
    if (poll.type === 'content' || poll.type === 'both') {
      const contentCounts = {};
      (poll.contents || []).forEach((_, i) => { contentCounts[i] = 0; });
      Object.values(votes).forEach(v => {
        if (!v.contents) return;
        Object.keys(v.contents).forEach(i => { const n=Number(i); if(v.contents[i]&&contentCounts.hasOwnProperty(n)) contentCounts[n]++; });
      });
      const mx = Math.max(...Object.values(contentCounts), 0);
      const winners = Object.entries(contentCounts).filter(([,c]) => c === mx && mx > 0).map(([i]) => (poll.contents||[])[Number(i)]).filter(Boolean);
      if (winners.length) parts.push(winners.join(', '));
    }

    const detail = parts.filter(Boolean).join(' · ');
    const body = detail
      ? `"${title}"가 ${detail}로 결정되었습니다. 일정표에 표기해 주세요!`
      : `"${title}" 투표가 마감되었습니다.`;

    const tokens = await getAllTokens();
    await sendPush(tokens, '🗳️ 머든 정하기 확정!', body, 'setup');
  }
);

// 관리자 수동 독촉 푸시
exports.notifyMeetingPollNudge = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    const { pollId } = request.data || {};
    if (!pollId) throw new Error('pollId가 필요합니다.');
    const pollSnap = await db.ref(`jmt/meetingPolls/${pollId}`).once('value');
    const poll = pollSnap.val();
    if (!poll || poll.status !== 'open') throw new Error('진행 중인 투표가 없습니다.');

    const votes = poll.votes || {};
    const voterNames = Object.values(votes).map(v => v.name).filter(Boolean);

    const membersSnap = await db.ref('jmt/members').once('value');
    const members = membersSnap.val() ? Object.values(membersSnap.val()).map(m => m.name) : [];
    const nonVoters = members.filter(n => !voterNames.includes(n));

    if (!nonVoters.length) return { message: '모든 멤버가 투표에 참여했습니다!' };

    const tokens = await getTokensByNames(nonVoters);
    if (!tokens.length) return { message: '독촉 알림을 보낼 대상이 없습니다.' };

    await sendPush(tokens, '🔔 머든 정하기 투표 미참여 알림', `"${poll.title||'머든 정하기'}" 투표에 아직 참여하지 않으셨습니다. 지금 참여해 주세요!`, 'setup');
    return { message: `${nonVoters.length}명에게 독촉 알림을 보냈습니다.` };
  }
);

// 자동 독촉 (하루 1회, 진행 중인 모든 투표)
exports.notifyMeetingPollAutoNudge = onSchedule(
  { schedule: '0 12 * * *', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => {
    const pollsSnap = await db.ref('jmt/meetingPolls').once('value');
    const polls = pollsSnap.val() || {};
    const membersSnap = await db.ref('jmt/members').once('value');
    const members = membersSnap.val() ? Object.values(membersSnap.val()).map(m => m.name) : [];

    for (const poll of Object.values(polls)) {
      if (!poll || poll.status !== 'open') continue;
      const votes = poll.votes || {};
      const voterNames = Object.values(votes).map(v => v.name).filter(Boolean);
      const nonVoters = members.filter(n => !voterNames.includes(n));
      if (!nonVoters.length) continue;
      const tokens = await getTokensByNames(nonVoters);
      if (!tokens.length) continue;
      await sendPush(tokens, '🗳️ 머든 정하기 투표 미참여 알림', `"${poll.title||'머든 정하기'}" 투표에 참여해 주세요!`, 'setup');
    }
  }
);

// ══ 모임 투표 마감 시간 자동 처리 (30분마다) ════════════════════
exports.checkMeetingPollDeadline = onSchedule(
  { schedule: '*/30 * * * *', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => {
    const pollsSnap = await db.ref('jmt/meetingPolls').once('value');
    const polls = pollsSnap.val() || {};
    const now = new Date();
    for (const [pollId, poll] of Object.entries(polls)) {
      if (!poll || poll.status !== 'open' || !poll.closesAt) continue;
      if (new Date(poll.closesAt) > now) continue;
      const closedAt = now.toISOString();
      await db.ref(`jmt/meetingPolls/${pollId}/status`).set('closed');
      await db.ref(`jmt/meetingPolls/${pollId}/closedAt`).set(closedAt);
    }
  }
);

// ══ 모임 투표 댓글 알림 — DB 트리거 (전체) ══════════════════════
exports.notifyMeetingPollComment = onValueCreated(
  { ref: 'jmt/meetingPolls/{pollId}/comments/{commentId}', region: 'asia-southeast1' },
  async (event) => {
    const comment = event.data.val();
    if (!comment) return;
    const { author, text } = comment;
    if (!author) return;
    const snap = await db.ref('jmt/fcmTokens').once('value');
    const data = snap.val() || {};
    const otherTokens = Object.values(data)
      .filter(v => v.name !== author && v.token)
      .map(v => v.token);
    await sendPush(otherTokens, `💬 ${author}님이 댓글을 달았습니다`, text, 'setup', event.params.commentId);
  }
);

// ══ 모임 투표 답글 알림 — DB 트리거 (댓글 작성자에게만) ══════════
exports.notifyMeetingPollReply = onValueCreated(
  { ref: 'jmt/meetingPolls/{pollId}/comments/{commentId}/replies/{replyId}', region: 'asia-southeast1' },
  async (event) => {
    const reply = event.data.val();
    if (!reply) return;
    const { author, text } = reply;
    if (!author) return;
    const commentSnap = await db.ref(`jmt/meetingPolls/${event.params.pollId}/comments/${event.params.commentId}`).once('value');
    const comment = commentSnap.val();
    if (!comment || !comment.author || comment.author === author) return;
    const tokens = await getTokensByNames([comment.author]);
    await sendPush(tokens, `💬 ${author}님이 답글을 달았습니다`, text, 'setup', event.params.commentId);
  }
);

// ══ 모임 최종결정 알림 ════════════════════════════════════════════
exports.notifyMeetingPollFinalDecision = onValueWritten(
  { ref: 'jmt/meetingPolls/{pollId}/finalDecision', region: 'asia-southeast1' },
  async (event) => {
    const fd = event.data.after.val();
    if (!fd) return;

    const pollSnap = await db.ref(`jmt/meetingPolls/${event.params.pollId}`).once('value');
    const poll = pollSnap.val();
    if (!poll) return;

    const pollTitle = poll.title || '모임 정하기';
    const parts = [];

    // 날짜 결정
    if (fd.memberDateKey && poll.memberDates && poll.memberDates[fd.memberDateKey]) {
      parts.push(fmtDate(poll.memberDates[fd.memberDateKey].date));
    } else if (fd.date) {
      parts.push(fmtDate(fd.date));
    }

    // 내용 결정
    if (fd.memberContentKey && poll.memberContents && poll.memberContents[fd.memberContentKey]) {
      parts.push(poll.memberContents[fd.memberContentKey].text || '');
    } else if (fd.contentIdx !== undefined && fd.contentIdx !== null) {
      parts.push((poll.contents || [])[fd.contentIdx] || '');
    }

    const detail = parts.filter(Boolean).join(' · ');
    const body = detail
      ? `"${pollTitle}"가 ${detail}로 결정되었습니다. 일정표에 표기해 주세요!`
      : `"${pollTitle}"가 확정되었습니다. 일정표에 표기해 주세요!`;

    const tokens = await getAllTokens();
    await sendPush(tokens, '📅 모임 날짜/내용 확정!', body, 'setup');
  }
);

// ══ ATP 뉴스 자동 수집 (12시간마다) ═══════════════════════════════
exports.fetchAtpNews = onSchedule(
  { schedule: '0 */12 * * *', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => {
    try {
      const url = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/news?limit=10';
      const res  = await fetch(url);
      const json = await res.json();
      const items = (json.articles || []).slice(0, 10).map(a => ({
        headline:    a.headline || '',
        description: a.description || '',
        published:   a.published || '',
        url:         (a.links && a.links.web && a.links.web.href) || '',
      })).filter(a => a.headline);

      if (!items.length) { console.warn('fetchAtpNews: no articles'); return; }

      // 헤드라인 + 설명 번역 — 실패 시 기존 DB 유지 (영문으로 덮어쓰기 방지)
      const toTranslate = items.flatMap(a => [a.headline, a.description]);
      const translated  = await translateTexts(toTranslate);
      if (!translated) {
        console.warn('fetchAtpNews: translation failed, skipping DB write to preserve existing Korean data');
        return;
      }
      items.forEach((a, i) => {
        a.headlineKo    = translated[i * 2]     || a.headline;
        a.descriptionKo = translated[i * 2 + 1] || a.description;
      });

      await db.ref('jmt/atpNews').set({ articles: items, updatedAt: new Date().toISOString() });
      console.log(`fetchAtpNews: saved ${items.length} articles`);
    } catch (e) {
      console.error('fetchAtpNews error:', e);
    }
  }
);

// ══ 자미봇 — 채팅 트리거 자동 응답 ══════════════════════════════════

const _BOT_NAME = '제이';

// ATP 랭킹 폴백 (jmt/atpRankings 미갱신 시 사용 — index.html ATP_TOP_PLAYERS와 동기화)
const _ATP_FALLBACK_RANKINGS = [
  { rank:1,  name:'Jannik Sinner' },    { rank:2,  name:'Carlos Alcaraz' },
  { rank:3,  name:'Alexander Zverev' }, { rank:4,  name:'Novak Djokovic' },
  { rank:5,  name:'Daniil Medvedev' },  { rank:6,  name:'Taylor Fritz' },
  { rank:7,  name:'Casper Ruud' },      { rank:8,  name:'Andrey Rublev' },
  { rank:9,  name:'Alex de Minaur' },   { rank:10, name:'Stefanos Tsitsipas' },
];
const _BOT_BZ_REF = 'jmt/banzige/current';
const _BOT_MANAGERS = ['유지원', '천지은', '김승수'];

// 트리거별 쿨다운 (ms) — DB: jmt/botCooldown/{trigger}
const _BOT_COOLDOWN = {
  ranking_ind:     10 * 60 * 1000,  // 10분
  ranking_pair:    10 * 60 * 1000,  // 10분
  ranking_att:     10 * 60 * 1000,  // 10분
  member_ranking:   0,               // 쿨다운 없음 (개인 질문)
  member_checkin:   0,               // 쿨다운 없음 (개인 질문)
  schedule:         5 * 60 * 1000,  //  5분
  checkin:          5 * 60 * 1000,  //  5분
  todaymatch:       3 * 60 * 1000,  //  3분
  weather:         10 * 60 * 1000,  // 10분
  air:             10 * 60 * 1000,  // 10분
  fortune:         60 * 60 * 1000,  //  1시간
};

// 구체적인 패턴이 앞에 위치해야 먼저 매칭됨
const _BOT_TRIGGERS = [
  { key: 'ranking_pair', pattern: /팀\s*(페어\s*)?랭킹|팀페어|복식\s*랭킹|페어\s*랭킹|팀\s*순위|페어\s*순위/ },
  { key: 'ranking_att',  pattern: /출석\s*랭킹|출석\s*순위|개근\s*순위/ },
  { key: 'member_ranking', pattern: /[가-힣]{2,4}(이|씨|님|형|오빠|누나|누님|언니|야|아)?\s*(몇\s*등|등수|몇\s*위|등\s*이야|등\s*해|등수야|등수인)/ },
  { key: 'ranking_ind',  pattern: /개인\s*랭킹|개인\s*순위|싱글\s*랭킹|랭킹|순위/ },
  { key: 'schedule',     pattern: /일정|다음\s*모임|이번\s*모임|모임\s*언제|언제\s*모임|몇\s*명|모임\s*날|정기\s*모임/ },
  { key: 'member_checkin', pattern: /[가-힣]{2,4}(이|씨|님|형|오빠|누나|누님|언니|야|아)?\s*(출첵|출석)\s*(안|했|해|함|했나|했어|했음|안해|안했)/ },
  { key: 'checkin',      pattern: /출첵|출석\s*체크|출석\s*현황|체크인\s*현황/ },
  { key: 'todaymatch',   pattern: /오늘\s*경기|경기\s*결과|오늘\s*결과/ },
  { key: 'weather',      pattern: /날씨/ },
  { key: 'air',          pattern: /미세먼지|공기/ },
  { key: 'fortune',      pattern: /운세|쥐띠|소띠|호랑이띠|토끼띠|용띠|뱀띠|말띠|양띠|원숭이띠|닭띠|개띠|돼지띠|\d{4}년\s*운세|\d{2}년생/ },
];

// ── 운세 30개 ─────────────────────────────────────────────────────
const _BOT_FORTUNES = [
  '🍀 오늘은 용기 있는 한 발이 큰 변화를 만듭니다. 망설이지 마세요!',
  '☀️ 따뜻한 사람과 함께하는 오늘, 기쁜 소식이 찾아옵니다.',
  '🌙 지금 힘든 일이 있다면 곧 지나갑니다. 버티는 힘이 빛납니다.',
  '⚡ 에너지 넘치는 날! 계획한 일을 지금 바로 시작하세요.',
  '🌈 뜻밖의 인연이 좋은 기회를 가져올 것입니다.',
  '💪 오늘은 체력 관리가 중요합니다. 충분히 휴식하세요.',
  '🎯 집중력이 높아지는 날입니다. 어려운 문제도 잘 풀립니다.',
  '🌊 흐름에 맡기세요. 억지로 밀어붙이면 오히려 역효과가 납니다.',
  '🏆 노력한 만큼 결과가 보이기 시작하는 날입니다.',
  '🤝 주변 사람에게 먼저 손을 내밀어 보세요. 좋은 반응이 옵니다.',
  '💡 창의적인 아이디어가 떠오를 것입니다. 메모해두세요!',
  '🌺 작은 행복에 감사하는 마음이 더 큰 행복을 불러옵니다.',
  '🎵 오늘은 즐겁고 긍정적인 기운이 넘칩니다. 마음껏 표현하세요.',
  '🔥 도전을 두려워 말고 뛰어들어 보세요. 생각보다 잘 됩니다.',
  '🌿 건강에 신경 써야 하는 날. 가벼운 운동이 도움이 됩니다.',
  '⭐ 오늘 당신이 하는 말 한마디가 누군가에게 큰 힘이 됩니다.',
  '🦋 변화를 두려워하지 마세요. 새로운 시작이 기다립니다.',
  '🎁 기다리던 소식이 올 수 있는 날입니다. 연락을 확인하세요.',
  '💎 진가가 드러나는 날입니다. 자신감을 가지고 나서세요.',
  '🚀 미뤄왔던 일을 오늘 처리하면 좋습니다. 추진력이 강한 날!',
  '🌸 주변 정리가 마음도 정리해줍니다. 공간을 가볍게 만들어보세요.',
  '🎪 예상치 못한 즐거움이 기다립니다. 기대해도 좋아요!',
  '🧘 차분히 생각하는 날. 큰 결정은 오늘 서두르지 마세요.',
  '🌟 오늘 만나는 사람들과 좋은 인연을 이어가세요.',
  '🍊 건강한 식사가 오늘 활력의 원천입니다. 잘 먹고 잘 자세요.',
  '🏄 파도를 타는 것처럼 상황에 유연하게 대응하면 성공합니다.',
  '🎯 정확한 판단을 내릴 수 있는 날. 중요한 결정을 해도 좋습니다.',
  '🌻 주변에 감사 표현을 많이 하세요. 관계가 더욱 깊어집니다.',
  '🦅 높은 곳을 바라보세요. 당신의 가능성은 생각보다 훨씬 큽니다.',
  '🎾 오늘 코트에서 최고의 플레이가 나올 예감! 자신을 믿으세요.',
];



async function _postBotMsg(msgData) {
  await db.ref(`${_BOT_BZ_REF}/messages`).push({
    alias: _BOT_NAME, realName: _BOT_NAME, ts: Date.now(), ...msgData,
  });
}

// ── AI 응답 (@자미봇 멘션) ─────────────────────────────────────────
const _BOT_AI_LIMIT = 600; // 월 총 사용 한도

async function _botAI(question, senderName, history = [], imageUrl = null) {
  // 사용량 체크
  const usageSnap = await db.ref('jmt/botUsage/total').once('value');
  const usageCount = usageSnap.val() || 0;
  if (usageCount >= _BOT_AI_LIMIT) {
    return { text: `🤖 제이 이번 달 사용 한도(${_BOT_AI_LIMIT}건)를 모두 사용했어요 😅 다음 달에 다시 만나요!` };
  }

  // 컨텍스트 데이터 수집
  const year = new Date().getFullYear();
  const [playerSnap, pairSnap, memberSnap, pollStateSnap, recentMatchSnap, restoSnap, ratingSnap] = await Promise.all([
    db.ref(`jmt/playerStats/${year}`).once('value'),
    db.ref(`jmt/pairStats/${year}`).once('value'),
    db.ref('jmt/members').once('value'),
    db.ref('jmt/pollState').once('value'),
    db.ref('jmt/matches').orderByChild('date').limitToLast(200).once('value'),
    db.ref('jmt/restaurants').once('value'),
    db.ref('jmt/restaurantRatings').once('value'),
  ]);

  const playerStats = playerSnap.val() || {};
  const pairStats   = pairSnap.val()   || {};
  const members     = memberSnap.val() || {};
  const pollState   = pollStateSnap.val() || {};
  const recentRaw   = recentMatchSnap.val() || {};
  const restaurants = restoSnap.val() || {};
  const ratings     = ratingSnap.val() || {};

  // 개인 랭킹 요약 — 앱과 동일한 유효승률 알고리즘
  const effWr = (w, d, l) => { const t = w+(d||0)+l; return t ? ((w+(d||0)*0.5)/t*100) : 0; };
  const plRaw = Object.entries(playerStats)
    .map(([name, s]) => ({ name, wins: s.wins||0, losses: s.losses||0, draws: s.draws||0 }));
  const plAvg = plRaw.reduce((sum, p) => sum + p.wins+p.draws+p.losses, 0) / (plRaw.length||1);
  const plTh = plAvg * 0.5;
  const plQ = plRaw.filter(p => p.wins+p.draws+p.losses >= plTh)
    .sort((a,b) => effWr(b.wins,b.draws,b.losses)-effWr(a.wins,a.draws,a.losses) || b.wins-a.wins);
  const plU = plRaw.filter(p => p.wins+p.draws+p.losses < plTh)
    .sort((a,b) => { const ga=a.wins+a.draws+a.losses,gb=b.wins+b.draws+b.losses; return gb-ga||effWr(b.wins,b.draws,b.losses)-effWr(a.wins,a.draws,a.losses)||b.wins-a.wins; });
  const playerList = [...plQ, ...plU].slice(0, 15);
  const playerSummary = playerList.map((p, i) => {
    const wr = Math.round(effWr(p.wins, p.draws, p.losses));
    return `${i+1}위 ${p.name}: ${p.wins}승 ${p.losses}패${p.draws ? ` ${p.draws}무` : ''} (승률 ${wr}%)`;
  }).join('\n');

  // 페어 랭킹 요약 — 유효승률 기준
  const prRaw = Object.entries(pairStats)
    .map(([key, s]) => ({ key, wins: s.wins||0, losses: s.losses||0, draws: s.draws||0, players: s.players||[] }));
  const prAvg = prRaw.reduce((sum, p) => sum + p.wins+p.draws+p.losses, 0) / (prRaw.length||1);
  const prTh = prAvg * 0.5;
  const prQ = prRaw.filter(p => p.wins+p.draws+p.losses >= prTh)
    .sort((a,b) => effWr(b.wins,b.draws,b.losses)-effWr(a.wins,a.draws,a.losses)||b.wins-a.wins);
  const prU = prRaw.filter(p => p.wins+p.draws+p.losses < prTh)
    .sort((a,b) => { const ga=a.wins+a.draws+a.losses,gb=b.wins+b.draws+b.losses; return gb-ga||effWr(b.wins,b.draws,b.losses)-effWr(a.wins,a.draws,a.losses)||b.wins-a.wins; });
  const pairList = [...prQ, ...prU].slice(0, 20);
  const pairSummary = pairList.map((p, i) => {
    const wr = Math.round(effWr(p.wins, p.draws, p.losses));
    return `${i+1}위 ${p.players.join('+')||p.key}: ${p.wins}승 ${p.losses}패 (승률 ${wr}%)`;
  }).join('\n');

  // 최근 경기 — 경기/랭킹 관련 질문일 때만 포함 (토큰 절약)
  const hasMatchQuery = /경기|승|패|랭킹|순위|점수|결과|대결|복식|파트너|이겼|이긴|싸워|상대|전적|누구.*이겼|몇번|몇승|몇패/.test(question);
  let recentMatches = null;
  let matchMentionedNames = [];
  if (hasMatchQuery) {
    // Firebase Admin SDK 배열 방어 변환
    const toArr = v => Array.isArray(v) ? v : Object.values(v || {});

    // 질문에서 언급된 멤버 추출 (풀네임 직접 매칭 + 호칭 패턴)
    const memberObjs = Object.values(members).filter(m => m.name && !m.isGuest);
    const _fn = n => n && n.length >= 3 ? n.slice(1) : n;
    const directMatches = memberObjs.filter(m => question.includes(m.name)).map(m => m.name);
    const honorificMatches = [];
    const honorPat = /([가-힣]{1,4})(오빠|형님|형|언니|누나)/g;
    let hm;
    while ((hm = honorPat.exec(question)) !== null) {
      const namePart = hm[1], hon = hm[2];
      const isMale = ['오빠','형','형님'].includes(hon);
      const found = memberObjs.find(m =>
        _fn(m.name) === namePart &&
        (isMale ? m.gender === 'male' : m.gender === 'female') &&
        !directMatches.includes(m.name)
      );
      if (found && !honorificMatches.includes(found.name)) honorificMatches.push(found.name);
    }
    matchMentionedNames = [...new Set([...directMatches, ...honorificMatches])];

    // 최근 30일 이내, source=daily 매치만 사용
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const allMatches = Object.values(recentRaw)
      .filter(m => m.source === 'daily' && m.sets && m.winner !== undefined && (m.date || '') >= cutoff)
      .sort((a, b) => (b.date||'').localeCompare(a.date||''));

    // 2명 감지 → 같은 팀 경기만 / 1명 → 그 선수 포함 / 0명 → 전체
    const filtered = matchMentionedNames.length >= 2
      ? allMatches.filter(m => {
          const t0 = toArr(m.team0), t1 = toArr(m.team1);
          return matchMentionedNames.every(n => t0.includes(n)) || matchMentionedNames.every(n => t1.includes(n));
        })
      : matchMentionedNames.length === 1
        ? allMatches.filter(m => {
            const t0 = toArr(m.team0), t1 = toArr(m.team1);
            return t0.includes(matchMentionedNames[0]) || t1.includes(matchMentionedNames[0]);
          })
        : allMatches;

    // 포맷: "날짜 A+B vs C+D → 승/패 (스코어)"
    // 특정 선수 언급 시 해당 선수 팀이 항상 왼쪽, 상대가 오른쪽
    recentMatches = filtered.slice(0, 20).map(m => {
      const t0Arr = toArr(m.team0), t1Arr = toArr(m.team1);
      const sets = toArr(m.sets);
      const score = sets.map(s => `${s.s0}-${s.s1}`).join(', ');
      if (matchMentionedNames.length >= 1) {
        const myInT0 = matchMentionedNames.some(n => t0Arr.includes(n));
        const myArr = myInT0 ? t0Arr : t1Arr;
        const oppArr = myInT0 ? t1Arr : t0Arr;
        const myWon = myInT0 ? m.winner === 0 : m.winner === 1;
        const wonStr = m.winner === -1 ? '무승부' : myWon ? '승' : '패';
        const myScore = sets.map(s => myInT0 ? s.s0 : s.s1).join('-');
        const oppScore = sets.map(s => myInT0 ? s.s1 : s.s0).join('-');
        return `${m.date} ${myArr.join('+')} vs ${oppArr.join('+')} → ${wonStr} (${myScore}:${oppScore})`;
      }
      const t0 = t0Arr.join('+'), t1 = t1Arr.join('+');
      const result = m.winner === 0 ? `${t0} 승` : m.winner === 1 ? `${t1} 승` : '무승부';
      return `${m.date} ${t0} vs ${t1} → ${result} (${score})`;
    }).join('\n') || null;
  }

  // 출첵 현황 — jmt/pollState → weekId → jmt/poll/{weekId}/votes
  let checkinCtx = '출첵 정보 없음';
  try {
    const weekId = pollState.weekId;
    const satDate = pollState.satDate || '';
    const pollStatus = pollState.status || '';
    if (weekId) {
      const votesSnap = await db.ref(`jmt/poll/${weekId}/votes`).once('value');
      const votesRaw = votesSnap.val() || {};
      const votes = Object.values(votesRaw);
      const attendList    = votes.filter(v => v.vote === 'attend').map(v => v.name);
      const lateList      = votes.filter(v => v.vote === 'late').map(v => v.name);
      const absentList    = votes.filter(v => v.vote === 'absent').map(v => v.name);
      // 미투표 = 투표 자체를 안 한 사람 (멤버 전체 - 투표자)
      const votedNames    = new Set(votes.map(v => v.name).filter(Boolean));
      const allMemberNames = Object.values(members).filter(m => m.name && !m.isGuest).map(m => m.name);
      const noVoteList    = allMemberNames.filter(n => !votedNames.has(n));
      checkinCtx = `[${satDate} 출첵 현황 (${pollStatus === 'open' ? '진행중' : '마감'})]
참석(${attendList.length}명): ${attendList.join(', ') || '없음'}
늦참(${lateList.length}명): ${lateList.join(', ') || '없음'}
불참(${absentList.length}명): ${absentList.join(', ') || '없음'}
미투표(${noVoteList.length}명): ${noVoteList.join(', ') || '없음'}`;
    }
  } catch(_) {}

  // 단골맛집
  let restaurantCtx = '등록된 맛집 없음';
  try {
    const restoList = Object.entries(restaurants).map(([id, r]) => {
      const ratingVals = Object.values(ratings[id] || {});
      const avgScore = ratingVals.length
        ? (ratingVals.reduce((s, v) => s + (v.score || 0), 0) / ratingVals.length).toFixed(1)
        : '별점없음';
      const addrPart = r.address ? `, 주소: ${r.address}` : '';
      return `- ${r.name} (${r.theme || '기타'}): 방문 ${r.visitCount || 0}회, 별점 ${avgScore}${addrPart}${r.memo ? ', ' + r.memo : ''}`;
    });
    if (restoList.length) restaurantCtx = restoList.join('\n');
  } catch(_) {}

  // 멤버 목록 (성별 포함)
  // 이름에서 성 제거 (3자 이상 → 앞 1자 성 제외, 2자 이하 → 그대로)
  const firstName = name => name && name.length >= 3 ? name.slice(1) : name;
  const memberList = Object.values(members);
  const fmtMember = m => {
    const fn = firstName(m.name);
    const honorific = m.gender === 'male' ? '오빠' : '언니';
    const bday = m.birthday ? `, 생일:${m.birthday}` : '';
    const ntrp = m.ntrp ? `, NTRP:${m.ntrp}` : '';
    return `${fn} ${honorific}(${m.name}${bday}${ntrp})`;
  };
  const males   = memberList.filter(m => m.gender === 'male').map(fmtMember);
  const females = memberList.filter(m => m.gender === 'female').map(fmtMember);
  const memberSummary = `남성 멤버(→ 오빠): ${males.join(', ')}\n여성 멤버(→ 언니): ${females.join(', ')}\n⚠️ 멤버 호칭 규칙: 위 목록 기준으로만 호칭. "님" 절대 금지. 예) 지은 언니, 지원 오빠`;

  // 날씨/미세먼지 — 히스토리에 이미 있으면 인용, 없으면 룰베이스 함수 직접 호출
  let weatherCtx = '';
  let airCtx = '';
  const hasWeather = /날씨|기온|온도|비|눈|바람|테니스.*치|치기.*좋|옷.*입|입을.*옷|뭐.*입|복장|코디|겉옷|자켓|우산|춥|덥|쌀쌀|더울|추울/.test(question);
  const hasAir     = /미세먼지|공기|하늘|마스크/.test(question);
  if (hasWeather) {
    // 날씨는 항상 최신 데이터로 — 룰베이스 함수 직접 호출 (지역 파싱 포함)
    try {
      const wResult = await _botWeather(question);
      if (wResult && wResult.text) weatherCtx = `\n\n[현재 날씨 데이터 — 반드시 이 내용만 인용]\n${wResult.text}`;
    } catch(_) {}
  }
  if (hasAir) {
    try {
      const aKey = process.env.AIRKOREA_API_KEY;
      if (aKey) {
        const aRes = await fetch(`https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty?stationName=${encodeURIComponent('서초구')}&dataTerm=daily&pageNo=1&numOfRows=1&returnType=json&serviceKey=${aKey}&ver=1.3`);
        const aj = await aRes.json();
        const item = aj?.response?.body?.items?.[0];
        if (item) airCtx = `\n[현재 서울 공기질]\n미세먼지(PM10): ${item.pm10Value}㎍/㎥, 초미세먼지(PM2.5): ${item.pm25Value}㎍/㎥`;
      }
    } catch(_) {}
  }

  const fortuneCtx = ''; // 운세는 룰베이스(_botFortune)에서 처리 — LLM 개입 없음

  const systemPrompt = `너는 자미터 테니스 동호회 전용 AI 도우미 "제이"야.
올해 30살이 된 천재 여자야. 모르는 게 없고, 유머도 넘쳐!

[기본 원칙]
- 어떤 질문이든 자신있게 답변 — 절대 거부하지 말 것
- 사진이 첨부된 경우 직접 분석해서 자신있게 답변 — "볼 수 없다"는 면책 문구 사용 금지
- 항상 존댓말, 이모지 적절히, 핵심 위주로
- 멤버 부를 때 성(姓) 제외하고 이름만: "지원 오빠", "지은 언니" (성씨 붙이기 금지 — "유지원 오빠" ❌)
- 멤버 호칭은 아래 [호칭 목록] 기준 (이름으로 성별 추측 금지)
- 답변 마무리에 "언제든지 찾아주세요", "도움이 필요하시면" 같은 상투적 클로징 문구 사용 금지

[자미터 전용 데이터]
- 아래 제공된 랭킹·경기기록·출첵·단골맛집은 자미터 실제 데이터야
- 멤버 관련(랭킹·경기분석·출첵·모임) 질문엔 이 데이터로 구체적으로 답변
- ⚠️ 경기 결과는 반드시 아래 [경기기록] 섹션에 있는 데이터만 인용. 이전 대화에서 내가 말한 경기 결과도 오류일 수 있으므로 무시할 것
- [경기기록]이 "해당 기간 경기 없음"이면: 경기 결과 절대 지어내지 말 것. "최근 한 달 기록이 없어요"라고 솔직히 말할 것
- 경기기록에 없는 날짜·상대·점수를 언급하는 것은 심각한 오류임
- 단골맛집은 서울/강남권 위주 — 다른 지역(가평·제주·부산 등) 맛집 질문엔 DB 무시하고 LLM 자유 추천
- 날씨·운세는 [⚠️] 블록의 실제 데이터 기반으로 답변

[자미터 멤버 호칭 — 반드시 준수]
${memberSummary}

[${year}년 개인 랭킹 (유효승률 기준)]
${playerSummary || '데이터 없음'}

[${year}년 페어 랭킹]
${pairSummary || '데이터 없음'}

${hasMatchQuery ? `[최근 30일 경기기록${matchMentionedNames.length ? ` (${matchMentionedNames.join('+')} 관련)` : ''}]\n${recentMatches || '해당 기간 경기 없음 — 추측 금지'}` : ''}

${checkinCtx}

[자미터 단골맛집 — 서울/강남권 위주, 다른 지역 질문엔 이 목록 사용 금지]
${restaurantCtx}
${weatherCtx}${airCtx}
현재 질문자: ${senderName}${fortuneCtx}`;

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return { text: '🤖 제이 API 키가 설정되지 않았어요.' };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        {
          role: 'user',
          content: imageUrl
            ? await (async () => {
                try {
                  // Firebase Storage URL → base64 변환 (OpenAI 직접 다운로드 타임아웃 방지)
                  const imgRes = await fetch(imageUrl);
                  const arrBuf = await imgRes.arrayBuffer();
                  const b64 = Buffer.from(arrBuf).toString('base64');
                  const mime = imgRes.headers.get('content-type') || 'image/jpeg';
                  return [
                    { type: 'text', text: `${senderName}: [📷 사진 첨부 — 직접 분석할 것] ${question}` },
                    { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}`, detail: 'auto' } },
                  ];
                } catch(_) {
                  return `${senderName}: ${question}`;
                }
              })()
            : `${senderName}: ${question}`,
        },
      ],
      max_tokens: 500,
      temperature: 0.5,
    }),
  });

  if (!resp.ok) {
    console.error('OpenAI API error:', resp.status, await resp.text());
    return { text: '🤖 제이가 잠시 쉬는 중이에요. 잠시 후 다시 시도해주세요 😅' };
  }

  const data = await resp.json();
  const answer = data.choices?.[0]?.message?.content?.trim();
  if (!answer) return { text: '🤖 답변을 가져오지 못했어요. 다시 시도해주세요.' };

  // 사용량 증가
  await db.ref('jmt/botUsage/total').transaction(n => (n || 0) + 1);

  return { text: answer, isBot: true };
}

// ── ATP 경기 결과/예고 자미봇 리포팅 ──────────────────────────────
async function _botReportAtpResults(matches, tournamentInfo) {
  if (!matches || !matches.length || !tournamentInfo) return;

  // ATP 랭킹 로드
  const rankSnap = await db.ref('jmt/atpRankings').once('value');
  const rankPlayers = ((rankSnap.val() || {}).players || []).length
    ? (rankSnap.val().players)
    : _ATP_FALLBACK_RANKINGS;
  const rankMap = {};
  for (const p of rankPlayers) {
    if (p.name) rankMap[p.name.toLowerCase()] = p.rank;
  }
  const getRank = (name) => {
    if (!name) return null;
    const key = name.toLowerCase();
    if (rankMap[key]) return rankMap[key];
    for (const [rn, rank] of Object.entries(rankMap)) {
      if (key.includes(rn) || rn.includes(key)) return rank;
    }
    return null;
  };

  // 리포트/알림 완료 목록
  const [reportedSnap, notifiedSnap] = await Promise.all([
    db.ref('jmt/botReportedMatches').once('value'),
    db.ref('jmt/botNotifiedMatches').once('value'),
  ]);
  const reported = reportedSnap.val() || {};
  const notified = notifiedSnap.val() || {};

  const now  = Date.now();
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const tName = tournamentInfo.displayName || '';

  const ROUND_MAP = {
    '1st round': '1R', '2nd round': '2R', '3rd round': '3R', '4th round': '4R',
    'round of 128': '1R', 'round of 64': '2R', 'round of 32': '3R', 'round of 16': '4R',
    'quarterfinals': 'QF', 'semifinals': 'SF', 'final': 'F',
  };
  const fmtRound = r => ROUND_MAP[(r || '').toLowerCase()] || r;

  // ISO → KST 날짜 (2026.05.21)
  const toKSTDate = iso => {
    const d = new Date(iso);
    const s = d.toLocaleDateString('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
    return s.replace(/\. /g, '.').replace(/\.$/, '');
  };
  // ISO → KST 날짜+시간 (5/25 22:00)
  const toKSTDateTime = iso => {
    const d = new Date(iso);
    return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
  };

  // 경기 예고만 처리 — top 3 + QF 이상, 2시간 이내 시작, 미알림 (결과는 아침 8시 다이제스트로 처리)
  const PREVIEW_ROUNDS = ['quarterfinals', 'semifinals', 'final'];
  for (const m of matches) {
    if (!m.id) continue;
    if (!PREVIEW_ROUNDS.includes((m.roundName || '').toLowerCase())) continue;
    const r1 = getRank(m.player1Name);
    const r2 = getRank(m.player2Name);

    if (((r1 && r1 <= 3) || (r2 && r2 <= 3)) && !notified[m.id] && m.date && m.status !== 'STATUS_FINAL') {
      const matchTs   = new Date(m.date).getTime();
      const remaining = matchTs - now;
      if (remaining > 0 && remaining <= TWO_HOURS) {
        const p1Label = r1 ? `${m.player1Name} (ATP ${r1}위)` : m.player1Name;
        const p2Label = r2 ? `${m.player2Name} (ATP ${r2}위)` : m.player2Name;

        const text = [
          `🔔 경기 예고 · ${tName} ${fmtRound(m.roundName)}`,
          `━━━━━━━━━━━━━━━━━━━━`,
          `🎾 ${p1Label}`,
          `🆚 ${p2Label}`,
          ``,
          `⏰ ${toKSTDateTime(m.date)} (KST)`,
          `약 2시간 후 시작 예정!`,
        ].join('\n');

        await _postBotMsg({ text });
        await db.ref(`jmt/botNotifiedMatches/${m.id}`).set(now);
      }
    }
  }
}

// ── 점심/맛집 추천 ─────────────────────────────────────────────────
// ── 개인 랭킹 TOP 5 ───────────────────────────────────────────────
async function _botRankingInd() {
  const year = new Date().getFullYear();
  const snap = await db.ref(`jmt/playerStats/${year}`).once('value');
  const stats = snap.val() || {};
  const sorted = Object.entries(stats)
    .filter(([, s]) => (s.wins || 0) + (s.losses || 0) >= 3)
    .sort((a, b) => {
      const aT = (a[1].wins||0) + (a[1].draws||0) + (a[1].losses||0);
      const bT = (b[1].wins||0) + (b[1].draws||0) + (b[1].losses||0);
      const aR = aT ? (a[1].wins||0)/aT : 0;
      const bR = bT ? (b[1].wins||0)/bT : 0;
      if (bR !== aR) return bR - aR;           // 1순위: 승률
      if ((b[1].wins||0) !== (a[1].wins||0)) return (b[1].wins||0) - (a[1].wins||0); // 2순위: 승수
      return bT - aT;                          // 3순위: 총 경기수
    }).slice(0, 5);
  if (!sorted.length) return { text: `🏆 ${year}년 개인랭킹\n\n아직 3경기 이상 기록된 멤버가 없어요.\n열심히 경기를 뛰어봐요! 🎾` };
  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
  const lines = sorted.map(([name, s], i) => {
    const total = (s.wins||0) + (s.draws||0) + (s.losses||0);
    const rate  = total ? Math.round((s.wins||0)/total*100) : 0;
    const draws = (s.draws||0) > 0 ? ` ${s.draws}무` : '';
    return `${medals[i]} ${name}  승률 ${rate}%\n    ${s.wins||0}승${draws} ${s.losses||0}패 · 총 ${total}경기`;
  });
  return { text: `🏆 ${year}년 개인랭킹 TOP 5\n3경기 이상 · 승률 기준\n\n${lines.join('\n')}` };
}

// ── 팀페어 랭킹 TOP 5 ─────────────────────────────────────────────
async function _botRankingPair() {
  const year = new Date().getFullYear();
  const snap = await db.ref(`jmt/pairStats/${year}`).once('value');
  const stats = snap.val() || {};
  const sorted = Object.entries(stats)
    .filter(([, s]) => (s.wins || 0) + (s.losses || 0) >= 2)
    .sort((a, b) => {
      const aT = (a[1].wins||0) + (a[1].draws||0) + (a[1].losses||0);
      const bT = (b[1].wins||0) + (b[1].draws||0) + (b[1].losses||0);
      const aR = aT ? (a[1].wins||0)/aT : 0;
      const bR = bT ? (b[1].wins||0)/bT : 0;
      if (bR !== aR) return bR - aR;           // 1순위: 승률
      if ((b[1].wins||0) !== (a[1].wins||0)) return (b[1].wins||0) - (a[1].wins||0); // 2순위: 승수
      return bT - aT;                          // 3순위: 총 경기수
    }).slice(0, 5);
  if (!sorted.length) return { text: `👥 ${year}년 팀페어 랭킹\n\n아직 2경기 이상 기록된 팀이 없어요.\n복식 경기를 더 기록해봐요! 🎾` };
  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
  const lines = sorted.map(([, s], i) => {
    const total    = (s.wins||0) + (s.draws||0) + (s.losses||0);
    const rate     = total ? Math.round((s.wins||0)/total*100) : 0;
    const draws    = (s.draws||0) > 0 ? ` ${s.draws}무` : '';
    const nick     = s.nickname ? ` "${s.nickname}"` : '';
    const players  = (s.players || []).join(' · ');
    return `${medals[i]} ${players}${nick}\n    승률 ${rate}% · ${s.wins||0}승${draws} ${s.losses||0}패 · ${total}경기`;
  });
  return { text: `👥 ${year}년 팀페어 랭킹 TOP 5\n2경기 이상 · 승률 기준\n\n${lines.join('\n')}` };
}

// ── 출석 랭킹 TOP 5 ───────────────────────────────────────────────
async function _botRankingAtt() {
  const year = new Date().getFullYear();
  // startAt/endAt으로 해당 연도 poll만 정확히 조회
  const snap = await db.ref('jmt/poll')
    .orderByKey()
    .startAt(String(year))
    .endAt(String(year) + '\uf8ff')
    .once('value');
  const poll = snap.val() || {};
  const counts = {};
  let totalWeeks = 0;
  for (const [, week] of Object.entries(poll)) {
    const votes = week.votes || {};
    if (!Object.keys(votes).length) continue;
    totalWeeks++;
    // votes 구조: { memberNameKey: { name, vote, votedAt } }
    for (const vObj of Object.values(votes)) {
      const vStr  = typeof vObj === 'object' ? (vObj.vote || '') : String(vObj || '');
      const mName = typeof vObj === 'object' ? (vObj.name || '') : '';
      if (mName && (vStr === 'attend' || vStr === 'late')) {
        counts[mName] = (counts[mName] || 0) + 1;
      }
    }
  }
  if (!Object.keys(counts).length) return { text: `📅 ${year}년 출석 랭킹\n\n아직 집계된 출석 데이터가 없어요.` };
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
  const lines = sorted.map(([name, cnt], i) => {
    const rate = totalWeeks ? Math.round(cnt / totalWeeks * 100) : 0;
    return `${medals[i]} ${name}  ${cnt}회 출석 · 출석률 ${rate}%`;
  });
  return { text: `📅 ${year}년 출석 랭킹 TOP 5\n총 ${totalWeeks}주 기준\n\n${lines.join('\n')}` };
}

// ── 오늘의 경기 결과 ───────────────────────────────────────────────
async function _botTodayMatch() {
  const snap = await db.ref('jmt/dailyCards').orderByChild('createdAt').limitToLast(30).once('value');
  const all = snap.val() || {};
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  // Firebase 배열→객체 변환 처리 헬퍼
  const toArr = v => Array.isArray(v) ? v : (v ? Object.values(v) : []);
  const today = Object.values(all)
    .filter(c => {
      if (!c.createdAt) return false;
      const cd = new Date(c.createdAt);
      return cd.getFullYear() === now.getFullYear() &&
             cd.getMonth()    === now.getMonth() &&
             cd.getDate()     === now.getDate() &&
             c.phase          === 'done';
    })
    .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
  if (!today.length) return { text: '🎾 오늘 등록된 경기가 없어요!\n먼저 경기를 시작해보세요 💪' };
  const lines = today.slice(0, 8).map((c, i) => {
    const t0   = toArr(c.team0).join(' · ');
    const t1   = toArr(c.team1).join(' · ');
    const sets = toArr(c.sets);
    // 세트 스코어: {s0, s1} 구조
    const scoreStr = sets.map(s => `${s.s0??'-'}:${s.s1??'-'}`).join('  ');
    const sw0  = sets.filter(s => (s.s0 ?? 0) > (s.s1 ?? 0)).length;
    const sw1  = sets.filter(s => (s.s1 ?? 0) > (s.s0 ?? 0)).length;
    let winLine;
    if (c.winner === 0 || (c.winner === undefined && sw0 > sw1)) {
      winLine = `🏆 ${t0}  WIN`;
    } else if (c.winner === 1 || sw1 > sw0) {
      winLine = `🏆 ${t1}  WIN`;
    } else {
      winLine = '🤝 무승부';
    }
    return `${i+1}. ${t0}\n    vs ${t1}\n    📊 ${scoreStr}\n    ${winLine}`;
  });
  return { text: `🎾 오늘의 경기 결과 · ${today.length}경기\n\n${lines.join('\n\n')}` };
}

// ── 모임 일정 + 출석 현황 통합 ────────────────────────────────────
async function _botSchedule() {
  // pollState 로드
  const psSnap = await db.ref('jmt/pollState').once('value');
  const ps = psSnap.val();
  if (!ps || !ps.satDate) {
    return { text: '📅 현재 등록된 모임 일정이 없어요.\n관리자가 출첵을 오픈하면 일정이 등록됩니다.' };
  }

  // 날짜 파싱
  const [y, mo, d] = ps.satDate.split('-').map(Number);
  const satDateObj  = new Date(y, mo - 1, d);
  const today       = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
  today.setHours(0, 0, 0, 0);
  const diffDays    = Math.round((satDateObj - today) / 86400000);
  const dayLabel    = diffDays === 0 ? '오늘' : diffDays === 1 ? '내일' : diffDays > 0 ? `${diffDays}일 후` : `${-diffDays}일 전 (종료)`;
  const dateStr     = `${y}년 ${mo}월 ${d}일 (토)`;

  // 모임 번호 계산 (index.html과 동일한 공식)
  const BASE_MS     = new Date('2026-03-28').getTime();
  const weeksDiff   = Math.round((satDateObj.getTime() - BASE_MS) / (7 * 24 * 60 * 60 * 1000));
  const meetNum     = 308 + weeksDiff;

  // 멤버 목록 (게스트 제외)
  const membSnap    = await db.ref('jmt/members').once('value');
  const members     = Object.values(membSnap.val() || {})
    .filter(m => m.name && !m.isGuest)
    .map(m => m.name);
  const total       = members.length;

  // 투표 현황 — pollState.weekId 기준 (app과 동일한 경로)
  const votesSnap = await db.ref(`jmt/poll/${ps.weekId}/votes`).once('value');
  const votes     = votesSnap.val() || {};
  // votes 구조: { memberNameKey: { name, vote, votedAt } }
  const voteMap = {};
  for (const vObj of Object.values(votes)) {
    if (vObj && vObj.name && vObj.vote) voteMap[vObj.name] = vObj.vote;
  }
  const attend = [], late = [], absent = [], noResp = [];
  for (const name of members) {
    const v = voteMap[name];
    if (!v)                noResp.push(name);
    else if (v === 'attend') attend.push(name);
    else if (v === 'late')   late.push(name);
    else if (v === 'absent') absent.push(name);
  }
  const playCount   = attend.length + late.length;
  const doneCount   = playCount + absent.length;
  const statusLabel = ps.status === 'closed' ? '마감' : '진행중';

  // 막대 그래프 (10칸)
  const barFill = total > 0 ? Math.round(doneCount / total * 10) : 0;
  const bar     = '■'.repeat(barFill) + '□'.repeat(10 - barFill);

  // 출석 목록 포맷
  const fmtList = (arr) => arr.length ? arr.join(', ') : '-';

  // 이번 주 경기 결과 (토요일 당일/하루뒤)
  let matchLines = [];
  if (diffDays <= 0 && diffDays > -2) {
    const mSnap = await db.ref('jmt/dailyCards').orderByChild('createdAt').limitToLast(20).once('value');
    Object.values(mSnap.val() || {}).filter(c => {
      if (!c.createdAt) return false;
      const cd = new Date(c.createdAt);
      return cd.getFullYear() === y && (cd.getMonth() + 1) === mo && cd.getDate() === d;
    }).slice(0, 5).forEach((c, i) => {
      const t0 = (c.team0||[]).join('·'), t1 = (c.team1||[]).join('·');
      const sc = (c.sets||[]).map(s=>`${s[0]}-${s[1]}`).join(' ');
      const win = c.winner===0?`▶${t0}`:c.winner===1?`▶${t1}`:'';
      matchLines.push(`${i+1}. ${t0} vs ${t1}  ${sc}  ${win}`);
    });
  }

  const tail = noResp.length
    ? `⚠️ 미응답 ${noResp.length}명 — 출첵 눌러주세요!`
    : '✨ 모든 멤버 응답 완료!';

  const parts = [
    `📅 제${meetNum}회 자미터 정기 모임`,
    `📆 ${dateStr}  ·  D${diffDays<=0?'+'+Math.abs(diffDays):'-'+diffDays}  ·  출첵 ${statusLabel}`,
    ``,
    `[${bar}]  ${doneCount} / ${total}명 응답`,
    ``,
    `✅ 참여 ${attend.length}명   ${fmtList(attend)}`,
    `⏰ 지각 ${late.length}명   ${fmtList(late)}`,
    `❌ 불참 ${absent.length}명   ${fmtList(absent)}`,
    `❓ 미응답 ${noResp.length}명   ${fmtList(noResp)}`,
    ``,
    `🎾 예상 참여 ${playCount}명`,
    tail,
  ];
  if (matchLines.length) {
    parts.push('', `── 경기 결과 (${matchLines.length}경기) ──`, ...matchLines);
  }
  return { text: parts.join('\n') };
}

// ── 출석체크 현황 ──────────────────────────────────────────────────
async function _botCheckin() {
  // 멤버 목록 (게스트 제외)
  const membSnap = await db.ref('jmt/members').once('value');
  const members = Object.values(membSnap.val() || {})
    .filter(m => m.name && !m.isGuest)
    .map(m => m.name);

  // pollState로 weekId 조회 (app과 동일한 경로)
  const psSnap = await db.ref('jmt/pollState').once('value');
  const ps     = psSnap.val();
  if (!ps || !ps.weekId) return { text: '📋 현재 진행 중인 출석체크가 없어요.' };

  const pollStatus = ps.status === 'closed' ? '마감' : '진행중';
  const votesSnap  = await db.ref(`jmt/poll/${ps.weekId}/votes`).once('value');
  const rawVotes   = votesSnap.val() || {};
  // votes 구조: { memberNameKey: { name, vote, votedAt } }
  const voteMap = {};
  for (const vObj of Object.values(rawVotes)) {
    if (vObj && vObj.name && vObj.vote) voteMap[vObj.name] = vObj.vote;
  }

  const attend = [], late = [], absent = [], noResp = [];
  for (const name of members) {
    const v = voteMap[name];
    if (!v)                noResp.push(name);
    else if (v === 'attend') attend.push(name);
    else if (v === 'late')   late.push(name);
    else if (v === 'absent') absent.push(name);
  }

  const total       = members.length;
  const done        = attend.length + late.length + absent.length;
  const statusLabel = pollStatus === 'closed' ? '마감' : '진행중';
  const barFill     = total > 0 ? Math.round(done / total * 10) : 0;
  const bar         = '■'.repeat(barFill) + '□'.repeat(10 - barFill);
  const fmtList     = (arr) => arr.length ? arr.join(', ') : '-';
  const tail        = noResp.length
    ? `⚠️ 미응답 ${noResp.length}명 — 빨리 출첵해주세요!`
    : '✨ 모든 멤버 응답 완료!';

  return { text: [
    `📋 출석체크 현황 · 출첵 ${statusLabel}`,
    `[${bar}]  ${done} / ${total}명 응답`,
    ``,
    `✅ 참여 ${attend.length}명   ${fmtList(attend)}`,
    `⏰ 지각 ${late.length}명   ${fmtList(late)}`,
    `❌ 불참 ${absent.length}명   ${fmtList(absent)}`,
    `❓ 미응답 ${noResp.length}명   ${fmtList(noResp)}`,
    ``,
    tail,
  ].join('\n') };
}

// ── 멤버 이름 추출 헬퍼 ───────────────────────────────────────────
async function _findMemberByText(text) {
  const snap = await db.ref('jmt/members').once('value');
  const members = Object.values(snap.val() || {})
    .filter(m => m.name && !m.isGuest)
    .map(m => m.name);
  // 1. 전체 이름 정확 매칭
  for (const name of members) {
    if (text.includes(name)) return name;
  }
  // 호칭/조사 목록
  const _TITLES = ['이', '씨', '님', '형', '오빠', '누나', '누님', '언니', '야', '아'];
  // 2. 성 제외 이름(2글자) + 호칭/공백 매칭
  for (const name of members) {
    const given = name.length >= 3 ? name.slice(1) : name;
    if (_TITLES.some(t => text.includes(given + t)) || text.includes(given + ' ') || text.startsWith(given)) return name;
  }
  // 3. 2글자 전체 이름 + 호칭 매칭
  for (const name of members) {
    if (name.length === 2 && _TITLES.some(t => text.includes(name + t))) return name;
  }
  return null;
}

// ── 특정 멤버 개인 랭킹 ───────────────────────────────────────────
async function _botMemberRanking(text) {
  const member = await _findMemberByText(text);
  if (!member) return null;
  const year = new Date().getFullYear();
  const snap = await db.ref(`jmt/playerStats/${year}`).once('value');
  const stats = snap.val() || {};
  const memberStats = stats[member];
  if (!memberStats || (memberStats.wins||0) + (memberStats.losses||0) < 1) {
    return { text: `🎾 ${member}님의 ${year}년 기록이 아직 없어요.\n경기를 더 뛰어봐요! 💪` };
  }
  const sorted = Object.entries(stats)
    .filter(([, s]) => (s.wins||0) + (s.losses||0) >= 1)
    .sort((a, b) => {
      const aT = (a[1].wins||0) + (a[1].draws||0) + (a[1].losses||0);
      const bT = (b[1].wins||0) + (b[1].draws||0) + (b[1].losses||0);
      const aR = aT ? (a[1].wins||0)/aT : 0;
      const bR = bT ? (b[1].wins||0)/bT : 0;
      if (bR !== aR) return bR - aR;
      if ((b[1].wins||0) !== (a[1].wins||0)) return (b[1].wins||0) - (a[1].wins||0);
      return bT - aT;
    });
  const rank  = sorted.findIndex(([name]) => name === member) + 1;
  const total = (memberStats.wins||0) + (memberStats.draws||0) + (memberStats.losses||0);
  const rate  = total ? Math.round((memberStats.wins||0)/total*100) : 0;
  const draws = (memberStats.draws||0) > 0 ? ` ${memberStats.draws}무` : '';
  const rankLabel = rank === 1 ? '🥇 1위' : rank === 2 ? '🥈 2위' : rank === 3 ? '🥉 3위' : `${rank}위`;
  return { text: `🏆 ${member}님 ${year}년 개인랭킹\n\n${rankLabel}  승률 ${rate}%\n${memberStats.wins||0}승${draws} ${memberStats.losses||0}패 · 총 ${total}경기\n(1경기 이상 기록 ${sorted.length}명 기준)` };
}

// ── 특정 멤버 출첵 현황 ───────────────────────────────────────────
async function _botMemberCheckin(text) {
  const member = await _findMemberByText(text);
  if (!member) return null;
  const psSnap = await db.ref('jmt/pollState').once('value');
  const ps = psSnap.val();
  if (!ps || !ps.weekId) {
    return { text: `📋 현재 진행 중인 출첵이 없어요.` };
  }
  const votesSnap = await db.ref(`jmt/poll/${ps.weekId}/votes`).once('value');
  const rawVotes = votesSnap.val() || {};
  let vote = null;
  for (const vObj of Object.values(rawVotes)) {
    if (vObj && vObj.name === member && vObj.vote) { vote = vObj.vote; break; }
  }
  const pollStatus = ps.status === 'closed' ? '마감' : '진행중';
  let statusText;
  if (vote === 'attend')      statusText = '✅ 참여로 출첵했어요!';
  else if (vote === 'late')   statusText = '⏰ 지각으로 출첵했어요.';
  else if (vote === 'absent') statusText = '❌ 불참으로 출첵했어요.';
  else                        statusText = `❓ 아직 출첵 안 했어요.\n${member}님~ 빨리 출첵해주세요! 🙏`;
  return { text: `📋 ${member}님 출첵 현황 · ${pollStatus}\n\n${statusText}` };
}

// ── 날씨 (OpenWeatherMap) ──────────────────────────────────────────
async function _botWeather(msgText) {
  const apiKey = process.env.OPENWEATHER_API_KEY;
  if (!apiKey) return { text: '⚠️ 날씨 API 키가 설정되지 않았습니다.\n관리자에게 문의하세요 (OPENWEATHER_API_KEY).' };
  try {
    // 메시지에서 위치 추출 (예: "강남 날씨", "부산 날씨 알려줘")
    let lat = process.env.BOT_WEATHER_LAT || '37.5665';
    let lon = process.env.BOT_WEATHER_LON || '126.9780';
    let locationName = null;
    if (msgText) {
      // 지역명 추출 — 날씨 키워드 앞뒤 단어, 장소 조사(에서/에/의/나가/가려) 앞 단어 등 다양하게 시도
      const cleaned = msgText
        .replace(/오늘|내일|지금|현재|지역|기온|온도|좀|알려줘|알려주세요|어때|어떤가요|날씨가|날씨는|날씨$/g, '')
        .trim();
      const patterns = [
        /([가-힣]{2,6})(?:\s*(?:날씨|기온|온도|바람))/, // "한강 날씨", "제주시 기온"
        /([가-힣]{2,6})(?:\s*(?:에서|에|로|까지|나가|가려|나오려))/, // "한강에서", "여의도로"
        /([가-힣]{2,6})\s*날씨/,
      ];
      let locMatch = '';
      for (const pat of patterns) {
        const m = cleaned.match(pat);
        if (m && m[1] && m[1].length >= 2) { locMatch = m[1]; break; }
      }
      if (locMatch) {
        // OpenWeatherMap Geocoding API로 한국 지명 → 좌표 변환
        const geoRes = await fetch(`http://api.openweathermap.org/geo/1.0/direct?q=${encodeURIComponent(locMatch)},KR&limit=1&appid=${apiKey}`);
        const geoData = await geoRes.json();
        if (Array.isArray(geoData) && geoData.length > 0) {
          lat = String(geoData[0].lat);
          lon = String(geoData[0].lon);
          locationName = geoData[0].local_names?.ko || geoData[0].name || locMatch;
        }
      }
    }
    const res = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric&lang=kr`);
    const d = await res.json();
    if (!d.main) return { text: '🌤️ 날씨 정보를 가져올 수 없어요.' };
    const wId = d.weather?.[0]?.id || 800;
    const emoji = (() => { if(wId<300)return'⛈️'; if(wId<400)return'🌦️'; if(wId<600)return'🌧️'; if(wId<700)return'❄️'; if(wId<800)return'🌫️'; if(wId===800)return'☀️'; if(wId===801)return'🌤️'; if(wId===802)return'⛅'; return'🌥️'; })();
    const desc = d.weather?.[0]?.description || '';
    const temp = d.main.temp;
    const wind = (d.wind?.speed || 0) * 3.6; // m/s → km/h
    const humid = d.main.humidity;
    const displayName = locationName || d.name || '서울';
    // 테니스 추천지수 계산 (0~100)
    let score = 100;
    if (wId < 700) score -= 70;           // 비/눈/뇌우
    else if (wId < 800) score -= 20;      // 안개/흐림
    if (temp < 5) score -= 30;
    else if (temp < 10) score -= 15;
    else if (temp > 33) score -= 25;
    else if (temp > 28) score -= 10;
    if (wind > 40) score -= 25;
    else if (wind > 25) score -= 10;
    if (humid > 85) score -= 10;
    score = Math.max(0, Math.min(100, score));
    const tennisEmoji = score >= 80 ? '🎾 최상' : score >= 60 ? '🎾 좋음' : score >= 40 ? '⚠️ 보통' : '❌ 비추천';
    const tennisBar = '█'.repeat(Math.round(score/10)) + '░'.repeat(10 - Math.round(score/10));
    return { text: `${emoji} ${displayName} 현재 날씨\n\n🌡️ ${Math.round(temp)}°C  (체감 ${Math.round(d.main.feels_like)}°C)\n💧 습도 ${humid}%  💨 바람 ${Math.round(wind)}km/h\n☁️ ${desc}\n\n🎾 테니스 추천지수  ${score}점\n[${tennisBar}] ${tennisEmoji}` };
  } catch (e) {
    return { text: '🌤️ 날씨 정보를 가져오는 데 실패했어요.' };
  }
}

// ── 미세먼지 (에어코리아) ──────────────────────────────────────────
async function _botAir(msgText) {
  const apiKey = process.env.AIRKOREA_API_KEY;
  if (!apiKey) return { text: '⚠️ 에어코리아 API 키가 설정되지 않았습니다.\n관리자에게 문의하세요 (AIRKOREA_API_KEY).' };
  try {
    // 메시지에서 위치 추출 (예: "강남 미세먼지", "부산 공기")
    let stationRaw = process.env.BOT_AIR_STATION || '종로구';
    if (msgText) {
      const locMatch = msgText.replace(/미세먼지.*|공기.*/, '').replace(/.*에서|.*의/, '').trim();
      if (locMatch && locMatch.length >= 2 && locMatch.length <= 10) {
        stationRaw = locMatch;
      }
    }
    const station = encodeURIComponent(stationRaw);
    const url = `https://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getMsrstnAcctoRltmMesureDnsty?stationName=${station}&dataTerm=daily&pageNo=1&numOfRows=1&returnType=json&serviceKey=${apiKey}&ver=1.3`;
    const res = await fetch(url);
    const json = await res.json();
    const item = json?.response?.body?.items?.[0];
    if (!item) return { text: `🌬️ '${stationRaw}' 측정소 정보를 찾을 수 없어요.\n구 이름으로 입력해보세요 (예: 강남구, 종로구).` };
    const g = (val, t) => { const v=parseInt(val); if(isNaN(v))return''; return t==='pm10' ? (v<=30?'😊좋음':v<=80?'🙂보통':v<=150?'😷나쁨':'🚨매우나쁨') : (v<=15?'😊좋음':v<=35?'🙂보통':v<=75?'😷나쁨':'🚨매우나쁨'); };
    return { text: `🌬️ ${stationRaw} 현재 공기질\n\n미세먼지(PM10): ${item.pm10Value}㎍/㎥  ${g(item.pm10Value,'pm10')}\n초미세먼지(PM2.5): ${item.pm25Value}㎍/㎥  ${g(item.pm25Value,'pm25')}` };
  } catch (e) {
    return { text: '🌬️ 미세먼지 정보를 가져오는 데 실패했어요.' };
  }
}

// ── 띠별 운세 ──────────────────────────────────────────────────────
const _ZODIAC_NAMES  = ['쥐','소','호랑이','토끼','용','뱀','말','양','원숭이','닭','개','돼지'];
const _ZODIAC_EMOJIS = ['🐭','🐮','🐯','🐰','🐲','🐍','🐴','🐑','🐵','🐔','🐶','🐷'];

// 오늘의 운세 (띠만 알 때 — 날짜 시드 기반 1개 표시)
const _ZODIAC_FORTUNES = [
  ['민첩함을 발휘할 때입니다. 빠른 판단이 좋은 결과를 가져와요. 행운의 숫자: 3', '인간관계에 집중하세요. 뜻밖의 인연이 큰 도움이 됩니다. 행운의 색: 빨강 🔴', '새로운 시작의 기운이 강합니다. 작은 기회도 놓치지 마세요. 행운의 색: 파랑 🔵'],
  ['묵묵히 노력한 일이 빛을 발하는 날입니다. 꾸준함을 유지하세요. 행운의 숫자: 8', '재물운이 좋습니다. 작은 투자라도 신중하게 결정하세요. 행운의 색: 초록 🟢', '건강 관리에 신경 쓸 때입니다. 충분한 휴식을 취하세요. 행운의 숫자: 6'],
  ['두려움 없이 도전하면 반드시 성과가 있어요. 행운의 색: 주황 🟠', '리더십이 빛납니다. 팀을 이끌어 가면 큰 성과를 거둡니다. 행운의 숫자: 1', '에너지가 넘치는 날! 야외활동이 특히 좋습니다. 행운의 색: 노랑 🟡'],
  ['온화한 기운으로 주변을 편안하게 만드는 날입니다. 행운의 숫자: 4', '창의적인 아이디어가 샘솟는 날! 메모해 두면 큰 자산이 됩니다. 행운의 색: 보라 🟣', '사랑운이 좋습니다. 소중한 사람에게 따뜻한 말 한마디를 건네보세요. 행운의 숫자: 9'],
  ['원대한 꿈을 향해 한 발짝 나아가기 좋은 날입니다. 행운의 색: 금색 ✨', '카리스마가 빛나는 날! 중요한 협상에 좋습니다. 행운의 숫자: 5', '새로운 계획을 세우기 좋은 날입니다. 장기 목표를 점검해보세요. 행운의 색: 파랑 🔵'],
  ['지혜롭게 분석하면 해결책이 보입니다. 급하게 행동하지 마세요. 행운의 숫자: 7', '조용히 내실을 다지기 좋은 날입니다. 남들 모르게 빛나고 있어요. 행운의 색: 검정 ⚫', '예상치 못한 소식이 들어올 수 있습니다. 유연하게 대처하면 이득이 됩니다. 행운의 숫자: 2'],
  ['자유롭게 행동하면 좋은 결과가 따릅니다. 행운의 색: 하늘 🔵', '직감을 믿어보세요. 첫 번째 선택이 정답일 가능성이 높습니다. 행운의 숫자: 8', '멀리 있는 사람과 연락하면 좋은 인연으로 이어집니다. 행운의 색: 초록 🟢'],
  ['따뜻한 마음으로 나누면 배로 돌아옵니다. 행운의 숫자: 3', '예술적 감수성이 높아지는 날! 음악이나 영화를 즐기면 영감이 옵니다. 행운의 색: 분홍 🩷', '가족 또는 가까운 사람과의 시간이 소중해지는 날입니다. 행운의 숫자: 6'],
  ['순발력과 임기응변이 빛나는 날! 변화를 두려워하지 마세요. 행운의 색: 주황 🟠', '다재다능함을 발휘할 기회입니다. 여러 분야에 관심을 가져보세요. 행운의 숫자: 4', '사교적인 활동이 좋은 결과를 가져옵니다. 행운의 색: 노랑 🟡'],
  ['꼼꼼하게 일을 처리하면 신뢰가 쌓입니다. 행운의 숫자: 1', '건강 관리에 투자하면 좋은 날입니다. 자기 관리가 빛납니다. 행운의 색: 하양 ⚪', '공식적인 자리에서 인정받는 날입니다. 자신감 있게 행동하세요. 행운의 숫자: 9'],
  ['의리와 신뢰로 주변을 감동시키는 날입니다. 행운의 색: 갈색 🟤', '오랜 친구와의 만남이 좋은 일을 가져옵니다. 행운의 숫자: 7', '솔직한 마음을 표현하면 관계가 더 깊어집니다. 행운의 색: 파랑 🔵'],
  ['풍요로운 기운이 감돌는 날입니다. 나눔을 실천하면 복이 돌아와요. 행운의 숫자: 5', '긍정적인 마음으로 시작하면 좋은 일이 생깁니다. 행운의 색: 빨강 🔴', '재물복이 있는 날입니다. 작은 행운도 감사하게 여기면 큰 복이 됩니다. 행운의 숫자: 2'],
];

// 12년 운세 사이클 (출생연도 기준 position 0~11)
const _CYCLE_DATA = [
  { label: '본명년⚡', tennis: '과감한 포지션 변화를 시도하기 좋은 해, 도전이 성장을 만든다',          money: '큰 지출·투자는 충분히 검토 후 신중하게 결정할 것',          relation: '기존 관계 재정립, 새로운 인연이 등장하는 시기',          health: '건강검진으로 기초 체력을 점검할 것, 무리 금물' },
  { label: '씨앗기🌱', tennis: '기초 스트로크 훈련에 집중하면 내년 도약이 따른다',                   money: '절약이 내년 풍요의 밑거름이 되는 시기',                    relation: '새 인연의 씨앗이 심어지는 해, 첫인상이 중요',            health: '규칙적인 생활 리듬 형성이 핵심, 수면 관리' },
  { label: '성장기🌿', tennis: '꾸준한 연습이 눈에 보이게 실력으로 돌아오는 해',                     money: '소소한 투자나 부업이 좋은 결과를 낸다',                    relation: '우정과 신뢰가 깊어지고 팀워크가 빛나는 시기',            health: '체력이 오르는 것이 몸으로 느껴지는 해, 유산소 추천' },
  { label: '결실기🌾', tennis: '게임 감각이 살아나며 승률이 눈에 띄게 오른다',                       money: '수입이 늘거나 보상이 돌아오는 풍요로운 시기',              relation: '인기 상승, 모임에서 자연스럽게 중심 역할을 맡게 됨',    health: '컨디션이 안정적, 야외 테니스 활동 적극 권장' },
  { label: '절정기🏆', tennis: '실력이 최고조! 대회 도전과 리그 참가에 최적의 해',                   money: '재물운 최상, 과감한 결정도 성과로 이어진다',              relation: '귀인 등장, 인간관계가 폭발적으로 확장되는 시기',        health: '에너지 넘치는 해, 과로 방지를 위한 체력 관리 필수' },
  { label: '안정기☀️', tennis: '안정적인 실력 유지, 후배 멘토링과 팀 리딩에 적합',                   money: '안정적인 수입, 무리하지 않고 유지하는 게 최선',            relation: '편안하고 따뜻한 인간관계가 이어지는 여유로운 시기',    health: '몸과 마음 모두 안정, 충분한 수면과 휴식을 챙길 것' },
  { label: '전환점🔄', tennis: '새로운 플레이 스타일 탐색이 필요한 변화의 시기',                     money: '변화 기회를 유연하게 포착할 것, 고정관념을 버릴 때',      relation: '관계의 변화·재편이 일어나는 해, 새 멤버와의 인연',      health: '몸의 신호에 귀 기울이고 과부하 주의' },
  { label: '성찰기🪞', tennis: '자신의 약점을 냉철하게 파악하고 보완하는 내실 다지기의 해',           money: '낭비를 줄이고 장기 플랜을 다시 세우는 시기',              relation: '깊은 관계는 더 깊어지고 피상적 관계는 자연히 정리됨',  health: '스트레스 관리와 정신 건강이 핵심 과제' },
  { label: '준비기🔧', tennis: '체계적인 훈련 계획을 세우면 내년이 확실히 달라진다',                 money: '미래를 위한 저축과 작은 투자를 시작하기 좋은 때',          relation: '소중한 사람들과의 유대를 더 단단하게 만드는 시기',      health: '부족한 부분을 보완하는 재활·보강 운동 적기' },
  { label: '수확기🍂', tennis: '오랜 훈련의 결과가 경기에서 빛나는 보람찬 해',                       money: '그동안의 노력이 금전적 보상으로 돌아오는 시기',            relation: '오래된 인연에서 깊은 감사와 유대를 느끼는 해',          health: '전반적으로 컨디션 최상, 적극적인 활동 권장' },
  { label: '마무리기🏁', tennis: '시즌을 잘 마무리하고 충분한 휴식과 회복에 투자',                   money: '정리와 결산의 시기, 불필요한 지출과 부채 청산',            relation: '묵은 오해를 풀고 인간관계를 깔끔하게 정리',            health: '과로 주의, 충분한 수면과 영양 관리 필수' },
  { label: '임박기🌅', tennis: '새 시즌을 위한 몸과 마음의 준비를 지금 시작할 것',                   money: '새로운 기회가 문 앞까지 와 있는 전환 직전 시기',          relation: '새 인연을 맞이할 마음의 공간을 비울 것',                health: '작은 증상도 무시하지 말고 조기에 대처할 것' },
];

async function _botFortune(msgText) {
  const currentYear = new Date().getFullYear();
  const d = new Date().toLocaleDateString('ko-KR', { month:'long', day:'numeric' });

  // 출생연도 파싱
  let birthYear = null;
  let memberName = null;

  if (msgText) {
    // 1순위: 멤버 이름 감지 → DB에서 birthday 조회 (성 제외한 이름도 매칭)
    const membSnap = await db.ref('jmt/members').once('value');
    const allMembers = Object.values(membSnap.val() || {}).filter(m => m.name && !m.isGuest);
    const _fn = n => n && n.length >= 3 ? n.slice(1) : n;
    for (const m of allMembers) {
      if ((msgText.includes(m.name) || msgText.includes(_fn(m.name))) && m.birthday) {
        birthYear = parseInt(m.birthday.split('-')[0]);
        memberName = m.name;
        break;
      }
    }
    // 2순위: 4자리 연도 또는 2자리 연도 (년생/년 모두 허용)
    if (!birthYear) {
      const m4 = msgText.match(/(\d{4})년/);
      const m2 = msgText.match(/(\d{2})년(?:생)?/);
      if (m4) birthYear = parseInt(m4[1]);
      else if (m2) { const y2 = parseInt(m2[1]); birthYear = y2 >= 0 && y2 <= 30 ? 2000 + y2 : 1900 + y2; }
    }
    if (birthYear && (birthYear < 1900 || birthYear > currentYear)) birthYear = null;
  }

  // ── 출생연도 있을 때: 7년 사이클 운세 ─────────────────────────────
  if (birthYear) {
    const zodiacIdx = ((birthYear - 2020) % 12 + 1200) % 12;
    const zName  = _ZODIAC_NAMES[zodiacIdx];
    const zEmoji = _ZODIAC_EMOJIS[zodiacIdx];
    const age    = currentYear - birthYear;
    const header = memberName
      ? `🔮 ${memberName}님 (${birthYear}년생 ${zEmoji}${zName}띠 · 만 ${age}세)`
      : `🔮 ${birthYear}년생 ${zEmoji}${zName}띠 · 만 ${age}세`;
    const lines = [];
    for (let yr = currentYear - 3; yr <= currentYear + 3; yr++) {
      const pos    = ((yr - birthYear) % 12 + 12) % 12;
      const cyc    = _CYCLE_DATA[pos];
      const isNow  = yr === currentYear;
      const prefix = isNow ? `★ ${yr}년 (${age}세)` : yr < currentYear ? `◀ ${yr}년` : `▶ ${yr}년`;
      lines.push(`${prefix}  [${cyc.label}]\n   🎾 ${cyc.tennis}`);
    }
    const curPos = ((currentYear - birthYear) % 12 + 12) % 12;
    const curCyc = _CYCLE_DATA[curPos];
    return { text: `${header}\n── 7년 운세 흐름 (-3 ~ +3) ──\n\n${lines.join('\n')}\n\n── ${currentYear}년 집중 포인트 ──\n💰 ${curCyc.money}\n❤️ ${curCyc.relation}\n🏃 ${curCyc.health}` };
  }

  // ── 띠 키워드만 있을 때: 오늘의 운세 ─────────────────────────────
  let zodiacIdx = -1;
  if (msgText) {
    for (let i = 0; i < _ZODIAC_NAMES.length; i++) {
      if (msgText.includes(_ZODIAC_NAMES[i])) { zodiacIdx = i; break; }
    }
  }
  if (zodiacIdx < 0) {
    const dayOfYear = Math.floor((Date.now() - new Date(currentYear, 0, 0)) / 86400000);
    zodiacIdx = dayOfYear % 12;
  }
  const zName  = _ZODIAC_NAMES[zodiacIdx];
  const zEmoji = _ZODIAC_EMOJIS[zodiacIdx];
  const fortunes = _ZODIAC_FORTUNES[zodiacIdx];
  const dayKey = new Date().toLocaleDateString('ko-KR');
  const fIdx = (dayKey.split('').reduce((a, c) => a + c.charCodeAt(0), 0) + zodiacIdx) % fortunes.length;
  return { text: `🔮 ${d} ${zEmoji}${zName}띠 운세\n\n${fortunes[fIdx]}\n\n─────────────────\n생년도 함께 말하면 7년 운세 흐름을 알려드려요!\n예) "1984년 운세" / "90년생 운세"` };
}

// ── 공지사항 전송 (관리자 UI에서 callable로 호출) ──────────────────
// HTML → 순수 텍스트 변환 (채팅 전송용)
function _htmlToPlainText(html) {
  return (html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

exports.sendNoticeAsBot = onCall({ region: 'asia-southeast1' }, async (req) => {
  const senderName = req.data.senderName || '';
  const noticeId   = req.data.noticeId   || '';
  if (!_BOT_MANAGERS.includes(senderName)) throw new Error('권한 없음');
  const snap = await db.ref(`jmt/notices/${noticeId}`).once('value');
  const notice = snap.val();
  if (!notice) throw new Error('공지 없음');
  // 자미톡에 공지 카드 메시지 게시 (type:'notice' — 클라이언트에서 카드 렌더링)
  await _postBotMsg({
    type: 'notice',
    noticeId:      noticeId,
    noticeTitle:   notice.title   || '',
    noticeContent: notice.content || '',
    text: `📢 ${notice.title || '공지사항'}`, // 푸시 미리보기·검색용
  });
  // 전체 멤버에게 FCM 푸시 (쿨다운 없이 항상 발송)
  const tokens = await getAllTokens();
  const pushTitle = `📢 공지사항${notice.title ? ` — ${notice.title}` : ''}`;
  const plainBody = _htmlToPlainText(notice.content);
  const pushBody  = plainBody.length > 60 ? plainBody.slice(0, 60) + '…' : plainBody;
  await sendPush(tokens, pushTitle, pushBody, 'matches', '', '', { subScreen: 'notices' });
  return { ok: true };
});

// ── 메인 트리거 함수 ───────────────────────────────────────────────
exports.handleBotTriggers = onValueCreated(
  { ref: 'jmt/banzige/current/messages/{msgId}', region: 'asia-southeast1' },
  async (event) => {
    try {
      const msg = event.data.val();
      if (!msg || msg.realName === _BOT_NAME) return;
      // LLM OFF 상태면 무응답
      const llmConfigSnap = await db.ref('jmt/botConfig/llmDisabled').once('value');
      if (llmConfigSnap.val()) return;
      // 제이 말풍선 reply + 사진만 첨부(텍스트 없음)도 허용
      const hasImage = !!(msg.imageUrl || (msg.photos && msg.photos[0]));
      const isReplyToBot = !!(msg.replyTo && msg.replyTo.realName === _BOT_NAME);
      // 텍스트 없어도 제이 말풍선 reply + 사진 첨부면 허용
      if (!msg.text && !(hasImage && isReplyToBot)) return;
      const text = (msg.text || '').trim();
      // 가명 모드에서는 alias로 응대 (일반 채팅에서는 alias === realName)
      const senderName = msg.alias || msg.realName || '';

      // 제이 호칭 또는 제이 말풍선 reply → AI 응답 우선 처리
      const aiMentionMatch = text.match(/^제이[,!. ]*(.*)/s);
      if (aiMentionMatch || isReplyToBot) {
        const question = aiMentionMatch ? (aiMentionMatch[1].trim() || '안녕!') : text;
        // 운세 키워드 → LLM 우회, 룰베이스 직접 처리
        if (/운세|띠/.test(question)) {
          const result = await _botFortune(question);
          if (result) await _postBotMsg(result);
          return;
        }
        // 이미지 소스 우선순위: ① 현재 메시지에 직접 첨부한 사진 ② reply한 원본 메시지의 사진
        let replyImageUrl = msg.imageUrl || (msg.photos && msg.photos[0]) || null;
        let replyBotText = null; // 제이 말풍선에 reply한 경우 원본 봇 답변
        if (msg.replyTo && msg.replyTo.msgKey) {
          try {
            const origSnap = await db.ref(`${_BOT_BZ_REF}/messages/${msg.replyTo.msgKey}`).once('value');
            const origMsg = origSnap.val();
            if (origMsg) {
              // 현재 메시지에 첨부 사진 없을 때만 원본 메시지 이미지 사용
              if (!replyImageUrl) replyImageUrl = origMsg.imageUrl || (origMsg.photos && origMsg.photos[0]) || null;
              // 제이 말풍선에 reply한 경우 → 원본 답변 텍스트 보관
              if (origMsg.realName === _BOT_NAME && origMsg.text) replyBotText = origMsg.text;
            }
          } catch(_) {}
        }
        // 타이핑 인디케이터 먼저 표시 (최소 0.5초 노출)
        const typingRef = db.ref(`${_BOT_BZ_REF}/messages`).push();
        const typingShownAt = Date.now();
        await typingRef.set({
          alias: _BOT_NAME, realName: _BOT_NAME, ts: Date.now(), typing: true, text: '...',
        });
        // 최근 채팅 히스토리 (현재 메시지 이전 최대 60개)
        const histSnap = await db.ref(`${_BOT_BZ_REF}/messages`)
          .orderByChild('ts').limitToLast(60).once('value');
        const histRaw = histSnap.val() || {};
        // 제이와의 대화만 추출 (질문 + 제이 답변) — "제이" 호칭 또는 제이에게 reply한 메시지 포함
        const botExchanges = Object.values(histRaw)
          .filter(m => m.ts < msg.ts && m.text && m.type !== 'restaurant'
            && (m.realName === _BOT_NAME || /^제이[,!. ]/i.test(m.text || '') || (m.replyTo && m.replyTo.realName === _BOT_NAME)))
          .sort((a, b) => a.ts - b.ts);
        // 마지막 제이 답변 시간 확인 — 5분 쿨타임
        const lastBotMsg = [...botExchanges].reverse().find(m => m.realName === _BOT_NAME);
        const isActiveSession = lastBotMsg && (msg.ts - lastBotMsg.ts) < 5 * 60 * 1000;
        // 활성 세션: 최근 4개(2쌍) / 신규 세션: 마지막 1쌍만
        const histSlice = isActiveSession ? botExchanges.slice(-4) : botExchanges.slice(-2);
        const history = histSlice.map(m => ({
          role: m.realName === _BOT_NAME ? 'assistant' : 'user',
          content: m.realName !== _BOT_NAME
            ? `${m.alias || m.realName || '멤버'}: ${m.text.replace(/^제이[,!. ]*/i, '').trim()}`
            : m.text,
        }));
        // 제이 말풍선 reply이고 해당 봇 답변이 히스토리에 없으면 맨 끝에 추가
        if (replyBotText) {
          const alreadyInHistory = history.some(h => h.role === 'assistant' && h.content === replyBotText);
          if (!alreadyInHistory) history.push({ role: 'assistant', content: replyBotText });
        }
        const result = await _botAI(question, senderName, history, replyImageUrl);
        // 타이핑 인디케이터 최소 0.5초 노출 후 제거
        const elapsed = Date.now() - typingShownAt;
        if (elapsed < 500) await new Promise(r => setTimeout(r, 500 - elapsed));
        await typingRef.remove();
        if (result) await _postBotMsg(result);
        return;
      }

      let trigger = null;
      for (const { key, pattern } of _BOT_TRIGGERS) {
        if (pattern.test(text)) { trigger = key; break; }
      }
      if (!trigger) return;

      // 쿨다운 체크
      const coolMs = _BOT_COOLDOWN[trigger];
      if (coolMs) {
        if (trigger === 'fortune') {
          // 운세: 사람별 하루 10회 무제한, 11회째부터 1시간 쿨다운
          const today = new Date().toLocaleDateString('ko-KR');
          const nameKey = senderName.replace(/[.#$[\]/]/g, '_');
          const coolRef = db.ref(`jmt/botCooldown/fortune/${nameKey}`);
          const coolSnap = await coolRef.once('value');
          const prev = coolSnap.val() || {};
          const count = prev.date === today ? (prev.count || 0) : 0;
          if (count >= 10 && Date.now() - (prev.lastTs || 0) < coolMs) return;
          await coolRef.set({ date: today, count: count + 1, lastTs: Date.now() });
        } else {
          // 나머지: 트리거별 쿨다운
          const coolRef = db.ref(`jmt/botCooldown/${trigger}`);
          const coolSnap = await coolRef.once('value');
          if (Date.now() - (coolSnap.val() || 0) < coolMs) return;
          await coolRef.set(Date.now());
        }
      }

      let result;
      switch (trigger) {
        case 'member_ranking': result = await _botMemberRanking(text); break;
        case 'member_checkin': result = await _botMemberCheckin(text); break;
        case 'ranking_ind':   result = await _botRankingInd(); break;
        case 'ranking_pair':  result = await _botRankingPair(); break;
        case 'ranking_att':   result = await _botRankingAtt(); break;
        case 'schedule':      result = await _botSchedule(); break;
        case 'checkin':       result = await _botCheckin(); break;
        case 'todaymatch':    result = await _botTodayMatch(); break;
        case 'weather':       result = await _botWeather(text); break;
        case 'air':           result = await _botAir(text); break;
        case 'fortune':       result = await _botFortune(text); break;
      }
      if (result) await _postBotMsg(result);
    } catch (e) {
      console.error('handleBotTriggers error:', e);
    }
  }
);
