const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');
const QRCode = require('qrcode');
const B = require('@whiskeysockets/baileys');
const {
  DATA_DIR, db, getSetting, setSetting, addMessage, recentMessages, log,
  upsertContact, getContact, markOwnerActive, isAway,
} = require('./db');
const { makeReply, FOOTER, isSimpleGreeting } = require('./ai');
const { autoLearn } = require('./style');

const makeWASocket = typeof B.default === 'function' ? B.default : B.makeWASocket;
const { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } = B;
const AUTH_DIR = path.join(DATA_DIR, 'wa_auth');

const conn = { status: 'starting', qr: null, number: null, pairCode: null, lastError: null };
let retry = 0;
let sock = null;
let starting = false;
let learnTimer = null;
const botSent = new Set();       // AI যে মেসেজ পাঠিয়েছে তার ID
const lastBotSend = new Map();   // কোন চ্যাটে AI সর্বশেষ কখন পাঠিয়েছে
const timers = new Map();        // কথা থামার জন্য অপেক্ষা
const busy = new Set();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const isPersonChat = (jid) => !!jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid'));

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
const tsOf = (m) => (Number(m.messageTimestamp?.low ?? m.messageTimestamp) || Math.floor(Date.now() / 1000)) * 1000;

function normaliseJid(jid) {
  return String(jid || '').replace(/:\d+(?=@)/, '');
}

function isOwnerSelfChat(jid) {
  if (!sock?.user || !jid) return false;
  const candidates = [sock.user.id, sock.user.lid, sock.user.jid]
    .filter(Boolean).map(normaliseJid);
  const target = normaliseJid(jid);
  return candidates.includes(target);
}

