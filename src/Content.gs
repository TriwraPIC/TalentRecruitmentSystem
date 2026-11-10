/**
 * 115 二所人力招募系統 — 計畫內容（面試文件產生器併入）
 *
 * 資料來源：試算表的三張工作表
 *   計畫內容      每個計畫的面試者版與面試官版內容，只改「內容」欄
 *   計畫清單      計畫ID、分類標籤、啟用（FALSE＝排面試時不出現）
 *   職缺對應計畫  應徵職缺包含某個關鍵字時，排面試預先勾選的計畫（可不填）
 *
 * 對外：
 *   ?page=job&p=計畫ID   應徵者說明頁，不需登入：只有面試者版（精簡）
 *   getProjectList       HR 排面試時選計畫用
 *   getInterviewMemo     面試官資料（面試官版 1～10），需登入
 *   getCandidateBrief    面試者資料（與說明頁相同內容，附應徵者抬頭），需登入
 *
 * 管理員工具（試算表選單「招募系統」）：
 *   更新計畫內容   改完內容後按一下，馬上生效並更新計畫清單的名稱與連結
 *   檢查計畫內容   列出空白名稱、找不到的計畫ID等問題
 *   新增計畫       複製一個既有計畫的所有列，改成新的計畫ID
 */

const CONTENT = {
  SHEET: '計畫內容',
  LIST: '計畫清單',
  MAP: '職缺對應計畫',
  CACHE_SEC: 21600               // 快取 6 小時；內容一改就會失效
};
const LIST_SUBFIELDS_ = ['examples', 'answer_points'];   // 儲存格內「一行一點」的欄位

// =====================================================================
// 讀取與組裝
// =====================================================================
/** 把試算表的列組回計畫物件（結構與原本面試文件產生器相同） */
function buildProject_(id, rows) {
  const p = { id: id, code: id.split('_')[0], slug: id.slice(id.indexOf('_') + 1), candidate: {}, interviewer_short: {} };
  const tmp = {};
  rows.forEach(r => {
    const path = String(r.path || '').trim();
    const val = String(r.value == null ? '' : r.value).replace(/\r\n/g, '\n').trim();
    if (!path) return;
    const seg = path.split('.');
    const part = seg[0], key = seg[1];
    const target = part === 'basic' ? p : p[part];
    if (!target || !key) return;
    if (seg.length === 2) { target[key] = val; return; }
    const i = Number(seg[2]);
    if (isNaN(i)) return;
    const bucket = (tmp[part + '.' + key] = tmp[part + '.' + key] || { target: target, key: key, items: {} });
    if (seg.length === 3) { if (val) bucket.items[i] = val; return; }
    const sub = seg[3];
    const it = bucket.items[i] = bucket.items[i] || {};
    it[sub] = LIST_SUBFIELDS_.indexOf(sub) >= 0 ? val.split('\n').map(s => s.trim()).filter(Boolean) : val;
  });
  Object.keys(tmp).forEach(k => {
    const b = tmp[k];
    b.target[b.key] = Object.keys(b.items).map(Number).sort((a, c) => a - c).map(n => b.items[n])
      .filter(it => typeof it === 'string' ? !!it
        : Object.keys(it).some(s => Array.isArray(it[s]) ? it[s].length : it[s]));
  });
  return p;
}

function contentVersion_() {
  return PropertiesService.getScriptProperties().getProperty('CONTENT_VERSION') || '0';
}
function bumpContentVersion_() {
  PropertiesService.getScriptProperties().setProperty('CONTENT_VERSION', String(Date.now()));
}

/** 讀出計畫清單（含未啟用），順序依工作表 */
function readProjectList_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONTENT.LIST);
  if (!sh) throw new Error('找不到工作表「' + CONTENT.LIST + '」，請先匯入計畫內容。');
  const v = sh.getDataRange().getValues();
  const h = v[0].map(txt_);
  const ci = h.indexOf('計畫ID'), ct = h.indexOf('分類標籤'), ce = h.indexOf('啟用');
  const cg = h.indexOf('組別'), cn = h.indexOf('顯示名稱');
  return v.slice(1).filter(r => txt_(r[ci])).map(r => ({
    id: txt_(r[ci]), tag: ct >= 0 ? txt_(r[ct]) : '',
    group: cg >= 0 ? txt_(r[cg]) : '', name: cn >= 0 ? txt_(r[cn]) : '',
    enabled: ce < 0 || r[ce] === true || txt_(r[ce]).toUpperCase() === 'TRUE'
  }));
}

