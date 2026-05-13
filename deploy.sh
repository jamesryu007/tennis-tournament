#!/bin/bash
# ══════════════════════════════════════════════════════════════════
#  JAMITE 배포 스크립트
#  사용법: ./deploy.sh dev | prod
#
#  dev  → jamite-dev.web.app    (개발환경)
#  prod → jamite-tennis.web.app (운영환경)
#
#  이 스크립트가 firebase-config.js + firebase-messaging-sw.js를
#  자동으로 올바른 환경 값으로 교체한 뒤 배포합니다.
# ══════════════════════════════════════════════════════════════════
set -e

ENV="$1"

if [ "$ENV" != "dev" ] && [ "$ENV" != "prod" ]; then
  echo "사용법: ./deploy.sh dev | prod"
  exit 1
fi

# ── 환경별 설정값 (수정 금지 — 값을 바꿔야 하면 이 파일에서만) ──────────────

if [ "$ENV" = "dev" ]; then
  FIREBASE_PROJECT="jamite-dev"
  ENV_LABEL="개발"

  # firebase-config.js 값 (index.html 용)
  APP_API_KEY="AIzaSyDgGhjMh5_wFCbb45p5kAkDJaLOJJAFDhI"
  APP_AUTH_DOMAIN="jamite-dev.firebaseapp.com"
  APP_DATABASE_URL="https://jamite-dev-default-rtdb.asia-southeast1.firebasedatabase.app"
  APP_PROJECT_ID="jamite-dev"
  APP_STORAGE_BUCKET="jamite-dev.firebasestorage.app"
  APP_MESSAGING_SENDER_ID="168236820456"
  APP_APP_ID="1:168236820456:web:32fab6a04d85702055e65d"

  # firebase-messaging-sw.js 값 (SW 전용 — 별도 앱 등록)
  SW_API_KEY="AIzaSyDgGhjMh5_wFCbb45p5kAkDJaLOJJAFDhI"
  SW_AUTH_DOMAIN="jamite-dev.firebaseapp.com"
  SW_DATABASE_URL="https://jamite-dev-default-rtdb.asia-southeast1.firebasedatabase.app"
  SW_PROJECT_ID="jamite-dev"
  SW_STORAGE_BUCKET="jamite-dev.firebasestorage.app"
  SW_MESSAGING_SENDER_ID="296777882297"
  SW_APP_ID="1:296777882297:web:a03b11c6c99e7a00b5a1ce"

else  # prod
  FIREBASE_PROJECT="jamite-tennis"
  ENV_LABEL="운영"

  # firebase-config.js 값 (index.html 용)
  APP_API_KEY="AIzaSyB0zkRmUfVrI7TOI4LIN2gu2KRcYlHIt14"
  APP_AUTH_DOMAIN="jamite-tennis.firebaseapp.com"
  APP_DATABASE_URL="https://jamite-tennis-default-rtdb.asia-southeast1.firebasedatabase.app"
  APP_PROJECT_ID="jamite-tennis"
  APP_STORAGE_BUCKET="jamite-tennis.firebasestorage.app"
  APP_MESSAGING_SENDER_ID="1023676041344"
  APP_APP_ID="1:1023676041344:web:d9a9fcf47f3b280bcbfe65"

  # firebase-messaging-sw.js 값
  SW_API_KEY="AIzaSyB0zkRmUfVrI7TOI4LIN2gu2KRcYlHIt14"
  SW_AUTH_DOMAIN="jamite-tennis.firebaseapp.com"
  SW_DATABASE_URL="https://jamite-tennis-default-rtdb.asia-southeast1.firebasedatabase.app"
  SW_PROJECT_ID="jamite-tennis"
  SW_STORAGE_BUCKET="jamite-tennis.firebasestorage.app"
  SW_MESSAGING_SENDER_ID="1023676041344"
  SW_APP_ID="1:1023676041344:web:d9a9fcf47f3b280bcbfe65"
fi

# vapidKey는 dev/prod 공통
VAPID_KEY="BM-j4mKyzfhoB0k6JChzCwazNNr8UmtzwY_V6J_d-ChEvuB9z46WrHu0O9ClEMBkGw_kWoVrlh6kjDhF6bM75Zg"

