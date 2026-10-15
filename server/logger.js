'use strict';
// PuTTY/SecureCRT-style session logging to data/logs.

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const { LOG_DIR } = require('./store');

const ANSI_RE =
  // CSI, OSC, DCS/PM/APC strings, two-char escapes, and remaining C0 controls except \t \n
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[PX^_][\s\S]*?\x1b\\|\x1b[@-Z\\-_]|\x1b[()*+][0-9A-Za-z]|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

const pad = (n, w = 2) => String(n).padStart(w, '0');

function stamp(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function safe(name) {
  return String(name || 'session').replace(/[^A-Za-z0-9._@-]+/g, '_').slice(0, 60);
}

class SessionLogger {
  /**
   * @param {string} label   host or session name used in the filename
   * @param {object} opts    { mode: 'printable' | 'raw', timestamps: boolean }
   */
  constructor(label, opts = {}) {
    const d = new Date();
    const name = `${safe(label)}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`;
    this.file = path.join(LOG_DIR, name);
    this.name = name;
    this.mode = opts.mode === 'raw' ? 'raw' : 'printable';
    this.timestamps = !!opts.timestamps;
    this.decoder = new StringDecoder('utf8');
    this.atLineStart = true;
    this.stream = fs.createWriteStream(this.file, { flags: 'a' });
    this.stream.write(`=~=~=~=~=~=~= TorTerminal log ${stamp(d)} =~=~=~=~=~=~=\n`);
  }

  write(buf) {
    if (this.mode === 'raw' && !this.timestamps) {
      this.stream.write(buf);
      return;
    }
    let text = this.decoder.write(buf);
    if (this.mode === 'printable') text = text.replace(ANSI_RE, '').replace(/\r\n?/g, '\n');
    if (this.timestamps && text) {
      let out = '';
      for (const ch of text) {
        if (this.atLineStart) {
          out += `[${stamp()}] `;
          this.atLineStart = false;
        }
        out += ch;
        if (ch === '\n') this.atLineStart = true;
      }
      text = out;
    }
    if (text) this.stream.write(text);
  }

  close() {
    this.stream.end(`\n=~=~=~=~=~=~= log closed ${stamp()} =~=~=~=~=~=~=\n`);
  }
}

function listLogs() {
  return fs
    .readdirSync(LOG_DIR)
    .filter((f) => f.endsWith('.log'))
    .map((f) => {
      const st = fs.statSync(path.join(LOG_DIR, f));
      return { name: f, size: st.size, mtime: st.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function logPath(name) {
  const base = path.basename(String(name));
  if (!base.endsWith('.log')) return null;
  const p = path.join(LOG_DIR, base);
  return fs.existsSync(p) ? p : null;
}

module.exports = { SessionLogger, listLogs, logPath };
