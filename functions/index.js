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
    } catch (e) {
      console.error('fetchAtpData error:', e);
    }
  }
);

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

// ══ ATP 세계 랭킹 주 1회 업데이트 (매주 월요일 오전 6시) ══════════
exports.fetchAtpRankings = onSchedule(
  { schedule: '0 6 * * 1', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => {
    try {
      const url = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/rankings?limit=100';
      const res  = await fetch(url);
      const json = await res.json();
      const entries = (json.rankings && json.rankings[0] && json.rankings[0].ranks) || [];
      const players = entries.map(e => ({
        rank:    e.current,
        name:    e.athlete ? `${e.athlete.firstName} ${e.athlete.lastName}` : '',
        country: e.athlete && e.athlete.flag ? e.athlete.flag.alt : '',
      })).filter(p => p.name);
      if (!players.length) { console.warn('fetchAtpRankings: empty result'); return; }
      await db.ref('jmt/atpRankings').set({ players, updatedAt: new Date().toISOString() });
      console.log(`fetchAtpRankings: saved ${players.length} players`);
    } catch (e) {
      console.error('fetchAtpRankings error:', e);
    }
  }
);

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

// ══ 모임 정하기 푸시 ══════════════════════════════════════════════

// 투표 생성 시 전체 알림
exports.notifyMeetingPollOpen = onValueCreated(
  { ref: 'jmt/meetingPoll/status', region: 'asia-southeast1' },
  async snap => {
    if (snap.data.val() !== 'open') return;
    const pollSnap = await db.ref('jmt/meetingPoll').once('value');
    const poll = pollSnap.val();
    if (!poll) return;
    const tokens = await getAllTokens();
    await sendPush(tokens, '📅 모임 정하기 투표 오픈!', `"${poll.title||'모임 정하기'}" 투표에 참여해 주세요!`, 'setup');
  }
);

// 날짜 포맷 헬퍼
function fmtDate(dateStr) {
  const weekDays = ['일','월','화','수','목','금','토'];
  const o = new Date(dateStr + 'T00:00:00');
  return `${o.getMonth()+1}월 ${o.getDate()}일(${weekDays[o.getDay()]})`;
}

// 투표 마감 시 전체 알림
exports.notifyMeetingPollClosed = onValueWritten(
  { ref: 'jmt/meetingPoll/status', region: 'asia-southeast1' },
  async snap => {
    if (snap.data.after.val() !== 'closed') return;
    const pollSnap = await db.ref('jmt/meetingPoll').once('value');
    const poll = pollSnap.val();
    if (!poll) return;

    const title = poll.title || '모임 정하기';
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
    await sendPush(tokens, '📅 모임 날짜/내용 확정!', body, 'setup');
  }
);

// 관리자 수동 독촉 푸시
exports.notifyMeetingPollNudge = onCall(
  { region: 'asia-southeast1' },
  async (request) => {
    const pollSnap = await db.ref('jmt/meetingPoll').once('value');
    const poll = pollSnap.val();
    if (!poll || poll.status !== 'open') throw new Error('진행 중인 투표가 없습니다.');

    const votes = poll.votes || {};
    const voterNames = Object.values(votes).map(v => v.name).filter(Boolean);

    // 멤버 목록 조회
    const membersSnap = await db.ref('jmt/members').once('value');
    const members = membersSnap.val() ? Object.values(membersSnap.val()).map(m => m.name) : [];
    const nonVoters = members.filter(n => !voterNames.includes(n));

    if (!nonVoters.length) return { message: '모든 멤버가 투표에 참여했습니다!' };

    const tokens = await getTokensByNames(nonVoters);
    if (!tokens.length) return { message: '독촉 알림을 보낼 대상이 없습니다.' };

    await sendPush(tokens, '🔔 모임 정하기 투표 미참여 알림', `"${poll.title||'모임 정하기'}" 투표에 아직 참여하지 않으셨습니다. 지금 참여해 주세요!`, 'setup');
    return { message: `${nonVoters.length}명에게 독촉 알림을 보냈습니다.` };
  }
);

// 자동 독촉 (하루 1회, 미참여자에게)
exports.notifyMeetingPollAutoNudge = onSchedule(
  { schedule: '0 12 * * *', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => {
    const pollSnap = await db.ref('jmt/meetingPoll').once('value');
    const poll = pollSnap.val();
    if (!poll || poll.status !== 'open') return;

    const votes = poll.votes || {};
    const voterNames = Object.values(votes).map(v => v.name).filter(Boolean);
    const membersSnap = await db.ref('jmt/members').once('value');
    const members = membersSnap.val() ? Object.values(membersSnap.val()).map(m => m.name) : [];
    const nonVoters = members.filter(n => !voterNames.includes(n));
    if (!nonVoters.length) return;

    const tokens = await getTokensByNames(nonVoters);
    if (!tokens.length) return;
    await sendPush(tokens, '📅 모임 정하기 투표 미참여 알림', `"${poll.title||'모임 정하기'}" 투표에 참여해 주세요!`, 'setup');
  }
);

// ══ 모임 투표 마감 시간 자동 처리 (30분마다) ════════════════════
exports.checkMeetingPollDeadline = onSchedule(
  { schedule: '*/30 * * * *', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => {
    const pollSnap = await db.ref('jmt/meetingPoll').once('value');
    const poll = pollSnap.val();
    if (!poll || poll.status !== 'open' || !poll.closesAt) return;
    if (new Date(poll.closesAt) > new Date()) return;
    const closedAt = new Date().toISOString();
    const pollId = (poll.createdAt||Date.now()).toString().replace(/[:.]/g,'_');
    await db.ref('jmt/meetingPoll/status').set('closed');
    await db.ref('jmt/meetingPoll/closedAt').set(closedAt);
    await db.ref(`jmt/meetingPollsHistory/${pollId}`).set({...poll, status:'closed', closedAt});
    // notifyMeetingPollClosed DB trigger fires automatically on status change
  }
);

// ══ 모임 투표 댓글 알림 — DB 트리거 (전체) ══════════════════════
exports.notifyMeetingPollComment = onValueCreated(
  { ref: 'jmt/meetingPoll/comments/{commentId}', region: 'asia-southeast1' },
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
  { ref: 'jmt/meetingPoll/comments/{commentId}/replies/{replyId}', region: 'asia-southeast1' },
  async (event) => {
    const reply = event.data.val();
    if (!reply) return;
    const { author, text } = reply;
    if (!author) return;
    const commentSnap = await db.ref(`jmt/meetingPoll/comments/${event.params.commentId}`).once('value');
    const comment = commentSnap.val();
    if (!comment || !comment.author || comment.author === author) return;
    const tokens = await getTokensByNames([comment.author]);
    await sendPush(tokens, `💬 ${author}님이 답글을 달았습니다`, text, 'setup', event.params.commentId);
  }
);

// ══ 모임 최종결정 알림 ════════════════════════════════════════════
exports.notifyMeetingPollFinalDecision = onValueWritten(
  { ref: 'jmt/meetingPoll/finalDecision', region: 'asia-southeast1' },
  async (event) => {
    const fd = event.data.after.val();
    if (!fd) return;

    const pollSnap = await db.ref('jmt/meetingPoll').once('value');
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

const _BOT_NAME = '자미봇';
const _BOT_BZ_REF = 'jmt/banzige/current';
const _BOT_MANAGERS = ['유지원', '천지은', '김승수'];

// 트리거별 쿨다운 (ms) — DB: jmt/botCooldown/{trigger}
const _BOT_COOLDOWN = {
  ranking_ind:  10 * 60 * 1000,  // 10분
  ranking_pair: 10 * 60 * 1000,  // 10분
  ranking_att:  10 * 60 * 1000,  // 10분
  schedule:      5 * 60 * 1000,  //  5분
  checkin:       5 * 60 * 1000,  //  5분
  todaymatch:    3 * 60 * 1000,  //  3분
  weather:      10 * 60 * 1000,  // 10분
  air:          10 * 60 * 1000,  // 10분
  fortune:      60 * 60 * 1000,  //  1시간
};

// 구체적인 패턴이 앞에 위치해야 먼저 매칭됨
const _BOT_TRIGGERS = [
  { key: 'ranking_pair', pattern: /팀\s*(페어\s*)?랭킹|팀페어|복식\s*랭킹|페어\s*랭킹|팀\s*순위|페어\s*순위/ },
  { key: 'ranking_att',  pattern: /출석\s*랭킹|출석\s*순위|개근\s*순위/ },
  { key: 'ranking_ind',  pattern: /개인\s*랭킹|개인\s*순위|싱글\s*랭킹|랭킹|순위/ },
  { key: 'schedule',     pattern: /일정|다음\s*모임|이번\s*모임|모임\s*언제|언제\s*모임|몇\s*명|모임\s*날|정기\s*모임/ },
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
      const locMatch = msgText.replace(/날씨.*/, '').replace(/.*에서/, '').replace(/.*의/, '').trim();
      if (locMatch && locMatch.length >= 2 && locMatch.length <= 10) {
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
    // 1순위: 멤버 이름 감지 → DB에서 birthday 조회
    const membSnap = await db.ref('jmt/members').once('value');
    const allMembers = Object.values(membSnap.val() || {}).filter(m => m.name && !m.isGuest);
    for (const m of allMembers) {
      if (msgText.includes(m.name) && m.birthday) {
        birthYear = parseInt(m.birthday.split('-')[0]);
        memberName = m.name;
        break;
      }
    }
    // 2순위: 4자리 연도 또는 2자리 년생
    if (!birthYear) {
      const m4 = msgText.match(/(\d{4})년/);
      const m2 = msgText.match(/(\d{2})년생/);
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
exports.sendNoticeAsBot = onCall({ region: 'asia-southeast1' }, async (req) => {
  const senderName = req.data.senderName || '';
  const noticeId   = req.data.noticeId   || '';
  if (!_BOT_MANAGERS.includes(senderName)) throw new Error('권한 없음');
  const snap = await db.ref(`jmt/notices/${noticeId}`).once('value');
  const notice = snap.val();
  if (!notice) throw new Error('공지 없음');
  const titleLine = notice.title ? `[${notice.title}]\n` : '';
  const botText = `📢 공지사항\n\n${titleLine}${notice.content}\n\n— ${notice.createdBy}`;
  // 자미톡에 봇 메시지 게시
  await _postBotMsg({ text: botText });
  // 전체 멤버에게 FCM 푸시 (쿨다운 없이 항상 발송)
  const tokens = await getAllTokens();
  const pushTitle = `📢 공지사항${notice.title ? ` — ${notice.title}` : ''}`;
  const pushBody  = notice.content.length > 60 ? notice.content.slice(0, 60) + '…' : notice.content;
  await sendPush(tokens, pushTitle, pushBody, 'matches', '', '', { subScreen: 'notices' });
  return { ok: true };
});

// ── 메인 트리거 함수 ───────────────────────────────────────────────
exports.handleBotTriggers = onValueCreated(
  { ref: 'jmt/banzige/current/messages/{msgId}', region: 'asia-southeast1' },
  async (event) => {
    try {
      const msg = event.data.val();
      if (!msg || !msg.text || msg.realName === _BOT_NAME) return;
      const text = (msg.text || '').trim();
      const senderName = msg.realName || '';

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
