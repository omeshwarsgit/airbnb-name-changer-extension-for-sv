// Injected into the Airbnb listing-editor tab by the side panel.
// Exposes window.__svRenamer with: inspect, fill, save, assist, removeBanner.
// Safe to inject more than once.
(() => {
  if (window.__svRenamer && window.__svRenamer.version === 4) return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

  function visible(el) {
    if (!el || !el.isConnected) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function pageText() {
    return (document.body && document.body.innerText || '').toLowerCase().slice(0, 20000);
  }

  // ---------------------------------------------------------------- page state
  function detectBlocker() {
    const text = pageText();
    if (document.querySelector('iframe[src*="captcha" i], iframe[src*="arkose" i], iframe[src*="funcaptcha" i], #px-captcha, [id*="captcha" i]') ||
        /verify (that )?you(['’]| a)re (a )?human|are you a robot|security check/.test(text)) {
      return { state: 'captcha', message: 'Airbnb is showing a human-verification check' };
    }
    if (/\/login|\/signup_login|\/authenticate/.test(location.pathname) ||
        (document.querySelector('input[type=password]') && !findField())) {
      return { state: 'login', message: 'Not logged in to Airbnb in this browser' };
    }
    if (/you don['’]t have (access|permission)|page you['’]re looking for|we can['’]t seem to find|listing (is|was) (unavailable|deactivated|removed)/.test(text)) {
      return { state: 'denied', message: 'This listing is not accessible from the Airbnb account logged in here' };
    }
    return null;
  }

  function attrs(el) {
    return ['id', 'name', 'aria-label', 'placeholder', 'data-testid', 'aria-labelledby']
      .map((a) => (el.getAttribute(a) || '')).join(' ').toLowerCase();
  }

  function labelText(el) {
    let t = '';
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) t += ' ' + l.innerText;
    }
    const lb = el.getAttribute('aria-labelledby');
    if (lb) lb.split(/\s+/).forEach((id) => { const n = document.getElementById(id); if (n) t += ' ' + n.innerText; });
    return t.toLowerCase();
  }

  // Text that describes a field: its attributes, its <label>, and nearby headings.
  function context(el) {
    let t = attrs(el) + ' ' + labelText(el);
    let node = el.parentElement;
    for (let i = 0; i < 5 && node && node !== document.body; i++, node = node.parentElement) {
      node.querySelectorAll('h1, h2, h3, h4, label, legend, [role=heading]').forEach((h) => {
        if (!h.contains(el)) t += ' ' + (h.innerText || '').slice(0, 120);
      });
      if (t.length > 600) break;
    }
    return t.toLowerCase();
  }

  // Fields we must never touch (internal name/nickname, description, translations, etc.).
  const NEVER = /internal|nickname|private name|only you|only visible to you|description|summary|about (this|the) (space|place)|translat|guest access|interaction|neighbou?rhood|house rules/;
  let lastFieldInfo = '';

  function findField(selector) {
    lastFieldInfo = '';
    if (selector) {
      const el = document.querySelector(selector);
      if (el && visible(el)) { lastFieldInfo = 'custom selector'; return el; }
      return null;
    }
    const cands = [...document.querySelectorAll('textarea, input[type=text], input:not([type])')]
      .filter((el) => visible(el) && !el.disabled && !el.readOnly && !(window.__svRenamer && window.__svRenamer._host && window.__svRenamer._host.contains(el)))
      .filter((el) => !/search|query|location|destination|guest|date/.test(attrs(el)));
    const scored = cands.map((el) => {
      const ctx = context(el);
      if (NEVER.test(attrs(el) + ' ' + labelText(el))) return { el, s: -1, ctx };
      let s = 0;
      if (el.maxLength === 50) s += 6;
      if (/\btitle\b/.test(ctx)) s += 5;
      if (/listing name|\bname\b/.test(ctx)) s += 1;
      if (NEVER.test(ctx)) s -= 8;
      if (el.closest('main')) s += 1;
      return { el, s, ctx };
    }).filter((x) => x.s > 0).sort((x, y) => y.s - x.s);
    if (!scored.length) return null;
    // Refuse to guess when two boxes look equally like the title.
    if (scored.length > 1 && scored[1].s === scored[0].s) { lastFieldInfo = 'ambiguous'; return null; }
    if (scored[0].s < 5) return null;     // must look like a title (limit 50 or labelled "title")
    lastFieldInfo = (labelText(scored[0].el) || attrs(scored[0].el)).trim().slice(0, 80) || 'title box';
    return scored[0].el;
  }

  // "Select title": if we landed on the editor overview, open the Title section.
  function openTitleSection() {
    const items = [...document.querySelectorAll('a, button, [role=button], [role=link], [role=tab]')]
      .filter((b) => visible(b) && /^title\b/i.test(norm(b.innerText)) && !/internal/i.test(b.innerText));
    if (items.length) { items[0].click(); return true; }
    return false;
  }

  function buttonText(b) { return norm(b.innerText || b.value || b.getAttribute('aria-label') || ''); }

  function findSave(saveText) {
    const re = saveText ? new RegExp('^' + saveText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
                        : /^(save|save changes)$/i;
    const btns = [...document.querySelectorAll('button, [role=button], input[type=submit]')]
      .filter((b) => visible(b) && re.test(buttonText(b)) && !(window.__svRenamer && window.__svRenamer._host && window.__svRenamer._host.contains(b)));
    return btns.length ? btns[btns.length - 1] : null;
  }

  function isDisabled(b) {
    return !!(b.disabled || b.getAttribute('aria-disabled') === 'true' || b.getAttribute('aria-busy') === 'true');
  }

  async function inspect(opts = {}) {
    const waitMs = opts.waitMs || 20000;
    const t0 = Date.now();
    let field = null, clickedTitle = false;
    while (Date.now() - t0 < waitMs) {
      field = findField(opts.fieldSelector);
      if (!field && !clickedTitle && Date.now() - t0 > 3000 && lastFieldInfo !== 'ambiguous') clickedTitle = openTitleSection();
      const block = detectBlocker();
      if (block && (block.state !== 'login' || !field)) return { ...block, url: location.href };
      if (field) break;
      await sleep(500);
    }
    if (!field) return { state: 'nofield', url: location.href, message: lastFieldInfo === 'ambiguous'
      ? 'More than one box looks like the title, so nothing was touched. Set the title box selector under Advanced.'
      : 'Could not find the English listing title box on this page' };
    await sleep(300); // let React settle the initial value
    return {
      state: 'ok',
      url: location.href,
      title: norm(field.value),
      maxLength: field.maxLength > 0 ? field.maxLength : null,
      field: lastFieldInfo,
      hasSave: !!findSave(opts.saveText)
    };
  }

  // ---------------------------------------------------------------- edit + save
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Re-send the value the way a keystroke would, so Airbnb's form notices the change.
  function nudge(el, value) {
    el.focus();
    setNativeValue(el, value + ' ');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ' ' }));
    setNativeValue(el, value);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'End' }));
  }

  async function fill(opts) {
    if (!norm(opts.value)) return { ok: false, message: 'No new name given' };
    const el = findField(opts.fieldSelector);
    if (!el) return { ok: false, message: 'Title box not found' };
    const before = norm(el.value);
    el.focus();
    el.select();
    // execCommand goes through the browser's own editing path, which React-controlled inputs pick up reliably.
    let done = false;
    try { done = document.execCommand('insertText', false, opts.value); } catch (e) { done = false; }
    if (!done || norm(el.value) !== norm(opts.value)) setNativeValue(el, opts.value);
    await sleep(500);
    const btn = findSave(opts.saveText);
    if (btn && isDisabled(btn) && before !== norm(opts.value)) { nudge(el, opts.value); await sleep(600); }
    return { ok: norm(el.value) === norm(opts.value), before, after: norm(el.value) };
  }

  async function save(opts = {}) {
    const timeout = opts.timeoutMs || 15000;
    let btn = findSave(opts.saveText);
    if (!btn) return { ok: false, message: 'Save button not found' };
    const t0 = Date.now();
    while (isDisabled(btn) && Date.now() - t0 < 3000) await sleep(200);
    if (isDisabled(btn)) {
      const f = findField(opts.fieldSelector);
      if (f) { nudge(f, norm(f.value)); await sleep(1000); btn = findSave(opts.saveText) || btn; }
    }
    if (isDisabled(btn)) return { ok: false, message: "Airbnb's Save button is still grey — type one space and delete it in the English box, then press Save & next again" };
    const label = buttonText(btn);
    const alertText = () => [...document.querySelectorAll('[role=alert], [role=status], [aria-live]')]
      .filter((n) => !(window.__svRenamer._host && window.__svRenamer._host.contains(n)))
      .map((n) => n.innerText.toLowerCase()).join(' ');
    const base = alertText();
    btn.click();
    const t1 = Date.now();
    await sleep(600);
    while (Date.now() - t1 < timeout) {
      const alert = alertText();
      if (alert !== base) {
        if (/couldn['’]t save|something went wrong|try again|error|not allowed|too long/.test(alert)) {
          return { ok: false, message: 'Airbnb error: ' + norm(alert).slice(0, 160) };
        }
        if (/saved|changes saved|updated/.test(alert)) return { ok: true, signal: 'toast' };
      }
      if (!btn.isConnected || !visible(btn)) return { ok: true, signal: 'button-gone' };
      if (isDisabled(btn)) return { ok: true, signal: 'button-disabled' };
      if (buttonText(btn) !== label) return { ok: true, signal: 'button-text' };
      await sleep(300);
    }
    return { ok: true, signal: 'timeout' }; // the side panel re-reads the page to be sure
  }

  // ---------------------------------------------------------------- assisted-mode banner
  function removeBanner(result) {
    const api = window.__svRenamer;
    if (api._host) { api._host.remove(); api._host = null; }
    if (api._keys) { window.removeEventListener('keydown', api._keys, true); api._keys = null; }
    if (api._resolve) { const r = api._resolve; api._resolve = null; r(result || { action: 'stop', value: null }); }
    return true;
  }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  async function assist(opts) {
    const api = window.__svRenamer;
    removeBanner({ action: 'stop' });
    const filled = await fill({ ...opts, value: opts.newName });
    if (!filled.ok) return { action: 'error', message: filled.message || 'Could not put the new name in the title box' };

    return new Promise((resolve) => {
      api._resolve = resolve;
      const host = document.createElement('div');
      host.id = 'sv-renamer-banner';
      host.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;';
      const root = host.attachShadow({ mode: 'open' });
      root.innerHTML = `
        <style>
          .box{font:13px/1.4 -apple-system,Segoe UI,Roboto,sans-serif;width:360px;background:#fff;color:#1d1d1d;
               border:1px solid #d6d6d6;border-radius:12px;box-shadow:0 12px 32px rgba(0,0,0,.18);padding:14px}
          .top{display:flex;justify-content:space-between;color:#5b5b5b;font-size:12px;margin-bottom:6px}
          .tag{background:#1f3b2d;color:#fff;border-radius:999px;padding:1px 8px;font-weight:600}
          .lbl{font-size:11px;color:#6b6b6b;text-transform:uppercase;letter-spacing:.04em;margin-top:8px}
          .old{color:#8a8a8a;text-decoration:line-through;word-break:break-word}
          .new{font-weight:600;word-break:break-word}
          .hint{font-size:12px;color:#5b5b5b;margin-top:8px}
          .row{display:flex;gap:8px;margin-top:12px}
          button{font:inherit;border-radius:8px;padding:8px 10px;cursor:pointer;border:1px solid #c9c9c9;background:#fff}
          .go{flex:1;background:#1f3b2d;color:#fff;border-color:#1f3b2d;font-weight:600}
          .go:disabled{opacity:.6;cursor:wait}
          .msg{color:#b3261e;font-size:12px;margin-top:6px;min-height:0}
        </style>
        <div class="box">
          <div class="top"><span class="tag">StayVista Renamer</span><span>${esc(opts.index)} of ${esc(opts.total)}</span></div>
          <div class="new" style="font-size:14px">${esc(opts.propertyName || 'Listing ' + opts.id)}</div>
          <div class="lbl">Current name</div><div class="old">${esc(filled.before || '—')}</div>
          <div class="lbl">New name (${String(opts.newName).length}/50)</div><div class="new">${esc(opts.newName)}</div>
          <div class="hint">The new name is filled in. You can edit it in Airbnb's box before saving.</div>
          <div class="msg" id="msg"></div>
          <div class="row">
            <button class="go" id="go" title="Ctrl+Enter">Save &amp; next ⏎</button>
            <button id="skip">Skip</button>
            <button id="stop">Stop</button>
          </div>
        </div>`;
      document.documentElement.appendChild(host);
      api._host = host;
      const $ = (id) => root.getElementById(id);

      const finish = (result) => {
        api._resolve = null;
        if (api._host) { api._host.remove(); api._host = null; }
        if (api._keys) { window.removeEventListener('keydown', api._keys, true); api._keys = null; }
        resolve(result);
      };

      const doSave = async () => {
        $('go').disabled = true; $('go').textContent = 'Saving…'; $('msg').textContent = '';
        const field = findField(opts.fieldSelector);
        const value = field ? norm(field.value) : '';
        if (!value) { $('msg').textContent = 'The title box is empty.'; $('go').disabled = false; $('go').textContent = 'Save & next ⏎'; return; }
        if (value.length > 50) { $('msg').textContent = `That is ${value.length} characters — Airbnb allows 50.`; $('go').disabled = false; $('go').textContent = 'Save & next ⏎'; return; }
        const s = await save(opts);
        if (!s.ok) { $('msg').textContent = s.message; $('go').disabled = false; $('go').textContent = 'Try save again'; return; }
        finish({ action: 'saved', value, before: filled.before, signal: s.signal });
      };

      $('go').addEventListener('click', doSave);
      $('skip').addEventListener('click', () => finish({ action: 'skip', before: filled.before }));
      $('stop').addEventListener('click', () => finish({ action: 'stop', before: filled.before }));
      api._keys = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); doSave(); } };
      window.addEventListener('keydown', api._keys, true);
      setTimeout(() => $('go').focus(), 50);
    });
  }

  window.__svRenamer = { version: 4, inspect, fill, save, assist, removeBanner, _host: null, _resolve: null, _keys: null };
})();
