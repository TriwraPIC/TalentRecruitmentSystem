/**
 * 115 二所人力招募系統 — 第三步：後端程式
 *
 * 提供給網頁呼叫的函式（google.script.run）：
 *   共用   getBootstrap, getVersion, getCandidates, getCandidateDetail, getResumeFile
 *   HR     checkDuplicate, uploadResume, createCandidate, updateBasicInfo,
 *          scheduleInterview, setPostOffer, markApplicantDeclined,
 *          getFeedback, markFeedbackRead
 *   所長／面試官  setScreening（初選，先按先決定）
 *                 joinInterview, leaveInterview, setInterviewPlan（認領面試、主面選計畫）
 *                 submitInterview（主面試官或所長：已面試＋評語＋結果一次送出）, addReview
 *   所長   assignPanel（指定或調整面試官）
 *
 * 測試：函式選單選 selfTest → 執行（需為「管理員」角色，會自動建立並刪除一筆測試資料）
 * 注意：本檔依賴 Setup.gs 的 SHEET_DEF 與 OPTIONS，Setup.gs 請保留。
 */

// ===== 基本設定 =====
const CONFIG = {
  APP_TITLE: '115 二所人力招募系統',
  EMAIL_NOTIFY_HR: true,                       // 給結果時寄信通知 HR
  EMAIL_NOTIFY_PANEL: true,                    // HR 排好面試時間後，寄信通知面試官與所長
  TEST_MODE: true,                             // 測試模式：所有通知信改寄到 TEST_MAIL_TO（登入驗證碼不受影響）
  TEST_MAIL_TO: 'w00556075@triwra.org.tw',
  EMAIL_NOTIFY_ADMIN: true,                    // 面試地點是有行政助理的辦公室時，寄信請行政預約會議室與投影機
  INTERVIEW_MINUTES: 60,                       // 通知行政時建議預約的時間長度（分鐘）
  AUTO_PARSE: true,                            // 履歷自動帶入（false = 關閉）
  EMAIL_DOMAIN_ALIASES: ['triwra.org.tw'],   // 單位信箱網域
  RESUME_FOLDER_NAME: '115二所招募_履歷檔（勿分享）',
  TZ: 'Asia/Taipei',
  MAX_RESUME_MB: 15
};

// ===== 權限表：每個動作允許哪些角色 =====
const PERMS = {
  view:             ['管理員', 'HR', '所長', '面試官'],
  createCandidate:  ['管理員', 'HR'],
  editBasic:        ['管理員', 'HR'],
  schedule:         ['管理員', 'HR'],
  postOffer:        ['管理員', 'HR'],
  applicantDecline: ['管理員', 'HR'],
  feedback:         ['管理員', 'HR'],
  thankYou:         ['管理員', 'HR'],
  screening:        ['管理員', '所長', '面試官'],          // 初選：先按的人為準（所長可改）
  claim:            ['管理員', '所長', '面試官'],          // 認領／退出面試
  assignPanel:      ['管理員', '所長'],                    // 指定或調整面試官
  setResult:        ['管理員', '所長', '面試官'],          // 面試官只限主面試官（程式內再檢查）
  markInterviewed:  ['管理員', '所長', '面試官'],
  addReview:        ['管理員', '所長', '面試官'],
  memo:             ['管理員', 'HR', '所長', '面試官']   // 面試準備資料（面試官版內容）
};

// HR 可以編輯的基本資料欄位
const BASIC_FIELDS = [
  '姓名', '性別', '年齡', '手機', 'Email', '現居',
  '最高學歷', '最高學歷學校科系', '次高學歷學校科系',
  '工作經歷', '標案經驗', '報告經驗', '其他專長',
  '應徵職缺', '應徵管道', 'HR備註'
];

// 欄位 → 對應的選項清單（寫入前檢查）
const FIELD_OPTION = {
  '性別': '性別', '最高學歷': '學歷', '應徵管道': '應徵管道',
  '進度': '進度', '結果': '結果', '錄取後進度': '錄取後進度', '面試地點': '辦公地點',
  '現場表現': '現場表現', '建議結果': '建議結果', '建議團隊': '建議團隊', '辦公地點': '辦公地點'
};
const DATE_FIELDS = ['面試日期', '預計到職日', '感謝函寄出日'];
const TIME_FIELDS = ['面試時間'];
const RESULT_TO_SUGGESTION = { '錄取': '建議聘用', '評估中': '評估中', '感謝函': '不建議' };
const RESULT_LABEL = { '錄取': '錄取', '評估中': '待評估', '感謝函': '不錄取' };   // 畫面上的說法
const PANEL_COLS = ['初選者', '主面試官', '陪同面試官', '其他陪同', '面試官名單', '面試計畫'];
const NO_ACCESS_MSG = '你沒有使用本系統的權限，請聯絡管理員。';

let SUPPRESS_MAIL_ = false; // 測試時關閉寄信

// =====================================================================
// 網頁入口
// =====================================================================
function doGet(e) {
  // 身分改由「Email 驗證碼登入」判斷（見 Auth.gs），這裡只決定要顯示哪個頁面
  const page = (e && e.parameter && e.parameter.page) || '';
  if (page === 'job') return jobPage_(e.parameter.p);   // 應徵者說明頁，不需登入（見 Content.gs）
  const file = page === 'hr' ? 'HR' : page === 'manager' ? 'Manager' : 'Home';
  try {
    return HtmlService.createTemplateFromFile(file).evaluate()
      .setTitle(CONFIG.APP_TITLE)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  } catch (err) {
    return HtmlService.createHtmlOutput('<p style="font-family:sans-serif">找不到頁面「' + file + '」。</p>');
  }
}

