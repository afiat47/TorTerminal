// Claude side panel: chat with Claude, which can read and operate the terminal panes.
// The agent loop runs on the server; terminal tools run here, behind user approval.

import { api, h, icon, esc, toast, confirmDialog, contextMenu, copyText, parseSendText, sleep, store } from './util.js';
import { describeTarget } from './terminal-pane.js';

const SUGGESTIONS = [
  'What is using the most disk space here?',
  'Check the health of this server (CPU, memory, disk, failed services).',
  'Explain the last error on screen and how to fix it.',
  'Show the 20 most recent lines of the system log.',
];

// ---------------------------------------------------------------------------
// Minimal, escape-first Markdown renderer (code blocks, inline code, bold, lists, headings)
// ---------------------------------------------------------------------------

function inline(s) {
  return esc(s)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
}

function renderBlocks(text) {
  const out = [];
  let list = null;
  const closeList = () => {
    if (list) out.push(`</${list}>`);
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if ((m = line.match(/^\s*[-*]\s+(.*)$/))) {
      if (list !== 'ul') closeList(), out.push('<ul>'), (list = 'ul');
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      if (list !== 'ol') closeList(), out.push('<ol>'), (list = 'ol');
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^#{1,4}\s+(.*)$/))) {
      closeList();
      out.push(`<div class="ai-h">${inline(m[1])}</div>`);
    } else if (!line.trim()) {
      closeList();
      out.push('<div class="ai-gap"></div>');
    } else {
      closeList();
      out.push(`<div>${inline(line)}</div>`);
    }
  }
  closeList();
  return out.join('');
}

export function renderMarkdown(text) {
  const parts = [];
  const re = /```([\w+-]*)[^\n]*\n?([\s\S]*?)(?:```|$)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(renderBlocks(text.slice(last, m.index)));
    const code = m[2].replace(/\n$/, '');
    parts.push(
      `<div class="ai-code"><div class="ai-code-bar"><span>${esc(m[1] || 'code')}</span>` +
        `<button class="icon-btn" data-act="insert" title="Paste into the active terminal (without Enter)">${icon('terminal')}</button>` +
        `<button class="icon-btn" data-act="copy" title="Copy">${icon('copy')}</button></div><pre><code>${esc(code)}</code></pre></div>`
    );
    last = re.lastIndex;
    if (m[0].length === 0) re.lastIndex++;
  }
  if (last < text.length) parts.push(renderBlocks(text.slice(last)));
  return parts.join('');
}

// ---------------------------------------------------------------------------

export class AssistantPanel {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('ai-panel');
    this.status = null;
    this.busy = false;
    this.cards = new Map();
    this.cur = null; // the assistant/thinking item currently streaming
    this.build();
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  toggle() {
    this.visible ? this.close() : this.open();
  }

  open() {
    this.el.classList.remove('hidden');
    document.querySelector('[data-action="toggleAssistant"]').classList.add('active');
    store.set('aiOpen', true);
    if (!this.ws) this.connect();
    this.updateContextLine();
    setTimeout(() => (this.status && this.status.connected ? this.input : this.keyInput).focus(), 30);
  }

  close() {
    this.el.classList.add('hidden');
    document.querySelector('[data-action="toggleAssistant"]').classList.remove('active');
    store.set('aiOpen', false);
    this.app.activePane && this.app.activePane.focus();
  }

  // ------------------------------------------------------------------ DOM

