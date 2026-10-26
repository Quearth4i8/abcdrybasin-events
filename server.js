'use strict';

const express = require('express');
const QRCode = require('qrcode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
// Bind IPv4 explicitly: on Windows an IPv6 listener can silently coexist with another app's IPv4 listener on the same port
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const SEED_FILE = path.join(__dirname, 'data', 'seed.json');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const SESSION_TTL_MS = 1000 * 60 * 60 * 12; // 12h
const COOKIE = 'abcd_admin';

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

/* ---------------------------------------------------------------- storage */

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const known = Buffer.from(hash, 'hex');
  return known.length === test.length && crypto.timingSafeEqual(known, test);
}

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
    seed.admin = {
      username: process.env.ADMIN_USER || 'admin',
      passwordHash: hashPassword(process.env.ADMIN_PASSWORD || 'admin123'),
      isDefault: !process.env.ADMIN_PASSWORD
    };
    seed.secret = crypto.randomBytes(32).toString('hex');
    saveDb(seed);
    return seed;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function saveDb(data) {
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

let db = loadDb();
const commit = () => saveDb(db);
const newId = (prefix) => `${prefix}${crypto.randomBytes(5).toString('hex')}`;

function publicContent() {
  const { event, features, days, partners } = db;
  return { event, features, days, partners };
}

/* ---------------------------------------------------------------- sessions */

function sign(value) {
  return crypto.createHmac('sha256', db.secret).update(value).digest('hex');
}

function makeToken(username) {
  const payload = Buffer.from(JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, sig] = token.split('.');
  const expected = sign(payload);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return data.exp > Date.now() && data.u === db.admin.username ? data : null;
  } catch {
    return null;
  }
}