/** 給同仁使用的網址（去掉會強制 Google 網域登入的 /a/macros/網域/） */
function publicUrl_() {
  return (ScriptApp.getService().getUrl() || '').replace(/\/a\/macros\/[^/]+\//, '/macros/');
}

/** 讓 HTML 範本引入共用的 CSS / JS 檔案 */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// =====================================================================
// 共用 API
// =====================================================================
function getBootstrap() {
  const me = getCurrentUser_();
  if (!me) throw new Error(noUserMsg_());
  const staff = readSheet_('使用者')
    .filter(u => u['啟用'] === true && ['所長', '面試官'].indexOf(txt_(u['角色'])) >= 0)
    .map(u => ({ email: normEmail_(u['Email']), name: txt_(u['姓名']), role: txt_(u['角色']) }));
  return { me: Object.assign({}, me, { key: normEmail_(me.email) }), options: OPTIONS, version: getVersion_(),
    appUrl: publicUrl_(), staff: staff, testMode: CONFIG.TEST_MODE };
}

/** 網頁每 30 秒呼叫一次；版本號變了才重新抓整份清單 */
function getVersion() {
  if (!getCurrentUser_()) throw new Error(noUserMsg_());
  return getVersion_();
}

function getCandidates() {
  const me = requireRole_('view');
  const reviews = readSheet_('面試評語');
  const countBy = {}, mineBy = {};
  reviews.forEach(r => {
    const id = r['應徵者ID'];
    countBy[id] = (countBy[id] || 0) + 1;
    if (txt_(r['面試官Email']).toLowerCase() === me.email) mineBy[id] = true;
  });
  const avail = availFilledMap_();
  const list = readSheet_('應徵者').map(c => {
    const o = toClient_(c);
    const panel = panelOf_(c);
    o.availFilled = panel.filter(k => (avail[c['應徵者ID']] || []).indexOf(k) >= 0).length;
    o.reviewCount = countBy[c['應徵者ID']] || 0;
    o.myReviewDone = !!mineBy[c['應徵者ID']];
    return o;
  });
  return { version: getVersion_(), candidates: list };
}

function getCandidateDetail(id) {
  requireRole_('view');
  const c = getCandidateObj_(id);
  const reviews = readSheet_('面試評語').filter(r => r['應徵者ID'] === id).map(toClient_);
  const history = readSheet_('異動紀錄').filter(r => r['應徵者ID'] === id).map(toClient_).reverse();
  return { candidate: toClient_(c), reviews: reviews, history: history };
}

/** 回傳履歷檔內容（base64），讓網頁直接顯示，不必把雲端檔案分享出去 */
function getResumeFile(id) {
  requireRole_('view');
  const c = getCandidateObj_(id);
  const fileId = extractDriveId_(c['履歷檔連結']);
  if (!fileId) throw new Error('這位應徵者沒有上傳履歷檔。');
  const file = DriveApp.getFileById(fileId);
  const blob = file.getBlob();
  return { name: file.getName(), mimeType: blob.getContentType(), base64: Utilities.base64Encode(blob.getBytes()) };
}

// =====================================================================
// HR API
// =====================================================================
function checkDuplicate(name, phone) {
  requireRole_('createCandidate');
  return findDuplicates_(name, phone, null);
}

function uploadResume(base64, filename, mimeType) {
  requireRole_('createCandidate');
  const bytes = Utilities.base64Decode(base64);
  if (bytes.length > CONFIG.MAX_RESUME_MB * 1024 * 1024) {
    throw new Error('檔案超過 ' + CONFIG.MAX_RESUME_MB + ' MB。');
  }
  const blob = Utilities.newBlob(bytes, mimeType || 'application/pdf', filename || 'resume.pdf');
  const file = getResumeFolder_().createFile(blob);
  return { fileId: file.getId(), url: file.getUrl() };
}

/**
 * 新增應徵者。若發現可能重複且 allowDuplicate 不為 true，
 * 不會建檔，而是回傳 { ok:false, duplicates:[...] } 讓 HR 決定。
 */
function createCandidate(data, allowDuplicate) {
  const me = requireRole_('createCandidate');
  return withLock_(() => {
    const name = txt_(data['姓名']);
    if (!name) throw new Error('姓名為必填。');
    const dups = findDuplicates_(name, data['手機'], null);
    if (dups.length && !allowDuplicate) return { ok: false, duplicates: dups };

    const rec0 = data['推薦計畫'] ? validProjectIds_(data['推薦計畫']) : [];
    if (rec0.length) ensureColumn_('應徵者', '推薦計畫');
    const sh = sheet_('應徵者');
    const headers = headers_('應徵者');
    const now = new Date();
    const id = nextId_(sh, 'C');
    const rec = {};
    BASIC_FIELDS.forEach(f => { if (data[f] !== undefined) rec[f] = normalizeIn_(f, data[f]); });
    Object.assign(rec, {
      '應徵者ID': id, '建檔時間': now, '建檔者': me.name,
      '重複比對鍵': makeDupKey_(name, data['手機']),
      '履歷檔連結': txt_(data['履歷檔連結']),
      '進度': '待初選',
      '最後更新時間': now, '最後更新者': me.name
    });
    if (rec0.length) rec['推薦計畫'] = rec0.join('、');
    if (dups.length) {
      rec['HR備註'] = '⚠️可能重複：' + dups.map(d => d.id).join('、') + (rec['HR備註'] ? '；' + rec['HR備註'] : '');
    }
    sh.appendRow(headers.map(h => (rec[h] !== undefined ? rec[h] : '')));
    appendLogs_([[now, me.name, id, '建檔', '', name]]);
    bumpVersion_();
    return { ok: true, id: id };
  });
}

function updateBasicInfo(id, data) {
  const me = requireRole_('editBasic');
  return withLock_(() => {
    const ch = {};
    BASIC_FIELDS.forEach(f => { if (data[f] !== undefined) ch[f] = data[f]; });
    if (ch['姓名'] !== undefined || ch['手機'] !== undefined) {
      const c = getCandidateObj_(id);
      ch['重複比對鍵'] = makeDupKey_(
        ch['姓名'] !== undefined ? ch['姓名'] : c['姓名'],
        ch['手機'] !== undefined ? ch['手機'] : c['手機']);
    }
    updateFields_(id, ch, me);
    return toClient_(getCandidateObj_(id));
  });
}

/**
 * date：'2026-10-01'，time：'14:00'
 * projectIds（選填）：HR 必要時可修改主面試官選的計畫；不傳就不更動
 * 需先有主面試官；排定或改期後寄信通知面試官與所長
 */
function scheduleInterview(id, date, time, location, projectIds) {
  const me = requireRole_('schedule');
  return withLock_(() => {
    ensurePanelColumns_();
    const c = getCandidateObj_(id);
    if (c['進度'] !== '約面試') throw new Error('初選通過「約面試」後才能排定面試時間。');
    if (!txt_(c['主面試官'])) throw new Error('還沒有主面試官，請等面試官認領後再排時間。');
    if (!date) throw new Error('請填面試日期。');
    // 面試地點由主面試官（或所長）決定，HR 不能改；location 參數保留只為相容舊版
    if (!txt_(c['面試地點'])) throw new Error('請主面試官先選面試地點，再排定時間。');
    const ch = { '面試日期': date, '面試時間': time || '' };
    if (projectIds !== undefined && projectIds !== null) ch['面試計畫'] = validProjectIds_(projectIds).join('、');
    const changed = updateFields_(id, ch, me);
    if (changed) {
      const now = getCandidateObj_(id);
      notifyPanel_(now, !txt_(c['面試日期']));
      notifyAdmin_(txt_(c['面試日期']) ? c : null, now);
    }
    return toClient_(getCandidateObj_(id));
  });
}

/**
 * 面試地點：主面試官或所長決定（院本部／台北辦公室／台中辦公室／待討論）
 * 已排定時間後改地點，會通知面試官，也會通知原地點與新地點的行政
 */
function setInterviewLocation(id, location) {
  const me = requireRole_('claim');
  return withLock_(() => {
    const c = getCandidateObj_(id);
    assertClaimable_(c);
    if (!isBoss_(me) && panelOf_(c)[0] !== normEmail_(me.email)) throw new Error('只有主面試官或所長可以決定面試地點。');
    const loc = txt_(location);
    if (OPTIONS['辦公地點'].indexOf(loc) < 0) throw new Error('請從清單選擇面試地點。');
    const changed = updateFields_(id, { '面試地點': loc }, me);
    if (changed && txt_(c['面試日期'])) {
      const now = getCandidateObj_(id);
      notifyPanel_(now, false, '面試地點改為「' + loc + '」（原本：' + (txt_(c['面試地點']) || '未定') + '）');
      notifyAdmin_(c, now);
    }
    return toClient_(getCandidateObj_(id));
  });
}

/** 錄取後進度：確認意願中／願意入職／對方婉拒／所內簽核／院內簽核／已到職 */
function setPostOffer(id, post, startDate) {
  const me = requireRole_('postOffer');
  return withLock_(() => {
    const c = getCandidateObj_(id);
    if (c['結果'] !== '錄取') throw new Error('只有結果為「錄取」的應徵者才能更新錄取後進度。');
    const ch = { '錄取後進度': post };
    if (startDate !== undefined) ch['預計到職日'] = startDate;
    updateFields_(id, ch, me);
    return toClient_(getCandidateObj_(id));
  });
}

/** 應徵者在錄取前自行放棄（無意願、面試前婉拒） */
/** HR 推薦的面試計畫（面試官認領時預先勾選，主面試官可以改） */
function setRecommendedProjects(id, projectIds) {
  const me = requireRole_('editBasic');
  return withLock_(() => {
    ensureColumn_('應徵者', '推薦計畫');
    getCandidateObj_(id);
    updateFields_(id, { '推薦計畫': validProjectIds_(projectIds || []).join('、') }, me);
    return toClient_(getCandidateObj_(id));
  });
}

function markApplicantDeclined(id, note) {
  const me = requireRole_('applicantDecline');
  return withLock_(() => {
    const c = getCandidateObj_(id);
    if (c['結果'] === '錄取') throw new Error('已錄取的應徵者婉拒，請改用錄取後進度「對方婉拒」。');
    const ch = { '結果': '應徵者婉拒' };
    if (txt_(note)) ch['HR備註'] = (txt_(c['HR備註']) ? txt_(c['HR備註']) + '；' : '') + txt_(note);
    updateFields_(id, ch, me);
    if (c['進度'] === '約面試' && txt_(c['面試日期'])) notifyAdmin_(c, null);   // 已排面試的取消，通知行政
    return toClient_(getCandidateObj_(id));
  });
}

/** HR 寄出感謝函後標記，應徵者才會移到「已結案」 */
function markThankYouSent(id) {
  const me = requireRole_('thankYou');
  return withLock_(() => {
    ensureColumn_('應徵者', '感謝函寄出日', 'yyyy/mm/dd');
    const c = getCandidateObj_(id);
    if (c['結果'] !== '感謝函') throw new Error('只有結果為「感謝函」的應徵者才需要寄感謝函。');
    if (txt_(c['感謝函寄出日'])) throw new Error('這位應徵者的感謝函已經標記寄出了。');
    updateFields_(id, { '感謝函寄出日': fmtD_(new Date(), 'yyyy-MM-dd') }, me);
    return toClient_(getCandidateObj_(id));
  });
}

/** 工作表缺少欄位時，自動加在最右邊（不影響既有資料） */
function ensureColumn_(sheetName, header, numberFormat) {
  const sh = sheet_(sheetName);
  if (headers_(sheetName).indexOf(header) >= 0) return;
  const col = sh.getLastColumn() + 1;
  if (col > sh.getMaxColumns()) sh.insertColumnsAfter(sh.getMaxColumns(), col - sh.getMaxColumns());   // 欄數用滿時先加欄
  sh.getRange(1, col).setValue(header);
  styleHeader_(sh, col);
  if (numberFormat) sh.getRange(2, col, MAX_ROWS, 1).setNumberFormat(numberFormat);
}

/**
 * 管理員只需執行一次：把轉移進來的舊資料中，結果為「感謝函」的人標記為已寄出，
 * 避免舊資料全部跑進「待寄感謝函」。系統上線後新增的應徵者不受影響。
 */
function markExistingThanksAsSent() {
  ensureColumn_('應徵者', '感謝函寄出日', 'yyyy/mm/dd');
  const me = { name: '系統（舊資料）', email: '', role: '管理員' };
  const today = fmtD_(new Date(), 'yyyy-MM-dd');
  let n = 0;
  readSheet_('應徵者').forEach(c => {
    if (c['結果'] === '感謝函' && c['建檔者'] === '資料轉移' && !txt_(c['感謝函寄出日'])) {
      updateFields_(c['應徵者ID'], { '感謝函寄出日': today }, me);
      n++;
    }
  });
  console.log('已把 ' + n + ' 位舊資料標記為感謝函已寄出');
}

/** HR 頁面的「主管回饋」：所長與面試官做過的動作 */
/**
 * HR 頁面的「主管回饋」：所長與面試官做過的事，整理成看得懂的句子
 * 同一個人同一次操作改了好幾個欄位，會合併成一筆
 */
function getFeedback(limit) {
  const me = requireRole_('feedback');
  const managerNames = readSheet_('使用者')
    .filter(u => ['所長', '面試官'].indexOf(txt_(u['角色'])) >= 0)
    .map(u => txt_(u['姓名']));
  const nameById = {}, candById = {};
  readSheet_('應徵者').forEach(c => { nameById[c['應徵者ID']] = c['姓名']; candById[c['應徵者ID']] = c; });
  const projName = {};
  try { readProjectList_().forEach(x => { projName[x.id] = x.name || x.id; }); } catch (e) { /* 沒有計畫清單時照原樣顯示 */ }
  const lastRead = Number(PropertiesService.getScriptProperties().getProperty('READ_' + me.email) || 0);

  const groups = [];
  readSheet_('異動紀錄').filter(l => managerNames.indexOf(txt_(l['操作者'])) >= 0).forEach(l => {
    const t = l['時間'] instanceof Date ? l['時間'] : new Date(l['時間']);
    const key = t.getTime() + '|' + txt_(l['操作者']) + '|' + l['應徵者ID'];
    let g = groups.length && groups[groups.length - 1].key === key ? groups[groups.length - 1] : null;
    if (!g) groups.push(g = { key: key, t: t, who: txt_(l['操作者']), id: l['應徵者ID'], f: {} });
    g.f[txt_(l['欄位'])] = { from: txt_(l['舊值']), to: txt_(l['新值']) };
  });

  const items = groups.map(g => {
    const f = g.f, parts = [];
    const to = k => f[k] ? f[k].to : '';
    if (f['結果'] && to('結果') === '不約面試') parts.push('初選：不約面試');
    else if (f['進度'] && to('進度') === '約面試') parts.push('初選：約面試');
    if (f['結果'] && RESULT_LABEL[to('結果')]) parts.push('面試結果：' + RESULT_LABEL[to('結果')]);
    if (f['主面試官'] || f['陪同面試官']) {
      const list = v => String(v || '').split('、').filter(Boolean);
      const leadTo = f['主面試官'] ? to('主面試官') : null, leadFrom = f['主面試官'] ? f['主面試官'].from : null;
      const mTo = f['陪同面試官'] ? list(to('陪同面試官')) : null, mFrom = f['陪同面試官'] ? list(f['陪同面試官'].from) : null;
      if (leadTo === g.who && leadFrom !== g.who && !(mFrom && mFrom.indexOf(g.who) >= 0)) parts.push('認領：擔任主面試官');
      else if (mTo && mTo.indexOf(g.who) >= 0 && mFrom.indexOf(g.who) < 0 && leadFrom !== g.who) parts.push('認領：加入陪同');
      else if ((leadFrom === g.who && leadTo !== g.who) || (mFrom && mFrom.indexOf(g.who) >= 0 && mTo.indexOf(g.who) < 0)) {
        parts.push('退出面試' + (leadFrom === g.who && leadTo ? '，由 ' + leadTo + ' 遞補主面試官' : ''));
      } else {
        const c = candById[g.id] || {};
        parts.push('調整面試官：主面 ' + ((leadTo !== null ? leadTo : txt_(c['主面試官'])) || '無') +
          '，陪同 ' + ((mTo !== null ? mTo.join('、') : txt_(c['陪同面試官'])) || '無'));
      }
    }
    if (f['其他陪同']) parts.push('其他陪同：' + (to('其他陪同') || '（清空）'));
    if (f['面試計畫']) parts.push('面試計畫：' + (to('面試計畫').split('、').filter(Boolean).map(x => projName[x] || x).join('、') || '（清空）'));
    ['面試評語', '面試評語（更新）'].forEach(k => { if (f[k]) parts.push((k === '面試評語' ? '填寫評語：' : '修改評語：') + f[k].to); });
    if (f['可面試時段']) parts.push('填寫可面試時間：' + f['可面試時段'].to);
    const shown = ['結果', '進度', '主面試官', '陪同面試官', '其他陪同', '面試計畫', '面試評語', '面試評語（更新）', '可面試時段',
      '面試官名單', '初選者', '錄取後進度', '最後更新時間', '最後更新者'];
    Object.keys(f).filter(k => shown.indexOf(k) < 0).forEach(k => parts.push(k + '：' + (f[k].from ? f[k].from + ' → ' : '') + f[k].to));
    if (!parts.length) return null;
    return { time: fmtD_(g.t, 'yyyy/MM/dd HH:mm'), who: g.who, id: g.id, name: nameById[g.id] || '',
      text: parts.join('；'), unread: g.t.getTime() > lastRead };
  }).filter(Boolean).slice(-(limit || 50)).reverse();
  return { unreadCount: items.filter(i => i.unread).length, items: items };
}

function markFeedbackRead() {
  const me = requireRole_('feedback');
  PropertiesService.getScriptProperties().setProperty('READ_' + me.email, String(Date.now()));
  return true;
}

// =====================================================================
// 所長／面試官 API
// =====================================================================
/**
 * 初選：decision = '約面試' 或 '不約面試'
 * 所長與面試官都可以按，以第一個按的人為準；之後只有所長（或管理員）能改。
 * 不約面試 → 直接結案，不寄感謝函、不通知 HR。
 */
function setScreening(id, decision) {
  const me = requireRole_('screening');
  if (decision === '感謝函') decision = '不約面試';   // 舊版按鈕相容
  if (['約面試', '不約面試'].indexOf(decision) < 0) throw new Error('初選只能選「約面試」或「不約面試」。');
  return withLock_(() => {
    ensurePanelColumns_();
    const c = getCandidateObj_(id);
    if (c['進度'] === '已面試') throw new Error('已面試的應徵者請改用面試結果。');
    if (['錄取', '應徵者婉拒', '感謝函', '評估中'].indexOf(c['結果']) >= 0) {
      throw new Error('此應徵者已有結果（' + (RESULT_LABEL[c['結果']] || c['結果']) + '），不能再做初選。');
    }
    const decided = c['進度'] === '約面試' || c['結果'] === '不約面試';
    if (decided && !isBoss_(me)) {
      throw new Error('初選已由 ' + (txt_(c['初選者']) || '其他主管') + ' 決定為「' +
        (c['結果'] === '不約面試' ? '不約面試' : '約面試') + '」，如需更改請洽所長。');
    }
    if (decision === '不約面試' && txt_(c['面試日期'])) throw new Error('已經排定面試時間，請先請 HR 取消面試。');
    const ch = decision === '約面試'
      ? { '進度': '約面試', '結果': '', '初選者': me.name }
      : { '進度': '待初選', '結果': '不約面試', '初選者': me.name };
    updateFields_(id, ch, me);
    return toClient_(getCandidateObj_(id));
  });
}

function isBoss_(me) { return me.role === '所長' || me.role === '管理員'; }

// ===== 面試官認領（主面＋陪同） =====
function ensurePanelColumns_() { PANEL_COLS.forEach(h => ensureColumn_('應徵者', h)); }

/** 面試官名單：第一位是主面試官，其餘是陪同 */
function panelOf_(c) { return txt_(c['面試官名單']).split(',').map(normEmail_).filter(Boolean); }

function staffByEmail_() {
  const m = {};
  readSheet_('使用者').forEach(u => {
    if (u['啟用'] === true) m[normEmail_(u['Email'])] = { name: txt_(u['姓名']), role: txt_(u['角色']), email: txt_(u['Email']) };
  });
  return m;
}

function panelChanges_(emails) {
  const staff = staffByEmail_();
  const uniq = [];
  emails.map(normEmail_).filter(Boolean).forEach(e => {
    if (uniq.indexOf(e) >= 0) return;
    if (!staff[e] || ['所長', '面試官', '管理員'].indexOf(staff[e].role) < 0) throw new Error('「' + e + '」不是已啟用的所長或面試官。');
    uniq.push(e);
  });
  return {
    '面試官名單': uniq.join(','),
    '主面試官': uniq.length ? staff[uniq[0]].name : '',
    '陪同面試官': uniq.slice(1).map(e => staff[e].name).join('、')
  };
}

function assertClaimable_(c) {
  if (c['進度'] !== '約面試' || txt_(c['結果'])) throw new Error('只有初選「約面試」、還沒面試的應徵者可以安排面試官。');
}

/** 我要參加：第一個參加的是主面試官，之後參加的是陪同 */
function joinInterview(id) {
  const me = requireRole_('claim');
  return withLock_(() => {
    ensurePanelColumns_();
    const c = getCandidateObj_(id);
    assertClaimable_(c);
    const list = panelOf_(c), key = normEmail_(me.email);
    if (list.indexOf(key) >= 0) throw new Error('你已經在這場面試的名單裡。');
    list.push(key);
    updateFields_(id, panelChanges_(list), me);
    return toClient_(getCandidateObj_(id));
  });
}

/** 退出：主面試官退出時，由第一位陪同自動遞補 */
function leaveInterview(id) {
  const me = requireRole_('claim');
  return withLock_(() => {
    ensurePanelColumns_();
    const c = getCandidateObj_(id);
    assertClaimable_(c);
    const key = normEmail_(me.email);
    const list = panelOf_(c);
    if (list.indexOf(key) < 0) throw new Error('你不在這場面試的名單裡。');
    const rest = list.filter(e => e !== key);
    if (!rest.length && txt_(c['面試日期'])) throw new Error('已經排定面試時間，最後一位面試官不能退出，請洽所長調整。');
    updateFields_(id, panelChanges_(rest), me);
    return toClient_(getCandidateObj_(id));
  });
}

/** 主面試官（或所長）選面試計畫，並填寫名單外的其他陪同（自由填寫） */
function setInterviewPlan(id, projectIds, others) {
  const me = requireRole_('claim');
  return withLock_(() => {
    ensurePanelColumns_();
    const c = getCandidateObj_(id);
    assertClaimable_(c);
    const lead = panelOf_(c)[0];
    if (!isBoss_(me) && lead !== normEmail_(me.email)) throw new Error('只有主面試官或所長可以選面試計畫。');
    const ids = validProjectIds_(projectIds);
    if (!ids.length) throw new Error('請至少選一個面試計畫。');
    updateFields_(id, { '面試計畫': ids.join('、'), '其他陪同': safeText_(txt_(others)) }, me);
    return toClient_(getCandidateObj_(id));
  });
}

/** 所長指定或調整：leadEmail 主面、companions 陪同（陣列）、others 其他陪同、projectIds 計畫（可不傳） */
function assignPanel(id, leadEmail, companions, others, projectIds) {
  const me = requireRole_('assignPanel');
  return withLock_(() => {
    ensurePanelColumns_();
    const c = getCandidateObj_(id);
    assertClaimable_(c);
    const list = [leadEmail].concat(companions || []).filter(Boolean);
    if (!list.length && txt_(c['面試日期'])) throw new Error('已經排定面試時間，至少要有一位主面試官。');
    const ch = panelChanges_(list);
    ch['其他陪同'] = safeText_(txt_(others));
    if (projectIds !== undefined && projectIds !== null) ch['面試計畫'] = validProjectIds_(projectIds).join('、');
    updateFields_(id, ch, me);
    return toClient_(getCandidateObj_(id));
  });
}

function markInterviewed(id) {
  const me = requireRole_('markInterviewed');
  return withLock_(() => {
    const c = getCandidateObj_(id);
    if (c['進度'] !== '約面試') throw new Error('只有「約面試」的應徵者可以標記為已面試。');
    updateFields_(id, { '進度': '已面試' }, me);
    return toClient_(getCandidateObj_(id));
  });
}

/**
 * 面試完成：一次送出「已面試＋評語＋結果」
 * result = '錄取'／'評估中'（待評估）／'感謝函'（不錄取）
 * review：{ 現場表現, 建議團隊, 辦公地點, 備註 }，存成自己的一筆評語
 * 只有主面試官與所長可以給結果；待評估不通知 HR
 */
function submitInterview(id, result, review) {
  const me = requireRole_('setResult');
  if (!RESULT_TO_SUGGESTION[result]) throw new Error('面試結果只能是錄取、待評估或不錄取。');
  return withLock_(() => {
    ensurePanelColumns_();
    const c = getCandidateObj_(id);
    if (!isBoss_(me) && panelOf_(c)[0] !== normEmail_(me.email)) throw new Error('只有主面試官或所長可以決定面試結果，陪同的面試官請填寫評語。');
    if (c['進度'] === '約面試') {
      if (!txt_(c['面試日期'])) throw new Error('還沒有排定面試時間。');
    } else if (c['進度'] !== '已面試') {
      throw new Error('這位應徵者還沒有進入面試階段。');
    }
    if (txt_(c['感謝函寄出日'])) throw new Error('HR 已經寄出感謝函，不能再更改結果。');
    if (['應徵者婉拒', '不約面試'].indexOf(c['結果']) >= 0) throw new Error('此應徵者已結案（' + c['結果'] + '）。');
    const ch = { '進度': '已面試', '結果': result };
    if (result === '錄取') {
      if (!txt_(c['錄取後進度'])) ch['錄取後進度'] = '確認意願中';
    } else {
      ch['錄取後進度'] = '';
    }
    const changed = updateFields_(id, ch, me);
    if (review) upsertReview_(c, Object.assign({}, review, { '建議結果': RESULT_TO_SUGGESTION[result] }), me);
    if (changed && result !== '評估中') {
      const lines = [me.name + ' 將 ' + c['姓名'] + '（' + id + '）的面試結果設為「' + RESULT_LABEL[result] + '」。'];
      if (review) ['現場表現', '建議團隊', '辦公地點', '備註'].forEach(k => { if (txt_(review[k])) lines.push(k + '：' + txt_(review[k])); });
      lines.push(result === '錄取' ? '請聯絡應徵者確認意願與報到時間。' : '請在 104 寄發感謝函，寄出後在系統按「已寄出感謝函」。');
      notifyHR_('面試結果：' + c['姓名'] + ' → ' + RESULT_LABEL[result], lines.join('\n'));
    }
    bumpVersion_();
    return toClient_(getCandidateObj_(id));
  });
}

/** 舊名稱相容 */
function setResult(id, result, review) { return submitInterview(id, result, review); }

/** 每位面試官各自給評語；同一人再送一次會更新自己那筆 */
function addReview(id, review) {
  const me = requireRole_('addReview');
  return withLock_(() => {
    const c = getCandidateObj_(id);
    upsertReview_(c, review || {}, me);
    bumpVersion_();
    return true;
  });
}

// =====================================================================
// 內部工具
// =====================================================================
function getCurrentUser_() {
  const email = RPC_MODE_ ? SESSION_EMAIL_ : txt_(Session.getActiveUser().getEmail()).toLowerCase();
  if (!email) return null;
  const key = normEmail_(email);
  const u = readSheet_('使用者').find(r => normEmail_(r['Email']) === key && r['啟用'] === true);
  return u ? { email: email, name: txt_(u['姓名']), role: txt_(u['角色']) } : null;
}

/** 單位的兩個網域（triwra.org.tw、g.triwra.org.tw）視為同一個帳號 */
function noUserMsg_() { return RPC_MODE_ ? 'AUTH_REQUIRED' : NO_ACCESS_MSG; }

function normEmail_(e) {
  e = txt_(e).toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 0) return e;
  const domain = e.slice(at + 1);
  return CONFIG.EMAIL_DOMAIN_ALIASES.indexOf(domain) >= 0 ? e.slice(0, at) + '@' + CONFIG.EMAIL_DOMAIN_ALIASES[0] : e;
}

