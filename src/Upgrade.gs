/**
 * 115 二所人力招募系統 — 第六版升級（只需執行一次，重複執行也不會出錯）
 *
 * 在 Apps Script 編輯器選 upgradeV6 → 執行，會：
 *   1. 新增使用者：莊育寧（面試官）、楊宗政（面試官）、謝青宏（HR）
 *   2. 「結果」下拉選單加入「不約面試」
 *   3. 應徵者表新增欄位：初選者、主面試官、陪同面試官、其他陪同、面試官名單、面試計畫
 *   4. 計畫清單改成五個組別、設定顯示名稱，停用 3 個計畫
 *   5. 新增 5 個空白計畫：馬太鞍、小水力、擴大灌溉、綠色照顧、跨區外展
 */

const V6_USERS = [
  ['NockC@triwra.org.tw', '莊育寧', '面試官'],
  ['Jerryyang@triwra.org.tw', '楊宗政', '面試官'],
  ['edward@triwra.org.tw', '謝青宏', 'HR']
];

const V6_GROUPS = [
  ['綜合業務組', [['07_事業興革', '事業興革'], ['03_主計', '主計發展'], ['04_人事系統', '人事系統']]],
  ['土地利用組', [['06_非事業用不動產', '非事業'], ['N1_馬太鞍', '馬太鞍']]],
  ['綠能發展組', [['15_農業綠能', '農綠加值'], ['N2_小水力', '小水力'], ['24_微水力', '微水力']]],
  ['人事政策組', [['12_人事政策', '人事躍升'], ['13_健康輔導', '健康輔導'], ['08_清潔隊人事', '清潔隊']]],
  ['公私協力組', [['N3_擴大灌溉', '擴大灌溉'], ['N4_綠色照顧', '綠色照顧'], ['N5_跨區外展', '跨區外展'], ['26_外展輔導', '外展輔導']]]
];
const V6_DISABLE = ['13_蛋雞友善飼養', '14_農業人力資源', '31_社會溝通'];
const V6_TEMPLATE = '03_主計';   // 新計畫照這個計畫的欄位結構建立空白列

function upgradeV6() {
  const log = [];
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. 使用者
  const us = sheet_('使用者');
  const have = readSheet_('使用者').map(u => normEmail_(u['Email']));
  V6_USERS.forEach(u => {
    if (have.indexOf(normEmail_(u[0])) >= 0) { log.push('使用者已存在：' + u[1]); return; }
    const row = us.getLastRow() + 1;
    us.getRange(row, 1, 1, 4).setValues([[u[0], u[1], u[2], true]]);
    us.getRange(row, 4).insertCheckboxes().setValue(true);
    log.push('新增使用者：' + u[1] + '（' + u[2] + '）');
  });

  // 2. 下拉選單
  const opt = ss.getSheetByName('選項');
  if (opt) {
    const keys = Object.keys(OPTIONS);
    keys.forEach((k, i) => {
      opt.getRange(2, i + 1, Math.max(opt.getMaxRows() - 1, 1), 1).clearContent();
      opt.getRange(1, i + 1).setValue(k);
      opt.getRange(2, i + 1, OPTIONS[k].length, 1).setValues(OPTIONS[k].map(v => [v]));
    });
    applyValidation_(sheet_('應徵者'), '應徵者', opt, keys);
    log.push('下拉選單已更新（結果加入「不約面試」）');
  }

  // 3. 欄位
  ensurePanelColumns_();
  log.push('應徵者表欄位已確認：' + PANEL_COLS.join('、'));

  // 4. 計畫清單
  const ls = sheet_(CONTENT.LIST);
  const old = readProjectList_();
  const byId = {}; old.forEach(x => { byId[x.id] = x; });
  const HEAD = ['計畫ID', '組別', '顯示名稱', '啟用', '分類標籤', '計畫名稱（自動）', '應徵者說明頁（自動）'];
  const rows = [], used = {};
  V6_GROUPS.forEach(g => g[1].forEach(([id, name]) => {
    rows.push([id, g[0], name, true, (byId[id] || {}).tag || '', '', '']); used[id] = true;
  }));
  V6_DISABLE.forEach(id => {
    if (!byId[id]) return;
    rows.push([id, '（停用）', byId[id].name || id.slice(id.indexOf('_') + 1), false, byId[id].tag || '', '', '']); used[id] = true;
  });
  old.filter(x => !used[x.id]).forEach(x => rows.push([x.id, x.group || '其他', x.name || x.id.slice(x.id.indexOf('_') + 1), x.enabled, x.tag, '', '']));
  ls.clear();
  ls.getRange(1, 1, 1, HEAD.length).setValues([HEAD]);
  styleHeader_(ls, HEAD.length);
  ls.getRange(2, 1, rows.length, HEAD.length).setValues(rows);
  ls.getRange(2, 4, rows.length, 1).insertCheckboxes();
  rows.forEach((r, i) => ls.getRange(i + 2, 4).setValue(r[3] === true));
  ls.setColumnWidth(1, 150); ls.setColumnWidth(2, 110); ls.setColumnWidth(3, 110);
  log.push('計畫清單已重排：5 個組別、' + rows.filter(r => r[3] === true).length + ' 個啟用計畫，停用 ' + V6_DISABLE.join('、'));

  // 5. 新計畫的空白內容
  const cs = sheet_(CONTENT.SHEET);
  const data = cs.getDataRange().getValues();
  const h = data[0].map(txt_);
  const ci = h.indexOf('計畫ID'), cv = h.indexOf('內容'), cg = h.indexOf('建議');
  const tpl = data.filter((r, i) => i > 0 && txt_(r[ci]) === V6_TEMPLATE);
  const exists = {}; data.forEach((r, i) => { if (i > 0) exists[txt_(r[ci])] = true; });
  V6_GROUPS.forEach(g => g[1].forEach(([id, name]) => {
    if (exists[id]) return;
    if (!tpl.length) { log.push('⚠️ 找不到範本 ' + V6_TEMPLATE + '，無法建立 ' + id); return; }
    const add = tpl.map(r => { const x = r.slice(); x[ci] = id; x[cv] = ''; if (cg >= 0) x[cg] = ''; return x; });
    cs.getRange(cs.getLastRow() + 1, 1, add.length, add[0].length).setNumberFormat('@').setValues(add);
    log.push('新增空白計畫：' + id + '（' + name + '，' + add.length + ' 列）');
  }));

  bumpContentVersion_();
  bumpVersion_();
  try { refreshContent(); } catch (e) { log.push('⚠️ 更新計畫清單連結失敗：' + e.message); }
  console.log('第六版升級完成\n' + log.join('\n'));
  return log;
}


