// Global settings: defaults, persistence and the settings dialog.

import { api, h, modal, toast, confirmDialog, esc, icon } from './util.js';
import { THEMES, FONTS } from './themes.js';

export const DEFAULT_HIGHLIGHTS = [
  { enabled: true, pattern: '\\b(error|errors|failed|failure|fatal|denied|critical|panic|refused|unreachable)\\b', regex: true, caseSensitive: false, fg: '#ffffff', bg: '#c0392b' },
  { enabled: true, pattern: '\\b(warn|warning|warnings|deprecated|timeout)\\b', regex: true, caseSensitive: false, fg: '#000000', bg: '#e0af68' },
  { enabled: true, pattern: '\\b(success|successful|succeeded|passed|enabled|established)\\b', regex: true, caseSensitive: false, fg: '#000000', bg: '#3ddc97' },
  { enabled: false, pattern: '\\b(?:\\d{1,3}\\.){3}\\d{1,3}(?:/\\d{1,2})?\\b', regex: true, caseSensitive: false, fg: '#7dcfff', bg: '' },
  { enabled: false, pattern: '\\b(down|administratively down)\\b', regex: true, caseSensitive: false, fg: '#ffffff', bg: '#a33' },
];

export const DEFAULTS = {
  uiTheme: 'dark',
  theme: 'Tor Dark',
  fontFamily: FONTS[0],
  fontSize: 14,
  lineHeight: 1.15,
  letterSpacing: 0,
  fontWeight: 'normal',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 10000,
  webgl: true,
  copyOnSelect: true,
  rightClick: 'menu', // menu | paste | copyPaste
  middleClickPaste: true,
  ctrlCCopy: true,
  ctrlVPaste: true,
  confirmMultilinePaste: true,
  trimPaste: false,
  bell: 'visual', // visual | sound | none
  titleFromRemote: true,
  wordSeparator: ' ()[]{}\',"`│',
  restoreWorkspace: true,
  confirmClose: true,
  openSessionIn: 'tab', // tab | split
  autoReconnect: false,
  reconnectDelay: 5,
  keepalive: 30,
  highlightEnabled: true,
  highlights: DEFAULT_HIGHLIGHTS,
  showButtonBar: true,
  showCommandWindow: false,
  sidebarWidth: 260,
  sidebarCollapsed: false,
  folders: [],
};

export const settings = { ...DEFAULTS };
const listeners = new Set();

export function onSettingsChange(fn) {
  listeners.add(fn);
}

export async function loadSettings() {
  try {
    const s = await api('/settings');
    if (s) Object.assign(settings, s);
  } catch {}
  applyUiTheme();
  return settings;
}

let saveTimer;
export function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  applyUiTheme();
  listeners.forEach((fn) => fn(settings, patch));
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => api('/settings', { method: 'PUT', body: settings }).catch((e) => toast('Saving settings failed: ' + e.message, 'error')), 300);
}

function applyUiTheme() {
  document.documentElement.dataset.theme = settings.uiTheme === 'light' ? 'light' : 'dark';
}

// ---------------------------------------------------------------------------
// Settings dialog
// ---------------------------------------------------------------------------

const field = (label, input, hint) => [h('label', label), input, hint ? h('div.hint', hint) : null];

function sel(key, options, s) {
  const e = h('select');
  for (const o of options) {
    const [v, l] = Array.isArray(o) ? o : [o, o];
    e.append(h('option', { value: v, selected: String(s[key]) === String(v) }, l));
  }
  e.addEventListener('change', () => (s[key] = typeof DEFAULTS[key] === 'number' ? Number(e.value) : e.value));
  return e;
}
function num(key, s, attrs = {}) {
  const e = h('input', { type: 'number', value: s[key], ...attrs });
  e.addEventListener('input', () => (s[key] = Number(e.value)));
  return e;
}
function txt(key, s) {
  const e = h('input', { type: 'text', value: s[key] });
  e.addEventListener('input', () => (s[key] = e.value));
  return e;
}
function chk(key, s, label) {
  const e = h('input', { type: 'checkbox', checked: !!s[key] });
  e.addEventListener('change', () => (s[key] = e.checked));
  return h('label.chk', e, label || '');
}

