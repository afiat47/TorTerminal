// Tabs, each holding a tree of resizable splits whose leaves are terminal panes.
// node := { type: 'pane', pane } | { type: 'split', dir: 'row'|'col', children: node[], sizes: number[] }

import { h, icon, uid, contextMenu, promptDialog } from './util.js';

const TAB_COLORS = ['', '#f7768e', '#e0af68', '#3ddc97', '#7aa2f7', '#bb9af7', '#7dcfff', '#ff9e64'];

export class Layout {
  constructor(app) {
    this.app = app;
    this.tabs = [];
    this.active = null;
    this.tabsEl = document.getElementById('tabs');
    this.viewsEl = document.getElementById('tab-views');
    this.dragPane = null;
    this.dragTab = null;
  }

  // ------------------------------------------------------------------ tabs

  newTab({ title = '', color = '', activate = true } = {}) {
    const tab = { id: uid(), customTitle: title, color, root: null, zoomed: null, broadcast: false, activePane: null, flagged: false, view: h('div.tab-view') };
    this.tabs.push(tab);
    this.viewsEl.append(tab.view);
    if (activate) this.activateTab(tab);
    else tab.view.classList.add('hidden');
    this.render(tab);
    return tab;
  }

  activateTab(tab) {
    if (!tab) return;
    this.active = tab;
    tab.flagged = false;
    for (const t of this.tabs) t.view.classList.toggle('hidden', t !== tab);
    this.renderTabs();
    const p = tab.activePane || this.panes(tab)[0];
    if (p) this.app.setActivePane(p);
    else this.app.setActivePane(null);
  }

  tabTitle(tab) {
    if (tab.customTitle) return tab.customTitle;
    const p = tab.activePane || this.panes(tab)[0];
    return p ? p.title : 'New tab';
  }

  async closeTab(tab, { confirm = true } = {}) {
    const panes = this.panes(tab);
    if (confirm && !(await this.app.confirmClosePanes(panes))) return;
    panes.forEach((p) => p.dispose());
    const idx = this.tabs.indexOf(tab);
    this.tabs.splice(idx, 1);
    tab.view.remove();
    if (this.active === tab) this.activateTab(this.tabs[Math.min(idx, this.tabs.length - 1)] || this.newTab());
    else this.renderTabs();
    this.app.saveWorkspace();
  }

  renderTabs() {
    this.tabsEl.replaceChildren(
      ...this.tabs.map((tab, i) => {
        const n = this.panes(tab).length;
        const anyConnected = this.panes(tab).some((p) => p.state === 'connected');
        const el = h(
          'div.tab',
          { draggable: 'true', title: `${this.tabTitle(tab)}${i < 9 ? `  (Alt+${i + 1})` : ''}` },
          tab.color ? h('span.tab-color', { style: { background: tab.color } }) : h('span.tab-color', { style: { background: anyConnected ? 'var(--ok)' : n ? 'var(--text-faint)' : 'transparent' } }),
          tab.broadcast ? h('span.bc', { html: icon('broadcast'), title: 'Broadcasting' }) : null,
          h('span.title', { style: tab.flagged ? { color: 'var(--warn)' } : null }, this.tabTitle(tab)),
          n > 1 ? h('span.count', n) : null,
          h('span.close', { html: icon('x'), title: 'Close tab', on: { click: (e) => (e.stopPropagation(), this.closeTab(tab)) } })
        );
        if (tab === this.active) el.classList.add('active');
        el.addEventListener('click', () => this.activateTab(tab));
        el.addEventListener('auxclick', (e) => e.button === 1 && this.closeTab(tab));
        el.addEventListener('dblclick', () => this.renameTab(tab));
        el.addEventListener('contextmenu', (e) => {
          e.preventDefault();
          this.tabMenu(tab, e.clientX, e.clientY);
        });
        el.addEventListener('dragstart', (e) => {
          this.dragTab = tab;
          e.dataTransfer.setData('application/x-tt-tab', tab.id);
        });
        el.addEventListener('dragend', () => (this.dragTab = null));
        el.addEventListener('dragover', (e) => {
          if (this.dragTab || this.dragPane || e.dataTransfer.types.includes('application/x-tt-session')) {
            e.preventDefault();
            el.classList.add('dragover');
            if (this.dragPane && this.active !== tab) clearTimeout(this._hover), (this._hover = setTimeout(() => this.activateTab(tab), 600));
          }
        });
        el.addEventListener('dragleave', () => {
          el.classList.remove('dragover');
          clearTimeout(this._hover);
        });
        el.addEventListener('drop', (e) => {
          e.preventDefault();
          el.classList.remove('dragover');
          clearTimeout(this._hover);
          if (this.dragTab && this.dragTab !== tab) {
            const from = this.tabs.indexOf(this.dragTab);
            this.tabs.splice(from, 1);
            this.tabs.splice(this.tabs.indexOf(tab) + (from <= i ? 1 : 0), 0, this.dragTab);
            this.renderTabs();
            this.app.saveWorkspace();
          } else if (this.dragPane) {
            this.movePaneToTab(this.dragPane, tab);
          } else {
            const sid = e.dataTransfer.getData('application/x-tt-session');
            if (sid) {
              this.activateTab(tab);
              this.app.openSession(sid, { where: 'split' });
            }
          }
        });
        return el;
      })
    );
    const at = this.tabsEl.querySelector('.tab.active');
    at && at.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    document.title = this.active ? `${this.tabTitle(this.active)} – TorTerminal` : 'TorTerminal';
  }

