/**
 * recalc-stats.js
 * 2026년 pairStats/playerStats/pairMatchups/playerMatchups 전체 초기화 후
 * jmt/matches에서 source:'daily'인 경기만 읽어 재계산
 *
 * 실행: GOOGLE_APPLICATION_CREDENTIALS 없이 Firebase CLI 토큰 사용
 *   node recalc-stats.js
 */
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');

initializeApp({
  credential: applicationDefault(),
  databaseURL: 'https://jamite-tennis-default-rtdb.asia-southeast1.firebasedatabase.app',
});

const db = getDatabase();

function getPairKey(p1, p2) {
  return [p1, p2].sort().join('_');
}

async function main() {
  const YEAR = '2026';

  // 1. 기존 2026 stats 전체 삭제
  console.log('Deleting existing 2026 stats...');
  await Promise.all([
    db.ref(`jmt/pairStats/${YEAR}`).remove(),
    db.ref(`jmt/playerStats/${YEAR}`).remove(),
    db.ref(`jmt/pairMatchups/${YEAR}`).remove(),
    db.ref(`jmt/playerMatchups/${YEAR}`).remove(),
  ]);
  console.log('Deleted.');

  // 2. matches 읽기
  const matchSnap = await db.ref('jmt/matches').once('value');
  const matches = matchSnap.val() || {};
  const dailyMatches = Object.entries(matches).filter(([, m]) => m.source === 'daily');
  console.log(`Daily matches to process: ${dailyMatches.length}`);

  // 3. 재계산
  const updates = {};

  function inc(path, val) {
    updates[path] = (updates[path] || 0) + val;
  }

  for (const [, m] of dailyMatches) {
    const team0 = m.team0 || [];
    const team1 = m.team1 || [];
    const winner = m.winner; // 0, 1, -1
    if (team0.length < 2 || team1.length < 2) continue;

    const k0 = getPairKey(team0[0], team0[1]);
    const k1 = getPairKey(team1[0], team1[1]);
    const w0 = winner === 0 ? 1 : 0;
    const w1 = winner === 1 ? 1 : 0;
    const dr = winner === -1 ? 1 : 0;

    // pairStats
    inc(`jmt/pairStats/${YEAR}/${k0}/wins`,   w0);
    inc(`jmt/pairStats/${YEAR}/${k0}/losses`, w1);
    inc(`jmt/pairStats/${YEAR}/${k0}/draws`,  dr);
    inc(`jmt/pairStats/${YEAR}/${k1}/wins`,   w1);
    inc(`jmt/pairStats/${YEAR}/${k1}/losses`, w0);
    inc(`jmt/pairStats/${YEAR}/${k1}/draws`,  dr);

    updates[`jmt/pairStats/${YEAR}/${k0}/players`] = [...team0].sort();
    updates[`jmt/pairStats/${YEAR}/${k1}/players`] = [...team1].sort();

    // pairMatchups
    inc(`jmt/pairMatchups/${YEAR}/${k0}/${k1}/wins`,   w0);
    inc(`jmt/pairMatchups/${YEAR}/${k0}/${k1}/losses`, w1);
    inc(`jmt/pairMatchups/${YEAR}/${k0}/${k1}/draws`,  dr);
    inc(`jmt/pairMatchups/${YEAR}/${k1}/${k0}/wins`,   w1);
    inc(`jmt/pairMatchups/${YEAR}/${k1}/${k0}/losses`, w0);
    inc(`jmt/pairMatchups/${YEAR}/${k1}/${k0}/draws`,  dr);

    // playerStats
    for (const p of team0) {
      inc(`jmt/playerStats/${YEAR}/${p}/wins`,   w0);
      inc(`jmt/playerStats/${YEAR}/${p}/losses`, w1);
      inc(`jmt/playerStats/${YEAR}/${p}/draws`,  dr);
    }
    for (const p of team1) {
      inc(`jmt/playerStats/${YEAR}/${p}/wins`,   w1);
      inc(`jmt/playerStats/${YEAR}/${p}/losses`, w0);
      inc(`jmt/playerStats/${YEAR}/${p}/draws`,  dr);
    }

    // playerMatchups
    for (const p0 of team0) for (const p1 of team1) {
      inc(`jmt/playerMatchups/${YEAR}/${p0}/${p1}/wins`,   w0);
      inc(`jmt/playerMatchups/${YEAR}/${p0}/${p1}/losses`, w1);
      inc(`jmt/playerMatchups/${YEAR}/${p0}/${p1}/draws`,  dr);
      inc(`jmt/playerMatchups/${YEAR}/${p1}/${p0}/wins`,   w1);
      inc(`jmt/playerMatchups/${YEAR}/${p1}/${p0}/losses`, w0);
      inc(`jmt/playerMatchups/${YEAR}/${p1}/${p0}/draws`,  dr);
    }
  }

  // 4. 닉네임 복원
  const nicknameSnap = await db.ref('jmt/pairNicknames').once('value');
  const nicknames = nicknameSnap.val() || {};
  for (const [key, nick] of Object.entries(nicknames)) {
    if (updates[`jmt/pairStats/${YEAR}/${key}/wins`] !== undefined) {
      updates[`jmt/pairStats/${YEAR}/${key}/nickname`] = nick;
    }
  }

  console.log(`Writing ${Object.keys(updates).length} stat entries...`);
  await db.ref().update(updates);
  console.log('Done! Stats recalculated from daily matches only.');
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
