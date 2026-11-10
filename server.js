const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { db, getSetting, setSetting, log } = require('./db');
const wa = require('./whatsapp');
const style = require('./style');

const PASSWORD = process.env.DASHBOARD_PASSWORD || '';
const SECRET = process.env.SESSION_SECRET || crypto.createHash('sha256').update('wa-ai:' + PASSWORD).digest('hex');
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8mb' }));

// ---------- লগইন ----------
const sign = (v) => crypto.createHmac('sha256', SECRET).update(v).digest('hex');
function makeToken() { const exp = String(Date.now() + 7 * 24 * 3600 * 1000); return `${exp}.${sign(exp)}`; }
function validToken(t) {
  if (!t) return false;
  const [exp, sig] = t.split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
function cookieOf(req, name) {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
const fails = new Map();
function tooManyFails(ip) {
  const f = fails.get(ip);
  return f && f.count >= 5 && Date.now() - f.last < 10 * 60 * 1000;
}

const loginPage = (msg = '') => `<!doctype html><html lang="bn"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>লগইন</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#e9efed;font-family:system-ui,"Noto Sans Bengali","Segoe UI",sans-serif;color:#14231f}
form{background:#fff;padding:28px;border-radius:14px;width:min(340px,88vw);box-shadow:0 2px 14px rgba(20,35,31,.12)}
h1{font-size:20px;margin:0 0 4px}p{margin:0 0 18px;color:#52665f;font-size:14px}
input{width:100%;box-sizing:border-box;padding:12px;border:1px solid #b9c9c3;border-radius:10px;font-size:16px}
button{margin-top:12px;width:100%;padding:12px;border:0;border-radius:10px;background:#14231f;color:#fff;font-size:16px}
.e{color:#b3261e;font-size:14px;margin-top:10px}
</style></head><body><form method="post" action="/login">
<h1>আমার WhatsApp সহকারী</h1><p>পাসওয়ার্ড দিয়ে ঢুকুন</p>
<input type="password" name="password" placeholder="পাসওয়ার্ড" autofocus required>
<button>ঢুকুন</button>${msg ? `<div class="e">${msg}</div>` : ''}</form></body></html>`;

app.use(express.urlencoded({ extended: false }));

if (!PASSWORD) {
  app.use((req, res) => res.status(503).send('<meta charset="utf-8"><h2>DASHBOARD_PASSWORD সেট করা নেই</h2><p>Railway-এর Variables-এ DASHBOARD_PASSWORD যোগ করে আবার Deploy করুন।</p>'));
} else {
  app.get('/login', (req, res) => res.send(loginPage()));
  app.post('/login', (req, res) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'x';
    if (tooManyFails(ip)) return res.status(429).send(loginPage('অনেকবার ভুল হয়েছে। ১০ মিনিট পরে চেষ্টা করুন।'));
    const given = Buffer.from(String(req.body.password || ''));
    const real = Buffer.from(PASSWORD);
    const ok = given.length === real.length && crypto.timingSafeEqual(given, real);
    if (!ok) {
      const f = fails.get(ip) || { count: 0, last: 0 };
      fails.set(ip, { count: f.count + 1, last: Date.now() });
      return res.status(401).send(loginPage('পাসওয়ার্ড ভুল'));
    }
    fails.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `auth=${encodeURIComponent(makeToken())}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${7 * 24 * 3600}${secure}`);
    res.redirect('/');
  });
  app.post('/logout', (req, res) => {
    res.setHeader('Set-Cookie', 'auth=; HttpOnly; Path=/; Max-Age=0');
    res.json({ ok: true });
  });

  app.use((req, res, next) => {
    if (validToken(cookieOf(req, 'auth'))) return next();
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'login' });
    res.redirect('/login');
  });

  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

  // ---------- API ----------
  const { isAway } = require('./db');

  app.get('/api/state', (req, res) => {
    res.json({
      conn: wa.conn,
      ai_enabled: getSetting('ai_enabled') === '1',
      away: isAway(),
      away_after: Number(getSetting('away_after')) || 15,
      owner_name: getSetting('owner_name'),
      hasKey: !!process.env.GEMINI_API_KEY,
      learned: !!getSetting('style_profile'),
      flags: db.prepare('SELECT id, name, jid, message, reason, ts FROM flags WHERE done = 0 ORDER BY id DESC LIMIT 30').all(),
      replies: db.prepare("SELECT name, jid, body, ts FROM messages WHERE by_ai = 1 ORDER BY id DESC LIMIT 15").all(),
      problems: db.prepare("SELECT text, ts FROM logs WHERE level = 'error' AND ts > ? ORDER BY id DESC LIMIT 3").all(Date.now() - 3600 * 1000),
    });
  });

  app.post('/api/settings', (req, res) => {
    const b = req.body || {};
    if (typeof b.ai_enabled === 'boolean') setSetting('ai_enabled', b.ai_enabled ? '1' : '0');
    res.json({ ok: true });
  });
  app.post('/api/flags/:id/done', (req, res) => { db.prepare('UPDATE flags SET done = 1 WHERE id = ?').run(Number(req.params.id)); res.json({ ok: true }); });
  app.post('/api/pair', async (req, res) => {
    try { res.json({ code: await wa.requestPairing(req.body && req.body.number) }); }
    catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/reconnect', async (req, res) => { await wa.reconnect(); res.json({ ok: true }); });
  app.post('/api/unlink', async (req, res) => { await wa.unlink(); res.json({ ok: true }); });
}

app.listen(PORT, () => {
  console.log(`Dashboard চলছে, পোর্ট ${PORT}`);
  if (!process.env.GEMINI_API_KEY) log('error', 'GEMINI_API_KEY সেট করা নেই');
  wa.start();
  setTimeout(style.autoLearn, 2 * 60 * 1000);
  setInterval(style.autoLearn, 6 * 3600 * 1000);
});

process.on('unhandledRejection', (e) => log('error', `অপ্রত্যাশিত সমস্যা: ${e && e.message ? e.message : e}`));
process.on('uncaughtException', (e) => log('error', `অপ্রত্যাশিত সমস্যা: ${e && e.message ? e.message : e}`));
