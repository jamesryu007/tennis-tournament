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
async function sendPush(tokens, title, body, tab = 'checkin', commentId = '') {
  if (!tokens || tokens.length === 0) return;
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));
  for (const chunk of chunks) {
    const data = { title, body, tab };
    if (commentId) data.commentId = commentId;
    await fcm.sendEachForMulticast({
      tokens: chunk,
      data,
      webpush: { headers: { Urgency: 'high' } }
    });
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

// ══ 3. 금요일 정오 — 출첵 자동 마감 + 매니저 알림 ════════════════
exports.notifyCheckinClose = onSchedule(
  { schedule: '0 12 * * 5', timeZone: 'Asia/Seoul' },
  async () => {
    // pollState 자동 close
    const snap = await db.ref('jmt/pollState').once('value');
    const ps = snap.val();
    if (ps && ps.status === 'open') {
      await db.ref('jmt/pollState').update({ status: 'closed', closedAt: new Date().toISOString() });
    }

    const MANAGERS = ['유지원', '천지은', '김승수'];
    const tokens = await getTokensByNames(MANAGERS);
    await sendPush(tokens, '🔴 출첵이 마감되었습니다', '참석 인원을 확인하고 대진을 생성해 주세요.');
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
    for (const comp of (grp.competitions || [])) {
      const c = comp.competitors || [];
      const p1 = c[0] || {}, p2 = c[1] || {};
      const st = comp.status || {};
      matches.push({
        id:             comp.id,
        roundName:      comp.round?.displayName || grp.displayName || '',
        date:           comp.date || '',
        status:         st.type?.name || '',
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

// ── ATP 데이터 저장 공통 (토너먼트 변경 시 베팅 초기화) ──────────
async function saveAtpData(tournamentInfo, matches, isGrandSlam) {
  const updatedAt = new Date().toISOString();

  // 토너먼트 변경 여부 확인 → 바뀌면 베팅 전체 초기화
  const currentSnap = await db.ref('jmt/atpData/tournamentInfo').once('value');
  const current = currentSnap.val();
  if (current && current.id && tournamentInfo && tournamentInfo.id &&
      current.id !== tournamentInfo.id) {
    console.log(`Tournament changed: ${current.id} → ${tournamentInfo.id}. Clearing bets.`);
    await db.ref('jmt/atpBets').remove();
  }

  await db.ref('jmt/atpData').set({ tournamentInfo, matches, updatedAt });
  await saveGrandSlamIfNeeded(tournamentInfo, matches, isGrandSlam);
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

    const tokens = await getAllTokens();
    if (!hadTournament) {
      await sendPush(tokens, '🎾 대진표가 생성되었습니다!', '앱에서 이번 주 대진표를 확인하세요.', 'matches');
    } else {
      await sendPush(tokens, '🔄 대진표가 수정되었습니다!', '앱에서 변경된 대진표를 확인하세요.', 'matches');
    }
  }
);
