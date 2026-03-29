const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onValueWritten, onValueCreated } = require('firebase-functions/v2/database');
const { setGlobalOptions } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getDatabase } = require('firebase-admin/database');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
setGlobalOptions({ maxInstances: 5, region: 'asia-southeast1' });

const db  = getDatabase();
const fcm = getMessaging();

// ── 유틸: 전체 FCM 토큰 목록 ───────────────────────────────────────
async function getAllTokens() {
  const snap = await db.ref('jmt/fcmTokens').once('value');
  const data = snap.val();
  if (!data) return [];
  return Object.values(data).map(v => v.token).filter(Boolean);
}

// ── 유틸: 특정 이름들의 FCM 토큰 ──────────────────────────────────
async function getTokensByNames(names) {
  const snap = await db.ref('jmt/fcmTokens').once('value');
  const data = snap.val();
  if (!data) return [];
  return Object.values(data)
    .filter(v => names.includes(v.name) && v.token)
    .map(v => v.token);
}

// ── 유틸: FCM 멀티캐스트 발송 ─────────────────────────────────────
async function sendPush(tokens, title, body, tab = 'checkin', commentId = '') {
  if (!tokens || tokens.length === 0) return;
  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) chunks.push(tokens.slice(i, i + 500));
  for (const chunk of chunks) {
    const data = { title, body, tab };
    if (commentId) data.commentId = commentId;
    await fcm.sendEachForMulticast({
      tokens: chunk,
      data,
      webpush: { headers: { Urgency: 'high' } }
    });
  }
}

// ══ 0. 월요일 오전 8:30 — pollState 자동 오픈 ════════════════════
exports.autoOpenCheckin = onSchedule(
  { schedule: '0 0 * * 1', timeZone: 'Asia/Seoul' },
  async () => {
    // 이번 주 토요일 날짜 계산 (월요일 기준 +5일, KST)
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
    const sat = new Date(now);
    sat.setDate(now.getDate() + 5);
    const satDate = sat.toISOString().split('T')[0];
    const weekId = satDate;

    await db.ref('jmt/pollState').set({
      status: 'open',
      weekId,
      satDate,
      openedAt: new Date().toISOString(),
    });
  }
);

// ══ 1. 월요일 오전 9시 — 출첵 오픈 알림 ══════════════════════════
exports.notifyCheckinOpen = onSchedule(
  { schedule: '0 9 * * 1', timeZone: 'Asia/Seoul' },
  async () => {
    const tokens = await getAllTokens();
    await sendPush(tokens, '🎾 자미터 테니스 출첵 오픈!', '이번 주 토요일 모임 출첵을 해주세요 ✋');
  }
);

// ══ 2. 금요일 11시 30분 — 미출첵자 알림 ══════════════════════════
exports.notifyCheckinReminder = onSchedule(
  { schedule: '30 11 * * 5', timeZone: 'Asia/Seoul' },
  async () => {
    const pollStateSnap = await db.ref('jmt/pollState').once('value');
    const pollState = pollStateSnap.val();
    if (!pollState || pollState.status !== 'open') return;

    const weekId = pollState.weekId;
    const pollSnap = await db.ref(`jmt/poll/${weekId}/votes`).once('value');
    const votes = pollSnap.val() || {};
    const voted = new Set(Object.values(votes).map(v => v.name));

    const membersSnap = await db.ref('jmt/members').once('value');
    const members = Object.values(membersSnap.val() || {});
    const unvotedNames = members.map(m => m.name).filter(n => !voted.has(n));

    const tokens = await getTokensByNames(unvotedNames);
    await sendPush(tokens, '⏰ 출첵 마감 30분 전!', '아직 출첵을 안 하셨어요. 지금 바로 참석 여부를 알려주세요!');
  }
);

// ══ 3. 금요일 정오 — 출첵 자동 마감 + 매니저 알림 ════════════════
exports.notifyCheckinClose = onSchedule(
  { schedule: '0 12 * * 5', timeZone: 'Asia/Seoul' },
  async () => {
    // pollState 자동 close
    const snap = await db.ref('jmt/pollState').once('value');
    const ps = snap.val();
    if (ps && ps.status === 'open') {
      await db.ref('jmt/pollState').update({ status: 'closed', closedAt: new Date().toISOString() });
    }

    const MANAGERS = ['유지원', '천지은', '김승수'];
    const tokens = await getTokensByNames(MANAGERS);
    await sendPush(tokens, '🔴 출첵이 마감되었습니다', '참석 인원을 확인하고 대진을 생성해 주세요.');
  }
);

// ══ 4. 댓글 작성 알림 — DB 트리거 (전체) ═════════════════════════
exports.notifyNewComment = onValueCreated(
  { ref: 'jmt/poll/{weekId}/comments/{commentId}', region: 'asia-southeast1' },
  async (event) => {
    const comment = event.data.val();
    if (!comment) return;
    const { author, text } = comment;
    if (!author) return;
    const tokens = await getAllTokens();
    // 작성자 본인 제외
    const snap = await db.ref('jmt/fcmTokens').once('value');
    const data = snap.val() || {};
    const otherTokens = Object.values(data)
      .filter(v => v.name !== author && v.token)
      .map(v => v.token);
    await sendPush(otherTokens, `💬 ${author}님이 댓글을 달았습니다`, text, 'checkin', event.params.commentId);
  }
);

// ══ 6. 답글 알림 — DB 트리거 ══════════════════════════════════════
exports.notifyCommentReply = onValueCreated(
  { ref: 'jmt/poll/{weekId}/comments/{commentId}/replies/{replyId}', region: 'asia-southeast1' },
  async (event) => {
    const reply = event.data.val();
    if (!reply) return;
    const { commentAuthor, author, text } = reply;
    if (!commentAuthor || commentAuthor === author) return;
    const commentId = event.params.commentId;
    const tokens = await getTokensByNames([commentAuthor]);
    await sendPush(tokens, `💬 ${author}님이 답글을 달았습니다`, text, 'checkin', commentId);
  }
);

// ══ 7. 대진 생성/수정 감지 — DB 트리거 ═══════════════════════════
exports.notifyBracketUpdate = onValueWritten(
  { ref: 'jmt/activeState', region: 'asia-southeast1' },
  async (event) => {
    const after = event.data.after.val();
    if (!after) return;

    let parsed;
    try { parsed = typeof after === 'string' ? JSON.parse(after) : after; }
    catch (e) { return; }

    if (parsed.finished) return;
    if (!parsed.tournaments) return;

    const hasTournament = parsed.tournaments.mixed || parsed.tournaments.mens || parsed.tournaments.womens;
    if (!hasTournament) return;

    const before = event.data.before.val();
    let parsedBefore = null;
    try { parsedBefore = before ? (typeof before === 'string' ? JSON.parse(before) : before) : null; }
    catch (e) {}

    const hadTournament = parsedBefore && parsedBefore.tournaments &&
      (parsedBefore.tournaments.mixed || parsedBefore.tournaments.mens || parsedBefore.tournaments.womens);

    const tokens = await getAllTokens();
    if (!hadTournament) {
      await sendPush(tokens, '🎾 대진표가 생성되었습니다!', '앱에서 이번 주 대진표를 확인하세요.', 'matches');
    } else {
      await sendPush(tokens, '🔄 대진표가 수정되었습니다!', '앱에서 변경된 대진표를 확인하세요.', 'matches');
    }
  }
);
