/**
 * 베팅 테스트 데이터 시드 스크립트 (jamite-dev)
 * 항목 3~6 테스트용
 * 실행: cd functions && node ../seed-test-bets.js
 */
const admin = require('firebase-admin');
const sa    = require('./jamite-dev-service-account.json');

admin.initializeApp({
  credential:  admin.credential.cert(sa),
  databaseURL: 'https://jamite-dev-default-rtdb.asia-southeast1.firebasedatabase.app',
});
const db = admin.database();

const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();

// ── 현재 토너먼트 정보 (테스트용) ─────────────────────────────────
const tournamentInfo = {
  id: 'test-roland-garros-2026',
  name: 'French Open',
  shortName: 'Roland Garros',
  displayName: 'French Open · Paris',
  tier: 'grandslam',
  venueName: 'Stade Roland Garros',
  venueCity: 'Paris',
  venueCountry: 'France',
  startDate: iso(now - 5 * 86400000),
  endDate:   iso(now + 9 * 86400000),
  updatedAt: iso(now),
};

// ── 베팅 데이터 ────────────────────────────────────────────────────

// [항목 3] 마감 시간이 있는 OPEN 베팅 (우승자 맞추기)
const betW_open = {
  type: 'winner',
  open: true,
  tournamentName: 'French Open',
  stake: '우승자 맞추면 다음 모임 음료 쏘기 🎾',
  deadlineAt: iso(now + 18 * 3600 * 1000),   // 18시간 후 마감
  openedBy: '유지원',
  openedAt: iso(now - 2 * 3600 * 1000),
  // [항목 4] 여러 멤버 베팅 (% 현황 테스트)
  bets: {
    '유지원':  { playerName: 'Carlos Alcaraz', votedAt: iso(now - 90 * 60000) },
    '배성두':  { playerName: 'Carlos Alcaraz', votedAt: iso(now - 80 * 60000) },
    '천지은':  { playerName: 'Carlos Alcaraz', votedAt: iso(now - 70 * 60000) },
    '김승수':  { playerName: 'Jannik Sinner',  votedAt: iso(now - 60 * 60000) },
    '이하영':  { playerName: 'Jannik Sinner',  votedAt: iso(now - 50 * 60000) },
    '지정열':  { playerName: 'Novak Djokovic', votedAt: iso(now - 40 * 60000) },
    '강형경':  { playerName: 'Carlos Alcaraz', votedAt: iso(now - 30 * 60000) },
    '이지은':  { playerName: 'Rafael Nadal',   votedAt: iso(now - 20 * 60000) },
  },
  // [항목 5] 댓글
  comments: {
    cmt1: { author: '배성두', text: '알카라스 이번엔 진짜 우승하겠는데요? 🔥', at: iso(now - 85 * 60000) },
    cmt2: { author: '유지원', text: '흙에서 알카라스 막을 선수가 없지 ㅋㅋ', at: iso(now - 75 * 60000) },
    cmt3: { author: '김승수', text: '시너 요즘 너무 좋던데... 저만 시너 찍었나요 😅', at: iso(now - 55 * 60000) },
    cmt4: { author: '천지은', text: '올해는 무조건 알카라스! 베팅 완료 🎯', at: iso(now - 45 * 60000) },
    cmt5: { author: '이지은', text: '나달 은퇴 전 마지막 우승 도전... 화이팅!', at: iso(now - 15 * 60000) },
  },
};

// [항목 3] 마감 시간이 있는 OPEN 베팅 (경기 베팅)
const betM_open = {
  type: 'match',
  open: true,
  matchId: 'sf1_test',
  matchName: 'SF: Alcaraz vs Sinner',
  player1Id: 'alcaraz',
  player1Name: 'Carlos Alcaraz',
  player2Id: 'sinner',
  player2Name: 'Jannik Sinner',
  stake: '진 팀 다음 대회 공 구매 🎾',
  deadlineAt: iso(now + 6 * 3600 * 1000),   // 6시간 후 마감
  openedBy: '유지원',
  openedAt: iso(now - 1 * 3600 * 1000),
  // [항목 4] % 현황 테스트
  bets: {
    '유지원':  { playerName: 'Carlos Alcaraz', playerId: 'alcaraz', votedAt: iso(now - 50 * 60000) },
    '배성두':  { playerName: 'Carlos Alcaraz', playerId: 'alcaraz', votedAt: iso(now - 45 * 60000) },
    '천지은':  { playerName: 'Jannik Sinner',  playerId: 'sinner',  votedAt: iso(now - 40 * 60000) },
    '김승수':  { playerName: 'Jannik Sinner',  playerId: 'sinner',  votedAt: iso(now - 35 * 60000) },
    '강형경':  { playerName: 'Carlos Alcaraz', playerId: 'alcaraz', votedAt: iso(now - 25 * 60000) },
  },
  // [항목 5] 댓글
  comments: {
    cmt1: { author: '유지원',  text: '알카라스 vs 시너 드림매치!! 💥',          at: iso(now - 48 * 60000) },
    cmt2: { author: '천지은',  text: '시너 최근 폼 보면 이번엔 뒤집을 것 같아요', at: iso(now - 38 * 60000) },
    cmt3: { author: '배성두',  text: '홈 코트 이점 알카라스 GO GO 🏆',          at: iso(now - 28 * 60000) },
  },
};

