/**
 * 115 二所人力招募系統 — 第六步：履歷自動解析（Gemini API）
 *
 * 設定金鑰（擇一）：
 *   A. 試算表選單「招募系統 → 設定 Gemini 金鑰」「設定 Claude 金鑰」
 *   B. 專案設定 → 指令碼屬性 → 新增 GEMINI_API_KEY／ANTHROPIC_API_KEY
 *
 * 辨識順序：先用 Gemini（免費）；Gemini 忙碌、額度用完或出錯時，自動改用 Claude（付費，只有失敗的那幾份才計費）。
 * 只設定 Claude 金鑰時，直接用 Claude。Claude 模型預設 claude-haiku-5-5，可在指令碼屬性 CLAUDE_MODEL 改。
 *
 * 模型會自動選擇最新的正式版 flash 模型；Google 下架模型時也會自動換新，不必手動設定。
 *
 * 編輯器可執行的工具：
 *   autoPickGeminiModel   重新選擇模型並測試連線（最常用）
 *   testGeminiConnection  只測試連線
 *   testClaudeConnection  測試 Claude 連線
 *   checkProps            列出已儲存的設定名稱（不顯示金鑰內容）
 *
 * 隱私：本檔不會把履歷內容寫進執行記錄。
 * 提醒：免費方案送出的內容可能被 Google 用於改善產品，正式使用真實履歷前請改用付費方案。
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/';
const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_DEFAULT_MODEL = 'claude-haiku-5-5';

// AI 回傳的英文欄位 → 系統欄位
const PARSE_MAP = {
  name: '姓名', gender: '性別', age: '年齡', phone: '手機', email: 'Email', city: '現居',
  eduLevel: '最高學歷', eduTop: '最高學歷學校科系', eduSecond: '次高學歷學校科系',
  experience: '工作經歷', tender: '標案經驗', report: '報告經驗', skills: '其他專長', jobTitle: '應徵職缺'
};

const PARSE_SCHEMA_ = {
  type: 'OBJECT',
  properties: {
    name:       { type: 'STRING',  description: '姓名' },
    gender:     { type: 'STRING',  description: '男或女，無法判斷留空' },
    age:        { type: 'INTEGER', description: '年齡，找不到填 0' },
    phone:      { type: 'STRING',  description: '手機號碼' },
    email:      { type: 'STRING',  description: 'Email' },
    city:       { type: 'STRING',  description: '現居地，例如 台中北屯' },
    eduLevel:   { type: 'STRING',  description: '最高學歷代碼' },
    eduTop:     { type: 'STRING',  description: '最高學歷 學校 科系' },
    eduSecond:  { type: 'STRING',  description: '次高學歷 學校 科系' },
    experience: { type: 'STRING',  description: '工作經歷摘要' },
    tender:     { type: 'STRING',  description: '有 或空字串' },
    report:     { type: 'STRING',  description: '有 或空字串' },
    skills:     { type: 'STRING',  description: '其他專長' },
    jobTitle:   { type: 'STRING',  description: '應徵職務原文' }
  },
  required: ['name']
};

// =====================================================================
// 網頁呼叫：傳入履歷檔（base64），回傳自動帶入的欄位
// =====================================================================
function parseResume(base64, mimeType) {
  requireRole_('createCandidate');
  if (CONFIG.AUTO_PARSE === false) return { disabled: true, fields: {} };
  const mt = mimeType || 'application/pdf';
  if (!/pdf|^image\//.test(mt)) throw new Error('自動帶入只支援 PDF 或圖片檔。');

  const props = PropertiesService.getScriptProperties();
  const hasGemini = !!txt_(props.getProperty('GEMINI_API_KEY'));
  const hasClaude = !!txt_(props.getProperty('ANTHROPIC_API_KEY'));
  if (!hasGemini && !hasClaude) throw new Error('尚未設定 AI 金鑰，請管理員從試算表選單「招募系統」設定 Gemini 或 Claude 金鑰。');

  let geminiErr = null;
  // Gemini 剛剛整批失敗（額度用完／忙碌）時，10 分鐘內直接用 Claude，不再浪費時間重試
  const cool = hasClaude && CacheService.getScriptCache().get('GEMINI_COOLDOWN');
  if (hasGemini && !cool) {
    try {
      const out = callGemini_({
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mt, data: base64 } }, { text: buildParsePrompt_() }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema: PARSE_SCHEMA_ }
      });
      return { fields: cleanParsed_(parseJsonReply_(replyText_(out.json))), model: out.model };
    } catch (e) {
      geminiErr = e;
      console.warn('Gemini 辨識失敗' + (hasClaude ? '，改用 Claude：' : '：') + e.message);
      if (hasClaude && /額度|忙碌|使用人數/.test(e.message)) CacheService.getScriptCache().put('GEMINI_COOLDOWN', '1', 600);
      if (!hasClaude) throw e;
    }
  }
  try {
    const out = callClaudeParse_(base64, mt);
    return { fields: cleanParsed_(out.obj), model: out.model, fallback: !!geminiErr };
  } catch (e) {
    throw new Error((geminiErr ? 'Gemini：' + geminiErr.message + '；' : '') + 'Claude：' + e.message);
  }
}

/** 從 AI 回覆中取出 JSON 物件（去掉 ```json 標記與前後多餘文字） */
function parseJsonReply_(text) {
  const raw = String(text || '').replace(/```json|```/g, '').trim();
  try { return JSON.parse(raw); } catch (e) { /* 再試著抓出第一個 {...} */ }
  const m = raw.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch (e) { /* 落到下面 */ } }
  throw new Error('AI 回傳的內容無法解讀，請手動填寫。');
}

