// SFTP file browser bound to an SSH pane.

import { h, icon, esc, formatBytes, modal, toast, confirmDialog, promptDialog, contextMenu, copyText } from './util.js';

const posix = {
  join: (a, b) => (b.startsWith('/') ? b : (a.endsWith('/') ? a : a + '/') + b),
  dirname: (p) => {
    const t = p.replace(/\/+$/, '');
    const i = t.lastIndexOf('/');
    return i <= 0 ? '/' : t.slice(0, i);
  },
};
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function perms(mode) {
  if (mode == null) return '';
  const t = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  let s = t;
  for (let i = 8; i >= 0; i--) s += mode & (1 << i) ? 'rwx'[(8 - i) % 3] : '-';
  return s;
}

export class SftpPanel {
  constructor(app) {
    this.app = app;
    this.el = document.getElementById('sftp-panel');
    this.pane = null;
    this.entries = [];
    this.sort = { key: 'name', dir: 1 };
    this.selected = new Set();
    this.build();
  }

  get visible() {
    return !this.el.classList.contains('hidden');
  }

  build() {
    this.titleEl = h('span.title', 'SFTP');
    this.pathInput = h('input', { type: 'text', spellcheck: 'false' });
    this.pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && this.list(this.pathInput.value.trim() || '/'));
    const btn = (ic, title, fn) => h('button.icon-btn', { title, html: icon(ic), on: { click: fn } });
    this.listEl = h('div.sftp-list');
    this.xferEl = h('div.sftp-transfers');
    this.fileInput = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    this.fileInput.addEventListener('change', () => {
      this.upload([...this.fileInput.files]);
      this.fileInput.value = '';
    });
    this.el.append(
      h('div.sftp-head', h('span', { html: icon('folderOpen') }), this.titleEl,
        btn('upload', 'Upload files', () => this.fileInput.click()),
        btn('folderPlus', 'New folder', () => this.mkdir()),
        btn('file', 'New file', () => this.newFile()),
        btn('terminal', 'Follow terminal: cd to this folder in the pane', () => this.cdInTerminal(this.cwd)),
        btn('x', 'Close', () => this.close())),
      h('div.sftp-path', btn('arrowUp', 'Parent folder', () => this.list(posix.dirname(this.cwd))), btn('home', 'Home', () => this.home()), this.pathInput, btn('refresh', 'Refresh', () => this.list(this.cwd))),
      this.listEl,
      this.xferEl,
      this.fileInput
    );
    this.listEl.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('Files')) {
        e.preventDefault();
        this.listEl.classList.add('dragover');
      }
    });
    this.listEl.addEventListener('dragleave', () => this.listEl.classList.remove('dragover'));
    this.listEl.addEventListener('drop', (e) => {
      e.preventDefault();
      this.listEl.classList.remove('dragover');
      if (e.dataTransfer.files.length) this.upload([...e.dataTransfer.files]);
    });
    this.listEl.addEventListener('contextmenu', (e) => {
      if (e.target.closest('tr[data-name]')) return;
      e.preventDefault();
      contextMenu(e.clientX, e.clientY, [
        { label: 'Upload files…', icon: 'upload', action: () => this.fileInput.click() },
        { label: 'New folder…', icon: 'folderPlus', action: () => this.mkdir() },
        { label: 'New file…', icon: 'file', action: () => this.newFile() },
        { label: 'Refresh', icon: 'refresh', action: () => this.list(this.cwd) },
      ]);
    });
  }

  async open(pane) {
    this.el.classList.remove('hidden');
    await this.bind(pane);
  }

  close() {
    this.el.classList.add('hidden');
    this.pane = null;
  }

  toggle(pane) {
    if (this.visible) this.close();
    else this.open(pane);
  }

  async bind(pane) {
    if (!pane || !pane.sftpAvailable) {
      this.pane = pane;
      this.titleEl.textContent = 'SFTP';
      this.listEl.replaceChildren(h('div.empty-hint', pane ? 'The active pane is not a connected SSH session.' : 'No active pane.'));
      return;
    }
    if (this.pane === pane && this.cwd) return;
    this.pane = pane;
    this.titleEl.textContent = pane.title;
    if (pane.sftpCwd) await this.list(pane.sftpCwd);
    else await this.home();
  }

  /** Called when the active pane changes. */
  follow(pane) {
    if (this.visible && pane && pane !== this.pane && pane.sftpAvailable) this.bind(pane);
  }

  async home() {
    try {
      const p = await this.pane.sftp('home');
      await this.list(p);
    } catch (e) {
      this.error(e);
    }
  }

  async list(path) {
    if (!this.pane) return;
    this.listEl.style.opacity = '0.6';
    try {
      const real = await this.pane.sftp('realpath', { path });
      const items = await this.pane.sftp('list', { path: real });
      this.cwd = real;
      this.pane.sftpCwd = real;
      this.pathInput.value = real;
      this.entries = items.filter((x) => x.name !== '.' && x.name !== '..');
      this.selected.clear();
      this.render();
    } catch (e) {
      this.error(e);
    } finally {
      this.listEl.style.opacity = '';
    }
  }

  error(e) {
    toast('SFTP: ' + (e.message || e), 'error');
  }

  render() {
    const { key, dir } = this.sort;
    const sorted = [...this.entries].sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      const va = a[key];
      const vb = b[key];
      return (typeof va === 'string' ? va.localeCompare(vb, undefined, { numeric: true }) : (va || 0) - (vb || 0)) * dir;
    });
    const th = (label, k) => {
      const e = h('th', label + (this.sort.key === k ? (this.sort.dir > 0 ? ' ▲' : ' ▼') : ''));
      e.addEventListener('click', () => {
        this.sort = { key: k, dir: this.sort.key === k ? -this.sort.dir : 1 };
        this.render();
      });
      return e;
    };
    const table = h('table', h('tr', th('Name', 'name'), th('Size', 'size'), th('Modified', 'mtime'), th('Perms', 'mode')));
    if (this.cwd !== '/') {
      const up = h('tr', h('td.n', { html: `${icon('folder', 'dir')}<span class="dir">..</span>` }), h('td'), h('td'), h('td'));
      up.addEventListener('dblclick', () => this.list(posix.dirname(this.cwd)));
      table.append(up);
    }
    for (const it of sorted) {
      const tr = h(
        'tr',
        { dataset: { name: it.name }, draggable: 'true' },
        h('td.n', { title: it.name, html: `${icon(it.isDir ? 'folder' : it.isLink ? 'link' : 'file', it.isDir ? 'dir' : '')}<span class="${it.isDir ? 'dir' : ''}">${esc(it.name)}</span>` }),
        h('td.r', it.isDir ? '' : formatBytes(it.size)),
        h('td.r', it.mtime ? new Date(it.mtime).toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' }) : ''),
        h('td.m', perms(it.mode))
      );
      if (this.selected.has(it.name)) tr.classList.add('sel');
      tr.addEventListener('click', (e) => {
        if (!e.ctrlKey && !e.metaKey) this.selected.clear();
        this.selected.has(it.name) && (e.ctrlKey || e.metaKey) ? this.selected.delete(it.name) : this.selected.add(it.name);
        this.render();
      });
      tr.addEventListener('dblclick', () => (it.isDir || it.isLink ? this.list(posix.join(this.cwd, it.name)) : this.download(it)));
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        if (!this.selected.has(it.name)) {
          this.selected.clear();
          this.selected.add(it.name);
          this.render();
        }
        this.itemMenu(it, e.clientX, e.clientY);
      });
      // Drag a remote path into a terminal pane to paste it.
      tr.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', posix.join(this.cwd, it.name)));
      table.append(tr);
    }
    this.listEl.replaceChildren(table);
    if (!sorted.length) this.listEl.append(h('div.empty-hint', 'Empty folder – drop files here to upload'));
  }

  selection() {
    return this.entries.filter((e) => this.selected.has(e.name));
  }

  itemMenu(it, x, y) {
    const sel = this.selection();
    const multi = sel.length > 1;
    const full = posix.join(this.cwd, it.name);
    contextMenu(x, y, [
      it.isDir ? { label: 'Open', icon: 'folderOpen', action: () => this.list(full) } : { label: 'Edit', icon: 'edit', disabled: multi, action: () => this.edit(full) },
      { label: multi ? `Download ${sel.filter((s) => !s.isDir).length} files` : 'Download', icon: 'download', disabled: sel.every((s) => s.isDir), action: () => sel.filter((s) => !s.isDir).forEach((s) => this.download(s)) },
      '-',
      { label: 'Rename…', icon: 'edit', disabled: multi, action: () => this.rename(it) },
      { label: 'Permissions…', icon: 'lock', action: () => this.chmod(sel) },
      { label: 'Copy path', icon: 'copy', action: () => copyText(multi ? sel.map((s) => posix.join(this.cwd, s.name)).join('\n') : full) },
      { label: 'Paste path into terminal', icon: 'terminal', action: () => this.pane.sendText(sel.map((s) => shq(posix.join(this.cwd, s.name))).join(' '), { escapes: false }) },
      it.isDir ? { label: 'cd here in terminal', icon: 'terminal', action: () => this.cdInTerminal(full) } : null,
      '-',
      { label: multi ? `Delete ${sel.length} items` : 'Delete', icon: 'trash', danger: true, action: () => this.remove(sel) },
    ]);
  }

  cdInTerminal(path) {
    if (!this.pane || !path) return;
    this.pane.sendText(`cd ${shq(path)}\r`, { escapes: false });
    this.pane.focus();
  }

  download(it) {
    const url = `/api/sftp/${this.pane.connId}/download?path=${encodeURIComponent(posix.join(this.cwd, it.name))}`;
    const a = h('a', { href: url, download: it.name });
    document.body.append(a);
    a.click();
    a.remove();
  }

  upload(files) {
    const pane = this.pane;
    const dir = this.cwd;
    if (!pane || !dir) return;
    for (const file of files) {
      const bar = h('div');
      const status = h('span.muted', '0%');
      const row = h('div.xfer', h('span', { title: file.name }, `↑ ${file.name}`), status, h('div.bar', bar));
      this.xferEl.prepend(row);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/sftp/${pane.connId}/upload?path=${encodeURIComponent(posix.join(dir, file.name))}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          const p = Math.round((e.loaded / e.total) * 100);
          bar.style.width = p + '%';
          status.textContent = `${p}% of ${formatBytes(e.total)}`;
        }
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          bar.style.width = '100%';
          status.textContent = `done (${formatBytes(file.size)})`;
          setTimeout(() => row.remove(), 4000);
          if (this.pane === pane && this.cwd === dir) this.list(dir);
        } else {
          row.classList.add('err');
          status.textContent = 'failed: ' + ((JSON.parse(xhr.responseText || '{}').error) || xhr.status);
        }
      };
      xhr.onerror = () => {
        row.classList.add('err');
        status.textContent = 'failed';
      };
      xhr.send(file);
    }
  }

  async mkdir() {
    const name = await promptDialog('New folder name:', '', { title: 'New folder' });
    if (!name) return;
    try {
      await this.pane.sftp('mkdir', { path: posix.join(this.cwd, name) });
      this.list(this.cwd);
    } catch (e) {
      this.error(e);
    }
  }

  async newFile() {
    const name = await promptDialog('New file name:', '', { title: 'New file' });
    if (!name) return;
    try {
      const p = posix.join(this.cwd, name);
      await this.pane.sftp('writeText', { path: p, content: '' });
      await this.list(this.cwd);
      this.edit(p);
    } catch (e) {
      this.error(e);
    }
  }

  async rename(it) {
    const name = await promptDialog('New name:', it.name, { title: 'Rename' });
    if (!name || name === it.name) return;
    try {
      await this.pane.sftp('rename', { from: posix.join(this.cwd, it.name), to: posix.join(this.cwd, name) });
      this.list(this.cwd);
    } catch (e) {
      this.error(e);
    }
  }

  async chmod(items) {
    const cur = items[0] && items[0].mode != null ? (items[0].mode & 0o777).toString(8) : '644';
    const mode = await promptDialog('Octal permissions (e.g. 644, 755):', cur, { title: 'Change permissions' });
    if (!mode || !/^[0-7]{3,4}$/.test(mode)) return;
    try {
      for (const it of items) await this.pane.sftp('chmod', { path: posix.join(this.cwd, it.name), mode });
      this.list(this.cwd);
    } catch (e) {
      this.error(e);
    }
  }

  async remove(items) {
    const names = items.map((i) => i.name + (i.isDir ? '/' : '')).join('\n');
    if (!(await confirmDialog(`Permanently delete ${items.length} item(s)?\n\n${names}`, { danger: true, ok: 'Delete', title: 'Delete' }))) return;
    try {
      for (const it of items) await this.pane.sftp('delete', { path: posix.join(this.cwd, it.name) });
    } catch (e) {
      this.error(e);
    }
    this.list(this.cwd);
  }

  async edit(path) {
    let content;
    try {
      content = await this.pane.sftp('readText', { path });
    } catch (e) {
      return this.error(e);
    }
    const pane = this.pane;
    const ta = h('textarea.editor-area', { spellcheck: 'false' }, content);
    let dirty = false;
    ta.addEventListener('input', () => (dirty = true));
    const save = async () => {
      try {
        await pane.sftp('writeText', { path, content: ta.value });
        dirty = false;
        toast(`Saved ${path}`, 'ok');
        if (this.pane === pane) this.list(this.cwd);
        return true;
      } catch (e) {
        this.error(e);
        return false;
      }
    };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        save();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const { selectionStart: s, selectionEnd: en } = ta;
        ta.setRangeText('\t', s, en, 'end');
        dirty = true;
      }
    });
    modal({
      title: `Edit ${path}`,
      size: 'xwide',
      body: ta,
      buttons: [
        { label: 'Close', onClick: async () => (dirty ? await confirmDialog('Discard unsaved changes?', { danger: true, ok: 'Discard' }) : true) || false },
        { label: 'Save (Ctrl+S)', onClick: async () => (await save(), false) },
        { label: 'Save & close', primary: true, onClick: async () => (await save()) || false },
      ],
    });
  }
}
