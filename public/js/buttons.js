// SecureCRT-style button bars: one-click commands sent to the active pane,
// every pane in the tab, or every open session.

import { api, h, icon, modal, toast, confirmDialog, promptDialog, contextMenu, uid, store } from './util.js';

const B = (label, text, extra = {}) => ({ id: uid(), label, text, appendEnter: true, target: 'active', ...extra });

export const DEFAULT_BARS = () => [
  {
    id: uid(),
    name: 'Linux',
    buttons: [
      B('ls -la', 'ls -la'),
      B('df -h', 'df -h'),
      B('free -h', 'free -h'),
      B('top', 'top'),
      B('uptime', 'uptime'),
      B('ip a', 'ip -br a'),
      B('ports', 'ss -tulpn'),
      B('syslog', 'sudo tail -f /var/log/syslog'),
      B('journal', 'sudo journalctl -f -n 100'),
      B('sudo -i', 'sudo -i'),
      B('Ctrl+C', '\\cC', { appendEnter: false, color: '#f7768e' }),
      B('clear', 'clear'),
    ],
  },
  {
    id: uid(),
    name: 'Cisco / Network',
    buttons: [
      B('term len 0', 'terminal length 0'),
      B('show run', 'show running-config'),
      B('int brief', 'show ip interface brief'),
      B('show ver', 'show version'),
      B('int status', 'show interfaces status'),
      B('cdp nei', 'show cdp neighbors'),
      B('show log', 'show logging'),
      B('conf t', 'configure terminal', { color: '#e0af68' }),
      B('end', 'end'),
      B('wr mem', 'write memory', { confirm: true, color: '#f7768e' }),
    ],
  },
  {
    id: uid(),
    name: 'Docker',
    buttons: [
      B('ps', 'docker ps'),
      B('ps -a', 'docker ps -a'),
      B('images', 'docker images'),
      B('stats', 'docker stats --no-stream'),
      B('compose logs', 'docker compose logs -f --tail=100'),
      B('compose up', 'docker compose up -d'),
      B('prune', 'docker system prune -f', { confirm: true, color: '#f7768e' }),
    ],
  },
];

