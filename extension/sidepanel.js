/* StayVista Airbnb Renamer — side panel: settings, import, and the run loop. */

const DEFAULTS = {
  operator: '',
  scriptUrl: '',
  token: '',
  editUrlTemplate: 'https://www.airbnb.co.in/hosting/listings/editor/{id}/details/title',
  mode: 'assisted',
  runTarget: 50,
  dailyCap: 300,
  batchSize: 10,
  minDelay: 25,
  maxDelay: 60,
  retryFailed: false,
  fieldSelector: '',
  saveText: ''
};
const MAX_LEN = 50;
const MAX_CONSECUTIVE_FAILS = 3;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
const today = () => new Date().toISOString().slice(0, 10);

let S = { ...DEFAULTS };
let running = false;
let stopRequested = false;
let workTabId = null;
let claimed = [];            // rows claimed from the sheet and not yet reported
let sessionLog = [];
let counts = { Done: 0, 'Already Correct': 0, Skipped: 0, Failed: 0, 'Needs Check': 0 };
let runTotal = 0, runProcessed = 0;

/* ================================================================= settings */

const FIELDS = ['operator', 'scriptUrl', 'token', 'editUrlTemplate', 'dailyCap', 'batchSize',
                'minDelay', 'maxDelay', 'retryFailed', 'fieldSelector', 'saveText', 'runTarget'];

async function loadSettings() {
  const got = await chrome.storage.sync.get(DEFAULTS);
  S = { ...DEFAULTS, ...got };
  FIELDS.forEach((k) => {
    const el = $(k);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!S[k]; else el.value = S[k];
  });
  setMode(S.mode, true);
  $('who').textContent = S.operator ? `Signed in as ${S.operator}` : 'Add your name in Settings';
  await refreshDaily();
}

async function saveSettings() {
  FIELDS.forEach((k) => {
    const el = $(k);
    if (!el) return;
    if (el.type === 'checkbox') S[k] = el.checked;
    else if (el.type === 'number') S[k] = Number(el.value) || DEFAULTS[k];
    else S[k] = el.value.trim();
  });
  if (S.maxDelay < S.minDelay) S.maxDelay = S.minDelay;
  if (!S.editUrlTemplate.includes('{id}')) S.editUrlTemplate = DEFAULTS.editUrlTemplate;
  await chrome.storage.sync.set(S);
  $('who').textContent = S.operator ? `Signed in as ${S.operator}` : 'Add your name in Settings';
  await refreshDaily();
}

function setMode(mode, silent) {
  S.mode = mode;
  $('modeAssisted').classList.toggle('active', mode === 'assisted');
  $('modeAuto').classList.toggle('active', mode === 'auto');
  $('autoWarn').classList.toggle('hidden', mode !== 'auto');
  $('modeHint').innerHTML = mode === 'auto'
    ? 'The tool fills the name, clicks Save, re-checks the page, then waits a random gap before the next listing.'
    : 'The tool opens each listing and fills the new name. You press <b>Save &amp; next</b> (or Ctrl+Enter) on the Airbnb page.';
  if (!silent) chrome.storage.sync.set({ mode });
}

/* ================================================================= daily counter */

async function getDaily() {
  const { daily } = await chrome.storage.local.get('daily');
  return daily && daily.date === today() ? daily : { date: today(), count: 0 };
}
async function bumpDaily() {
  const d = await getDaily(); d.count++;
  await chrome.storage.local.set({ daily: d });
  await refreshDaily();
  return d.count;
}
async function refreshDaily() {
  const d = await getDaily();
  $('dailyUsed').textContent = `${d.count} / ${S.dailyCap}`;
  return d.count;
}

/* ================================================================= sheet API */

async function api(action, payload = {}, tries = 3) {
  if (!S.scriptUrl || !S.token) throw new Error('Add the Apps Script URL and token in Settings');
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(S.scriptUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ token: S.token, action, ...payload })
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch (e) {
        throw new Error('The sheet did not answer with data. Check the web app is deployed with access "Anyone".');
      }
      if (!data.ok) {
        if (/busy/i.test(data.error || '') && i < tries - 1) { await sleep(2000 * (i + 1)); continue; }
        throw new Error(data.error || 'Sheet error');
      }
      setConn('on', 'Sheet connected');
      return data;
    } catch (e) {
      lastErr = e;
      if (/token|setup|Unknown action|did not answer/i.test(e.message)) break;
      await sleep(1500 * (i + 1));
    }
  }
  setConn('err', 'Sheet error');
  throw lastErr;
}

