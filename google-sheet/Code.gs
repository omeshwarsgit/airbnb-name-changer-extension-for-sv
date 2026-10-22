/**
 * StayVista Airbnb Renamer — Google Sheet tracker backend
 * ------------------------------------------------------
 * Paste this whole file into Extensions > Apps Script of the tracker Google Sheet,
 * run `setup` once, then Deploy > New deployment > Web app
 *   (Execute as: Me, Who has access: Anyone).
 * Copy the Web app URL + the token shown by setup into the Chrome extension settings.
 *
 * The "Queue" tab is both the to-do list and the tracker:
 *   the extension claims Pending rows, changes the name on Airbnb,
 *   and writes back the status, the old name, the verified name, who did it and when.
 */

var QUEUE = 'Queue';
var SUMMARY = 'Summary';
var SETTINGS = 'Settings';
var CLAIM_MINUTES = 30;     // an "In Progress" row older than this is treated as abandoned
var MAX_ATTEMPTS = 3;       // a Failed row is retried until it has this many attempts

var HEADERS = [
  'Listing Link',          // 1  A  (paste the Airbnb link or listing ID)
  'Listing ID',            // 2  B  (filled automatically)
  'Property Name',         // 3  C
  'New Name',              // 4  D  (the approved title, max 50 chars)
  'Chars',                 // 5  E  (formula)
  'Status',                // 6  F
  'Old Name (on Airbnb)',  // 7  G
  'Name After Save',       // 8  H  (read back from Airbnb after saving)
  'Mode',                  // 9  I  Assisted / Auto
  'Done By',               // 10 J
  'Claimed At',            // 11 K
  'Updated At',            // 12 L
  'Attempts',              // 13 M
  'Notes / Error'          // 14 N
];
var C = { LINK: 1, ID: 2, PROP: 3, NEW: 4, CHARS: 5, STATUS: 6, OLD: 7, AFTER: 8, MODE: 9,
          BY: 10, CLAIMED: 11, UPDATED: 12, ATTEMPTS: 13, NOTE: 14 };
var STATUSES = ['Pending', 'In Progress', 'Done', 'Already Correct', 'Skipped', 'Failed', 'Needs Check'];

/* ------------------------------------------------------------------ menu + setup */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Airbnb Renamer')
    .addItem('1. Set up sheet (run once)', 'setup')
    .addItem('Show extension token', 'showToken')
    .addSeparator()
    .addItem('Release stuck "In Progress" rows', 'menuReleaseStuck')
    .addItem('Send all Failed rows back to Pending', 'menuRetryFailed')
    .addToUi();
}

function setup() {
  var ss = SpreadsheetApp.getActive();
  var q = ss.getSheetByName(QUEUE) || ss.insertSheet(QUEUE, 0);
  q.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS])
    .setFontWeight('bold').setBackground('#1f3b2d').setFontColor('#ffffff').setWrap(true);
  q.setFrozenRows(1);
  // Links and IDs as plain text, otherwise long Airbnb IDs lose digits.
  q.getRange('A:B').setNumberFormat('@');
  q.getRange('E1').setFormula('={"Chars";ARRAYFORMULA(IF(D2:D="",,LEN(D2:D)))}');
  q.getRange('K:L').setNumberFormat('dd-mmm-yyyy hh:mm');
  var widths = [300, 170, 200, 330, 60, 120, 300, 300, 80, 110, 130, 130, 75, 300];
  widths.forEach(function (w, i) { q.setColumnWidth(i + 1, w); });

  var rule = SpreadsheetApp.newDataValidation().requireValueInList(STATUSES, true).setAllowInvalid(true).build();
  q.getRange(2, C.STATUS, q.getMaxRows() - 1, 1).setDataValidation(rule);

  var colours = { 'Done': '#d9ead3', 'Already Correct': '#d0e0e3', 'Failed': '#f4cccc',
                  'Needs Check': '#fce5cd', 'In Progress': '#fff2cc', 'Skipped': '#eeeeee' };
  var rules = [];
  var rng = q.getRange(2, 1, q.getMaxRows() - 1, HEADERS.length);
  Object.keys(colours).forEach(function (s) {
    rules.push(SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$F2="' + s + '"').setBackground(colours[s]).setRanges([rng]).build());
  });
  rules.push(SpreadsheetApp.newConditionalFormatRule()
    .whenFormulaSatisfied('=$E2>50').setFontColor('#cc0000').setBold(true)
    .setRanges([q.getRange('E2:E')]).build());
  q.setConditionalFormatRules(rules);

  buildSummary_(ss);

  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('TOKEN')) {
    props.setProperty('TOKEN', Utilities.getUuid().replace(/-/g, '').slice(0, 20));
  }
  var st = ss.getSheetByName(SETTINGS) || ss.insertSheet(SETTINGS);
  st.getRange('A1:B3').setValues([
    ['Extension token', props.getProperty('TOKEN')],
    ['Web app URL', 'Deploy > New deployment > Web app, then paste the URL here for reference'],
    ['Note', 'Anyone with the token + URL can update this sheet. Share them only with the team running the extension.']
  ]);
  st.setColumnWidth(1, 160); st.setColumnWidth(2, 520);
  showToken();
}