function requireRole_(action) {
  const me = getCurrentUser_();
  if (!me) throw new Error(noUserMsg_());
  if (PERMS[action].indexOf(me.role) < 0) throw new Error('你的角色（' + me.role + '）不能執行這個動作。');
  return me;
}

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('找不到工作表「' + name + '」。');
  return sh;
}

function headers_(name) {
  const sh = sheet_(name);
  if (sh.getLastColumn() === 0 || sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].every(v => txt_(v) === '')) {
    restoreHeaders_(sh, name);
  }
  return sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(txt_);
}

/**
 * 標題列不見時自動補回（例如工作表被清空，或第一列被刪掉）。
 * 工作表完全空白：直接寫入標題；第一列空白但下面還有資料：在最上面插入一列再寫標題，不會蓋掉資料。
 */
function restoreHeaders_(sh, name) {
  const def = SHEET_DEF[name];
  if (!def) throw new Error('工作表「' + name + '」的標題列不見了，請聯絡管理員。');
  if (sh.getLastRow() > 1 && txt_(sh.getRange(2, 1).getValue()) === def[0]) {   // 只是上面多了一列空白
    sh.deleteRow(1);
    return;
  }
  if (sh.getLastRow() > 0) sh.insertRowBefore(1);
  if (sh.getMaxColumns() < def.length) sh.insertColumnsAfter(sh.getMaxColumns(), def.length - sh.getMaxColumns());
  sh.getRange(1, 1, 1, def.length).setValues([def]);
  styleHeader_(sh, def.length);
  sh.setFrozenRows(1);
  console.warn('工作表「' + name + '」的標題列不見了，已自動補回。');
}

