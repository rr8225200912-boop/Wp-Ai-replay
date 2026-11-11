const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');
const QRCode = require('qrcode');
const B = require('@whiskeysockets/baileys');
const {
  DATA_DIR, db, getSetting, setSetting, addMessage, recentMessages, log,
  upsertContact, getContact, markOwnerActive, isAway,
} = require('./db');
const { makeReply, makePersonalReply, FOOTER, isSimpleGreeting } = require('./ai');
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

async function sendOwnerSelfText(jid, message, { store = true } = {}) {
  if (!sock || conn.status !== 'connected') return false;
  try {
    const sent = await sock.sendMessage(jid, { text: message });
    if (sent?.key?.id) botSent.add(sent.key.id);
    if (store) addMessage({ jid, name: 'নিজের চ্যাট', direction: 'out', body: message, byAi: 1, waId: sent?.key?.id || null });
    return true;
  } catch (e) {
    log('warn', `নিজের চ্যাটে মেসেজ পাঠানো যায়নি: ${e.message}`);
    return false;
  }
}

async function confirmOwnerCommand(jid, message) {
  await sendOwnerSelfText(jid, message);
}

function buildOwnerReport({ force = false } = {}) {
  const ownerJids = getOwnerJids();
  const exclusion = ownerJids.length ? `jid NOT IN (${ownerJids.map(() => '?').join(',')})` : '1 = 1';
  const lastReportId = Number(getSetting('owner_report_id')) || 0;
  const firstReportSince = Date.now() - 24 * 60 * 60 * 1000;
  const rows = lastReportId
    ? db.prepare(`
        SELECT id, name, jid, direction, body, by_ai, ts,
          CASE WHEN direction = 'in' AND EXISTS (SELECT 1 FROM flags f WHERE f.jid = messages.jid AND f.message = messages.body AND f.ts >= messages.ts) THEN 1 ELSE 0 END AS needs_review
        FROM messages
        WHERE id > ? AND ${exclusion}
          AND (direction = 'in' OR (direction = 'out' AND by_ai = 1))
        ORDER BY id ASC LIMIT 160
      `).all(lastReportId, ...ownerJids)
    : db.prepare(`
        SELECT id, name, jid, direction, body, by_ai, ts,
          CASE WHEN direction = 'in' AND EXISTS (SELECT 1 FROM flags f WHERE f.jid = messages.jid AND f.message = messages.body AND f.ts >= messages.ts) THEN 1 ELSE 0 END AS needs_review
        FROM messages
        WHERE ts > ? AND ${exclusion}
          AND (direction = 'in' OR (direction = 'out' AND by_ai = 1))
        ORDER BY id ASC LIMIT 160
      `).all(firstReportSince, ...ownerJids);

  if (!rows.length) {
    return {
      text: force ? '📭 শেষ রিপোর্টের পর নতুন কোনো incoming message বা AI reply নেই।' : '',
      nextTs: Date.now(),
      nextId: lastReportId,
      count: 0,
    };
  }

  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.jid)) groups.set(row.jid, { name: row.name || row.jid.split('@')[0], items: [] });
    groups.get(row.jid).items.push(row);
  }
  const lines = ['📬 WhatsApp activity report', `মোট ${rows.filter((r) => r.direction === 'in').length}টি incoming · ${rows.filter((r) => r.direction === 'out' && r.by_ai).length}টি AI reply`, ''];
  for (const [jid, group] of groups) {
    lines.push(`👤 ${group.name || jid.split('@')[0]}`);
    for (const item of group.items) {
      const time = new Date(item.ts).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      const label = item.direction === 'in' ? (item.needs_review ? 'তারা · ⚠️ owner review দরকার' : 'তারা') : 'AI';
      const body = String(item.body || '').replace(/\s+/g, ' ').slice(0, 360);
      lines.push(`  ${time} · ${label}: ${body}`);
    }
    lines.push('');
  }
  let text = lines.join('\n').trim();
  if (text.length > 3600) text = text.slice(0, 3550) + '\n… রিপোর্ট সংক্ষিপ্ত করা হয়েছে। বিস্তারিত Dashboard-এ দেখো।';
  return { text, nextTs: Date.now(), nextId: Math.max(...rows.map((r) => Number(r.id) || 0)), count: rows.length };
}

async function sendOwnerReport({ force = false } = {}) {
  const jid = getOwnerJid();
  if (!jid) return false;
  const report = buildOwnerReport({ force });
  if (!report.text) return false;
  const sent = await sendOwnerSelfText(jid, report.text);
  if (sent) {
    setSetting('owner_report_ts', report.nextTs);
    setSetting('owner_report_id', report.nextId);
  }
  return sent;
}

let returnReportBusy = false;
async function maybeSendReturnReport() {
  if (returnReportBusy || !sock || conn.status !== 'connected' || !isAway()) return;
  returnReportBusy = true;
  try {
    await sendOwnerReport({ force: false });
  } finally {
    markOwnerActive();
    returnReportBusy = false;
  }
}

