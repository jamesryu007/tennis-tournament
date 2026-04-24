# JAMITE 테니스 앱 — Claude 작업 가이드

## 프로젝트 개요

JAMITE 테니스 동호회 웹앱. 순수 HTML/CSS/JS SPA (프레임워크 없음).
단일 파일 `index.html` (~13,000줄)에 HTML/CSS/JS 전부 포함.
Firebase Realtime Database + Firebase Cloud Functions + Firebase Hosting.

---

## 배포 구조 (중요 — 절대 혼동 금지)

| 환경 | 브랜치 | Firebase 프로젝트 | URL |
|------|--------|-------------------|-----|
| 개발 | `dev`  | `jamite-dev`      | jamite-dev.web.app |
| 운영 | `main` | `jamite-tennis`   | jamite-tennis.web.app |

### 배포 절차 (반드시 순서 준수)

```bash
# 1. dev 브랜치에서 작업·커밋
git add firebase-messaging-sw.js index.html
git commit -m "기능 설명, SW vN"

# 2. dev 먼저 배포·테스트
git branch  # dev 확인
grep databaseURL firebase-config.js  # jamite-dev 확인
firebase deploy --project jamite-dev

# 3. main 머지 후 반드시 databaseURL 재확인
git checkout main
git merge dev
grep databaseURL firebase-config.js  # jamite-tennis 이어야 함!
git push origin main
firebase deploy --project jamite-tennis

# 4. dev 동기화
git checkout dev
git push origin dev
```

> **절대 규칙**: jamite-tennis 배포 전 반드시 `grep databaseURL firebase-config.js` 로 운영 DB 확인.
> `firebase-config.js` 는 `merge=ours` 전략으로 보호되지만, 눈으로 항상 검증.

### 서비스워커 캐시 버전

- `firebase-messaging-sw.js` 6번째 줄: `const CACHE = 'jamite-vN';`
- `index.html` 변경 시 N을 반드시 +1 증가
- 커밋 메시지 끝에 `SW vN` 명시: `"기능 설명, SW v221"`

---

## JavaScript 코딩 스타일

### 기본 규칙

- **변수**: `const` > `let` > `var` 순 우선
- **세미콜론**: 항상 사용
- **따옴표**: JS 내 작은따옴표 `'`, 동적 문자열은 백틱 `` ` ``
- **들여쓰기**: 2칸 스페이스
- **함수**: 유틸리티/핸들러는 `function` 선언, 콜백/배열 메서드는 화살표 함수

### 명명 규칙

```javascript
// 상수 — UPPER_SNAKE_CASE
const ADMIN_NAME = '유지원';
const MANAGERS = ['유지원', '천지은', '김승수'];
const LS_IDENTITY = 'jmt_identity';

// 전역/공개 함수 — camelCase, 동사 시작
function renderMemberList() {}
function saveActiveState() {}
function openAddMemberModal() {}

// 내부/프라이빗 — 언더스코어 prefix
let _pollDataRef = null;
let _activeStateDebounce = null;
function _renderDailyCard(id) {}
function _normCard(data) {}

// CSS 클래스/ID — kebab-case
// id="page-atp", class="modal-overlay", class="btn-primary"
```

### 섹션 구분 주석 (Korean + ASCII art)

```javascript
// ══ 상태 관리 ══════════════════════════════════════════════════════
// ── Firebase 유틸 ───────────────────────────────────────────────────
/* ── CARDS ── */
```

---

## 전역 상태 관리

모든 앱 상태는 단일 `state` 객체에 집중. 직접 뮤테이션 허용.

```javascript
const state = {
  members: [],
  guests: [],
  selectedIds: new Set(),
  tournaments: { mixed: null, mens: null, womens: null, ladder: null },
  history: [],
  identity: null,         // { name } — 현재 디바이스 사용자
  pairNicknames: {},
  pollState: null,
  pollData: null,
  // ...
};
```

- Firebase 리스너 콜백에서 `state.xxx = snap.val()` 직접 업데이트
- 임시/프라이빗 상태는 모듈 레벨 `let _xxx = null` 변수로 분리
- localStorage 저장 키는 `jmt_` prefix: `'jmt_identity'`, `'jmt_v2_members'`

---

## Firebase 사용 패턴

### Firebase Compat Mode (v9+ 아님)

```javascript
// 항상 compat API 사용
firebase.database()         // OK
firebase.messaging()        // OK
// import { getDatabase } — 사용 안 함
```

### DB 경로: 모든 데이터는 `jmt/` 하위

```
jmt/members, jmt/history, jmt/matches, jmt/dailyCards
jmt/atpData, jmt/atpBets, jmt/atpBetsHistory
jmt/poll/{weekId}/votes, jmt/fcmTokens
jmt/ladderState, jmt/ladderLastResult
jmt/pairStats/{year}, jmt/playerStats/{year}
```

### 읽기/쓰기/구독 패턴

```javascript
// 단일 읽기
const snap = await db.ref('jmt/members').once('value');
const data = snap.val() || {};

