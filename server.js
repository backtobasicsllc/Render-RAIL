/**
 * RENDER RAIL STUDIO — multi-user AI content production console.
 *
 * Tools: Nano Banana Pro (images) · Veo 3.1 · Grok Imagine · HeyGen · ElevenLabs
 * Plus the Director: Claude writes tool-ready prompts from a brief + character bible.
 *
 * Multi-user: email/password accounts. Each user connects their OWN API keys
 * (encrypted at rest with AES-256-GCM), runs their own queue, and only sees
 * their own files. Deploy on any Node host; put HTTPS in front for real users.
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const E = require('./lib/engines');
const { DEFAULT_PRESETS, buildDirectorMessages, buildChatSystem } = require('./lib/presets');

const ROOT = __dirname;
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const KEYS_DIR = path.join(DATA_DIR, 'keys');
const PRESETS_DIR = path.join(DATA_DIR, 'presets');
const OUT_DIR = process.env.OUT_DIR || path.join(ROOT, 'outputs');
for (const d of [DATA_DIR, KEYS_DIR, PRESETS_DIR, OUT_DIR]) fs.mkdirSync(d, { recursive: true });

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function id(n = 5) { return crypto.randomBytes(n).toString('hex'); }
function slug(s, max = 42) { return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'item'; }
function loadJson(p, fb) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return structuredClone(fb); } }
function saveJson(p, v) { fs.writeFileSync(p, JSON.stringify(v, null, 2)); }

// ---------------------------------------------------------------- secret + key vault

const SECRET_PATH = path.join(DATA_DIR, '.secret');
if (!fs.existsSync(SECRET_PATH)) fs.writeFileSync(SECRET_PATH, crypto.randomBytes(32));
const SECRET = fs.readFileSync(SECRET_PATH).subarray(0, 32);

function encrypt(obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', SECRET, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(b64, fb) {
  try {
    const buf = Buffer.from(b64, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', SECRET, buf.subarray(0, 12));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
  } catch { return structuredClone(fb); }
}

const DEFAULT_PROFILE = {
  keys: { kie: '', kieImage: '', kieVideo: '', gemini: '', xai: '', heygen: '', eleven: '', anthropic: '', openai: '' },
  models: { nano: 'gemini-3-pro-image-preview', gptimage: 'gpt-image-1', veo: 'veo-3.1-generate-preview', grok: 'grok-imagine-video', eleven: 'eleven_turbo_v2_5',
    kieImage: 'google/nano-banana', kieVideo: 'veo3_fast', director: 'claude-sonnet-4-6' },
  eleven: { stability: 0.55, similarity: 0.75, style: 0.15, speakerBoost: false },
  picks: { heygenAvatar: '', heygenVoice: '', elevenVoice: '' }
};

function profilePath(userId) { return path.join(KEYS_DIR, userId + '.enc'); }
function fixupModels(prof) {
  if (prof?.models?.kieVideo === 'veo3-fast') prof.models.kieVideo = 'veo3_fast';
  return prof;
}
function loadProfile(userId) {
  const p = profilePath(userId);
  if (!fs.existsSync(p)) return structuredClone(DEFAULT_PROFILE);
  const prof = decrypt(fs.readFileSync(p, 'utf8'), DEFAULT_PROFILE);
  return fixupModels(Object.assign(structuredClone(DEFAULT_PROFILE), prof, {
    keys: { ...DEFAULT_PROFILE.keys, ...(prof.keys || {}) },
    models: { ...DEFAULT_PROFILE.models, ...(prof.models || {}) },
    eleven: { ...DEFAULT_PROFILE.eleven, ...(prof.eleven || {}) },
    picks: { ...DEFAULT_PROFILE.picks, ...(prof.picks || {}) }
  }));
}
function saveProfile(userId, prof) { fs.writeFileSync(profilePath(userId), encrypt(prof)); }

function loadPresets(userId) {
  const p = path.join(PRESETS_DIR, userId + '.json');
  if (!fs.existsSync(p)) { saveJson(p, DEFAULT_PRESETS); return structuredClone(DEFAULT_PRESETS); }
  return loadJson(p, DEFAULT_PRESETS);
}
function savePresets(userId, presets) { saveJson(path.join(PRESETS_DIR, userId + '.json'), presets); }

// ---------------------------------------------------------------- users + sessions

const USERS_PATH = path.join(DATA_DIR, 'users.json');
const SESS_PATH = path.join(DATA_DIR, 'sessions.json');
let users = loadJson(USERS_PATH, []);
let sessions = loadJson(SESS_PATH, {});

function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 64).toString('hex'); }

function getSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)rrs=([a-f0-9]{48})/);
  if (!m) return null;
  const sess = sessions[m[1]];
  return sess ? { token: m[1], userId: sess.userId } : null;
}

function requireAuth(req, res, next) {
  const sess = getSession(req);
  if (!sess) return res.status(401).json({ error: 'Not signed in.' });
  req.userId = sess.userId;
  next();
}

// ---------------------------------------------------------------- jobs + queue

const JOBS_PATH = path.join(DATA_DIR, 'jobs.json');
let jobs = loadJson(JOBS_PATH, []);
for (const j of jobs) if (j.status === 'running' || j.status === 'polling') j.status = 'queued';

let saveTimer = null;
function saveJobs() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveJson(JOBS_PATH, jobs), 400);
}

const ENGINES = ['nano', 'gptimage', 'kieimage', 'veo', 'grok', 'kievideo', 'heygen', 'eleven'];
const CONCURRENCY = { nano: 3, gptimage: 3, kieimage: 4, veo: 2, grok: 2, kievideo: 3, heygen: 2, eleven: 3 }; // global, per engine

function tick() {
  for (const engine of ENGINES) {
    let slots = CONCURRENCY[engine] - jobs.filter(j => j.engine === engine && (j.status === 'running' || j.status === 'polling')).length;
    if (slots <= 0) continue;
    const waiting = jobs.filter(j => j.engine === engine && j.status === 'queued' && (!j.notBefore || j.notBefore <= Date.now()));
    for (const job of waiting.slice(0, slots)) startJob(job).catch(err => failJob(job, err));
  }
}
setInterval(tick, 1500);

function outputFor(job) {
  return ext => {
    const dir = path.join(OUT_DIR, job.userId, job.batchSlug);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${String(job.index).padStart(3, '0')}_${slug(job.prompt)}${job.variant > 1 ? '_v' + job.variant : ''}.${ext}`;
    return { abs: path.join(dir, name), rel: path.posix.join(job.userId, job.batchSlug, name) };
  };
}

async function startJob(job) {
  job.status = 'running'; job.startedAt = Date.now(); job.error = null;
  saveJobs();
  log(`[${job.engine}] start ${job.id} — ${job.prompt.slice(0, 60)}`);
  const keys = loadProfile(job.userId).keys;
  const out = outputFor(job);
  const onPolling = op => { job.status = 'polling'; job.operation = op; saveJobs(); };
  try {
    const resolveImage = rel => path.join(OUT_DIR, rel);
    const resolveRef = rel => path.join(REFS_DIR, rel);
    if (job.engine === 'nano') await E.runNano(job, keys, out, resolveRef);
    else if (job.engine === 'gptimage') await E.runGptImage(job, keys, out, resolveRef);
    else if (job.engine === 'kieimage') await E.runKieImage(job, keys, out, resolveRef);
    else if (job.engine === 'kievideo') await E.runKieVideo(job, keys, out, onPolling, resolveImage);
    else if (job.engine === 'veo') await E.runVeo(job, keys, out, onPolling, resolveImage);
    else if (job.engine === 'grok') await E.runGrok(job, keys, out, onPolling, resolveImage);
    else if (job.engine === 'heygen') {
      // chained clips animate the generated still via Avatar IV; standard jobs use the picked avatar
      if (job.imageFile) await E.runHeygenAv4(job, keys, out, onPolling, resolveImage);
      else await E.runHeygen(job, keys, out, onPolling);
    }
    else if (job.engine === 'eleven') await E.runEleven(job, keys, out);
    job.status = 'done'; job.finishedAt = Date.now();
    log(`[${job.engine}] done  ${job.id} -> ${job.file}`);
    if (job.chain && job.file) {
      const c = job.chain;
      const prof = loadProfile(job.userId);
      jobs.push({
        id: id(), userId: job.userId, batchId: job.batchId, batchSlug: job.batchSlug,
        index: job.index, variant: job.variant, engine: c.videoEngine,
        prompt: c.videoPrompt || job.prompt, model: prof.models[c.videoEngine === 'kievideo' ? 'kieVideo' : c.videoEngine === 'kieimage' ? 'kieImage' : c.videoEngine],
        aspectRatio: c.aspectRatio || job.aspectRatio || '9:16',
        resolution: (c.videoEngine === 'grok' || c.videoEngine === 'veo') ? (c.resolution || '720p') : undefined,
        duration: c.videoEngine === 'grok' ? (c.duration || 6) : undefined,
        voiceId: c.videoEngine === 'eleven' ? prof.picks.elevenVoice
               : c.videoEngine === 'heygen' ? prof.picks.heygenVoice : undefined,
        voiceSettings: c.videoEngine === 'eleven' ? prof.eleven : undefined,
        // carry media forward: an image parent feeds imageFile, an audio parent feeds audioFile
        imageFile: job.kind === 'image' ? job.file : job.imageFile,
        audioFile: job.kind === 'audio' ? job.file : job.audioFile,
        chain: c.next || undefined,
        chained: true,
        status: 'queued', attempts: 0, createdAt: Date.now()
      });
      log(`[chain] ${job.engine} ${job.id} -> ${c.videoEngine} queued`);
      saveJobs();
    }
  } catch (err) { failJob(job, err); }
  saveJobs();
}

function failJob(job, err) {
  const msg = err?.message || String(err);
  job.attempts = (job.attempts || 0) + 1;
  const transient = /\b(429|500|502|503|504|timeout|fetch failed|ECONN|network)\b/i.test(msg);
  if (transient && job.attempts <= 2) {
    job.status = 'queued';
    job.notBefore = Date.now() + 20000 * job.attempts;
    job.error = `retrying after: ${msg}`;
  } else {
    job.status = 'failed'; job.error = msg; job.finishedAt = Date.now();
    log(`[${job.engine}] FAIL  ${job.id} — ${msg}`);
  }
  saveJobs();
}

// ---------------------------------------------------------------- app

const app = express();
app.use(express.json({ limit: '30mb' }));
app.use(express.static(path.join(ROOT, 'public')));

// ---- auth
function startSession(res, userId) {
  const token = id(24);
  sessions[token] = { userId, createdAt: Date.now() };
  saveJson(SESS_PATH, sessions);
  res.setHeader('Set-Cookie', `rrs=${token}; HttpOnly; Path=/; Max-Age=31536000; SameSite=Lax`);
}

app.post('/api/register', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const pass = String(req.body?.password || '');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email.' });
  if (pass.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (users.some(u => u.email === email)) return res.status(400).json({ error: 'That email is already registered.' });
  const salt = id(8);
  const user = { id: id(6), email, salt, passHash: hashPass(pass, salt), createdAt: Date.now() };
  users.push(user);
  saveJson(USERS_PATH, users);
  loadPresets(user.id); // seed the character bibles
  startSession(res, user.id);
  res.json({ ok: true, email });
});

app.post('/api/login', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = users.find(u => u.email === email);
  if (!user || hashPass(String(req.body?.password || ''), user.salt) !== user.passHash) {
    return res.status(401).json({ error: 'Wrong email or password.' });
  }
  startSession(res, user.id);
  res.json({ ok: true, email });
});

app.post('/api/logout', (req, res) => {
  const sess = getSession(req);
  if (sess) { delete sessions[sess.token]; saveJson(SESS_PATH, sessions); }
  res.setHeader('Set-Cookie', 'rrs=; HttpOnly; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---- claude model catalog (from the user's own Anthropic account)
app.get('/api/catalog/claude', requireAuth, async (req, res) => {
  const prof = loadProfile(req.userId);
  if (!prof.keys.anthropic) return res.status(400).json({ error: 'Add your Anthropic API key first — the model list comes from your account.' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/models?limit=100', {
      headers: { 'x-api-key': prof.keys.anthropic, 'anthropic-version': '2023-06-01' }
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
    const models = (d.data || []).map(m => ({ id: m.id, name: m.display_name || m.id }));
    if (!models.length) throw new Error('No models returned.');
    res.json({ models });
  } catch (err) {
    res.status(502).json({ error: 'Could not load models from Anthropic: ' + String(err.message || err).slice(0, 150) });
  }
});

// ---- kie live credits
const kieCreditCache = {}; // userId -> { at, payload }
app.get('/api/kie/credits', requireAuth, async (req, res) => {
  const prof = loadProfile(req.userId);
  const kkey = prof.keys.kie || prof.keys.kieImage || prof.keys.kieVideo;
  if (!kkey) return res.json({ connected: false });
  const c = kieCreditCache[req.userId];
  if (c && Date.now() - c.at < 15000) return res.json(c.payload);
  let payload;
  try {
    const r = await fetch('https://api.kie.ai/api/v1/chat/credit', { headers: { 'Authorization': `Bearer ${kkey}` } });
    const text = await r.text();
    let d; try { d = JSON.parse(text); } catch { d = {}; }
    if (!r.ok) throw new Error(d?.msg || `HTTP ${r.status}`);
    // credits may arrive as data: <number> or data: { credits/balance/remaining }
    const raw = d.data;
    const credits = typeof raw === 'number' ? raw
      : Number(raw?.credits ?? raw?.balance ?? raw?.remaining ?? raw?.credit ?? NaN);
    if (!Number.isFinite(credits)) throw new Error('unexpected credit format');
    if (!prof.kieBaseline || credits > prof.kieBaseline) { prof.kieBaseline = credits; saveProfile(req.userId, prof); }
    payload = { connected: true, credits, usd: +(credits * 0.005).toFixed(2), baseline: prof.kieBaseline, refreshedAt: new Date().toISOString().slice(0, 19).replace('T', ' ') };
  } catch (err) {
    payload = { connected: true, credits: null, error: String(err.message || err).slice(0, 120) };
  }
  kieCreditCache[req.userId] = { at: Date.now(), payload };
  res.json(payload);
});

// ---- state
app.get('/api/state', requireAuth, (req, res) => {
  const prof = loadProfile(req.userId);
  const mine = jobs.filter(j => j.userId === req.userId);
  const counts = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const j of mine) {
    if (j.status === 'polling') counts.running++;
    else if (counts[j.status] !== undefined) counts[j.status]++;
  }
  const mask = k => (k ? `••••${k.slice(-4)}` : '');
  const user = users.find(u => u.id === req.userId);
  res.json({
    email: user?.email || '',
    counts,
    jobs: mine.slice().reverse().slice(0, 400),
    settings: {
      keys: Object.fromEntries(Object.entries(prof.keys).map(([k, v]) => [k, mask(v)])),
      connected: Object.fromEntries(Object.entries(prof.keys).map(([k, v]) => [k, !!v])),
      models: prof.models,
      eleven: prof.eleven,
      picks: prof.picks
    },
    presets: loadPresets(req.userId).map(p => ({ id: p.id, name: p.name,
      hasRef: ['png','jpg','jpeg','webp'].some(e => fs.existsSync(path.join(REFS_DIR, req.userId, `${p.id}.${e}`))) }))
  });
});

// ---- settings
app.post('/api/settings', requireAuth, async (req, res) => {
  const prof = loadProfile(req.userId);
  const b = req.body || {};
  // when the user picks their ElevenLabs voice, pull that voice's saved settings from their account
  if (b.picks?.elevenVoice && prof.keys.eleven) {
    try {
      prof.eleven = await E.elevenVoiceSettings(prof.keys, b.picks.elevenVoice);
    } catch { /* keep current settings if the fetch fails */ }
  }
  for (const k of Object.keys(DEFAULT_PROFILE.keys)) {
    const v = b.keys?.[k];
    if (typeof v === 'string' && v.trim() && !v.includes('••')) prof.keys[k] = v.trim();
    if (b.clearKeys?.[k]) prof.keys[k] = '';
  }
  if (b.models) Object.assign(prof.models, Object.fromEntries(Object.entries(b.models).filter(([, v]) => typeof v === 'string' && v.trim())));
  if (b.eleven) Object.assign(prof.eleven, b.eleven);
  if (b.picks) Object.assign(prof.picks, Object.fromEntries(Object.entries(b.picks).filter(([,v]) => typeof v === 'string')));
  saveProfile(req.userId, prof);
  res.json({ ok: true });
});