/** 讀整張「計畫內容」並組好所有計畫，回傳 { 計畫ID: 計畫物件 } */
function buildAllProjects_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONTENT.SHEET);
  if (!sh) throw new Error('找不到工作表「' + CONTENT.SHEET + '」，請先匯入計畫內容。');
  const disp = sh.getDataRange().getDisplayValues();   // 用畫面上的文字，避免被轉成數字或日期
  const h = disp[0].map(txt_);
  const ci = h.indexOf('計畫ID'), cp = h.indexOf('路徑'), cv = h.indexOf('內容');
  if (ci < 0 || cp < 0 || cv < 0) throw new Error('「' + CONTENT.SHEET + '」少了「計畫ID」「路徑」或「內容」欄。');
  const byId = {};
  for (let i = 1; i < disp.length; i++) {
    const id = txt_(disp[i][ci]);
    if (!id) continue;
    (byId[id] = byId[id] || []).push({ path: disp[i][cp], value: disp[i][cv] });
  }
  const meta = {};
  try { readProjectList_().forEach(x => { meta[x.id] = x; }); } catch (e) { /* 沒有清單時不影響內容 */ }
  const out = {};
  Object.keys(byId).forEach(id => {
    const p = buildProject_(id, byId[id]);
    const m = meta[id] || {};
    p.tag = m.tag || '';
    p.group = m.group || '';
    p.name = m.name || p.slug;                 // 顯示名稱，例如「主計發展」
    if (!p.title) p.title = p.name;            // 新計畫還沒填計畫名稱時
    p.empty = !txt_(p.candidate.project_intro) && !txt_((p.interviewer_short || {}).overview);
    out[id] = p;
  });
  return out;
}

/** 取得單一計畫（有快取）；找不到回傳 null */
function getProject_(id) {
  id = txt_(id);
  if (!id) return null;
  const cache = CacheService.getScriptCache();
  const prefix = 'PJ_' + contentVersion_() + '_';
  const hit = cache.get(prefix + id);
  if (hit) return JSON.parse(hit);
  const all = buildAllProjects_();
  const put = {};
  Object.keys(all).forEach(k => {
    const s = JSON.stringify(all[k]);
    if (s.length < 95000) put[prefix + k] = s;
  });
  try { cache.putAll(put, CONTENT.CACHE_SEC); } catch (e) { /* 快取失敗只影響速度 */ }
  return all[id] || null;
}

function jobUrl_(id, base) {
  const b = base !== undefined ? base : publicUrl_();
  return b ? b + '?page=job&p=' + encodeURIComponent(id) : '';
}

function splitProjectIds_(s) {
  return txt_(s).split(/[、,，;；\s]+/).map(x => x.trim()).filter(Boolean);
}

// =====================================================================
// 網頁 API
// =====================================================================
/** HR 排面試時用：啟用中的計畫清單與職缺關鍵字對應 */
function getProjectList() {
  requireRole_('view');
  const base = publicUrl_();
  const projects = readProjectList_().filter(x => x.enabled).map(x => {
    const p = getProject_(x.id);
    if (!p) return null;
    return { id: x.id, code: p.code, slug: p.slug, tag: x.tag, title: p.title || x.id,
      name: p.name, group: x.group || '其他', empty: !!p.empty,
      client: p.client || '', year: p.year || '', url: jobUrl_(x.id, base) };
  }).filter(Boolean);

  const map = [];
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONTENT.MAP);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 2).getDisplayValues().forEach(r => {
      if (txt_(r[0]) && txt_(r[1])) map.push({ kw: txt_(r[0]), id: txt_(r[1]) });
    });
  }
  return { projects: projects, map: map };
}

/** 面試準備資料：回傳這位應徵者的面試計畫（面試官版內容）與應徵者摘要 */
function getInterviewMemo(id) {
  const me = requireRole_('memo');
  const c = getCandidateObj_(id);
  const ids = splitProjectIds_(c['面試計畫']);
  if (!ids.length) throw new Error('HR 還沒有設定這位應徵者的面試計畫。');
  const projects = ids.map(pid => {
    const p = getProject_(pid);
    if (!p) return null;
    return { id: p.id, code: p.code, slug: p.slug, tag: p.tag, title: p.title, client: p.client, year: p.year,
      name: p.name, group: p.group, empty: !!p.empty, url: jobUrl_(p.id),
      // 面試官看完整的面試官版 1～10（面試的人不一定是計畫負責人，需要較多背景）
      interviewer_short: p.interviewer_short || {} };
  }).filter(Boolean);
  if (!projects.length) throw new Error('找不到這位應徵者的面試計畫內容（' + ids.join('、') + '），請聯絡管理員。');
  return { viewer: me.name, candidate: candidateSummary_(c, id), projects: projects };
}

/**
 * 給應徵者看的內容：只有面試者版（精簡、A4 1～2 頁）
 * 面試官版（背景、名詞、問法、訊號、題目、注意事項）一律不放進來
 */