// 실시간 구독
db.ref('jmt/atpBets').on('value', snap => {
  atpState.bets = snap.val() || {};
  renderAtpBetPanel();
});

// 쓰기 — 항상 .catch(fbErr)
db.ref('jmt/members/' + m.id).set(m).catch(fbErr);
db.ref(`jmt/dailyCards/${id}`).update({ phase: 'done' }).catch(fbErr);
db.ref('jmt/atpBets/' + betId).remove().catch(fbErr);

// 에러 핸들러
function fbErr(e) { console.error('Firebase 오류:', e); }

// 중요하지 않은 ops — 조용히 실패
db.ref('jmt/winnerAlert').remove().catch(()=>{});
```

### Firebase Push Key 즉시 확보 패턴 (레이스 컨디션 방지)

```javascript
// ❌ 잘못된 방식 — 비동기 체인에서 key 분실
db.ref('jmt/matches').push(data).then(ref => {
  db.ref('jmt/dailyCards/' + ref.key).set(...); // 리스너가 먼저 실행될 수 있음
});

// ✅ 올바른 방식 — 동기적으로 key 즉시 확보 후 병렬 쓰기
const newRef = db.ref('jmt/matches').push();
const newKey = newRef.key; // 즉시 동기적으로 확보
newRef.set(matchData).catch(fbErr);
db.ref('jmt/dailyCards/' + newKey).set(cardData).catch(fbErr);
```

### Cloud Functions 호출 (클라이언트)

```javascript
// 반드시 asia-southeast1 region 명시 (기본 us-central1이면 오류)
const fn = firebase.app().functions('asia-southeast1').httpsCallable('functionName');
const result = await fn({ param: value });
```

---

## UI 렌더링 패턴

### DOM 조작 — innerHTML 직접 할당

```javascript
// 리스트 렌더링
el.innerHTML = items.map(item => `<div class="card">${item.name}</div>`).join('');

// 조건부 렌더링
el.innerHTML = items.length
  ? items.map(renderItem).join('')
  : '<p class="empty-state">내용 없음</p>';
```

### 모달 패턴

```javascript
// HTML 구조
// <div class="modal-overlay" id="xxx-modal">
//   <div class="modal">
//     <div class="modal-handle"></div>
//     <div class="modal-header">
//       <span class="modal-round">제목</span>
//       <button class="modal-close" onclick="closeXxxModal()">✕</button>
//     </div>
//     <div style="padding:14px 16px">...</div>
//   </div>
// </div>

// 열기/닫기
document.getElementById('xxx-modal').classList.add('open');
document.getElementById('xxx-modal').classList.remove('open');
```

### 카드 생성 패턴 (오늘의 경기)

```javascript
// createdAt 타임스탬프 필수 포함 (정렬 기준)
const cardData = {
  phase: 'done',
  team0: [...], team1: [...],
  sets: [...], winner: 0,
  bgImage: 'images/ca.png',
  num: Object.keys(_dailyCards).length + 1,
  createdAt: Date.now(),  // 필수!
  label: '제목 날짜 라운드'
};

// DOM 삽입 — 최신 카드는 항상 맨 위
container.insertBefore(el, container.firstChild);

// 정렬 기준 (내림차순)
.sort((a, b) => (b[1].createdAt || b[1].num || 0) - (a[1].createdAt || a[1].num || 0))
```

### 탭/페이지 전환

```javascript
// 페이지
document.getElementById('page-atp').classList.add('active');
document.getElementById('page-atp').classList.remove('active');

// 버튼 상태
btn.classList.toggle('active', condition);
```

---

## 권한 시스템

```javascript
const ADMIN_NAME = '유지원';          // 슈퍼 관리자
const MANAGERS = ['유지원', '천지은', '김승수'];  // 관리자 그룹

function isAdmin() {
  return (state.identity && state.identity.name) === ADMIN_NAME;
}
function isManager() {
  return MANAGERS.includes(state.identity && state.identity.name);
}

// 현재 사용자
const curName = (state.identity && state.identity.name) || '';
```

---

## 대진표 타입

```javascript
// 4가지 타입
const types = ['mixed', 'mens', 'womens', 'ladder'];
// mixed  = 혼합복식
// mens   = 남자복식
// womens = 여자복식
// ladder = 사다리 복식