// ---- presets
app.get('/api/presets', requireAuth, (req, res) => res.json({ presets: loadPresets(req.userId) }));
app.post('/api/presets', requireAuth, (req, res) => {
  const list = req.body?.presets;
  if (!Array.isArray(list) || list.length > 30) return res.status(400).json({ error: 'Invalid presets.' });
  for (const p of list) {
    if (!p.id) p.id = slug(p.name || id(3), 30);
    p.name = String(p.name || 'Untitled').slice(0, 60);
    p.character = String(p.character || '').slice(0, 4000);
    p.rules = Object.fromEntries(ENGINES.map(e => [e, String(p.rules?.[e] || '').slice(0, 4000)]));
  }
  savePresets(req.userId, list);
  res.json({ ok: true });
});

// ---- director chat (persistent, per character)
const REFS_DIR = path.join(DATA_DIR, 'refs');
fs.mkdirSync(REFS_DIR, { recursive: true });

const CHATS_DIR = path.join(DATA_DIR, 'chats');
fs.mkdirSync(CHATS_DIR, { recursive: true });
function loadChats(userId) { return loadJson(path.join(CHATS_DIR, userId + '.json'), []); }
function saveChats(userId, chats) { saveJson(path.join(CHATS_DIR, userId + '.json'), chats); }

