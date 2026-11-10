/**
 * 115 二所人力招募系統 — 第七步：Email 驗證碼登入
 *
 * 同仁不需要 Google 帳號：輸入單位信箱 → 收到 6 位數驗證碼 → 登入。
 * 登入狀態保留 30 天（同一台電腦、同一個瀏覽器）。
 *
 * 部署設定：執行身分「我」、誰可以存取「所有人」。
 * 網頁的所有資料操作都經過 rpc()，沒有有效的登入憑證就拿不到任何資料。
 */

const AUTH = {
  CODE_TTL_SEC: 600,        // 驗證碼有效 10 分鐘
  SESSION_DAYS: 30,         // 登入狀態保留天數
  MAX_CODES_PER_HOUR: 5,    // 每個信箱每小時最多申請幾次
  MAX_TRIES: 5              // 每組驗證碼最多輸入錯幾次
};

let RPC_MODE_ = false;      // 由 rpc() 呼叫時為 true，身分只認登入憑證
let SESSION_EMAIL_ = '';

// 不需登入就能呼叫
const RPC_PUBLIC = ['requestLoginCode', 'verifyLoginCode', 'logout'];
// 需要登入才能呼叫（實際權限仍由各函式的 requireRole_ 檢查）
const RPC_PRIVATE = [
  'getBootstrap', 'getVersion', 'getCandidates', 'getCandidateDetail', 'getResumeFile',
  'checkDuplicate', 'uploadResume', 'createCandidate', 'updateBasicInfo',
  'scheduleInterview', 'setPostOffer', 'markApplicantDeclined', 'getFeedback', 'markFeedbackRead',
  'setScreening', 'setResult', 'markInterviewed', 'addReview', 'parseResume', 'markThankYouSent',
  'getProjectList', 'getInterviewMemo', 'getCandidateBrief',
  'joinInterview', 'leaveInterview', 'setInterviewPlan', 'assignPanel', 'submitInterview',
  'getAvailability', 'setAvailability', 'setRecommendedProjects', 'setInterviewLocation'
];

/** 網頁唯一的呼叫入口 */
function rpc(token, fn, args) {
  args = Array.isArray(args) ? args : [];
  if (RPC_PUBLIC.indexOf(fn) >= 0) return globalThis[fn].apply(null, args);
  if (RPC_PRIVATE.indexOf(fn) < 0) throw new Error('不允許的操作：' + fn);
  RPC_MODE_ = true;
  SESSION_EMAIL_ = sessionEmail_(token);
  if (!SESSION_EMAIL_) throw new Error('AUTH_REQUIRED');
  try {
    return globalThis[fn].apply(null, args);
  } catch (e) {
    // 記到 Apps Script「執行作業」，方便查原因；畫面上一定要有看得懂的訊息
    console.error('[' + fn + '] ' + SESSION_EMAIL_ + '：' + (e && e.stack ? e.stack : e));
    const msg = e && e.message ? String(e.message) : String(e || '');
    throw new Error(msg.trim() ? msg : '系統發生錯誤（' + fn + '），請重新整理後再試；若持續發生請通知管理員。');
  }
}

/** 第一步：寄送驗證碼 */
function requestLoginCode(email) {
  const e = normEmail_(email);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('請輸入正確的 Email。');
  const user = findUserByEmail_(e);
  if (!user) throw new Error('這個信箱沒有使用本系統的權限，請聯絡管理員。');
  if (user.role === '行政') throw new Error('行政帳號只接收會議室預約通知信，不需要登入系統。');

  const cache = CacheService.getScriptCache();
  const rateKey = 'RL_' + hash_(e);
  const n = Number(cache.get(rateKey) || 0);
  if (n >= AUTH.MAX_CODES_PER_HOUR) throw new Error('驗證碼申請太頻繁，請一小時後再試。');
  cache.put(rateKey, String(n + 1), 3600);

  const code = ('000000' + (parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 10), 16) % 1000000)).slice(-6);
  cache.put('LC_' + hash_(e), JSON.stringify({ h: hash_(code), tries: 0 }), AUTH.CODE_TTL_SEC);

  MailApp.sendEmail({
    to: user.email,
    subject: '[招募系統] 登入驗證碼 ' + code,
    body: user.name + ' 你好：\n\n你的登入驗證碼是 ' + code + '，10 分鐘內有效。\n\n' +
      '如果不是你本人申請，請忽略這封信。\n\n' + CONFIG.APP_TITLE,
    name: CONFIG.APP_TITLE
  });
  return { ok: true, masked: maskEmail_(user.email) };
}

