/**
 * 자.만.추. 썸네일 일괄 재생성
 * - jmt/photos 전체 조회
 * - 각 사진의 원본 다운로드 → sharp로 600px 리사이즈 → Storage 덮어쓰기
 * - 영상(type=video)은 thumbUrl이 있는 경우에도 원본 영상 프레임 추출 불가 → 건너뜀
 *
 * 실행: node regen-thumbnails.js
 * 운영: node regen-thumbnails.js --prod
 */
const admin = require('firebase-admin');
const sharp = require('sharp');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const serviceAccount = require('../jamite-tennis-firebase-adminsdk-fbsvc-03c94afa9e.json');

const isProd = process.argv.includes('--prod');
const DB_URL = isProd
  ? 'https://jamite-tennis-default-rtdb.asia-southeast1.firebasedatabase.app'
  : 'https://jamite-dev-default-rtdb.asia-southeast1.firebasedatabase.app';
const BUCKET = isProd ? 'jamite-tennis.firebasestorage.app' : 'jamite-dev.firebasestorage.app';

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: DB_URL,
  storageBucket: BUCKET,
});

const db      = admin.database();
const bucket  = admin.storage().bucket();
const MAX_PX  = 600;
const QUALITY = 82;

async function regenThumbnail(key, data) {
  if (data.type === 'video') {
    console.log(`  [건너뜀] ${key} — 영상 썸네일은 재생성 불가`);
    return;
  }
  if (!data.url) {
    console.log(`  [건너뜀] ${key} — url 없음`);
    return;
  }

  // 원본 이미지 다운로드
  let imgBuf;
  try {
    const res = await fetch(data.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    imgBuf = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    console.log(`  [실패] ${key} — 원본 다운로드 오류: ${e.message}`);
    return;
  }

  // sharp로 리사이즈
  let thumbBuf;
  try {
    thumbBuf = await sharp(imgBuf)
      .resize(MAX_PX, MAX_PX, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: QUALITY })
      .toBuffer();
  } catch (e) {
    console.log(`  [실패] ${key} — 리사이즈 오류: ${e.message}`);
    return;
  }

  // Storage 업로드 (덮어쓰기)
  const thumbPath = `photos/thumbs/${key}_thumb.jpg`;
  try {
    const file = bucket.file(thumbPath);
    await file.save(thumbBuf, { contentType: 'image/jpeg', resumable: false });
    const [url] = await file.getSignedUrl({ action: 'read', expires: '2099-01-01' });

    // DB thumbUrl 갱신
    await db.ref(`jmt/photos/${key}`).update({ thumbUrl: url, thumbPath });
    console.log(`  [완료] ${key}`);
  } catch (e) {
    console.log(`  [실패] ${key} — Storage 업로드 오류: ${e.message}`);
  }
}

async function main() {
  console.log(`썸네일 재생성 시작 — ${isProd ? '운영(jamite-tennis)' : '개발(jamite-dev)'}`);
  const snap = await db.ref('jmt/photos').once('value');
  const photos = snap.val();
  if (!photos) { console.log('사진 데이터 없음'); process.exit(0); }

  const entries = Object.entries(photos).filter(([, d]) => d.type !== 'video');
  console.log(`대상 이미지: ${entries.length}개`);

  // 병렬 처리 (3개씩)
  for (let i = 0; i < entries.length; i += 3) {
    await Promise.all(entries.slice(i, i + 3).map(([key, data]) => regenThumbnail(key, data)));
  }

  console.log('\n완료!');
  process.exit(0);
}

main().catch(e => { console.error('오류:', e); process.exit(1); });
