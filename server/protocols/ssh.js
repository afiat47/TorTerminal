'use strict';
// SSH client: password / public key / agent / keyboard-interactive auth,
// host key verification, jump hosts, local/remote/dynamic (SOCKS5) port
// forwarding, agent forwarding, remote command and SFTP.

const net = require('net');
const crypto = require('crypto');
const { Client, utils } = require('ssh2');
const C = require('ssh2/lib/protocol/constants');
const store = require('../store');

const LEGACY_ALGOS = {
  kex: C.SUPPORTED_KEX,
  cipher: C.SUPPORTED_CIPHER,
  serverHostKey: C.SUPPORTED_SERVER_HOST_KEY,
  hmac: C.SUPPORTED_MAC,
};

function keyInfo(raw) {
  let type = 'unknown';
  try {
    const len = raw.readUInt32BE(0);
    type = raw.subarray(4, 4 + len).toString('ascii');
  } catch {}
  const fingerprint = 'SHA256:' + crypto.createHash('sha256').update(raw).digest('base64').replace(/=+$/, '');
  const md5 = crypto
    .createHash('md5')
    .update(raw)
    .digest('hex')
    .replace(/(..)(?!$)/g, '$1:');
  return { type, fingerprint, md5 };
}

/** Resolve a usable private key, prompting for a passphrase when needed. */
async function preparePrivateKey(o, ctx, label) {
  if (!o.privateKey) return null;
  let passphrase = o.passphrase || undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    const parsed = utils.parseKey(o.privateKey, passphrase);
    if (!(parsed instanceof Error)) return { key: o.privateKey, passphrase };
    if (!/encrypted|passphrase|bad decrypt/i.test(parsed.message)) {
      ctx.info(`Private key error: ${parsed.message}`, 'error');
      return null;
    }
    const ans = await ctx.prompt({
      title: `${label}: key passphrase`,
      instructions: attempt ? 'Wrong passphrase, try again.' : 'The private key is encrypted.',
      prompts: [{ prompt: 'Passphrase for key:', echo: false }],
    });
    if (!ans) return null;
    passphrase = ans[0];
  }
  return null;
}

/** Open and authenticate an SSH client. Resolves with the ready Client. */
async function openClient(o, ctx, { sock, label } = {}) {
  label = label || `${o.host}`;
  let username = o.username;
  if (!username) {
    const ans = await ctx.prompt({ title: `${label}`, prompts: [{ prompt: 'login as:', echo: true }] });
    if (!ans || !ans[0]) throw new Error('No username given');
    username = ans[0];
    ctx.remember && ctx.remember('username', username);
  }
  const pk = await preparePrivateKey(o, ctx, label);
  const timeoutMs = (Number(o.connectTimeout) || 20) * 1000;
  let timer = null;
  let handshakeDone = false;
  let timeoutHandler = () => {};
  const pauseTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  const armTimer = () => {
    pauseTimer();
    if (!handshakeDone) timer = setTimeout(() => timeoutHandler(), timeoutMs);
  };
  const port = Number(o.port) || 22;
  const hostId = `${o.host}:${port}`;

  // Ordered auth attempts, then an interactive password prompt fallback.
  const queue = [];
  if (o.useAgent) {
    const agent = process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK;
    if (agent) queue.push({ type: 'agent', username, agent });
  }
  if (pk) queue.push({ type: 'publickey', username, key: pk.key, passphrase: pk.passphrase });
  if (o.password) queue.push({ type: 'password', username, password: o.password });
  let usedSavedPasswordForKbd = false;
  queue.push({
    type: 'keyboard-interactive',
    username,
    prompt: (name, instructions, lang, prompts, finish) => {
      if (!prompts.length) return finish([]);
      if (o.password && !usedSavedPasswordForKbd && prompts.length === 1 && /pass/i.test(prompts[0].prompt)) {
        usedSavedPasswordForKbd = true;
        return finish([o.password]);
      }
      ctx
        .prompt({ title: name || `${username}@${label}`, instructions, prompts })
        .then((ans) => finish(ans || prompts.map(() => '')));
    },
  });
  let passwordPrompts = 0;

  const authHandler = (methodsLeft, partialSuccess, cb) => {
    while (queue.length) {
      const next = queue.shift();
      if (!methodsLeft || methodsLeft.includes(next.type) || (next.type === 'agent' && methodsLeft.includes('publickey'))) {
        return cb(next);
      }
    }
    if ((!methodsLeft || methodsLeft.includes('password')) && passwordPrompts < 3) {
      passwordPrompts++;
      ctx
        .prompt({
          title: `${username}@${label}`,
          instructions: passwordPrompts > 1 ? 'Access denied' : '',
          prompts: [{ prompt: `${username}@${o.host}'s password:`, echo: false }],
        })
        .then((ans) => {
          if (ans) ctx.remember && ctx.remember('password', ans[0]);
          cb(ans ? { type: 'password', username, password: ans[0] } : false);
        });
      return;
    }
    cb(false);
  };

  const hostVerifier = (raw, verify) => {
    const info = keyInfo(raw);
    const known = store.knownHosts()[hostId];
    if (known && known.fingerprint === info.fingerprint) return verify(true);
    if (o.skipHostKeyCheck) return verify(true);
    pauseTimer(); // don't count the time the user spends reading the dialog
    ctx
      .hostKey({
        host: o.host,
        port,
        keyType: info.type,
        fingerprint: info.fingerprint,
        md5: info.md5,
        status: known ? 'changed' : 'new',
        oldFingerprint: known ? known.fingerprint : undefined,
      })
      .then((res) => {
        if (res && res.accept && res.save) store.setKnownHost(hostId, { keyType: info.type, fingerprint: info.fingerprint });
        armTimer();
        verify(!!(res && res.accept));
      });
  };

  const cfg = {
    host: o.host,
    port,
    sock,
    username,
    authHandler,
    hostVerifier,
    tryKeyboard: true,
    // ssh2's readyTimeout also covers authentication, which would expire while the
    // user is typing a password; we time only the connect + handshake ourselves.
    readyTimeout: 0,
    keepaliveInterval: (Number(o.keepalive) || 0) * 1000,
    keepaliveCountMax: 3,
    agentForward: !!o.agentForward && !!o.useAgent,
    agent: o.useAgent ? (process.platform === 'win32' ? 'pageant' : process.env.SSH_AUTH_SOCK) : undefined,
    compress: !!o.compression,
  };
  if (o.legacyAlgorithms) cfg.algorithms = LEGACY_ALGOS;

  const conn = new Client();
  await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      handshakeDone = true;
      pauseTimer();
      if (err) {
        try {
          conn.end();
        } catch {}
        reject(err);
      } else resolve();
    };
    timeoutHandler = () => finish(new Error('Timed out while waiting for handshake'));
    conn.once('ready', () => finish());
    // Keep a listener for the client's whole life: a late auth failure (e.g. a prompt
    // answered after the connection already failed) must not crash the server.
    conn.on('error', (e) => finish(e));
    conn.once('close', () => finish(new Error('Connection closed during authentication')));
    conn.once('handshake', () => {
      handshakeDone = true;
      pauseTimer();
    });
    conn.on('banner', (msg) => ctx.data(Buffer.from(msg.replace(/\r?\n/g, '\r\n'))));
    try {
      armTimer();
      conn.connect(cfg);
    } catch (e) {
      finish(e);
    }
  });
  return conn;
}