export class ButtonsUI {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('buttonbar');
    this.bars = [];
    this.currentId = store.get('buttonBar', null);
  }

  async load() {
    let bars = null;
    try {
      bars = await api('/buttons');
    } catch {}
    if (!Array.isArray(bars) || !bars.length) {
      bars = DEFAULT_BARS();
      this.bars = bars;
      this.persist();
    }
    this.bars = bars;
    if (!this.current()) this.currentId = bars[0].id;
    this.render();
  }

  persist() {
    api('/buttons', { method: 'PUT', body: this.bars }).catch((e) => toast('Saving buttons failed: ' + e.message, 'error'));
  }

  importBars(bars) {
    for (const b of bars) if (b && Array.isArray(b.buttons)) this.bars.push({ ...b, id: uid(), buttons: b.buttons.map((x) => ({ ...x, id: uid() })) });
    this.persist();
    this.render();
  }

  current() {
    return this.bars.find((b) => b.id === this.currentId);
  }

  select(id) {
    if (!this.bars.some((b) => b.id === id)) return;
    this.currentId = id;
    store.set('buttonBar', id);
    this.render();
  }

  render() {
    const bar = this.current();
    const selEl = h('select', { title: 'Button bar' }, this.bars.map((b) => h('option', { value: b.id, selected: b.id === this.currentId }, b.name)));
    selEl.addEventListener('change', () => this.select(selEl.value));
    const manage = h('button.icon-btn', { title: 'Manage button bars', html: icon('settings') });
    manage.addEventListener('click', (e) => this.barMenu(e.clientX, e.clientY));
    const add = h('button.icon-btn', { title: 'Add button', html: icon('plus'), on: { click: () => this.editButton(null) } });
    const buttons = (bar ? bar.buttons : []).map((b, i) => this.buttonEl(bar, b, i));
    this.el.replaceChildren(selEl, manage, ...buttons, ...(buttons.length ? [] : [h('span.bb-empty', 'No buttons – click + to add one')]), add);
  }

  buttonEl(bar, b, i) {
    const el = h('button.bb-btn', { title: `${b.text}${b.hotkey ? `\nHotkey: ${b.hotkey}` : ''}\nTarget: ${b.target || 'active'}\nRight-click to edit, drag to reorder`, draggable: 'true' }, b.color ? h('span.swatch', { style: { background: b.color } }) : null, b.label);
    el.addEventListener('click', () => this.run(b));
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Run', icon: 'play', action: () => this.run(b) },
        { label: 'Run in all panes of tab', icon: 'grid', action: () => this.run({ ...b, target: 'tab' }) },
        { label: 'Run in all sessions', icon: 'broadcast', action: () => this.run({ ...b, target: 'all' }) },
        '-',
        { label: 'Edit…', icon: 'edit', action: () => this.editButton(b) },
        { label: 'Duplicate', icon: 'copy', action: () => (bar.buttons.splice(i + 1, 0, { ...b, id: uid(), label: b.label + ' copy' }), this.persist(), this.render()) },
        { label: 'Move to bar', submenu: this.bars.filter((x) => x !== bar).map((x) => ({ label: x.name, action: () => (bar.buttons.splice(i, 1), x.buttons.push(b), this.persist(), this.render()) })) },
        '-',
        { label: 'Delete', icon: 'trash', danger: true, action: () => (bar.buttons.splice(i, 1), this.persist(), this.render()) },
      ]);
    });
    el.addEventListener('dragstart', (e) => {
      this.dragIndex = i;
      e.dataTransfer.setData('application/x-tt-button', String(i));
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', (e) => e.dataTransfer.types.includes('application/x-tt-button') && e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = this.dragIndex;
      if (from == null || from === i) return;
      const [moved] = bar.buttons.splice(from, 1);
      bar.buttons.splice(i, 0, moved);
      this.dragIndex = null;
      this.persist();
      this.render();
    });
    return el;
  }

  async run(b) {
    if (b.confirm && !(await confirmDialog(`Send "${b.label}"?\n\n${b.text}`, { title: 'Confirm command', ok: 'Send' }))) return;
    let text = b.text || '';
    if (b.mode === 'lines') {
      text = text.split(/\r?\n/).filter((l) => l.length).map((l) => l + '\\r').join('');
    } else if (b.appendEnter) text += '\\r';
    const n = this.app.sendToTarget(text, b.target || 'active', { lineDelay: Number(b.delay) || 0 });
    if (!n) toast('No connected session to send to', 'error');
  }

  /** Match a keyboard event against button hotkeys. Returns true when handled. */
  handleHotkey(e) {
    const combo = comboFromEvent(e);
    for (const bar of this.bars) {
      for (const b of bar.buttons) {
        if (b.hotkey && normalizeCombo(b.hotkey) === combo) {
          this.run(b);
          return true;
        }
      }
    }
    return false;
  }

  barMenu(x, y) {
    const bar = this.current();
    contextMenu(x, y, [
      { label: 'Add button…', icon: 'plus', action: () => this.editButton(null) },
      '-',
      { label: 'New button bar…', icon: 'plus', action: async () => {
        const name = await promptDialog('Name of the new button bar:', '', { title: 'New button bar' });
        if (!name) return;
        const nb = { id: uid(), name, buttons: [] };
        this.bars.push(nb);
        this.persist();
        this.select(nb.id);
      } },
      { label: 'Rename bar…', icon: 'edit', disabled: !bar, action: async () => {
        const name = await promptDialog('Button bar name:', bar.name, { title: 'Rename button bar' });
        if (!name) return;
        bar.name = name;
        this.persist();
        this.render();
      } },
      { label: 'Delete bar', icon: 'trash', danger: true, disabled: !bar || this.bars.length < 2, action: async () => {
        if (!(await confirmDialog(`Delete button bar "${bar.name}" and its ${bar.buttons.length} buttons?`, { danger: true, ok: 'Delete' }))) return;
        this.bars = this.bars.filter((b) => b !== bar);
        this.currentId = this.bars[0].id;
        this.persist();
        this.render();
      } },
      '-',
      { label: 'Restore default bars', action: async () => {
        if (!(await confirmDialog('Add the default Linux, Cisco and Docker button bars?'))) return;
        this.bars.push(...DEFAULT_BARS());
        this.persist();
        this.render();
      } },
    ]);
  }

  editButton(btn) {
    const bar = this.current();
    if (!bar) return;
    const b = btn ? { ...btn } : { id: uid(), label: '', text: '', appendEnter: true, target: 'active', mode: 'send' };
    b.mode = b.mode || 'send';
    const f = (label, el, hint) => [h('label', label), el, hint ? h('div.hint', hint) : null];
    const bind = (key, el, prop = 'value') => {
      el.addEventListener(prop === 'checked' ? 'change' : 'input', () => (b[key] = el[prop]));
      return el;
    };
    const textArea = bind('text', h('textarea.mono', { rows: 5, spellcheck: 'false', placeholder: 'ls -la' }, b.text));
    const sel = (key, opts) => {
      const e = h('select', opts.map(([v, l]) => h('option', { value: v, selected: (b[key] || opts[0][0]) === v }, l)));
      e.addEventListener('change', () => (b[key] = e.value));
      return e;
    };
    const hot = h('input', { type: 'text', value: b.hotkey || '', placeholder: 'click and press keys, e.g. Ctrl+Alt+1 or F5', readOnly: true });
    hot.addEventListener('keydown', (e) => {
      e.preventDefault();
      if (e.key === 'Backspace' || e.key === 'Delete') {
        hot.value = b.hotkey = '';
        return;
      }
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;
      hot.value = b.hotkey = comboFromEvent(e);
    });
    const body = h(
      'div.form-grid',
      ...f('Label', bind('label', h('input', { type: 'text', value: b.label, placeholder: 'Button text', autofocus: true }))),
      ...f('Action', sel('mode', [['send', 'Send string'], ['lines', 'Send lines (script – Enter after each line)']])),
      ...f('Text', textArea, 'Escapes: \\r Enter, \\n LF, \\t Tab, \\e Esc, \\cC Ctrl+C, \\xHH byte, \\p pause 1 s. ${username} and ${password} expand to the session\'s saved credentials.'),
      ...f('', h('label.chk', bind('appendEnter', h('input', { type: 'checkbox', checked: !!b.appendEnter }), 'checked'), 'Append Enter (\\r)')),
      ...f('Line delay (ms)', bind('delay', h('input', { type: 'number', min: 0, value: b.delay || 0 })), 'Delay between lines – useful for slow network devices.'),
      ...f('Send to', sel('target', [['active', 'Active pane'], ['tab', 'All panes in current tab'], ['all', 'All open sessions']])),
      ...f('Color', h('div.inline', bind('color', h('input', { type: 'color', value: b.color || '#7aa2f7' })), h('button.btn.sm', { type: 'button', on: { click: () => (b.color = '') } }, 'No color'))),
      ...f('Hotkey', h('div.inline', hot, h('button.btn.sm', { type: 'button', on: { click: () => (hot.value = b.hotkey = '') } }, 'Clear'))),
      ...f('', h('label.chk', bind('confirm', h('input', { type: 'checkbox', checked: !!b.confirm }), 'checked'), 'Ask for confirmation before sending'))
    );
    modal({
      title: btn ? 'Edit button' : `New button in "${bar.name}"`,
      size: 'wide',
      body,
      buttons: [
        btn ? { label: 'Delete', danger: true, left: true, onClick: () => ((bar.buttons = bar.buttons.filter((x) => x.id !== btn.id)), this.persist(), this.render()) } : null,
        { label: 'Cancel' },
        {
          label: 'Save',
          primary: true,
          onClick: () => {
            if (!b.label) b.label = (b.text || 'Button').split('\n')[0].slice(0, 20);
            const i = bar.buttons.findIndex((x) => x.id === b.id);
            if (i >= 0) bar.buttons[i] = b;
            else bar.buttons.push(b);
            this.persist();
            this.render();
          },
        },
      ].filter(Boolean),
    });
  }
}

export function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Meta');
  let k = e.key;
  if (k === ' ') k = 'Space';
  else if (k.length === 1) k = (e.code && /^(Key|Digit)/.test(e.code) ? e.code.replace(/^(Key|Digit)/, '') : k).toUpperCase();
  parts.push(k);
  return parts.join('+');
}

export function normalizeCombo(s) {
  const parts = String(s).split('+').map((p) => p.trim());
  const key = parts.pop();
  const mods = ['Ctrl', 'Alt', 'Shift', 'Meta'].filter((m) => parts.some((p) => p.toLowerCase() === m.toLowerCase()));
  return [...mods, key.length === 1 ? key.toUpperCase() : key].join('+');
}

