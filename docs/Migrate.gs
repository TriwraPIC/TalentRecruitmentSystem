/**
 * 115 二所人力招募系統 — 第二步：把舊表轉進新資料庫
 *
 * 來源：一覽表、吳博1、吳博2（同一份試算表內）
 * 目的：應徵者、面試評語，另產生「轉移報告」列出待確認事項
 *
 * 執行前：
 *   Setup.gs 的 OPTIONS['結果'] 要先加上 '應徵者婉拒'，並重跑 setupDatabase()
 * 執行：
 *   函式選單選 migrateOldData → 執行
 * 想重來：
 *   執行 clearMigratedData()，只會刪除「資料轉移」建立的資料
 */

const MIG = {
  listSheet: '一覽表',
  hrSheets: ['吳博1', '吳博2'],
  year: 2026,                          // 一覽表中「9月10日」這類沒寫年份的日期
  aliases: { '林奕豪': '林弈豪' },       // 一覽表寫法 → 104 資料寫法（合併成同一人）
  creator: '資料轉移'
};

function migrateOldData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const target = ss.getSheetByName('應徵者');
  const reviewSheet = ss.getSheetByName('面試評語');

  if (target.getLastRow() > 1) {
    throw new Error('「應徵者」表已經有資料。若要重新轉移，請先執行 clearMigratedData()。');
  }
  if (OPTIONS['結果'].indexOf('應徵者婉拒') < 0) {
    throw new Error("請先在 Setup.gs 的 OPTIONS 結果 加上 '應徵者婉拒'，並重跑 setupDatabase()。");
  }

  const people = {};
  const order = [];
  const getPerson = name => {
    if (!people[name]) {
      people[name] = { name: name, W: null, L: null, notes: [], flags: [] };
      order.push(name);
    }
    return people[name];
  };

  // ---------- 1. 讀吳博1、吳博2（第 3 列起為資料）----------
  MIG.hrSheets.forEach(sn => {
    const sh = ss.getSheetByName(sn);
    if (!sh) return;
    const rows = sh.getDataRange().getValues();
    if (str_(rows[1][2]) !== '姓名') {
      throw new Error(sn + ' 的欄位位置和預期不同（第 2 列 C 欄應為「姓名」）');
    }
    rows.slice(2).forEach(r => {
      const name = str_(r[2]);
      if (!name) return;
      const p = getPerson(name);
      if (p.W) p.flags.push('在' + sn + '重複出現，只保留第一筆');
      else p.W = { sheet: sn, r: r };
    });
  });

  // ---------- 2. 讀一覽表（第 3 列起為資料）----------
  const ls = ss.getSheetByName(MIG.listSheet);
  const lrows = ls.getDataRange().getValues();
  if (str_(lrows[1][0]) !== '姓名') {
    throw new Error('一覽表的欄位位置和預期不同（第 2 列 A 欄應為「姓名」）');
  }
  lrows.slice(2).forEach(r => {
    let name = str_(r[0]);
    if (!name) return;
    let aliasFlag = '';
    if (MIG.aliases[name]) {
      aliasFlag = '一覽表寫作「' + name + '」，104 資料為「' + MIG.aliases[name] + '」，已合併，請確認正確寫法';
      name = MIG.aliases[name];
    }
    const p = getPerson(name);
    if (aliasFlag) p.flags.push(aliasFlag);
    p.L = r;
  });

  // ---------- 3. 組合成新格式 ----------
  const H = SHEET_DEF['應徵者'];
  const RH = SHEET_DEF['面試評語'];
  const now = new Date();
  const outRows = [], reviewRows = [], report = [], flaggedRowIdx = [];

  order.forEach((name, i) => {
    const p = people[name];
    const id = 'C' + ('000' + (i + 1)).slice(-4);
    const rec = {
      '應徵者ID': id, '建檔時間': now, '建檔者': MIG.creator, '姓名': name,
      '重複比對鍵': dupKey_(name, ''), '最後更新時間': now, '最後更新者': MIG.creator
    };

    // --- 吳博表 ---
    let wRes = null;
    if (p.W) {
      const r = p.W.r;
      p.notes.push('原編號 ' + str_(r[0]) + '（' + p.W.sheet + '）');
      setOpt_(rec, p, '性別', r[3], '性別');
      rec['年齡'] = num_(r[4]);
      rec['現居'] = str_(r[5]);
      setOpt_(rec, p, '最高學歷', r[6], '學歷');
      rec['最高學歷學校科系'] = str_(r[7]);
      rec['次高學歷學校科系'] = str_(r[8]);
      rec['標案經驗'] = vmark_(r[9]);
      rec['報告經驗'] = vmark_(r[10]);
      rec['工作經歷'] = str_(r[11]);
      rec['其他專長'] = str_(r[12]);
      rec['應徵職缺'] = str_(r[1]);
      setOpt_(rec, p, '應徵管道', r[13], '應徵管道');

      const screen = str_(r[14]);
      const status = str_(r[15]);
      if (status === '面試完成') rec['進度'] = '已面試';
      else if (status || screen === '可約面談') rec['進度'] = '約面試';
      else rec['進度'] = '待初選';

      const t = parseRocDateTime_(r[16]);
      if (t.date) rec['面試日期'] = t.date;
      if (t.time) rec['面試時間'] = t.time;
      if (t.rest) p.notes.push('面試時間原註記：' + t.rest);

      const memo = str_(r[20]);
      const loc = memo.match(/(院本部|台北辦公室|台中辦公室)面試/);
      if (loc) rec['面試地點'] = loc[1];
      const memoRest = memo.replace(/(院本部|台北辦公室|台中辦公室)面試/, '').trim();
      if (memoRest) p.notes.push(memoRest);
      if (str_(r[19])) p.notes.push('104備註：' + str_(r[19]));

      wRes = mapHrResult_(str_(r[17]), str_(r[18]), p);
      if (status === '面試前婉拒') wRes = { res: '應徵者婉拒', post: '' };
    }

    // --- 一覽表 ---
    let lRes = null;
    if (p.L) {
      const r = p.L; // 0姓名 1面試日期 2面試者 3面試結果 4現場表現 5辦公地點 6建議團隊 7辦理進度 8備註 9預計到職
      rec['進度'] = '已面試';

      const d = parseAnyDate_(r[1]);
      if (d) {
        if (!rec['面試日期']) rec['面試日期'] = d;
        else if (fmt_(rec['面試日期']) !== fmt_(d)) {
          p.flags.push('面試日期不一致：吳博表 ' + fmt_(rec['面試日期']) + '，一覽表 ' + fmt_(d));
        }
      }

      const resMap = { '建議聘用': '錄取', '不錄取': '感謝函', '評估中': '評估中', '待討論': '評估中' };
      const postMap = {
        '對方婉拒回報吳博': '對方婉拒', '已回復願意入職': '願意入職',
        '確認意願與到職日期': '確認意願中', '所內簽核': '所內簽核', '院內簽核': '院內簽核'
      };
      const resText = str_(r[3]);
      const progText = str_(r[7]);
      lRes = { res: resMap[resText] || '', post: postMap[progText] || '' };
      if (resText && !resMap[resText]) p.notes.push('一覽表面試結果：' + resText);
      if (progText && !postMap[progText]) p.notes.push('辦理進度：' + progText);
      if (lRes.post && lRes.res !== '錄取') {
        p.flags.push('一覽表面試結果為「' + resText + '」，但辦理進度寫「' + progText + '」');
        lRes.post = '';
      }

      const start = parseAnyDate_(r[9]);
      if (start) lRes.start = start;
      else if (str_(r[9])) p.notes.push('預計到職欄：' + str_(r[9]));
      if (lRes.post === '對方婉拒' && start) {
        p.flags.push('已標示對方婉拒，但仍填有預計到職日 ' + fmt_(start));
      }

      // 一覽表的面試者、表現、團隊、備註轉成一筆「舊表合併評語」
      const suggMap = { '建議聘用': '建議聘用', '不錄取': '不建議', '評估中': '評估中', '待討論': '評估中' };
      const rv = {
        '評語ID': 'R' + ('000' + (reviewRows.length + 1)).slice(-4),
        '應徵者ID': id, '應徵者姓名': name, '面試官Email': '', '面試官': str_(r[2]),
        '建議結果': suggMap[resText] || '', '填寫時間': now
      };
      const rvNotes = ['舊表合併評語'];
      setOptTo_(rv, rvNotes, '現場表現', r[4], '現場表現');
      setOptTo_(rv, rvNotes, '辦公地點', r[5], '辦公地點');
      setOptTo_(rv, rvNotes, '建議團隊', r[6], '建議團隊');
      if (str_(r[8])) rvNotes.push(str_(r[8]));
      rv['備註'] = rvNotes.join('；');
      reviewRows.push(RH.map(h => (rv[h] !== undefined ? rv[h] : '')));
    }

    // --- 合併結果（兩邊都有時以一覽表為準）---
    const fin = (lRes && lRes.res) ? lRes : (wRes || { res: '', post: '' });
    if (lRes && lRes.res && wRes && wRes.res) {
      const a = wRes.res + (wRes.post ? '／' + wRes.post : '');
      const b = lRes.res + (lRes.post ? '／' + lRes.post : '');
      if (a !== b) p.flags.push('一覽表為「' + b + '」，吳博表為「' + a + '」，暫以一覽表為準');
    }
    rec['結果'] = fin.res || '';
    rec['錄取後進度'] = fin.res === '錄取' ? (fin.post || '確認意願中') : '';
    const startDate = fin.start || (wRes && wRes.start);
    if (startDate) rec['預計到職日'] = startDate;

    const memoParts = p.flags.map(f => '⚠️待確認：' + f).concat(p.notes);
    rec['HR備註'] = memoParts.join('；');

    outRows.push(H.map(h => (rec[h] !== undefined ? rec[h] : '')));
    if (p.flags.length) flaggedRowIdx.push(outRows.length + 1);
    const src = [p.W ? p.W.sheet : '', p.L ? '一覽表' : ''].filter(String).join('+');
    report.push([id, name, src, p.flags.join('\n') || '—']);
  });

  // ---------- 4. 寫入 ----------
  target.getRange(2, 1, outRows.length, H.length).setValues(outRows);
  flaggedRowIdx.forEach(row => target.getRange(row, 1, 1, H.length).setBackground('#fff2cc'));
  if (reviewRows.length) {
    reviewSheet.getRange(reviewSheet.getLastRow() + 1, 1, reviewRows.length, RH.length).setValues(reviewRows);
  }

  let rs = ss.getSheetByName('轉移報告');
  if (rs) rs.clear(); else rs = ss.insertSheet('轉移報告');
  rs.getRange(1, 1, 1, 4).setValues([['應徵者ID', '姓名', '資料來源', '待確認事項']]);
  rs.getRange(2, 1, report.length, 4).setValues(report);
  styleHeader_(rs, 4);
  rs.setColumnWidth(4, 520);
  rs.getRange(2, 4, report.length, 1).setWrap(true);

  ss.toast('轉入 ' + outRows.length + ' 位應徵者、' + reviewRows.length + ' 筆評語，其中 '
    + flaggedRowIdx.length + ' 位需要確認（黃底標示，詳見「轉移報告」）。', '轉移完成', 15);
}