/** 把工作表讀成物件陣列；日期與時間欄位用畫面上顯示的文字，避免時區誤差 */
function readSheet_(name) {
  const range = sheet_(name).getDataRange();
  const values = range.getValues();
  const disp = range.getDisplayValues();
  const headers = values[0].map(txt_);
  const out = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i].every(v => v === '' || v === false)) continue;
    const o = { _row: i + 1 };
    headers.forEach((h, j) => {
      if (!h) return;
      o[h] = (DATE_FIELDS.indexOf(h) >= 0 || TIME_FIELDS.indexOf(h) >= 0) ? disp[i][j] : values[i][j];
    });
    out.push(o);
  }
  return out;
}

function getCandidateObj_(id) {
  const c = readSheet_('應徵者').find(r => r['應徵者ID'] === id);
  if (!c) throw new Error('找不到應徵者 ' + id + '。');
  return c;
}

/** 更新指定欄位並寫入異動紀錄，回傳實際變更的欄位數 */
function updateFields_(id, changes, me) {
  const sh = sheet_('應徵者');
  const headers = headers_('應徵者');
  const c = getCandidateObj_(id);
  const range = sh.getRange(c._row, 1, 1, headers.length);
  const cur = range.getValues()[0];
  const disp = range.getDisplayValues()[0];
  const now = new Date();
  const logs = [];

  Object.keys(changes).forEach(f => {
    const idx = headers.indexOf(f);
    if (idx < 0) throw new Error('未知欄位：' + f);
    const nv = normalizeIn_(f, changes[f]);
    const oldStr = disp[idx];
    const newStr = displayOf_(nv);
    if (oldStr === newStr) return;
    cur[idx] = nv;
    if (f !== '重複比對鍵') logs.push([now, me.name, id, f, oldStr, newStr]);
  });
  if (!logs.length) return 0;

  cur[headers.indexOf('最後更新時間')] = now;
  cur[headers.indexOf('最後更新者')] = me.name;
  range.setValues([cur]);
  appendLogs_(logs);
  bumpVersion_();
  return logs.length;
}