  tabMenu(tab, x, y) {
    contextMenu(x, y, [
      { label: 'Rename tab…', icon: 'edit', action: () => this.renameTab(tab) },
      { label: 'Color', submenu: TAB_COLORS.map((c) => ({ label: c || 'None', action: () => ((tab.color = c), this.renderTabs(), this.app.saveWorkspace()) })) },
      { label: 'Tile panes', icon: 'grid', action: () => this.tile(tab) },
      { label: tab.broadcast ? 'Stop broadcasting' : 'Broadcast input to all panes', icon: 'broadcast', action: () => this.app.toggleBroadcast(tab) },
      { label: 'Duplicate tab', icon: 'copy', action: () => this.duplicateTab(tab) },
      '-',
      { label: 'Close other tabs', action: () => this.tabs.filter((t) => t !== tab).forEach((t) => this.closeTab(t)) },
      { label: 'Close tab', icon: 'x', danger: true, action: () => this.closeTab(tab) },
    ]);
  }

  async renameTab(tab) {
    const t = await promptDialog('Tab title (empty = automatic):', this.tabTitle(tab), { title: 'Rename tab' });
    if (t === null) return;
    tab.customTitle = t.trim();
    this.renderTabs();
    this.app.saveWorkspace();
  }

  duplicateTab(tab) {
    const data = this.serializeNode(tab.root);
    const nt = this.newTab({ title: tab.customTitle, color: tab.color });
    nt.root = this.restoreNode(data);
    this.render(nt);
    this.activateTab(nt);
    this.app.saveWorkspace();
  }

  flagTab(pane) {
    const loc = this.locate(pane);
    if (loc && loc.tab !== this.active) {
      loc.tab.flagged = true;
      this.renderTabs();
    }
  }

  // ------------------------------------------------------------------ tree helpers

  panes(tab) {
    const out = [];
    const walk = (n) => {
      if (!n) return;
      if (n.type === 'pane') out.push(n.pane);
      else n.children.forEach(walk);
    };
    walk(tab.root);
    return out;
  }

  allPanes() {
    return this.tabs.flatMap((t) => this.panes(t));
  }

  /** Find a pane: { tab, node, parent, index } */
  locate(pane) {
    for (const tab of this.tabs) {
      const r = this.findNode(tab.root, (n) => n.type === 'pane' && n.pane === pane);
      if (r) return { tab, ...r };
    }
    return null;
  }

  findNode(node, pred, parent = null, index = -1) {
    if (!node) return null;
    if (pred(node)) return { node, parent, index };
    if (node.type === 'split') {
      for (let i = 0; i < node.children.length; i++) {
        const r = this.findNode(node.children[i], pred, node, i);
        if (r) return r;
      }
    }
    return null;
  }

