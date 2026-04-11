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
}

// ── 베팅 자동 결과 처리 (winner + match 타입 모두) ──────────────────
async function autoProcessWinnerBet(matches) {
  const matchList = matches || [];

  // Final 경기 (우승자 맞추기용)
  const finalMatch = matchList.find(m => {
    const rn = (m.roundName || '').toLowerCase();
    return (rn === 'final' || rn === 'the final')
      && !rn.includes('semi') && !rn.includes('qualify')
      && m.status === 'STATUS_FINAL'
      && (m.player1Winner === true || m.player2Winner === true);
  });

  const betsSnap = await db.ref('jmt/atpBets').once('value');
  const bets = betsSnap.val() || {};
  const now = new Date().toISOString();

  for (const [betId, bet] of Object.entries(bets)) {
    if (bet.result) continue; // 이미 처리됨
    if (!bet.open) continue;  // 이미 close된 베팅은 skip

    let winnerName = null;
    let winnerId = null;

    if (bet.type === 'winner') {
      // 우승자 맞추기: Final 경기 승자
      if (!finalMatch) continue;
      winnerName = finalMatch.player1Winner ? finalMatch.player1Name : finalMatch.player2Name;
      winnerId   = finalMatch.player1Winner ? finalMatch.player1Id   : finalMatch.player2Id;
    } else {
      // 경기 베팅: bet.matchId로 해당 경기 찾기
      if (!bet.matchId) continue;
      const m = matchList.find(m => m.id === bet.matchId && m.status === 'STATUS_FINAL'
        && (m.player1Winner === true || m.player2Winner === true));
      if (!m) continue;
      winnerName = m.player1Winner ? m.player1Name : m.player2Name;
      winnerId   = m.player1Winner ? m.player1Id   : m.player2Id;
    }

    if (!winnerName) continue;

    console.log(`autoProcessBet: betId=${betId}, type=${bet.type||'match'}, winner=${winnerName}`);
    await db.ref(`jmt/atpBets/${betId}/result`).set({
      winnerName,
      winnerId: winnerId || '',
      setAt: now,
      auto: true,
    });
    await db.ref(`jmt/atpBets/${betId}`).update({ open: false, closedAt: now });
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

// ══ 13. 개인 랭킹 1~3위 변동 감지 ════════════════════════════════
function computePlayerTop3(stats) {
  const effWr = (w, d, l) => { const t = w+(d||0)+l; return t ? ((w+(d||0)*0.5)/t*100) : 0; };
  const players = Object.entries(stats || {})
    .map(([name, v]) => ({ name, wins: v.wins||0, draws: v.draws||0, losses: v.losses||0 }))
    .filter(p => p.wins+p.draws+p.losses >= 1);
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
    const before = computePlayerTop3(event.data.before.val());
    const after  = computePlayerTop3(event.data.after.val());
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
function computePairTop3(stats) {
  const effWr = (w, d, l) => { const t = w+(d||0)+l; return t ? ((w+(d||0)*0.5)/t*100) : 0; };
  const pairs = Object.entries(stats || {})
    .map(([key, v]) => ({ key, wins: v.wins||0, draws: v.draws||0, losses: v.losses||0, nickname: v.nickname, players: v.players||key.split('_') }))
    .filter(p => p.wins+p.draws+p.losses >= 1);
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
    const before = computePairTop3(event.data.before.val());
    const after  = computePairTop3(event.data.after.val());
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
    return json.translated || texts;
  } catch(e) {
    console.warn('translateTexts error:', e.message);
    return texts;
  }
}

// ══ 모임 정하기 푸시 ══════════════════════════════════════════════

// 투표 생성 시 전체 알림
exports.notifyMeetingPollOpen = onValueCreated(
  { ref: 'jmt/meetingPoll/status', region: 'asia-southeast1' },
  async snap => {
    if (snap.val() !== 'open') return;
    const pollSnap = await db.ref('jmt/meetingPoll').once('value');
    const poll = pollSnap.val();
    if (!poll) return;
    const tokens = await getAllTokens();
    await sendPush(tokens, '📅 모임 정하기 투표 오픈!', `"${poll.title||'모임 정하기'}" 투표에 참여해 주세요!`, 'setup');
  }
);

// 투표 마감 시 전체 알림
exports.notifyMeetingPollClosed = onValueWritten(
  { ref: 'jmt/meetingPoll/status', region: 'asia-southeast1' },
  async snap => {
    if (snap.data.after.val() !== 'closed') return;
    const pollSnap = await db.ref('jmt/meetingPoll').once('value');
    const poll = pollSnap.val();
    if (!poll) return;

    // 날짜 투표 결과 계산
    let resultMsg = '';
    const votes = poll.votes || {};
    if (poll.type === 'date' || poll.type === 'both') {
      const dateCounts = {};
      (poll.dates || []).forEach(d => { dateCounts[d] = 0; });
      Object.values(votes).forEach(v => {
        if (!v.dates) return;
        Object.keys(v.dates).forEach(dk => { if (v.dates[dk] && dateCounts.hasOwnProperty(dk)) dateCounts[dk]++; });
      });
      const mx = Math.max(...Object.values(dateCounts), 0);
      const winners = Object.entries(dateCounts).filter(([,c]) => c === mx && mx > 0).map(([d]) => d).sort();
      if (winners.length) {
        const weekDays = ['일','월','화','수','목','금','토'];
        const labels = winners.map(d => {
          const o = new Date(d + 'T00:00:00');
          return `${o.getMonth()+1}월 ${o.getDate()}일(${weekDays[o.getDay()]})`;
        }).join(', ');
        resultMsg = `${poll.title||'모임'}이 ${labels}로 결정되었습니다! 🎉`;
      }
    } else if (poll.type === 'content') {
      const contentCounts = {};
      (poll.contents || []).forEach((_, i) => { contentCounts[i] = 0; });
      Object.values(votes).forEach(v => {
        if (!v.contents) return;
        Object.keys(v.contents).forEach(i => { const n=Number(i); if(v.contents[i]&&contentCounts.hasOwnProperty(n)) contentCounts[n]++; });
      });
      const mx = Math.max(...Object.values(contentCounts), 0);
      const winners = Object.entries(contentCounts).filter(([,c]) => c === mx && mx > 0).map(([i]) => (poll.contents||[])[Number(i)]).filter(Boolean);
      if (winners.length) resultMsg = `최다 선택: ${winners.join(', ')} 🎉`;
    }

    const tokens = await getAllTokens();
    await sendPush(tokens, '🏆 모임 정하기 투표 결과!', resultMsg || `"${poll.title||'모임 정하기'}" 투표가 마감되었습니다.`, 'setup');
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

      // 이전 뉴스와 비교 — 첫 번째 기사 URL이 같으면 번역/저장 스킵
      const prev = await db.ref('jmt/atpNews/articles/0/url').once('value');
      if (prev.val() && prev.val() === items[0].url) {
        console.log('fetchAtpNews: no new articles, skip');
        return;
      }

      // 헤드라인 + 설명 번역
      const toTranslate = items.flatMap(a => [a.headline, a.description]);
      const translated  = await translateTexts(toTranslate);
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