/** 寫入前整理與檢查欄位值 */
function normalizeIn_(field, value) {
  if (value === null || value === undefined) value = '';
  if (DATE_FIELDS.indexOf(field) >= 0) {
    const s = txt_(value);
    if (!s) return '';
    const m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (!m) throw new Error(field + ' 格式錯誤：' + s);
    return new Date(+m[1], +m[2] - 1, +m[3]);
  }
  if (TIME_FIELDS.indexOf(field) >= 0) {
    const s = txt_(value);
    if (!s) return '';
    const m = s.match(/^(\d{1,2}):(\d{2})$/);
    if (!m || +m[1] > 23 || +m[2] > 59) throw new Error(field + ' 格式錯誤：' + s);
    return ('0' + m[1]).slice(-2) + ':' + m[2];
  }
  if (field === '年齡') {
    const s = txt_(value);
    if (!s) return '';
    const n = parseInt(s, 10);
    if (isNaN(n) || n < 15 || n > 90) throw new Error('年齡格式錯誤：' + s);
    return n;
  }
  const s = txt_(value);
  if (FIELD_OPTION[field] && s && OPTIONS[FIELD_OPTION[field]].indexOf(s) < 0) {
    throw new Error(field + ' 不在選項內：' + s);
  }
  return safeText_(s);
}