function parseOwnerStatus(text) {
  const raw = String(text || '').trim();
  const lower = raw.toLowerCase();
  const clear = /^\/(clearstatus|status\s+clear|available)\s*$/i.test(raw) ||
    /(আমি এখন ফ্রি|ami ekhon free|i am available|i'm available|ami free)/i.test(raw);
  if (clear) return { clear: true };

  if (/^\/sleep\s*$/i.test(raw) || /(ঘুমাতে যাচ্ছি|ঘুমাইতে যাইতেছি|ঘুমাতে গেলাম|ঘুমাইতে গেলাম|ঘুমাচ্ছি|ghumate jacchi|ghumait(e|a) jacchi|ghumacchi|going to sleep|i am sleeping)/i.test(lower)) {
    return { status: 'ঘুমাচ্ছেন', hours: 10, label: 'ঘুম' };
  }
  if (/^\/(work|busy)\s*$/i.test(raw) || /(কাজ করছি|কাজ করতে যাচ্ছি|কাজে ব্যস্ত|অফিসে আছি|kaj kortesi|kaj kortechi|office e achi|working now|i am working|i'm working|in a meeting|মিটিংয়ে আছি)/i.test(lower)) {
    return { status: 'কাজে ব্যস্ত', hours: 5, label: 'কাজ' };
  }
  if (/^\/busy\s*$/i.test(raw) || /(এখন ব্যস্ত|ekhon busy|busy achi|busy right now)/i.test(lower)) {
    return { status: 'এখন ব্যস্ত', hours: 3, label: 'ব্যস্ত' };
  }
  if (/^\/out\s*$/i.test(raw) || /(বাইরে আছি|বাইরে যাচ্ছি|baire achi|baire jacchi|out of home)/i.test(lower)) {
    return { status: 'বাইরে আছেন', hours: 4, label: 'বাইরে' };
  }

  const command = raw.match(/^\/status\s+(.+)$/i);
  if (command) {
    const value = command[1].trim().slice(0, 90);
    if (/^(clear|available)$/i.test(value)) return { clear: true };
    if (/^(sleep|sleeping|ঘুম)$/i.test(value)) return { status: 'ঘুমাচ্ছেন', hours: 10, label: 'ঘুম' };
    if (/^(work|working|কাজ)$/i.test(value)) return { status: 'কাজে ব্যস্ত', hours: 5, label: 'কাজ' };
    if (/^(busy|ব্যস্ত)$/i.test(value)) return { status: 'এখন ব্যস্ত', hours: 3, label: 'ব্যস্ত' };
    if (/^(out|outside|বাইরে)$/i.test(value)) return { status: 'বাইরে আছেন', hours: 4, label: 'বাইরে' };
    return value ? { status: value, hours: 4, label: 'কাস্টম স্ট্যাটাস' } : null;
  }
  return null;
}

async function confirmOwnerCommand(jid, message) {
  try {
    const sent = await sock.sendMessage(jid, { text: message });
    if (sent?.key?.id) botSent.add(sent.key.id);
  } catch (e) {
    log('warn', `নিজের চ্যাটে কনফার্মেশন পাঠানো যায়নি: ${e.message}`);
  }
}

async function handleOwnerSelfChat(jid, body) {
  markOwnerActive();
  const raw = String(body || '').trim();
  if (!raw) return true;

  const status = parseOwnerStatus(raw);
  if (status?.clear) {
    setSetting('owner_status', '');
    setSetting('owner_status_until', '0');
    await confirmOwnerCommand(jid, '✅ তোমার availability status মুছে দেওয়া হয়েছে।');
    log('info', 'Owner status cleared from self-chat');
    return true;
  }
  if (status?.status) {
    setSetting('owner_status', status.status);
    setSetting('owner_status_until', Date.now() + status.hours * 60 * 60 * 1000);
    await confirmOwnerCommand(jid, `✅ Status মনে রাখা হয়েছে: ${status.status}\nএটি প্রায় ${status.hours} ঘণ্টা কার্যকর থাকবে। মুছতে /clearstatus পাঠাও।`);
    log('info', `Owner status updated: ${status.label}`);
    return true;
  }

  const remember = raw.match(/^\/(remember|note)\s+([\s\S]+)/i) || raw.match(/^মনে রাখো[:：]?\s*([\s\S]+)/i);
  if (remember) {
    const note = (remember[2] || remember[1] || '').trim().slice(0, 500);
    if (note) {
      const old = String(getSetting('owner_notes') || '');
      const entry = `${new Date().toISOString()}: ${note}`;
      setSetting('owner_notes', [old, entry].filter(Boolean).slice(-20).join('\n').slice(-5000));
      await confirmOwnerCommand(jid, '✅ নোটটি ব্যক্তিগতভাবে সংরক্ষণ করেছি। এটি অন্য কাউকে নিজে থেকে জানাব না।');
      log('info', 'Owner private note saved');
    }
    return true;
  }
  if (/^\/(forgetnotes|clearnotes)\s*$/i.test(raw)) {
    setSetting('owner_notes', '');
    await confirmOwnerCommand(jid, '✅ ব্যক্তিগত নোট মুছে দেওয়া হয়েছে।');
    return true;
  }
  if (/^\/help\s*$/i.test(raw)) {
    await confirmOwnerCommand(jid, 'নিজের চ্যাট কমান্ড:\n/status sleep — ঘুমাচ্ছি\n/status work — কাজে ব্যস্ত\n/status busy — ব্যস্ত\n/status <লেখা> — নিজের অবস্থা\n/clearstatus — অবস্থা মুছুন\n/remember <নোট> — ব্যক্তিগত নোট রাখুন\n/forgetnotes — নোট মুছুন');
    return true;
  }
  return true; // নিজের চ্যাটের অন্য লেখা কখনো কন্টাক্টের কাছে পাঠানো হবে না
}

// আপনি আগে এই ব্যক্তিকে নিজে মেসেজ করেছেন কি না (অচেনা নম্বর/স্প্যামে AI উত্তর দেয় না)
function knownContact(jid) {
  return !!db.prepare("SELECT 1 FROM messages WHERE jid = ? AND direction = 'out' AND by_ai = 0 LIMIT 1").get(jid);
}
function ownerRecentlyActive(jid) {
  const row = db.prepare("SELECT ts FROM messages WHERE jid = ? AND direction = 'out' AND by_ai = 0 ORDER BY ts DESC LIMIT 1").get(jid);
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
    const latestIncoming = recentMessages(jid, 1)[0];
    if (!knownContact(jid)) {
      const greeting = isSimpleGreeting(latestIncoming?.body || '');
      if (!greeting) {
        if (latestIncoming?.direction === 'in') db.prepare('INSERT INTO flags(jid, name, message, reason, ts) VALUES(?,?,?,?,?)')
          .run(jid, contact.name || '', latestIncoming.body, 'অপরিচিত কন্টাক্ট; পরিচয়/উদ্দেশ্য নিশ্চিত নয়', Date.now());
        log('info', `${contact.name || jid}: অপরিচিত কন্টাক্ট, শুধু সাধারণ greeting হলে সীমিত উত্তর`);
        return;
      }
    }
    if (ownerRecentlyActive(jid)) return;

    const maxPerHour = Number(getSetting('max_per_hour')) || 12;
    const sentLastHour = db.prepare('SELECT COUNT(*) AS c FROM messages WHERE jid = ? AND by_ai = 1 AND ts > ?')
      .get(jid, Date.now() - 3600 * 1000).c;
    if (sentLastHour >= maxPerHour) { log('warn', `${contact.name || jid}: ঘণ্টার সীমা শেষ, AI চুপ থাকছে`); return; }

    const before = recentMessages(jid, 1)[0];
    if (!before || before.direction !== 'in') return;

    const result = await makeReply(jid, contact.name);
    if (!result) return;

    // উত্তর তৈরির সময় অবস্থা বদলেছে কি না আবার দেখি
    const after = recentMessages(jid, 1)[0];
    if (!after || after.id !== before.id) return;
    if (getSetting('ai_enabled') !== '1' || !isAway() || ownerRecentlyActive(jid)) return;

    if (result.needsOwner) {
      db.prepare('INSERT INTO flags(jid, name, message, reason, ts) VALUES(?,?,?,?,?)')
        .run(jid, contact.name || '', before.body, result.reason, Date.now());
      log('info', `${contact.name || jid}: আপনার জন্য রাখা হলো (${result.reason})`);
      return;
    }

    try { await sock.sendPresenceUpdate('composing', jid); } catch {}
    await sleep(Math.min(7000, 1500 + result.reply.length * 60));
    if (!isAway() || ownerRecentlyActive(jid)) return;

    const sent = await sock.sendMessage(jid, { text: result.reply + FOOTER });
    try { await sock.sendPresenceUpdate('paused', jid); } catch {}
    if (sent?.key?.id) botSent.add(sent.key.id);
    lastBotSend.set(jid, Date.now());
    addMessage({ jid, name: contact.name || null, direction: 'out', body: result.reply, byAi: 1, waId: sent?.key?.id || null });
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
  timers.set(jid, setTimeout(() => { timers.delete(jid); maybeReply(jid); }, delay));
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
    if (botSent.has(m.key.id)) return;                       // AI-এর নিজের পাঠানো
    if (isOwnerSelfChat(jid)) {
      await handleOwnerSelfChat(jid, body);                  // নিজের চ্যাট = কমান্ড/ব্যক্তিগত নোট
      return;
    }
    const c = getContact(jid) || {};
    addMessage({ jid, name: c.name || null, direction: 'out', body, byAi: 0, ts, waId: m.key.id });
    if (fresh) { markOwnerActive(); cancelReply(jid); }      // আপনি নিজে লিখছেন
    return;
  }

  if (type !== 'notify') return;
  const name = m.pushName || '';
  upsertContact(jid, name);
  addMessage({ jid, name: name || (getContact(jid) || {}).name || null, direction: 'in', body, byAi: 0, ts, waId: m.key.id });
  if (fresh && text) scheduleReply(jid);
}

// প্রথমবার লিঙ্ক করলে WhatsApp পুরনো চ্যাট পাঠায়, সেখান থেকে স্টাইল শেখা হয়
function handleHistory({ chats, contacts, messages }) {
  try {
    for (const c of contacts || []) if (isPersonChat(c.id)) upsertContact(c.id, c.name || c.notify || '');
    for (const c of chats || []) if (isPersonChat(c.id) && c.name) upsertContact(c.id, c.name);
    let n = 0;
    for (const m of messages || []) {
      if (!m.message || !isPersonChat(m.key?.remoteJid)) continue;
      const body = textOf(m).trim() || mediaLabel(m);
      if (!body) continue;
      const jid = m.key.remoteJid;
      addMessage({ jid, name: (getContact(jid) || {}).name || null, direction: m.key.fromMe ? 'out' : 'in', body, byAi: 0, ts: tsOf(m), waId: m.key.id });
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
  try {
    try { sock?.ev.removeAllListeners(); sock?.end?.(undefined); } catch {}
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version;
    try { if (typeof B.fetchLatestWaWebVersion === 'function') ({ version } = await B.fetchLatestWaWebVersion()); } catch {}
    if (!version) { try { ({ version } = await fetchLatestBaileysVersion()); } catch {} }
    log('info', 'WhatsApp সংস্করণ: ' + (version ? version.join('.') : 'ডিফল্ট'));
    sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      logger: pino({ level: 'silent' }),
      browser: Browsers.ubuntu('Chrome'), // WEB_BROWSER identity; Desktop identity now triggers WA 428 on current servers
      markOnlineOnConnect: false,
      syncFullHistory: true,
    });
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) {
        conn.qr = await QRCode.toDataURL(qr, { width: 320, margin: 1 });
        conn.status = 'qr';
      }
      if (connection === 'open') {
        conn.status = 'connected';
        conn.qr = null;
        conn.pairCode = null;
        conn.lastError = null;
        retry = 0;
        conn.number = (sock.user?.id || '').split(':')[0].split('@')[0];
        if (!getSetting('owner_name') && sock.user?.name) setSetting('owner_name', sock.user.name);
        if (!Number(getSetting('owner_seen_ts'))) markOwnerActive();
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
        setTimeout(start, Math.min(60000, 3000 * 2 ** Math.min(retry, 5)));
      }
    });
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      for (const m of messages) {
        try { await handleMessage(m, type); } catch (e) { log('error', `মেসেজ প্রসেসে সমস্যা: ${e.message}`); }
      }
    });
    sock.ev.on('messaging-history.set', handleHistory);
    // আপনি ফোনে চ্যাট খুলে পড়লে বোঝা যায় আপনি সক্রিয়
    sock.ev.on('chats.update', (updates) => {
      for (const u of updates) {
        if (!isPersonChat(u.id) || u.unreadCount !== 0) continue;
        if (Date.now() - (lastBotSend.get(u.id) || 0) < 20000) continue;
        markOwnerActive();
        cancelReply(u.id);
      }
    });
  } catch (e) {
    log('error', `WhatsApp চালু করতে সমস্যা: ${e.message}`);
    conn.status = 'disconnected';
    starting = false;
    setTimeout(start, 8000);
    return;
  }
  starting = false;
}