/** 只刪除「資料轉移」建立的資料，之後新增的資料不受影響 */
function clearMigratedData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('應徵者');
  const H = SHEET_DEF['應徵者'];
  const creatorCol = H.indexOf('建檔者');
  const ids = {};
  const data = sh.getDataRange().getValues();
  for (let i = data.length - 1; i >= 1; i--) {
    if (data[i][creatorCol] === MIG.creator) {
      ids[data[i][0]] = true;
      sh.deleteRow(i + 1);
    }
  }
  const rv = ss.getSheetByName('面試評語');
  const rdata = rv.getDataRange().getValues();
  for (let i = rdata.length - 1; i >= 1; i--) {
    if (ids[rdata[i][1]] && String(rdata[i][9]).indexOf('舊表合併評語') === 0) rv.deleteRow(i + 1);
  }
  const rs = ss.getSheetByName('轉移報告');
  if (rs) ss.deleteSheet(rs);
  ss.toast('已清除轉移資料。', '完成', 5);
}

// ===== 對應規則 =====
function mapHrResult_(res, expl, p) {
  switch (res) {
    case '無意願':
      if (expl) p.notes.push('說明：' + expl);
      return { res: '應徵者婉拒', post: '' };
    case '不錄取':
      if (expl) p.notes.push(expl === '已通知' ? '感謝函已通知' : '說明：' + expl);
      return { res: '感謝函', post: '' };
    case '提報進用': {
      const d = parseRocDate_(expl);
      const post = d && d < new Date() ? '已到職' : '院內簽核';
      p.flags.push('舊表為「提報進用」' + (d ? '（' + fmt_(d) + '）' : '') + '，系統推定為「' + post + '」');
      return { res: '錄取', post: post, start: d };
    }
    case '錄取待到職':
      if (expl) p.notes.push('預計到職：' + expl.replace(/[()（）]/g, ''));
      return { res: '錄取', post: '願意入職' };
    case '':
      if (expl) p.notes.push('說明：' + expl);
      return null;
    default:
      p.notes.push('舊表面試結果：' + res + (expl ? '（' + expl + '）' : ''));
      return null;
  }
}