function buildSummary_(ss) {
  var s = ss.getSheetByName(SUMMARY) || ss.insertSheet(SUMMARY, 1);
  s.clear();
  var rows = [['Status', 'Count']];
  ['Pending', 'In Progress', 'Done', 'Already Correct', 'Skipped', 'Failed', 'Needs Check'].forEach(function (st, i) {
    rows.push([st, st === 'Pending'
      ? '=COUNTIFS(Queue!D2:D,"<>",Queue!F2:F,"")+COUNTIF(Queue!F2:F,"Pending")'
      : '=COUNTIF(Queue!F2:F,"' + st + '")']);
  });
  rows.push(['Total listings', '=COUNTA(Queue!D2:D)']);
  rows.push(['% complete', '=IFERROR((B4+B5)/B9,0)']);
  rows.push(['Done today', '=COUNTIFS(Queue!F2:F,"Done",Queue!L2:L,">="&TODAY())']);
  s.getRange(1, 1, rows.length, 2).setValues(rows);
  s.getRange('B10').setNumberFormat('0.0%');
  s.getRange('A1:B1').setFontWeight('bold').setBackground('#1f3b2d').setFontColor('#ffffff');
  s.getRange('D1').setValue('Done per person per day').setFontWeight('bold');
  s.getRange('D2').setFormula(
    '=IFERROR(QUERY({Queue!J2:J,ARRAYFORMULA(IF(Queue!L2:L="",,INT(Queue!L2:L))),Queue!F2:F},' +
    '"select Col2, Col1, count(Col3) where Col3=\'Done\' group by Col2, Col1 order by Col2 desc ' +
    'label Col2 \'Date\', Col1 \'Person\', count(Col3) \'Done\' format Col2 \'dd-mmm-yyyy\'",0),"No completed rows yet")');
  s.setColumnWidth(1, 160); s.setColumnWidth(4, 120); s.setColumnWidth(5, 140);
}