function publicView_(p) {
  return { id: p.id, code: p.code, slug: p.slug, title: p.title, client: p.client, year: p.year,
    name: p.name, group: p.group, empty: !!p.empty, candidate: p.candidate || {} };
}

/** 面試者資料：與應徵者說明頁相同的內容，附應徵者姓名等抬頭，供主管與 HR 檢視或下載 Word */
function getCandidateBrief(id) {
  const me = requireRole_('memo');
  const c = getCandidateObj_(id);
  const ids = splitProjectIds_(c['面試計畫']);
  if (!ids.length) throw new Error('HR 還沒有設定這位應徵者的面試計畫。');
  const base = publicUrl_();
  const projects = ids.map(pid => getProject_(pid)).filter(Boolean)
    .map(p => Object.assign(publicView_(p), { url: jobUrl_(p.id, base) }));
  if (!projects.length) throw new Error('找不到這位應徵者的面試計畫內容（' + ids.join('、') + '），請聯絡管理員。');
  return { viewer: me.name, candidate: candidateSummary_(c, id), projects: projects };
}

function candidateSummary_(c, id) {
  const pick = ['姓名', '應徵職缺', '面試日期', '面試時間', '面試地點', '最高學歷', '最高學歷學校科系', '工作經歷'];
  const cand = { '應徵者ID': id };
  pick.forEach(k => { cand[k] = c[k] instanceof Date ? fmtD_(c[k], 'yyyy/MM/dd') : txt_(c[k]); });
  if (txt_(c['主面試官'])) {
    const rest = [txt_(c['陪同面試官']), txt_(c['其他陪同'])].filter(Boolean).join('、').split(/[、,，]/).map(x => x.trim()).filter(Boolean);
    cand['面試官組合'] = [txt_(c['主面試官']) + '（主）'].concat(rest).join('、');
  }
  return cand;
}

/** 檢查計畫ID是否存在，回傳整理好的清單 */
function validProjectIds_(ids) {
  const list = Array.isArray(ids) ? ids : splitProjectIds_(ids);
  const clean = [];
  list.map(txt_).filter(Boolean).forEach(pid => {
    if (clean.indexOf(pid) >= 0) return;
    if (!getProject_(pid)) throw new Error('找不到計畫「' + pid + '」，請重新整理頁面後再試。');
    clean.push(pid);
  });
  return clean;
}

// =====================================================================
// 應徵者說明頁（不需登入，只送面試者版）
// =====================================================================
function jobPage_(id) {
  const t = HtmlService.createTemplateFromFile('Job');
  t.p = null;
  try {
    const listed = readProjectList_().find(x => x.id === txt_(id));
    const p = listed && listed.enabled ? getProject_(id) : null;
    if (p) t.p = publicView_(p);
  } catch (e) {
    console.error('說明頁讀取失敗：' + e);
  }
  return t.evaluate()
    .setTitle(t.p ? t.p.title + '｜工作說明' : '工作說明')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// =====================================================================
// 管理員工具
// =====================================================================
/** 試算表內直接修改內容時，讓快取立即失效（簡易觸發條件，不需另外設定） */
function onEdit(e) {
  try {
    const name = e && e.range ? e.range.getSheet().getName() : '';
    if (name === CONTENT.SHEET || name === CONTENT.LIST) bumpContentVersion_();
  } catch (err) { /* 不影響編輯 */ }
}

/** 選單：更新計畫內容（清除快取，並回寫計畫清單的名稱與說明頁連結） */
function refreshContent() {
  bumpContentVersion_();
  const report = checkContent_();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CONTENT.LIST);
  if (sh && sh.getLastRow() > 1) {
    const h = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(txt_);
    const ci = h.indexOf('計畫ID'), cn = h.indexOf('計畫名稱（自動）'), cu = h.indexOf('應徵者說明頁（自動）');
    const ids = sh.getRange(2, ci + 1, sh.getLastRow() - 1, 1).getValues().map(r => txt_(r[0]));
    const all = buildAllProjects_();
    const base = publicUrl_();
    if (cn >= 0) sh.getRange(2, cn + 1, ids.length, 1).setValues(ids.map(id => [all[id] ? all[id].title : (id ? '（找不到內容）' : '')]));
    if (cu >= 0) sh.getRange(2, cu + 1, ids.length, 1).setValues(ids.map(id => [id && all[id] ? jobUrl_(id, base) : '']));
  }
  return showReport_('計畫內容已更新', report);
}

/** 選單：只檢查不更新 */
function checkContent() {
  return showReport_('計畫內容檢查', checkContent_());
}