function getCookie(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSessionCookie(req, res, token, maxAgeMs) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure ? '; Secure' : ''}`);
}

function requireAdmin(req, res, next) {
  const session = readToken(getCookie(req, COOKIE));
  if (!session) return res.status(401).json({ error: 'Not authenticated' });
  req.admin = session;
  next();
}

// Simple brute-force protection: 8 failed attempts per IP per 15 minutes.
const attempts = new Map();
function tooManyAttempts(ip) {
  const a = attempts.get(ip);
  if (!a || a.reset < Date.now()) return false;
  return a.count >= 8;
}
function recordFailure(ip) {
  const a = attempts.get(ip);
  if (!a || a.reset < Date.now()) attempts.set(ip, { count: 1, reset: Date.now() + 15 * 60 * 1000 });
  else a.count++;
}

/* ---------------------------------------------------------------- helpers */

const str = (v, max = 2000) => (v === undefined || v === null ? '' : String(v).slice(0, max).trim());
const bool = (v) => v === true || v === 'true' || v === 1;

const EVENT_FIELDS = ['logo', 'seminarTitle', 'title', 'programTitle', 'dateLabel', 'dateSub', 'timeLabel',
  'location', 'heroImage', 'registerLabel', 'registerUrl', 'email'];

function cleanFeature(b) {
  return { title: str(b.title, 120), subtitle: str(b.subtitle, 200) };
}
function cleanDay(b) {
  return { title: str(b.title, 200) };
}
function cleanSession(b) {
  return {
    type: b.type === 'break' ? 'break' : 'session',
    start: str(b.start, 10),
    end: str(b.end, 10),
    title: str(b.title, 400),
    speaker: str(b.speaker, 300)
  };
}
function cleanPartner(b) {
  return { name: str(b.name, 200), logo: str(b.logo, 500), url: str(b.url, 500), header: bool(b.header), footer: bool(b.footer) };
}

function reorder(list, ids) {
  if (!Array.isArray(ids)) return false;
  const byId = new Map(list.map((x) => [x.id, x]));
  if (ids.length !== list.length || !ids.every((id) => byId.has(id))) return false;
  list.splice(0, list.length, ...ids.map((id) => byId.get(id)));
  return true;
}

// Generic CRUD routes for a top-level list in the db.
function crudRoutes(router, name, prefix, clean, getList = () => db[name]) {
  router.post(`/${name}`, (req, res) => {
    const item = { id: newId(prefix), ...clean(req.body) };
    getList().push(item);
    commit();
    res.status(201).json(item);
  });
  router.put(`/${name}/:id`, (req, res) => {
    const item = getList().find((x) => x.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    Object.assign(item, clean({ ...item, ...req.body }));
    commit();
    res.json(item);
  });
  router.delete(`/${name}/:id`, (req, res) => {
    const list = getList();
    const i = list.findIndex((x) => x.id === req.params.id);
    if (i < 0) return res.status(404).json({ error: 'Not found' });
    list.splice(i, 1);
    commit();
    res.json({ ok: true });
  });
  router.post(`/${name}-order`, (req, res) => {
    if (!reorder(getList(), req.body.ids)) return res.status(400).json({ error: 'Invalid order' });
    commit();
    res.json({ ok: true });
  });
}

/* ---------------------------------------------------------------- app */

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '12mb' }));
app.use((req, res, next) => { if (!req.body || typeof req.body !== 'object') req.body = {}; next(); });
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

// Public API
app.get('/api/content', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(publicContent());
});

app.get('/api/qr.svg', async (req, res) => {
  try {
    const svg = await QRCode.toString(db.event.registerUrl || ' ', { type: 'svg', margin: 1, color: { dark: '#0b1f3a', light: '#ffffff' } });
    res.type('image/svg+xml').setHeader('Cache-Control', 'no-cache');
    res.send(svg);
  } catch (e) {
    res.status(500).end();
  }
});

// Auth
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip;
  if (tooManyAttempts(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
  const { username, password } = req.body || {};
  if (username !== db.admin.username || !verifyPassword(String(password || ''), db.admin.passwordHash)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  attempts.delete(ip);
  setSessionCookie(req, res, makeToken(username), SESSION_TTL_MS);
  res.json({ ok: true, username, isDefault: !!db.admin.isDefault });
});

app.post('/api/auth/logout', (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

app.get('/api/auth/me', requireAdmin, (req, res) => {
  res.json({ username: db.admin.username, isDefault: !!db.admin.isDefault });
});

// Admin API
const admin = express.Router();
admin.use(requireAdmin);

admin.put('/event', (req, res) => {
  for (const key of EVENT_FIELDS) if (key in req.body) db.event[key] = str(req.body[key], 1000);
  if ('showQr' in req.body) db.event.showQr = bool(req.body.showQr);
  commit();
  res.json(db.event);
});

crudRoutes(admin, 'features', 'f', cleanFeature);
crudRoutes(admin, 'partners', 'p', cleanPartner);

// Days: creating a day starts with an empty session list
admin.post('/days', (req, res) => {
  const day = { id: newId('d'), ...cleanDay(req.body), sessions: [] };
  db.days.push(day);
  commit();
  res.status(201).json(day);
});
admin.put('/days/:id', (req, res) => {
  const day = db.days.find((d) => d.id === req.params.id);
  if (!day) return res.status(404).json({ error: 'Not found' });
  Object.assign(day, cleanDay({ ...day, ...req.body }));
  commit();
  res.json(day);
});
admin.delete('/days/:id', (req, res) => {
  const i = db.days.findIndex((d) => d.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Not found' });
  db.days.splice(i, 1);
  commit();
  res.json({ ok: true });
});
admin.post('/days-order', (req, res) => {
  if (!reorder(db.days, req.body.ids)) return res.status(400).json({ error: 'Invalid order' });
  commit();
  res.json({ ok: true });
});
admin.post('/days/:id/duplicate', (req, res) => {
  const day = db.days.find((d) => d.id === req.params.id);
  if (!day) return res.status(404).json({ error: 'Not found' });
  const copy = { id: newId('d'), title: `${day.title} (copy)`, sessions: day.sessions.map((s) => ({ ...s, id: newId('s') })) };
  db.days.splice(db.days.indexOf(day) + 1, 0, copy);
  commit();
  res.status(201).json(copy);
});

// Sessions (nested in days)
const findSession = (id) => {
  for (const day of db.days) {
    const i = day.sessions.findIndex((s) => s.id === id);
    if (i >= 0) return { day, i, session: day.sessions[i] };
  }
  return null;
};
admin.post('/days/:id/sessions', (req, res) => {
  const day = db.days.find((d) => d.id === req.params.id);
  if (!day) return res.status(404).json({ error: 'Day not found' });
  const session = { id: newId('s'), ...cleanSession(req.body) };
  day.sessions.push(session);
  commit();
  res.status(201).json(session);
});
admin.put('/sessions/:id', (req, res) => {
  const found = findSession(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  Object.assign(found.session, cleanSession({ ...found.session, ...req.body }));
  // Optionally move the session to another day
  if (req.body.dayId && req.body.dayId !== found.day.id) {
    const target = db.days.find((d) => d.id === req.body.dayId);
    if (target) {
      found.day.sessions.splice(found.i, 1);
      target.sessions.push(found.session);
    }
  }
  commit();
  res.json(found.session);
});
admin.delete('/sessions/:id', (req, res) => {
  const found = findSession(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  found.day.sessions.splice(found.i, 1);
  commit();
  res.json({ ok: true });
});
admin.post('/sessions/:id/duplicate', (req, res) => {
  const found = findSession(req.params.id);
  if (!found) return res.status(404).json({ error: 'Not found' });
  const copy = { ...found.session, id: newId('s') };
  found.day.sessions.splice(found.i + 1, 0, copy);
  commit();
  res.status(201).json(copy);
});
admin.post('/days/:id/sessions-order', (req, res) => {
  const day = db.days.find((d) => d.id === req.params.id);
  if (!day) return res.status(404).json({ error: 'Not found' });
  if (!reorder(day.sessions, req.body.ids)) return res.status(400).json({ error: 'Invalid order' });
  commit();
  res.json({ ok: true });
});

// Image upload (JSON body with a base64 data URL). SVG is refused on purpose: it can carry scripts.
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
admin.post('/upload', (req, res) => {
  const match = /^data:([\w/+.-]+);base64,(.+)$/.exec(String(req.body.data || ''));
  if (!match || !IMAGE_TYPES[match[1]]) return res.status(400).json({ error: 'Only PNG, JPG, WEBP or GIF images are allowed' });
  const buf = Buffer.from(match[2], 'base64');
  if (buf.length > 8 * 1024 * 1024) return res.status(413).json({ error: 'Image too large (max 8 MB)' });
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${IMAGE_TYPES[match[1]]}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  res.status(201).json({ url: `/uploads/${name}` });
});

admin.post('/account', (req, res) => {
  const { currentPassword, newUsername, newPassword } = req.body || {};
  if (!verifyPassword(String(currentPassword || ''), db.admin.passwordHash)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (newPassword !== undefined && newPassword !== '') {
    if (String(newPassword).length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters' });
    db.admin.passwordHash = hashPassword(String(newPassword));
    db.admin.isDefault = false;
  }
  if (newUsername) db.admin.username = str(newUsername, 60);
  commit();
  setSessionCookie(req, res, makeToken(db.admin.username), SESSION_TTL_MS);
  res.json({ ok: true, username: db.admin.username });
});

// Backup / restore of all public content
admin.get('/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="abcdrybasin-backup.json"');
  res.json(publicContent());
});
admin.post('/import', (req, res) => {
  const b = req.body || {};
  if (!b.event || !Array.isArray(b.features) || !Array.isArray(b.days) || !Array.isArray(b.partners)) {
    return res.status(400).json({ error: 'Invalid backup file' });
  }
  const event = {};
  for (const key of EVENT_FIELDS) event[key] = str(b.event[key], 1000);
  event.showQr = bool(b.event.showQr);
  db.event = event;
  db.features = b.features.map((f) => ({ id: newId('f'), ...cleanFeature(f) }));
  db.partners = b.partners.map((p) => ({ id: newId('p'), ...cleanPartner(p) }));
  db.days = b.days.map((d) => ({
    id: newId('d'), ...cleanDay(d),
    sessions: (Array.isArray(d.sessions) ? d.sessions : []).map((s) => ({ id: newId('s'), ...cleanSession(s) }))
  }));
  commit();
  res.json(publicContent());
});
admin.post('/reset', (req, res) => {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  Object.assign(db, { event: seed.event, features: seed.features, days: seed.days, partners: seed.partners });
  commit();
  res.json(publicContent());
});

app.use('/api/admin', admin);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

// Static files
app.use('/uploads', express.static(UPLOAD_DIR, { maxAge: '7d' }));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Upload too large' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
  console.error(err);
  res.status(500).json({ error: 'Server error' });
});

app.listen(PORT, HOST, (err) => {
  // Express 5 passes listen errors (e.g. port already in use) here instead of throwing
  if (err) {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${PORT} is already in use by another program. Pick another port, e.g. set PORT=3001.`
      : `Could not start the server: ${err.message}`);
    process.exit(1);
  }
  console.log(`ABCDryBASIN events site running on http://localhost:${PORT}`);
  console.log(`Admin panel: http://localhost:${PORT}/admin`);
  if (db.admin.isDefault) console.log('Default admin login: admin / admin123 (change it in Admin > Account)');
});