CURRENT_BRANCH=$(git branch --show-current)

# ── 배포 정보 출력 ────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════"
printf "  환경:     %s (%s)\n" "$ENV_LABEL" "$ENV"
printf "  프로젝트: %s\n" "$FIREBASE_PROJECT"
printf "  앱 DB:    %s\n" "$APP_DATABASE_URL"
printf "  SW  DB:   %s\n" "$SW_DATABASE_URL"
printf "  브랜치:   %s\n" "$CURRENT_BRANCH"
echo "══════════════════════════════════════════════════"
echo ""

# ── 운영 배포 시 명시적 확인 ──────────────────────────────────────
if [ "$ENV" = "prod" ]; then
  printf "⚠️  운영(jamite-tennis) 배포입니다. 계속하려면 'yes' 입력: "
  read -r CONFIRM
  if [ "$CONFIRM" != "yes" ]; then
    echo "배포 취소."
    exit 0
  fi
  echo ""
fi

# ── STEP 1: firebase-config.js 교체 ──────────────────────────────
echo "▶ [1/3] firebase-config.js 교체..."

cat > firebase-config.js << CFEOF
// ── Firebase 설정 (${ENV_LABEL}환경: ${APP_PROJECT_ID}) ──────────────────────────

const firebaseConfig = {
  apiKey:            "${APP_API_KEY}",
  authDomain:        "${APP_AUTH_DOMAIN}",
  databaseURL:       "${APP_DATABASE_URL}",
  projectId:         "${APP_PROJECT_ID}",
  storageBucket:     "${APP_STORAGE_BUCKET}",
  messagingSenderId: "${APP_MESSAGING_SENDER_ID}",
  appId:             "${APP_APP_ID}",
  vapidKey:          "${VAPID_KEY}"
};
CFEOF

APPLIED=$(grep databaseURL firebase-config.js | tr -d ' "')
echo "  ✔ $APPLIED"

# ── STEP 2: index.html + firebase-messaging-sw.js 인라인 config 교체 ────
echo "▶ [2/3] index.html + firebase-messaging-sw.js config 교체..."

export ENV_LABEL \
       APP_API_KEY APP_AUTH_DOMAIN APP_DATABASE_URL APP_PROJECT_ID \
       APP_STORAGE_BUCKET APP_MESSAGING_SENDER_ID APP_APP_ID \
       SW_API_KEY SW_AUTH_DOMAIN SW_DATABASE_URL SW_PROJECT_ID \
       SW_STORAGE_BUCKET SW_MESSAGING_SENDER_ID SW_APP_ID VAPID_KEY

python3 << 'PYEOF'
import os, re, sys

env_label    = os.environ['ENV_LABEL']
# 앱(index.html) 값
app_api_key  = os.environ['APP_API_KEY']
app_auth     = os.environ['APP_AUTH_DOMAIN']
app_db_url   = os.environ['APP_DATABASE_URL']
app_proj_id  = os.environ['APP_PROJECT_ID']
app_bucket   = os.environ['APP_STORAGE_BUCKET']
app_sender   = os.environ['APP_MESSAGING_SENDER_ID']
app_app_id   = os.environ['APP_APP_ID']
# SW 값
sw_api_key   = os.environ['SW_API_KEY']
sw_auth      = os.environ['SW_AUTH_DOMAIN']
sw_db_url    = os.environ['SW_DATABASE_URL']
sw_proj_id   = os.environ['SW_PROJECT_ID']
sw_bucket    = os.environ['SW_STORAGE_BUCKET']
sw_sender    = os.environ['SW_MESSAGING_SENDER_ID']
sw_app_id    = os.environ['SW_APP_ID']
vapid        = os.environ['VAPID_KEY']

# ── index.html 인라인 config 교체 ──
app_block = (
    f"// ── Firebase 설정 인라인 ({env_label}환경: {app_proj_id}) — 외부파일 캐시 오염 방지 ──\n"
    f"const firebaseConfig = {{\n"
    f"  apiKey:            '{app_api_key}',\n"
    f"  authDomain:        '{app_auth}',\n"
    f"  databaseURL:       '{app_db_url}',\n"
    f"  projectId:         '{app_proj_id}',\n"
    f"  storageBucket:     '{app_bucket}',\n"
    f"  messagingSenderId: '{app_sender}',\n"
    f"  appId:             '{app_app_id}',\n"
    f"  vapidKey:          '{vapid}',\n"
    f"}};"
)

