
const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');
const QRCode = require('qrcode');
const B = require('@whiskeysockets/baileys');

const {
  DATA_DIR, db, getSetting, setSetting, addMessage, recentMessages, log,
  upsertContact, getContact, markOwnerActive, isAway,
} = require('./db');

const { makeReply, FOOTER } = require('./ai');
const { autoLearn } = require('./style');

const makeWASocket = typeof B.default === 'function' ? B.default : B.makeWASocket;
const {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} = B;

const AUTH_DIR = path.join(DATA_DIR, 'wa_auth');

const conn = {
  status: 'starting',
  qr: null,
  number: null,
  pairCode: null,
  lastError: null,
};

let retry = 0;
let sock = null;
let starting = false;
let learnTimer = null;

const botSent = new Set();
const lastBotSend = new Map();
const timers = new Map();
const busy = new Set();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isPersonChat = (jid) =>
  !!jid &&
  (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));

function textOf(m) {
  const x = m.message || {};

  return (
    x.conversation ||
    x.extendedTextMessage?.text ||
    x.imageMessage?.caption ||
    x.videoMessage?.caption ||
    x.ephemeralMessage?.message?.extendedTextMessage?.text ||
    x.ephemeralMessage?.message?.conversation ||
    ''
  );
}

function mediaLabel(m) {
  const x = m.message || {};

  if (x.audioMessage) return '[ভয়েস/অডিও মেসেজ]';
  if (x.imageMessage) return '[ছবি]';
  if (x.videoMessage) return '[ভিডিও]';
  if (x.documentMessage) return '[ফাইল]';
  if (x.stickerMessage) return '[স্টিকার]';

  return '';
}

const tsOf = (m) =>
  (Number(m.messageTimestamp?.low ?? m.messageTimestamp) ||
    Math.floor(Date.now() / 1000)) * 1000;

function knownContact(jid) {
  return !!db.prepare(
    "SELECT 1 FROM messages WHERE jid = ? AND direction = 'out' AND by_ai = 0 LIMIT 1"
  ).get(jid);
}

function ownerRecentlyActive(jid) {
  const row = db.prepare(
    "SELECT ts FROM messages WHERE jid = ? AND direction = 'out' AND by_ai = 0 ORDER BY ts DESC LIMIT 1"
  ).get(jid);

  return !!row && Date.now() - row.ts < 15 * 60 * 1000;
}

async function maybeReply(jid) {
  if (busy.has(jid)) return;

  busy.add(jid);

  try {
    if (getSetting('ai_enabled') !== '1' || !isAway()) return;
    if (conn.status !== 'connected' || !sock) return;

    const contact = getContact(jid) || {};

    if (contact.blocked) return;

    if (!knownContact(jid)) {
      log('info', `${contact.name || jid}: আগে কথা হয়নি এমন নম্বর, AI উত্তর দেয়নি`);
      return;
    }

    if (ownerRecentlyActive(jid)) return;

    const maxPerHour = Number(getSetting('max_per_hour')) || 12;

    const sentLastHour = db.prepare(
      'SELECT COUNT(*) AS c FROM messages WHERE jid = ? AND by_ai = 1 AND ts > ?'
    ).get(jid, Date.now() - 3600 * 1000).c;

    if (sentLastHour >= maxPerHour) {
      log('warn', `${contact.name || jid}: ঘণ্টার সীমা শেষ, AI চুপ থাকছে`);
      return;
    }

    const before = recentMessages(jid, 1)[0];

    if (!before || before.direction !== 'in') return;

    const result = await makeReply(jid, contact.name);

    if (!result) return;

    const after = recentMessages(jid, 1)[0];

    if (!after || after.id !== before.id) return;

    if (
      getSetting('ai_enabled') !== '1' ||
      !isAway() ||
      ownerRecentlyActive(jid)
    ) return;

    if (result.needsOwner) {
      db.prepare(
        'INSERT INTO flags(jid, name, message, reason, ts) VALUES(?,?,?,?,?)'
      ).run(
        jid,
        contact.name || '',
        before.body,
        result.reason,
        Date.now()
      );

      log('info', `${contact.name || jid}: আপনার জন্য রাখা হলো (${result.reason})`);
      return;
    }

    try {
      await sock.sendPresenceUpdate('composing', jid);
    } catch {}

    await sleep(Math.min(7000, 1500 + result.reply.length * 60));

    if (!isAway() || ownerRecentlyActive(jid)) return;

    const sent = await sock.sendMessage(jid, {
      text: result.reply + FOOTER,
    });

    try {
      await sock.sendPresenceUpdate('paused', jid);
    } catch {}

    if (sent?.key?.id) botSent.add(sent.key.id);

    lastBotSend.set(jid, Date.now());

    addMessage({
      jid,
      name: contact.name || null,
      direction: 'out',
      body: result.reply,
      byAi: 1,
      waId: sent?.key?.id || null,
    });

    log('info', `${contact.name || jid}: AI উত্তর পাঠিয়েছে`);
  } catch (e) {
    log('error', `উত্তর তৈরি/পাঠাতে সমস্যা: ${e.message}`);
  } finally {
    busy.delete(jid);
  }
}