function getOwnerJids() {
  return [...new Set([sock?.user?.id, sock?.user?.lid, sock?.user?.jid]
    .filter(Boolean).map(normaliseJid))];
}
function getOwnerJid() {
  return getOwnerJids()[0] || '';
}

function saveOwnerNote(note) {
  const clean = String(note || '').trim().slice(0, 500);
  if (!clean) return false;
  const old = String(getSetting('owner_notes') || '');
  const entry = `${new Date().toISOString()}: ${clean}`;
  setSetting('owner_notes', [old, entry].filter(Boolean).slice(-30).join('\n').slice(-5000));
  return true;
}

async function handleOwnerSelfChat(jid, body) {
  markOwnerActive();
  const raw = String(body || '').trim();
  if (!raw) return true;

  const enableMatch = /^(?:\/(?:ai|auto|copilot)\s+on|(?:ai|auto[- ]?reply|copilot)\s+(?:on|চালু)|(?:ai|অটো.?রিপ্লাই|সহকারী)\s*চালু(?:\s*করো)?|(?:সব মেসেজে|সবাইকে)\s*(?:অটো)?\s*রিপ্লাই\s*(?:দাও|করো)|(?:enable|turn on|start)\s+(?:the )?(?:ai|auto[- ]?reply)|ai\s+reply\s+start)$/i.test(raw);
  const disableMatch = /^(?:\/(?:ai|auto|copilot)\s+off|(?:ai|auto[- ]?reply|copilot)\s+(?:off|বন্ধ)|(?:ai|অটো.?রিপ্লাই|সহকারী)\s*বন্ধ(?:\s*করো)?|(?:কাউকে|কোনো মেসেজে)\s*(?:আর )?(?:অটো)?\s*রিপ্লাই\s*(?:দিও না|বন্ধ করো)|(?:disable|turn off|stop)\s+(?:the )?(?:ai|auto[- ]?reply)|stop\s+replying\s+to\s+contacts)$/i.test(raw);
  if (enableMatch || disableMatch) {
    setSetting('ai_enabled', enableMatch ? '1' : '0');
    await confirmOwnerCommand(jid, enableMatch
      ? '✅ Contact auto-reply ON. তুমি online বা offline—দুই অবস্থাতেই enabled থাকবে।'
      : '⏸️ Contact auto-reply OFF. নিজের চ্যাটের personal assistant চালু থাকবে।');
    return true;
  }

  if (/^\/(?:report|summary)\s*$/i.test(raw) || /^(?:report|activity report|show (?:me )?(?:the )?(?:report|activity)|who (?:has )?messaged me(?: today)?|what did (?:they|the ai) reply|কারা মেসেজ দিছে|কে কে মেসেজ দিয়েছে|কে কে মেসেজ দিয়েছে|কে আমাকে মেসেজ দিয়েছে|কে আমাকে মেসেজ দিয়েছে|কি রিপ্লাই দিয়েছে|কী রিপ্লাই দিয়েছে|আমাকে রিপোর্ট দাও|রিপোর্ট দাও|আজকে কারা মেসেজ করেছে|কি কি মেসেজ এসেছে|কী কী মেসেজ এসেছে|ke ke msg dise|ke amake msg dise|ki reply dise)$/i.test(raw)) {
    await sendOwnerReport({ force: true });
    return true;
  }

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

  const remember = raw.match(/^\/(?:remember|note)\s+([\s\S]+)/i) ||
    raw.match(/^(?:মনে রাখো|মনে রেখো|মনে রাখবে)[:：, ]*([\s\S]+)/i) ||
    raw.match(/^(?:eta mone rekho|eta mone rakho|remember that|please remember)[:：, ]*([\s\S]+)/i);
  if (remember) {
    const note = String(remember[1] || '').trim().slice(0, 500);
    if (saveOwnerNote(note)) {
      await confirmOwnerCommand(jid, '✅ এই তথ্যটা তোমার private memory-তে সেভ করেছি। অন্য কাউকে নিজে থেকে বলব না।');
      log('info', 'Owner private note saved');
    }
    return true;
  }
  if (/^\/(?:forgetnotes|clearnotes)\s*$/i.test(raw) || /^(?:সব নোট মুছে দাও|আমার নোট ভুলে যাও)$/i.test(raw)) {
    setSetting('owner_notes', '');
    await confirmOwnerCommand(jid, '✅ ব্যক্তিগত নোট মুছে দেওয়া হয়েছে।');
    return true;
  }
  if (/^\/help\s*$/i.test(raw)) {
    await confirmOwnerCommand(jid, 'নিজের চ্যাটে স্বাভাবিকভাবেই কথা বলো—এটাই personal AI chat।\n\nকিছু shortcut:\n/ai on বা /ai off — contact auto-reply চালু/বন্ধ\n/report — শেষ রিপোর্টের পরের মেসেজ ও AI reply\n/remember <তথ্য> — private memory-তে রাখো\n/forgetnotes — private notes মুছো\n/status sleep বা /status work — availability জানাও\n/clearstatus — availability মুছো\n\nContact auto-reply OFF হলেও নিজের চ্যাটের AI চলবে।');
    return true;
  }

  try {
    const reply = await makePersonalReply(jid);
    if (reply) await sendOwnerSelfText(jid, reply);
    else await confirmOwnerCommand(jid, 'এখন উত্তর তৈরি করতে পারলাম না। একটু পরে আবার লিখো।');
  } catch (e) {
    log('error', `Personal assistant error: ${e.message}`);
    await confirmOwnerCommand(jid, 'AI service-এ এখন সমস্যা হচ্ছে। GROQ_API_KEY, connection বা model status চেক করতে হবে।');
  }
  return true;
}