function forwardOut(conn, host, port) {
  return new Promise((resolve, reject) =>
    conn.forwardOut('127.0.0.1', 0, host, Number(port), (err, ch) => (err ? reject(err) : resolve(ch)))
  );
}

function pipeBoth(a, b) {
  a.pipe(b).pipe(a);
  const end = () => {
    a.destroy?.();
    b.destroy?.();
  };
  a.on('error', end);
  b.on('error', end);
  a.on('close', end);
  b.on('close', end);
}

// ---------- port forwarding ----------

function startLocalForward(conn, rule, ctx) {
  const server = net.createServer((sock) => {
    conn.forwardOut(sock.remoteAddress || '127.0.0.1', sock.remotePort || 0, rule.dstHost, Number(rule.dstPort), (err, ch) => {
      if (err) {
        ctx.info(`Forward L${rule.bindPort} -> ${rule.dstHost}:${rule.dstPort} failed: ${err.message}`, 'error');
        return sock.destroy();
      }
      pipeBoth(sock, ch);
    });
  });
  server.on('error', (e) => ctx.info(`Local forward ${rule.bindPort} error: ${e.message}`, 'error'));
  server.listen(Number(rule.bindPort), rule.bindAddr || '127.0.0.1', () =>
    ctx.info(`Local forward ${rule.bindAddr || '127.0.0.1'}:${rule.bindPort} -> ${rule.dstHost}:${rule.dstPort}`)
  );
  return server;
}

