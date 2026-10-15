// Application controller.

import { api, h, icon, esc, hydrateIcons, modal, toast, confirmDialog, contextMenu, debounce, store, formatBytes, formatDuration } from './util.js';
import { settings, loadSettings, saveSettings, openSettings, SHORTCUTS } from './settings.js';
import { Layout } from './layout.js';
import { TerminalPane, describeTarget, invalidateHighlightRules } from './terminal-pane.js';
import { SessionsUI, protoShort } from './sessions.js';
import { ButtonsUI } from './buttons.js';
import { SftpPanel } from './sftp.js';
import { AssistantPanel } from './assistant.js';

class App {
  constructor() {
    this.sessions = new Map();
    this.activePane = null;
    this.caps = {};
    this.saveWorkspace = debounce(() => {
      if (this.layout) store.set('workspace', this.layout.serialize());
    }, 400);
    this.renderTabsSoon = debounce(() => this.layout.renderTabs(), 100);
  }

  async init() {
    hydrateIcons();
    await loadSettings();
    try {
      this.caps = await api('/capabilities');
    } catch (e) {
      toast('Cannot reach server: ' + e.message, 'error');
    }
    this.layout = new Layout(this);
    this.sessionsUI = new SessionsUI(this);
    this.buttons = new ButtonsUI(this);
    this.sftpPanel = new SftpPanel(this);
    this.assistant = new AssistantPanel(this);
    await Promise.all([this.sessionsUI.load().catch((e) => toast(e.message, 'error')), this.buttons.load()]);

    this.bindToolbar();
    this.bindQuickConnect();
    this.bindCommandWindow();
    this.bindSidebarResize();
    this.bindGlobalKeys();
    this.applyChrome();
    if (this.caps.auth) document.getElementById('btn-logout').classList.remove('hidden');

    const ws = settings.restoreWorkspace ? store.get('workspace', null) : null;
    if (!ws || !this.layout.restore(ws)) this.layout.newTab();

    if (store.get('aiOpen', false)) this.assistant.open();
    setInterval(() => this.updateStatusBar(), 1000);
    window.addEventListener('beforeunload', (e) => {
      this.saveWorkspaceNow();
      if (settings.confirmClose && this.layout.allPanes().some((p) => p.state === 'connected')) {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  saveWorkspaceNow() {
    store.set('workspace', this.layout.serialize());
  }

  // ------------------------------------------------------------------ chrome

  applyChrome() {
    const sb = document.getElementById('sidebar');
    sb.classList.toggle('collapsed', !!settings.sidebarCollapsed);
    sb.style.width = (settings.sidebarWidth || 260) + 'px';
    document.getElementById('buttonbar').classList.toggle('hidden', !settings.showButtonBar);
    document.getElementById('command-window').classList.toggle('hidden', !settings.showCommandWindow);
    document.querySelector('[data-action="toggleButtonBar"]').classList.toggle('active', !!settings.showButtonBar);
    document.querySelector('[data-action="toggleCommandWindow"]').classList.toggle('active', !!settings.showCommandWindow);
    document.querySelector('[data-action="toggleSidebar"]').classList.toggle('active', !settings.sidebarCollapsed);
  }

  applySettingsToAll() {
    invalidateHighlightRules();
    this.layout.allPanes().forEach((p) => p.applySettings());
    this.applyChrome();
  }

  bindToolbar() {
    document.addEventListener('click', (e) => {
      const b = e.target.closest('[data-action]');
      if (!b) return;
      const fn = this.actions[b.dataset.action];
      if (fn) fn(e, b);
    });
  }

  get actions() {
    return {
      toggleSidebar: () => {
        saveSettings({ sidebarCollapsed: !settings.sidebarCollapsed });
        this.applyChrome();
      },
      newTab: () => this.layout.newTab(),
      localShell: (e) => this.localShellMenu(e),
      splitRight: () => this.activePane && this.splitPane(this.activePane, 'row'),
      splitDown: () => this.activePane && this.splitPane(this.activePane, 'col'),
      tile: () => this.layout.tile(),
      zoomPane: () => this.activePane && this.layout.toggleZoom(this.activePane),
      toggleBroadcast: () => this.toggleBroadcast(),
      toggleSftp: () => this.sftpPanel.toggle(this.activePane),
      toggleAssistant: () => this.assistant.toggle(),
      toggleCommandWindow: () => {
        saveSettings({ showCommandWindow: !settings.showCommandWindow });
        this.applyChrome();
        if (settings.showCommandWindow) document.getElementById('cw-input').focus();
      },
      toggleButtonBar: () => {
        saveSettings({ showButtonBar: !settings.showButtonBar });
        this.applyChrome();
      },
      showLogs: () => this.showLogs(),
      palette: () => this.palette(),
      settings: () => openSettings(this),
      logout: async () => {
        await api('/logout', { method: 'POST' });
        location.href = '/login.html';
      },
      newSession: () => this.sessionsUI.edit(null),
      newFolder: () => this.sessionsUI.newFolder(),
      importSessions: () => this.sessionsUI.importAll(),
      exportSessions: () => this.sessionsUI.exportAll(),
    };
  }

  localShellMenu(e) {
    const shells = this.caps.shells || [];
    if (!shells.length) return toast('No local shells detected', 'error');
    if (shells.length === 1 || !e) return this.openLocalShell(shells[0]);
    const r = (e.target.closest('button') || e.target).getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, shells.map((s) => ({ label: s.name, icon: 'terminal', action: () => this.openLocalShell(s) })));
  }

  openLocalShell(shell) {
    return this.openSpec({ overrides: { protocol: 'local', shell: shell.path, shellName: shell.name } });
  }

  bindSidebarResize() {
    const rz = document.getElementById('sidebar-resizer');
    const sb = document.getElementById('sidebar');
    rz.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const x0 = e.clientX;
      const w0 = sb.offsetWidth;
      rz.classList.add('drag');
      const shield = h('div', { style: { position: 'fixed', inset: 0, zIndex: 999, cursor: 'col-resize' } });
      document.body.append(shield);
      const move = (ev) => (sb.style.width = Math.max(180, Math.min(520, w0 + ev.clientX - x0)) + 'px');
      const up = () => {
        rz.classList.remove('drag');
        shield.remove();
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        saveSettings({ sidebarWidth: sb.offsetWidth });
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    rz.addEventListener('dblclick', () => this.actions.toggleSidebar());
  }

  // ------------------------------------------------------------------ quick connect

  bindQuickConnect() {
    const form = document.getElementById('quick-connect');
    const proto = document.getElementById('qc-proto');
    const input = document.getElementById('qc-target');
    const history = store.get('qcHistory', []);
    const dl = h('datalist#qc-history', history.map((x) => h('option', { value: x })));
    form.append(dl);
    input.setAttribute('list', 'qc-history');
    const placeholders = { ssh: 'user@host:port', telnet: 'host:port', raw: 'host:port', serial: 'COM3 115200', local: 'shell (optional)' };
    proto.addEventListener('change', () => (input.placeholder = `Quick connect: ${placeholders[proto.value]}`));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const spec = this.parseQuickConnect(proto.value, input.value.trim());
      if (!spec) return toast('Enter a host, e.g. user@server:22', 'error');
      const hist = [input.value.trim(), ...history.filter((x) => x !== input.value.trim())].slice(0, 20);
      store.set('qcHistory', hist);
      this.openSpec({ overrides: spec }, { where: 'tab' });
      input.value = '';
    });
  }

  parseQuickConnect(protocol, text) {
    let t = text;
    const m = t.match(/^(ssh|telnet|raw|serial|local)(?::\/\/|\s+)(.*)$/i);
    if (m) {
      protocol = m[1].toLowerCase();
      t = m[2].trim();
    }
    if (protocol === 'local') {
      const shells = this.caps.shells || [];
      const s = shells.find((x) => t && (x.name.toLowerCase().includes(t.toLowerCase()) || x.path.toLowerCase().includes(t.toLowerCase()))) || shells[0];
      return s ? { protocol, shell: s.path, shellName: s.name } : null;
    }
    if (protocol === 'serial') {
      const [port, baud] = t.split(/\s+/);
      if (!port) return null;
      return { protocol, serialPort: port, baudRate: baud || '9600', name: port };
    }
    let port;
    const pf = t.match(/(?:^|\s)-p\s*(\d+)/);
    if (pf) {
      port = Number(pf[1]);
      t = t.replace(pf[0], ' ').trim();
    }
    const parts = t.split(/\s+/);
    t = parts[0] || '';
    if (parts[1] && /^\d+$/.test(parts[1])) port = Number(parts[1]);
    let username;
    const at = t.lastIndexOf('@');
    if (at > 0) {
      username = t.slice(0, at);
      t = t.slice(at + 1);
    }
    let host = t;
    const v6 = t.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (v6) {
      host = v6[1];
      if (v6[2]) port = Number(v6[2]);
    } else if ((t.match(/:/g) || []).length === 1) {
      const [hh, pp] = t.split(':');
      host = hh;
      if (/^\d+$/.test(pp)) port = Number(pp);
    }
    if (!host) return null;
    const defPort = { ssh: 22, telnet: 23, raw: 23 }[protocol];
    return { protocol, host, port: port || defPort, username, keepalive: settings.keepalive, autoReconnect: settings.autoReconnect };
  }

  // ------------------------------------------------------------------ panes & sessions

  createPane(spec) {
    if (spec.sessionId && !this.sessions.has(spec.sessionId)) return null;
    return new TerminalPane(this, spec);
  }

  openSession(id, opts = {}) {
    if (!this.sessions.has(id)) return toast('Session not found', 'error');
    const recent = [id, ...store.get('recent', []).filter((x) => x !== id)].slice(0, 12);
    store.set('recent', recent);
    return this.openSpec({ sessionId: id }, opts);
  }

  openSpec(spec, { where = settings.openSessionIn, target = null, dir = 'row', before = false } = {}) {
    const pane = this.createPane(spec);
    if (!pane) return null;
    let tab = this.layout.active;
    if (!tab || !tab.root) {
      tab = tab || this.layout.newTab();
      this.layout.addPane(tab, pane);
    } else if (where === 'split') {
      this.layout.insertAt(target || tab.activePane || this.layout.panes(tab)[0], pane, dir, before);
      tab.zoomed = null;
      this.layout.render(tab);
    } else {
      tab = this.layout.newTab();
      this.layout.addPane(tab, pane);
    }
    this.setActivePane(pane);
    this.saveWorkspace();
    return pane;
  }

  openInNewTab(spec) {
    return this.openSpec(JSON.parse(JSON.stringify({ ...spec, title: undefined })), { where: 'tab' });
  }

  openMany(ids, title) {
    const tab = this.layout.active && !this.layout.active.root ? this.layout.active : this.layout.newTab();
    tab.customTitle = title || '';
    for (const id of ids) {
      const pane = this.createPane({ sessionId: id });
      if (pane) this.layout.addPane(tab, pane);
    }
    this.layout.tile(tab);
    this.layout.activateTab(tab);
    this.saveWorkspace();
  }

  splitPane(pane, dir) {
    const spec = JSON.parse(JSON.stringify({ ...pane.spec, title: undefined }));
    const np = this.createPane(spec);
    if (!np) return;
    const loc = this.layout.locate(pane);
    this.layout.insertAt(pane, np, dir, false);
    loc.tab.zoomed = null;
    this.layout.render(loc.tab);
    this.setActivePane(np);
    this.saveWorkspace();
  }

  async confirmClosePanes(panes) {
    const live = panes.filter((p) => p.state === 'connected');
    if (!settings.confirmClose || !live.length) return true;
    return confirmDialog(live.length === 1 ? `Close the connection to "${live[0].title}"?` : `Close ${live.length} active connections?`, { title: 'Close', ok: 'Close', danger: true });
  }

  async closePane(pane) {
    if (!(await this.confirmClosePanes([pane]))) return;
    const tab = this.layout.detach(pane);
    pane.dispose();
    if (this.sftpPanel.pane === pane) this.sftpPanel.close();
    if (!tab) return;
    if (!tab.root && this.layout.tabs.length > 1) {
      this.layout.closeTab(tab, { confirm: false });
    } else {
      this.layout.render(tab);
      const next = tab.activePane || this.layout.panes(tab)[0] || null;
      this.activePane = null;
      this.setActivePane(next);
      next && next.focus();
    }
    this.saveWorkspace();
  }

  setActivePane(pane) {
    if (this.activePane === pane) return;
    if (this.activePane) this.activePane.el.classList.remove('focused');
    this.activePane = pane;
    if (pane) {
      pane.el.classList.add('focused');
      const loc = this.layout.locate(pane);
      if (loc) loc.tab.activePane = pane;
      if (pane.opts.buttonBarId) this.buttons.select(pane.opts.buttonBarId);
      this.sftpPanel.follow(pane);
      setTimeout(() => pane === this.activePane && document.activeElement?.closest?.('.modal, .search-bar, #command-window, #toolbar, #sidebar') == null && pane.focus(), 0);
    }
    this.updateBroadcastButton();
    this.updateStatusBar();
    this.renderTabsSoon();
    if (this.assistant) this.assistant.updateContextLine();
  }

  onPaneChanged(pane) {
    if (pane === this.activePane) this.updateStatusBar();
    if (this.layout) this.renderTabsSoon();
  }

  onSessionSaved(s) {
    for (const p of this.layout.allPanes()) {
      if (p.spec.sessionId === s.id) p.applySettings();
    }
  }

  // ------------------------------------------------------------------ broadcast & multi-send

  tabOf(pane) {
    const loc = pane && this.layout.locate(pane);
    return loc ? loc.tab : null;
  }

  isBroadcasting(pane) {
    const t = this.tabOf(pane);
    return !!(t && t.broadcast);
  }

  broadcastInput(src, d) {
    const tab = this.tabOf(src);
    for (const p of this.layout.panes(tab)) if (p !== src) p.sendInput(d);
  }

  toggleBroadcast(tab = this.layout.active) {
    if (!tab) return;
    tab.broadcast = !tab.broadcast;
    for (const p of this.layout.panes(tab)) {
      p.el.classList.toggle('broadcast', tab.broadcast);
      p.updateHeader();
    }
    this.updateBroadcastButton();
    this.layout.renderTabs();
    toast(tab.broadcast ? 'Broadcast ON – typing goes to every pane in this tab' : 'Broadcast off', tab.broadcast ? 'error' : 'info');
  }

  updateBroadcastButton() {
    const t = this.layout && this.layout.active;
    document.getElementById('btn-broadcast').classList.toggle('on', !!(t && t.broadcast));
  }

  targetPanes(target) {
    let panes = [];
    if (target === 'all') panes = this.layout.allPanes();
    else if (target === 'tab') panes = this.layout.active ? this.layout.panes(this.layout.active) : [];
    else if (this.activePane) panes = [this.activePane];
    return panes.filter((p) => p.state === 'connected');
  }

  sendToTarget(text, target, opts = {}) {
    const panes = this.targetPanes(target);
    panes.forEach((p) => p.sendText(text, opts));
    if (this.activePane) this.activePane.focus();
    return panes.length;
  }

  // ------------------------------------------------------------------ command window (SecureCRT "Command/Chat window")

  bindCommandWindow() {
    const ta = document.getElementById('cw-input');
    const target = document.getElementById('cw-target');
    const enter = document.getElementById('cw-enter');
    const hist = store.get('cwHistory', []);
    let hi = -1;
    target.value = store.get('cwTarget', 'active');
    target.addEventListener('change', () => store.set('cwTarget', target.value));
    const send = () => {
      const text = ta.value;
      if (!text && !enter.checked) return;
      const lines = text.split(/\r?\n/);
      const payload = lines.join('\r') + (enter.checked ? '\r' : '');
      const n = this.sendToTarget(payload, target.value, { escapes: false });
      if (!n) return toast('No connected session to send to', 'error');
      if (text) {
        const i = hist.indexOf(text);
        if (i >= 0) hist.splice(i, 1);
        hist.unshift(text);
        hist.length = Math.min(hist.length, 100);
        store.set('cwHistory', hist);
      }
      hi = -1;
      ta.value = '';
      ta.focus();
    };
    document.getElementById('cw-send').addEventListener('click', send);
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      } else if (e.key === 'ArrowUp' && ta.selectionStart === 0 && hist.length) {
        e.preventDefault();
        hi = Math.min(hist.length - 1, hi + 1);
        ta.value = hist[hi];
      } else if (e.key === 'ArrowDown' && ta.selectionEnd === ta.value.length) {
        e.preventDefault();
        hi = Math.max(-1, hi - 1);
        ta.value = hi >= 0 ? hist[hi] : '';
      } else if (e.key === 'Escape') {
        this.activePane && this.activePane.focus();
      }
    });
  }

  // ------------------------------------------------------------------ keyboard

  bindGlobalKeys() {
    document.addEventListener('keydown', (e) => {
      const t = e.target;
      if (t && t.classList && t.classList.contains('xterm-helper-textarea')) return; // handled by the pane
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
      if (document.querySelector('.modal-backdrop')) return;
      const ctrl = e.ctrlKey || e.metaKey;
      if (typing && !(ctrl && e.shiftKey) && !(e.altKey && e.shiftKey)) return;
      if (this.handleShortcut(e, this.activePane)) e.preventDefault();
    });
  }

  /** Returns true when the key event was consumed. */
  handleShortcut(e, pane) {
    const ctrl = e.ctrlKey || e.metaKey;
    const c = e.code;
    if (e.altKey && e.shiftKey && !ctrl) {
      const map = {
        KeyT: () => this.layout.newTab(),
        KeyD: () => pane && this.splitPane(pane, 'row'),
        KeyE: () => pane && this.splitPane(pane, 'col'),
        Minus: () => pane && this.splitPane(pane, 'col'),
        Equal: () => pane && this.splitPane(pane, 'row'),
        KeyW: () => pane && this.closePane(pane),
        Enter: () => pane && this.layout.toggleZoom(pane),
        KeyR: () => pane && (pane.state === 'connected' ? (pane.disconnect(), pane.reconnect()) : pane.reconnect()),
        KeyS: () => this.sftpPanel.toggle(pane),
        KeyA: () => this.assistant.toggle(),
      };
      if (map[c]) return map[c](), true;
    }
    if (e.altKey && !e.shiftKey && !ctrl) {
      const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
      if (dirs[e.key]) return this.layout.focusDirection(dirs[e.key]), true;
      const d = c.match(/^Digit([1-9])$/);
      if (d) {
        const tab = this.layout.tabs[Number(d[1]) - 1];
        if (tab) this.layout.activateTab(tab);
        return true;
      }
      if (e.key === 'PageUp' || e.key === 'PageDown') {
        const tabs = this.layout.tabs;
        const i = tabs.indexOf(this.layout.active);
        this.layout.activateTab(tabs[(i + (e.key === 'PageDown' ? 1 : -1) + tabs.length) % tabs.length]);
        return true;
      }
    }
    if (ctrl && e.shiftKey && !e.altKey) {
      const map = {
        KeyP: () => this.palette(),
        KeyF: () => pane && pane.toggleSearch(true),
        KeyB: () => this.toggleBroadcast(),
        KeyK: () => pane && pane.term.clear(),
        KeyL: () => {
          if (!settings.showCommandWindow) this.actions.toggleCommandWindow();
          document.getElementById('cw-input').focus();
        },
      };
      if (map[c]) return map[c](), true;
    }
    if (ctrl && !e.shiftKey && !e.altKey && pane) {
      if (c === 'Equal' || c === 'NumpadAdd') return pane.setFontDelta(pane.fontDelta + 1), true;
      if (c === 'Minus' || c === 'NumpadSubtract') return pane.setFontDelta(pane.fontDelta - 1), true;
      if (c === 'Digit0' || c === 'Numpad0') return pane.setFontDelta(0), true;
    }
    if ((e.ctrlKey || e.altKey || e.metaKey || /^F\d+$/.test(e.key)) && this.buttons.handleHotkey(e)) return true;
    return false;
  }

  // ------------------------------------------------------------------ welcome

  welcomeView(tab) {
    const recentIds = store.get('recent', []).filter((id) => this.sessions.has(id)).slice(0, 8);
    const card = (proto, title, sub, fn) => h('button.card', { type: 'button', on: { click: fn } }, h('span', { class: `proto-dot p-${proto}`, html: proto === 'new' ? icon('plus') : esc(protoShort(proto)) }), h('div.meta', h('div', title), sub ? h('div.sub', sub) : null));
    const shells = this.caps.shells || [];
    return h(
      'div.welcome',
      h(
        'div.welcome-inner',
        h('h2', 'TorTerminal'),
        h('p.lead', 'SSH, SFTP, Telnet, Raw TCP, Serial and local shells – with split panes, tabs, button bars and session management.'),
        h('h4', 'Start'),
        h(
          'div.card-grid',
          card('new', 'New session…', 'Save host, credentials and options', () => this.sessionsUI.edit(null)),
          card('ssh', 'Quick connect', 'user@host:port in the toolbar', () => document.getElementById('qc-target').focus()),
          ...shells.map((s) => card('local', s.name, s.path, () => this.openLocalShell(s)))
        ),
        recentIds.length ? h('h4', 'Recent sessions') : null,
        recentIds.length
          ? h('div.card-grid', recentIds.map((id) => {
              const s = this.sessions.get(id);
              return card(s.protocol, s.name, describeTarget(s), () => this.openSession(id));
            }))
          : null,
        !recentIds.length && this.sessions.size
          ? [h('h4', 'Saved sessions'), h('div.card-grid', [...this.sessions.values()].slice(0, 8).map((s) => card(s.protocol, s.name, describeTarget(s), () => this.openSession(s.id))))]
          : null,
        h('h4', 'Keyboard shortcuts'),
        h('div.kbd-list', SHORTCUTS.map(([k, d]) => h('div', { html: `${k.split(' / ').map((x) => `<kbd>${esc(x)}</kbd>`).join(' / ')} &nbsp;${esc(d)}` }))),
        h('h4', 'Tips'),
        h('ul', { style: { color: 'var(--text-dim)', paddingLeft: '18px', margin: 0 } },
          h('li', 'Drag a session from the sidebar onto a pane edge to open it in a split, or drag a pane header to re-dock it.'),
          h('li', 'Right-click a folder to connect to all its sessions tiled side by side.'),
          h('li', 'Use the button bar and command window to send commands to one pane, a whole tab, or every session.'),
          h('li', 'Ctrl+click links in the terminal to open them.'))
      )
    );
  }

  // ------------------------------------------------------------------ status bar

  updateStatusBar() {
    const p = this.activePane;
    const set = (id, text, cls) => {
      const el = document.getElementById(id);
      el.textContent = text || '';
      if (cls !== undefined) el.className = 'sb-item ' + cls;
    };
    if (!p) {
      ['sb-state', 'sb-target', 'sb-log', 'sb-enc', 'sb-size', 'sb-traffic', 'sb-time'].forEach((id) => set(id, ''));
      set('sb-state', `${this.layout ? this.layout.allPanes().filter((x) => x.state === 'connected').length : 0} connected`);
      return;
    }
    set('sb-state', { connected: '● Connected', connecting: '◌ Connecting…', closed: '○ Disconnected', error: '✖ Error', idle: '○ Idle' }[p.state] || p.state);
    set('sb-target', `${(p.opts.protocol || '').toUpperCase()} ${describeTarget(p.opts)}`);
    set('sb-log', p.logging ? `● REC ${p.logFile || ''}` : '', p.logging ? 'on' : '');
    set('sb-enc', (p.opts.encoding || 'UTF-8').toUpperCase());
    set('sb-size', p.term ? `${p.term.cols}×${p.term.rows}` : '');
    set('sb-traffic', `↓ ${formatBytes(p.rx)}  ↑ ${formatBytes(p.tx)}`);
    set('sb-time', p.state === 'connected' && p.connectedAt ? `⏱ ${formatDuration(Date.now() - p.connectedAt)}` : '');
  }

  openSftp(pane) {
    this.sftpPanel.open(pane);
  }

  async uploadToPane(pane, files) {
    await this.sftpPanel.open(pane);
    if (this.sftpPanel.cwd) this.sftpPanel.upload(files);
  }

  // ------------------------------------------------------------------ logs

  async showLogs() {
    const body = h('div', h('p.muted', 'Loading…'));
    const load = async () => {
      const logs = await api('/logs');
      if (!logs.length) return body.replaceChildren(h('p.muted', 'No logs yet. Start logging from a pane menu, or enable it in a session\'s Logging tab.'));
      body.replaceChildren(
        h('table.tbl',
          h('tr', h('th', 'File'), h('th', 'Size'), h('th', 'Modified'), h('th', '')),
          logs.map((l) =>
            h('tr',
              h('td.mono', l.name),
              h('td', formatBytes(l.size)),
              h('td', new Date(l.mtime).toLocaleString()),
              h('td', { style: { whiteSpace: 'nowrap' } },
                h('a.icon-btn', { href: `/api/logs/${encodeURIComponent(l.name)}`, target: '_blank', title: 'View', html: icon('fileText') }),
                h('a.icon-btn', { href: `/api/logs/${encodeURIComponent(l.name)}?download=1`, title: 'Download', html: icon('download') }),
                h('button.icon-btn', { title: 'Delete', html: icon('trash'), on: { click: async () => (await api('/logs/' + encodeURIComponent(l.name), { method: 'DELETE' }), load()) } }))
            )
          )
        )
      );
    };
    load().catch((e) => body.replaceChildren(h('p', e.message)));
    modal({ title: 'Session logs', size: 'wide', body, buttons: [{ label: 'Close', primary: true }] });
  }

  // ------------------------------------------------------------------ command palette

  palette() {
    if (document.querySelector('.palette')) return;
    const a = this.actions;
    const pane = this.activePane;
    const items = [
      ...[
        ['New tab', 'Alt+Shift+T', a.newTab],
        ['New session…', '', a.newSession],
        ['Split right', 'Alt+Shift+D', a.splitRight],
        ['Split down', 'Alt+Shift+E', a.splitDown],
        ['Tile panes', '', a.tile],
        ['Maximize / restore pane', 'Alt+Shift+Enter', a.zoomPane],
        ['Toggle broadcast', 'Ctrl+Shift+B', a.toggleBroadcast],
        ['SFTP browser', 'Alt+Shift+S', a.toggleSftp],
        ['Claude assistant', 'Alt+Shift+A', a.toggleAssistant],
        ['Toggle command window', 'Ctrl+Shift+L', a.toggleCommandWindow],
        ['Toggle button bar', '', a.toggleButtonBar],
        ['Toggle sidebar', '', a.toggleSidebar],
        ['Session logs', '', a.showLogs],
        ['Settings', '', a.settings],
        ['Import sessions', '', a.importSessions],
        ['Export sessions', '', a.exportSessions],
        ['Find in terminal', 'Ctrl+Shift+F', () => pane && pane.toggleSearch(true)],
        ['Clear scrollback', 'Ctrl+Shift+K', () => pane && pane.term.clear()],
        ['Reconnect pane', 'Alt+Shift+R', () => pane && pane.reconnect()],
        ['Disconnect pane', '', () => pane && pane.disconnect()],
        ['Start / stop logging', '', () => pane && pane.toggleLogging()],
        ['Save output to file', '', () => pane && pane.saveOutput()],
        ['Close pane', 'Alt+Shift+W', () => pane && this.closePane(pane)],
        ['Toggle light / dark UI', '', () => (saveSettings({ uiTheme: settings.uiTheme === 'light' ? 'dark' : 'light' }), this.applySettingsToAll())],
      ].map(([label, kb, run]) => ({ grp: 'Action', label, kb, run })),
      ...(this.caps.shells || []).map((s) => ({ grp: 'Shell', label: `Open ${s.name}`, run: () => this.openLocalShell(s) })),
      ...[...this.sessions.values()].map((s) => ({ grp: 'Connect', label: `${s.folder ? s.folder + '/' : ''}${s.name}`, kb: describeTarget(s), run: () => this.openSession(s.id) })),
      ...this.layout.tabs.map((t, i) => ({ grp: 'Tab', label: this.layout.tabTitle(t), kb: i < 9 ? `Alt+${i + 1}` : '', run: () => this.layout.activateTab(t) })),
      ...this.buttons.bars.flatMap((b) => b.buttons.map((btn) => ({ grp: 'Button', label: `${b.name}: ${btn.label}`, kb: btn.text.slice(0, 30), run: () => this.buttons.run(btn) }))),
    ];
    const input = h('input', { type: 'text', placeholder: 'Type a command, session or tab…', spellcheck: 'false' });
    const list = h('div.palette-list');
    const box = h('div.palette', input, list);
    const back = h('div', { style: { position: 'fixed', inset: 0, zIndex: 140 } });
    let shown = [];
    let idx = 0;
    const close = () => {
      box.remove();
      back.remove();
      pane && pane.focus();
    };
    const render = () => {
      const q = input.value.toLowerCase().trim().split(/\s+/).filter(Boolean);
      shown = items.filter((it) => {
        const hay = `${it.grp} ${it.label} ${it.kb || ''}`.toLowerCase();
        return q.every((w) => hay.includes(w));
      }).slice(0, 80);
      idx = Math.min(idx, Math.max(0, shown.length - 1));
      list.replaceChildren(
        ...shown.map((it, i) => {
          const el = h(`div.palette-item${i === idx ? '.active' : ''}`, h('span.grp', it.grp), h('span', it.label), it.kb ? h('span.kb', it.kb) : null);
          el.addEventListener('mousemove', () => {
            if (idx !== i) {
              idx = i;
              render();
            }
          });
          el.addEventListener('click', () => {
            close();
            it.run();
          });
          return el;
        })
      );
      const act = list.querySelector('.active');
      act && act.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => ((idx = 0), render()));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') idx = Math.min(shown.length - 1, idx + 1);
      else if (e.key === 'ArrowUp') idx = Math.max(0, idx - 1);
      else if (e.key === 'Enter') {
        const it = shown[idx];
        close();
        it && it.run();
        return;
      } else if (e.key === 'Escape') return close();
      else return;
      e.preventDefault();
      render();
    });
    back.addEventListener('mousedown', close);
    document.body.append(back, box);
    render();
    input.focus();
  }
}

const app = new App();
window.torterminal = app;
app.init().catch((e) => {
  console.error(e);
  toast('Startup failed: ' + e.message, 'error', 10000);
});
