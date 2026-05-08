// ATP 뉴스 시딩 스크립트 — jamite-tennis 운영 DB에 ESPN 뉴스 저장
// 실행: node seed-atp-news.js
const admin = require('./functions/node_modules/firebase-admin');
const https = require('https');

const serviceAccount = require('./jamite-dev-service-account.json');

// jamite-tennis 운영 DB URL 확인 필요 — 일단 jamite-dev로 테스트
// 운영 배포 시 databaseURL을 jamite-tennis로 변경
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://jamite-tennis-default-rtdb.asia-southeast1.firebasedatabase.app',
});

const db = admin.database();

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function run() {
  try {
    const url = 'https://site.api.espn.com/apis/site/v2/sports/tennis/atp/news';
    const json = await httpsGet(url);
    const items = (json.articles || []).slice(0, 10).map(a => ({
      headline:    a.headline || '',
      description: a.description || '',
      published:   a.published || '',
      url:         (a.links && a.links.web && a.links.web.href) || '',
    })).filter(a => a.headline);

    if (!items.length) { console.log('기사 없음'); process.exit(0); }

    await db.ref('jmt/atpNews').set({ articles: items, updatedAt: new Date().toISOString() });
    console.log(`✅ ${items.length}개 뉴스 저장 완료`);
    items.forEach((a, i) => console.log(`  ${i+1}. ${a.headline}`));
    process.exit(0);
  } catch (e) {
    console.error('❌ 오류:', e.message);
    process.exit(1);
  }
}

run();