function showToken() {
  var t = PropertiesService.getScriptProperties().getProperty('TOKEN');
  try {
    SpreadsheetApp.getUi().alert('Extension token',
      'Token: ' + t + '\n\nNext: Deploy > New deployment > Web app (Execute as: Me, Access: Anyone). ' +
      'Paste the Web app URL and this token into the extension settings.', SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { Logger.log('Token: ' + t); }
}

function menuReleaseStuck() { var n = releaseStuck_(0); SpreadsheetApp.getActive().toast(n + ' rows released'); }
function menuRetryFailed() {
  var q = sheet_(), data = values_(q), n = 0;
  data.forEach(function (r, i) {
    if (r[C.STATUS - 1] === 'Failed') {
      q.getRange(i + 2, C.STATUS).setValue('Pending');
      q.getRange(i + 2, C.ATTEMPTS).setValue(0);
      n++;
    }
  });
  SpreadsheetApp.getActive().toast(n + ' failed rows sent back to Pending');
}

/* ------------------------------------------------------------------ web app */

function doGet(e) {
  return json_({ ok: true, app: 'stayvista-airbnb-renamer', hint: 'POST JSON with a token' });
}

function doPost(e) {
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Bad JSON' }); }
  var token = PropertiesService.getScriptProperties().getProperty('TOKEN');
  if (!token || body.token !== token) return json_({ ok: false, error: 'Wrong token' });

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return json_({ ok: false, error: 'Sheet busy, try again' });
  try {
    switch (body.action) {
      case 'ping':    return json_({ ok: true, sheet: SpreadsheetApp.getActive().getName(), stats: stats_() });
      case 'stats':   return json_({ ok: true, stats: stats_() });
      case 'claim':   return json_({ ok: true, rows: claim_(body.limit || 20, body.operator || '', !!body.retryFailed) });
      case 'update':  return json_(update_(body));
      case 'release': return json_({ ok: true, released: release_(body.ids || []) });
      case 'import':  return json_(import_(body.rows || []));
      default:        return json_({ ok: false, error: 'Unknown action ' + body.action });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}

/* ------------------------------------------------------------------ actions */

function claim_(limit, operator, retryFailed) {
  var q = sheet_(), data = values_(q), now = new Date(), out = [];
  var stale = new Date(now.getTime() - CLAIM_MINUTES * 60000);
  for (var i = 0; i < data.length && out.length < limit; i++) {
    var r = data[i], status = String(r[C.STATUS - 1] || '').trim();
    var newName = String(r[C.NEW - 1] || '').trim();
    var link = String(r[C.LINK - 1] || '').trim();
    var id = String(r[C.ID - 1] || '').trim() || extractId_(link);
    if (!newName || !id) continue;
    var claimedAt = r[C.CLAIMED - 1];
    var attempts = Number(r[C.ATTEMPTS - 1] || 0);
    var ok = status === '' || status === 'Pending' ||
             (status === 'In Progress' && claimedAt instanceof Date && claimedAt < stale) ||
             (retryFailed && status === 'Failed' && attempts < MAX_ATTEMPTS);
    if (!ok) continue;
    var row = i + 2;
    q.getRange(row, C.ID).setValue(id);
    q.getRange(row, C.STATUS).setValue('In Progress');
    q.getRange(row, C.BY).setValue(operator);
    q.getRange(row, C.CLAIMED).setValue(now);
    out.push({ row: row, id: id, link: link, propertyName: String(r[C.PROP - 1] || ''), newName: newName });
  }
  return out;
}

function update_(b) {
  var q = sheet_();
  var row = findRow_(q, b.row, String(b.id || ''));
  if (!row) return { ok: false, error: 'Listing ' + b.id + ' not found in sheet' };
  var attempts = Number(q.getRange(row, C.ATTEMPTS).getValue() || 0) + 1;
  var set = {};
  set[C.STATUS] = b.status || 'Needs Check';
  if (b.oldName !== undefined && b.oldName !== null && !q.getRange(row, C.OLD).getValue()) set[C.OLD] = b.oldName;
  if (b.verifiedName !== undefined && b.verifiedName !== null) set[C.AFTER] = b.verifiedName;
  set[C.MODE] = b.mode || '';
  if (b.operator) set[C.BY] = b.operator;
  set[C.UPDATED] = new Date();
  set[C.ATTEMPTS] = attempts;
  set[C.NOTE] = b.note || '';
  Object.keys(set).forEach(function (col) { q.getRange(row, Number(col)).setValue(set[col]); });
  return { ok: true, row: row };
}

function release_(ids) {
  var q = sheet_(), data = values_(q), n = 0, want = {};
  ids.forEach(function (x) { want[String(x)] = true; });
  data.forEach(function (r, i) {
    if (want[String(r[C.ID - 1])] && r[C.STATUS - 1] === 'In Progress') {
      q.getRange(i + 2, C.STATUS).setValue('Pending');
      q.getRange(i + 2, C.CLAIMED).setValue('');
      n++;
    }
  });
  return n;
}

function releaseStuck_(minutes) {
  var q = sheet_(), data = values_(q), n = 0;
  var cutoff = new Date(Date.now() - minutes * 60000);
  data.forEach(function (r, i) {
    var c = r[C.CLAIMED - 1];
    if (r[C.STATUS - 1] === 'In Progress' && (!(c instanceof Date) || c <= cutoff)) {
      q.getRange(i + 2, C.STATUS).setValue('Pending');
      n++;
    }
  });
  return n;
}

function import_(rows) {
  var q = sheet_(), data = values_(q), index = {}, added = 0, updated = 0, skipped = 0;
  data.forEach(function (r, i) {
    var id = String(r[C.ID - 1] || '').trim() || extractId_(String(r[C.LINK - 1] || ''));
    if (id) index[id] = { row: i + 2, status: String(r[C.STATUS - 1] || '') };
  });
  var append = [];
  rows.forEach(function (x) {
    var id = String(x.id || '').trim() || extractId_(String(x.link || ''));
    var name = String(x.newName || '').trim();
    if (!id || !name) { skipped++; return; }
    var hit = index[id];
    if (hit) {
      // Only refresh the name of rows that haven't been processed yet.
      if (hit.status === '' || hit.status === 'Pending') {
        q.getRange(hit.row, C.NEW).setValue(name);
        if (x.propertyName) q.getRange(hit.row, C.PROP).setValue(x.propertyName);
        updated++;
      } else skipped++;
      return;
    }
    var line = new Array(HEADERS.length).fill('');
    line[C.LINK - 1] = String(x.link || id);
    line[C.ID - 1] = id;
    line[C.PROP - 1] = String(x.propertyName || '');
    line[C.NEW - 1] = name;
    line[C.CHARS - 1] = null;            // left to the ARRAYFORMULA
    line[C.STATUS - 1] = 'Pending';
    line[C.ATTEMPTS - 1] = 0;
    index[id] = { row: -1, status: 'Pending' };
    append.push(line);
  });
  if (append.length) {
    var start = lastDataRow_(q) + 1;
    // write A:D and F:N separately so the Chars ARRAYFORMULA in column E stays intact
    q.getRange(start, 1, append.length, 4).setValues(append.map(function (l) { return l.slice(0, 4); }));
    q.getRange(start, 6, append.length, HEADERS.length - 5).setValues(append.map(function (l) { return l.slice(5); }));
    added = append.length;
  }
  return { ok: true, added: added, updated: updated, skipped: skipped };
}

function stats_() {
  var data = values_(sheet_()), s = { total: 0 };
  STATUSES.forEach(function (x) { s[x] = 0; });
  var today = new Date(); today.setHours(0, 0, 0, 0);
  s.doneToday = 0;
  data.forEach(function (r) {
    if (!String(r[C.NEW - 1] || '').trim()) return;
    s.total++;
    var st = String(r[C.STATUS - 1] || '') || 'Pending';
    s[st] = (s[st] || 0) + 1;
    var u = r[C.UPDATED - 1];
    if (st === 'Done' && u instanceof Date && u >= today) s.doneToday++;
  });
  return s;
}

/* ------------------------------------------------------------------ helpers */

function sheet_() {
  var q = SpreadsheetApp.getActive().getSheetByName(QUEUE);
  if (!q) throw new Error('Run setup first: there is no "Queue" tab');
  return q;
}

function values_(q) {
  var last = lastDataRow_(q);
  if (last < 2) return [];
  return q.getRange(2, 1, last - 1, HEADERS.length).getValues();
}

// Last row that has a link or a new name (column E is a full-height ARRAYFORMULA, so getLastRow is unreliable).
function lastDataRow_(q) {
  var n = q.getLastRow();
  if (n < 2) return 1;
  var v = q.getRange(2, 1, n - 1, 4).getValues();
  for (var i = v.length - 1; i >= 0; i--) {
    if (String(v[i][0]).trim() || String(v[i][3]).trim()) return i + 2;
  }
  return 1;
}

function findRow_(q, hintRow, id) {
  if (hintRow && hintRow >= 2 && hintRow <= q.getLastRow()) {
    var at = String(q.getRange(hintRow, C.ID).getValue()).trim();
    if (at === id) return hintRow;
  }
  var data = values_(q);
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][C.ID - 1]).trim() === id) return i + 2;
  }
  return 0;
}

function extractId_(link) {
  link = String(link || '').trim();
  if (/^\d{5,}$/.test(link)) return link;
  var m = link.match(/\/(?:rooms|editor|listings|manage-your-space)\/(?:plus\/)?(\d{5,})/) || link.match(/(\d{6,})/);
  return m ? m[1] : '';
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
