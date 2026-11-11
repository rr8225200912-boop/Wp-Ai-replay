WHATSAPP AI — PERSONAL CHAT + CONTACT COPILOT UPDATE

This update starts from the supplied whatsapp-ai-behavior-update project. It keeps the existing Baileys connection, Groq API adapter, SQLite database, dashboard login, contact etiquette, Style Learning and WhatsApp auth storage design.

WHAT IT DOES

1) PRIVATE PERSONAL AI CHAT
- Open your own WhatsApp "Message Yourself" chat and talk normally in Bangla, Banglish or English.
- The assistant replies in that same self-chat. These messages are stored separately from contact conversations and are not sent to contacts.
- You can ask questions, draft messages, plan tasks, discuss code and manage the assistant.
- Private notes are available as context in your self-chat. Use phrases such as "মনে রাখো ...", "eta mone rekho ...", "remember that ...", or `/remember <note>` to save a note.
- Use `/forgetnotes` to delete saved private notes. This does not erase the WhatsApp chat itself or the conversation log in SQLite.

2) MANUAL CONTACT AUTO-REPLY SWITCH
- The Dashboard switch is now the final ON/OFF control for contact auto-replies.
- ON means eligible contacts can receive AI replies whether the owner is online or offline. There is no longer a 15-minute inactivity gate.
- OFF means the assistant will not automatically reply to contacts. The private self-chat assistant remains available.
- If the owner sends a human reply in the same contact chat after an incoming message, the pending AI response is cancelled/withheld for that message.
- The existing per-contact hourly limit remains in place.

IMPORTANT: The existing saved `ai_enabled` value is retained. If the Dashboard switch is ON when this version is deployed, contact auto-replies are enabled even while the owner is online. Turn the switch OFF before testing if you do not want any automatic contact replies yet.

3) OWNER REPORTS AND REVIEW
- The Dashboard shows recent incoming messages, AI contact replies and messages held for owner review.
- After owner activity resumes following an inactive period, the assistant attempts to send an activity report to the owner's self-chat. A manual report can also be requested with `/report`, or by asking naturally, for example "কে কে মেসেজ দিয়েছে" / "who messaged me".
- Reports show the sender, incoming message, AI reply and an owner-review marker where applicable.
- Sensitive, uncertain, angry/boundary-setting or commitment-related messages are held for review rather than answered automatically.
- For a held message, use the Dashboard's "নিজে উত্তর পাঠাও" action to write and send an owner-approved reply. The "দেখেছি" action only closes the review item; it does not send a message.

OPTIONAL SELF-CHAT SHORTCUTS

/ai on                 Enable contact auto-replies
/ai off                Disable contact auto-replies
/report                Send the activity report to the self-chat
/remember <note>       Save a private note
/forgetnotes           Delete saved private notes
/status sleep          Set a temporary sleep status
/status work           Set a temporary work status
/status busy           Set a temporary busy status
/status out            Set a temporary out status
/status <text>         Set a custom availability status
/clearstatus           Clear the availability status
/help                  Show the shortcuts

No command is needed for ordinary conversations in the owner's self-chat. The shortcuts are only for explicit controls and memory.

DEPLOYMENT / DATA SAFETY
- No new Railway Variables or npm packages are required. Keep the existing `GROQ_API_KEY`.
- Keep the existing `DASHBOARD_PASSWORD`; `SESSION_SECRET` remains optional as before.
- Keep Railway Volume mounted at `/data` with `DATA_DIR=/data`.
- Do not delete the existing Railway Volume, `data/assistant.db`, or `data/wa_auth`. They hold settings, message history, private notes and WhatsApp session credentials.
- This ZIP intentionally does not contain your database, WhatsApp login/session, Railway secrets or API key.
- Node.js >= 22.13 is required by the existing project.

PRIVACY / LIMITATIONS
- The assistant only sees messages Baileys receives or imports and that are saved in the local SQLite database. WhatsApp may not provide complete historical sync.
- AI requests are sent to the configured Groq API. Existing Style Learning may also send selected owner-written style samples to Groq. Review provider privacy terms before using sensitive conversations.
- Self-chat history and private notes are stored on the configured DATA_DIR volume. `/forgetnotes` deletes notes, not the underlying WhatsApp conversation history.
- Source syntax and local SQLite/personal-assistant smoke tests were run. A live Railway deployment and real WhatsApp message test are still required; this package cannot prove the live service has connected or sent messages.