with open('index.html', 'r') as f:
    html = f.read()

pattern_html = r'// ── Firebase 설정 인라인.*?— 외부파일 캐시 오염 방지 ──\nconst firebaseConfig = \{.*?^};'
html_result, html_count = re.subn(pattern_html, app_block, html, flags=re.DOTALL | re.MULTILINE)

if html_count != 1:
    print(f"❌ 오류: index.html config 블록 매치 수 = {html_count} (정확히 1이어야 함)")
    sys.exit(1)

with open('index.html', 'w') as f:
    f.write(html_result)

print(f"  ✔ index.html databaseURL: '{app_db_url}'")

# ── firebase-messaging-sw.js 인라인 config 교체 ──
sw_block = (
    f"// ── Firebase 설정 인라인 ({env_label}환경: {sw_proj_id}) ───────────────────────\n"
    f"// importScripts('./firebase-config.js') 제거 — HTTP 캐시 오염 방지\n"
    f"const firebaseConfig = {{\n"
    f"  apiKey:            '{sw_api_key}',\n"
    f"  authDomain:        '{sw_auth}',\n"
    f"  databaseURL:       '{sw_db_url}',\n"
    f"  projectId:         '{sw_proj_id}',\n"
    f"  storageBucket:     '{sw_bucket}',\n"
    f"  messagingSenderId: '{sw_sender}',\n"
    f"  appId:             '{sw_app_id}',\n"
    f"  vapidKey:          '{vapid}',\n"
    f"}};"
)

with open('firebase-messaging-sw.js', 'r') as f:
    sw = f.read()

pattern_sw = r'// ── Firebase 설정 인라인.*?^};'
sw_result, sw_count = re.subn(pattern_sw, sw_block, sw, flags=re.DOTALL | re.MULTILINE)

if sw_count != 1:
    print(f"❌ 오류: SW config 블록 매치 수 = {sw_count} (정확히 1이어야 함)")
    sys.exit(1)

with open('firebase-messaging-sw.js', 'w') as f:
    f.write(sw_result)

print(f"  ✔ firebase-messaging-sw.js databaseURL: '{sw_db_url}'")
PYEOF

# ── STEP 3: 최종 검증 ─────────────────────────────────────────────
echo "▶ [3/3] 최종 검증..."

HTML_DB=$(grep -m1 "databaseURL" index.html | tr -d " '")
SW_DB=$(grep databaseURL firebase-messaging-sw.js | tr -d " '")

echo "  index.html               → $HTML_DB"
echo "  firebase-messaging-sw.js → $SW_DB"

if [[ "$HTML_DB" != *"$FIREBASE_PROJECT"* ]]; then
  echo "❌ 오류: index.html이 잘못된 프로젝트를 바라봅니다!"
  exit 1
fi
if [[ "$SW_DB" != *"$FIREBASE_PROJECT"* ]]; then
  echo "❌ 오류: firebase-messaging-sw.js가 잘못된 프로젝트를 바라봅니다!"
  exit 1
fi

echo "  ✔ 두 파일 모두 ${ENV_LABEL}(${FIREBASE_PROJECT}) 환경 확인 완료"
echo ""

# ── Firebase 배포 ─────────────────────────────────────────────────
echo "▶ Firebase 배포 시작..."
firebase deploy --project "$FIREBASE_PROJECT"

echo ""
echo "✅ ${ENV_LABEL} 배포 완료! (project: ${FIREBASE_PROJECT})"

if [ "$ENV" = "prod" ]; then
  # ── GitHub Pages 동기화 — origin/main push ────────────────────────
  echo "▶ GitHub Pages 동기화 (git push origin main)..."
  git add firebase-config.js firebase-messaging-sw.js index.html
  git commit -m "운영 config 교체 — GitHub Pages jamite-tennis 연결" || true
  git push origin main
  echo "  ✔ GitHub Pages 업데이트 완료"
  echo ""
  echo "💡 개발 환경으로 복귀하려면: ./deploy.sh dev"
fi
