const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'assistant.db'));

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  name TEXT,
  direction TEXT NOT NULL,
  body TEXT NOT NULL,
  by_ai INTEGER DEFAULT 0,
  ts INTEGER NOT NULL,
  wa_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages(jid, ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_waid ON messages(wa_id) WHERE wa_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS contacts (jid TEXT PRIMARY KEY, name TEXT, blocked INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, level TEXT, text TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT, name TEXT, message TEXT, reason TEXT, ts INTEGER, done INTEGER DEFAULT 0
);
`);

const DEFAULTS = {
  ai_enabled: '1',
  owner_name: '',
  away_after: '15',     // এত মিনিট আপনি কিছু না করলে AI উত্তর দেওয়া শুরু করে
  max_per_hour: '12',
  style_profile: '',
  style_learned_count: '0',
  owner_seen_ts: '0',
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : (DEFAULTS[key] ?? '');
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}
function addMessage({ jid, name = null, direction, body, byAi = 0, ts = Date.now(), waId = null }) {
  db.prepare('INSERT OR IGNORE INTO messages(jid, name, direction, body, by_ai, ts, wa_id) VALUES(?,?,?,?,?,?,?)')
    .run(jid, name, direction, body, byAi ? 1 : 0, ts, waId);
}
function recentMessages(jid, n = 24) {
  return db.prepare('SELECT * FROM (SELECT * FROM messages WHERE jid = ? ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts ASC, id ASC')
    .all(jid, n);
}
function log(level, text) {
  console.log(`[${level}] ${text}`);
  db.prepare('INSERT INTO logs(level, text, ts) VALUES(?,?,?)').run(level, String(text).slice(0, 1000), Date.now());
  db.prepare('DELETE FROM logs WHERE id < (SELECT MAX(id) - 500 FROM logs)').run();
}
function upsertContact(jid, name) {
  db.prepare(`INSERT INTO contacts(jid, name) VALUES(?, ?)
              ON CONFLICT(jid) DO UPDATE SET name = COALESCE(NULLIF(excluded.name, ''), contacts.name)`)
    .run(jid, name || '');
}
function getContact(jid) {
  return db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid);
}

// আপনি সর্বশেষ কখন ফোন/WhatsApp ব্যবহার করেছেন
function markOwnerActive() { setSetting('owner_seen_ts', Date.now()); }
function isAway() {
  const seen = Number(getSetting('owner_seen_ts')) || 0;
  const mins = Number(getSetting('away_after')) || 15;
  return Date.now() - seen > mins * 60 * 1000;
}

module.exports = { db, DATA_DIR, getSetting, setSetting, addMessage, recentMessages, log, upsertContact, getContact, markOwnerActive, isAway };