// Status updates must never be lost: failed ones wait in an outbox and are re-sent later.
async function report(update) {
  try {
    await api('update', update);
  } catch (e) {
    const { outbox = [] } = await chrome.storage.local.get('outbox');
    outbox.push(update);
    await chrome.storage.local.set({ outbox });
    log('Info', `Couldn't write row for ${update.id} to the sheet yet — will retry`);
  }
}
async function flushOutbox() {
  const { outbox = [] } = await chrome.storage.local.get('outbox');
  if (!outbox.length) return;
  const left = [];
  for (const u of outbox) { try { await api('update', u, 1); } catch (e) { left.push(u); } }
  await chrome.storage.local.set({ outbox: left });
  if (outbox.length !== left.length) log('Info', `Sent ${outbox.length - left.length} delayed updates to the sheet`);
}

function setConn(kind, text) {
  const p = $('conn');
  p.className = 'pill' + (kind ? ' ' + kind : '');
  p.textContent = text;
}

async function refreshStats() {
  try {
    const { stats } = await api('stats', {}, 1);
    const keys = [['total', 'Total'], ['Pending', 'Pending'], ['Done', 'Done'], ['doneToday', 'Done today'],
                  ['Already Correct', 'Already ok'], ['Failed', 'Failed']];
    $('totals').innerHTML = keys.map(([k, l]) => `<div><b>${stats[k] || 0}</b><small>${l}</small></div>`).join('');
  } catch (e) {
    $('totals').innerHTML = `<span class="muted">${escapeHtml(e.message)}</span>`;
  }
}

/* ================================================================= tab + page helpers */

function extractId(link) {
  link = String(link || '').trim();
  if (/^\d{5,}$/.test(link)) return link;
  const m = link.match(/\/(?:rooms|editor|listings|manage-your-space)\/(?:plus\/)?(\d{5,})/) || link.match(/(\d{6,})/);
  return m ? m[1] : '';
}
function editUrl(id) { return S.editUrlTemplate.replace('{id}', id); }

async function ensureTab(active) {
  if (workTabId != null) {
    try { await chrome.tabs.get(workTabId); return workTabId; } catch (e) { workTabId = null; }
  }
  const tab = await chrome.tabs.create({ url: 'about:blank', active });
  workTabId = tab.id;
  return workTabId;
}

function waitComplete(tabId, timeoutMs = 45000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); reject(new Error('Airbnb page took too long to load')); }, timeoutMs);
    function fn(id, info) {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(t); chrome.tabs.onUpdated.removeListener(fn); resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(fn);
  });
}

async function openUrl(url, active) {
  const tabId = await ensureTab(active);
  const done = waitComplete(tabId);
  const tab = await chrome.tabs.get(tabId);
  if (tab.url === url) await chrome.tabs.reload(tabId, { bypassCache: true });
  else await chrome.tabs.update(tabId, { url, active: active || undefined });
  await done;
  await sleep(800);
}

async function page(cmd, args = {}) {
  await chrome.scripting.executeScript({ target: { tabId: workTabId }, files: ['page.js'] });
  const [r] = await chrome.scripting.executeScript({
    target: { tabId: workTabId },
    func: (c, a) => window.__svRenamer[c](a),
    args: [cmd, { fieldSelector: S.fieldSelector || '', saveText: S.saveText || '', ...args }]
  });
  return r ? r.result : null;
}

/* ================================================================= one listing */

class StopRun extends Error {}

