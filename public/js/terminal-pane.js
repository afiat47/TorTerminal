// A single terminal pane: xterm.js instance bound to one server connection.

import { Terminal } from '/vendor/xterm/lib/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit/lib/addon-fit.mjs';
import { SearchAddon } from '/vendor/addon-search/lib/addon-search.mjs';
import { WebLinksAddon } from '/vendor/addon-web-links/lib/addon-web-links.mjs';
import { Unicode11Addon } from '/vendor/addon-unicode11/lib/addon-unicode11.mjs';
import { WebglAddon } from '/vendor/addon-webgl/lib/addon-webgl.mjs';
import { h, icon, uid, copyText, readClipboard, confirmDialog, promptDialog, contextMenu, downloadText, debounce, parseSendText, sleep, toast } from './util.js';
import { settings } from './settings.js';
import { THEMES } from './themes.js';

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x00-\x08\x0b-\x1f\x7f]/g;
const PROTO_LABEL = { ssh: 'SSH', telnet: 'TELNET', raw: 'RAW', serial: 'SERIAL', local: 'LOCAL' };

export function describeTarget(o) {
  if (!o) return '';
  if (o.protocol === 'serial') return `${o.serialPort || '?'} @ ${o.baudRate || 9600}`;
  if (o.protocol === 'local') return o.shellName || (o.shell ? o.shell.split(/[\\/]/).pop() : 'local shell');
  const defPort = { ssh: 22, telnet: 23 }[o.protocol];
  const port = o.port && Number(o.port) !== defPort ? `:${o.port}` : '';
  return `${o.username ? o.username + '@' : ''}${o.host || '?'}${port}`;
}

let highlightRules = null;
export function invalidateHighlightRules() {
  highlightRules = null;
}
function getHighlightRules() {
  if (highlightRules) return highlightRules;
  highlightRules = [];
  for (const r of settings.highlights || []) {
    if (r.enabled === false || !r.pattern) continue;
    try {
      const src = r.regex ? r.pattern : r.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      highlightRules.push({ re: new RegExp(src, r.caseSensitive ? 'g' : 'gi'), fg: r.fg || undefined, bg: r.bg || undefined });
    } catch {}
  }
  return highlightRules;
}

let audioCtx;
function beep() {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.06;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.08);
  } catch {}
}

export class TerminalPane {
  /**
   * @param app  the App controller
   * @param spec { sessionId?, overrides?, title? }
   */
  constructor(app, spec) {
    this.app = app;
    this.id = uid();
    this.spec = JSON.parse(JSON.stringify(spec));
    this.state = 'idle';
    this.rx = 0;
    this.tx = 0;
    this.remoteEcho = true;
    this.lineBuf = '';
    this.logging = false;
    this.customTitle = spec.title || '';
    this.remoteTitle = '';
    this.sftpPending = new Map();
    this.aiId = 'T' + ++TerminalPane.counter; // short ID that Claude and the user can refer to
    this.lastOutputAt = 0;
    this.dialogQueue = Promise.resolve();
    this.hlDecos = [];
    this.fontDelta = 0;
    this.refreshOptions();
    this.buildDom();
    this.createTerminal();
  }

  /** Effective (non-secret) options: saved session merged with overrides. */
  refreshOptions() {
    const saved = this.spec.sessionId ? this.app.sessions.get(this.spec.sessionId) : null;
    this.opts = { ...(saved || {}), ...(this.spec.overrides || {}) };
    if (this.opts.autoReconnect == null) this.opts.autoReconnect = settings.autoReconnect;
  }

  get title() {
    return this.customTitle || (settings.titleFromRemote && this.remoteTitle) || this.opts.name || describeTarget(this.opts) || 'Terminal';
  }

  // ------------------------------------------------------------------ DOM