function startDynamicForward(conn, rule, ctx) {
  // Minimal SOCKS5 (no auth, CONNECT only) and SOCKS4/4a.
  const server = net.createServer((sock) => {
    sock.once('data', (buf) => {
      if (buf[0] === 0x04) return socks4(sock, buf);
      if (buf[0] !== 0x05) return sock.destroy();
      sock.write(Buffer.from([0x05, 0x00]));
      sock.once('data', (req) => {
        if (req[0] !== 0x05 || req[1] !== 0x01) {
          sock.end(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          return;
        }
        let host;
        let off;
        if (req[3] === 0x01) {
          host = Array.from(req.subarray(4, 8)).join('.');
          off = 8;
        } else if (req[3] === 0x03) {
          const len = req[4];
          host = req.subarray(5, 5 + len).toString();
          off = 5 + len;
        } else if (req[3] === 0x04) {
          const parts = [];
          for (let i = 0; i < 16; i += 2) parts.push(req.readUInt16BE(4 + i).toString(16));
          host = parts.join(':');
          off = 20;
        } else return sock.destroy();
        const port = req.readUInt16BE(off);
        conn.forwardOut('127.0.0.1', 0, host, port, (err, ch) => {
          if (err) {
            sock.end(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
            return;
          }
          sock.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          pipeBoth(sock, ch);
        });
      });
    });
    sock.on('error', () => {});
  });
  function socks4(sock, buf) {
    const port = buf.readUInt16BE(2);
    let host = Array.from(buf.subarray(4, 8)).join('.');
    const userEnd = buf.indexOf(0, 8);
    if (host.startsWith('0.0.0.') && userEnd >= 0) {
      const hostEnd = buf.indexOf(0, userEnd + 1);
      host = buf.subarray(userEnd + 1, hostEnd).toString();
    }
    conn.forwardOut('127.0.0.1', 0, host, port, (err, ch) => {
      const reply = Buffer.from([0x00, err ? 0x5b : 0x5a, 0, 0, 0, 0, 0, 0]);
      if (err) return sock.end(reply);
      sock.write(reply);
      pipeBoth(sock, ch);
    });
  }
  server.on('error', (e) => ctx.info(`SOCKS proxy ${rule.bindPort} error: ${e.message}`, 'error'));
  server.listen(Number(rule.bindPort), rule.bindAddr || '127.0.0.1', () =>
    ctx.info(`Dynamic SOCKS proxy on ${rule.bindAddr || '127.0.0.1'}:${rule.bindPort}`)
  );
  return server;
}

function startRemoteForwards(conn, rules, ctx) {
  if (!rules.length) return;
  conn.on('tcp connection', (info, accept, reject) => {
    const rule = rules.find((r) => Number(r.bindPort) === info.destPort);
    if (!rule) return reject();
    const ch = accept();
    const sock = net.connect(Number(rule.dstPort), rule.dstHost || '127.0.0.1');
    pipeBoth(sock, ch);
  });
  for (const r of rules) {
    conn.forwardIn(r.bindAddr || '127.0.0.1', Number(r.bindPort), (err) => {
      if (err) ctx.info(`Remote forward ${r.bindPort} failed: ${err.message}`, 'error');
      else ctx.info(`Remote forward ${r.bindAddr || '127.0.0.1'}:${r.bindPort} -> ${r.dstHost}:${r.dstPort}`);
    });
  }
}

// ---------- main entry ----------

async function connect(o, ctx) {
  const cleanup = [];
  let sock;
  if (o.jumpHost && o.jumpHost.host) {
    ctx.info(`Connecting to jump host ${o.jumpHost.host}...`);
    const jump = await openClient(o.jumpHost, ctx, { label: `jump ${o.jumpHost.host}` });
    cleanup.push(() => jump.end());
    sock = await forwardOut(jump, o.host, Number(o.port) || 22);
    ctx.info(`Tunnelled through ${o.jumpHost.host}`);
  }

  let conn;
  try {
    conn = await openClient(o, ctx, { sock, label: o.host });
  } catch (e) {
    cleanup.forEach((f) => f());
    throw e;
  }

  const servers = [];
  const forwards = Array.isArray(o.forwards) ? o.forwards.filter((f) => f && f.bindPort) : [];
  for (const f of forwards) {
    if (f.type === 'L') servers.push(startLocalForward(conn, f, ctx));
    else if (f.type === 'D') servers.push(startDynamicForward(conn, f, ctx));
  }
  startRemoteForwards(
    conn,
    forwards.filter((f) => f.type === 'R'),
    ctx
  );

  const pty = { term: o.term || 'xterm-256color', cols: ctx.cols, rows: ctx.rows };
  const env = {};
  for (const line of String(o.env || '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }

  const stream = await new Promise((resolve, reject) => {
    const cb = (err, s) => (err ? reject(err) : resolve(s));
    if (o.remoteCommand) conn.exec(o.remoteCommand, { pty, env }, cb);
    else conn.shell(pty, { env }, cb);
  });

  stream.on('data', (d) => ctx.data(d));
  stream.stderr.on('data', (d) => ctx.data(d));

  let sftpPromise = null;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    servers.forEach((s) => s.close());
    try {
      conn.end();
    } catch {}
    cleanup.forEach((f) => f());
  };
  stream.on('close', (code) => {
    ctx.closed(code != null ? `Remote shell exited (${code})` : 'Connection closed');
    close();
  });
  conn.on('error', (e) => ctx.info(`SSH error: ${e.message}`, 'error'));
  conn.on('close', () => {
    ctx.closed('Connection closed');
    close();
  });

  return {
    write: (buf) => stream.write(buf),
    resize: (cols, rows) => stream.setWindow(rows, cols, 0, 0),
    special: (cmd) => {
      const sig = { int: 'INT', term: 'TERM', kill: 'KILL', hup: 'HUP', quit: 'QUIT' }[cmd];
      if (sig) stream.signal(sig);
    },
    close,
    sftp: () => {
      if (!sftpPromise) {
        sftpPromise = new Promise((resolve, reject) => conn.sftp((err, s) => (err ? reject(err) : resolve(s))));
        sftpPromise.catch(() => (sftpPromise = null));
      }
      return sftpPromise;
    },
  };
}

module.exports = { connect };