async function processItem(item, index, total) {
  const id = item.id || extractId(item.link);
  const newName = norm(item.newName);
  const base = { row: item.row, id, mode: S.mode === 'auto' ? 'Auto' : 'Assisted', operator: S.operator };
  const label = item.propertyName || `Listing ${id}`;
  setNow(`${index}/${total} · ${label}\n→ ${newName}`);

  if (!id) return finish(item, { ...base, status: 'Failed', note: 'No Airbnb listing ID in the link' }, label);
  if (!newName) return finish(item, { ...base, status: 'Skipped', note: 'New name is empty' }, label);
  if (newName.length > MAX_LEN) return finish(item, { ...base, status: 'Failed', note: `New name is ${newName.length} characters (max ${MAX_LEN})` }, label);

  const url = editUrl(id);
  await openUrl(url, true);
  let info = await page('inspect', { waitMs: 20000 });

  if (info.state === 'captcha' || info.state === 'login') {
    await release([item]);
    throw new StopRun(info.message + ' — sort it out in the Airbnb tab, then press Start again.');
  }
  if (info.state === 'denied') return finish(item, { ...base, status: 'Failed', note: info.message }, label);
  if (info.state !== 'ok') return finish(item, { ...base, status: 'Failed', note: info.message || 'Title box not found' }, label, true);

  const oldName = info.title;
  if (norm(oldName) === newName) {
    return finish(item, { ...base, status: 'Already Correct', oldName, verifiedName: oldName, note: '' }, label);
  }
  if (info.maxLength && newName.length > info.maxLength) {
    return finish(item, { ...base, status: 'Failed', oldName, note: `Airbnb allows ${info.maxLength} characters here` }, label);
  }

  let savedValue = newName, note = '';
  if (S.mode === 'assisted') {
    let res;
    try {
      res = await page('assist', { newName, id, propertyName: item.propertyName, index, total });
    } catch (e) {
      return finish(item, { ...base, status: 'Needs Check', oldName, note: 'Airbnb page changed before saving — check manually' }, label);
    }
    if (!res || res.action === 'stop') { await release([item]); throw new StopRun('Stopped from the Airbnb page'); }
    if (res.action === 'skip') return finish(item, { ...base, status: 'Skipped', oldName, note: 'Skipped by ' + (S.operator || 'operator') }, label);
    if (res.action === 'error') return finish(item, { ...base, status: 'Failed', oldName, note: res.message }, label, true);
    savedValue = norm(res.value);
    if (savedValue !== newName) note = 'Saved with an edit by ' + (S.operator || 'operator');
  } else {
    const f = await page('fill', { value: newName });
    if (!f || !f.ok) return finish(item, { ...base, status: 'Failed', oldName, note: 'Could not type the new name into the title box' }, label, true);
    const s = await page('save', { timeoutMs: 15000 });
    if (!s || !s.ok) return finish(item, { ...base, status: 'Failed', oldName, note: (s && s.message) || 'Save failed' }, label, true);
  }

  // Verify: reload the page and read the title back from Airbnb.
  await sleep(1500);
  await openUrl(url, S.mode === 'assisted');
  const check = await page('inspect', { waitMs: 20000 });
  const after = check && check.state === 'ok' ? check.title : null;
  let status;
  if (after == null) { status = 'Needs Check'; note = 'Saved, but could not re-read the title to confirm'; }
  else if (norm(after) === savedValue) status = 'Done';
  else if (norm(after) === norm(oldName)) { status = 'Failed'; note = 'Airbnb still shows the old name after saving'; }
  else { status = 'Needs Check'; note = 'Airbnb shows a different name than the one saved'; }

  return finish(item, { ...base, status, oldName, verifiedName: after, note }, label, status === 'Failed', true);
}

let consecutiveFails = 0;
async function finish(item, update, label, countsAsFailure = false, saved = false) {
  await report(update);
  claimed = claimed.filter((c) => c !== item);
  counts[update.status] = (counts[update.status] || 0) + 1;
  runProcessed++;
  consecutiveFails = countsAsFailure ? consecutiveFails + 1 : 0;
  if (saved) await bumpDaily();
  log(update.status, `${label}${update.note ? ' — ' + update.note : ''}`, update);
  renderCounts();
  if (consecutiveFails >= MAX_CONSECUTIVE_FAILS) {
    throw new StopRun(`${MAX_CONSECUTIVE_FAILS} failures in a row — paused. Open "Test one listing" to check the page still works.`);
  }
}

