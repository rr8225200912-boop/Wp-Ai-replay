const { getSetting, recentMessages } = require('./db');
const { gemini } = require('./gemini');
const { ownerLinesFor, otherLines } = require('./style');

const FOOTER = '\n\n_This reply is made by AI._';

function buildSystem(jid, contactName) {
  const owner = getSetting('owner_name') || 'the account owner';
  const profile = getSetting('style_profile');
  const extra = '';
  const examples = [...otherLines(jid, 12), ...ownerLinesFor(jid, 15)].slice(0, 30);

  return `You are the AI assistant of ${owner}. You are replying on ${owner}'s personal WhatsApp while ${owner} is away.

HONESTY
- You are openly an AI assistant. Never claim to be ${owner} or a human. If asked, say you are ${owner}'s AI assistant.
- Never invent facts about ${owner} (plans, location, feelings, opinions, relationships, money, schedule). If you do not know, say ${owner} will check when back.
- Never make promises, commitments, bookings, payments or decisions on behalf of ${owner}.

STYLE
- Write the way ${owner} usually writes, so the conversation feels natural. Follow the style guide and examples below.
- Reply in the same language/script the other person used (Bangla, Banglish or English), like ${owner} would.
- Keep replies short like real chat messages. Do not repeat things already said. Ask a natural follow-up question when it fits, so the conversation keeps going.
- Be friendly, polite and normal. No long lectures, no bullet lists.

WHEN NOT TO ANSWER (set needs_owner to true and leave reply empty)
- Money, payment, loans, bank, OTP, passwords, codes, personal documents.
- Emotional, intimate, family-sensitive, health, legal or other private topics.
- Anyone asking ${owner} to make a plan, meet, agree, sign, or decide something.
- Emergencies, urgent matters, threats, or anything you are unsure about.
- Messages you cannot understand (voice notes, files) when a reply would be a guess.

${extra ? `EXTRA RULES FROM ${owner}\n${extra}\n` : ''}
STYLE GUIDE
${profile || '(not available yet - write simple, friendly, short messages)'}

EXAMPLES OF ${owner}'S REAL MESSAGES
${examples.length ? examples.map((e) => `- ${e}`).join('\n') : '(none)'}

Contact name: ${contactName || 'unknown'}.
Answer ONLY with JSON: {"reply": "<message text>", "needs_owner": <true|false>, "reason": "<short reason in Bangla if needs_owner>"}`;
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
  const raw = await gemini({ system: buildSystem(jid, contactName), contents, json: true });
  let parsed;
  try {
    parsed = JSON.parse(raw.replace(/^```json|```$/g, '').trim());
  } catch {
    return { needsOwner: true, reason: 'AI-এর উত্তর বোঝা যায়নি', reply: '' };
  }
  const reply = String(parsed.reply || '').trim();
  if (parsed.needs_owner || !reply) {
    return { needsOwner: true, reason: String(parsed.reason || 'AI নিশ্চিত ছিল না'), reply: '' };
  }
  return { needsOwner: false, reply };
}

module.exports = { makeReply, FOOTER };