  addPane(tab, pane, { dir = 'row', target = null } = {}) {
    if (!tab.root) tab.root = { type: 'pane', pane };
    else this.insertAt(target || tab.activePane || this.panes(tab).slice(-1)[0], pane, dir, false);
    tab.activePane = pane;
    this.render(tab);
  }

  /** Insert `pane` next to `target` along `dir`. */
  insertAt(target, pane, dir, before) {
    const loc = this.locate(target);
    const leaf = { type: 'pane', pane };
    if (loc.parent && loc.parent.dir === dir) {
      const i = loc.index;
      const half = loc.parent.sizes[i] / 2;
      loc.parent.sizes[i] = half;
      loc.parent.children.splice(before ? i : i + 1, 0, leaf);
      loc.parent.sizes.splice(before ? i : i + 1, 0, half);
    } else {
      const split = { type: 'split', dir, children: before ? [leaf, loc.node] : [loc.node, leaf], sizes: [0.5, 0.5] };
      if (loc.parent) loc.parent.children[loc.index] = split;
      else loc.tab.root = split;
    }
    return loc.tab;
  }

  /** Detach a pane from its tree (without disposing). Returns the tab it was in. */
  detach(pane) {
    const loc = this.locate(pane);
    if (!loc) return null;
    const { tab, parent, index } = loc;
    if (tab.zoomed === pane) tab.zoomed = null;
    if (!parent) tab.root = null;
    else {
      parent.children.splice(index, 1);
      const [removed] = parent.sizes.splice(index, 1);
      const sum = parent.sizes.reduce((a, b) => a + b, 0) || 1;
      parent.sizes = parent.sizes.map((s) => s / sum);
      void removed;
      if (parent.children.length === 1) {
        const only = parent.children[0];
        const gp = this.findNode(tab.root, (n) => n === parent);
        if (gp.parent) gp.parent.children[gp.index] = only;
        else tab.root = only;
        // merge same-direction nested splits
        if (only.type === 'split' && gp.parent && gp.parent.dir === only.dir) {
          const s = gp.parent.sizes[gp.index];
          gp.parent.children.splice(gp.index, 1, ...only.children);
          gp.parent.sizes.splice(gp.index, 1, ...only.sizes.map((x) => x * s));
        }
      }
    }
    if (tab.activePane === pane) tab.activePane = this.panes(tab)[0] || null;
    pane.el.remove();
    return tab;
  }

  movePaneToTab(pane, tab) {
    const from = this.detach(pane);
    this.addPane(tab, pane, { dir: 'row' });
    if (from && from !== tab) this.render(from);
    this.activateTab(tab);
    this.app.setActivePane(pane);
    this.app.saveWorkspace();
  }

  movePaneToNewTab(pane) {
    const tab = this.newTab({ activate: false });
    this.movePaneToTab(pane, tab);
  }

  // ------------------------------------------------------------------ rendering

  render(tab) {
    if (!tab) return;
    tab.view.replaceChildren();
    if (!tab.root) {
      tab.view.append(this.app.welcomeView(tab));
    } else if (tab.zoomed) {
      tab.view.append(tab.zoomed.el);
    } else {
      tab.view.append(this.buildNode(tab.root));
    }
    for (const p of this.panes(tab)) p.zoomBtn.innerHTML = icon(tab.zoomed === p ? 'minimize' : 'maximize');
    if (tab === this.active) this.renderTabs();
  }

  buildNode(node) {
    if (node.type === 'pane') {
      this.attachDrop(node.pane);
      return node.pane.el;
    }
    const wrap = h(`div.split.${node.dir}`);
    node.children.forEach((child, i) => {
      if (i > 0) wrap.append(this.gutter(node, i, wrap));
      const cell = h('div.cell', { style: { flex: `${node.sizes[i]} 1 0px` } }, this.buildNode(child));
      wrap.append(cell);
    });
    return wrap;
  }

