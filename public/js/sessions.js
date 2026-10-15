// Session manager sidebar and the session editor dialog.

import { api, h, icon, esc, modal, toast, confirmDialog, promptDialog, contextMenu, pickFile, downloadText, store } from './util.js';
import { settings, saveSettings } from './settings.js';
import { THEMES } from './themes.js';
import { describeTarget } from './terminal-pane.js';

export const PROTOCOLS = [
  ['ssh', 'SSH'],
  ['telnet', 'Telnet'],
  ['raw', 'Raw TCP'],
  ['serial', 'Serial'],
  ['local', 'Local shell'],
];
const DEFAULT_PORT = { ssh: 22, telnet: 23, raw: 23 };
const ENCODINGS = ['utf-8', 'latin1', 'windows-1252', 'iso-8859-15', 'cp437', 'cp850', 'koi8-r', 'windows-1251', 'gbk', 'big5', 'shift_jis', 'euc-kr'];

export class SessionsUI {
  constructor(app) {
    this.app = app;
    this.treeEl = document.getElementById('session-tree');
    this.filterEl = document.getElementById('session-filter');
    this.footEl = document.getElementById('sb-foot');
    this.expanded = new Set(store.get('expandedFolders', []));
    this.selected = null;
    this.filterEl.addEventListener('input', () => this.render());
    this.filterEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.treeEl.querySelector('.tree-row[data-sid]');
        if (first) this.app.openSession(first.dataset.sid);
      } else if (e.key === 'Escape') {
        this.filterEl.value = '';
        this.render();
      }
    });
    this.treeEl.addEventListener('contextmenu', (e) => {
      if (e.target === this.treeEl) {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: 'New session…', icon: 'plus', action: () => this.edit(null) },
          { label: 'New folder…', icon: 'folderPlus', action: () => this.newFolder() },
        ]);
      }
    });
    // Dropping a session on the empty area moves it to the root folder.
    this.treeEl.addEventListener('dragover', (e) => e.dataTransfer.types.includes('application/x-tt-session') && e.preventDefault());
    this.treeEl.addEventListener('drop', (e) => {
      if (e.target !== this.treeEl) return;
      const sid = e.dataTransfer.getData('application/x-tt-session');
      if (sid) this.moveToFolder(sid, '');
    });
  }

  async load() {
    const list = await api('/sessions');
    this.app.sessions = new Map(list.map((s) => [s.id, s]));
    this.render();
    return list;
  }

  list() {
    return [...this.app.sessions.values()];
  }

  folders() {
    const set = new Set(settings.folders || []);
    for (const s of this.list()) if (s.folder) set.add(s.folder);
    // include parent folders
    for (const f of [...set]) {
      const parts = f.split('/');
      for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join('/'));
    }
    return [...set].sort((a, b) => a.localeCompare(b));
  }

  render() {
    const q = this.filterEl.value.trim().toLowerCase();
    const sessions = this.list().filter((s) => !q || [s.name, s.host, s.username, s.folder, s.protocol, s.serialPort, s.notes].some((v) => v && String(v).toLowerCase().includes(q)));
    sessions.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const root = { name: '', path: '', folders: new Map(), sessions: [] };
    const ensure = (path) => {
      let node = root;
      if (!path) return node;
      let acc = '';
      for (const part of path.split('/')) {
        acc = acc ? acc + '/' + part : part;
        if (!node.folders.has(part)) node.folders.set(part, { name: part, path: acc, folders: new Map(), sessions: [] });
        node = node.folders.get(part);
      }
      return node;
    };
    if (!q) this.folders().forEach(ensure);
    for (const s of sessions) ensure(s.folder || '').sessions.push(s);

    const frag = document.createDocumentFragment();
    const draw = (node, parentEl) => {
      for (const f of [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
        const open = q || this.expanded.has(f.path);
        const count = countSessions(f);
        const row = h('div.tree-row', { dataset: { folder: f.path }, html: `<span class="chev">${icon(open ? 'chevDown' : 'chevRight')}</span>${icon(open ? 'folderOpen' : 'folder')}<span class="name">${esc(f.name)}</span><span class="sub">${count || ''}</span>` });
        row.addEventListener('click', () => {
          open ? this.expanded.delete(f.path) : this.expanded.add(f.path);
          store.set('expandedFolders', [...this.expanded]);
          this.render();
        });
        row.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.folderMenu(f, e.clientX, e.clientY);
        });
        row.addEventListener('dragover', (e) => {
          if (e.dataTransfer.types.includes('application/x-tt-session')) {
            e.preventDefault();
            row.classList.add('drop');
          }
        });
        row.addEventListener('dragleave', () => row.classList.remove('drop'));
        row.addEventListener('drop', (e) => {
          e.preventDefault();
          e.stopPropagation();
          row.classList.remove('drop');
          const sid = e.dataTransfer.getData('application/x-tt-session');
          if (sid) this.moveToFolder(sid, f.path);
        });
        parentEl.append(row);
        if (open) {
          const kids = h('div.tree-children');
          draw(f, kids);
          parentEl.append(kids);
        }
      }
      for (const s of node.sessions) parentEl.append(this.sessionRow(s));
    };
    draw(root, frag);
    this.treeEl.replaceChildren(frag);
    if (!this.app.sessions.size) {
      this.treeEl.append(h('div.empty-hint', 'No saved sessions yet.', h('br'), h('button.btn.sm', { style: { marginTop: '10px' }, on: { click: () => this.edit(null) } }, '+ New session')));
    }
    this.footEl.textContent = `${this.app.sessions.size} session${this.app.sessions.size === 1 ? '' : 's'}`;
  }

  sessionRow(s) {
    const row = h('div.tree-row', {
      draggable: 'true',
      dataset: { sid: s.id },
      title: `${s.name}\n${s.protocol.toUpperCase()} ${describeTarget(s)}${s.notes ? '\n\n' + s.notes : ''}\n\nDouble-click to connect, drag onto a pane to split`,
      html: `<span class="chev"></span><span class="proto-dot p-${esc(s.protocol)}">${esc(protoShort(s.protocol))}</span><span class="name">${esc(s.name || describeTarget(s))}</span><span class="sub">${esc(describeTarget(s))}</span>`,
    });
    if (s.color) row.querySelector('.proto-dot').style.boxShadow = `inset 0 -2px 0 ${s.color}`;
    if (this.selected === s.id) row.classList.add('selected');
    row.addEventListener('click', () => {
      this.selected = s.id;
      this.treeEl.querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
      row.classList.add('selected');
    });
    row.addEventListener('dblclick', () => this.app.openSession(s.id));
    row.addEventListener('keydown', (e) => e.key === 'Enter' && this.app.openSession(s.id));
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      this.sessionMenu(s, e.clientX, e.clientY);
    });
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-tt-session', s.id);
      e.dataTransfer.effectAllowed = 'copyMove';
    });
    return row;
  }

  sessionMenu(s, x, y) {
    contextMenu(x, y, [
      { label: 'Connect', icon: 'plug', action: () => this.app.openSession(s.id) },
      { label: 'Connect in new tab', icon: 'plus', action: () => this.app.openSession(s.id, { where: 'tab' }) },
      { label: 'Connect split right', icon: 'splitV', action: () => this.app.openSession(s.id, { where: 'split', dir: 'row' }) },
      { label: 'Connect split down', icon: 'splitH', action: () => this.app.openSession(s.id, { where: 'split', dir: 'col' }) },
      '-',
      { label: 'Edit…', icon: 'edit', action: () => this.edit(s.id) },
      { label: 'Duplicate', icon: 'copy', action: () => this.duplicate(s) },
      { label: 'Move to folder…', icon: 'folder', action: async () => {
        const f = await promptDialog('Folder path (use / for sub-folders, empty = root):', s.folder || '', { title: 'Move session' });
        if (f !== null) this.moveToFolder(s.id, f.trim().replace(/^\/+|\/+$/g, ''));
      } },
      s.protocol === 'ssh' ? { label: 'Copy ssh command', icon: 'terminal', action: () => navigator.clipboard.writeText(`ssh ${s.port && s.port != 22 ? `-p ${s.port} ` : ''}${s.username ? s.username + '@' : ''}${s.host}`) } : null,
      '-',
      { label: 'Delete', icon: 'trash', danger: true, action: () => this.remove(s) },
    ]);
  }

  folderMenu(f, x, y) {
    const inFolder = this.list().filter((s) => (s.folder || '') === f.path || (s.folder || '').startsWith(f.path + '/'));
    contextMenu(x, y, [
      { label: 'New session here…', icon: 'plus', action: () => this.edit(null, { folder: f.path }) },
      { label: 'New sub-folder…', icon: 'folderPlus', action: () => this.newFolder(f.path + '/') },
      '-',
      { label: `Connect all (${inFolder.length}) tiled`, icon: 'grid', disabled: !inFolder.length, action: () => this.app.openMany(inFolder.map((s) => s.id), f.name) },
      { label: `Connect all in tabs`, icon: 'plus', disabled: !inFolder.length, action: () => inFolder.forEach((s) => this.app.openSession(s.id, { where: 'tab' })) },
      '-',
      { label: 'Rename folder…', icon: 'edit', action: () => this.renameFolder(f.path) },
      { label: 'Delete folder', icon: 'trash', danger: true, action: () => this.deleteFolder(f.path, inFolder) },
    ]);
  }

  async moveToFolder(id, folder) {
    const s = this.app.sessions.get(id);
    if (!s || (s.folder || '') === folder) return;
    const saved = await api('/sessions', { method: 'POST', body: { ...s, folder } });
    this.app.sessions.set(saved.id, saved);
    if (folder) this.expanded.add(folder);
    this.render();
  }

  async newFolder(prefix = '') {
    const name = await promptDialog('Folder name (use / for nested folders):', prefix, { title: 'New folder' });
    if (!name || !name.trim()) return;
    const path = name.trim().replace(/^\/+|\/+$/g, '');
    saveSettings({ folders: [...new Set([...(settings.folders || []), path])] });
    this.expanded.add(path);
    this.render();
  }

  async renameFolder(path) {
    const to = await promptDialog('New folder path:', path, { title: 'Rename folder' });
    if (!to || to === path) return;
    const clean = to.trim().replace(/^\/+|\/+$/g, '');
    await api('/folders/rename', { method: 'POST', body: { from: path, to: clean } });
    saveSettings({ folders: (settings.folders || []).map((f) => (f === path || f.startsWith(path + '/') ? clean + f.slice(path.length) : f)) });
    await this.load();
  }

  async deleteFolder(path, inFolder) {
    if (inFolder.length && !(await confirmDialog(`Delete folder "${path}" and its ${inFolder.length} session(s)?`, { danger: true, ok: 'Delete' }))) return;
    for (const s of inFolder) await api('/sessions/' + s.id, { method: 'DELETE' });
    saveSettings({ folders: (settings.folders || []).filter((f) => f !== path && !f.startsWith(path + '/')) });
    await this.load();
  }

  async remove(s) {
    if (!(await confirmDialog(`Delete session "${s.name}"?`, { danger: true, ok: 'Delete' }))) return;
    await api('/sessions/' + s.id, { method: 'DELETE' });
    this.app.sessions.delete(s.id);
    this.render();
  }

  async duplicate(s) {
    // Secrets never reach the browser, so the server copies them from the source session.
    const copy = { ...s, id: undefined, name: s.name + ' (copy)', copySecretsFrom: s.id };
    delete copy._has;
    const saved = await api('/sessions', { method: 'POST', body: copy });
    this.app.sessions.set(saved.id, saved);
    this.render();
    toast('Session duplicated', 'ok');
  }

  async exportAll() {
    const withSecrets = await confirmDialog('Include saved passwords and private keys in the export?\n\nThe file will contain them in plain text.', { title: 'Export sessions', ok: 'Include secrets' });
    const data = await api('/sessions/export' + (withSecrets ? '?secrets=1' : ''));
    downloadText('torterminal-sessions.json', JSON.stringify({ sessions: data, buttons: this.app.buttons.bars, version: 1 }, null, 2), 'application/json');
  }

  async importAll() {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const sessions = Array.isArray(data) ? data : data.sessions;
      const r = await api('/sessions/import', { method: 'POST', body: { sessions } });
      if (data.buttons && Array.isArray(data.buttons) && (await confirmDialog('The file also contains button bars. Import them too?'))) {
        this.app.buttons.importBars(data.buttons);
      }
      await this.load();
      toast(`Imported. ${r.count} sessions total.`, 'ok');
    } catch (e) {
      toast('Import failed: ' + e.message, 'error');
    }
  }

  // ------------------------------------------------------------------ editor

  async edit(id, preset = {}) {
    const existing = id ? this.app.sessions.get(id) : null;
    const s = existing
      ? JSON.parse(JSON.stringify(existing))
      : { protocol: 'ssh', port: 22, keepalive: settings.keepalive, autoReconnect: settings.autoReconnect, ...preset };
    s.forwards = s.forwards || [];
    s.logonScript = s.logonScript || [];
    const has = s._has || {};
    const secret = { password: undefined, privateKey: undefined, passphrase: undefined };
    const caps = this.app.caps || {};

    const body = h('div');
    const tabBar = h('div.form-tabs');
    const panel = h('div');
    body.append(tabBar, panel);

    // --- field builders bound to `s` ---
    const inp = (key, attrs = {}) => {
      const e = h('input', { type: 'text', value: s[key] ?? '', spellcheck: 'false', ...attrs });
      e.addEventListener('input', () => (s[key] = attrs.type === 'number' ? (e.value === '' ? '' : Number(e.value)) : e.value));
      return e;
    };
    const area = (key, rows = 3, attrs = {}) => {
      const e = h('textarea', { rows, spellcheck: 'false', ...attrs }, s[key] ?? '');
      e.addEventListener('input', () => (s[key] = e.value));
      return e;
    };
    const select = (key, options, onChange) => {
      const e = h('select');
      for (const o of options) {
        const [v, l] = Array.isArray(o) ? o : [o, o];
        e.append(h('option', { value: v, selected: String(s[key] ?? '') === String(v) }, l));
      }
      e.addEventListener('change', () => {
        s[key] = e.value;
        onChange && onChange();
      });
      return e;
    };
    const check = (key, label) => {
      const e = h('input', { type: 'checkbox', checked: !!s[key] });
      e.addEventListener('change', () => (s[key] = e.checked));
      return h('label.chk', e, label);
    };
    const row = (label, input, hint) => [h('label', label), input, hint ? h('div.hint', hint) : null].filter(Boolean);
    const section = (t) => h('div.form-section', t);
    const secretInput = (key, label, multiline) => {
      const ph = has[key] ? '•••••• saved – leave empty to keep' : '';
      const e = multiline ? h('textarea', { rows: 4, placeholder: ph || '-----BEGIN OPENSSH PRIVATE KEY-----', spellcheck: 'false' }) : h('input', { type: 'password', placeholder: ph, autocomplete: 'new-password' });
      if (secret[key]) e.value = secret[key];
      e.addEventListener('input', () => (secret[key] = e.value));
      const clear = has[key] ? h('button.btn.sm', { type: 'button', title: 'Remove saved value', on: { click: () => ((secret[key] = null), (e.value = ''), (e.placeholder = 'will be cleared'), toast(`${label} will be cleared on save`)) } }, 'Clear') : null;
      return h('div.inline', e, clear);
    };

    const sessionsForJump = this.list().filter((x) => x.protocol === 'ssh' && x.id !== s.id);

    const tabs = {
      General: () => {
        const p = s.protocol;
        const g = h('div.form-grid',
          row('Name', inp('name', { placeholder: 'My server', autofocus: true })),
          row('Folder', inp('folder', { placeholder: 'e.g. Production/Web', list: 'folder-list' })),
          h('datalist#folder-list', this.folders().map((f) => h('option', { value: f }))),
          row('Protocol', select('protocol', PROTOCOLS, () => {
            if (DEFAULT_PORT[s.protocol] && (!s.port || Object.values(DEFAULT_PORT).includes(Number(s.port)))) s.port = DEFAULT_PORT[s.protocol];
            show('General');
          }))
        );
        if (p === 'ssh' || p === 'telnet' || p === 'raw') {
          g.append(...row('Host', h('div.inline', inp('host', { placeholder: 'hostname or IP' }), h('span', { style: { flex: 'none', color: 'var(--text-dim)' } }, 'Port'), inp('port', { type: 'number', min: 1, max: 65535, style: { maxWidth: '90px' } }))));
        }
        if (p === 'ssh' || p === 'telnet') g.append(...row('Username', inp('username', { placeholder: p === 'ssh' ? 'prompted if empty' : 'used by logon script / buttons' })));
        if (p === 'ssh') {
          g.append(
            section('Authentication'),
            ...row('Password', secretInput('password', 'Password'), 'Leave empty to be prompted when connecting.'),
            ...row('Private key', h('div', secretInput('privateKey', 'Private key', true), h('button.btn.sm', { type: 'button', style: { marginTop: '4px' }, on: { click: async () => {
              const f = await pickFile();
              if (f) {
                secret.privateKey = await f.text();
                show('General');
                toast(`Loaded key ${f.name}`, 'ok');
              }
            } } }, 'Load key file…')), 'OpenSSH, PEM or PuTTY .ppk (v2) keys.'),
            ...row('Key passphrase', secretInput('passphrase', 'Passphrase'), 'Prompted if needed and not saved.'),
            ...row('', check('useAgent', 'Use SSH agent (Pageant / ssh-agent)')),
            ...row('', check('agentForward', 'Agent forwarding'))
          );
        }
        if (p === 'telnet') {
          g.append(...row('Password', secretInput('password', 'Password'), 'Optional – available to logon scripts as ${password}.'));
        }
        if (p === 'serial') {
          s.baudRate = s.baudRate || '9600';
          const portSel = h('select', h('option', { value: s.serialPort || '' }, s.serialPort || 'Loading…'));
          const portInp = inp('serialPort', { placeholder: 'COM3 or /dev/ttyUSB0' });
          api('/serial/ports').then((ports) => {
            portSel.replaceChildren(h('option', { value: '' }, ports.length ? '— detected ports —' : 'No ports detected'), ...ports.map((x) => h('option', { value: x.path }, `${x.path}${x.friendlyName || x.manufacturer ? ' – ' + (x.friendlyName || x.manufacturer) : ''}`)));
          }).catch(() => portSel.replaceChildren(h('option', 'Serial not available')));
          portSel.addEventListener('change', () => portSel.value && ((s.serialPort = portSel.value), (portInp.value = portSel.value)));
          g.append(
            ...row('Port', h('div.inline', portInp, portSel)),
            ...row('Baud rate', select('baudRate', ['300', '1200', '2400', '4800', '9600', '19200', '38400', '57600', '115200', '230400', '460800', '921600'].map((b) => [b, b]))),
            ...row('Data bits', select('dataBits', ['8', '7', '6', '5'])),
            ...row('Parity', select('parity', ['none', 'even', 'odd', 'mark', 'space'])),
            ...row('Stop bits', select('stopBits', ['1', '1.5', '2'])),
            ...row('Flow control', select('flowControl', [['none', 'None'], ['rtscts', 'RTS/CTS (hardware)'], ['xonxoff', 'XON/XOFF (software)']]))
          );
          if (!caps.serial) g.append(h('div.hint', { style: { color: 'var(--danger)' } }, 'Serial support is not installed on the server (npm install serialport).'));
        }
        if (p === 'local') {
          const shells = caps.shells || [];
          g.append(
            ...row('Shell', select('shell', shells.map((x) => [x.path, `${x.name} (${x.path})`]), () => (s.shellName = (shells.find((x) => x.path === s.shell) || {}).name))),
            ...row('Arguments', inp('shellArgs', { placeholder: 'default' })),
            ...row('Start directory', inp('cwd', { placeholder: 'home directory' }))
          );
          if (!s.shell && shells[0]) {
            s.shell = shells[0].path;
            s.shellName = shells[0].name;
          }
          if (!caps.pty) g.append(h('div.hint', { style: { color: 'var(--warn)' } }, 'node-pty is not available: local shells run without a PTY.'));
        }
        g.append(section('Notes'), h('div.full', area('notes', 2, { placeholder: 'Notes, description, credentials hint…' })));
        return g;
      },
      Connection: () => {
        const p = s.protocol;
        const g = h('div.form-grid');
        if (p !== 'serial' && p !== 'local') g.append(...row('Connect timeout (s)', inp('connectTimeout', { type: 'number', min: 1, placeholder: '20' })));
        if (p === 'ssh') {
          g.append(
            ...row('Keepalive (s)', inp('keepalive', { type: 'number', min: 0, placeholder: '0 = off' }), 'Sends SSH keepalive packets to prevent idle disconnects.'),
            ...row('Jump host', select('jumpHostId', [['', '— none —'], ...sessionsForJump.map((x) => [x.id, `${x.name} (${describeTarget(x)})`])]), 'Tunnel through another saved SSH session (ProxyJump).'),
            ...row('Remote command', inp('remoteCommand', { placeholder: 'run instead of a shell, e.g. tmux attach || tmux' })),
            ...row('Environment', area('env', 2, { placeholder: 'LANG=en_US.UTF-8' }), 'One VAR=value per line (server must AcceptEnv).'),
            ...row('', check('compression', 'Enable compression')),
            ...row('', check('legacyAlgorithms', 'Allow legacy algorithms (old routers/switches: ssh-rsa, dh-group1, CBC, 3DES)')),
            ...row('', check('skipHostKeyCheck', 'Skip host key verification (insecure)'))
          );
        }
        if (p === 'telnet') {
          g.append(
            ...row('', check('telnetPassive', 'Passive negotiation (wait for server to start option negotiation)')),
            ...row('Enter sends', select('telnetNewline', [['true', 'CR LF (Telnet New Line)'], ['false', 'CR NUL']]))
          );
          if (s.telnetNewline === undefined) s.telnetNewline = 'true';
        }
        if (p !== 'serial') g.append(...row('Terminal type', inp('term', { placeholder: 'xterm-256color', list: 'term-list' })), h('datalist#term-list', ['xterm-256color', 'xterm', 'vt100', 'vt220', 'linux', 'ansi', 'screen-256color'].map((t) => h('option', { value: t }))));
        g.append(...row('Character set', select('encoding', ENCODINGS)));
        g.append(section('Reconnect & anti-idle'));
        g.append(...row('', check('autoReconnect', 'Automatically reconnect when the connection drops')));
        g.append(...row('Anti-idle every (s)', inp('antiIdleSeconds', { type: 'number', min: 0, placeholder: '0 = off' }), 'Send a string when there was no input for this many seconds.'));
        g.append(...row('Anti-idle string', inp('antiIdleText', { placeholder: 'e.g. \\x00 or " \\b"', class: 'mono' })));
        return g;
      },
      Tunnels: () => {
        if (s.protocol !== 'ssh') return h('p.muted', 'Port forwarding is available for SSH sessions.');
        const wrap = h('div');
        const table = h('table.tbl');
        const draw = () => {
          table.replaceChildren(h('tr', h('th', 'Type'), h('th', 'Bind address'), h('th', 'Port'), h('th', 'Destination host'), h('th', 'Port'), h('th', '')));
          s.forwards.forEach((f, i) => {
            const cell = (k, attrs = {}) => {
              const e = h('input', { type: 'text', value: f[k] ?? '', ...attrs });
              e.addEventListener('input', () => (f[k] = e.value));
              return h('td', e);
            };
            const typeSel = h('select', [['L', 'Local (-L)'], ['R', 'Remote (-R)'], ['D', 'Dynamic SOCKS (-D)']].map(([v, l]) => h('option', { value: v, selected: f.type === v }, l)));
            typeSel.addEventListener('change', () => ((f.type = typeSel.value), draw()));
            table.append(h('tr', h('td', typeSel), cell('bindAddr', { placeholder: '127.0.0.1' }), cell('bindPort', { type: 'number', style: { width: '80px' } }), f.type === 'D' ? h('td.muted', 'SOCKS5 / 4a') : cell('dstHost', { placeholder: 'localhost' }), f.type === 'D' ? h('td') : cell('dstPort', { type: 'number', style: { width: '80px' } }), h('td', h('button.icon-btn', { html: icon('trash'), on: { click: () => (s.forwards.splice(i, 1), draw()) } }))));
          });
        };
        draw();
        wrap.append(
          h('p.muted', 'Local: listen on the TorTerminal server, forward through SSH. Remote: listen on the SSH server, forward back here. Dynamic: SOCKS proxy on the TorTerminal server.'),
          table,
          h('button.btn.sm', { type: 'button', style: { marginTop: '8px' }, on: { click: () => (s.forwards.push({ type: 'L', bindAddr: '127.0.0.1', bindPort: '', dstHost: 'localhost', dstPort: '' }), draw()) } }, '+ Add forward')
        );
        return wrap;
      },
      Terminal: () =>
        h('div.form-grid',
          ...row('Color scheme', select('theme', [['', '— default —'], ...Object.keys(THEMES).map((t) => [t, t])])),
          ...row('Font size', inp('fontSize', { type: 'number', min: 6, max: 48, placeholder: 'default' })),
          ...row('Tab color', h('div.inline', h('input', { type: 'color', value: s.color || '#7aa2f7', on: { input: (e) => (s.color = e.target.value) } }), h('button.btn.sm', { type: 'button', on: { click: () => (s.color = '') } }, 'None'))),
          ...row('Local echo', select('localEcho', [['auto', 'Auto'], ['on', 'Force on'], ['off', 'Force off']])),
          ...row('Local line editing', select('lineEdit', [['auto', 'Auto'], ['on', 'Force on'], ['off', 'Force off']]), 'Auto = on for Raw, and for Telnet when the server does not echo (PuTTY behaviour).'),
          ...row('Backspace sends', select('backspace', [['del', 'Control-? (127, DEL)'], ['bs', 'Control-H (8, BS)']])),
          ...row('Button bar', select('buttonBarId', [['', '— keep current —'], ...this.app.buttons.bars.map((b) => [b.id, b.name])]), 'Switch to this button bar when the session is focused.')
        ),
      'Logon script': () => {
        const wrap = h('div');
        const table = h('table.tbl');
        const draw = () => {
          table.replaceChildren(h('tr', h('th', '#'), h('th', 'Wait for (text or /regex/)'), h('th', 'Then send'), h('th', 'Enter'), h('th', '')));
          s.logonScript.forEach((st, i) => {
            const e1 = h('input.mono', { type: 'text', value: st.expect || '', placeholder: 'e.g. login: or /[$#] $/' });
            const e2 = h('input.mono', { type: 'text', value: st.send || '', placeholder: 'text, \\r \\t \\e \\xHH \\p (pause)' });
            const e3 = h('input', { type: 'checkbox', checked: !st.noEnter });
            e1.addEventListener('input', () => (st.expect = e1.value));
            e2.addEventListener('input', () => (st.send = e2.value));
            e3.addEventListener('change', () => (st.noEnter = !e3.checked));
            table.append(h('tr', h('td.muted', i + 1), h('td', e1), h('td', e2), h('td', e3), h('td', h('button.icon-btn', { html: icon('trash'), on: { click: () => (s.logonScript.splice(i, 1), draw()) } }))));
          });
        };
        draw();
        wrap.append(
          h('p.muted', 'Expect/send pairs run after connecting (SecureCRT "Logon Actions"). Leave "wait for" empty to send immediately. Each step times out after 30 s.'),
          table,
          h('div.inline', { style: { marginTop: '8px', justifyContent: 'flex-start' } },
            h('button.btn.sm', { type: 'button', on: { click: () => (s.logonScript.push({ expect: '', send: '' }), draw()) } }, '+ Add step'),
            h('button.btn.sm', { type: 'button', on: { click: () => (s.logonScript.push({ expect: 'login:', send: s.username || '' }, { expect: 'assword:', send: '' }), draw()) } }, 'Telnet login template'),
            h('button.btn.sm', { type: 'button', on: { click: () => (s.logonScript.push({ expect: '>', send: 'enable' }, { expect: '#', send: 'terminal length 0' }), draw()) } }, 'Cisco enable template'))
        );
        return wrap;
      },
      Logging: () =>
        h('div.form-grid',
          ...row('', check('logEnabled', 'Start logging automatically when connected')),
          ...row('What to log', select('logMode', [['printable', 'Printable output (strip escape codes)'], ['raw', 'All session output (raw)']])),
          ...row('', check('logTimestamps', 'Timestamp each line')),
          h('div.hint', 'Logs are written on the server to data/logs and can be viewed from the Logs button in the toolbar.')
        ),
    };

    let current = 'General';
    function show(name) {
      current = name;
      tabBar.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.textContent === name));
      panel.replaceChildren(tabs[name]());
    }
    for (const name of Object.keys(tabs)) tabBar.append(h('button', { type: 'button', on: { click: () => show(name) } }, name));
    show(current);

    const save = async (connect) => {
      if (!s.name) s.name = describeTarget(s) || 'Untitled';
      if ((s.protocol === 'ssh' || s.protocol === 'telnet' || s.protocol === 'raw') && !s.host) {
        toast('Host is required', 'error');
        show('General');
        return false;
      }
      if (s.protocol === 'serial' && !s.serialPort) {
        toast('Serial port is required', 'error');
        return false;
      }
      if (typeof s.telnetNewline === 'string') s.telnetNewline = s.telnetNewline !== 'false';
      s.forwards = s.forwards.filter((f) => f.bindPort);
      s.logonScript = s.logonScript.filter((x) => x.expect || x.send);
      const body = { ...s, ...Object.fromEntries(Object.entries(secret).filter(([, v]) => v !== undefined)) };
      delete body._has;
      try {
        const saved = await api('/sessions', { method: 'POST', body });
        this.app.sessions.set(saved.id, saved);
        if (saved.folder) this.expanded.add(saved.folder);
        this.render();
        this.app.onSessionSaved(saved);
        toast('Session saved', 'ok');
        if (connect) this.app.openSession(saved.id);
      } catch (e) {
        toast('Save failed: ' + e.message, 'error');
        return false;
      }
    };

    modal({
      title: existing ? `Edit session – ${existing.name}` : 'New session',
      size: 'wide',
      body,
      buttons: [
        existing ? { label: 'Delete', danger: true, left: true, onClick: async () => { await this.remove(existing); } } : null,
        { label: 'Cancel' },
        { label: 'Save', onClick: () => save(false) },
        { label: 'Save & connect', primary: true, onClick: () => save(true) },
      ].filter(Boolean),
    });
  }
}

function countSessions(f) {
  let n = f.sessions.length;
  for (const c of f.folders.values()) n += countSessions(c);
  return n;
}

export function protoShort(p) {
  return { ssh: 'SSH', telnet: 'TEL', raw: 'RAW', serial: 'COM', local: '>_' }[p] || '?';
}
