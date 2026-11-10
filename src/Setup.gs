/**
 * 115 二所人力招募系統 — 第一步：建立資料庫骨架
 *
 * 使用方式：
 * 1. 新建一份 Google 試算表，命名為「115二所人力招募系統」
 * 2. 選單「擴充功能 → Apps Script」，把本檔內容整份貼上，存檔
 * 3. 上方函式選單選 setupDatabase，按「執行」，依畫面完成授權
 *
 * 重複執行是安全的：已經有資料的工作表不會被清空，只會更新「選項」表。
 */

// ===== 各工作表欄位定義 =====
const SHEET_DEF = {
  '應徵者': [
    '應徵者ID', '建檔時間', '建檔者',
    '姓名', '性別', '年齡', '手機', 'Email', '現居',
    '最高學歷', '最高學歷學校科系', '次高學歷學校科系',
    '工作經歷', '標案經驗', '報告經驗', '其他專長',
    '應徵職缺', '應徵管道', '履歷檔連結', '重複比對鍵',
    '進度', '面試日期', '面試時間', '面試地點',
    '結果', '錄取後進度', '預計到職日',
    'HR備註', '最後更新時間', '最後更新者'
  ],
  '面試評語': [
    '評語ID', '應徵者ID', '應徵者姓名', '面試官Email', '面試官',
    '現場表現', '建議結果', '建議團隊', '辦公地點', '備註', '填寫時間'
  ],
  '使用者': ['Email', '姓名', '角色', '啟用', '負責地點'],
  '異動紀錄': ['時間', '操作者', '應徵者ID', '欄位', '舊值', '新值']
};

// ===== 下拉選單選項（之後要增減，改這裡再重跑一次即可）=====
const OPTIONS = {
  '性別': ['男', '女', '其他'],
  '學歷': ['博畢', '博肄', '博ing', '碩畢', '碩肄', '碩ing', '學士', '其他'],
  '應徵管道': ['主動應徵', '海選通知', '專人推薦', '其他'],
  '進度': ['待初選', '約面試', '已面試'],
  '結果': ['錄取', '評估中', '感謝函', '不約面試', '應徵者婉拒'],   // 畫面上：錄取／待評估／不錄取／不約面試／應徵者婉拒
  '錄取後進度': ['確認意願中', '願意入職', '對方婉拒', '所內簽核', '院內簽核', '已到職'],
  '現場表現': ['優', '佳', '一般', '欠佳'],
  '建議結果': ['建議聘用', '評估中', '不建議'],
  '辦公地點': ['院本部', '台北辦公室', '台中辦公室', '待討論'],
  '建議團隊': ['不動產', '事業興革', '主計/人事系統', '微水力', '創新灌溉',
               '綠色照顧', '跨區外展', '清潔隊', '馬太鞍', '純行政', '待討論'],
  '角色': ['管理員', 'HR', '所長', '面試官', '行政']
};

// ===== 哪個欄位套用哪組下拉選單 =====
const VALIDATION_MAP = {
  '應徵者': {
    '性別': '性別', '最高學歷': '學歷', '應徵管道': '應徵管道',
    '進度': '進度', '面試地點': '辦公地點', '結果': '結果', '錄取後進度': '錄取後進度'
  },
  '面試評語': {
    '現場表現': '現場表現', '建議結果': '建議結果',
    '建議團隊': '建議團隊', '辦公地點': '辦公地點'
  },
  '使用者': { '角色': '角色' }
};

// ===== 特殊欄位格式 =====
const FORMAT_MAP = {
  '應徵者': {
    '建檔時間': 'yyyy/mm/dd hh:mm', '最後更新時間': 'yyyy/mm/dd hh:mm',
    '面試日期': 'yyyy/mm/dd', '面試時間': 'hh:mm', '預計到職日': 'yyyy/mm/dd',
    '手機': '@', '年齡': '0'
  },
  '面試評語': { '填寫時間': 'yyyy/mm/dd hh:mm' },
  '異動紀錄': { '時間': 'yyyy/mm/dd hh:mm:ss' }
};

const MAX_ROWS = 2000;

function setupDatabase() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. 選項表（每次重建，讓修改後的選項生效）
  const optSheet = getOrCreateSheet_(ss, '選項');
  optSheet.clear();
  const optKeys = Object.keys(OPTIONS);
  optKeys.forEach((key, i) => {
    optSheet.getRange(1, i + 1).setValue(key);
    const vals = OPTIONS[key].map(v => [v]);
    optSheet.getRange(2, i + 1, vals.length, 1).setValues(vals);
  });
  styleHeader_(optSheet, optKeys.length);

  // 2. 資料表
  Object.keys(SHEET_DEF).forEach(name => {
    const headers = SHEET_DEF[name];
    const sh = getOrCreateSheet_(ss, name);
    if (sh.getLastRow() <= 1) {
      sh.clear();
      sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    styleHeader_(sh, headers.length);
    applyValidation_(sh, name, optSheet, optKeys);
    applyFormats_(sh, name);
  });

  // 使用者表的「啟用」欄做成勾選框
  const userSheet = ss.getSheetByName('使用者');
  const enableCol = SHEET_DEF['使用者'].indexOf('啟用') + 1;
  userSheet.getRange(2, enableCol, MAX_ROWS, 1).insertCheckboxes();

  // 3. 把執行者登記為管理員（僅在使用者表還是空的時候）
  if (userSheet.getLastRow() <= 1) {
    const me = Session.getActiveUser().getEmail();
    userSheet.getRange(2, 1, 1, 4).setValues([[me, '（請填姓名）', '管理員', true]]);
  }

  // 4. 移除預設的空白工作表
  ['工作表1', 'Sheet1'].forEach(n => {
    const s = ss.getSheetByName(n);
    if (s && s.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(s);
  });

  // 5. 排列工作表順序
  ['應徵者', '面試評語', '使用者', '異動紀錄', '選項'].forEach((n, i) => {
    ss.setActiveSheet(ss.getSheetByName(n));
    ss.moveActiveSheet(i + 1);
  });
  ss.setActiveSheet(ss.getSheetByName('應徵者'));

  ss.toast('資料庫骨架建立完成，請到「使用者」表填入吳博、所長與面試官的 Email。', '完成', 10);
}

// ===== 工具函式 =====
function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function styleHeader_(sh, numCols) {
  sh.getRange(1, 1, 1, numCols)
    .setFontWeight('bold')
    .setBackground('#1f4e79')
    .setFontColor('#ffffff');
  sh.setFrozenRows(1);
}

function applyValidation_(sh, sheetName, optSheet, optKeys) {
  const map = VALIDATION_MAP[sheetName];
  if (!map) return;
  const headers = SHEET_DEF[sheetName];
  Object.keys(map).forEach(colName => {
    const colIdx = headers.indexOf(colName) + 1;
    const optKey = map[colName];
    const optCol = optKeys.indexOf(optKey) + 1;
    if (colIdx < 1 || optCol < 1) return;
    const src = optSheet.getRange(2, optCol, OPTIONS[optKey].length, 1);
    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(src, true)
      .setAllowInvalid(false)
      .build();
    sh.getRange(2, colIdx, MAX_ROWS, 1).setDataValidation(rule);
  });
}

function applyFormats_(sh, sheetName) {
  const map = FORMAT_MAP[sheetName];
  if (!map) return;
  const headers = SHEET_DEF[sheetName];
  Object.keys(map).forEach(colName => {
    const colIdx = headers.indexOf(colName) + 1;
    if (colIdx > 0) sh.getRange(2, colIdx, MAX_ROWS, 1).setNumberFormat(map[colName]);
  });
}