/** 防止履歷文字被試算表當成公式 */
function safeText_(s) {
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function displayOf_(v) {
  if (v instanceof Date) return fmtD_(v, 'yyyy/MM/dd');
  return String(v).replace(/^'/, '');
}

function toClient_(obj) {
  const o = {};
  Object.keys(obj).forEach(k => {
    if (k === '_row') return;
    const v = obj[k];
    o[k] = v instanceof Date ? fmtD_(v, 'yyyy/MM/dd HH:mm') : v;
  });
  return o;
}

function upsertReview_(cand, review, me) {
  const sh = sheet_('面試評語');
  const headers = headers_('面試評語');
  const rows = readSheet_('面試評語');
  const id = cand['應徵者ID'];
  const existing = rows.find(r => r['應徵者ID'] === id && txt_(r['面試官Email']).toLowerCase() === me.email);
  const rec = {
    '應徵者ID': id, '應徵者姓名': cand['姓名'], '面試官Email': me.email, '面試官': me.name,
    '現場表現': normalizeIn_('現場表現', review['現場表現']),
    '建議結果': normalizeIn_('建議結果', review['建議結果']),
    '建議團隊': normalizeIn_('建議團隊', review['建議團隊']),
    '辦公地點': normalizeIn_('辦公地點', review['辦公地點']),
    '備註': normalizeIn_('備註', review['備註']),
    '填寫時間': new Date()
  };
  if (existing) {
    rec['評語ID'] = existing['評語ID'];
    sh.getRange(existing._row, 1, 1, headers.length).setValues([headers.map(h => (rec[h] !== undefined ? rec[h] : ''))]);
  } else {
    rec['評語ID'] = nextId_(sh, 'R');
    sh.appendRow(headers.map(h => (rec[h] !== undefined ? rec[h] : '')));
  }
  const summary = ['建議結果', '現場表現', '建議團隊', '辦公地點', '備註']
    .filter(k => txt_(rec[k])).map(k => k + '：' + displayOf_(rec[k])).join('／');
  appendLogs_([[new Date(), me.name, id, existing ? '面試評語（更新）' : '面試評語', '', summary]]);
}

function findDuplicates_(name, phone, excludeId) {
  const n = txt_(name).replace(/\s/g, '');
  const p = txt_(phone).replace(/\D/g, '');
  if (!n && !p) return [];
  return readSheet_('應徵者')
    .filter(c => c['應徵者ID'] !== excludeId)
    .filter(c => {
      const cn = txt_(c['姓名']).replace(/\s/g, '');
      const cp = txt_(c['手機']).replace(/\D/g, '');
      return (n && cn === n) || (p && cp && cp === p);
    })
    .map(c => ({
      id: c['應徵者ID'], name: c['姓名'], phone: txt_(c['手機']), job: txt_(c['應徵職缺']),
      progress: txt_(c['進度']), result: txt_(c['結果']),
      created: c['建檔時間'] instanceof Date ? fmtD_(c['建檔時間'], 'yyyy/MM/dd') : txt_(c['建檔時間'])
    }));
}

function makeDupKey_(name, phone) {
  return txt_(name).replace(/\s/g, '') + '|' + txt_(phone).replace(/\D/g, '');
}

function nextId_(sh, prefix) {
  const last = sh.getLastRow();
  let max = 0;
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach(r => {
      const m = String(r[0]).match(new RegExp('^' + prefix + '(\\d+)$'));
      if (m) max = Math.max(max, +m[1]);
    });
  }
  return prefix + ('000' + (max + 1)).slice(-4);
}

function appendLogs_(logs) {
  if (!logs.length) return;
  const sh = sheet_('異動紀錄');
  sh.getRange(sh.getLastRow() + 1, 1, logs.length, logs[0].length).setValues(logs);
}

function getVersion_() {
  return PropertiesService.getScriptProperties().getProperty('DATA_VERSION') || '0';
}
function bumpVersion_() {
  PropertiesService.getScriptProperties().setProperty('DATA_VERSION', String(Date.now()));
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('系統忙碌中，請稍後再試。');
  try { return fn(); } finally { lock.releaseLock(); }
}

function getResumeFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('RESUME_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 資料夾被刪除，重建 */ }
  }
  const folder = DriveApp.createFolder(CONFIG.RESUME_FOLDER_NAME);
  props.setProperty('RESUME_FOLDER_ID', folder.getId());
  return folder;
}