// =====================================================================
// Claude 連線（付費備援）
// =====================================================================
function getClaudeKey_() {
  const key = txt_(PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'));
  if (!key) throw new Error('尚未設定 Claude 金鑰，請管理員從試算表選單「招募系統 → 設定 Claude 金鑰」設定。');
  return key;
}

function claudeModel_() {
  return txt_(PropertiesService.getScriptProperties().getProperty('CLAUDE_MODEL')) || CLAUDE_DEFAULT_MODEL;
}

/** 呼叫 Claude Messages API；伺服器忙碌（429／5xx／529）時等一下再試，最多 3 次 */
function claudeFetch_(content, maxTokens) {
  const key = getClaudeKey_(), model = claudeModel_();
  let code = 0, text = '';
  for (let i = 0; i < 3; i++) {
    let resp;
    try {
      resp = UrlFetchApp.fetch(CLAUDE_URL, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        // 不帶 temperature：新版 Claude 模型已不接受這個參數
        payload: JSON.stringify({ model: model, max_tokens: maxTokens || 1500,
          messages: [{ role: 'user', content: content }] })
      });
    } catch (e) {
      throw new Error('無法連線到 Claude，可能被單位的管理政策封鎖：' + e.message);
    }
    code = resp.getResponseCode(); text = resp.getContentText();
    if (code === 200) {
      const json = JSON.parse(text);
      return { model: model, text: (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('') };
    }
    if (!(code === 429 || code === 529 || code >= 500) || i === 2) break;
    Utilities.sleep(3000 * (i + 1));
  }
  let msg = '';
  try { msg = JSON.parse(text).error.message; } catch (e) { msg = text.slice(0, 300); }
  console.warn('Claude 回應 ' + code + '：' + msg);
  if (code === 401) throw new Error('Claude API 金鑰無效，請管理員重新設定。');
  if (code === 403) throw new Error('Claude API 金鑰沒有權限：' + msg);
  if (code === 429) throw new Error('Claude 呼叫太頻繁或額度不足，請稍後再試：' + msg);
  if (code === 529 || code >= 500) throw new Error('Claude 目前忙碌，請稍後再試。');
  if (code === 404) throw new Error('找不到 Claude 模型「' + model + '」，請在指令碼屬性 CLAUDE_MODEL 改成可用的模型：' + msg);
  throw new Error('Claude 回應錯誤（' + code + '）：' + msg);
}

function callClaudeParse_(base64, mt) {
  const keys = Object.keys(PARSE_MAP);
  const fileBlock = /pdf/.test(mt)
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
    : { type: 'image', source: { type: 'base64', media_type: mt, data: base64 } };
  const prompt = buildParsePrompt_() + '\n\n請只回傳一個 JSON 物件，不要任何說明文字或 ``` 標記。' +
    '鍵名固定為：' + keys.join(', ') + '。所有值都用字串，age 用數字（找不到填 0）。';
  const out = claudeFetch_([fileBlock, { type: 'text', text: prompt }], 2000);
  return { obj: parseJsonReply_(out.text), model: 'Claude ' + out.model };
}

function buildParsePrompt_() {
  const year = new Date().getFullYear();
  return [
    '你是人資助理，請從這份履歷擷取資料，依指定的 JSON 格式回傳。',
    '規則：',
    '1. 只根據履歷內容填寫。找不到的欄位一律回傳空字串（年齡回傳 0），不要猜測。',
    '2. 年齡：履歷有寫年齡就直接使用；只有出生日期時，以 ' + year + ' 年計算足歲。',
    '3. eduLevel 只能是以下其中一個：' + OPTIONS['學歷'].join('、') + '。「ing」代表就讀中，「肄」代表肄業，學士以下填「其他」。',
    '4. eduTop、eduSecond 格式為「學校名稱 科系名稱」，例如「國立政治大學 公共行政學系」。',
    '5. city：縣市加行政區，去掉「市」「縣」「區」「鄉」「鎮」字，例如「台中北屯」「新北淡水」「彰化彰化」。',
    '6. experience：依時間由近到遠，格式「職稱（公司）年資y」，年資四捨五入到整數年，不足一年寫「未滿1y」，以「、」分隔。' +
      '例如「行政助理（某某公司）1y、活動主持人（自由接案）3y」。沒有工作經驗就寫「無工作經驗」。',
    '7. tender：履歷提到參與政府標案、投標、備標、撰寫計畫書或執行政府委託計畫時填「有」，否則空字串。',
    '8. report：履歷提到撰寫研究報告、期中期末報告、成果報告或論文時填「有」，否則空字串。',
    '9. skills：證照、語言能力、軟體技能、駕照等，以「、」分隔，最多 10 項。',
    '10. jobTitle：履歷中「應徵職務」或「希望職稱」的原文，沒有就空字串。',
    '11. phone：只保留數字和連字號，例如 0912-345-678。'
  ].join('\n');
}

/** 檢查 AI 回傳值，不合規則的欄位直接清空，交給 HR 手動填 */
function cleanParsed_(o) {
  const out = {};
  const s = v => (v === null || v === undefined ? '' : String(v).trim());
  Object.keys(PARSE_MAP).forEach(k => {
    let v = s(o[k]);
    if (k === 'age') { const n = parseInt(v, 10); v = n >= 15 && n <= 90 ? n : ''; }
    if (k === 'gender' && OPTIONS['性別'].indexOf(v) < 0) v = '';
    if (k === 'eduLevel' && OPTIONS['學歷'].indexOf(v) < 0) v = '';
    if ((k === 'tender' || k === 'report') && v !== '有') v = '';
    if (k === 'phone') v = v.replace(/[^\d\-+]/g, '');
    if (typeof v === 'string' && v.length > 2000) v = v.slice(0, 2000);
    out[PARSE_MAP[k]] = v;
  });
  return out;
}

// =====================================================================
// Gemini 連線（模型不存在時自動換新模型並重試一次）
// =====================================================================
function callGemini_(body) {
  const key = getGeminiKey_();
  let model = txt_(PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL'));
  if (!model) model = pickGeminiModel_(key);

  let r = geminiFetchRetry_(model, key, body);
  if (r.code === 404) {
    model = pickGeminiModel_(key);
    r = geminiFetchRetry_(model, key, body);
  }
  // 主要模型忙碌或額度用完時，依序改用其他模型（每個模型的免費額度是分開計算的）
  if (isBusy_(r.code) || r.code === 429) {
    console.warn('Gemini 模型 ' + model + ' 回應 ' + r.code + '：' + r.msg);
    let pool = [];
    try { pool = geminiModelPool_(key).filter(m => m !== model).slice(0, 4); } catch (e) { /* 查不到清單就略過 */ }
    for (const alt of pool) {
      const r2 = geminiFetch_(alt, key, body);
      if (r2.code === 200) {
        PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', alt);   // 下次直接用這個
        return { json: r2.json, model: alt };
      }
      console.warn('Gemini 模型 ' + alt + ' 回應 ' + r2.code + '：' + r2.msg);
    }
  }
  if (r.code === 200) return { json: r.json, model: model };

  if (isBusy_(r.code)) throw new Error('Gemini 目前使用人數太多，請按「重新辨識」再試一次，或先手動填寫。');
  if (r.code === 429) throw new Error('已達 Gemini 免費額度上限（' + String(r.msg).slice(0, 120) + '），請過幾分鐘再試，或先手動填寫。');
  if (r.code === 400 && /api key/i.test(r.msg)) throw new Error('Gemini API 金鑰無效，請管理員重新設定金鑰。');
  if (r.code === 403) throw new Error('Gemini API 金鑰沒有權限：' + r.msg);
  throw new Error('Gemini 回應錯誤（' + r.code + '）：' + r.msg);
}

function geminiFetch_(model, key, body) {
  let resp;
  try {
    resp = UrlFetchApp.fetch(GEMINI_BASE + 'models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'post', contentType: 'application/json',
      headers: { 'x-goog-api-key': key },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
  } catch (e) {
    throw new Error('無法連線到 Gemini，可能被單位的管理政策封鎖：' + e.message);
  }
  const code = resp.getResponseCode();
  const text = resp.getContentText();
  if (code === 200) return { code: code, json: JSON.parse(text), msg: '' };
  let msg = '';
  try { msg = JSON.parse(text).error.message; } catch (e) { msg = text.slice(0, 200); }
  return { code: code, json: null, msg: msg };
}

function isBusy_(code) { return code === 503 || code === 500 || code === 502 || code === 504; }

/** 伺服器忙碌時等一下再試，最多 3 次 */
function geminiFetchRetry_(model, key, body) {
  let r;
  for (let i = 0; i < 3; i++) {
    r = geminiFetch_(model, key, body);
    if (!isBusy_(r.code)) return r;
    if (i < 2) Utilities.sleep(2000 * (i + 1));
  }
  return r;
}

/** 可用模型清單，依優先順序：正式版 flash（新到舊）→ 正式版 flash-lite（新到舊） */
function geminiModelPool_(key) {
  const resp = UrlFetchApp.fetch(GEMINI_BASE + 'models?pageSize=200', {
    headers: { 'x-goog-api-key': key }, muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) {
    let msg = '';
    try { msg = JSON.parse(resp.getContentText()).error.message; } catch (e) { msg = resp.getContentText().slice(0, 200); }
    throw new Error('查詢 Gemini 模型失敗：' + msg);
  }
  const names = (JSON.parse(resp.getContentText()).models || [])
    .filter(m => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
    .map(m => m.name.replace('models/', ''));

  const bad = /preview|exp|image|tts|audio|live|thinking/;
  const ver = n => parseFloat((n.match(/(\d+(?:\.\d+)?)/) || [0, 0])[1]);
  const byVer = (a, b) => ver(b) - ver(a);
  const flash = names.filter(n => /flash/.test(n) && !/lite/.test(n) && !bad.test(n)).sort(byVer);
  const lite = names.filter(n => /flash-lite/.test(n) && !bad.test(n)).sort(byVer);
  const pool = flash.concat(lite);
  if (!pool.length) {
    const any = names.filter(n => /flash/.test(n)).sort(byVer);
    if (!any.length) throw new Error('這把金鑰找不到可用的 flash 模型。可用模型：' + names.join('、'));
    return any;
  }
  return pool;
}

/** 挑第一順位的模型並存起來 */
function pickGeminiModel_(key) {
  const model = geminiModelPool_(key)[0];
  PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', model);
  return model;
}

function getGeminiKey_() {
  const key = txt_(PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'));
  if (!key) throw new Error('尚未設定 Gemini 金鑰，請管理員從試算表選單「招募系統 → 設定 Gemini 金鑰」設定。');
  return key;
}

function replyText_(json) {
  const parts = (((json.candidates || [])[0] || {}).content || {}).parts || [];
  return parts.map(p => p.text || '').join('');
}

// =====================================================================
// 試算表選單
// =====================================================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('招募系統')
    .addItem('設定 Gemini 金鑰', 'setupGeminiKey')
    .addItem('測試 Gemini 連線', 'menuTestGemini')
    .addItem('設定 Claude 金鑰（備援）', 'setupClaudeKey')
    .addItem('測試 Claude 連線', 'menuTestClaude')
    .addSeparator()
    .addItem('更新計畫內容', 'refreshContent')
    .addItem('檢查計畫內容', 'checkContent')
    .addItem('新增計畫', 'menuNewProject')
    .addToUi();
}

function setupGeminiKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('設定 Gemini API 金鑰', '請貼上金鑰：', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const key = r.getResponseText().trim();
  if (!key) { ui.alert('沒有輸入金鑰。'); return; }
  PropertiesService.getScriptProperties().setProperty('GEMINI_API_KEY', key);
  menuTestGemini();
}

function setupClaudeKey() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('設定 Claude API 金鑰', '請貼上金鑰（sk-ant- 開頭）：', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const key = r.getResponseText().trim();
  if (!key) { ui.alert('沒有輸入金鑰。'); return; }
  PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', key);
  menuTestClaude();
}

function menuTestClaude() {
  const ui = SpreadsheetApp.getUi();
  try {
    const out = claudeFetch_([{ type: 'text', text: '請只回覆「連線成功」四個字。' }], 20);
    ui.alert('✅ Claude 連線成功\n\n使用模型：' + out.model + '\n模型回應：' + out.text.trim() +
      '\n\nGemini 無法使用時，履歷辨識會自動改用 Claude。');
  } catch (e) {
    ui.alert('❌ Claude 連線失敗\n\n' + e.message);
  }
}

function testClaudeConnection() {
  const out = claudeFetch_([{ type: 'text', text: '請只回覆「連線成功」四個字。' }], 20);
  console.log('✅ Claude 模型 ' + out.model + ' 回應：' + out.text.trim());
}

function menuTestGemini() {
  const ui = SpreadsheetApp.getUi();
  try {
    const model = autoPickGeminiModel();
    if (!model) throw new Error('所有 Gemini 模型目前都無法使用（多半是免費額度用完）。詳細原因請看 Apps Script「執行作業」。');
    ui.alert('✅ 連線成功\n\n使用模型：' + model);
  } catch (e) {
    ui.alert('❌ 連線失敗\n\n' + e.message);
  }
}

// =====================================================================
// 編輯器工具
// =====================================================================
/** 逐一測試可用的 Gemini 模型，選第一個真的能回應的（額度用完的會跳過），並列出每個模型的結果 */
function autoPickGeminiModel() {
  const key = getGeminiKey_();
  const pool = geminiModelPool_(key);
  const body = { contents: [{ parts: [{ text: '請只回覆「連線成功」四個字。' }] }] };
  for (const m of pool) {
    const r = geminiFetch_(m, key, body);
    if (r.code === 200) {
      PropertiesService.getScriptProperties().setProperty('GEMINI_MODEL', m);
      console.log('✅ ' + m + '：可以使用，已設定為目前模型。回應：' + (replyText_(r.json).trim() || '（空白）'));
      return m;
    }
    console.log('❌ ' + m + '：' + r.code + ' ' + String(r.msg).slice(0, 200));
  }
  console.log('⚠️ 所有 Gemini 模型都無法使用。' +
    (txt_(PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY')) ? '已設定 Claude 金鑰，履歷辨識會自動改用 Claude。' : '可以設定 Claude 金鑰作為備援，或幫 Gemini 金鑰開通付費。'));
  return '';
}

function testGeminiConnection() {
  console.log('✅ 模型回應：' + testReply_());
  console.log('目前使用模型：' + PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL'));
}

function checkProps() {
  console.log(JSON.stringify(PropertiesService.getScriptProperties().getKeys()));
}

function testReply_() {
  const out = callGemini_({ contents: [{ parts: [{ text: '請只回覆「連線成功」四個字。' }] }] });
  return replyText_(out.json).trim() || '（空白）';
}