/** 第二步：驗證碼正確就發給登入憑證 */
function verifyLoginCode(email, code) {
  const e = normEmail_(email);
  const cache = CacheService.getScriptCache();
  const key = 'LC_' + hash_(e);
  const raw = cache.get(key);
  if (!raw) throw new Error('驗證碼已過期，請重新申請。');
  const rec = JSON.parse(raw);
  if (rec.tries >= AUTH.MAX_TRIES) { cache.remove(key); throw new Error('錯誤次數太多，請重新申請驗證碼。'); }
  if (hash_(txt_(code)) !== rec.h) {
    rec.tries++;
    cache.put(key, JSON.stringify(rec), AUTH.CODE_TTL_SEC);
    throw new Error('驗證碼不正確，還可以再試 ' + (AUTH.MAX_TRIES - rec.tries) + ' 次。');
  }
  cache.remove(key);
  const user = findUserByEmail_(e);
  if (!user) throw new Error('這個信箱沒有使用本系統的權限，請聯絡管理員。');
  if (user.role === '行政') throw new Error('行政帳號只接收會議室預約通知信，不需要登入系統。');

  const token = Utilities.getUuid() + Utilities.getUuid();
  const props = PropertiesService.getScriptProperties();
  cleanSessions_(props);
  props.setProperty('S_' + hash_(token), JSON.stringify({ e: e, exp: Date.now() + AUTH.SESSION_DAYS * 864e5 }));
  try { appendLogs_([[new Date(), user.name, '', '登入', '', user.email]]); } catch (err) { /* 不影響登入 */ }
  return { token: token };
}

function logout(token) {
  if (token) PropertiesService.getScriptProperties().deleteProperty('S_' + hash_(token));
  return true;
}

/** 管理員工具：讓所有人登出（例如懷疑有人外流登入狀態時） */
function logoutEveryone() {
  const props = PropertiesService.getScriptProperties();
  Object.keys(props.getProperties()).filter(k => k.indexOf('S_') === 0).forEach(k => props.deleteProperty(k));
  console.log('已讓所有人登出');
}

// ===== 內部工具 =====
function sessionEmail_(token) {
  if (!token) return '';
  const props = PropertiesService.getScriptProperties();
  const key = 'S_' + hash_(String(token));
  const raw = props.getProperty(key);
  if (!raw) return '';
  try {
    const s = JSON.parse(raw);
    if (s.exp < Date.now()) { props.deleteProperty(key); return ''; }
    return s.e;
  } catch (e) { return ''; }
}

function cleanSessions_(props) {
  const all = props.getProperties(), now = Date.now();
  Object.keys(all).filter(k => k.indexOf('S_') === 0).forEach(k => {
    try { if (JSON.parse(all[k]).exp < now) props.deleteProperty(k); } catch (e) { props.deleteProperty(k); }
  });
}

function findUserByEmail_(normalized) {
  const u = readSheet_('使用者').find(r => normEmail_(r['Email']) === normalized && r['啟用'] === true);
  return u ? { email: txt_(u['Email']), name: txt_(u['姓名']), role: txt_(u['角色']) } : null;
}

function hash_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}

function maskEmail_(email) {
  const at = email.indexOf('@');
  if (at < 2) return email;
  return email.slice(0, 2) + '***' + email.slice(at);
}
