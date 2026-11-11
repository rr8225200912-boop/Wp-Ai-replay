const { db, getSetting, recentMessages } = require('./db');
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
    if (!status) return `${who} is not available right now. They will reply when free.`;
    if (/ঘুম|sleep/i.test(status)) return `${who} is sleeping now. They will reply after waking up.`;
    return `${who} is ${status}. They will reply when free.`;
  }
  if (latinOnly) {
    if (!status) return `${who} ekhon available na. Free hole nijey reply dibe.`;
    if (/ঘুম|sleep/i.test(status)) return `${who} ekhon ghumacche. Uthe free hole reply dibe.`;
    if (/কাজ|busy|work|meeting/i.test(status)) return `${who} ekhon kaj niye busy. Free hole reply dibe.`;
    return `${who} ekhon ${status}. Free hole reply dibe.`;
  }
  if (!status) return `${who} এখন available নেই। সময় হলে নিজেই reply দেবেন।`;
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

  return `You are the clearly disclosed AI assistant for ${owner}, replying from the owner's WhatsApp account when the owner is away. Your role is to be a careful, courteous assistant, not to impersonate the owner.

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
- If asked where ${owner} is, what ${owner} is doing, or whether ${owner} is available, use ONLY that status if it is present. Do not infer a physical location.
- If no status is available, say only that ${owner} is unavailable right now and will reply when free. Never guess that they are sleeping, working, outside or at a particular place.

PRIVACY AND ESCALATION (set needs_owner=true and leave reply empty)
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

  if (isAvailabilityQuestion(latestText)) {
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
  return { needsOwner: false, reply };
}

module.exports = { makeReply, FOOTER, inferContactEtiquette, isSimpleGreeting };