export function openSettings(app) {
  const s = JSON.parse(JSON.stringify(settings));
  const tabs = {
    Appearance: () => {
      const prev = themePreview(s);
      const grid = h(
        'div.form-grid',
        field('UI theme', sel('uiTheme', [['dark', 'Dark'], ['light', 'Light']], s)),
        field('Color scheme', sel('theme', Object.keys(THEMES), s)),
        field('Font family', fontPicker(s)),
        field('Font size', num('fontSize', s, { min: 6, max: 48 })),
        field('Font weight', sel('fontWeight', ['normal', '300', '500', '600', 'bold'], s)),
        field('Line height', num('lineHeight', s, { min: 1, max: 2, step: 0.05 })),
        field('Letter spacing', num('letterSpacing', s, { min: -2, max: 10, step: 1 })),
        field('Cursor style', sel('cursorStyle', ['block', 'bar', 'underline'], s)),
        field('', chk('cursorBlink', s, 'Blinking cursor')),
        field('', chk('webgl', s, 'GPU accelerated rendering (WebGL)'), 'Applies to newly opened panes.'),
        prev
      );
      grid.addEventListener('change', prev.draw);
      grid.addEventListener('input', prev.draw);
      return grid;
    },
    Terminal: () =>
      h(
        'div.form-grid',
        field('Scrollback lines', num('scrollback', s, { min: 0, max: 1000000, step: 1000 })),
        field('Bell', sel('bell', [['visual', 'Visual flash'], ['sound', 'Beep'], ['none', 'None']], s)),
        field('Word separators', txt('wordSeparator', s), 'Characters that end a word when double-clicking to select.'),
        field('', chk('titleFromRemote', s, 'Let the remote host set the pane title')),
        h('div.form-section', 'Clipboard'),
        field('', chk('copyOnSelect', s, 'Copy on select (PuTTY style)')),
        field('Right click', sel('rightClick', [['menu', 'Context menu'], ['paste', 'Paste (PuTTY)'], ['copyPaste', 'Copy if selection, else paste']], s), 'Shift+right-click always opens the menu.'),
        field('', chk('middleClickPaste', s, 'Middle click pastes')),
        field('', chk('ctrlCCopy', s, 'Ctrl+C copies when text is selected')),
        field('', chk('ctrlVPaste', s, 'Ctrl+V pastes (otherwise sends ^V)')),
        field('', chk('confirmMultilinePaste', s, 'Confirm before pasting multiple lines')),
        field('', chk('trimPaste', s, 'Trim trailing whitespace/newline on paste'))
      ),
    Behavior: () =>
      h(
        'div.form-grid',
        field('Open sessions in', sel('openSessionIn', [['tab', 'New tab'], ['split', 'Split current tab']], s)),
        field('', chk('restoreWorkspace', s, 'Restore tabs and panes on startup')),
        field('', chk('confirmClose', s, 'Confirm before closing connected panes')),
        field('', chk('autoReconnect', s, 'Auto reconnect when a connection drops (default for new sessions)')),
        field('Reconnect delay (s)', num('reconnectDelay', s, { min: 1, max: 600 })),
        field('SSH keepalive (s)', num('keepalive', s, { min: 0, max: 3600 }), 'Default for quick connects. 0 disables.')
      ),
    Highlighting: () => highlightEditor(s),
    'Known hosts': () => knownHostsView(),
    Shortcuts: () => shortcutsView(),
  };

  const body = h('div');
  const tabBar = h('div.form-tabs');
  const pane = h('div');
  body.append(tabBar, pane);
  const show = (name) => {
    tabBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.textContent === name));
    pane.replaceChildren(tabs[name]());
  };
  for (const name of Object.keys(tabs)) tabBar.append(h('button', { type: 'button', on: { click: () => show(name) } }, name));
  show('Appearance');

  modal({
    title: 'Settings',
    size: 'wide',
    body,
    buttons: [
      {
        label: 'Reset to defaults',
        left: true,
        onClick: async () => {
          if (!(await confirmDialog('Reset all settings to defaults? Sessions and buttons are kept.'))) return false;
          saveSettings({ ...DEFAULTS, folders: settings.folders });
          app.applySettingsToAll();
        },
      },
      { label: 'Cancel' },
      {
        label: 'Save',
        primary: true,
        onClick: () => {
          saveSettings(s);
          app.applySettingsToAll();
          toast('Settings saved', 'ok');
        },
      },
    ],
  });
}

function fontPicker(s) {
  const list = h('datalist#font-list', FONTS.map((f) => h('option', { value: f })));
  const inp = h('input', { type: 'text', value: s.fontFamily, list: 'font-list' });
  inp.addEventListener('input', () => (s.fontFamily = inp.value));
  return h('div', inp, list);
}

function themePreview(s) {
  const wrap = h('div.full', { style: { marginTop: '10px' } });
  const draw = () => {
    const t = THEMES[s.theme] || THEMES['Tor Dark'];
    const colors = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];
    wrap.innerHTML = `<div style="background:${t.background};color:${t.foreground};font-family:${esc(s.fontFamily)};font-size:13px;padding:10px 12px;border-radius:8px;border:1px solid var(--border)">
      <div><span style="color:${t.green}">user@server</span>:<span style="color:${t.blue}">~/projects</span>$ ls -la</div>
      <div><span style="color:${t.blue}">drwxr-xr-x</span> config  <span style="color:${t.green}">run.sh</span>  <span style="color:${t.red}">error.log</span>  <span style="color:${t.yellow}">notes.md</span><span style="background:${t.cursor};color:${t.background}"> </span></div>
      <div style="display:flex;gap:4px;margin-top:8px">${colors.map((c) => `<span style="width:22px;height:12px;border-radius:2px;background:${t[c]}"></span>`).join('')}</div>
      <div style="display:flex;gap:4px;margin-top:3px">${colors.map((c) => `<span style="width:22px;height:12px;border-radius:2px;background:${t['bright' + c[0].toUpperCase() + c.slice(1)]}"></span>`).join('')}</div></div>`;
  };
  draw();
  wrap.draw = draw;
  return wrap;
}