app.get('/api/chats', requireAuth, (req, res) => {
  const chats = loadChats(req.userId)
    .map(c => ({ id: c.id, presetId: c.presetId, title: c.title, updatedAt: c.updatedAt, count: c.messages.length }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  res.json({ chats });
});

app.get('/api/chats/:id', requireAuth, (req, res) => {
  const chat = loadChats(req.userId).find(c => c.id === req.params.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });
  res.json({ chat });
});

app.post('/api/chats/import', requireAuth, (req, res) => {
  const { presetId, conversations } = req.body || {};
  if (!presetId) return res.status(400).json({ error: 'Pick a character first.' });
  const list = Array.isArray(conversations) ? conversations : [];
  if (!list.length) return res.status(400).json({ error: 'No conversations found in that file — export from claude.ai Settings → Export data, then upload conversations.json.' });
  const chats = loadChats(req.userId);
  let imported = 0;
  for (const conv of list.slice(0, 200)) {
    const msgs = (conv.chat_messages || conv.messages || [])
      .map(m => {
        const role = (m.sender === 'human' || m.role === 'user') ? 'user' : 'assistant';
        let content = typeof m.text === 'string' && m.text ? m.text
          : Array.isArray(m.content) ? m.content.map(c => c?.text || '').join('\n') : '';
        return content.trim() ? { role, content: content.slice(0, 40000) } : null;
      })
      .filter(Boolean).slice(-200);
    if (!msgs.length) continue;
    chats.unshift({
      id: id(), presetId,
      title: String(conv.name || msgs[0].content).replace(/\s+/g, ' ').slice(0, 48) || 'Imported chat',
      messages: msgs,
      createdAt: Date.now(), updatedAt: Date.parse(conv.updated_at || '') || Date.now(),
      imported: true
    });
    imported++;
  }
  saveChats(req.userId, chats.slice(0, 500));
  res.json({ ok: true, imported });
});

app.delete('/api/chats/:id', requireAuth, (req, res) => {
  const chats = loadChats(req.userId);
  const i = chats.findIndex(c => c.id === req.params.id);
  if (i === -1) return res.status(404).json({ error: 'Chat not found.' });
  chats.splice(i, 1);
  saveChats(req.userId, chats);
  res.json({ ok: true });
});

app.post('/api/chat', requireAuth, async (req, res) => {
  try {
    const { presetId, chatId, message } = req.body || {};
    const preset = loadPresets(req.userId).find(p => p.id === presetId);
    if (!preset) return res.status(400).json({ error: 'Pick a character preset.' });
    const text = String(message || '').trim().slice(0, 40000);
    if (!text) return res.status(400).json({ error: 'Say something first.' });

    const chats = loadChats(req.userId);
    let chat = chatId ? chats.find(c => c.id === chatId) : null;
    if (!chat) {
      chat = { id: id(), presetId, title: text.replace(/\s+/g, ' ').slice(0, 48), messages: [], createdAt: Date.now() };
      chats.unshift(chat);
    }
    chat.messages.push({ role: 'user', content: text });

    const prof2 = loadProfile(req.userId);
    const history = chat.messages.slice(-30).map(m => ({ role: m.role, content: m.content }));
    const reply = await E.runChat({ keys: prof2.keys, system: buildChatSystem(preset), messages: history, model: prof2.models.director });

    chat.messages.push({ role: 'assistant', content: reply });
    chat.updatedAt = Date.now();
    if (chat.messages.length > 200) chat.messages = chat.messages.slice(-200);
    saveChats(req.userId, chats);
    res.json({ ok: true, chatId: chat.id, title: chat.title, reply });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- director
app.post('/api/director', requireAuth, async (req, res) => {
  try {
    const { presetId, tool, brief, count } = req.body || {};
    if (!ENGINES.includes(tool)) return res.status(400).json({ error: 'Pick a target tool.' });
    if (!String(brief || '').trim()) return res.status(400).json({ error: 'Write a brief first.' });
    const n = Math.min(Math.max(1, Number(count) || 5), 25);
    const preset = loadPresets(req.userId).find(p => p.id === presetId);
    if (!preset) return res.status(400).json({ error: 'Pick a character preset.' });
    const keys = loadProfile(req.userId).keys;
    const { system, user } = buildDirectorMessages({ preset, tool, brief: String(brief).slice(0, 6000), count: n });
    const prompts = await E.runDirector({ keys, system, user, maxTokens: Math.min(300 * n + 800, 8000) });
    res.json({ ok: true, prompts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- character reference images
app.post('/api/presets/:id/reference', requireAuth, (req, res) => {
  const { data, mime } = req.body || {};
  if (!data || !/^image\/(png|jpe?g|webp)$/.test(mime || '')) return res.status(400).json({ error: 'Send a PNG, JPG, or WebP image.' });
  const buf = Buffer.from(String(data), 'base64');
  if (buf.length < 1000 || buf.length > 20 * 1024 * 1024) return res.status(400).json({ error: 'Image must be under 20 MB.' });
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg';
  const dir = path.join(REFS_DIR, req.userId);
  fs.mkdirSync(dir, { recursive: true });
  for (const e of ['png', 'jpg', 'jpeg', 'webp']) { const p = path.join(dir, `${req.params.id}.${e}`); if (fs.existsSync(p)) fs.unlinkSync(p); }
  fs.writeFileSync(path.join(dir, `${req.params.id}.${ext}`), buf);
  res.json({ ok: true });
});
app.get('/api/presets/:id/reference', requireAuth, (req, res) => {
  for (const e of ['png', 'jpg', 'jpeg', 'webp']) {
    const p = path.join(REFS_DIR, req.userId, `${req.params.id}.${e}`);
    if (fs.existsSync(p)) return res.sendFile(p);
  }
  res.status(404).json({ error: 'No reference image set.' });
});

// ---- catalogs
app.get('/api/catalog/heygen', requireAuth, async (req, res) => {
  try { res.json(await E.heygenCatalog(loadProfile(req.userId).keys)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/catalog/eleven', requireAuth, async (req, res) => {
  try { res.json(await E.elevenCatalog(loadProfile(req.userId).keys)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ---- batches
app.post('/api/batches', requireAuth, (req, res) => {
  const { engine, prompts, options = {} } = req.body || {};
  if (engine === 'shot') return createShotBatch(req, res, prompts, options);
  if (!ENGINES.includes(engine)) return res.status(400).json({ error: 'Unknown engine.' });
  const raw = String(Array.isArray(prompts) ? prompts.join('\n') : prompts || '');
  // long scripts (heygen/eleven) can use --- on its own line as a separator
  const list = (raw.includes('\n---') || raw.startsWith('---')
    ? raw.split(/\n?---\n?/) : raw.split('\n'))
    .map(p => p.trim()).filter(Boolean);
  if (!list.length) return res.status(400).json({ error: 'No prompts provided.' });
  if (list.length > 500) return res.status(400).json({ error: 'Max 500 items per batch.' });

  const prof = loadProfile(req.userId);
  let refImage = null;
  if (options.presetId && ['kieimage', 'nano', 'gptimage'].includes(engine)) {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      const pth = path.join(REFS_DIR, req.userId, `${options.presetId}.${ext}`);
      if (fs.existsSync(pth)) { refImage = path.posix.join(req.userId, `${options.presetId}.${ext}`); break; }
    }
  }
  if (engine === 'heygen' && (!options.avatarId || !options.voiceId)) {
    return res.status(400).json({ error: 'Pick a HeyGen avatar and voice first — they are remembered after the first time.' });
  }
  const stamp = new Date().toISOString().slice(5, 16).replace(/[:T]/g, '-');
  const batchSlug = (options.batchName ? slug(options.batchName, 30) : '') || `${engine}-${stamp}`;
  const variations = Math.min(Math.max(1, Number(options.variations) || 1), 8);
  const batchId = id();
  let index = 1;

  for (const prompt of list) {
    for (let v = 1; v <= variations; v++) {
      jobs.push({
        id: id(), userId: req.userId, batchId, batchSlug, index, variant: v, engine, prompt,
        model: options.model || prof.models[engine === 'kieimage' ? 'kieImage' : engine === 'kievideo' ? 'kieVideo' : engine] || undefined,
        refImage: refImage || undefined,
        aspectRatio: engine === 'eleven' ? undefined : (options.aspectRatio || '9:16'),
        resolution: (engine === 'veo' || engine === 'grok' || engine === 'kievideo') ? (options.resolution || '720p') : undefined,
        duration: (engine === 'grok' || engine === 'kievideo') ? (options.duration || 6) : undefined,
        avatarId: engine === 'heygen' ? options.avatarId : undefined,
        voiceId: (engine === 'heygen' || engine === 'eleven') ? options.voiceId : undefined,
        voiceSettings: engine === 'eleven' ? prof.eleven : undefined,
        status: 'queued', attempts: 0, createdAt: Date.now()
      });
    }
    index++;
  }
  saveJobs();
  res.json({ ok: true, batchId, batchSlug, count: list.length * variations });
});


// Parse producer-format clips: multi-paragraph prompts labeled
// "IMAGE:"/"ChatGPT Image Prompt:", "VIDEO:"/"Grok Video Prompt:", "HEYGEN:"/"HeyGen Script:",
// separated by --- lines or "CLIP n" headers. Tolerates markdown (>, **, ##).
function parseClips(raw) {
  const text = String(raw || '').replace(/\r/g, '');
  const chunks = text.split(/\n\s*-{3,}\s*\n|\n(?=#{0,4}\s*(?:\*\*)?\s*CLIP\s+\d)/i);
  const clips = [];
  for (const chunk of chunks) {
    let cur = null, title = '';
    const buf = { img: [], vid: [], hg: [] };
    for (const rawLine of chunk.split('\n')) {
      const l = rawLine.replace(/^\s*>\s?/, '').replace(/\*\*/g, '').replace(/^#{1,4}\s*/, '').trim();
      const t = l.match(/^CLIP\s+\d+.*$/i);
      if (t && !cur) { title = l; continue; }
      const m = l.match(/^((?:chatgpt\s+)?image(?:\s+prompt)?|(?:grok\s+|veo\s+)?video(?:\s+prompt)?|heygen(?:\s+script)?)\s*:\s*(.*)$/i);
      if (m) {
        cur = /image/i.test(m[1]) ? 'img' : /video/i.test(m[1]) ? 'vid' : 'hg';
        if (m[2]) buf[cur].push(m[2]);
        continue;
      }
      if (cur) buf[cur].push(l);
    }
    const join = a => a.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const img = join(buf.img), vid = join(buf.vid), hg = join(buf.hg);
    if (img && (vid || hg)) clips.push({ title, img, vid, hg });
  }
  return clips;
}

function createShotBatch(req, res, prompts, options) {
  const videoEngine = ['veo','grok','kievideo'].includes(options.videoEngine) ? options.videoEngine : 'grok';
  const clips = parseClips(prompts);
  if (!clips.length) return res.status(400).json({ error: 'No labeled clips found — need IMAGE: plus VIDEO: or HEYGEN: per clip.' });
  if (clips.length > 100) return res.status(400).json({ error: 'Max 100 clips per batch.' });

  const prof = loadProfile(req.userId);
  // character reference image, if one is set for this preset
  let refImage = null;
  if (options.presetId) {
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      const p = path.join(REFS_DIR, req.userId, `${options.presetId}.${ext}`);
      if (fs.existsSync(p)) { refImage = path.posix.join(req.userId, `${options.presetId}.${ext}`); break; }
    }
  }

  const stamp = new Date().toISOString().slice(5, 16).replace(/[:T]/g, '-');
  const batchSlug = (options.batchName ? slug(options.batchName, 30) : '') || `clips-${stamp}`;
  const batchId = id();
  let nVid = 0, nHg = 0;
  const imgEngine = ['nano','gptimage','kieimage'].includes(options.imageEngine) ? options.imageEngine : 'gptimage';
  clips.forEach((c, i) => {
    const isHg = !c.vid && c.hg;
    if (isHg) nHg++; else nVid++;
    jobs.push({
      id: id(), userId: req.userId, batchId, batchSlug, index: i + 1, variant: 1,
      engine: imgEngine, prompt: c.img, model: prof.models[imgEngine === 'kieimage' ? 'kieImage' : imgEngine],
      aspectRatio: options.aspectRatio || '9:16',
      refImage,
      clipTitle: c.title || undefined,
      chain: isHg
        ? { videoEngine: 'eleven', videoPrompt: c.hg,
            next: { videoEngine: 'heygen', videoPrompt: c.hg, aspectRatio: options.aspectRatio || '9:16' } }
        : { videoEngine, videoPrompt: c.vid, aspectRatio: options.aspectRatio || '9:16', resolution: options.resolution || '720p', duration: options.duration || 6 },
      status: 'queued', attempts: 0, createdAt: Date.now()
    });
  });
  saveJobs();
  res.json({ ok: true, batchId, batchSlug, count: clips.length, video: nVid, heygen: nHg });
}

// ---- job controls
app.post('/api/jobs/:id/retry', requireAuth, (req, res) => {
  const job = jobs.find(j => j.id === req.params.id && j.userId === req.userId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.status === 'running' || job.status === 'polling') return res.status(400).json({ error: 'Job is in flight.' });
  job.status = 'queued'; job.error = null; job.attempts = 0; job.notBefore = 0;
  saveJobs(); res.json({ ok: true });
});
app.post('/api/jobs/retry-failed', requireAuth, (req, res) => {
  let n = 0;
  for (const j of jobs) if (j.userId === req.userId && j.status === 'failed') { j.status = 'queued'; j.error = null; j.attempts = 0; j.notBefore = 0; n++; }
  saveJobs(); res.json({ ok: true, retried: n });
});
app.delete('/api/jobs/:id', requireAuth, (req, res) => {
  const i = jobs.findIndex(j => j.id === req.params.id && j.userId === req.userId);
  if (i === -1) return res.status(404).json({ error: 'Job not found.' });
  if (jobs[i].status === 'running' || jobs[i].status === 'polling') return res.status(400).json({ error: 'Cannot remove a job in flight.' });
  jobs.splice(i, 1); saveJobs(); res.json({ ok: true });
});
app.post('/api/jobs/clear-finished', requireAuth, (req, res) => {
  const before = jobs.length;
  jobs = jobs.filter(j => j.userId !== req.userId || (j.status !== 'done' && j.status !== 'failed'));
  saveJobs(); res.json({ ok: true, removed: before - jobs.length });
});

// ---- files (auth-gated; users can only reach their own folder)
app.get('/files/*', requireAuth, (req, res) => {
  const rel = decodeURIComponent(req.params[0] || '');
  if (!rel.startsWith(req.userId + '/')) return res.status(403).json({ error: 'Not yours.' });
  const abs = path.resolve(OUT_DIR, rel);
  if (!abs.startsWith(path.resolve(OUT_DIR)) || !fs.existsSync(abs)) return res.status(404).json({ error: 'Not found.' });
  res.sendFile(abs);
});

const PORT = process.env.PORT || 4600;
app.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  log(`RENDER RAIL TEAM → port ${PORT}`);
  log(`Outputs → ${OUT_DIR}`);
});