// prefix 패턴
const prefix = type === 'ladder' ? 'ladder' : type;
// DOM: id="mixed-panel", id="ladder-panel-content"
```

---

## 에러 처리

```javascript
// Firebase 에러 — fbErr 헬퍼
db.ref(...).set(data).catch(fbErr);

// JSON 파싱 — try-catch 필수
try {
  const d = localStorage.getItem(LS_IDENTITY);
  if (d) state.identity = JSON.parse(d);
} catch (e) {
  state.identity = null;
}

// 사용자 알림이 필요한 경우
} catch (e) {
  alert('저장 실패: ' + (e.message || e));
}

// 비중요 ops — 조용히 실패
.catch(()=>{})
```

---

## Cloud Functions (functions/index.js)

- Node.js, Firebase Functions v2 (`firebase-functions/v2`)
- 모든 함수: `region: 'asia-southeast1'`
- 스케줄 함수: `onSchedule`, DB 트리거: `onValueCreated`/`onValueWritten`, 클라이언트 호출: `onCall`
- 비동기: `async/await` 사용

```javascript
// 스케줄 함수 예시
exports.fetchAtpData = onSchedule(
  { schedule: '0 */2 * * *', timeZone: 'Asia/Seoul', region: 'asia-southeast1' },
  async () => { ... }
);

// callable 함수 예시
exports.refreshAtpData = onCall({ region: 'asia-southeast1' }, async (req) => { ... });
```

---

## 오늘의 경기 (`_dailyCards`) 핵심 규칙

1. **로컬 상태**: `_dailyCards[id]` — 임시 numeric id 또는 Firebase push key
2. **Firebase**: `jmt/dailyCards/{pushKey}` — `startDailyMatch` 또는 `submitScore` 시 저장
3. **createdAt 필수**: 모든 생성 경로에서 `createdAt: Date.now()` 포함
4. **DOM 즉시 반영**: Firebase 쓰기 후 반드시 `_renderDailyCard(id)` 호출
5. **정렬**: `createdAt` 내림차순 (없으면 `num` fallback)
6. **`+` 버튼**: 클릭 시 Firebase DB 한 번 조회 → 다른 멤버 카드 동기화 후 새 카드 추가

---

## 베팅 시스템 핵심 규칙

- `deleteBet(betId)`: 삭제 전 반드시 `_archiveBetToHistory()` 호출 후 remove
- `closeBet(betId)`: `_archiveBetToHistory()` → `jmt/atpBetsHistory/{tId}/{betId}` 저장
- 베팅 보호: 오픈 베팅 있거나 close 후 24시간 미만이면 대회 전환 차단
- Cloud Functions region: `asia-southeast1` (us-central1 아님)

---

## CSS 핵심 패턴

```css
/* 색상 팔레트 (Tailwind-inspired) */
/* Primary: #2563eb | Success: #22c55e | Warning: #f59e0b | Error: #dc2626 */
/* Neutral: #94a3b8 (slate-400), #64748b (slate-500) */
/* Background: #f0f4fb, #f8fafc, #eff6ff */

/* 폰트 */
font-family: -apple-system, 'Segoe UI', sans-serif;
font-size: 15px; /* base */

/* 애니메이션 — infinite 금지 (발열 유발), 3회 이하 */
animation: bounce-celebrate 1.4s ease-in-out 3;  /* ✅ */
animation: bounce-celebrate 1.4s ease-in-out infinite;  /* ❌ */
```

---

## 자주 쓰는 유틸 함수

```javascript
getPairKey(p1, p2)         // 두 선수 이름 → 정렬된 pairKey
getGender(name)            // 'male' | 'female' | 'unknown'
isAdmin()                  // 유지원 여부
isManager()                // MANAGERS 포함 여부
roundNames(n)              // n라운드 토너먼트 라운드 이름 배열
_getTournamentMeta(type)   // 현재 대진표 제목+날짜 반환
_getTeamDisplay(players)   // 팀 HTML + 닉네임 반환
showWinnerCelebration(label) // 팡파레 UI 표시
fbErr(e)                   // Firebase 에러 콘솔 출력
```

---

## 주석/문서화 언어

- **모든 주석은 한국어**
- 섹션 구분: `// ══ 제목 ══` 또는 `// ── 소제목 ───`
- 복잡한 로직에만 인라인 주석, 자명한 코드는 생략

---

## 하지 말아야 할 것

- `index.html`을 여러 파일로 분리하지 말 것 (SPA 단일 파일 구조 유지)
- Firebase v9+ modular API 사용 금지 (compat API만)
- 외부 UI 프레임워크 추가 금지 (React, Vue 등)
- CSS `animation: infinite` 사용 금지 (발열 유발)
- 배포 전 브랜치·databaseURL 미확인 금지
- `index.html` 변경 시 SW 버전 올리지 않으면 iOS에서 미반영