function scheduleReply(jid) {
  clearTimeout(timers.get(jid));

  const delay = 10000 + Math.floor(Math.random() * 6000);

  timers.set(jid, setTimeout(() => {
    timers.delete(jid);
    maybeReply(jid);
  }, delay));
}

function cancelReply(jid) {
  clearTimeout(timers.get(jid));
  timers.delete(jid);
}

async function handleMessage(m, type) {
  if (!m.message) return;

  const jid = m.key.remoteJid;

  if (!isPersonChat(jid)) return;

  const text = textOf(m).trim();
  const label = mediaLabel(m);
  const body = text || label;

  if (!body) return;

  const ts = tsOf(m);
  const fresh = Date.now() - ts < 2 * 60 * 1000;

  if (m.key.fromMe) {
    if (botSent.has(m.key.id)) return;

    const c = getContact(jid) || {};

    addMessage({
      jid,
      name: c.name || null,
      direction: 'out',
      body,
      byAi: 0,
      ts,
      waId: m.key.id,
    });

    if (fresh) {
      markOwnerActive();
      cancelReply(jid);
    }

    return;
  }

  if (type !== 'notify') return;

  const name = m.pushName || '';

  upsertContact(jid, name);

  addMessage({
    jid,
    name: name || (getContact(jid) || {}).name || null,
    direction: 'in',
    body,
    byAi: 0,
    ts,
    waId: m.key.id,
  });

  if (fresh && text) scheduleReply(jid);
}

function handleHistory({ chats, contacts, messages }) {
  try {
    for (const c of contacts || []) {
      if (isPersonChat(c.id)) {
        upsertContact(c.id, c.name || c.notify || '');
      }
    }

    for (const c of chats || []) {
      if (isPersonChat(c.id) && c.name) {
        upsertContact(c.id, c.name);
      }
    }

    let n = 0;

    for (const m of messages || []) {
      if (!m.message || !isPersonChat(m.key?.remoteJid)) continue;

      const body = textOf(m).trim() || mediaLabel(m);

      if (!body) continue;

      const jid = m.key.remoteJid;

      addMessage({
        jid,
        name: (getContact(jid) || {}).name || null,
        direction: m.key.fromMe ? 'out' : 'in',
        body,
        byAi: 0,
        ts: tsOf(m),
        waId: m.key.id,
      });

      n++;
    }

    if (n) {
      log('info', `পুরনো চ্যাট থেকে ${n}টি মেসেজ পাওয়া গেছে`);

      clearTimeout(learnTimer);
      learnTimer = setTimeout(autoLearn, 60 * 1000);
    }
  } catch (e) {
    log('error', `পুরনো চ্যাট পড়তে সমস্যা: ${e.message}`);
  }
}