  buildDom() {
    this.dot = h('span.state');
    this.titleEl = h('span.title');
    this.badges = h('span.badges');
    const act = (ic, title, fn) => h('button.icon-btn', { title, html: icon(ic), on: { click: (e) => (e.stopPropagation(), fn(e)) } });
    this.sftpBtn = act('folderOpen', 'SFTP browser', () => this.app.openSftp(this));
    this.sftpBtn.classList.add('hidden');
    this.zoomBtn = act('maximize', 'Maximize / restore (Alt+Shift+Enter)', () => this.app.layout.toggleZoom(this));
    this.head = h(
      'div.pane-head',
      { draggable: 'true' },
      this.dot,
      this.titleEl,
      this.badges,
      h('span.actions',
        this.sftpBtn,
        act('splitV', 'Split right', () => this.app.splitPane(this, 'row')),
        act('splitH', 'Split down', () => this.app.splitPane(this, 'col')),
        this.zoomBtn,
        act('more', 'Menu', (e) => this.showMenu(e.clientX, e.clientY)),
        act('x', 'Close pane', () => this.app.closePane(this))
      )
    );
    this.head.addEventListener('dblclick', () => this.rename());
    this.head.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-tt-pane', this.id);
      e.dataTransfer.effectAllowed = 'move';
      this.app.layout.dragPane = this;
    });
    this.head.addEventListener('dragend', () => (this.app.layout.dragPane = null));
    this.host = h('div.term-host');
    this.el = h('div.pane', this.head, this.host);
    this.el.addEventListener('mousedown', () => this.app.setActivePane(this), true);
    this.el.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    this.el.addEventListener('mouseup', (e) => {
      if (e.button === 1 && settings.middleClickPaste && this.host.contains(e.target)) {
        e.preventDefault();
        readClipboard().then((t) => t && this.paste(t));
      }
    });
    // Drop text (e.g. a path dragged from the SFTP panel) to paste it; drop files to upload via SFTP.
    this.host.addEventListener('dragover', (e) => {
      if (this.app.layout.dragPane) return;
      const t = e.dataTransfer.types;
      if (t.includes('Files') || (t.includes('text/plain') && !t.includes('application/x-tt-session'))) e.preventDefault();
    });
    this.host.addEventListener('drop', (e) => {
      if (this.app.layout.dragPane || e.dataTransfer.types.includes('application/x-tt-session')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer.files.length) {
        if (this.sftpAvailable) this.app.uploadToPane(this, [...e.dataTransfer.files]);
        else toast('File upload needs a connected SSH session', 'error');
      } else {
        const text = e.dataTransfer.getData('text/plain');
        if (text) this.paste(text);
      }
    });
    // Intercept paste so multi-line confirmation and trimming apply everywhere.
    this.host.addEventListener(
      'paste',
      (e) => {
        const text = e.clipboardData && e.clipboardData.getData('text/plain');
        e.preventDefault();
        e.stopImmediatePropagation();
        if (text) this.paste(text);
      },
      true
    );
    this.updateHeader();
  }

  updateHeader() {
    this.dot.className = `state ${this.state}`;
    this.titleEl.textContent = this.title;
    this.titleEl.title = `${this.title}\n${PROTO_LABEL[this.opts.protocol] || ''} ${describeTarget(this.opts)}`;
    this.badges.replaceChildren(
      ...[
        h('span.badge', { title: 'Terminal ID (use it to refer to this pane when talking to Claude)' }, this.aiId),
        h('span.badge', PROTO_LABEL[this.opts.protocol] || '?'),
        this.logging ? h('span.badge.rec', { title: this.logFile || '' }, 'REC') : null,
        this.app.isBroadcasting && this.app.isBroadcasting(this) ? h('span.badge.bc', 'BC') : null,
      ].filter(Boolean)
    );
    this.sftpBtn.classList.toggle('hidden', !this.sftpAvailable);
    this.el.style.setProperty('--term-bg', this.theme().background);
    this.app.onPaneChanged && this.app.onPaneChanged(this);
  }

  theme() {
    return THEMES[this.opts.theme] || THEMES[settings.theme] || THEMES['Tor Dark'];
  }

  // ------------------------------------------------------------------ xterm

  termOptions() {
    const s = settings;
    return {
      fontFamily: s.fontFamily,
      fontSize: Math.max(6, (Number(this.opts.fontSize) || s.fontSize) + this.fontDelta),
      fontWeight: s.fontWeight,
      fontWeightBold: 'bold',
      lineHeight: Number(s.lineHeight) || 1,
      letterSpacing: Number(s.letterSpacing) || 0,
      cursorStyle: s.cursorStyle,
      cursorBlink: !!s.cursorBlink,
      cursorInactiveStyle: 'outline',
      scrollback: Number(s.scrollback) || 0,
      theme: this.theme(),
      wordSeparator: s.wordSeparator,
      drawBoldTextInBrightColors: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      altClickMovesCursor: true,
    };
  }

  createTerminal() {
    this.term = new Terminal({ ...this.termOptions(), allowProposedApi: true });
    this.fit = new FitAddon();
    this.search = new SearchAddon();
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.search.onDidChangeResults((r) => this.searchBar && this.onSearchResults && this.onSearchResults(r));
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.ctrlKey || e.metaKey) window.open(uri, '_blank', 'noopener');
        else toast('Ctrl+click to open link');
      })
    );

    this.term.attachCustomKeyEventHandler((e) => this.onKey(e));
    this.term.onData((d) => this.userInput(d));
    this.term.onBinary((d) => this.userInput(d));
    this.term.onResize(({ cols, rows }) => {
      this.send({ t: 'resize', cols, rows });
      this.app.onPaneChanged(this);
    });
    this.term.onTitleChange((t) => {
      this.remoteTitle = t;
      this.updateHeader();
    });
    this.term.onBell(() => {
      if (settings.bell === 'sound') beep();
      else if (settings.bell === 'visual') {
        this.el.classList.remove('bell');
        void this.el.offsetWidth;
        this.el.classList.add('bell');
      }
      if (this.app.activePane !== this) this.app.layout.flagTab(this);
    });
    const copySel = debounce(() => {
      if (settings.copyOnSelect && this.term.hasSelection()) copyText(this.term.getSelection());
    }, 200);
    this.term.onSelectionChange(copySel);
    this.term.onWriteParsed(() => this.scheduleHighlight());
    this.term.onScroll(() => this.scheduleHighlight());

    this.ro = new ResizeObserver(debounce(() => this.onHostResize(), 25));
    this.ro.observe(this.host);
  }

  onHostResize() {
    if (!this.host.offsetWidth || !this.host.offsetHeight) return;
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.host);
      this.term.textarea.addEventListener('focus', () => this.app.setActivePane(this));
      if (settings.webgl) {
        try {
          const gl = new WebglAddon();
          gl.onContextLoss(() => gl.dispose());
          this.term.loadAddon(gl);
        } catch {}
      }
      try {
        this.fit.fit();
      } catch {}
      if (this.app.activePane === this) this.term.focus();
      this.connect();
      return;
    }
    try {
      this.fit.fit();
    } catch {}
  }

  applySettings() {
    this.refreshOptions();
    const o = this.termOptions();
    for (const [k, v] of Object.entries(o)) this.term.options[k] = v;
    this.clearHighlights();
    this.scheduleHighlight();
    this.updateHeader();
    try {
      this.fit.fit();
    } catch {}
  }

  setFontDelta(d) {
    this.fontDelta = d;
    this.term.options.fontSize = this.termOptions().fontSize;
    try {
      this.fit.fit();
    } catch {}
  }

  focus() {
    if (this.opened) this.term.focus();
  }

  // ------------------------------------------------------------------ keys

  onKey(e) {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    if (this.app.handleShortcut(e, this)) {
      e.preventDefault();
      return false;
    }
    if (ctrl && e.shiftKey && k === 'c') {
      e.preventDefault();
      if (this.term.hasSelection()) copyText(this.term.getSelection());
      return false;
    }
    if (ctrl && e.shiftKey && k === 'v') {
      // Let the browser fire a native paste event (handled in our listener).
      return false;
    }
    if (ctrl && !e.shiftKey && !e.altKey && k === 'c' && settings.ctrlCCopy && this.term.hasSelection()) {
      e.preventDefault();
      copyText(this.term.getSelection());
      this.term.clearSelection();
      return false;
    }
    if (ctrl && !e.shiftKey && !e.altKey && k === 'v' && settings.ctrlVPaste) return false;
    return true;
  }

  // ------------------------------------------------------------------ input

  userInput(d) {
    if (this.app.isBroadcasting(this)) this.app.broadcastInput(this, d);
    this.sendInput(d);
  }

  /** Send keyboard-originated text: applies backspace mode, local echo, line editing. */
  sendInput(d) {
    if (this.state === 'closed' || this.state === 'error') {
      if (d === '\r') this.reconnect();
      else if (this.reconnectTimer && d === '\x1b') this.cancelReconnect();
      return;
    }
    if (this.state !== 'connected') return;
    if (this.opts.backspace === 'bs') d = d.replace(/\x7f/g, '\x08');
    if (this.lineEditActive()) return this.lineEdit(d);
    if (this.localEchoActive()) this.term.write(d.replace(/\r/g, '\r\n'));
    this.rawSend(d);
  }

  /** Send scripted text (buttons, logon scripts). The server expands ${username} / ${password}. */
  scriptSend(d) {
    if (this.state !== 'connected' || !d) return;
    if (this.opts.backspace === 'bs') d = d.replace(/\x7f/g, '\x08');
    if (this.localEchoActive()) this.term.write(d.replace(/\$\{password\}/g, '********').replace(/\r/g, '\r\n'));
    this.send({ t: 'i', d, subst: true });
    this.tx += d.length;
    this.lastInputAt = Date.now();
  }

  rawSend(d) {
    if (!d) return;
    this.send({ t: 'i', d });
    this.tx += d.length;
    this.lastInputAt = Date.now();
  }

  autoEcho() {
    if (this.opts.protocol === 'raw') return true;
    if (this.opts.protocol === 'telnet') return !this.remoteEcho;
    return false;
  }
  localEchoActive() {
    const m = this.opts.localEcho || 'auto';
    return m === 'on' || (m === 'auto' && this.autoEcho());
  }
  lineEditActive() {
    const m = this.opts.lineEdit || 'auto';
    return m === 'on' || (m === 'auto' && this.autoEcho());
  }

  lineEdit(d) {
    const echo = this.localEchoActive();
    const w = (s) => echo && this.term.write(s);
    for (let i = 0; i < d.length; i++) {
      const ch = d[i];
      if (ch === '\r' || ch === '\n') {
        if (ch === '\n' && d[i - 1] === '\r') continue;
        w('\r\n');
        this.rawSend(this.lineBuf + '\r');
        this.lineBuf = '';
      } else if (ch === '\x7f' || ch === '\x08') {
        if (this.lineBuf) {
          this.lineBuf = this.lineBuf.slice(0, -1);
          w('\b \b');
        }
      } else if (ch === '\x15') {
        w('\b \b'.repeat(this.lineBuf.length));
        this.lineBuf = '';
      } else if (ch === '\x17') {
        const m = this.lineBuf.match(/\S*\s*$/);
        const n = m ? m[0].length : 0;
        w('\b \b'.repeat(n));
        this.lineBuf = this.lineBuf.slice(0, this.lineBuf.length - n);
      } else if (ch === '\x1b') {
        break; // ignore cursor keys etc. in local line mode
      } else if (ch < ' ') {
        this.rawSend(ch);
        this.lineBuf = '';
      } else {
        this.lineBuf += ch;
        w(ch);
      }
    }
  }

  /** Send text with \p pauses and escape sequences already parsed. */
  async sendText(text, { escapes = true, lineDelay = 0 } = {}) {
    const chunks = escapes ? parseSendText(text) : [{ text }];
    for (const c of chunks) {
      if (c.pause) await sleep(c.pause);
      else if (lineDelay > 0 && /\r/.test(c.text)) {
        const parts = c.text.split(/(?<=\r)/);
        for (const p of parts) {
          this.scriptSend(p);
          await sleep(lineDelay);
        }
      } else this.scriptSend(c.text);
    }
  }

  async paste(text) {
    if (!text) return;
    if (settings.trimPaste) text = text.replace(/\s+$/, '');
    const lines = text.split(/\r\n|\r|\n/).length;
    if (settings.confirmMultilinePaste && lines > 1 && !this.term.modes.bracketedPasteMode) {
      const preview = text.length > 600 ? text.slice(0, 600) + '\n…' : text;
      if (!(await confirmDialog(`Paste ${lines} lines into "${this.title}"?\n\n${preview}`, { title: 'Multi-line paste', ok: 'Paste' }))) return;
    }
    this.term.paste(text);
    this.focus();
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  // ------------------------------------------------------------------ connection

  connect() {
    this.cancelReconnect(true);
    this.closeSocket();
    this.refreshOptions();
    this.userClosed = false;
    this.remoteEcho = this.opts.protocol !== 'raw';
    this.lineBuf = '';
    this.sftpAvailable = false;
    this.setState('connecting');
    this.term.write(`\x1b[90mConnecting to ${PROTO_LABEL[this.opts.protocol] || ''} ${describeTarget(this.opts)}…\x1b[0m\r\n`);
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.decoder = new TextDecoder();
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'connect', sessionId: this.spec.sessionId, overrides: this.spec.overrides || {}, cols: this.term.cols, rows: this.term.rows }));
    };
    ws.onmessage = (e) => {
      if (ws !== this.ws) return;
      if (typeof e.data === 'string') {
        let m;
        try {
          m = JSON.parse(e.data);
        } catch {
          return;
        }
        this.onControl(m);
      } else this.onOutput(new Uint8Array(e.data));
    };
    ws.onclose = () => {
      if (ws !== this.ws) return;
      if (this.state === 'connecting' || this.state === 'connected') this.onClosed('Lost connection to TorTerminal server', true);
    };
  }

  closeSocket() {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {}
    }
    this.stopTimers();
  }

  disconnect() {
    this.userClosed = true;
    this.cancelReconnect();
    if (this.state === 'connected' || this.state === 'connecting') {
      this.closeSocket();
      this.onClosed('Disconnected by user');
    }
  }

  reconnect() {
    this.term.write('\r\n');
    this.connect();
  }

  cancelReconnect(silent) {
    if (this.reconnectTimer) {
      clearInterval(this.reconnectTimer);
      this.reconnectTimer = null;
      if (!silent) this.term.write('\r\n\x1b[90mAuto reconnect cancelled. Press Enter to reconnect.\x1b[0m\r\n');
    }
  }

  setState(s) {
    this.state = s;
    this.updateHeader();
  }

  onOutput(u8) {
    this.rx += u8.length;
    this.lastOutputAt = Date.now();
    this.term.write(u8);
    if (this.logon) this.logonFeed(this.decoder.decode(u8, { stream: true }));
  }

  onControl(m) {
    switch (m.t) {
      case 'status':
        if (m.state === 'connected') {
          this.connId = m.connId;
          this.sftpAvailable = !!m.sftp;
          this.connectedAt = Date.now();
          this.lastInputAt = Date.now();
          this.reconnectAttempts = 0;
          this.setState('connected');
          this.startTimers();
          this.runLogonScript();
        } else if (m.state === 'connecting') this.setState('connecting');
        else this.onClosed(m.msg || (m.state === 'error' ? 'Connection failed' : 'Connection closed'), m.state === 'error');
        break;
      case 'info': {
        const color = m.level === 'error' ? '31' : m.level === 'warn' ? '33' : '90';
        this.term.write(`\x1b[${color}m${m.msg}\x1b[0m\r\n`);
        break;
      }
      case 'prompt':
        this.enqueueDialog(() => this.showPrompt(m));
        break;
      case 'hostkey':
        this.enqueueDialog(() => this.showHostKey(m));
        break;
      case 'echo':
        this.remoteEcho = !!m.remote;
        break;
      case 'log':
        this.logging = !!m.on;
        this.logFile = m.file;
        this.updateHeader();
        if (m.on) toast(`Logging to ${m.file}`, 'ok');
        break;
      case 'sftp': {
        const p = this.sftpPending.get(m.id);
        if (p) {
          this.sftpPending.delete(m.id);
          m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
        }
        break;
      }
    }
  }

  onClosed(msg, isError) {
    if (this.state === 'closed' || this.state === 'error') return;
    const wasConnected = this.state === 'connected';
    this.closeSocket();
    this.logging = false;
    this.sftpAvailable = false;
    this.logon = null;
    this.setState(isError ? 'error' : 'closed');
    for (const p of this.sftpPending.values()) p.reject(new Error('Connection closed'));
    this.sftpPending.clear();
    this.term.write(`\r\n\x1b[${isError ? '1;31m✖' : '33m●'} ${msg}\x1b[0m\r\n`);
    const attempts = (this.reconnectAttempts = (this.reconnectAttempts || 0) + (wasConnected ? 0 : 1));
    if (!this.userClosed && this.opts.autoReconnect && attempts < 20) {
      let left = Math.max(1, Number(settings.reconnectDelay) || 5) * Math.min(6, attempts || 1);
      this.term.write(`\x1b[90mReconnecting in ${left}s… (Enter = now, Esc = cancel)\x1b[0m`);
      this.reconnectTimer = setInterval(() => {
        left--;
        if (left <= 0) {
          clearInterval(this.reconnectTimer);
          this.reconnectTimer = null;
          this.reconnect();
        }
      }, 1000);
    } else {
      this.term.write('\x1b[90mPress Enter to reconnect.\x1b[0m\r\n');
    }
  }

  // ------------------------------------------------------------------ timers (anti-idle)

  startTimers() {
    this.stopTimers();
    const secs = Number(this.opts.antiIdleSeconds);
    if (secs > 0 && this.opts.antiIdleText) {
      this.antiIdleTimer = setInterval(() => {
        if (this.state === 'connected' && Date.now() - this.lastInputAt >= secs * 1000) {
          this.sendText(this.opts.antiIdleText);
          this.lastInputAt = Date.now();
        }
      }, 1000);
    }
  }

  stopTimers() {
    clearInterval(this.antiIdleTimer);
    this.antiIdleTimer = null;
  }

  // ------------------------------------------------------------------ logon script (expect / send)

  runLogonScript() {
    const steps = (this.opts.logonScript || []).filter((s) => s && (s.expect || s.send));
    if (!steps.length) return;
    this.logon = { steps, i: 0, buf: '', timer: null };
    this.advanceLogon();
  }

  logonFeed(text) {
    const L = this.logon;
    if (!L) return;
    L.buf = (L.buf + text.replace(ANSI_RE, '')).slice(-8000);
    this.advanceLogon();
  }

  advanceLogon() {
    const L = this.logon;
    while (L && this.logon === L && L.i < L.steps.length) {
      const st = L.steps[L.i];
      if (st.expect) {
        let end = -1;
        const rx = st.expect.match(/^\/(.+)\/([a-z]*)$/);
        if (rx) {
          try {
            const m = new RegExp(rx[1], rx[2].replace('g', '')).exec(L.buf);
            if (m) end = m.index + m[0].length;
          } catch {}
        } else {
          const idx = L.buf.indexOf(st.expect);
          if (idx >= 0) end = idx + st.expect.length;
        }
        if (end < 0) {
          if (!L.timer) {
            L.timer = setTimeout(() => {
              if (this.logon !== L) return;
              this.term.write(`\r\n\x1b[33m[Logon script: timed out waiting for "${st.expect}"]\x1b[0m\r\n`);
              this.logon = null;
            }, (Number(st.timeout) || 30) * 1000);
          }
          return;
        }
        L.buf = L.buf.slice(end);
      }
      clearTimeout(L.timer);
      L.timer = null;
      L.i++;
      this.sendText((st.send || '') + (st.noEnter ? '' : '\\r'));
    }
    if (this.logon === L) this.logon = null;
  }

  // ------------------------------------------------------------------ dialogs inside the pane

  enqueueDialog(fn) {
    this.dialogQueue = this.dialogQueue.then(fn, fn);
  }

  overlay(content) {
    const ov = h('div.pane-overlay', h('div.pane-dialog', content));
    this.el.append(ov);
    return ov;
  }

  showPrompt(m) {
    return new Promise((resolve) => {
      const inputs = (m.prompts || []).map((p) => h('input', { type: p.echo ? 'text' : 'password', autocomplete: 'off', spellcheck: 'false' }));
      const done = (val) => {
        ov.remove();
        this.send({ t: 'reply', id: m.id, value: val });
        this.focus();
        resolve();
      };
      const form = h(
        'form',
        { on: { submit: (e) => (e.preventDefault(), done(inputs.map((i) => i.value))) } },
        h('h3', m.title || 'Authentication'),
        m.instructions ? h('p', m.instructions) : null,
        (m.prompts || []).map((p, i) => [h('label', p.prompt), inputs[i]]),
        h('div.row-btns', h('button.btn', { type: 'button', on: { click: () => done(null) } }, 'Cancel'), h('button.btn.primary', { type: 'submit' }, 'OK'))
      );
      form.addEventListener('keydown', (e) => e.key === 'Escape' && done(null));
      const ov = this.overlay(form);
      setTimeout(() => inputs[0] && inputs[0].focus(), 20);
    });
  }

  showHostKey(m) {
    return new Promise((resolve) => {
      const done = (val) => {
        ov.remove();
        this.send({ t: 'reply', id: m.id, value: val });
        this.focus();
        resolve();
      };
      const changed = m.status === 'changed';
      const accept = h('button.btn.primary', { type: 'button', on: { click: () => done({ accept: true, save: true }) } }, changed ? 'Update key & connect' : 'Accept & save');
      const content = h(
        'div',
        h('h3', { class: changed ? 'warn' : '' }, changed ? '⚠ WARNING – HOST KEY HAS CHANGED' : 'Unknown host key'),
        h(
          'p',
          changed
            ? `The host key for ${m.host}:${m.port} does not match the cached key. This could mean someone is intercepting your connection (man-in-the-middle), or the server was reinstalled.`
            : `The authenticity of ${m.host}:${m.port} can't be established. The server's host key is not cached. Only continue if you trust this host.`
        ),
        changed ? h('div.fp', `Old: ${m.oldFingerprint}`) : null,
        h('div.fp', `${m.keyType}\n${m.fingerprint}\nMD5:${m.md5}`),
        h('div.row-btns', h('button.btn', { type: 'button', on: { click: () => done({ accept: false }) } }, 'Cancel'), h('button.btn', { type: 'button', on: { click: () => done({ accept: true, save: false }) } }, 'Connect once'), accept)
      );
      const ov = this.overlay(content);
      setTimeout(() => (changed ? content.querySelector('.btn').focus() : accept.focus()), 20);
    });
  }

  // ------------------------------------------------------------------ keyword highlighting

  scheduleHighlight() {
    if (this.hlTimer || !settings.highlightEnabled) return;
    this.hlTimer = setTimeout(() => {
      this.hlTimer = null;
      this.runHighlight();
    }, 40);
  }

  clearHighlights() {
    for (const d of this.hlDecos) {
      d.deco.dispose();
      d.marker.dispose();
    }
    this.hlDecos = [];
    if (this.hlMarker) this.hlMarker.dispose();
    this.hlMarker = null;
  }

  runHighlight() {
    const term = this.term;
    if (!this.opened) return;
    const rules = getHighlightRules();
    const buf = term.buffer.active;
    if (!rules.length || buf.type !== 'normal') return;
    const top = buf.baseY;
    const cursorAbs = buf.baseY + buf.cursorY;
    let start = this.hlMarker && !this.hlMarker.isDisposed && this.hlMarker.line >= 0 ? Math.min(this.hlMarker.line, top) : top;
    start = Math.max(start, top - 2000, 0);
    // Re-evaluate everything from `start` on, since visible lines may still change.
    this.hlDecos = this.hlDecos.filter((d) => {
      if (d.marker.isDisposed) return false;
      if (d.marker.line >= start) {
        d.deco.dispose();
        d.marker.dispose();
        return false;
      }
      return true;
    });
    const end = Math.min(buf.length - 1, top + term.rows - 1);
    for (let y = start; y <= end; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      const text = line.translateToString(true);
      if (!text.trim()) continue;
      for (const r of rules) {
        r.re.lastIndex = 0;
        let m;
        let guard = 0;
        while ((m = r.re.exec(text)) && guard++ < 50) {
          if (!m[0].length) {
            r.re.lastIndex++;
            continue;
          }
          const marker = term.registerMarker(y - cursorAbs);
          if (!marker) continue;
          const deco = term.registerDecoration({ marker, x: m.index, width: m[0].length, foregroundColor: r.fg, backgroundColor: r.bg, layer: 'top' });
          if (deco) this.hlDecos.push({ marker, deco });
          else marker.dispose();
        }
      }
    }
    if (this.hlMarker) this.hlMarker.dispose();
    this.hlMarker = term.registerMarker(top - cursorAbs);
  }

  // ------------------------------------------------------------------ search

  toggleSearch(show = !this.searchBar) {
    if (!show) {
      if (this.searchBar) this.searchBar.remove();
      this.searchBar = null;
      this.search.clearDecorations();
      this.focus();
      return;
    }
    if (this.searchBar) return this.searchBar.querySelector('input').select();
    const opts = { regex: false, caseSensitive: false, wholeWord: false };
    const input = h('input', { type: 'text', placeholder: 'Find', spellcheck: 'false' });
    const count = h('span.count');
    const deco = { matchBackground: '#6b5b00', matchOverviewRuler: '#e0af68', activeMatchBackground: '#ff9e3b', activeMatchColorOverviewRuler: '#ff9e3b' };
    const run = (dir = 1, incremental = false) => {
      const so = { ...opts, incremental, decorations: deco };
      if (!input.value) {
        this.search.clearDecorations();
        count.textContent = '';
        return;
      }
      dir > 0 ? this.search.findNext(input.value, so) : this.search.findPrevious(input.value, so);
    };
    this.onSearchResults = ({ resultIndex, resultCount }) => {
      count.textContent = resultCount ? `${resultIndex + 1}/${resultCount}` : 'No results';
    };
    const toggle = (key, label, title) => {
      const b = h('button.toggle', { type: 'button', title }, label);
      b.addEventListener('click', () => {
        opts[key] = !opts[key];
        b.classList.toggle('on', opts[key]);
        run(1, true);
      });
      return b;
    };
    input.addEventListener('input', () => run(1, true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') run(e.shiftKey ? -1 : 1);
      else if (e.key === 'Escape') this.toggleSearch(false);
    });
    this.searchBar = h(
      'div.search-bar',
      input,
      toggle('caseSensitive', 'Aa', 'Match case'),
      toggle('wholeWord', 'ab', 'Whole word'),
      toggle('regex', '.*', 'Regular expression'),
      count,
      h('button.icon-btn', { title: 'Previous (Shift+Enter)', html: icon('up'), on: { click: () => run(-1) } }),
      h('button.icon-btn', { title: 'Next (Enter)', html: icon('chevDown'), on: { click: () => run(1) } }),
      h('button.icon-btn', { title: 'Close (Esc)', html: icon('x'), on: { click: () => this.toggleSearch(false) } })
    );
    this.el.append(this.searchBar);
    const sel = this.term.getSelection();
    if (sel && !sel.includes('\n')) input.value = sel;
    setTimeout(() => input.select(), 10);
  }

  // ------------------------------------------------------------------ misc actions

  async rename() {
    const t = await promptDialog('Pane title (empty = automatic):', this.customTitle || this.title, { title: 'Rename pane' });
    if (t === null) return;
    this.customTitle = t.trim();
    this.updateHeader();
  }

  /** Plain text of buffer lines [start, end), joining soft-wrapped lines. */
  linesText(start, end) {
    const buf = this.term.buffer.active;
    const lines = [];
    for (let i = Math.max(0, start); i < Math.min(end, buf.length); i++) {
      const l = buf.getLine(i);
      if (!l) continue;
      if (l.isWrapped && lines.length) lines[lines.length - 1] += l.translateToString(true);
      else lines.push(l.translateToString(true));
    }
    return lines.join('\n').replace(/\s+$/, '');
  }

  /** The last `n` lines, or the whole screen when a full-screen program is running. */
  tailText(n = 100) {
    const buf = this.term.buffer.active;
    if (buf.type === 'alternate') return this.linesText(buf.baseY, buf.length);
    return this.linesText(buf.length - n, buf.length);
  }

  /**
   * Type a command + Enter and collect the output until the shell prompt comes
   * back, the output stays quiet for a long time, or the timeout passes.
   */
  async runCapture(command, timeoutSec = 30) {
    if (this.state !== 'connected') throw new Error(`${this.aiId} is not connected (${this.state})`);
    const PROMPT_RE = /[$#>%]\s*$/;
    const buf = () => this.term.buffer.active;
    const marker = this.term.registerMarker(0);
    const t0 = Date.now();
    const limit = Math.min(600, Math.max(1, Number(timeoutSec) || 30)) * 1000;
    this.sendInput(command.replace(/\r?\n/g, '\r') + '\r');
    let status = 'timeout';
    while (Date.now() - t0 < limit) {
      await sleep(200);
      if (this.state !== 'connected') {
        status = 'disconnected';
        break;
      }
      const quietFor = Date.now() - Math.max(this.lastOutputAt, t0);
      const b = buf();
      const cursorLine = b.baseY + b.cursorY;
      const moved = marker.isDisposed || cursorLine > marker.line;
      const current = b.getLine(cursorLine);
      const promptBack = moved && current && PROMPT_RE.test(current.translateToString(true));
      if (promptBack && quietFor > 500) {
        status = 'done';
        break;
      }
      if (quietFor > 8000) {
        status = 'quiet';
        break;
      }
    }
    let out;
    if (buf().type === 'alternate') out = this.tailText();
    else out = this.linesText(marker.isDisposed ? buf().length - 300 : marker.line, buf().length);
    marker.dispose();
    const MAX = 16000;
    if (out.length > MAX) out = `[… ${out.length - MAX} earlier characters omitted …]\n` + out.slice(-MAX);
    return { output: out, status, seconds: Math.round((Date.now() - t0) / 100) / 10 };
  }

  bufferText() {
    return this.linesText(0, this.term.buffer.active.length) + '\n';
  }

  saveOutput() {
    const d = new Date();
    const name = `${(this.title || 'terminal').replace(/[^\w.@-]+/g, '_')}_${d.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    downloadText(name, this.bufferText());
  }

  toggleLogging() {
    if (this.state !== 'connected') return toast('Not connected', 'error');
    this.send({ t: 'log', on: !this.logging, mode: this.opts.logMode, timestamps: this.opts.logTimestamps });
  }

  special(cmd) {
    this.send({ t: 'special', cmd });
  }

  sftp(op, args = {}) {
    return new Promise((resolve, reject) => {
      if (this.state !== 'connected' || !this.ws) return reject(new Error('Not connected'));
      const id = uid();
      this.sftpPending.set(id, { resolve, reject });
      this.send({ t: 'sftp', id, op, ...args });
      setTimeout(() => {
        if (this.sftpPending.has(id)) {
          this.sftpPending.delete(id);
          reject(new Error('SFTP request timed out'));
        }
      }, 60000);
    });
  }

  specialItems() {
    const p = this.opts.protocol;
    const it = (label, cmd) => ({ label, action: () => this.special(cmd) });
    if (p === 'telnet')
      return [it('Break', 'break'), it('Are You There', 'ayt'), it('Interrupt Process', 'ip'), it('Abort Output', 'ao'), it('Erase Character', 'ec'), it('Erase Line', 'el'), it('Go Ahead', 'ga'), it('No Operation', 'nop'), it('End Of File', 'eof'), it('Suspend', 'susp'), it('Abort Process', 'abort')];
    if (p === 'serial') return [it('Break (300 ms)', 'break'), it('Pulse DTR', 'dtr'), it('Pulse RTS', 'rts')];
    if (p === 'ssh') return [it('Signal INT', 'int'), it('Signal TERM', 'term'), it('Signal HUP', 'hup'), it('Signal QUIT', 'quit'), it('Signal KILL', 'kill')];
    return [];
  }

  onContextMenu(e) {
    if (!this.host.contains(e.target)) return;
    e.preventDefault();
    if (!e.shiftKey && settings.rightClick !== 'menu') {
      if (settings.rightClick === 'copyPaste' && this.term.hasSelection()) {
        copyText(this.term.getSelection());
        this.term.clearSelection();
      } else readClipboard().then((t) => t && this.paste(t));
      return;
    }
    this.showMenu(e.clientX, e.clientY);
  }

  showMenu(x, y) {
    const app = this.app;
    const connected = this.state === 'connected';
    const specials = this.specialItems();
    const items = [
      { label: 'Copy', icon: 'copy', kb: 'Ctrl+Shift+C', disabled: !this.term.hasSelection(), action: () => copyText(this.term.getSelection()) },
      { label: 'Paste', icon: 'paste', kb: 'Ctrl+Shift+V', action: () => readClipboard().then((t) => t && this.paste(t)) },
      { label: 'Select all', action: () => this.term.selectAll() },
      { label: 'Find…', icon: 'search', kb: 'Ctrl+Shift+F', action: () => this.toggleSearch(true) },
      {
        label: this.term.hasSelection() ? 'Ask Claude about selection' : 'Ask Claude about this terminal',
        icon: 'sparkles',
        action: () => app.assistant.askAbout(this, this.term.hasSelection() ? this.term.getSelection() : ''),
      },
      '-',
      { label: 'Split right', icon: 'splitV', kb: 'Alt+Shift+D', action: () => app.splitPane(this, 'row') },
      { label: 'Split down', icon: 'splitH', kb: 'Alt+Shift+E', action: () => app.splitPane(this, 'col') },
      { label: 'Duplicate in new tab', icon: 'copy', action: () => app.openInNewTab(this.spec) },
      { label: 'Move to new tab', action: () => app.layout.movePaneToNewTab(this) },
      { label: app.layout.isZoomed(this) ? 'Restore size' : 'Maximize pane', icon: 'maximize', kb: 'Alt+Shift+Enter', action: () => app.layout.toggleZoom(this) },
      '-',
      connected
        ? { label: 'Disconnect', icon: 'power', action: () => this.disconnect() }
        : { label: 'Reconnect', icon: 'refresh', kb: 'Alt+Shift+R', action: () => this.reconnect() },
      connected ? { label: 'Reconnect', icon: 'refresh', kb: 'Alt+Shift+R', action: () => (this.disconnect(), this.reconnect()) } : null,
      { label: this.logging ? 'Stop logging' : 'Start logging', icon: 'record', disabled: !connected, action: () => this.toggleLogging() },
      specials.length ? { label: 'Send special', icon: 'zap', disabled: !connected, submenu: specials } : null,
      this.sftpAvailable ? { label: 'SFTP browser', icon: 'folderOpen', action: () => app.openSftp(this) } : null,
      '-',
      { label: 'Clear scrollback', icon: 'eraser', kb: 'Ctrl+Shift+K', action: () => this.term.clear() },
      { label: 'Reset terminal', action: () => this.term.reset() },
      { label: 'Save output to file…', icon: 'save', action: () => this.saveOutput() },
      { label: 'Rename pane…', icon: 'edit', action: () => this.rename() },
      {
        label: 'Font size',
        icon: 'type',
        submenu: [
          { label: 'Bigger', kb: 'Ctrl+=', action: () => this.setFontDelta(this.fontDelta + 1) },
          { label: 'Smaller', kb: 'Ctrl+-', action: () => this.setFontDelta(this.fontDelta - 1) },
          { label: 'Reset', kb: 'Ctrl+0', action: () => this.setFontDelta(0) },
        ],
      },
      this.spec.sessionId
        ? { label: 'Edit session…', icon: 'settings', action: () => app.sessionsUI.edit(this.spec.sessionId) }
        : { label: 'Save as session…', icon: 'star', action: () => app.sessionsUI.edit(null, { ...this.spec.overrides }) },
      '-',
      { label: 'Close pane', icon: 'x', danger: true, kb: 'Alt+Shift+W', action: () => app.closePane(this) },
    ];
    contextMenu(x, y, items);
  }

  dispose() {
    this.userClosed = true;
    this.cancelReconnect();
    this.closeSocket();
    clearTimeout(this.hlTimer);
    this.ro.disconnect();
    this.term.dispose();
    this.el.remove();
  }
}
TerminalPane.counter = 0;