function extractDriveId_(url) {
  const m = txt_(url).match(/[-\w]{25,}/);
  return m ? m[0] : '';
}

function notifyHR_(subject, body) {
  if (!CONFIG.EMAIL_NOTIFY_HR) return;
  const to = readSheet_('使用者').filter(u => txt_(u['角色']) === 'HR' && u['啟用'] === true).map(u => txt_(u['Email']));
  sendMail_(to, subject, body, '?page=hr');
}

/** 排定或改期後通知：主面試官、陪同面試官、所長 */
function notifyPanel_(c, isNew, note) {
  if (!CONFIG.EMAIL_NOTIFY_PANEL) return;
  const staff = staffByEmail_();
  const to = panelOf_(c).map(e => staff[e] && staff[e].email);
  readSheet_('使用者').forEach(u => { if (u['啟用'] === true && txt_(u['角色']) === '所長') to.push(txt_(u['Email'])); });
  const lines = [
    (isNew ? '已排定面試：' : '面試有異動：') + c['姓名'] + '（' + c['應徵者ID'] + '）' + (note ? '，' + note : ''),
    '時間：' + txt_(c['面試日期']) + ' ' + txt_(c['面試時間']),
    '地點：' + (txt_(c['面試地點']) || '未定'),
    '主面試官：' + txt_(c['主面試官']),
    '陪同：' + ([txt_(c['陪同面試官']), txt_(c['其他陪同'])].filter(Boolean).join('、') || '無'),
    '應徵職缺：' + txt_(c['應徵職缺']),
    '',
    '面試者資料與面試官資料可在主管頁面下載列印。'
  ];
  sendMail_(to, (isNew ? '面試已排定：' : note ? '面試異動：' : '面試改期：') + c['姓名'] + ' ' + txt_(c['面試日期']), lines.join('\n'), '?page=manager');
}

/**
 * 通知行政助理預約會議室與投影機（只限「使用者」表中角色為「行政」、負責地點相符的人）
 * before：排定前的資料（新排定時為 null）；after：排定後的資料（取消時為 null）
 */
function notifyAdmin_(before, after) {
  if (!CONFIG.EMAIL_NOTIFY_ADMIN) return;
  const users = readSheet_('使用者').filter(u => u['啟用'] === true && txt_(u['角色']) === '行政');
  // 同一個信箱只寄一次（使用者表裡同一個人重複出現時也不會重複寄）
  const adminsAt = loc => {
    const seen = {};
    return users.filter(u => {
      const key = normEmail_(u['Email']);
      if (!key || seen[key] || !txt_(u['負責地點']) || txt_(u['負責地點']) !== txt_(loc)) return false;
      seen[key] = true; return true;
    });
  };
  const when = c => txt_(c['面試日期']) + ' ' + txt_(c['面試時間']);
  const info = c => {
    const panel = [txt_(c['主面試官'])].concat(txt_(c['陪同面試官']).split('、'), txt_(c['其他陪同']).split(/[、,，]/))
      .map(x => x.trim()).filter(Boolean);
    return [
      '應徵者：' + c['姓名'] + (txt_(c['應徵職缺']) ? '（' + txt_(c['應徵職缺']) + '）' : ''),
      '時間：' + when(c) + '，建議預約 ' + CONFIG.INTERVIEW_MINUTES + ' 分鐘',
      '地點：' + txt_(c['面試地點']),
      '面試官：' + (panel.join('、') || '未定'),
      '預估人數：' + (panel.length + 1) + ' 人（面試官 ' + panel.length + ' 人＋應徵者 1 人）'
    ];
  };
  const send = (c, title, lead, extra) => adminsAt(c['面試地點']).forEach(u => sendMail_([txt_(u['Email'])],
    title + '：' + c['姓名'] + ' ' + when(c) + ' ' + txt_(c['面試地點']),
    txt_(u['姓名']) + ' 你好：\n\n' + lead + '\n\n' + info(c).concat(extra || []).join('\n'), false));
  const sameLoc = before && after && txt_(before['面試地點']) === txt_(after['面試地點']);
  if (before && !sameLoc) send(before, '取消會議室', '這場面試已取消或改到其他地點，原本預約的會議室與投影機可以取消。');
  if (after && !sameLoc) send(after, '請預約會議室', '有一場面試排在你負責的辦公室，請協助預約會議室並借用投影機。');
  if (sameLoc && when(before) !== when(after)) {
    send(after, '面試改期', '這場面試改了時間，請協助改訂會議室與投影機。', ['原本時間：' + when(before)]);
  }
}