async function start() {
  if (starting) return;

  starting = true;
  conn.status = 'starting';
  conn.lastError = null;

  try {
    try {
      sock?.ev.removeAllListeners();
      sock?.end?.(undefined);
    } catch {}

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    let version;

    try {
      if (typeof B.fetchLatestWaWebVersion === 'function') {
        ({ version } = await B.fetchLatestWaWebVersion());
      }
    } catch {}

    if (!version) {
      try {
        ({ version } = await fetchLatestBaileysVersion());
      } catch {}
    }

    log(
      'info',
      'WhatsApp সংস্করণ: ' + (version ? version.join('.') : 'ডিফল্ট')
    );

    sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: pino({ level: 'silent' }),
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: true,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;

      if (qr) {
        conn.qr = await QRCode.toDataURL(qr, {
          width: 320,
          margin: 1,
        });

        // QR না থাকলেও Pairing Code চাওয়ার সুযোগ থাকবে।
        if (!conn.pairCode) conn.status = 'qr';
      }

      if (connection === 'open') {
        conn.status = 'connected';
        conn.qr = null;
        conn.pairCode = null;
        conn.lastError = null;

        retry = 0;

        conn.number = (sock.user?.id || '')
          .split(':')[0]
          .split('@')[0];

        if (!getSetting('owner_name') && sock.user?.name) {
          setSetting('owner_name', sock.user.name);
        }

        if (!Number(getSetting('owner_seen_ts'))) {
          markOwnerActive();
        }

        log('info', 'WhatsApp কানেক্টেড');
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        const why = lastDisconnect?.error?.message || '';

        conn.status = 'disconnected';
        conn.number = null;
        conn.qr = null;

        conn.lastError = `কোড ${code || '?'} ${why}`.trim();

        if (code === DisconnectReason.loggedOut) {
          log('warn', 'WhatsApp থেকে লগআউট হয়েছে। নতুন করে লিঙ্ক করুন');
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        } else {
          log('warn', `কানেকশন বন্ধ হয়েছে (${conn.lastError})`);
        }

        starting = false;
        retry++;

        setTimeout(
          start,
          Math.min(60000, 3000 * 2 ** Math.min(retry, 5))
        );
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        try {
          await handleMessage(m, type);
        } catch (e) {
          log('error', `মেসেজ প্রসেসে সমস্যা: ${e.message}`);
        }
      }
    });

    sock.ev.on('messaging-history.set', handleHistory);

    sock.ev.on('chats.update', (updates) => {
      for (const u of updates) {
        if (!isPersonChat(u.id) || u.unreadCount !== 0) continue;

        if (Date.now() - (lastBotSend.get(u.id) || 0) < 20000) {
          continue;
        }

        markOwnerActive();
        cancelReply(u.id);
      }
    });
  } catch (e) {
    log('error', `WhatsApp চালু করতে সমস্যা: ${e.message}`);

    conn.status = 'disconnected';
    conn.lastError = e.message;

    starting = false;

    setTimeout(start, 8000);
    return;
  }

  starting = false;
}

async function requestPairing(number) {
  const n = String(number || '').replace(/\D/g, '');

  if (n.length < 8) {
    throw new Error('দেশের কোডসহ পুরো নম্বর দিন, যেমন 8801XXXXXXXXX');
  }

  if (!sock) {
    throw new Error('WhatsApp সংযোগ এখনো তৈরি হয়নি। কয়েক সেকেন্ড পর আবার চেষ্টা করুন।');
  }

  if (sock.authState?.creds?.registered) {
    throw new Error('এই WhatsApp অ্যাকাউন্ট আগেই লিঙ্ক করা আছে।');
  }

  if (conn.status === 'disconnected') {
    throw new Error('WhatsApp সার্ভারের সংযোগ বন্ধ হয়েছে। শেষ সমস্যাটি দেখুন।');
  }

  try {
    // QR ইভেন্টের জন্য অপেক্ষা না করে Pairing Code চাওয়া হবে।
    await sleep(3000);

    if (!sock || sock.authState?.creds?.registered) {
      throw new Error('WhatsApp সংযোগ পরিবর্তিত হয়েছে। আবার চেষ্টা করুন।');
    }

    const code = await sock.requestPairingCode(n);

    conn.pairCode = String(code).replace(/(.{4})(.{4})/, '$1-$2');
    conn.status = 'qr';

    return conn.pairCode;
  } catch (e) {
    log('error', `Pairing Code তৈরি হয়নি: ${e.message}`);
    throw new Error(`Pairing Code তৈরি হয়নি: ${e.message}`);
  }
}

async function reconnect() {
  try {
    sock?.end?.(undefined);
  } catch {}

  starting = false;
  conn.status = 'starting';
  conn.lastError = null;

  setTimeout(start, 500);
}

async function unlink() {
  try {
    await sock?.logout();
  } catch {}

  try {
    sock?.end?.(undefined);
  } catch {}

  fs.rmSync(AUTH_DIR, {
    recursive: true,
    force: true,
  });

  conn.status = 'starting';
  conn.qr = null;
  conn.number = null;
  conn.pairCode = null;
  conn.lastError = null;

  starting = false;

  setTimeout(start, 800);
}

module.exports = {
  start,
  reconnect,
  unlink,
  requestPairing,
  conn,
};
