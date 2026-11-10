const { db, getSetting, setSetting, log } = require('./db');
const { gemini } = require('./gemini');

const isText = (b) => b && !b.startsWith('[');

function sampleEvenly(arr, n) {
  if (arr.length <= n) return arr;
  const out = [];
  const step = arr.length / n;
  for (let i = 0; i < n; i++) out.push(arr[Math.floor(i * step)]);
  return out;
}

// আপনার নিজের লেখা মেসেজ: এই ব্যক্তির সাথে
function ownerLinesFor(jid, n = 15) {
  return db
    .prepare("SELECT body FROM messages WHERE jid = ? AND direction = 'out' AND by_ai = 0 ORDER BY ts DESC LIMIT 60")
    .all(jid).map((r) => r.body).filter(isText).slice(0, n).reverse();
}
// আপনার নিজের লেখা মেসেজ: অন্যদের সাথে
function otherLines(jid, n = 15) {
  return db
    .prepare("SELECT body FROM messages WHERE jid != ? AND direction = 'out' AND by_ai = 0 ORDER BY RANDOM() LIMIT 80")
    .all(jid).map((r) => r.body).filter(isText).slice(0, n);
}

async function generateProfile() {
  const owner = getSetting('owner_name') || 'the user';
  const chats = db
    .prepare("SELECT jid, COUNT(*) AS n FROM messages WHERE direction = 'out' AND by_ai = 0 GROUP BY jid HAVING n >= 5 ORDER BY n DESC LIMIT 8")
    .all();
  let blocks = [];
  let i = 1;
  for (const c of chats) {
    const lines = db
      .prepare("SELECT body FROM messages WHERE jid = ? AND direction = 'out' AND by_ai = 0 ORDER BY ts ASC")
      .all(c.jid).map((r) => r.body).filter(isText);
    if (lines.length < 5) continue;
    const name = (db.prepare('SELECT name FROM contacts WHERE jid = ?').get(c.jid) || {}).name || `Contact ${i}`;
    blocks.push(`### Chat with: ${name}\n${sampleEvenly(lines, 70).map((s) => `- ${s.slice(0, 300)}`).join('\n')}`);
    i++;
  }
  if (!blocks.length) throw new Error('এখনো যথেষ্ট মেসেজ নেই');
  const system =
    'You are a linguist who studies how one person writes chat messages. ' +
    'Write a compact, practical style guide (max 250 words, in English) that another writer could follow to sound like this person. ' +
    'Cover: language mix (Bangla script / Banglish in Latin letters / English), typical message length, tone, common words and fillers, ' +
    'emoji habits (which, how often, where), punctuation and capitalisation, how they ask questions and answer, greetings and sign-offs, ' +
    'and how the style differs between the different chats listed (e.g. close friends vs others) if there is a visible difference. ' +
    'Include 5-8 short real example phrases copied from the samples. Do not include private facts, names or numbers from the chats.';
  const text = await gemini({
    system,
    contents: [{ role: 'user', parts: [{ text: `These are messages written by ${owner}:\n\n${blocks.join('\n\n')}` }] }],
    temperature: 0.3,
  });
  setSetting('style_profile', text.trim());
  return text.trim();
}

// নিজে নিজেই স্টাইল শেখে: পর্যাপ্ত নতুন মেসেজ জমলে প্রোফাইল নতুন করে বানায়
async function autoLearn() {
  try {
    if (!process.env.GEMINI_API_KEY) return;
    const total = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE direction = 'out' AND by_ai = 0").get().c;
    const last = Number(getSetting('style_learned_count')) || 0;
    const has = !!getSetting('style_profile');
    if (total < 30) return;
    if (has && total - last < 150) return;
    await generateProfile();
    setSetting('style_learned_count', total);
    log('info', `আপনার কথার স্টাইল শেখা হয়েছে (${total}টি মেসেজ থেকে)`);
  } catch (e) {
    log('error', `স্টাইল শিখতে সমস্যা: ${e.message}`);
  }
}

module.exports = { ownerLinesFor, otherLines, generateProfile, autoLearn };