// ===== 工具函式 =====
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }
function num_(v) { const n = parseInt(str_(v), 10); return isNaN(n) ? '' : n; }
function vmark_(v) { return /v/i.test(str_(v)) ? '有' : ''; }
function dupKey_(name, phone) {
  return str_(name).replace(/\s/g, '') + '|' + str_(phone).replace(/\D/g, '');
}
function fmt_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy/MM/dd'); }

/** 值在選項內才寫入，否則留空並記到備註（避免違反下拉選單規則） */
function setOpt_(rec, p, field, value, optKey) {
  const v = str_(value);
  if (!v) return;
  if (OPTIONS[optKey].indexOf(v) >= 0) rec[field] = v;
  else p.notes.push('原始' + field + '：' + v);
}
function setOptTo_(obj, notes, field, value, optKey) {
  const v = str_(value);
  if (!v || v === '空') return;
  if (OPTIONS[optKey].indexOf(v) >= 0) obj[field] = v;
  else notes.push('原始' + field + '：' + v);
}

/** 民國日期 115/9/1 */
function parseRocDate_(s) {
  const m = str_(s).match(/(\d{2,3})\/(\d{1,2})\/(\d{1,2})/);
  return m ? new Date(+m[1] + 1911, +m[2] - 1, +m[3]) : null;
}

/** 民國日期＋星期＋時間，例如 115/7/31五1400，32 */
function parseRocDateTime_(v) {
  const s = str_(v);
  const m = s.match(/^(\d{2,3})\/(\d{1,2})\/(\d{1,2})\s*[一二三四五六日]?\s*(\d{3,4})?\s*(.*)$/);
  if (!m) return { rest: s };
  const out = { date: new Date(+m[1] + 1911, +m[2] - 1, +m[3]) };
  if (m[4]) {
    const hm = m[4].padStart(4, '0');
    out.time = new Date(1899, 11, 30, +hm.slice(0, 2), +hm.slice(2));
  }
  out.rest = m[5].replace(/^[，,、\s]+/, '');
  return out;
}

/** 日期物件、Excel 序號、「9月10日」、民國日期都能解析 */
function parseAnyDate_(v) {
  if (v instanceof Date && !isNaN(v)) return v;
  if (typeof v === 'number' && v > 30000 && v < 80000) return new Date(1899, 11, 30 + v);
  const s = str_(v);
  const m = s.match(/(\d{1,2})月(\d{1,2})日/);
  if (m) return new Date(MIG.year, +m[1] - 1, +m[2]);
  return parseRocDate_(s);
}
