WHATSAPP AI — CONTACT ETIQUETTE + OWNER STATUS UPDATE

This update keeps the existing Groq API adapter, Baileys connection, database, dashboard, and Style Learning design.
No new Railway Variables or npm packages are required. Keep your existing GROQ_API_KEY.

WHAT CHANGED
- ai.js: safer conversational policy, contact-specific etiquette inferred from the owner's own outgoing messages in that chat, neutral/formal defaults for unknown contacts, polite first greeting for a new contact, direct owner-availability answers, and escalation when someone is angry or asks to stop.
- whatsapp.js: recognizes the owner's own WhatsApp self-chat and supports private status/note commands. Self-chat commands are never sent to contacts.
- db.js: adds default settings for owner status and private notes. Existing SQLite data is retained; no table reset/migration is needed.

SELF-CHAT COMMANDS
Send these to your own WhatsApp "Message Yourself" chat:

/status sleep       -> says you are sleeping for up to 10 hours
/status work        -> says you are busy with work for up to 5 hours
/status busy        -> says you are busy for up to 3 hours
/status out         -> says you are out for up to 4 hours
/status <text>      -> saves a custom short availability status for up to 4 hours
/clearstatus        -> clears the status
/remember <note>    -> saves a private note locally
/forgetnotes        -> deletes private notes
/help               -> lists the commands

Natural status phrases are also recognized in the self-chat, for example:
- "ami ghumate jacchi" / "আমি ঘুমাতে যাচ্ছি"
- "ami kaj kortesi" / "আমি কাজে ব্যস্ত"

The owner status expires automatically. If someone asks where the owner is and an active status exists, the assistant shares only that general status. If no status exists, it says the owner is unavailable and will reply later; it does not guess a location.

CONTACT ETIQUETTE
- It infers a tentative style from the owner's own messages in the same chat: respectful/formal, familiar, or close/casual.
- It does not guess a contact's age, gender, or identity.
- Unknown contacts receive only a short, polite greeting/identity request when they send a simple greeting. Other first-time messages are held for the owner.
- Angry messages, threats to block, and requests to stop are not answered automatically; they are placed in the dashboard's owner-review flags.
- Sensitive, financial, medical, legal, intimate, and commitment-related topics are held for the owner.

IMPORTANT
- The bot discloses that it is an AI assistant.
- The assistant only sees chat history actually delivered to Baileys and saved locally. WhatsApp does not guarantee complete historical sync.
- Current AI messages are processed through the configured Groq API. The existing Style Learning feature may send selected owner-written style samples to Groq to generate a style guide. Review provider privacy terms before using private conversations.
- Keep Railway Volume and DATA_DIR intact. Do not delete wa_auth or your existing Railway Volume.
- These are source-code changes; live behavior still needs a Railway deployment and real-chat test.