/**
 * 第七版升級（只需執行一次，重複執行也不會出錯）：
 *   1. 角色下拉選單加入「行政」，使用者表新增「負責地點」欄
 *   2. 新增行政助理：趙苙棻（台北辦公室）、楊琇羽（台中辦公室）
 *   3. 應徵者表新增「推薦計畫」欄
 */
const V7_ADMINS = [
  ['LiFen0404@triwra.org.tw', '趙苙棻', '行政', '台北辦公室'],
  ['kaia@triwra.org.tw', '楊琇羽', '行政', '台中辦公室']
];

function upgradeV7() {
  const log = [];
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const opt = ss.getSheetByName('選項');
  if (opt) {
    const keys = Object.keys(OPTIONS);
    keys.forEach((k, i) => {
      opt.getRange(2, i + 1, Math.max(opt.getMaxRows() - 1, 1), 1).clearContent();
      opt.getRange(1, i + 1).setValue(k);
      opt.getRange(2, i + 1, OPTIONS[k].length, 1).setValues(OPTIONS[k].map(v => [v]));
    });
    ['應徵者', '面試評語', '使用者'].forEach(n => applyValidation_(sheet_(n), n, opt, keys));
    log.push('下拉選單已更新（角色加入「行政」）');
  }
  ensureColumn_('使用者', '負責地點');
  ensureColumn_('應徵者', '推薦計畫');
  log.push('欄位已確認：使用者「負責地點」、應徵者「推薦計畫」');

  const us = sheet_('使用者');
  const h = headers_('使用者');
  const have = readSheet_('使用者').map(u => normEmail_(u['Email']));
  V7_ADMINS.forEach(([email, name, role, loc]) => {
    if (have.indexOf(normEmail_(email)) >= 0) { log.push('使用者已存在：' + name); return; }
    const rec = { 'Email': email, '姓名': name, '角色': role, '啟用': true, '負責地點': loc };
    const row = us.getLastRow() + 1;
    us.getRange(row, 1, 1, h.length).setValues([h.map(k => rec[k] !== undefined ? rec[k] : '')]);
    us.getRange(row, h.indexOf('啟用') + 1).insertCheckboxes().setValue(true);
    log.push('新增行政：' + name + '（' + loc + '）');
  });
  bumpVersion_();
  console.log('第七版升級完成\n' + log.join('\n'));
  return log;
}
