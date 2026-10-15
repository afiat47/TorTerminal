// Shared UI helpers: icons, DOM builder, API, toasts, modals, context menus.

const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  plug: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  terminal: '<path d="m5 8 4 4-4 4M12 17h7"/><rect x="2" y="3" width="20" height="18" rx="2"/>',
  splitV: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M12 3v18"/>',
  splitH: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 12h18"/>',
  grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49M7.76 16.24a6 6 0 0 1 0-8.49M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  folder: '<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderOpen: '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  folderPlus: '<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  command: '<path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"/>',
  keyboard: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4M7 16h10"/>',
  fileText: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  settings: '<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16M8 16H3v5"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
  home: '<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  trash: '<path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  edit: '<path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  paste: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  chevRight: '<path d="m9 18 6-6-6-6"/>',
  chevDown: '<path d="m6 9 6 6 6-6"/>',
  play: '<path d="m6 3 14 9-14 9V3z"/>',
  stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  power: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0M12 2v10"/>',
  server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><path d="M6 6h.01M6 18h.01"/>',
  record: '<circle cx="12" cy="12" r="8"/>',
  eraser: '<path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>',
  star: '<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  type: '<path d="M4 7V4h16v3M9 20h6M12 4v16"/>',
  sparkles: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 15l.7 2.3L22 18l-2.3.7L19 21l-.7-2.3L16 18l2.3-.7z"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
};

export function icon(name, cls = '') {
  return `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name] || ''}</svg>`;
}

/** Replace <i data-icon="x"> placeholders inside root. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('i[data-icon]').forEach((n) => {
    if (!n.firstChild) n.innerHTML = icon(n.dataset.icon);
  });
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** Tiny hyperscript: h('div.cls#id', {attrs, on:{click}}, ...children) */
export function h(tag, props, ...children) {
  const m = tag.match(/^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i);
  const node = document.createElement(m[1] || 'div');
  for (const part of m[2].match(/[.#][\w-]+/g) || []) {
    if (part[0] === '.') node.classList.add(part.slice(1));
    else node.id = part.slice(1);
  }
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function formatBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
}

export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return `${hh ? hh + ':' : ''}${String(mm).padStart(hh ? 2 : 1, '0')}:${String(ss).padStart(2, '0')}`;
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));

export const debounce = (fn, ms) => {
  let t;
  return (...a) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
};

export const store = {
  get(k, d) {
    try {
      const v = localStorage.getItem('tt.' + k);
      return v == null ? d : JSON.parse(v);
    } catch {
      return d;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem('tt.' + k, JSON.stringify(v));
    } catch {}
  },
};

// ---------- API ----------

export async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const r = await fetch('/api' + path, init);
  if (r.status === 401) {
    location.href = '/login.html';
    throw new Error('Unauthorized');
  }
  const data = await r.json().catch(() => null);
  if (!r.ok) throw new Error((data && data.error) || r.statusText);
  return data;
}

// ---------- clipboard ----------

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: 0 } }, text);
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch {
    toast('Clipboard read blocked by the browser. Use Ctrl+V / Ctrl+Shift+V instead.', 'error');
    return '';
  }
}

export function downloadText(name, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept = '') {
  return new Promise((resolve) => {
    const inp = h('input', { type: 'file', accept, style: { display: 'none' } });
    inp.addEventListener('change', () => resolve(inp.files[0] || null));
    document.body.append(inp);
    inp.click();
    setTimeout(() => inp.remove(), 60000);
  });
}

// ---------- toasts ----------