  build() {
    this.dot = h('span.ai-dot');
    this.modelSel = h('select.ai-model', { title: 'Model' });
    this.modelSel.addEventListener('change', () => this.saveConfig({ model: this.modelSel.value }));
    const btn = (ic, title, fn) => h('button.icon-btn', { title, html: icon(ic), on: { click: fn } });
    this.head = h(
      'div.ai-head',
      h('span.ai-title', { html: `${icon('sparkles')}<span>Claude</span>` }),
      this.dot,
      this.modelSel,
      h('span.ai-spacer'),
      btn('plus', 'New chat', () => this.newChat()),
      btn('settings', 'Assistant settings', (e) => this.menu(e)),
      btn('x', 'Close (Alt+Shift+A)', () => this.close())
    );

    // Connect screen: Claude Code login (like the VS Code extension) or an API key.
    this.ccError = h('div.ai-err');
    this.ccButton = h('button.btn.primary', { type: 'button', on: { click: () => this.useClaudeCode() } }, 'Use my Claude Code login');
    this.keyInput = h('input', { type: 'password', placeholder: 'sk-ant-…', autocomplete: 'off', spellcheck: 'false' });
    this.keyError = h('div.ai-err');
    const connectBtn = h('button.btn', { type: 'submit' }, 'Connect with API key');
    this.connectView = h(
      'div.ai-connect',
      h('div.ai-connect-icon', { html: icon('sparkles') }),
      h('h3', 'Connect to Claude'),
      h('div.ai-option',
        h('b', 'Claude Code login'),
        h('p', 'Uses the account you are signed in to in Claude Code, the same way the Claude Code extension in VS Code does. No API key needed; usage counts toward your Claude plan.'),
        this.ccButton,
        this.ccError),
      h('div.ai-or', 'or'),
      h('form.ai-option',
        { on: { submit: (e) => (e.preventDefault(), this.connectKey(connectBtn)) } },
        h('b', 'Anthropic API key'),
        h('p', 'Billed per use to the key\'s account. Stored encrypted on this server and never sent back to the browser. Create one at ', h('a', { href: 'https://console.anthropic.com/settings/keys', target: '_blank', rel: 'noopener' }, 'console.anthropic.com'), '.'),
        this.keyInput,
        connectBtn,
        this.keyError),
      h('button.btn.sm', { type: 'button', on: { click: () => this.refreshStatus(true) } }, 'Check again')
    );

    // Chat
    this.list = h('div.ai-list');
    this.list.addEventListener('click', (e) => this.onListClick(e));
    this.input = h('textarea.ai-input', { rows: 3, placeholder: 'Ask Claude… (Enter to send, Shift+Enter for a new line)', spellcheck: 'false' });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        this.submit();
      } else if (e.key === 'Escape') this.app.activePane && this.app.activePane.focus();
    });
    this.sendBtn = h('button.btn.primary.sm', { type: 'button', on: { click: () => (this.busy ? this.stop() : this.submit()) } }, 'Send');
    this.ctxLine = h('div.ai-ctx');
    this.autoChip = h('button.ai-chip', { type: 'button', on: { click: () => this.toggleAutoRun() } });
    this.chatView = h(
      'div.ai-chat',
      this.list,
      h('div.ai-compose', this.input, h('div.ai-compose-bar', this.ctxLine, this.autoChip, this.sendBtn))
    );
    this.el.append(this.head, this.connectView, this.chatView);
    this.renderStatus();
  }

  renderStatus() {
    const s = this.status;
    const connected = !!(s && s.connected);
    this.dot.className = 'ai-dot ' + (s ? (connected ? 'on' : 'off') : '');
    this.dot.title = s
      ? connected
        ? `Connected via ${s.source}${s.account ? ` (${s.account}${s.plan ? ', ' + s.plan : ''})` : ''}${s.keyHint ? ' ' + s.keyHint : ''}`
        : s.error || 'Not connected'
      : 'Checking…';
    this.connectView.classList.toggle('hidden', connected || !s);
    this.chatView.classList.toggle('hidden', !connected);
    this.ccError.textContent = s && !connected && s.provider === 'claude-code' ? s.error || '' : '';
    if (s && !connected && s.provider === 'api' && s.error && s.hasSavedKey) this.keyError.textContent = s.error;
    if (s) {
      this.modelSel.replaceChildren(...s.models.map((m) => h('option', { value: m.id, selected: m.id === s.model }, m.name)));
      this.autoChip.textContent = s.autoRun ? '⚡ Auto-run on' : '✋ Ask before running';
      this.autoChip.classList.toggle('danger', !!s.autoRun);
      this.autoChip.title = s.autoRun ? 'Claude runs commands without asking. Click to require approval.' : 'You approve every command Claude wants to run. Click to allow auto-run.';
    }
  }

  async refreshStatus(force) {
    try {
      this.status = await api('/ai/status' + (force ? '?refresh=1' : ''));
    } catch (e) {
      this.status = { connected: false, error: e.message, models: [], efforts: [] };
    }
    this.renderStatus();
  }

  async connectKey(button) {
    this.keyError.textContent = '';
    button.disabled = true;
    button.textContent = 'Checking…';
    try {
      this.status = await api('/ai/key', { method: 'POST', body: { apiKey: this.keyInput.value } });
      this.keyInput.value = '';
      this.renderStatus();
      toast('Connected to Claude', 'ok');
      this.input.focus();
    } catch (e) {
      this.keyError.textContent = e.message;
    } finally {
      button.disabled = false;
      button.textContent = 'Connect';
    }
  }

  async useClaudeCode() {
    this.ccError.textContent = '';
    this.ccButton.disabled = true;
    this.ccButton.textContent = 'Starting Claude Code…';
    await this.saveConfig({ provider: 'claude-code' });
    this.ccButton.disabled = false;
    this.ccButton.textContent = 'Use my Claude Code login';
    if (this.status && this.status.connected) {
      toast(`Connected with your Claude Code login${this.status.plan ? ' (' + this.status.plan + ')' : ''}`, 'ok');
      this.input.focus();
    }
  }

  async saveConfig(patch) {
    try {
      this.status = await api('/ai/config', { method: 'PUT', body: patch });
      this.renderStatus();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async toggleAutoRun() {
    const on = !(this.status && this.status.autoRun);
    if (on && !(await confirmDialog('Let Claude run commands and keystrokes in your terminals without asking first?\n\nClaude is instructed to ask in chat before anything destructive, but commands will no longer wait for your approval.', { title: 'Enable auto-run', ok: 'Enable auto-run', danger: true }))) return;
    this.saveConfig({ autoRun: on });
  }

  menu(e) {
    const s = this.status || { efforts: [] };
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left - 160, r.bottom + 4, [
      { label: 'New chat', icon: 'plus', action: () => this.newChat() },
      {
        label: 'Connection',
        icon: 'plug',
        submenu: [
          { label: (s.provider === 'claude-code' ? '✓ ' : '   ') + 'Claude Code login', action: () => this.useClaudeCode() },
          { label: (s.provider === 'api' ? '✓ ' : '   ') + 'Anthropic API key', action: () => this.saveConfig({ provider: 'api' }) },
        ],
      },
      { label: 'Effort', submenu: (s.efforts || []).map((x) => ({ label: (x === s.effort ? '✓ ' : '   ') + x, action: () => this.saveConfig({ effort: x }) })) },
      { label: s.autoRun ? 'Require approval for commands' : 'Auto-run commands…', icon: 'zap', action: () => this.toggleAutoRun() },
      '-',
      { label: 'Check connection', icon: 'refresh', action: () => this.refreshStatus(true) },
      s.provider === 'api' && s.keyHint ? { label: `Remove saved API key ${s.keyHint}`, icon: 'power', danger: true, action: () => this.disconnectKey() } : null,
    ]);
  }

  async disconnectKey() {
    if (!(await confirmDialog('Remove the saved Anthropic API key from this server?', { danger: true, ok: 'Remove key' }))) return;
    this.status = await api('/ai/key', { method: 'DELETE' });
    this.renderStatus();
  }

  // ------------------------------------------------------------------ socket

  connect() {
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ai`);
    this.ws = ws;
    ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', conversationId: store.get('aiConversation', null) }));
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.setBusy(false);
      setTimeout(() => this.visible && !this.ws && this.connect(), 2000);
    };
  }

  send(obj) {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    else toast('Not connected to the TorTerminal server', 'error');
  }

  onMessage(m) {
    switch (m.t) {
      case 'hello':
        store.set('aiConversation', m.conversationId);
        this.status = m.status;
        this.renderStatus();
        this.renderTranscript(m.transcript);
        this.setBusy(m.busy);
        break;
      case 'busy':
        this.setBusy(m.busy);
        if (!m.busy) this.cur = null;
        break;
      case 'block':
        if (m.kind === 'text') this.cur = this.addItem({ kind: 'assistant', text: '' });
        else if (m.kind === 'thinking') this.cur = this.addItem({ kind: 'thinking', text: '' });
        else this.cur = null;
        break;
      case 'delta':
        if (!this.cur || this.cur.kind !== 'assistant') this.cur = this.addItem({ kind: 'assistant', text: '' });
        this.cur.text += m.text;
        this.renderSoon(this.cur);
        break;
      case 'thinking':
        if (!this.cur || this.cur.kind !== 'thinking') this.cur = this.addItem({ kind: 'thinking', text: '' });
        this.cur.text += m.text;
        this.renderSoon(this.cur);
        break;
      case 'toolCall':
        this.cur = null;
        this.runTool(m);
        break;
      case 'toolDone': {
        const card = this.cards.get(m.id);
        if (card && !card.done) card.finish(m.content, m.isError);
        break;
      }
      case 'turn':
        this.lastUsage = m.usage;
        this.updateContextLine();
        break;
      case 'notice':
        this.addItem({ kind: 'notice', text: m.msg, level: m.level });
        break;
      case 'error':
        this.addItem({ kind: 'notice', text: m.msg, level: 'error' });
        if (/api key|not connected/i.test(m.msg)) this.refreshStatus(true);
        break;
    }
  }

  setBusy(b) {
    this.busy = !!b;
    this.sendBtn.textContent = this.busy ? 'Stop' : 'Send';
    this.sendBtn.classList.toggle('danger', this.busy);
    this.el.classList.toggle('busy', this.busy);
  }

  newChat() {
    if (this.busy) this.stop();
    this.cards.clear();
    this.send({ t: 'reset' });
    this.input.focus();
  }

  stop() {
    this.send({ t: 'stop' });
    for (const c of this.cards.values()) if (c.pending) c.cancel();
  }

  // ------------------------------------------------------------------ chat

  terminalContext() {
    const panes = this.app.layout.allPanes();
    if (!panes.length) return 'No terminals are open.';
    return panes
      .map((p) => {
        const tab = this.app.layout.locate(p);
        return `${p.aiId} "${p.title}" ${(p.opts.protocol || '').toUpperCase()} ${describeTarget(p.opts)} - ${p.state}${p === this.app.activePane ? ' (active)' : ''}${tab ? ` [tab: ${this.app.layout.tabTitle(tab.tab)}]` : ''}`;
      })
      .join('\n');
  }

  updateContextLine() {
    const p = this.app.activePane;
    const u = this.lastUsage;
    this.ctxLine.textContent = `${p ? `Active: ${p.aiId} ${p.title}` : 'No active terminal'}${u ? ` · last turn ${fmtTokens(u.input)} in / ${fmtTokens(u.output)} out` : ''}`;
  }

  submit(text = this.input.value) {
    text = text.trim();
    if (!text || this.busy) return;
    this.addItem({ kind: 'user', text });
    this.send({ t: 'chat', text, context: this.terminalContext() });
    this.input.value = '';
  }

  /** Used by the terminal context menu. */
  askAbout(pane, selection) {
    this.open();
    const body = selection || pane.tailText(60);
    this.input.value = `In ${pane.aiId} (${pane.title}):\n\`\`\`\n${body.slice(-6000)}\n\`\`\`\n`;
    this.input.focus();
    this.input.setSelectionRange(this.input.value.length, this.input.value.length);
  }

  // ------------------------------------------------------------------ rendering

  renderTranscript(items) {
    this.list.replaceChildren();
    this.cards.clear();
    this.cur = null;
    if (!items.length) return this.renderEmpty();
    for (const it of items) {
      if (it.kind === 'tool') this.addToolCard(it, true);
      else this.addItem(it);
    }
  }

  renderEmpty() {
    this.list.append(
      h('div.ai-empty',
        h('div.ai-connect-icon', { html: icon('sparkles') }),
        h('p', 'Ask about your servers. Claude can read your terminals and run commands, with your approval.'),
        h('div.ai-suggest', SUGGESTIONS.map((s) => h('button.ai-chip', { type: 'button', on: { click: () => this.submit(s) } }, s))))
    );
  }

  nearBottom() {
    return this.list.scrollHeight - this.list.scrollTop - this.list.clientHeight < 80;
  }

  scroll(force) {
    if (force || this.stick) this.list.scrollTop = this.list.scrollHeight;
  }

  addItem(it) {
    const empty = this.list.querySelector('.ai-empty');
    if (empty) empty.remove();
    this.stick = this.nearBottom();
    let el;
    if (it.kind === 'user') el = h('div.ai-msg.user', it.text);
    else if (it.kind === 'assistant') el = h('div.ai-msg.assistant');
    else if (it.kind === 'thinking') el = h('details.ai-thinking', h('summary', 'Thinking'), h('div.ai-thinking-body'));
    else el = h(`div.ai-notice${it.level === 'error' ? '.error' : ''}`, it.text);
    const item = { ...it, el };
    this.list.append(el);
    if (it.text && (it.kind === 'assistant' || it.kind === 'thinking')) this.renderItem(item);
    this.scroll(it.kind === 'user');
    return item;
  }

  renderSoon(item) {
    if (item.raf) return;
    item.raf = requestAnimationFrame(() => {
      item.raf = null;
      this.stick = this.nearBottom();
      this.renderItem(item);
      this.scroll();
    });
  }

  renderItem(item) {
    if (item.kind === 'assistant') item.el.innerHTML = renderMarkdown(item.text);
    else if (item.kind === 'thinking') item.el.querySelector('.ai-thinking-body').textContent = item.text;
  }

  onListClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const code = b.closest('.ai-code').querySelector('code').textContent;
    if (b.dataset.act === 'copy') copyText(code).then(() => toast('Copied', 'ok'));
    else if (b.dataset.act === 'insert') {
      const p = this.app.activePane;
      if (!p || p.state !== 'connected') return toast('No connected active terminal', 'error');
      p.paste(code);
    }
  }

  // ------------------------------------------------------------------ tools

  pane(id) {
    return this.app.layout.allPanes().find((p) => p.aiId.toLowerCase() === String(id || '').trim().toLowerCase());
  }

  describeCall(m) {
    const p = this.pane(m.input.terminal_id);
    const where = p ? `${p.aiId} · ${p.title}` : m.input.terminal_id || '';
    switch (m.name) {
      case 'run_command':
        return { label: 'Run command', where, editable: m.input.command };
      case 'send_keys':
        return { label: 'Send keys', where, editable: m.input.keys };
      case 'read_terminal':
        return { label: 'Read terminal', where };
      case 'list_terminals':
        return { label: 'List terminals', where: '' };
      case 'open_session':
        return { label: 'Open session', where: `${m.input.name}${m.input.placement ? ' · ' + m.input.placement.replace('_', ' ') : ''}` };
      default:
        return { label: m.name, where };
    }
  }

  /** Card for a tool call. `restored` = rebuilt from history (already finished). */
  addToolCard(m, restored = false) {
    const empty = this.list.querySelector('.ai-empty');
    if (empty) empty.remove();
    this.stick = this.nearBottom();
    const d = this.describeCall(m);
    const state = h('span.ai-tool-state');
    const out = h('pre.ai-tool-out.hidden');
    const outToggle = h('button.ai-link.hidden', { type: 'button' }, 'Show output');
    outToggle.addEventListener('click', () => {
      out.classList.toggle('hidden');
      outToggle.textContent = out.classList.contains('hidden') ? 'Show output' : 'Hide output';
    });
    const cmdEl = d.editable != null ? h('textarea.ai-tool-cmd', { rows: Math.min(6, String(d.editable).split('\n').length), spellcheck: 'false', readOnly: true }, d.editable) : null;
    const actions = h('div.ai-tool-actions');
    const el = h('div.ai-tool', h('div.ai-tool-head', h('span', { html: icon(m.name === 'run_command' ? 'terminal' : m.name === 'open_session' ? 'plug' : m.name === 'send_keys' ? 'keyboard' : 'search') }), h('b', d.label), h('span.ai-tool-where', d.where), state), cmdEl, actions, outToggle, out);
    this.list.append(el);
    this.scroll();
    const card = {
      el,
      pending: false,
      done: false,
      setState(text, cls = '') {
        state.textContent = text;
        state.className = 'ai-tool-state ' + cls;
      },
      finish(content, isError) {
        this.done = true;
        this.pending = false;
        actions.replaceChildren();
        if (cmdEl) cmdEl.readOnly = true;
        if (/declined|skipped/i.test(content || '') && !isError) this.setState('skipped', 'muted');
        else this.setState(isError ? 'failed' : 'done', isError ? 'err' : 'ok');
        if (content) {
          out.textContent = content;
          outToggle.classList.remove('hidden');
          if (isError) out.classList.remove('hidden'), (outToggle.textContent = 'Hide output');
        }
      },
      cancel() {
        if (this.resolve) this.resolve(null);
      },
      /** Ask the user. Resolves with the (possibly edited) text, or null when declined. */
      ask(target) {
        this.pending = true;
        this.setState('waiting for you', 'warn');
        if (cmdEl) {
          cmdEl.readOnly = false;
          cmdEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey) && m.name !== 'send_keys') {
              e.preventDefault();
              runBtn.click();
            }
          });
        }
        const runBtn = h('button.btn.primary.sm', { type: 'button' }, m.name === 'open_session' ? 'Open' : m.name === 'send_keys' ? 'Send' : 'Run');
        const skipBtn = h('button.btn.sm', { type: 'button' }, 'Skip');
        actions.replaceChildren(runBtn, skipBtn);
        if (target) {
          target.el.classList.add('ai-target');
          setTimeout(() => target.el.classList.remove('ai-target'), 2500);
        }
        setTimeout(() => (cmdEl || runBtn).focus(), 30);
        return new Promise((resolve) => {
          this.resolve = (v) => {
            this.resolve = null;
            this.pending = false;
            actions.replaceChildren();
            resolve(v);
          };
          runBtn.addEventListener('click', () => this.resolve(cmdEl ? cmdEl.value : ''));
          skipBtn.addEventListener('click', () => this.resolve(null));
        });
      },
    };
    if (restored) {
      if (m.done) card.finish(m.result, m.isError);
      else card.setState('interrupted', 'muted');
    }
    if (m.id) this.cards.set(m.id, card);
    return card;
  }

  async runTool(m) {
    const card = this.addToolCard(m);
    let result;
    try {
      result = await this.executeTool(m, card);
    } catch (e) {
      result = { content: String(e.message || e), isError: true };
    }
    card.finish(result.content, result.isError);
    this.send({ t: 'toolResult', id: m.id, content: result.content, isError: !!result.isError });
  }

  async executeTool(m, card) {
    const input = m.input || {};
    const auto = this.status && this.status.autoRun;
    const needPane = () => {
      const p = this.pane(input.terminal_id);
      if (!p) throw new Error(`No terminal with ID ${input.terminal_id}. Open terminals:\n${this.terminalContext()}`);
      return p;
    };

    switch (m.name) {
      case 'list_terminals':
        return { content: this.terminalContext() };

      case 'read_terminal': {
        const p = needPane();
        const n = Math.min(2000, Math.max(1, input.lines || 100));
        return { content: `${p.aiId} (${p.title}, ${p.state}):\n${p.tailText(n) || '(empty screen)'}` };
      }

      case 'run_command': {
        const p = needPane();
        let cmd = input.command;
        if (!auto) {
          const edited = await card.ask(p);
          if (edited == null) return { content: 'The user declined to run this command.' };
          cmd = edited;
        }
        if (p.state !== 'connected') throw new Error(`${p.aiId} is not connected (${p.state}).`);
        card.setState('running…', 'warn');
        const r = await p.runCapture(cmd, input.timeout_seconds || 30);
        const edited = cmd !== input.command ? `The user edited the command before running it. Actually ran: ${cmd}\n` : '';
        const note = {
          done: `finished in ${r.seconds}s`,
          quiet: `no new output for 8s after ${r.seconds}s; the command may still be running or waiting for input`,
          timeout: `still running after the ${r.seconds}s timeout`,
          disconnected: 'the terminal disconnected',
        }[r.status];
        return { content: `${edited}[${p.aiId}: ${note}]\n${r.output}` };
      }

      case 'send_keys': {
        const p = needPane();
        let keys = input.keys;
        if (!auto) {
          const edited = await card.ask(p);
          if (edited == null) return { content: 'The user declined to send these keys.' };
          keys = edited;
        }
        if (p.state !== 'connected') throw new Error(`${p.aiId} is not connected (${p.state}).`);
        for (const c of parseSendText(keys)) {
          if (c.pause) await sleep(c.pause);
          else p.sendInput(c.text);
        }
        await sleep(1000);
        return { content: `[${p.aiId} screen after sending keys]\n${p.tailText(p.term.rows)}` };
      }

      case 'open_session': {
        const spec = this.findSession(input.name);
        if (!spec) {
          const names = [...this.app.sessions.values()].map((s) => s.name).concat((this.app.caps.shells || []).map((s) => s.name));
          throw new Error(`No saved session or local shell named "${input.name}". Available: ${names.join(', ') || 'none'}`);
        }
        if (!auto && (await card.ask()) == null) return { content: 'The user declined to open this session.' };
        const placement = input.placement || 'split_right';
        const opts = placement === 'new_tab' ? { where: 'tab' } : { where: 'split', dir: placement === 'split_down' ? 'col' : 'row' };
        const pane = spec.sessionId ? this.app.openSession(spec.sessionId, opts) : this.app.openSpec(spec, opts);
        if (!pane) throw new Error('Could not open the session.');
        card.setState('connecting…', 'warn');
        const t0 = Date.now();
        while (Date.now() - t0 < 120000) {
          await sleep(300);
          const waitingForUser = !!pane.el.querySelector('.pane-overlay');
          if (pane.state === 'connected' && Date.now() - pane.lastOutputAt > 800) break;
          if (pane.state === 'error' || pane.state === 'closed') break;
          if (!waitingForUser && pane.state === 'connecting' && Date.now() - t0 > 45000) break;
        }
        this.updateContextLine();
        return {
          content: `Opened as ${pane.aiId} ("${pane.title}"), state: ${pane.state}.\n${pane.tailText(30)}`,
          isError: pane.state !== 'connected',
        };
      }
    }
    throw new Error(`Unknown tool ${m.name}`);
  }

  findSession(name) {
    const q = String(name || '').trim().toLowerCase();
    if (!q) return null;
    const sessions = [...this.app.sessions.values()];
    const s = sessions.find((x) => x.name.toLowerCase() === q) || sessions.find((x) => x.name.toLowerCase().includes(q));
    if (s) return { sessionId: s.id };
    const shells = this.app.caps.shells || [];
    const sh = shells.find((x) => x.name.toLowerCase() === q) || shells.find((x) => x.name.toLowerCase().includes(q) || x.path.toLowerCase().includes(q));
    return sh ? { overrides: { protocol: 'local', shell: sh.path, shellName: sh.name } } : null;
  }
}

function fmtTokens(n) {
  return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0);
}
