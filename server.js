const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { db, getSetting, setSetting, log } = require('./db');
const wa = require('./whatsapp');
const style = require('./style');

const INDEX_HTML = "<!doctype html>\n<html lang=\"bn\">\n<head>\n<meta charset=\"utf-8\">\n<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<title>আমার WhatsApp সহকারী</title>\n<style>\n:root{--bg:#e9efed;--ink:#14231f;--mute:#52665f;--line:#d3dedb;--on:#1f9d6b;--away:#d98e04;--bad:#b3261e}\n*{box-sizing:border-box}\nbody{margin:0;background:var(--bg);color:var(--ink);font-family:system-ui,\"Noto Sans Bengali\",\"Segoe UI\",sans-serif;font-size:17px;line-height:1.5}\nmain{max-width:560px;margin:0 auto;padding:14px}\nh1{font-size:20px;margin:6px 0 14px}\n.card{background:#fff;border-radius:14px;padding:14px;margin-bottom:12px;box-shadow:0 1px 6px rgba(20,35,31,.08)}\n.card h2{font-size:16px;margin:0 0 6px}\n.row{display:flex;justify-content:space-between;align-items:center;gap:10px}\n.mute{color:var(--mute);font-size:14px}\n.dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;background:#8a9a95}\n.dot.connected{background:var(--on)}.dot.qr{background:var(--away)}.dot.disconnected{background:var(--bad)}\n.sw{position:relative;width:60px;height:34px;flex:none}\n.sw input{opacity:0;width:100%;height:100%;position:absolute;margin:0;z-index:1}\n.sw span{position:absolute;inset:0;background:#b6c4bf;border-radius:99px;transition:.2s}\n.sw span:before{content:\"\";position:absolute;width:28px;height:28px;left:3px;top:3px;background:#fff;border-radius:50%;transition:.2s}\n.sw input:checked+span{background:var(--on)}\n.sw input:checked+span:before{transform:translateX(26px)}\n.qr img{display:block;margin:10px auto;width:min(300px,100%)}\n.note{background:#fff6dd;border-radius:10px;padding:10px;font-size:15px;margin-top:8px}\n.bad{background:#fde8e6;color:var(--bad)}\n.item{padding:8px 0;border-top:1px solid var(--line)}\n.item:first-of-type{border-top:0}\n.item .who{font-size:13px;color:var(--mute)}\n.item .txt{white-space:pre-wrap;word-break:break-word}\nbutton{border:0;border-radius:10px;padding:9px 13px;font-size:15px;background:#dbe5e1;color:var(--ink)}\nbutton.red{background:var(--bad);color:#fff}\ndetails{margin-top:6px}summary{color:var(--mute);font-size:14px;padding:6px 0}\n</style>\n</head>\n<body>\n<main>\n  <h1>আমার WhatsApp সহকারী</h1>\n  <div class=\"card\" id=\"top\"></div>\n  <div class=\"card\" id=\"flags\"></div>\n  <div class=\"card\" id=\"replies\"></div>\n  <details class=\"card\"><summary>সমস্যা হলে</summary>\n    <div class=\"row\" style=\"margin-top:8px\">\n      <button id=\"re\">আবার কানেক্ট</button>\n      <button class=\"red\" id=\"un\">নতুন QR নিন</button>\n      <button id=\"out\">বের হন</button>\n    </div>\n  </details>\n</main>\n<script>\nconst $ = (s) => document.querySelector(s);\nfunction h(tag, attrs = {}, ...kids) {\n  const e = document.createElement(tag);\n  for (const [k, v] of Object.entries(attrs)) {\n    if (k === 'class') e.className = v;\n    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);\n    else if (v != null && v !== false) e.setAttribute(k, v);\n  }\n  for (const c of kids.flat()) { if (c == null) continue; e.append(c.nodeType ? c : document.createTextNode(String(c))); }\n  return e;\n}\nasync function api(path, body) {\n  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };\n  const r = await fetch(path, opt);\n  if (r.status === 401) { location = '/login'; return {}; }\n  return r.json();\n}\nconst fmt = (ts) => new Date(ts).toLocaleString('bn-BD', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });\nconst STATUS = { connected: 'WhatsApp কানেক্টেড', qr: 'WhatsApp কানেক্ট করা হয়নি', disconnected: 'সংযোগ নেই, আবার চেষ্টা চলছে', starting: 'চালু হচ্ছে...' };\n\nlet phoneVal = '';\nfunction render(s) {\n  if (document.activeElement && document.activeElement.id === 'ph') return;\n  const c = s.conn;\n  const sw = h('input', { type: 'checkbox', onchange: async (e) => { await api('/api/settings', { ai_enabled: e.target.checked }); load(); } });\n  sw.checked = s.ai_enabled;\n  $('#top').replaceChildren(\n    h('div', { class: 'row' }, h('div', {}, h('span', { class: 'dot ' + c.status }), STATUS[c.status] || c.status), null),\n    c.status !== 'connected' && c.lastError ? h('div', { class: 'note bad' }, 'শেষ সমস্যা: ' + c.lastError) : null,\n    c.status === 'qr' ? h('div', { style: 'margin-top:10px' },\n      c.pairCode ? h('div', { class: 'note' }, 'আপনার কোড:', h('div', { style: 'font-size:30px;font-weight:700;letter-spacing:3px;margin:6px 0' }, c.pairCode),\n        'WhatsApp → সেটিংস → লিঙ্কড ডিভাইস → ডিভাইস লিঙ্ক করুন → নিচের \"ফোন নম্বর দিয়ে লিঙ্ক করুন\" চাপুন → এই কোড দিন।') : null,\n      h('div', { class: 'mute', style: 'margin:8px 0 4px' }, 'আপনার WhatsApp নম্বর (দেশের কোডসহ, যেমন 8801XXXXXXXXX):'),\n      h('input', { id: 'ph', type: 'tel', value: phoneVal, placeholder: '8801XXXXXXXXX', oninput: (e) => { phoneVal = e.target.value; }, style: 'width:100%;padding:12px;font-size:18px;border:1px solid #b9c9c3;border-radius:10px' }),\n      h('div', { style: 'margin-top:8px' }, h('button', { onclick: async (e) => {\n        e.target.textContent = 'অপেক্ষা করুন...';\n        const r = await api('/api/pair', { number: phoneVal });\n        e.target.textContent = 'কোড নিন';\n        if (r.error) alert(r.error); else load(true);\n      } }, 'কোড নিন'))) : null,\n    c.status === 'connected' ? h('div', { class: 'row', style: 'margin-top:12px' },\n      h('div', {}, 'সহকারী চালু', h('div', { class: 'mute' }, s.away ? 'এখন আপনাকে অফলাইন ধরা হচ্ছে, তাই সহকারী উত্তর দিচ্ছে' : 'আপনি সক্রিয়, তাই সহকারী চুপ আছে')),\n      h('label', { class: 'sw' }, sw, h('span'))) : null,\n    c.status === 'connected' ? h('div', { class: 'mute', style: 'margin-top:8px' },\n      s.learned ? 'আপনার কথার ধরন শেখা হয়ে গেছে।' : 'আপনার কথার ধরন শেখা হচ্ছে। পুরনো চ্যাট আসতে কিছুক্ষণ লাগে।') : null,\n    !s.hasKey ? h('div', { class: 'note bad' }, 'GEMINI_API_KEY দেওয়া হয়নি। Railway-এর Variables-এ যোগ করুন।') : null,\n    ...(s.problems || []).map((p) => h('div', { class: 'note bad' }, p.text))\n  );\n  $('#flags').replaceChildren(h('h2', {}, 'আপনার উত্তরের জন্য অপেক্ষায়'),\n    s.flags.length ? s.flags.map((f) => h('div', { class: 'item' },\n      h('div', { class: 'who' }, (f.name || f.jid.split('@')[0]) + ' · ' + fmt(f.ts)),\n      h('div', { class: 'txt' }, f.message),\n      h('div', { class: 'who' }, 'কেন: ' + f.reason),\n      h('button', { onclick: async () => { await api('/api/flags/' + f.id + '/done', {}); load(); } }, 'দেখেছি'))) :\n      h('div', { class: 'mute' }, 'এখন কিছু নেই। জরুরি বা ব্যক্তিগত মেসেজে সহকারী উত্তর না দিয়ে এখানে রেখে দেয়।'));\n  $('#replies').replaceChildren(h('h2', {}, 'সহকারী যা উত্তর দিয়েছে'),\n    s.replies.length ? s.replies.map((r) => h('div', { class: 'item' },\n      h('div', { class: 'who' }, (r.name || r.jid.split('@')[0]) + ' · ' + fmt(r.ts)), h('div', { class: 'txt' }, r.body))) :\n      h('div', { class: 'mute' }, 'এখনো কোনো উত্তর দেওয়া হয়নি।'));\n}\nasync function load(force) { const s = await api('/api/state'); if (s && s.conn) { if (force && document.activeElement) document.activeElement.blur(); render(s); } }\n$('#re').onclick = async () => { await api('/api/reconnect', {}); load(); };\n$('#un').onclick = async () => { if (confirm('WhatsApp আনলিঙ্ক করে নতুন QR নেবেন?')) { await api('/api/unlink', {}); load(); } };\n$('#out').onclick = async () => { await api('/logout', {}); location = '/login'; };\nload(); setInterval(load, 5000);\n</script>\n</body>\n</html>\n";
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

  app.get('/', (req, res) => res.type('html').send(INDEX_HTML));

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