// [항목 6] 히스토리 아카이브 — 직전 대회 베팅 결과
const historyBets = {
  'test-australian-open-2026': {
    betW_ao2026: {
      type: 'winner',
      open: false,
      tournamentName: 'Australian Open',
      stake: '우승자 맞추면 삼겹살 파티 🥩',
      deadlineAt: iso(now - 90 * 86400000 + 5 * 86400000),
      openedBy: '유지원',
      openedAt: iso(now - 95 * 86400000),
      result: { winnerName: 'Jannik Sinner', settledAt: iso(now - 88 * 86400000) },
      bets: {
        '유지원':  { playerName: 'Jannik Sinner',  votedAt: iso(now - 94 * 86400000) },
        '배성두':  { playerName: 'Carlos Alcaraz', votedAt: iso(now - 94 * 86400000) },
        '천지은':  { playerName: 'Jannik Sinner',  votedAt: iso(now - 93 * 86400000) },
        '김승수':  { playerName: 'Novak Djokovic', votedAt: iso(now - 93 * 86400000) },
        '강형경':  { playerName: 'Carlos Alcaraz', votedAt: iso(now - 92 * 86400000) },
        '이하영':  { playerName: 'Jannik Sinner',  votedAt: iso(now - 92 * 86400000) },
        '지정열':  { playerName: 'Jannik Sinner',  votedAt: iso(now - 91 * 86400000) },
        '이지은':  { playerName: 'Carlos Alcaraz', votedAt: iso(now - 91 * 86400000) },
      },
      comments: {
        c1: { author: '유지원', text: '시너 우승 예상! 🏆', at: iso(now - 93 * 86400000) },
        c2: { author: '배성두', text: '알카라스가 이번엔 가져갈 것 같은데...', at: iso(now - 92 * 86400000) },
        c3: { author: '유지원', text: '결국 시너!! 예측 성공 😄', at: iso(now - 88 * 86400000) },
      },
    },
    betM_ao2026_final: {
      type: 'match',
      open: false,
      matchId: 'ao_final_2026',
      matchName: 'F: Sinner vs Zverev',
      player1Id: 'sinner',
      player1Name: 'Jannik Sinner',
      player2Id: 'zverev',
      player2Name: 'Alexander Zverev',
      stake: '진 편 다음 번 라켓줄 교체비',
      deadlineAt: iso(now - 88 * 86400000 + 2 * 3600000),
      openedBy: '유지원',
      openedAt: iso(now - 88 * 86400000 - 3 * 86400000),
      result: { winnerName: 'Jannik Sinner', winnerId: 'sinner', settledAt: iso(now - 88 * 86400000) },
      bets: {
        '유지원':  { playerName: 'Jannik Sinner',    playerId: 'sinner',  votedAt: iso(now - 91 * 86400000) },
        '배성두':  { playerName: 'Alexander Zverev', playerId: 'zverev',  votedAt: iso(now - 91 * 86400000) },
        '천지은':  { playerName: 'Jannik Sinner',    playerId: 'sinner',  votedAt: iso(now - 90 * 86400000) },
        '김승수':  { playerName: 'Alexander Zverev', playerId: 'zverev',  votedAt: iso(now - 90 * 86400000) },
        '강형경':  { playerName: 'Jannik Sinner',    playerId: 'sinner',  votedAt: iso(now - 89 * 86400000) },
      },
    },
  },
};

async function seed() {
  console.log('🌱 테스트 데이터 시딩 시작...\n');

  // 1) 현재 대회 정보 (tournament info + 빈 matches)
  await db.ref('jmt/atpData').set({
    tournamentInfo,
    matches: [
      { id: 'm1', roundName: 'Semifinal', status: 'STATUS_SCHEDULED',
        player1Id: 'alcaraz', player1Name: 'Carlos Alcaraz', player1Country: 'ESP', player1Score: '', player1Winner: false,
        player2Id: 'sinner',  player2Name: 'Jannik Sinner',  player2Country: 'ITA', player2Score: '', player2Winner: false,
        date: iso(now + 1 * 86400000) },
      { id: 'm2', roundName: 'Semifinal', status: 'STATUS_SCHEDULED',
        player1Id: 'djokovic', player1Name: 'Novak Djokovic', player1Country: 'SRB', player1Score: '', player1Winner: false,
        player2Id: 'zverev',   player2Name: 'Alexander Zverev', player2Country: 'GER', player2Score: '', player2Winner: false,
        date: iso(now + 1 * 86400000) },
    ],
    updatedAt: iso(now),
  });
  console.log('✅ jmt/atpData — 현재 대회(Roland Garros) 설정');

  // 2) 현재 베팅 (항목 3, 4, 5)
  await db.ref('jmt/atpBets/betW_test_open').set(betW_open);
  console.log('✅ jmt/atpBets/betW_test_open — 우승자 베팅 (마감시간+투표현황+댓글)');

  await db.ref('jmt/atpBets/betM_test_open').set(betM_open);
  console.log('✅ jmt/atpBets/betM_test_open — 경기 베팅 (마감시간+투표현황+댓글)');

  // 3) 히스토리 아카이브 (항목 6)
  for (const [tId, bets] of Object.entries(historyBets)) {
    await db.ref(`jmt/atpBetsHistory/${tId}`).set(bets);
    console.log(`✅ jmt/atpBetsHistory/${tId} — 히스토리 아카이브`);
  }

  console.log('\n🎉 시딩 완료! 개발 앱에서 Live → 🎯 베팅 탭 확인하세요.');
  process.exit(0);
}

seed().catch(e => { console.error('❌ 시딩 실패:', e.message); process.exit(1); });
