const { db, getSetting, recentMessages, pendingNotes } = require('./db');
const { gemini } = require('./gemini');
const { ownerLinesFor } = require('./style');

const FOOTER = '\n\n_This reply is made by AI._';

function countMatches(lines, regex) {
  return lines.reduce((n, line) => n + (regex.test(String(line)) ? 1 : 0), 0);
}

// Infer etiquette only from the owner's own messages in this exact chat.
// It does not guess a person's age or identity.
function inferContactEtiquette(jid) {
  const lines = db.prepare(
    "SELECT body FROM messages WHERE jid = ? AND direction = 'out' AND by_ai = 0 ORDER BY ts DESC LIMIT 80"
  ).all(jid).map((r) => String(r.body || '')).filter((s) => s && !s.startsWith('['));

  const respectful = countMatches(lines, /(^|\W)(আপনি|আপনার|আপনাকে|স্যার|ম্যাডাম|apni|apnar|apnake|sir|madam|assalamu alaikum|জ্বি|জি)(\W|$)/i);
  const close = countMatches(lines, /(^|\W)(তুই|তোর|তোকে|tui|tor|toke|dost|দোস্ত|pagol|পাগল|re)(\W|$)/i);
  const familiar = countMatches(lines, /(^|\W)(তুমি|তোমার|তোমাকে|tumi|tomar|tomake|vai|ভাই|bro)(\W|$)/i);
  const latin = lines.filter((s) => /[A-Za-z]/.test(s) && !/[\u0980-\u09FF]/.test(s)).length;
  const bangla = lines.filter((s) => /[\u0980-\u09FF]/.test(s)).length;

  let relationship = 'unknown_or_not_enough_evidence';
  let tone = 'polite_neutral';
  if (lines.length >= 3 && respectful >= 2 && respectful >= close) {
    relationship = 'respectful_or_senior';
    tone = 'respectful_formal';
  } else if (lines.length >= 3 && close >= 2 && close > respectful) {
    relationship = 'close_or_very_familiar';
    tone = 'casual_close_friend';
  } else if (lines.length >= 3 && familiar >= 2) {
    relationship = 'familiar';
    tone = 'friendly_respectful';
  }

  return {
    relationship,
    tone,
    language: latin > bangla ? 'often_banglish_or_latin' : bangla > latin ? 'often_bangla_script' : 'match_contact_language',
    sampleCount: lines.length,
  };
}

function activeOwnerStatus() {
  const status = String(getSetting('owner_status') || '').trim();
  const until = Number(getSetting('owner_status_until')) || 0;
  if (!status || (until && Date.now() > until)) return '';
  return status;
}

function isAvailabilityQuestion(text) {
  return /(কোথায়|কোথায়|কই|কোথায় আছে|কই আছে|কি করছে|কী করছে|ঘুমাচ্ছে|ব্যস্ত|ফ্রি আছে|অনলাইনে আছে|আছে নাকি|রাকিব কোথায়|রাকিব কই|where is|where's|where are|is .* available|is .* online|what is .* doing|what's .* doing|busy now|sleeping\??|kothay|koi|ki kortese|ki korche|ghumacche|free ache|online ache|ase naki)/i.test(String(text || ''));
}