function checkContent_() {
  const all = buildAllProjects_();
  const list = readProjectList_();
  const problems = [];
  const required = ['title', 'client', 'year'];
  Object.keys(all).forEach(id => {
    const p = all[id];
    if (!/^\w+_.+/.test(id)) problems.push(id + '：計畫ID 格式應為「代碼_簡稱」，例如 03_主計');
    if (!list.some(x => x.id === id)) problems.push(id + '：有內容，但「計畫清單」沒有這個計畫（HR 看不到）');
    if (p.empty) { problems.push(id + '：內容尚未建立（面試資料會顯示「內容準備中」）'); return; }
    required.forEach(k => { if (!p[k]) problems.push(id + '：缺少' + { title: '計畫名稱', client: '委託機關', year: '計畫年度' }[k]); });
    if (!p.candidate.project_intro) problems.push(id + '：面試者版「這個計畫在做什麼」是空的');
    if (!(p.interviewer_short.questions || []).length) problems.push(id + '：面試官版沒有建議題目');
  });
  list.forEach(x => { if (!all[x.id]) problems.push(x.id + '：在「計畫清單」裡，但「計畫內容」找不到'); });
  return { count: Object.keys(all).length, enabled: list.filter(x => x.enabled && all[x.id]).length, problems: problems };
}

function showReport_(title, r) {
  const msg = '計畫共 ' + r.count + ' 個，啟用中 ' + r.enabled + ' 個。\n\n' +
    (r.problems.length ? '需要注意：\n' + r.problems.map(s => '・' + s).join('\n') : '沒有發現問題。');
  console.log(title + '\n' + msg);
  try { SpreadsheetApp.getUi().alert(title, msg, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* 從編輯器執行時沒有畫面 */ }
  return r;
}

/** 選單：新增計畫（複製既有計畫的所有列） */
function menuNewProject() {
  const ui = SpreadsheetApp.getUi();
  const ask = (t, m) => { const r = ui.prompt(t, m, ui.ButtonSet.OK_CANCEL); return r.getSelectedButton() === ui.Button.OK ? r.getResponseText() : null; };
  const id = ask('新增計畫（1/4）', '新計畫的計畫ID（格式：代碼_簡稱，例如 16_智慧灌溉；建立後不要再改）：'); if (id === null) return;
  const name = ask('新增計畫（2/4）', '顯示名稱（勾選時看到的名字，例如「智慧灌溉」）：'); if (name === null) return;
  const group = ask('新增計畫（3/4）', '組別（例如：綜合業務組、土地利用組、綠能發展組、人事政策組、公私協力組）：'); if (group === null) return;
  const from = ask('新增計畫（4/4）', '以哪個計畫為範本？請輸入既有的計畫ID（例如 03_主計）：'); if (from === null) return;
  try {
    const n = newProject(id, from, name, group);
    ui.alert('已新增「' + txt_(name) + '」（' + n + ' 列），排在「計畫內容」最下方。\n' +
      '請修改這些列的「內容」欄，改完按選單「更新計畫內容」。\n新計畫預設為「未啟用」，確認無誤後再到「計畫清單」把「啟用」打勾。');
  } catch (e) { ui.alert('新增失敗：' + e.message); }
}

function newProject(newId, fromId, name, group) {
  newId = txt_(newId); fromId = txt_(fromId);
  if (!/^\w+_.+/.test(newId)) throw new Error('計畫ID 格式應為「代碼_簡稱」，例如 16_智慧灌溉。');
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CONTENT.SHEET);
  const v = sh.getDataRange().getValues();
  if (v.some((r, i) => i > 0 && txt_(r[0]) === newId)) throw new Error('「' + newId + '」已經存在。');
  const rows = v.filter((r, i) => i > 0 && txt_(r[0]) === fromId).map(r => { const x = r.slice(); x[0] = newId; return x; });
  if (!rows.length) throw new Error('找不到範本計畫「' + fromId + '」。');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setNumberFormat('@').setValues(rows);
  // 依「計畫清單」實際的欄位名稱寫入，欄位順序改過也不會寫錯
  const list = ss.getSheetByName(CONTENT.LIST);
  const h = list.getRange(1, 1, 1, list.getLastColumn()).getValues()[0].map(txt_);
  const rec = { '計畫ID': newId, '組別': txt_(group), '顯示名稱': txt_(name) || newId.slice(newId.indexOf('_') + 1), '啟用': false };
  const row = list.getLastRow() + 1;
  list.getRange(row, 1, 1, h.length).setValues([h.map(k => rec[k] !== undefined ? rec[k] : '')]);
  const ce = h.indexOf('啟用');
  if (ce >= 0) list.getRange(row, ce + 1).insertCheckboxes().setValue(false);
  bumpContentVersion_();
  return rows.length;
}
