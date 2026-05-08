/**
 * 자.만.추. 사진 카테고리 마이그레이션
 * 행사사진 → 모임, 단체사진 → 단체, 경기사진 → 경기, 기타 → 기타
 *
 * 실행: node migrate-photo-categories.js
 */
const admin = require('firebase-admin');
const serviceAccount = require('./jamite-tennis-firebase-adminsdk-fbsvc-03c94afa9e.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://jamite-tennis-default-rtdb.asia-southeast1.firebasedatabase.app'
});

const db = admin.database();

const CATEGORY_MAP = {
  '행사사진': '모임',
  '단체사진': '단체',
  '경기사진': '경기',
  '기타': '기타'
};

async function migrate() {
  console.log('📸 사진 카테고리 마이그레이션 시작...');
  const snap = await db.ref('jmt/photos').once('value');
  const photos = snap.val();
  if (!photos) { console.log('사진 데이터 없음'); process.exit(0); }

  const updates = {};
  let count = 0;

  Object.entries(photos).forEach(([key, data]) => {
    const oldCat = data.category;
    const newCat = CATEGORY_MAP[oldCat];
    if (newCat && newCat !== oldCat) {
      updates[`jmt/photos/${key}/category`] = newCat;
      console.log(`  ${key}: "${oldCat}" → "${newCat}"`);
      count++;
    }
  });

  if (count === 0) {
    console.log('변경할 데이터 없음 (이미 마이그레이션됨)');
    process.exit(0);
  }

  console.log(`\n총 ${count}건 업데이트 중...`);
  await db.ref().update(updates);
  console.log('✅ 마이그레이션 완료!');
  process.exit(0);
}

migrate().catch(e => { console.error('❌ 오류:', e); process.exit(1); });