function ownerStatusReply(text, ownerName) {
  const status = activeOwnerStatus();
  const latinOnly = /[A-Za-z]/.test(text) && !/[\u0980-\u09FF]/.test(text);
  const english = /\b(where|available|online|what is|what's|busy|sleeping)\b/i.test(text) && !/(kothay|koi|ase|ache|korche|kortese|ghumacche)/i.test(text);
  const who = ownerName || 'Rakib';
  if (english) {
    if (!status) return `${who}'s availability is not set right now. They may reply themselves when free.`;
    if (/ঘুম|sleep/i.test(status)) return `${who} is sleeping now. They will reply after waking up.`;
    return `${who} is ${status}. They will reply when free.`;
  }
  if (latinOnly) {
    if (!status) return `${who}-er current availability set kora nei. Free hole uni nijey reply dite paren.`;
    if (/ঘুম|sleep/i.test(status)) return `${who} ekhon ghumacche. Uthe free hole reply dibe.`;
    if (/কাজ|busy|work|meeting/i.test(status)) return `${who} ekhon kaj niye busy. Free hole reply dibe.`;
    return `${who} ekhon ${status}. Free hole reply dibe.`;
  }
  if (!status) return `${who}-এর বর্তমান availability সেট করা নেই। সময় হলে তিনি নিজেই উত্তর দিতে পারেন।`;
  if (/ঘুম|sleep/i.test(status)) return `${who} এখন ঘুমাচ্ছেন। ঘুম থেকে উঠে সময় হলে রিপ্লাই দেবেন।`;
  if (/কাজ|busy|work|meeting/i.test(status)) return `${who} এখন কাজে ব্যস্ত। ফ্রি হলে রিপ্লাই দেবেন।`;
  return `${who} এখন ${status}। সময় হলে নিজেই রিপ্লাই দেবেন।`;
}

function isSimpleGreeting(text) {
  const s = String(text || '').trim().toLowerCase();
  if (s.length > 90) return false;
  return /^(hi|hii+|hello|hey+|oi|assalamu alaikum|salam|salaam|আসসালামু আলাইকুম|সালাম|হাই|হ্যালো|কেমন আছেন|কেমন আছো|kemon achen|kemon acho)[!.?\s🙂😊👋🙏]*$/i.test(s);
}

function isBoundaryOrAngry(text) {
  return /(block kore dibo|block korbo|block me|block you|don't message|dont message|stop messaging|leave me alone|ar msg dio na|আর মেসেজ দিও না|আর মেসেজ করো না|আর কথা বলো না|কথা বলব না|কথা বলবো না|বিরক্ত করো না|বিরক্ত করিস না|কথা বলতে চাই না|talk to me again|never contact me|😡|🤬)/i.test(String(text || ''));
}

function buildSystem(jid, contactName, etiquette) {
  const owner = getSetting('owner_name') || 'Rakib';
  const profile = getSetting('style_profile');
  const examples = ownerLinesFor(jid, 18);
  const status = activeOwnerStatus();
  const notes = pendingNotes(jid);
  const noteBlock = notes.length
    ? `MESSAGE FROM ${owner} FOR THIS PERSON (deliver it in this reply, naturally, in third person, using exactly these facts and adding nothing):\n${notes.map((n) => `- ${n.text}`).join('\n')}\n\n`
    : '';

  let etiquetteRules = '';
  if (etiquette.tone === 'respectful_formal') {
    etiquetteRules = '- The owner consistently addresses this contact respectfully. Use আপনি/apni, আপনার/apnar, respectful greetings and polite wording. Never use তুই/tui or teasing.';
  } else if (etiquette.tone === 'casual_close_friend') {
    etiquetteRules = '- The owner uses very familiar language with this contact. A relaxed, friendly tone is appropriate, but still notice discomfort and boundaries.';
  } else if (etiquette.tone === 'friendly_respectful') {
    etiquetteRules = '- Use friendly but respectful language. Prefer তুমি/tumi rather than তুই/tui unless the recent conversation clearly establishes otherwise.';
  } else {
    etiquetteRules = '- Relationship is unknown or evidence is limited. Start formally and neutrally: use আপনি/apni, avoid jokes, nicknames and over-familiar language. Do not assume age, closeness or gender.';
  }

  return `You are the clearly disclosed AI assistant for ${owner}, replying from the owner's WhatsApp account only while the owner has enabled contact auto-reply. The owner may be online or offline. Your role is to be a careful, courteous assistant, not to impersonate the owner.

IDENTITY AND HONESTY
- If asked who you are, say clearly that you are ${owner}'s AI assistant. Never claim to be ${owner} or a human.
- Never invent the owner's plans, opinions, location, feelings, relationships, money, schedule or promises.
- Never commit the owner to meetings, decisions, payments, agreements or plans.

CONTACT-SPECIFIC ETIQUETTE
- The relationship label below is an inference from the owner's own messages in THIS chat only. It is tentative, not a fact about the contact's age or identity.
- Inference: ${etiquette.relationship}; tone: ${etiquette.tone}; observed owner messages: ${etiquette.sampleCount}.
${etiquetteRules}
- Unknown/new contacts: greet politely (use Assalamu alaikum when it naturally fits), identify yourself as the AI assistant, ask how you may help or who is messaging. Do not act like a close friend.
- Match the language/script of the latest message: Bangla, Banglish or English. Keep wording natural for Bangladesh.
- For a senior/formal contact, avoid slang, flirting, teasing, sarcasm and excessive emojis.
- For a close friend, light humour is okay only when the person is clearly comfortable.
- If the person sounds upset, confused, uncomfortable, asks you to stop, threatens to block, or sends angry language/emojis, do not joke or argue. Set needs_owner=true and leave reply empty so ${owner} can handle it.
- Never keep pushing a conversation. If the person says goodbye or does not want to talk, politely stop.

OWNER AVAILABILITY
- Current owner status supplied by the owner: ${status || '(no current status has been set)'}.
- Do NOT mention ${owner}'s status on your own. Chat normally and answer what the person actually said. Mention the status only when the person asks where ${owner} is, what ${owner} is doing, why there is no reply, or whether ${owner} is available.
- If asked where ${owner} is, what ${owner} is doing, or whether ${owner} is available, use ONLY that status if it is present. Do not infer a physical location.
- If no status is available, say that ${owner}'s availability has not been set and they may reply themselves when free. Do not assume they are offline. Never guess that they are sleeping, working, outside or at a particular place.

${noteBlock}PRIVACY AND ESCALATION (set needs_owner=true and leave reply empty)
- Money, payments, loans, banking, OTPs, passwords, login codes, private documents or account access.
- Health, legal, intimate, family-sensitive, emotional crisis, threats, emergencies or serious conflict.
- Requests for private information, secrets, private opinions about another person, exact location or personal relationship details.
- Requests that require ${owner} to make a decision, promise, agree, meet, sign or take action.
- Anything you do not understand confidently. Do not guess.

STYLE
- Use the owner's style guide and examples only as a writing-style reference, not as permission to reveal facts from other chats.
- Keep replies short, calm, respectful and relevant. Usually one or two sentences.
- Do not repeatedly ask questions. Do not use random emojis. Avoid exaggerated or robotic replies.
- Answer the actual message; do not use unrelated fillers such as "ki lagse?" or "ki hoise?" unless the context calls for it.

STYLE GUIDE
${profile || '(No style profile yet. Use simple, polite, short chat messages.)'}

EXAMPLES OF THE OWNER'S OWN MESSAGES IN THIS CHAT
${examples.length ? examples.map((e) => `- ${e}`).join('\n') : '(No examples yet. Use polite neutral language.)'}

Contact name: ${contactName || 'unknown'}.
Return ONLY valid JSON: {"reply":"message text","needs_owner":true or false,"reason":"short Bengali reason when needs_owner is true"}`;
}

function toContents(rows) {
  const contents = [];
  for (const r of rows) {
    const role = r.direction === 'in' ? 'user' : 'model';
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts[0].text += '\n' + r.body;
    else contents.push({ role, parts: [{ text: r.body }] });
  }
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return contents;
}

async function makeReply(jid, contactName) {
  const rows = recentMessages(jid, 24);
  const contents = toContents(rows);
  if (!contents.length || contents[contents.length - 1].role !== 'user') return null;
  const latestText = contents[contents.length - 1].parts[0].text;
  const owner = getSetting('owner_name') || 'Rakib';

  const hasOwnerMessage = rows.some((r) => r.direction === 'out' && !r.by_ai);
  if (!hasOwnerMessage) {
    if (!isSimpleGreeting(latestText)) {
      return { needsOwner: true, reason: 'অপরিচিত কন্টাক্টের মেসেজ; মালিকের অনুমতি দরকার', reply: '' };
    }
    const latinOnly = /[A-Za-z]/.test(latestText) && !/[\u0980-\u09FF]/.test(latestText);
    const english = /^(hi|hello|hey)/i.test(latestText);
    const incomingSalam = /^(assalamu alaikum|salam|salaam|আসসালামু আলাইকুম|সালাম)/i.test(latestText.trim());
    const reply = english
      ? `Hello. I'm ${owner}'s AI assistant. May I know who is messaging?`
      : latinOnly
        ? `${incomingSalam ? 'Wa alaikum assalam.' : 'Assalamu alaikum.'} Ami ${owner}-er AI assistant. Apni ke bolchen janale ${owner}-ke janate parbo.`
        : `${incomingSalam ? 'ওয়া আলাইকুমুস সালাম।' : 'আসসালামু আলাইকুম।'} আমি ${owner}-এর AI assistant। আপনি কে বলছেন জানালে ${owner}-কে জানাতে পারব.`;
    return { needsOwner: false, reply };
  }

  if (isBoundaryOrAngry(latestText)) {
    return { needsOwner: true, reason: 'ব্যক্তি বিরক্ত বা যোগাযোগ বন্ধ করতে বলেছে; AI উত্তর দেয়নি', reply: '' };
  }

  if (isAvailabilityQuestion(latestText) && !pendingNotes(jid).length) {
    return { needsOwner: false, reply: ownerStatusReply(latestText, owner) };
  }

  const etiquette = inferContactEtiquette(jid);
  const raw = await gemini({ system: buildSystem(jid, contactName, etiquette), contents, json: true });
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```json\s*|```$/g, '').trim());
  } catch {
    return { needsOwner: true, reason: 'AI-এর উত্তর সঠিক JSON হয়নি', reply: '' };
  }
  const reply = String(parsed.reply || '').trim();
  if (parsed.needs_owner || !reply) {
    return { needsOwner: true, reason: String(parsed.reason || 'AI নিশ্চিত নয়; মালিকের উত্তর প্রয়োজন'), reply: '' };
  }
  return { needsOwner: false, reply, usedNotes: pendingNotes(jid).length > 0 };
}