function highlightEditor(s) {
  const wrap = h('div');
  const table = h('table.tbl');
  const render = () => {
    table.replaceChildren(h('tr', h('th', 'On'), h('th', 'Pattern'), h('th', 'Regex'), h('th', 'Case'), h('th', 'Text'), h('th', 'Background'), h('th', '')));
    s.highlights.forEach((r, i) => {
      const bind = (k, el, prop = 'value') => {
        el.addEventListener(prop === 'checked' ? 'change' : 'input', () => (r[k] = el[prop]));
        return el;
      };
      const bgOn = h('input', { type: 'checkbox', checked: !!r.bg, title: 'Use background' });
      const bg = h('input', { type: 'color', value: r.bg || '#333333' });
      bgOn.addEventListener('change', () => (r.bg = bgOn.checked ? bg.value : ''));
      bg.addEventListener('input', () => bgOn.checked && (r.bg = bg.value));
      table.append(
        h(
          'tr',
          h('td', bind('enabled', h('input', { type: 'checkbox', checked: r.enabled !== false }), 'checked')),
          h('td', bind('pattern', h('input.mono', { type: 'text', value: r.pattern }))),
          h('td', bind('regex', h('input', { type: 'checkbox', checked: !!r.regex }), 'checked')),
          h('td', bind('caseSensitive', h('input', { type: 'checkbox', checked: !!r.caseSensitive }), 'checked')),
          h('td', bind('fg', h('input', { type: 'color', value: r.fg || '#ffffff' }))),
          h('td', h('div.inline', bgOn, bg)),
          h('td', h('button.icon-btn', { title: 'Remove', html: icon('trash'), on: { click: () => (s.highlights.splice(i, 1), render()) } }))
        )
      );
    });
  };
  render();
  wrap.append(
    h('div.form-grid', field('', chk('highlightEnabled', s, 'Enable keyword highlighting (SecureCRT style)'))),
    h('p.muted', 'Matching text in terminal output is colored. Applies to the normal screen buffer (not full-screen apps).'),
    table,
    h('div.inline', { style: { marginTop: '8px', justifyContent: 'flex-start' } },
      h('button.btn.sm', { type: 'button', on: { click: () => (s.highlights.push({ enabled: true, pattern: '', regex: false, caseSensitive: false, fg: '#000000', bg: '#ffd166' }), render()) } }, '+ Add rule'),
      h('button.btn.sm', { type: 'button', on: { click: () => ((s.highlights = JSON.parse(JSON.stringify(DEFAULT_HIGHLIGHTS))), render()) } }, 'Restore defaults'))
  );
  return wrap;
}

function knownHostsView() {
  const wrap = h('div', h('p.muted', 'Loading…'));
  const load = async () => {
    const hosts = await api('/known-hosts');
    const keys = Object.keys(hosts);
    if (!keys.length) return wrap.replaceChildren(h('p.muted', 'No cached host keys yet.'));
    wrap.replaceChildren(
      h('table.tbl',
        h('tr', h('th', 'Host'), h('th', 'Key type'), h('th', 'Fingerprint'), h('th', '')),
        keys.map((k) =>
          h('tr',
            h('td.mono', k),
            h('td', hosts[k].keyType),
            h('td.mono', { style: { wordBreak: 'break-all' } }, hosts[k].fingerprint),
            h('td', h('button.icon-btn', { title: 'Forget', html: icon('trash'), on: { click: async () => (await api('/known-hosts/' + encodeURIComponent(k), { method: 'DELETE' }), load()) } }))
          )
        )
      )
    );
  };
  load();
  return wrap;
}

export const SHORTCUTS = [
  ['Alt+Shift+T', 'New tab'],
  ['Alt+Shift+D', 'Split right (duplicate session)'],
  ['Alt+Shift+E', 'Split down (duplicate session)'],
  ['Alt+Shift+W', 'Close pane'],
  ['Alt+Shift+Enter', 'Maximize / restore pane'],
  ['Alt+Shift+R', 'Reconnect pane'],
  ['Alt+Arrows', 'Move focus between panes'],
  ['Alt+1…9', 'Go to tab'],
  ['Alt+PgUp / PgDn', 'Previous / next tab'],
  ['Alt+Shift+A', 'Claude assistant panel'],
  ['Ctrl+Shift+P', 'Command palette'],
  ['Ctrl+Shift+F', 'Find in terminal'],
  ['Ctrl+Shift+C / V', 'Copy / paste'],
  ['Ctrl+Shift+B', 'Broadcast input to tab'],
  ['Ctrl+Shift+K', 'Clear scrollback'],
  ['Ctrl+Shift+L', 'Focus command window'],
  ['Ctrl+= / − / 0', 'Font size bigger / smaller / reset'],
];

function shortcutsView() {
  return h('div.kbd-list', SHORTCUTS.map(([k, d]) => h('div', { html: `${k.split(' / ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' / ')} &nbsp;${esc(d)}` })));
}
