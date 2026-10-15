'use strict';
// TorTerminal server: static web UI, REST API and one WebSocket per terminal pane.

const http = require('http');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const iconv = require('iconv-lite');

const store = require('./store');
const { SessionLogger, listLogs, logPath } = require('./logger');
const ssh = require('./protocols/ssh');
const { connectTelnet, connectRaw } = require('./protocols/telnet');
const serial = require('./protocols/serial');
const local = require('./protocols/local');
const assistant = require('./assistant');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 7070;
const PASSWORD = process.env.TORTERM_PASSWORD || '';
const LOCAL_NAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

const PROTOCOLS = {
  ssh: ssh.connect,
  telnet: connectTelnet,
  raw: connectRaw,
  serial: serial.connect,
  local: local.connect,
};

// ---------------------------------------------------------------------------
// Auth & request hardening
// ---------------------------------------------------------------------------

const tokens = new Set();

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function isAuthed(req) {
  return !PASSWORD || tokens.has(cookies(req).tt_token);
}

/** Blocks cross-site requests and DNS-rebinding against the local shell. */
function trustedOrigin(req) {
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '');
  if (!PASSWORD && !LOCAL_NAMES.has(hostname)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

const app = express();
app.disable('x-powered-by');

app.use((req, res, next) => {
  if (!trustedOrigin(req)) return res.status(403).send('Forbidden origin');
  next();
});

app.post('/api/login', express.json(), (req, res) => {
  const given = String((req.body && req.body.password) || '');
  const ok =
    PASSWORD &&
    given.length === PASSWORD.length &&
    crypto.timingSafeEqual(Buffer.from(given), Buffer.from(PASSWORD));
  if (!ok) return res.status(401).json({ error: 'Invalid password' });
  const t = crypto.randomBytes(32).toString('hex');
  tokens.add(t);
  res.setHeader('Set-Cookie', `tt_token=${t}; HttpOnly; SameSite=Strict; Path=/`);
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  tokens.delete(cookies(req).tt_token);
  res.setHeader('Set-Cookie', 'tt_token=; Max-Age=0; Path=/');
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (isAuthed(req) || req.path === '/login.html' || req.path.startsWith('/css/')) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login.html');
});

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------

const nm = path.join(__dirname, '..', 'node_modules', '@xterm');
app.use('/vendor/xterm', express.static(path.join(nm, 'xterm')));
for (const a of ['fit', 'search', 'web-links', 'unicode11', 'webgl']) {
  app.use(`/vendor/addon-${a}`, express.static(path.join(nm, `addon-${a}`)));
}
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

const api = express.Router();
api.use(express.json({ limit: '5mb' }));

const wrap = (fn) => (req, res) => {
  Promise.resolve()
    .then(() => fn(req, res))
    .then((out) => out !== undefined && res.json(out))
    .catch((e) => res.status(400).json({ error: e.message }));
};

api.get('/capabilities', wrap(() => ({
  pty: local.hasPty(),
  serial: serial.available(),
  shells: local.detectShells(),
  platform: process.platform,
  auth: !!PASSWORD,
})));

api.get('/sessions', wrap(() => store.listSessions()));
api.post('/sessions', wrap((req) => store.saveSession(req.body)));
api.delete('/sessions/:id', wrap((req) => (store.deleteSession(req.params.id), { ok: true })));
api.post('/folders/rename', wrap((req) => (store.renameFolder(req.body.from, req.body.to), { ok: true })));
api.get('/sessions/export', wrap((req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="torterminal-sessions.json"');
  return store.exportSessions(req.query.secrets === '1');
}));
api.post('/sessions/import', wrap((req) => ({ count: store.importSessions(req.body.sessions, !!req.body.replace) })));

for (const doc of ['buttons', 'settings', 'highlights']) {
  api.get(`/${doc}`, wrap(() => store.getDoc(doc, null)));
  api.put(`/${doc}`, wrap((req) => (store.putDoc(doc, req.body), { ok: true })));
}

api.get('/known-hosts', wrap(() => store.knownHosts()));
api.delete('/known-hosts/:key', wrap((req) => (store.deleteKnownHost(req.params.key), { ok: true })));

api.get('/serial/ports', wrap(() => serial.listPorts()));

// Claude assistant: connection status, API key and preferences. The key is never sent back.
api.get('/ai/status', wrap((req) => assistant.status(req.query.refresh === '1')));
api.post('/ai/key', wrap((req) => assistant.connectWithKey(req.body && req.body.apiKey)));
api.delete('/ai/key', wrap(() => (assistant.disconnect(), assistant.status(true))));
api.put('/ai/config', wrap((req) => (assistant.saveConfig(req.body || {}), assistant.status(true))));

api.get('/logs', wrap(() => listLogs()));
api.get('/logs/:name', (req, res) => {
  const p = logPath(req.params.name);
  if (!p) return res.status(404).end();
  if (req.query.download) res.download(p);
  else res.type('text/plain; charset=utf-8').sendFile(p);
});
api.delete('/logs/:name', wrap((req) => {
  const p = logPath(req.params.name);
  if (p) require('fs').unlinkSync(p);
  return { ok: true };
}));

// SFTP transfers stream over HTTP; the connection id is an unguessable UUID.
const liveConnections = new Map();

async function sftpFor(req) {
  const t = liveConnections.get(req.params.conn);
  if (!t || !t.handle || !t.handle.sftp) throw new Error('No SFTP-capable connection');
  return t.handle.sftp();
}

api.get('/sftp/:conn/download', async (req, res) => {
  try {
    const sftp = await sftpFor(req);
    const p = String(req.query.path);
    const st = await new Promise((ok, no) => sftp.stat(p, (e, s) => (e ? no(e) : ok(s))));
    res.setHeader('Content-Length', st.size);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(path.posix.basename(p))}`);
    sftp.createReadStream(p).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

api.post('/sftp/:conn/upload', async (req, res) => {
  try {
    const sftp = await sftpFor(req);
    const ws = sftp.createWriteStream(String(req.query.path));
    ws.on('error', (e) => res.status(400).json({ error: e.message }));
    ws.on('close', () => res.headersSent || res.json({ ok: true }));
    req.pipe(ws);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.use('/api', api);

// ---------------------------------------------------------------------------
// Terminal sessions over WebSocket
// ---------------------------------------------------------------------------

const SFTP_OPS = {
  home: (s) => new Promise((ok, no) => s.realpath('.', (e, p) => (e ? no(e) : ok(p)))),
  realpath: (s, m) => new Promise((ok, no) => s.realpath(m.path, (e, p) => (e ? no(e) : ok(p)))),
  list: (s, m) =>
    new Promise((ok, no) =>
      s.readdir(m.path, (e, list) =>
        e
          ? no(e)
          : ok(
              list.map((f) => ({
                name: f.filename,
                size: f.attrs.size,
                mtime: f.attrs.mtime * 1000,
                mode: f.attrs.mode,
                isDir: (f.attrs.mode & 0o170000) === 0o040000,
                isLink: (f.attrs.mode & 0o170000) === 0o120000,
                longname: f.longname,
              }))
            )
      )
    ),
  mkdir: (s, m) => new Promise((ok, no) => s.mkdir(m.path, (e) => (e ? no(e) : ok(true)))),
  rename: (s, m) => new Promise((ok, no) => s.rename(m.from, m.to, (e) => (e ? no(e) : ok(true)))),
  chmod: (s, m) => new Promise((ok, no) => s.chmod(m.path, parseInt(m.mode, 8), (e) => (e ? no(e) : ok(true)))),
  delete: async function del(s, m) {
    const st = await new Promise((ok, no) => s.lstat(m.path, (e, a) => (e ? no(e) : ok(a))));
    if (st.isDirectory()) {
      const items = await SFTP_OPS.list(s, m);
      for (const it of items) if (it.name !== '.' && it.name !== '..') await del(s, { path: path.posix.join(m.path, it.name) });
      await new Promise((ok, no) => s.rmdir(m.path, (e) => (e ? no(e) : ok())));
    } else await new Promise((ok, no) => s.unlink(m.path, (e) => (e ? no(e) : ok())));
    return true;
  },
  readText: (s, m) =>
    new Promise((ok, no) => {
      const chunks = [];
      let size = 0;
      const rs = s.createReadStream(m.path);
      rs.on('data', (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) {
          rs.destroy();
          no(new Error('File too large to edit (>2MB)'));
        } else chunks.push(c);
      });
      rs.on('error', no);
      rs.on('end', () => ok(Buffer.concat(chunks).toString('utf8')));
    }),
  writeText: (s, m) =>
    new Promise((ok, no) => s.writeFile(m.path, String(m.content), (e) => (e ? no(e) : ok(true)))),
};

class TermSession {
  constructor(ws) {
    this.ws = ws;
    this.id = crypto.randomUUID();
    this.handle = null;
    this.logger = null;
    this.pending = new Map();
    this.cols = 80;
    this.rows = 24;
    this.closedNotified = false;
    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('close', () => this.dispose());
    ws.on('error', () => this.dispose());
  }

  send(obj) {
    if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  info(msg, level = 'info') {
    this.send({ t: 'info', msg, level });
  }

  ask(type, payload) {
    const id = crypto.randomUUID();
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.send({ t: type, id, ...payload });
    });
  }

  output(buf) {
    if (this.logger) this.logger.write(buf);
    if (this.decoder) {
      const s = this.decoder.write(buf);
      if (!s) return;
      buf = Buffer.from(s, 'utf8');
    }
    if (this.ws.readyState === 1) this.ws.send(buf, { binary: true });
  }

  encodeInput(str) {
    return this.encoding ? iconv.encode(str, this.encoding) : Buffer.from(str, 'utf8');
  }

  async connect(msg) {
    if (this.handle) return;
    let o = {};
    if (msg.sessionId) {
      o = store.getSession(msg.sessionId);
      if (!o) return this.send({ t: 'status', state: 'error', msg: 'Saved session not found' });
    }
    o = { ...o, ...(msg.overrides || {}) };
    if (o.jumpHostId && !o.jumpHost) o.jumpHost = store.getSession(o.jumpHostId);
    this.cols = Number(msg.cols) || 80;
    this.rows = Number(msg.rows) || 24;
    this.label = o.name || o.host || o.serialPort || o.protocol;
    this.vars = { username: o.username || '', password: o.password || '' };
    const enc = String(o.encoding || 'utf-8').toLowerCase();
    if (enc !== 'utf-8' && enc !== 'utf8' && iconv.encodingExists(enc)) {
      this.encoding = enc;
      this.decoder = iconv.getDecoder(enc);
    }

    const fn = PROTOCOLS[o.protocol];
    if (!fn) return this.send({ t: 'status', state: 'error', msg: `Unknown protocol "${o.protocol}"` });

    const self = this;
    const ctx = {
      get cols() {
        return self.cols;
      },
      get rows() {
        return self.rows;
      },
      data: (b) => this.output(b),
      info: (m, l) => this.info(m, l),
      prompt: (p) => this.ask('prompt', p),
      hostKey: (k) => this.ask('hostkey', k),
      remoteEcho: (on) => this.send({ t: 'echo', remote: on }),
      remember: (k, v) => (this.vars[k] = v),
      closed: (reason) => {
        if (this.closedNotified) return;
        this.closedNotified = true;
        this.stopLog();
        this.send({ t: 'status', state: 'closed', msg: reason });
      },
    };

    this.send({ t: 'status', state: 'connecting' });
    try {
      this.handle = await fn(o, ctx);
    } catch (e) {
      this.send({ t: 'status', state: 'error', msg: e.message || String(e) });
      return;
    }
    if (this.ws.readyState !== 1) return this.dispose();
    liveConnections.set(this.id, this);
    this.send({ t: 'status', state: 'connected', connId: this.id, sftp: !!this.handle.sftp });
    if (o.logEnabled) this.startLog({ mode: o.logMode, timestamps: o.logTimestamps });
  }

  startLog(opts) {
    if (this.logger) return;
    this.logger = new SessionLogger(this.label, opts);
    this.send({ t: 'log', on: true, file: this.logger.name });
  }

  stopLog() {
    if (!this.logger) return;
    this.logger.close();
    this.logger = null;
    this.send({ t: 'log', on: false });
  }

  async onMessage(data, isBinary) {
    if (isBinary) {
      this.handle && this.handle.write(Buffer.from(data));
      return;
    }
    let m;
    try {
      m = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (m.t) {
      case 'connect':
        return this.connect(m);
      case 'i': {
        if (!this.handle) return;
        let d = String(m.d);
        // Scripted input (buttons, logon scripts) may reference saved credentials.
        if (m.subst) d = d.replace(/\$\{(username|password)\}/g, (_, k) => this.vars[k] || '');
        this.handle.write(this.encodeInput(d));
        return;
      }
      case 'resize':
        this.cols = Math.max(1, Number(m.cols) | 0);
        this.rows = Math.max(1, Number(m.rows) | 0);
        if (this.handle) this.handle.resize(this.cols, this.rows);
        return;
      case 'reply': {
        const r = this.pending.get(m.id);
        if (r) {
          this.pending.delete(m.id);
          r(m.value);
        }
        return;
      }
      case 'special':
        if (this.handle) this.handle.special(m.cmd);
        return;
      case 'log':
        if (m.on) this.startLog(m);
        else this.stopLog();
        return;
      case 'sftp': {
        try {
          if (!this.handle || !this.handle.sftp) throw new Error('SFTP is only available on SSH connections');
          const op = SFTP_OPS[m.op];
          if (!op) throw new Error(`Unknown SFTP op ${m.op}`);
          const s = await this.handle.sftp();
          this.send({ t: 'sftp', id: m.id, ok: true, result: await op(s, m) });
        } catch (e) {
          this.send({ t: 'sftp', id: m.id, ok: false, error: e.message || String(e) });
        }
        return;
      }
      case 'ping':
        return this.send({ t: 'pong' });
    }
  }

  dispose() {
    for (const r of this.pending.values()) r(null);
    this.pending.clear();
    this.stopLog();
    liveConnections.delete(this.id);
    if (this.handle) {
      try {
        this.handle.close();
      } catch {}
      this.handle = null;
    }
  }
}

// One misbehaving connection must never take down every other session.
process.on('uncaughtException', (e) => console.error('[uncaught]', e && e.stack ? e.stack : e));
process.on('unhandledRejection', (e) => console.error('[unhandled rejection]', e && e.stack ? e.stack : e));

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/ws') || !trustedOrigin(req) || !isAuthed(req)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  if (req.url.startsWith('/ws/ai')) wss.handleUpgrade(req, socket, head, (ws) => new assistant.AiSocket(ws));
  else wss.handleUpgrade(req, socket, head, (ws) => new TermSession(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`TorTerminal running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && !PASSWORD) {
    console.warn('WARNING: listening on a non-local address without TORTERM_PASSWORD. Remote access is blocked until you set one.');
  }
  console.log(`Local PTY: ${local.hasPty() ? 'yes' : 'no'}   Serial: ${serial.available() ? 'yes' : 'no'}   Auth: ${PASSWORD ? 'on' : 'off'}`);
});
