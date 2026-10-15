'use strict';
// Local shell on the machine running the server (PowerShell, cmd, WSL, Git
// Bash, bash, zsh...). Uses node-pty when available, plain pipes otherwise.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let pty = null;
try {
  pty = require('node-pty');
} catch {}

function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

function detectShells() {
  const shells = [];
  if (process.platform === 'win32') {
    const sys = process.env.SystemRoot || 'C:\\Windows';
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const candidates = [
      ['PowerShell 7', path.join(pf, 'PowerShell', '7', 'pwsh.exe')],
      ['Windows PowerShell', path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
      ['Command Prompt', path.join(sys, 'System32', 'cmd.exe')],
      ['WSL', path.join(sys, 'System32', 'wsl.exe')],
      ['Git Bash', path.join(pf, 'Git', 'bin', 'bash.exe')],
    ];
    for (const [name, p] of candidates) if (exists(p)) shells.push({ name, path: p, args: name === 'Git Bash' ? ['--login', '-i'] : [] });
  } else {
    let listed = [];
    try {
      listed = fs.readFileSync('/etc/shells', 'utf8').split('\n').filter((l) => l.startsWith('/'));
    } catch {}
    const seen = new Set();
    for (const p of [process.env.SHELL, ...listed, '/bin/bash', '/bin/sh']) {
      if (p && !seen.has(p) && exists(p)) {
        seen.add(p);
        shells.push({ name: path.basename(p), path: p, args: ['-l'] });
      }
    }
  }
  return shells;
}

async function connect(o, ctx) {
  const shells = detectShells();
  const chosen = shells.find((s) => s.path === o.shell) || shells[0];
  if (!chosen) throw new Error('No local shell found');
  const args = o.shellArgs ? String(o.shellArgs).match(/(?:[^\s"]+|"[^"]*")+/g).map((a) => a.replace(/^"|"$/g, '')) : chosen.args;
  const cwd = o.cwd && exists(o.cwd) ? o.cwd : os.homedir();
  const env = { ...process.env, TERM: o.term || 'xterm-256color', COLORTERM: 'truecolor' };

  if (pty) {
    const p = pty.spawn(chosen.path, args, { name: o.term || 'xterm-256color', cols: ctx.cols, rows: ctx.rows, cwd, env, useConpty: true });
    p.onData((d) => ctx.data(Buffer.from(d, 'utf8')));
    p.onExit(({ exitCode }) => ctx.closed(`Process exited (${exitCode})`));
    return {
      write: (buf) => p.write(buf.toString('utf8')),
      resize: (c, r) => {
        try {
          p.resize(c, r);
        } catch {}
      },
      special: (cmd) => cmd === 'int' && p.write('\x03'),
      close: () => {
        try {
          p.kill();
        } catch {}
      },
    };
  }

  // Fallback: no pseudo-terminal, so interactive programs will be limited.
  ctx.info('node-pty not available: running shell without a PTY (limited).', 'warn');
  const child = spawn(chosen.path, args, { cwd, env });
  const fix = (d) => Buffer.from(d.toString('utf8').replace(/\r?\n/g, '\r\n'));
  child.stdout.on('data', (d) => ctx.data(fix(d)));
  child.stderr.on('data', (d) => ctx.data(fix(d)));
  child.on('exit', (code) => ctx.closed(`Process exited (${code})`));
  child.on('error', (e) => ctx.closed(e.message));
  ctx.remoteEcho(false);
  return {
    write: (buf) => child.stdin.write(buf.toString('utf8').replace(/\r/g, '\r\n')),
    resize: () => {},
    special: () => {},
    close: () => child.kill(),
  };
}

module.exports = { connect, detectShells, hasPty: () => !!pty };