async function release(items) {
  if (!items.length) return;
  const ids = items.map((x) => x.id || extractId(x.link));
  claimed = claimed.filter((c) => !items.includes(c));
  try { await api('release', { ids }); } catch (e) { /* the sheet frees them after 30 minutes anyway */ }
}

/* ================================================================= run loop */

async function start() {
  await saveSettings();
  if (!S.operator) { openSettings('Add your name first'); return; }
  if (!S.scriptUrl || !S.token) { openSettings('Connect the Google Sheet first'); return; }
  if (S.mode === 'auto' && !$('autoAck').checked) { $('autoWarn').scrollIntoView(); flash($('autoWarn')); return; }

  const used = await refreshDaily();
  const left = Math.max(0, S.dailyCap - used);
  if (!left) { setNow(`Daily limit of ${S.dailyCap} reached. Change it in Settings if needed.`); return; }

  running = true; stopRequested = false; consecutiveFails = 0;
  counts = { Done: 0, 'Already Correct': 0, Skipped: 0, Failed: 0, 'Needs Check': 0 };
  runTotal = Math.min(S.runTarget, left); runProcessed = 0;
  renderCounts(); toggleRunning(true);
  log('Info', `Run started — ${S.mode} mode, up to ${runTotal} listings`);

  try {
    await flushOutbox();
    while (!stopRequested && runProcessed < runTotal) {
      const want = Math.min(S.batchSize, runTotal - runProcessed);
      const { rows } = await api('claim', { limit: want, operator: S.operator, retryFailed: S.retryFailed });
      if (!rows.length) { log('Info', 'No more Pending rows in the sheet'); break; }
      claimed.push(...rows);
      for (const item of rows) {
        if (stopRequested) break;
        if ((await getDaily()).count >= S.dailyCap) { stopRequested = true; log('Stop', `Daily limit of ${S.dailyCap} reached`); break; }
        try {
          await processItem(item, runProcessed + 1, runTotal);
        } catch (e) {
          if (e instanceof StopRun) throw e;
          await finish(item, { row: item.row, id: item.id, status: 'Failed', mode: S.mode === 'auto' ? 'Auto' : 'Assisted', operator: S.operator, note: e.message }, item.propertyName || item.id, true);
        }
        if (!stopRequested && S.mode === 'auto' && runProcessed < runTotal) {
          const gap = S.minDelay + Math.random() * (S.maxDelay - S.minDelay);
          await countdown(gap);
        } else if (!stopRequested) {
          await sleep(500);
        }
      }
    }
  } catch (e) {
    const msg = e instanceof StopRun ? e.message : 'Stopped: ' + e.message;
    log('Stop', msg);
    notify(msg);
  } finally {
    await release(claimed.slice());
    running = false; toggleRunning(false);
    setNow(`Finished — ${counts.Done} done, ${counts['Already Correct']} already ok, ${counts.Skipped} skipped, ${counts.Failed} failed`);
    refreshStats();
  }
}

async function stop() {
  stopRequested = true;
  setNow('Stopping after the current listing…');
  if (workTabId != null) {
    try {
      await chrome.scripting.executeScript({ target: { tabId: workTabId },
        func: () => window.__svRenamer && window.__svRenamer.removeBanner({ action: 'stop' }) });
    } catch (e) { /* tab gone */ }
  }
}

async function countdown(sec) {
  const end = Date.now() + sec * 1000;
  while (Date.now() < end && !stopRequested) {
    $('now').textContent = `Waiting ${Math.ceil((end - Date.now()) / 1000)}s before the next listing (auto mode)…`;
    await sleep(1000);
  }
}

/* ================================================================= test one */

async function testOne() {
  await saveSettings();
  const id = extractId($('testLink').value);
  const out = $('testOut');
  if (!id) { out.textContent = 'Paste an Airbnb link or a listing ID.'; return; }
  out.textContent = 'Opening ' + editUrl(id) + ' …';
  try {
    await openUrl(editUrl(id), true);
    const info = await page('inspect', { waitMs: 20000 });
    out.textContent = [
      `Page state: ${info.state}${info.message ? ' — ' + info.message : ''}`,
      `Current name: ${info.title != null ? '"' + info.title + '"' : '—'}`,
      `Box it will edit: ${info.field || '—'}`,
      `Name limit on page: ${info.maxLength || 'not shown'}`,
      `Save button found: ${info.hasSave ? 'yes' : 'no (it may only appear after editing)'}`,
      `URL: ${info.url}`,
      info.state === 'ok' ? '\nLooks good — the tool can work on this listing.' :
        '\nThe tool could not use this page. If Airbnb changed its layout, set the title box selector under Advanced.'
    ].join('\n');
  } catch (e) {
    out.textContent = 'Test failed: ' + e.message;
  }
}