// আপনি আগে এই ব্যক্তিকে নিজে মেসেজ করেছেন কি না (অচেনা নম্বর/স্প্যামে AI উত্তর দেয় না)
function knownContact(jid) {
  return !!db.prepare("SELECT 1 FROM messages WHERE jid = ? AND direction = 'out' AND by_ai = 0 LIMIT 1").get(jid);
}
function ownerRepliedAfter(jid, incoming) {
  if (!incoming) return false;
  return !!db.prepare("SELECT 1 FROM messages WHERE jid = ? AND direction = 'out' AND by_ai = 0 AND (ts > ? OR (ts = ? AND id > ?)) LIMIT 1")
    .get(jid, incoming.ts, incoming.ts, incoming.id);
}

async function maybeReply(jid) {
  if (busy.has(jid)) return;
  busy.add(jid);
  try {
    if (getSetting('ai_enabled') !== '1') return;
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
    if (getSetting('ai_enabled') !== '1' || ownerRepliedAfter(jid, before)) return;

    if (result.needsOwner) {
      db.prepare('INSERT INTO flags(jid, name, message, reason, ts) VALUES(?,?,?,?,?)')
        .run(jid, contact.name || '', before.body, result.reason, Date.now());
      log('info', `${contact.name || jid}: আপনার জন্য রাখা হলো (${result.reason})`);
      return;
    }

    try { await sock.sendPresenceUpdate('composing', jid); } catch {}
    await sleep(Math.min(7000, 1500 + result.reply.length * 60));
    const latestAtSend = recentMessages(jid, 1)[0];
    if (!latestAtSend || latestAtSend.id !== before.id) return;
    if (getSetting('ai_enabled') !== '1' || ownerRepliedAfter(jid, before)) return;

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
  timers.set(jid, setTimeout(() => {
    timers.delete(jid);
    if (busy.has(jid)) { scheduleReply(jid); return; }
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
    if (botSent.has(m.key.id)) return;                       // AI-এর নিজের পাঠানো
    if (isOwnerSelfChat(jid)) {
      await maybeSendReturnReport();
      addMessage({ jid, name: 'নিজের চ্যাট', direction: 'in', body, byAi: 0, ts: Date.now(), waId: m.key.id });
      await handleOwnerSelfChat(jid, body);                  // নিজের চ্যাট = personal assistant
      return;
    }
    const c = getContact(jid) || {};
    addMessage({ jid, name: c.name || null, direction: 'out', body, byAi: 0, ts, waId: m.key.id });
    if (fresh) {
      await maybeSendReturnReport();
      markOwnerActive();
      cancelReply(jid);                                      // এই চ্যাটে আপনি উত্তর দিলে pending AI থামবে
    }
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
      const selfChat = isOwnerSelfChat(jid);
      const direction = selfChat ? (m.key.fromMe ? 'in' : 'out') : (m.key.fromMe ? 'out' : 'in');
      try {
        addMessage({ jid, name: selfChat ? 'নিজের চ্যাট' : ((getContact(jid) || {}).name || null), direction, body, byAi: 0, ts: tsOf(m), waId: m.key.id });
        n++;
      } catch (e) {
        log('warn', `একটি পুরনো মেসেজ বাদ গেছে: ${e.message}`);
      }
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
        void maybeSendReturnReport();
        markOwnerActive();
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

async function sendManualReply(flagId, replyText) {
  const id = Number(flagId);
  const text = String(replyText || '').trim();
  if (!Number.isInteger(id) || id < 1) throw new Error('Flag ID সঠিক নয়।');
  if (!text || text.length > 3000) throw new Error('উত্তর ১–৩০০০ অক্ষরের মধ্যে লিখুন।');
  if (!sock || conn.status !== 'connected') throw new Error('WhatsApp এখন connected নয়।');
  const flag = db.prepare('SELECT * FROM flags WHERE id = ? AND done = 0').get(id);
  if (!flag) throw new Error('এই pending message আর পাওয়া যাচ্ছে না।');
  const sent = await sock.sendMessage(flag.jid, { text });
  addMessage({ jid: flag.jid, name: flag.name || null, direction: 'out', body: text, byAi: 0, waId: sent?.key?.id || null });
  db.prepare('UPDATE flags SET done = 1 WHERE id = ?').run(id);
  markOwnerActive();
  log('info', `${flag.name || flag.jid}: owner-approved manual reply sent`);
  return { ok: true };
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

module.exports = { start, reconnect, unlink, requestPairing, sendManualReply, getOwnerJid, getOwnerJids, conn };