/**
 * 所有通知信都經過這裡。測試模式時一律改寄 TEST_MAIL_TO，並在信中註明原本的收件人。
 * （登入驗證碼由 Auth.gs 直接寄給本人，不受測試模式影響）
 */
function sendMail_(toList, subject, body, page) {
  if (SUPPRESS_MAIL_) return;
  try {
    const to = Array.from(new Set((toList || []).map(txt_).filter(Boolean)));
    if (!to.length) return;
    const url = page !== false && publicUrl_() ? publicUrl_() + (page || '') : '';   // page=false：不附系統連結（給行政）
    let rcpt = to.join(','), subj = '[招募系統] ' + subject, text = body + (url ? '\n\n系統連結：' + url : '');
    if (CONFIG.TEST_MODE) {
      rcpt = CONFIG.TEST_MAIL_TO;
      subj = '[測試] ' + subj;
      text = '（測試模式：這封信原本要寄給 ' + to.join('、') + '）\n\n' + text;
    }
    MailApp.sendEmail({ to: rcpt, subject: subj, body: text, name: CONFIG.APP_TITLE });
  } catch (e) {
    console.error('通知信寄送失敗：' + e);
  }
}

function txt_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function fmtD_(d, pattern) { return Utilities.formatDate(d, CONFIG.TZ, pattern); }

// =====================================================================
// 自我測試（走完整流程後自動刪除測試資料，不會寄信）
// =====================================================================
function selfTest() {
  SUPPRESS_MAIL_ = true;
  const me = getCurrentUser_();
  if (!me || me.role !== '管理員') throw new Error('目前執行帳號「' + (Session.getActiveUser().getEmail() || '抓不到') + '」不是「使用者」表中已啟用的管理員。');
  const testName = '測試員_自動刪除';
  let id = null;
  const ok = msg => console.log('✅ ' + msg);

  try {
    const r1 = createCandidate({ '姓名': testName, '性別': '男', '年齡': '30', '手機': '0900-000-000',
      '應徵管道': '主動應徵', '最高學歷': '碩畢', '工作經歷': '=測試公式防護' }, false);
    if (!r1.ok) throw new Error('建檔失敗（可能已有同名測試資料，請先手動刪除）');
    id = r1.id; ok('建檔 ' + id);

    const r2 = createCandidate({ '姓名': testName, '手機': '0900000000' }, false);
    if (r2.ok || !r2.duplicates.length) throw new Error('重複檢查沒有攔下來');
    ok('重複應徵檢查（找到 ' + r2.duplicates.length + ' 筆）');

    try { markInterviewed(id); throw new Error('流程檢查失效'); }
    catch (e) { if (e.message === '流程檢查失效') throw e; ok('流程檢查：未約面試不能標記已面試'); }

    setScreening(id, '約面試'); ok('初選：約面試');
    try { scheduleInterview(id, '2026-10-01', '14:00', '台中辦公室'); throw new Error('流程檢查失效'); }
    catch (e) { if (e.message === '流程檢查失效') throw e; ok('流程檢查：沒有主面試官不能排時間'); }
    joinInterview(id); ok('認領：成為主面試官');
    const pj = readProjectList_().filter(x => x.enabled)[0];
    setInterviewPlan(id, [pj.id], '測試陪同'); ok('主面試官選計畫：' + pj.id);
    try { scheduleInterview(id, '2026-10-01', '14:00'); throw new Error('流程檢查失效'); }
    catch (e) { if (e.message === '流程檢查失效') throw e; ok('流程檢查：主面試官沒選地點不能排時間'); }
    setInterviewLocation(id, '院本部'); ok('主面試官選面試地點：院本部');
    scheduleInterview(id, '2026-10-01', '14:00', '台中辦公室'); ok('HR 排定面試');
    addReview(id, { '現場表現': '佳', '建議結果': '建議聘用', '備註': '測試評語' }); ok('新增評語');
    submitInterview(id, '錄取', { '現場表現': '優', '建議團隊': '純行政', '辦公地點': '台中辦公室', '備註': '測試' });
    ok('面試完成：已面試＋結果錄取（同一人評語應更新而非新增）');
    setPostOffer(id, '願意入職', '2026-10-19'); ok('HR 更新錄取後進度');

    const d = getCandidateDetail(id);
    const c = d.candidate;
    const checks = [
      ['進度', c['進度'], '已面試'], ['結果', c['結果'], '錄取'], ['錄取後進度', c['錄取後進度'], '願意入職'],
      ['面試日期', c['面試日期'], '2026/10/01'], ['面試時間', c['面試時間'], '14:00'],
      ['預計到職日', c['預計到職日'], '2026/10/19'], ['評語筆數', d.reviews.length, 1]
    ];
    checks.forEach(([k, got, want]) => {
      if (String(got) !== String(want)) throw new Error(k + ' 應為「' + want + '」，實際為「' + got + '」');
    });
    ok('資料檢查通過（異動紀錄 ' + d.history.length + ' 筆）');
    console.log('🎉 全部測試通過');
  } finally {
    if (id) {
      deleteRowsWhere_('應徵者', 0, id);
      deleteRowsWhere_('面試評語', 1, id);
      deleteRowsWhere_('異動紀錄', 2, id);
      bumpVersion_();
      console.log('🧹 已刪除測試資料 ' + id);
    }
    SUPPRESS_MAIL_ = false;
  }
}

function deleteRowsWhere_(name, colIdx, value) {
  const sh = sheet_(name);
  const data = sh.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][colIdx] === value) sh.deleteRow(i + 1);
  }
}

// =====================================================================
// 管理員維護工具（在編輯器執行）
// =====================================================================
/** 檢查目前執行帳號，以及「使用者」表的比對結果 */
function whoAmI() {
  console.log('目前執行帳號：' + (Session.getActiveUser().getEmail() || '（抓不到）'));
  readSheet_('使用者').forEach(u =>
    console.log(JSON.stringify(u['Email']) + ' | ' + JSON.stringify(u['角色']) + ' | 啟用=' + u['啟用']));
  console.log('比對結果：' + JSON.stringify(getCurrentUser_()));
}

/** 刪除一筆測試資料：把下面的編號改成要刪的應徵者 ID 再執行 */
function deleteTestCandidate() {
  const id = 'C0027';
  deleteRowsWhere_('應徵者', 0, id);
  deleteRowsWhere_('面試評語', 1, id);
  deleteRowsWhere_('異動紀錄', 2, id);
  bumpVersion_();
  console.log('已刪除 ' + id + ' 的所有資料');
}
