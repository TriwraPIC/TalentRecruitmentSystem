/**
 * 115 二所人力招募系統 — 面試官可面試時間
 *
 * 流程：面試官認領後（主面＋陪同），各自勾選方便的時段 →
 *       HR 看到大家都方便的「共同時段」→ 和應徵者約時間 → 排定面試
 *
 * 資料存在「面試時段」工作表（第一次使用時自動建立），一位面試官對一位應徵者一列。
 * 時段格式：'2026-10-12 14:00'
 */

const AVAIL = {
  SHEET: '面試時段',
  DAYS: 10,                                                  // 從明天起，往後列出幾個工作天
  // 每天可選的開始時間：09:00 到 17:00，每 30 分鐘一格（共 17 格）
  TIMES: ['09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00',
          '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00']
};

function availSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(AVAIL.SHEET);
  if (!sh) {
    sh = ss.insertSheet(AVAIL.SHEET);
    sh.getRange(1, 1, 1, 5).setValues([['應徵者ID', '面試官Email', '面試官', '可面試時段', '更新時間']]);
    styleHeader_(sh, 5);
  }
  return sh;
}

/** 可選的日期：從明天起的工作天（週一到週五） */
function availDays_() {
  const out = [], wk = ['日', '一', '二', '三', '四', '五', '六'];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  while (out.length < AVAIL.DAYS) {
    d.setDate(d.getDate() + 1);
    const w = d.getDay();
    if (w === 0 || w === 6) continue;
    out.push({ date: fmtD_(d, 'yyyy-MM-dd'), label: fmtD_(d, 'MM/dd') + '（' + wk[w] + '）' });
  }
  return out;
}

function readAvail_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(AVAIL.SHEET);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues().map((r, i) => ({
    row: i + 2, id: txt_(r[0]), key: normEmail_(r[1]), name: txt_(r[2]),
    slots: txt_(r[3]).split(',').map(x => x.trim()).filter(Boolean), updated: r[4]
  })).filter(x => x.id);
}

/** 某位應徵者的面試官時段：面試官名單上的每個人（主面在前），含還沒填的人 */
function getAvailability(id) {
  requireRole_('view');
  const c = getCandidateObj_(id);
  const staff = staffByEmail_();
  const rows = readAvail_().filter(x => x.id === id);
  const members = panelOf_(c).map((key, i) => {
    const r = rows.find(x => x.key === key);
    return { key: key, name: (staff[key] && staff[key].name) || key, lead: i === 0,
      filled: !!r, slots: r ? r.slots : [],
      updated: r && r.updated instanceof Date ? fmtD_(r.updated, 'MM/dd HH:mm') : '' };
  });
  return { days: availDays_(), times: AVAIL.TIMES, members: members, others: txt_(c['其他陪同']) };
}

/** 面試官（主面或陪同）儲存自己方便的時段 */
function setAvailability(id, slots) {
  const me = requireRole_('claim');
  return withLock_(() => {
    const c = getCandidateObj_(id);
    assertClaimable_(c);
    const key = normEmail_(me.email);
    if (panelOf_(c).indexOf(key) < 0) throw new Error('你不在這場面試的面試官名單裡，請先認領。');
    const okDays = availDays_().map(d => d.date);
    const clean = [];
    (slots || []).map(txt_).forEach(s => {
      const m = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$/);
      if (!m || AVAIL.TIMES.indexOf(m[2]) < 0) throw new Error('時段格式錯誤：' + s);
      if (okDays.indexOf(m[1]) >= 0 && clean.indexOf(s) < 0) clean.push(s);
    });
    clean.sort();
    const sh = availSheet_();
    const row = readAvail_().find(x => x.id === id && x.key === key);
    const rec = [id, key, me.name, clean.join(','), new Date()];
    if (row) sh.getRange(row.row, 1, 1, 5).setValues([rec]);
    else sh.appendRow(rec);
    appendLogs_([[new Date(), me.name, id, '可面試時段', '', clean.length ? clean.length + ' 個時段' : '都不方便']]);
    bumpVersion_();
    return getAvailability(id);
  });
}

/** 每位應徵者：面試官名單中已填時段的人數（給列表與看板顯示） */
function availFilledMap_() {
  const m = {};
  readAvail_().forEach(x => { (m[x.id] = m[x.id] || []).push(x.key); });
  return m;
}
