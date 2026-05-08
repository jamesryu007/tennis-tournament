const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp({
  credential: applicationDefault(),
  databaseURL: 'https://jamite-tennis-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const db = getDatabase();
const fcm = getMessaging();

async function main() {
  const snap = await db.ref('jmt/fcmTokens').once('value');
  const data = snap.val();
  if (!data) { console.log('토큰 없음'); return; }
  const tokens = Object.values(data).map(v => v.token).filter(Boolean);
  console.log(`토큰 ${tokens.length}개 발견`);

  const title = '📅 모임 날짜/내용 확정!';
  const body = '"5월 봄나들이 자미터 대회"가 5월 30일(토)로 결정되었습니다. 일정표에 표기해 주세요!';

  const res = await fcm.sendEachForMulticast({
    tokens,
    notification: { title, body },
    data: { tab: 'setup', title, body },
    apns: { payload: { aps: { sound: 'default', badge: 1 } } },
    android: { notification: { sound: 'default' } }
  });
  console.log(`성공: ${res.successCount}, 실패: ${res.failureCount}`);
}

main().catch(console.error);