/* ================================================================= import */

let wb = null;

function readFile(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try { resolve(XLSX.read(new Uint8Array(r.result), { type: 'array', raw: false })); } catch (e) { reject(e); }
    };
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

function sheetRows(name) {
  return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '', raw: false });
}

function guess(headers, patterns) {
  for (const p of patterns) {
    const i = headers.findIndex((h) => p.test(String(h).trim()));
    if (i >= 0) return i;
  }
  return -1;
}

function fillMap() {
  const rows = sheetRows($('mapSheet').value);
  const headers = (rows[0] || []).map((h, i) => String(h || `Column ${i + 1}`));
  const opts = (sel, idx, optional) => {
    sel.innerHTML = (optional ? '<option value="-1">— none —</option>' : '') +
      headers.map((h, i) => `<option value="${i}">${escapeHtml(h)}</option>`).join('');
    sel.value = String(idx >= 0 ? idx : (optional ? -1 : 0));
  };
  opts($('mapLink'), guess(headers, [/airbnb.*(link|url)/i, /^(listing )?(link|url)$/i, /airbnb.*id/i, /listing.?id/i, /link|url/i]));
  opts($('mapName'), guess(headers, [/^new.?name$/i, /best airbnb name/i, /new.*(name|title)/i, /approved/i]));
  opts($('mapProp'), guess(headers, [/^property.?name$/i, /vista_name/i, /property/i]), true);
  previewMap();
}

function mappedRows() {
  const rows = sheetRows($('mapSheet').value).slice(1);
  const li = Number($('mapLink').value), ni = Number($('mapName').value), pi = Number($('mapProp').value);
  return rows.map((r) => ({
    link: String(r[li] || '').trim(),
    id: extractId(r[li]),
    newName: norm(r[ni]),
    propertyName: pi >= 0 ? norm(r[pi]) : ''
  })).filter((r) => r.link || r.newName);
}

function previewMap() {
  const rows = mappedRows();
  const ok = rows.filter((r) => r.id && r.newName);
  const long = ok.filter((r) => r.newName.length > MAX_LEN).length;
  const noId = rows.filter((r) => !r.id).length;
  $('mapPreview').innerHTML = `${ok.length} rows ready` +
    (noId ? ` · <b>${noId}</b> without a listing ID (ignored)` : '') +
    (long ? ` · <b>${long}</b> over ${MAX_LEN} characters (they will be marked Failed)` : '') +
    (ok[0] ? `<br>Example: ${escapeHtml(ok[0].id)} → “${escapeHtml(ok[0].newName)}”` : '');
}

async function doImport() {
  await saveSettings();
  const rows = mappedRows().filter((r) => r.id && r.newName);
  if (!rows.length) { $('mapPreview').textContent = 'Nothing to send — check the column choices.'; return; }
  $('importBtn').disabled = true;
  let added = 0, updated = 0, skipped = 0;
  try {
    for (let i = 0; i < rows.length; i += 200) {
      $('mapPreview').textContent = `Sending ${Math.min(i + 200, rows.length)} / ${rows.length}…`;
      const r = await api('import', { rows: rows.slice(i, i + 200) });
      added += r.added; updated += r.updated; skipped += r.skipped;
    }
    $('mapPreview').textContent = `Done: ${added} added, ${updated} updated, ${skipped} skipped (already processed or incomplete).`;
    log('Info', `Imported ${added} new rows into the sheet`);
    refreshStats();
  } catch (e) {
    $('mapPreview').textContent = 'Import failed: ' + e.message;
  } finally {
    $('importBtn').disabled = false;
  }
}