export function toast(msg, kind = 'info', ms = 3500) {
  const t = h('div.toast', { class: `toast ${kind}` }, msg);
  document.getElementById('toasts').append(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- modals ----------

/**
 * Open a modal. `body` is a Node; `buttons` = [{label, primary, danger, left, onClick(close) -> false keeps open}]
 * Returns { el, close }.
 */
export function modal({ title, body, buttons = [], size = '', onClose, dismissable = true }) {
  const root = document.getElementById('modal-root');
  const prevFocus = document.activeElement;
  const foot = h('div.modal-foot');
  const left = h('div.left');
  foot.append(left);
  const box = h(`div.modal${size ? '.' + size : ''}`, h('div.modal-head', h('h3', title), h('button.icon-btn', { title: 'Close', html: icon('x'), on: { click: () => close() } })), h('div.modal-body', body), buttons.length ? foot : null);
  const back = h('div.modal-backdrop', box);
  let closed = false;
  function close(result) {
    if (closed) return;
    closed = true;
    back.remove();
    document.removeEventListener('keydown', onKey, true);
    onClose && onClose(result);
    prevFocus && prevFocus.focus && prevFocus.focus();
  }
  function onKey(e) {
    if (e.key === 'Escape' && dismissable && root.lastElementChild === back) {
      e.stopPropagation();
      close();
    }
  }
  for (const b of buttons) {
    const btn = h(`button.btn${b.primary ? '.primary' : ''}${b.danger ? '.danger' : ''}`, { type: 'button' }, b.label);
    btn.addEventListener('click', async () => {
      const r = b.onClick ? await b.onClick(close) : undefined;
      if (r !== false) close(b.value);
    });
    (b.left ? left : foot).append(btn);
  }
  back.addEventListener('mousedown', (e) => {
    if (e.target === back && dismissable) close();
  });
  document.addEventListener('keydown', onKey, true);
  root.append(back);
  setTimeout(() => {
    const f = box.querySelector('[autofocus], input:not([type=hidden]):not([type=checkbox]), textarea, select');
    f && f.focus();
  }, 20);
  return { el: box, close };
}

export function confirmDialog(message, { title = 'Confirm', ok = 'OK', danger = false } = {}) {
  return new Promise((resolve) => {
    let result = false;
    modal({
      title,
      body: h('p', { style: { whiteSpace: 'pre-wrap', margin: '4px 0 8px' } }, message),
      buttons: [
        { label: 'Cancel' },
        { label: ok, primary: !danger, danger, onClick: () => void (result = true) },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(message, value = '', { title = 'Input', placeholder = '' } = {}) {
  return new Promise((resolve) => {
    let result = null;
    const inp = h('input', { type: 'text', value, placeholder, autofocus: true });
    const m = modal({
      title,
      body: h('div', h('p', { style: { margin: '4px 0 8px', color: 'var(--text-dim)' } }, message), inp),
      buttons: [{ label: 'Cancel' }, { label: 'OK', primary: true, onClick: () => void (result = inp.value) }],
      onClose: () => resolve(result),
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        result = inp.value;
        m.close();
      }
    });
    setTimeout(() => inp.select(), 30);
  });
}

// ---------- context menu ----------

let openMenu = null;
export function closeContextMenu() {
  closeAll();
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeContextMenu());
window.addEventListener('blur', closeContextMenu);

/** items: [{label, icon, kb, action, disabled, danger, submenu:[...]}, '-'] */
export function contextMenu(x, y, items) {
  closeContextMenu();
  const menu = buildMenu(items);
  document.body.append(menu);
  placeMenu(menu, x, y);
  openMenu = menu;
}

function buildMenu(items) {
  const menu = h('div.ctx-menu');
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      menu.append(h('div.ctx-sep'));
      continue;
    }
    const row = h(`div.ctx-item${it.disabled ? '.disabled' : ''}${it.danger ? '.danger' : ''}`, { html: `${it.icon ? icon(it.icon) : '<span style="width:16px"></span>'}<span>${esc(it.label)}</span>${it.kb ? `<span class="kb">${esc(it.kb)}</span>` : it.submenu ? `<span class="kb">${icon('chevRight')}</span>` : ''}` });
    if (it.submenu) {
      row.classList.add('ctx-sub');
      let sub;
      row.addEventListener('mouseenter', () => {
        row.parentElement.querySelectorAll(':scope > .ctx-item.open').forEach((o) => {
          o.classList.remove('open');
          o._sub && o._sub.remove();
        });
        row.classList.add('open');
        sub = buildMenu(it.submenu);
        row._sub = sub;
        document.body.append(sub);
        const r = row.getBoundingClientRect();
        placeMenu(sub, r.right - 2, r.top - 4, r.left);

        sub.addEventListener('mousedown', (e) => e.stopPropagation());
      });
    } else {
      row.addEventListener('mouseenter', () => {
        row.parentElement.querySelectorAll(':scope > .ctx-item.open').forEach((o) => {
          o.classList.remove('open');
          o._sub && o._sub.remove();
        });
      });
      row.addEventListener('click', () => {
        closeAll();
        it.action && it.action();
      });
    }
    menu.append(row);
  }
  return menu;
}

function closeAll() {
  document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
  openMenu = null;
}
document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('.ctx-menu')) document.querySelectorAll('.ctx-menu').forEach((m) => m.remove());
});

function placeMenu(menu, x, y, altX) {
  const r = menu.getBoundingClientRect();
  let left = x;
  if (left + r.width > innerWidth - 4) left = altX != null ? altX - r.width + 2 : innerWidth - r.width - 4;
  let top = y;
  if (top + r.height > innerHeight - 4) top = Math.max(4, innerHeight - r.height - 4);
  menu.style.left = Math.max(4, left) + 'px';
  menu.style.top = top + 'px';
}

/**
 * Parse SecureCRT/PuTTY-style escapes in button / script text.
 * \r \n \t \e \b \\ \xHH \uHHHH, ^X control chars via \c (e.g. \cC), and
 * \p (pause 1s) which splits the result into chunks.
 * Returns an array of {text} | {pause: ms}.
 */
export function parseSendText(src) {
  const out = [];
  let cur = '';
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c !== '\\' || i === src.length - 1) {
      cur += c;
      continue;
    }
    const n = src[++i];
    switch (n) {
      case 'r': cur += '\r'; break;
      case 'n': cur += '\n'; break;
      case 't': cur += '\t'; break;
      case 'e': cur += '\x1b'; break;
      case 'b': cur += '\x08'; break;
      case '0': cur += '\x00'; break;
      case '\\': cur += '\\'; break;
      case 'x': cur += String.fromCharCode(parseInt(src.substr(i + 1, 2), 16) || 0); i += 2; break;
      case 'u': cur += String.fromCharCode(parseInt(src.substr(i + 1, 4), 16) || 0); i += 4; break;
      case 'c': {
        const ch = (src[++i] || '').toUpperCase();
        cur += ch === '?' ? '\x7f' : String.fromCharCode(ch.charCodeAt(0) & 0x1f);
        break;
      }
      case 'p':
        if (cur) out.push({ text: cur });
        cur = '';
        out.push({ pause: 1000 });
        break;
      default: cur += '\\' + n;
    }
  }
  if (cur) out.push({ text: cur });
  return out;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