async function requestPairing(number) {
  const n = String(number || '').replace(/\D/g, '');
  if (n.length < 8) throw new Error('দেশের কোডসহ পুরো নম্বর দিন, যেমন 8801XXXXXXXXX');
  if (conn.status === 'connected') throw new Error('WhatsApp আগেই কানেক্টেড আছে।');

  // Dashboard থেকে pairing request আসার সময় socket তৈরি হওয়ার অপেক্ষা করি।
  const deadline = Date.now() + 20000;
  while ((!sock || typeof sock.requestPairingCode !== 'function') && Date.now() < deadline) {
    await sleep(500);
  }
  if (!sock || typeof sock.requestPairingCode !== 'function') {
    throw new Error('WhatsApp সংযোগ এখনো তৈরি হয়নি। ১৫–২০ সেকেন্ড অপেক্ষা করে আবার চেষ্টা করুন।');
  }
  if (sock.authState?.creds?.registered) throw new Error('এই WhatsApp আগেই লিঙ্ক করা আছে।');

  // Socket-কে handshake শেষ করার জন্য সময় দিই; পুরনো/বন্ধ socket-এ code চাই না।
  const activeSock = sock;
  await sleep(5000);
  if (sock !== activeSock) {
    throw new Error('WhatsApp পুনরায় সংযোগ নিচ্ছে। Dashboard refresh করে কয়েক সেকেন্ড পর আবার চেষ্টা করুন।');
  }
  if (conn.status === 'disconnected') {
    throw new Error('WhatsApp সার্ভারের সংযোগ বন্ধ হয়েছে: ' + (conn.lastError || 'আবার চেষ্টা করুন।'));
  }

  const code = await activeSock.requestPairingCode(n);
  conn.pairCode = String(code).replace(/(.{4})(.{4})/, '$1-$2');
  conn.status = 'qr';
  conn.lastError = null;
  return conn.pairCode;
}

async function reconnect() {
  try { sock?.end?.(undefined); } catch {}
  starting = false;
  conn.status = 'starting';
  setTimeout(start, 500);
}

async function unlink() {
  try { await sock?.logout(); } catch {}
  try { sock?.end?.(undefined); } catch {}
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  conn.status = 'starting';
  conn.qr = null;
  conn.number = null;
  starting = false;
  setTimeout(start, 800);
}

module.exports = { start, reconnect, unlink, requestPairing, conn };