/* ================================================================= UI helpers */

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function log(status, text, update) {
  const time = new Date().toLocaleTimeString();
  sessionLog.unshift({ time, status, text, ...(update || {}) });
  if (sessionLog.length > 1000) sessionLog.pop();
  const li = document.createElement('li');
  const cls = status.split(' ')[0];
  li.innerHTML = `<span class="s ${cls}">${escapeHtml(status)}</span>${escapeHtml(text)} <span class="muted">· ${time}</span>`;
  $('log').prepend(li);
  while ($('log').children.length > 200) $('log').lastChild.remove();
}

function downloadLog() {
  const cols = ['time', 'status', 'id', 'oldName', 'verifiedName', 'mode', 'operator', 'note', 'text'];
  const csv = [cols.join(',')].concat(sessionLog.map((r) =>
    cols.map((c) => `"${String(r[c] == null ? '' : r[c]).replace(/"/g, '""')}"`).join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `airbnb-renamer-log-${today()}.csv`;
  a.click();
}

function renderCounts() {
  $('cDone').textContent = counts.Done;
  $('cSame').textContent = counts['Already Correct'];
  $('cSkip').textContent = counts.Skipped;
  $('cFail').textContent = counts.Failed + (counts['Needs Check'] || 0);
  $('bar').style.width = runTotal ? `${Math.min(100, (runProcessed / runTotal) * 100)}%` : '0';
}

function setNow(t) { $('now').textContent = t; }
function toggleRunning(on) {
  $('startBtn').disabled = on; $('stopBtn').disabled = !on;
  $('modeAssisted').disabled = on; $('modeAuto').disabled = on;
  $('startBtn').textContent = on ? 'Running…' : 'Start';
}
function openSettings(msg) { $('settingsCard').open = true; $('settingsMsg').textContent = msg; $('settingsCard').scrollIntoView(); }
function flash(el) { el.animate([{ outline: '2px solid #e6aa5a' }, { outline: '2px solid transparent' }], { duration: 1200 }); }
function notify(message) {
  try { chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title: 'Airbnb Renamer stopped', message }); } catch (e) {}
}

/* ================================================================= wiring */

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  $('modeAssisted').onclick = () => setMode('assisted');
  $('modeAuto').onclick = () => setMode('auto');
  $('startBtn').onclick = () => start();
  $('stopBtn').onclick = () => stop();
  $('runTarget').onchange = () => saveSettings();
  $('saveSettings').onclick = async () => { await saveSettings(); $('settingsMsg').textContent = 'Saved.'; };
  $('testConn').onclick = async () => {
    await saveSettings();
    $('settingsMsg').textContent = 'Checking…';
    try { const r = await api('ping', {}, 1); $('settingsMsg').textContent = `Connected to "${r.sheet}" — ${r.stats.total} listings, ${r.stats.Pending || 0} pending.`; refreshStats(); }
    catch (e) { $('settingsMsg').textContent = 'Not connected: ' + e.message; }
  };
  $('refreshStats').onclick = () => refreshStats();
  $('dlLog').onclick = () => downloadLog();
  $('testBtn').onclick = () => testOne();
  $('file').onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      wb = await readFile(f);
      $('mapSheet').innerHTML = wb.SheetNames.map((n) => `<option>${escapeHtml(n)}</option>`).join('');
      $('mapBox').classList.remove('hidden');
      fillMap();
    } catch (err) { $('mapPreview').textContent = 'Could not read that file: ' + err.message; $('mapBox').classList.remove('hidden'); }
  };
  $('mapSheet').onchange = fillMap;
  ['mapLink', 'mapName', 'mapProp'].forEach((id) => { $(id).onchange = previewMap; });
  $('importBtn').onclick = doImport;
  if (S.scriptUrl && S.token) { refreshStats(); flushOutbox(); }
  else openSettings('Start here: add your name, the Apps Script URL and the token.');
});

// If the panel is closed mid-run, hand the claimed rows back to the sheet.
window.addEventListener('pagehide', () => {
  if (!claimed.length || !S.scriptUrl) return;
  const ids = claimed.map((x) => x.id || extractId(x.link));
  navigator.sendBeacon(S.scriptUrl, new Blob([JSON.stringify({ token: S.token, action: 'release', ids })], { type: 'text/plain' }));
});
