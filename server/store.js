'use strict';
// Persistent JSON storage for sessions, button bars, settings and known hosts.
// Secrets (passwords, private keys, passphrases) are encrypted at rest with
// AES-256-GCM using a key generated on first run (data/secret.key).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.TORTERM_DATA || path.join(__dirname, '..', 'data');
const LOG_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

const SECRET_FIELDS = ['password', 'privateKey', 'passphrase'];

function loadKey() {
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  }
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

function encrypt(text) {
  if (text == null || text === '') return '';
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}

function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith('enc:v1:')) return value || '';
  try {
    const raw = Buffer.from(value.slice(7), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function readJSON(name, fallback) {
  const file = path.join(DATA_DIR, name);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJSON(name, data) {
  const file = path.join(DATA_DIR, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

// ---------- sessions ----------

function rawSessions() {
  return readJSON('sessions.json', []);
}

/** Sessions as sent to the browser: secrets removed, presence flags added. */
function listSessions() {
  return rawSessions().map(maskSession);
}

function maskSession(s) {
  const out = { ...s, _has: {} };
  for (const f of SECRET_FIELDS) {
    out._has[f] = !!s[f];
    delete out[f];
  }
  return out;
}

/** Full session including decrypted secrets (server side only). */
function getSession(id) {
  const s = rawSessions().find((x) => x.id === id);
  if (!s) return null;
  const out = { ...s };
  for (const f of SECRET_FIELDS) out[f] = decrypt(s[f]);
  if (out.jumpHostId) out.jumpHost = getSession(out.jumpHostId === id ? null : out.jumpHostId);
  return out;
}

/**
 * Create or update a session. Secret fields: undefined/'' keeps the existing
 * value, null clears it, any other string replaces it.
 */
function saveSession(input) {
  const list = rawSessions();
  const id = input.id || crypto.randomUUID();
  const idx = list.findIndex((x) => x.id === id);
  const src = input.copySecretsFrom ? list.find((x) => x.id === input.copySecretsFrom) : null;
  const prev = idx >= 0 ? list[idx] : src || {};
  const next = { ...input, id };
  delete next._has;
  delete next.copySecretsFrom;
  for (const f of SECRET_FIELDS) {
    if (input[f] === null) next[f] = '';
    else if (input[f] === undefined || input[f] === '') next[f] = prev[f] || '';
    else next[f] = encrypt(input[f]);
  }
  next.updatedAt = Date.now();
  if (idx >= 0) list[idx] = next;
  else list.push({ ...next, createdAt: Date.now() });
  writeJSON('sessions.json', list);
  return maskSession(next);
}

function deleteSession(id) {
  writeJSON('sessions.json', rawSessions().filter((x) => x.id !== id));
}

function renameFolder(from, to) {
  const list = rawSessions();
  for (const s of list) {
    const f = s.folder || '';
    if (f === from || f.startsWith(from + '/')) s.folder = to + f.slice(from.length);
  }
  writeJSON('sessions.json', list);
}

function exportSessions(withSecrets) {
  return rawSessions().map((s) => {
    const out = { ...s };
    for (const f of SECRET_FIELDS) {
      if (withSecrets) out[f] = decrypt(s[f]);
      else delete out[f];
    }
    return out;
  });
}

function importSessions(items, replace) {
  if (!Array.isArray(items)) throw new Error('Expected an array of sessions');
  const list = replace ? [] : rawSessions();
  for (const it of items) {
    if (!it || typeof it !== 'object' || !it.protocol) continue;
    const s = { ...it, id: it.id && !list.some((x) => x.id === it.id) ? it.id : crypto.randomUUID() };
    delete s._has;
    for (const f of SECRET_FIELDS) s[f] = s[f] ? (String(s[f]).startsWith('enc:v1:') ? '' : encrypt(s[f])) : '';
    list.push(s);
  }
  writeJSON('sessions.json', list);
  return list.length;
}

// ---------- known hosts ----------

function knownHosts() {
  return readJSON('known_hosts.json', {});
}

function setKnownHost(hostKey, entry) {
  const all = knownHosts();
  all[hostKey] = { ...entry, addedAt: Date.now() };
  writeJSON('known_hosts.json', all);
}

function deleteKnownHost(hostKey) {
  const all = knownHosts();
  delete all[hostKey];
  writeJSON('known_hosts.json', all);
}

// ---------- generic documents (buttons, settings, snippets) ----------

const getDoc = (name, fallback) => readJSON(name + '.json', fallback);
const putDoc = (name, data) => writeJSON(name + '.json', data);

module.exports = {
  DATA_DIR,
  LOG_DIR,
  encrypt,
  decrypt,
  listSessions,
  getSession,
  saveSession,
  deleteSession,
  renameFolder,
  exportSessions,
  importSessions,
  knownHosts,
  setKnownHost,
  deleteKnownHost,
  getDoc,
  putDoc,
};
