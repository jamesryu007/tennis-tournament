/**
 * backfill-bet-history.js
 * jmt/atpBets 에서 open:false인 베팅을 jmt/atpBetsHistory/{tId}/{betId} 로 한 번만 복사
 *
 * tId는 jmt/atpData.tournamentInfo.id 를 자동으로 읽음
 * 직접 지정하려면: node backfill-bet-history.js <tournamentId>
 *
 * 실행: node backfill-bet-history.js
 */
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

initializeApp({
  credential: applicationDefault(),
  databaseURL: 'https://jamite-tennis-default-rtdb.asia-southeast1.firebasedatabase.app',
});

const db = getDatabase();

async function main() {
  // 1. tId 결정
  let tId = process.argv[2] || null;

  if (!tId) {
    const atpSnap = await db.ref('jmt/atpData/tournamentInfo').once('value');
    const ti = atpSnap.val();
    if (!ti || !ti.id) {
      console.error('❌ jmt/atpData.tournamentInfo.id 를 찾을 수 없습니다. 인자로 직접 전달하세요: node backfill-bet-history.js <tournamentId>');
      process.exit(1);
    }
    tId = ti.id;
    console.log(`ℹ️  대회 ID 자동 감지: ${tId} (${ti.name || ''})`);
  } else {
    console.log(`ℹ️  대회 ID 수동 지정: ${tId}`);
  }

  // 2. 닫힌 베팅 읽기
  const betsSnap = await db.ref('jmt/atpBets').once('value');
  const bets = betsSnap.val() || {};
  const closedBets = Object.entries(bets).filter(([, b]) => b.open === false);

  if (!closedBets.length) {
    console.log('✅ CLOSED 베팅 없음 — 백필 불필요');
    process.exit(0);
  }

  console.log(`📋 CLOSED 베팅 ${closedBets.length}건 발견`);

  // 3. 이미 히스토리에 있는 항목 확인
  const histSnap = await db.ref(`jmt/atpBetsHistory/${tId}`).once('value');
  const existing = histSnap.val() || {};

  let copied = 0;
  let skipped = 0;

  for (const [betId, bet] of closedBets) {
    if (existing[betId]) {
      console.log(`  ⏭  ${betId} — 이미 존재, 스킵`);
      skipped++;
      continue;
    }
    await db.ref(`jmt/atpBetsHistory/${tId}/${betId}`).set(bet);
    console.log(`  ✅ ${betId} — 복사 완료 (${bet.tournamentName || ''})`);
    copied++;
  }

  console.log(`\n완료: ${copied}건 복사, ${skipped}건 스킵`);
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