  gutter(node, i, wrap) {
    const g = h('div.gutter');
    g.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const horizontal = node.dir === 'row';
      const rect = wrap.getBoundingClientRect();
      const total = horizontal ? rect.width : rect.height;
      const start = horizontal ? e.clientX : e.clientY;
      const a0 = node.sizes[i - 1];
      const b0 = node.sizes[i];
      const cells = wrap.querySelectorAll(':scope > .cell');
      const shield = h('div', { style: { position: 'fixed', inset: '0', zIndex: 999, cursor: horizontal ? 'col-resize' : 'row-resize' } });
      document.body.append(shield);
      g.classList.add('drag');
      const move = (ev) => {
        const d = ((horizontal ? ev.clientX : ev.clientY) - start) / total;
        const min = 0.04;
        const a = Math.max(min, Math.min(a0 + b0 - min, a0 + d));
        node.sizes[i - 1] = a;
        node.sizes[i] = a0 + b0 - a;
        cells[i - 1].style.flex = `${node.sizes[i - 1]} 1 0px`;
        cells[i].style.flex = `${node.sizes[i]} 1 0px`;
      };
      const up = () => {
        shield.remove();
        g.classList.remove('drag');
        removeEventListener('mousemove', move);
        removeEventListener('mouseup', up);
        this.app.saveWorkspace();
      };
      addEventListener('mousemove', move);
      addEventListener('mouseup', up);
    });
    g.addEventListener('dblclick', () => {
      const avg = (node.sizes[i - 1] + node.sizes[i]) / 2;
      node.sizes[i - 1] = node.sizes[i] = avg;
      this.render(this.locateNodeTab(node));
    });
    return g;
  }

  locateNodeTab(node) {
    return this.tabs.find((t) => this.findNode(t.root, (n) => n === node));
  }

  // ------------------------------------------------------------------ drag & drop docking

  attachDrop(pane) {
    if (pane._dropAttached) return;
    pane._dropAttached = true;
    const el = pane.el;
    let zoneEl = null;
    let zone = null;
    const accepts = (e) => (this.dragPane && this.dragPane !== pane) || e.dataTransfer.types.includes('application/x-tt-session');
    const clear = () => {
      zoneEl && zoneEl.remove();
      zoneEl = null;
      zone = null;
    };
    el.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width;
      const y = (e.clientY - r.top) / r.height;
      const isSession = !this.dragPane;
      let z = 'center';
      const m = Math.min(x, 1 - x, y, 1 - y);
      if (m < 0.3 || isSession) z = m === x ? 'left' : m === 1 - x ? 'right' : m === y ? 'top' : 'bottom';
      if (z === zone) return;
      zone = z;
      if (!zoneEl) {
        zoneEl = h('div.drop-zone');
        el.append(zoneEl);
      }
      const s = { left: '0', top: '0', width: '100%', height: '100%' };
      if (z === 'left') s.width = '50%';
      if (z === 'right') Object.assign(s, { left: '50%', width: '50%' });
      if (z === 'top') s.height = '50%';
      if (z === 'bottom') Object.assign(s, { top: '50%', height: '50%' });
      Object.assign(zoneEl.style, s);
    });
    el.addEventListener('dragleave', (e) => {
      if (!el.contains(e.relatedTarget)) clear();
    });
    el.addEventListener('drop', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      const z = zone;
      clear();
      const dir = z === 'left' || z === 'right' ? 'row' : 'col';
      const before = z === 'left' || z === 'top';
      const sid = e.dataTransfer.getData('application/x-tt-session');
      if (!this.dragPane && sid) {
        this.app.openSession(sid, { where: 'split', target: pane, dir, before });
        return;
      }
      const src = this.dragPane;
      this.dragPane = null;
      if (!src || src === pane) return;
      if (z === 'center') this.swap(src, pane);
      else {
        const fromTab = this.detach(src);
        const tab = this.insertAt(pane, src, dir, before);
        if (fromTab && fromTab !== tab) this.render(fromTab);
        this.render(tab);
      }
      this.app.setActivePane(src);
      this.app.saveWorkspace();
    });
  }

  swap(a, b) {
    const la = this.locate(a);
    const lb = this.locate(b);
    la.node.pane = b;
    lb.node.pane = a;
    this.render(la.tab);
    if (lb.tab !== la.tab) this.render(lb.tab);
  }

  // ------------------------------------------------------------------ zoom / tile / focus

  isZoomed(pane) {
    const loc = this.locate(pane);
    return !!(loc && loc.tab.zoomed === pane);
  }

  toggleZoom(pane) {
    const loc = this.locate(pane);
    if (!loc) return;
    loc.tab.zoomed = loc.tab.zoomed === pane ? null : pane;
    this.render(loc.tab);
    pane.focus();
  }

  tile(tab = this.active) {
    const panes = this.panes(tab);
    if (panes.length < 2) return;
    tab.zoomed = null;
    const cols = Math.ceil(Math.sqrt(panes.length));
    const rows = Math.ceil(panes.length / cols);
    const rowNodes = [];
    for (let r = 0; r < rows; r++) {
      const slice = panes.slice(r * cols, (r + 1) * cols).map((pane) => ({ type: 'pane', pane }));
      rowNodes.push(slice.length === 1 ? slice[0] : { type: 'split', dir: 'row', children: slice, sizes: slice.map(() => 1 / slice.length) });
    }
    tab.root = rowNodes.length === 1 ? rowNodes[0] : { type: 'split', dir: 'col', children: rowNodes, sizes: rowNodes.map(() => 1 / rowNodes.length) };
    this.render(tab);
    this.app.saveWorkspace();
  }

  focusDirection(dir) {
    const cur = this.app.activePane;
    if (!cur || !this.active) return;
    const panes = this.panes(this.active).filter((p) => p !== cur && p.el.isConnected);
    const r0 = cur.el.getBoundingClientRect();
    const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };
    let best = null;
    let bestScore = Infinity;
    for (const p of panes) {
      const r = p.el.getBoundingClientRect();
      const c = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      const dx = c.x - c0.x;
      const dy = c.y - c0.y;
      const ok = { left: dx < -10, right: dx > 10, up: dy < -10, down: dy > 10 }[dir];
      if (!ok) continue;
      const primary = dir === 'left' || dir === 'right' ? Math.abs(dx) : Math.abs(dy);
      const secondary = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx);
      const score = primary + secondary * 2;
      if (score < bestScore) {
        bestScore = score;
        best = p;
      }
    }
    if (best) {
      this.app.setActivePane(best);
      best.focus();
    }
  }

  // ------------------------------------------------------------------ persistence

  serializeNode(n) {
    if (!n) return null;
    if (n.type === 'pane') return { pane: { ...n.pane.spec, title: n.pane.customTitle || undefined } };
    return { dir: n.dir, sizes: n.sizes, children: n.children.map((c) => this.serializeNode(c)) };
  }

  restoreNode(d) {
    if (!d) return null;
    if (d.pane) return { type: 'pane', pane: this.app.createPane(d.pane) };
    const children = (d.children || []).map((c) => this.restoreNode(c)).filter(Boolean);
    if (!children.length) return null;
    if (children.length === 1) return children[0];
    const sizes = d.sizes && d.sizes.length === children.length ? d.sizes : children.map(() => 1 / children.length);
    return { type: 'split', dir: d.dir === 'col' ? 'col' : 'row', children, sizes };
  }

  serialize() {
    return {
      active: this.tabs.indexOf(this.active),
      tabs: this.tabs.map((t) => ({ title: t.customTitle, color: t.color, root: this.serializeNode(t.root) })),
    };
  }

  restore(data) {
    if (!data || !Array.isArray(data.tabs) || !data.tabs.length) return false;
    for (const t of data.tabs) {
      const tab = this.newTab({ title: t.title, color: t.color, activate: false });
      tab.root = this.restoreNode(t.root);
      tab.activePane = this.panes(tab)[0] || null;
      this.render(tab);
    }
    this.activateTab(this.tabs[data.active] || this.tabs[0]);
    return true;
  }
}

