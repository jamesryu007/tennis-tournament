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

# ── STEP 2: firebase-messaging-sw.js 인라인 config 교체 ──────────
echo "▶ [2/3] firebase-messaging-sw.js config 교체..."

export ENV_LABEL SW_API_KEY SW_AUTH_DOMAIN SW_DATABASE_URL SW_PROJECT_ID \
       SW_STORAGE_BUCKET SW_MESSAGING_SENDER_ID SW_APP_ID VAPID_KEY

python3 << 'PYEOF'
import os, re, sys

env_label = os.environ['ENV_LABEL']
api_key   = os.environ['SW_API_KEY']
auth      = os.environ['SW_AUTH_DOMAIN']
db_url    = os.environ['SW_DATABASE_URL']
proj_id   = os.environ['SW_PROJECT_ID']
bucket    = os.environ['SW_STORAGE_BUCKET']
sender    = os.environ['SW_MESSAGING_SENDER_ID']
app_id    = os.environ['SW_APP_ID']
vapid     = os.environ['VAPID_KEY']

new_block = (
    f"// ── Firebase 설정 인라인 ({env_label}환경: {proj_id}) ───────────────────────\n"
    f"// importScripts('./firebase-config.js') 제거 — HTTP 캐시 오염 방지\n"
    f"const firebaseConfig = {{\n"
    f"  apiKey:            '{api_key}',\n"
    f"  authDomain:        '{auth}',\n"
    f"  databaseURL:       '{db_url}',\n"
    f"  projectId:         '{proj_id}',\n"
    f"  storageBucket:     '{bucket}',\n"
    f"  messagingSenderId: '{sender}',\n"
    f"  appId:             '{app_id}',\n"
    f"  vapidKey:          '{vapid}',\n"
    f"}};"
)

with open('firebase-messaging-sw.js', 'r') as f:
    content = f.read()

pattern = r'// ── Firebase 설정 인라인.*?^};'
result, count = re.subn(pattern, new_block, content, flags=re.DOTALL | re.MULTILINE)

if count != 1:
    print(f"❌ 오류: SW config 블록 매치 수 = {count} (정확히 1이어야 함)")
    sys.exit(1)

with open('firebase-messaging-sw.js', 'w') as f:
    f.write(result)

print(f"  ✔ databaseURL: '{db_url}'")
PYEOF

# ── STEP 3: 최종 검증 ─────────────────────────────────────────────
echo "▶ [3/3] 최종 검증..."

CONFIG_DB=$(grep databaseURL firebase-config.js | tr -d ' "')
SW_DB=$(grep databaseURL firebase-messaging-sw.js | tr -d " '")

echo "  firebase-config.js       → $CONFIG_DB"
echo "  firebase-messaging-sw.js → $SW_DB"

if [[ "$CONFIG_DB" != *"$FIREBASE_PROJECT"* ]]; then
  echo "❌ 오류: firebase-config.js가 잘못된 프로젝트를 바라봅니다!"
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
  echo ""
  echo "💡 개발 환경으로 복귀하려면: ./deploy.sh dev"
fi