// Private owner-facing chat assistant. Its context is restricted to the owner's
// self-chat and private notes; contact conversations are never mixed into it.
async function makePersonalReply(jid) {
  const rows = db.prepare(`
    SELECT * FROM (
      SELECT * FROM messages
      WHERE jid = ? AND NOT (direction = 'out' AND by_ai = 1 AND body LIKE '📬 WhatsApp activity report%')
      ORDER BY ts DESC, id DESC LIMIT 36
    ) ORDER BY ts ASC, id ASC
  `).all(jid);
  const contents = toContents(rows);
  if (!contents.length || contents[contents.length - 1].role !== 'user') return { reply: '', actions: [] };
  const owner = getSetting('owner_name') || 'Rakib';
  const notes = String(getSetting('owner_notes') || '').slice(-5000);
  const style = String(getSetting('style_profile') || '').slice(0, 1500);
  const system = `You are ${owner}'s private WhatsApp AI assistant, working inside the owner's own Message Yourself chat. The owner talks to you and you can DO tasks for them.\n\n` +
    `HOW TO TALK\n- Understand Bangla, Banglish and English. Reply in the language and casual tone the owner uses.\n` +
    `- NEVER start a reply with a greeting or salam (no "Assalamualikum", "Hi", "Hello") unless the owner's latest message is itself a greeting. Answer the point directly. Never copy greeting habits from the style profile.\n` +
    `- Keep replies short and natural, like a smart friend. Longer only for complex tasks (code, planning, writing).\n` +
    `- Be honest. The app performs actions and adds its own confirmation lines, so do NOT claim an action is done yourself; just briefly say what you are doing.\n\n` +
    `TASKS YOU CAN DO (put them in "actions" ONLY when the owner clearly asks)\n` +
    `- {"type":"set_status","text":"short reason, e.g. ঘুমাচ্ছেন / কাজে ব্যস্ত / বাইরে আছেন","hours":number}  -> when the owner says they are sleeping, busy, out, driving etc. Others who message will be told this reason. hours = sensible duration (sleep 9, work 4, busy 3, out 3).\n` +
    `- {"type":"clear_status"}  -> owner says they are free/back.\n` +
    `- {"type":"leave_message","contact":"name exactly as the owner said it","message":"the fact to tell that person, neutral, third person, e.g. 'Owner will meet tomorrow at 5'"}  -> "Rim ke bolo ...", "someone messages Rim, tell her ...". It is delivered when that person next writes.\n` +
    `- {"type":"send_message","contact":"name or full phone number with country code","message":"text to send now"}  -> owner wants a message sent to someone now. The app will ask the owner to confirm before sending, so just draft it in the owner's tone.\n` +
    `- {"type":"read_chat","contact":"name or number","question":"what the owner wants to know, e.g. summary, what did they last say"}  -> owner asks about a past conversation with a contact. The app reads the messages saved in its own database (only those it has received or imported since it was connected, not WhatsApp itself) and answers from them. Never say you cannot read chats; use this action instead.\n` +
    `- {"type":"remember","note":"fact"}  -> owner asks you to remember something.\n` +
    `- {"type":"set_auto_reply","enabled":true or false}  -> owner turns contact auto-replies on or off.\n` +
    `You cannot do anything outside this list (no calls, no payments, no reading other chats). If asked, say so plainly.\n\n` +
    `PRIVACY\n- This is the owner's private chat. Never reveal its contents or the notes to any contact.\n` +
    `OWNER NOTES (private context; use only when relevant)\n${notes || '(No saved notes.)'}\n` +
    `STYLE REFERENCE (tone only)\n${style || '(none)'}\n\n` +
    `Return ONLY JSON: {"reply":"text to the owner (may be empty if actions say it all)","actions":[...]}`;
  const raw = await gemini({ system, contents, json: true });
  const text = String(raw || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/^```json\s*|```$/g, '').trim());
  } catch {
    return { reply: text.slice(0, 4000), actions: [] };
  }
  const known = new Set(['read_chat', 'set_status', 'clear_status', 'leave_message', 'send_message', 'remember', 'set_auto_reply']);
  const actions = (Array.isArray(parsed.actions) ? parsed.actions : []).filter((x) => x && known.has(x.type)).slice(0, 4);
  return { reply: String(parsed.reply || '').trim().slice(0, 4000), actions };
}

async function summarizeChat(name, rows, question) {
  const owner = getSetting('owner_name') || 'Rakib';
  const transcript = rows
    .map((r) => `${r.direction === 'in' ? name : (r.by_ai ? 'AI assistant' : owner)}: ${String(r.body).slice(0, 300)}`)
    .join('\n');
  const system = `You help ${owner} understand a saved WhatsApp conversation with ${name}. Answer ${owner}'s question using ONLY the transcript. Reply in Bangla/Banglish like ${owner} writes, short and clear. If the transcript does not contain the answer, say so. Never invent anything.`;
  const raw = await gemini({
    system,
    contents: [{ role: 'user', parts: [{ text: `Question: ${question || 'Summarize the conversation briefly.'}\n\nTRANSCRIPT (oldest first):\n${transcript}` }] }],
    json: false,
  });
  return String(raw || '').trim().slice(0, 3500);
}

module.exports = { makeReply, makePersonalReply, summarizeChat, FOOTER, inferContactEtiquette, isSimpleGreeting };
