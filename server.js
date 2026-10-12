// Impact Auto Care booking app.
// Zero-dependency Node.js (22.5+) server: public booking form + admin approval dashboard.
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

// ---------- setup ----------

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const IS_PROD = process.env.NODE_ENV === 'production';

let ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  if (IS_PROD) {
    console.error('ADMIN_PASSWORD must be set in production.');
    process.exit(1);
  }
  ADMIN_PASSWORD = crypto.randomBytes(6).toString('hex');
  console.log(`\n  No ADMIN_PASSWORD set. Temporary admin password for this run: ${ADMIN_PASSWORD}\n`);
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_HOURS = 12;

fs.mkdirSync(DATA_DIR, { recursive: true });
const db = new DatabaseSync(path.join(DATA_DIR, 'bookings.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS bookings (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ref           TEXT NOT NULL UNIQUE,
    status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
    name          TEXT NOT NULL,
    phone         TEXT NOT NULL,
    email         TEXT NOT NULL,
    vehicle_make  TEXT NOT NULL,
    vehicle_model TEXT NOT NULL,
    vehicle_year  TEXT,
    rego          TEXT NOT NULL,
    service       TEXT NOT NULL,
    pref_date     TEXT NOT NULL,  -- YYYY-MM-DD, workshop local date
    pref_time     TEXT NOT NULL,  -- HH:MM, workshop local time
    notes         TEXT,
    admin_note    TEXT,
    created_at    TEXT NOT NULL,  -- ISO UTC
    decided_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status, pref_date);
`);

// ---------- helpers ----------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function todayInWorkshop() {
  // en-CA formats as YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone }).format(new Date());
}

function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(ymd) {
  return new Date(ymd + 'T00:00:00Z').getUTCDay(); // 0 = Sunday
}

function fmtDate(ymd) {
  return new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

function fmtTime(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

function fmtStamp(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('en-AU', { timeZone: config.timezone, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

function bookingWindow() {
  const today = todayInWorkshop();
  return { min: addDays(today, config.minDaysAhead), max: addDays(today, config.maxDaysAhead) };
}

function newRef() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (const b of crypto.randomBytes(6)) s += alphabet[b % alphabet.length];
  return 'IAC-' + s;
}

function clientIp(req) {
  if (process.env.TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Simple fixed-window rate limiter, in memory.
function rateLimiter(limit, windowMs) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return true;
    }
    entry.count += 1;
    return entry.count <= limit;
  };
}
const bookingLimit = rateLimiter(6, 60 * 60 * 1000);
const loginLimit = rateLimiter(8, 15 * 60 * 1000);

function readBody(req, maxBytes = 20_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const type = req.headers['content-type'] || '';
      try {
        if (type.includes('application/json')) resolve(JSON.parse(raw || '{}'));
        else resolve(Object.fromEntries(new URLSearchParams(raw)));
      } catch { reject(new Error('bad body')); }
    });
    req.on('error', reject);
  });
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'SAMEORIGIN',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}
const sendJson = (res, status, obj) => send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8' });
const sendHtml = (res, status, html, extra = {}) => send(res, status, html, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...extra });
const redirect = (res, to, extra = {}) => send(res, 303, '', { Location: to, ...extra });

// ---------- admin session (HMAC-signed cookie) ----------

function sign(value) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
}

function makeSessionCookie() {
  const exp = Date.now() + SESSION_HOURS * 3600 * 1000;
  const payload = `admin.${exp}`;
  const secure = IS_PROD ? '; Secure' : '';
  return `iac_admin=${payload}.${sign(payload)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_HOURS * 3600}${secure}`;
}
const clearSessionCookie = 'iac_admin=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0';

function isAdmin(req) {
  const cookie = (req.headers.cookie || '').split(';').map((c) => c.trim()).find((c) => c.startsWith('iac_admin='));
  if (!cookie) return false;
  const [who, exp, sig] = cookie.slice('iac_admin='.length).split('.');
  if (who !== 'admin' || !exp || !sig) return false;
  const expected = sign(`${who}.${exp}`);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  return Number(exp) > Date.now();
}

function passwordMatches(input) {
  const a = crypto.createHash('sha256').update(String(input)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return crypto.timingSafeEqual(a, b);
}

// Blocks cross-site form posts to admin routes (on top of SameSite=Strict).
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // older browsers / same-origin navigations without Origin
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// ---------- optional email (Resend HTTP API) ----------

async function sendEmail(to, subject, text) {
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !to) return;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text, reply_to: config.business.email }),
    });
    if (!r.ok) console.error('Email failed:', r.status, await r.text());
  } catch (err) {
    console.error('Email failed:', err.message);
  }
}

function bookingSummary(b) {
  return [
    `Reference: ${b.ref}`,
    `Name: ${b.name}`,
    `Phone: ${b.phone}`,
    `Email: ${b.email}`,
    `Vehicle: ${[b.vehicle_year, b.vehicle_make, b.vehicle_model].filter(Boolean).join(' ')} (rego ${b.rego})`,
    `Service: ${b.service}`,
    `Preferred drop-off: ${fmtDate(b.pref_date)}, ${fmtTime(b.pref_time)}`,
    b.notes ? `Notes: ${b.notes}` : null,
  ].filter(Boolean).join('\n');
}

// ---------- booking validation ----------

function validateBooking(input) {
  const errors = {};
  const clean = (v, max) => String(v ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
  const b = {
    name: clean(input.name, 80),
    phone: clean(input.phone, 20),
    email: clean(input.email, 120).toLowerCase(),
    vehicle_make: clean(input.vehicle_make, 40),
    vehicle_model: clean(input.vehicle_model, 60),
    vehicle_year: clean(input.vehicle_year, 4),
    rego: clean(input.rego, 10).toUpperCase().replace(/[^A-Z0-9]/g, ''),
    service: clean(input.service, 60),
    pref_date: clean(input.pref_date, 10),
    pref_time: clean(input.pref_time, 5),
    notes: String(input.notes ?? '').trim().slice(0, 1000),
  };

  if (b.name.length < 2) errors.name = 'Please enter your name.';
  const digits = b.phone.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 12 || !/^[\d\s()+-]+$/.test(b.phone)) errors.phone = 'Please enter a valid phone number.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) errors.email = 'Please enter a valid email address.';
  if (!b.vehicle_make) errors.vehicle_make = 'Please enter the make.';
  if (!b.vehicle_model) errors.vehicle_model = 'Please enter the model.';
  if (b.vehicle_year && !/^(19|20)\d{2}$/.test(b.vehicle_year)) errors.vehicle_year = 'Please enter a 4-digit year.';
  if (b.rego.length < 2 || b.rego.length > 9) errors.rego = 'Please enter the registration.';
  if (!config.services.includes(b.service)) errors.service = 'Please choose a service.';

  const { min, max } = bookingWindow();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.pref_date) || isNaN(Date.parse(b.pref_date))) {
    errors.pref_date = 'Please choose a date.';
  } else if (b.pref_date < min || b.pref_date > max) {
    errors.pref_date = `Please choose a date between ${fmtDate(min)} and ${fmtDate(max)}.`;
  } else if (!config.openDays.includes(weekdayOf(b.pref_date))) {
    errors.pref_date = 'We are closed that day. Please choose a weekday.';
  } else if (config.closedDates.includes(b.pref_date)) {
    errors.pref_date = 'We are closed that day. Please choose another date.';
  }
  if (!config.dropOffTimes.includes(b.pref_time)) errors.pref_time = 'Please choose a drop-off time.';

  return { booking: b, errors };
}

// ---------- routes ----------

async function handleCreateBooking(req, res) {
  if (!bookingLimit(clientIp(req))) return sendJson(res, 429, { error: 'Too many requests. Please call us instead.' });
  let input;
  try { input = await readBody(req); } catch { return sendJson(res, 400, { error: 'Invalid request.' }); }

  // Honeypot: real people never fill this hidden field.
  if (input.website) return sendJson(res, 200, { ok: true, ref: newRef() });

  const { booking: b, errors } = validateBooking(input);
  if (Object.keys(errors).length) return sendJson(res, 422, { error: 'Please check the highlighted fields.', fields: errors });

  b.ref = newRef();
  b.created_at = new Date().toISOString();
  db.prepare(`INSERT INTO bookings (ref, name, phone, email, vehicle_make, vehicle_model, vehicle_year, rego, service, pref_date, pref_time, notes, created_at)
              VALUES (:ref, :name, :phone, :email, :vehicle_make, :vehicle_model, :vehicle_year, :rego, :service, :pref_date, :pref_time, :notes, :created_at)`).run(b);

  sendEmail(process.env.NOTIFY_EMAIL || config.business.email, `New booking request ${b.ref}: ${b.name}`, `${bookingSummary(b)}\n\nReview it in the admin dashboard.`);
  sendEmail(b.email, `We've received your booking request (${b.ref})`,
    `Hi ${b.name},\n\nThanks for your booking request with ${config.business.name}. It isn't confirmed yet: we'll be in touch to confirm shortly.\n\n${bookingSummary(b)}\n\nQuestions? Call ${config.business.phone}.`);

  sendJson(res, 201, { ok: true, ref: b.ref });
}

function handleConfig(req, res) {
  const { min, max } = bookingWindow();
  sendJson(res, 200, {
    business: config.business,
    services: config.services,
    openDays: config.openDays,
    closedDates: config.closedDates,
    dropOffTimes: config.dropOffTimes.map((t) => ({ value: t, label: fmtTime(t) })),
    hoursText: config.hoursText,
    minDate: min,
    maxDate: max,
  });
}

async function handleLogin(req, res) {
  if (!sameOrigin(req)) return sendHtml(res, 403, 'Forbidden');
  const ip = clientIp(req);
  if (!loginLimit(ip)) return sendHtml(res, 429, loginPage('Too many attempts. Please wait 15 minutes and try again.'));
  let input;
  try { input = await readBody(req); } catch { return sendHtml(res, 400, loginPage('Invalid request.')); }
  if (!passwordMatches(input.password || '')) return sendHtml(res, 401, loginPage('Incorrect password.'));
  redirect(res, '/admin', { 'Set-Cookie': makeSessionCookie() });
}

async function handleDecision(req, res, id) {
  if (!isAdmin(req)) return redirect(res, '/admin');
  if (!sameOrigin(req)) return sendHtml(res, 403, 'Forbidden');
  let input;
  try { input = await readBody(req); } catch { return sendHtml(res, 400, 'Invalid request.'); }
  const status = { approve: 'approved', decline: 'declined', pending: 'pending' }[input.action];
  if (!status) return sendHtml(res, 400, 'Invalid action.');
  const note = String(input.admin_note ?? '').trim().slice(0, 500) || null;

  const b = db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  if (!b) return sendHtml(res, 404, 'Booking not found.');
  db.prepare('UPDATE bookings SET status = ?, admin_note = ?, decided_at = ? WHERE id = ?')
    .run(status, note, status === 'pending' ? null : new Date().toISOString(), id);

  if (status === 'approved') {
    sendEmail(b.email, `Your booking is confirmed (${b.ref})`,
      `Hi ${b.name},\n\nGood news: your booking with ${config.business.name} is confirmed.\n\n${bookingSummary(b)}\n${note ? `\nMessage from the workshop: ${note}\n` : ''}\nSee you then. Need to change it? Call ${config.business.phone}.`);
  } else if (status === 'declined') {
    sendEmail(b.email, `About your booking request (${b.ref})`,
      `Hi ${b.name},\n\nUnfortunately we can't take your booking request for ${fmtDate(b.pref_date)} at ${fmtTime(b.pref_time)}.\n${note ? `\nMessage from the workshop: ${note}\n` : ''}\nPlease call ${config.business.phone} and we'll find another time that works.`);
  }

  const back = typeof input.back === 'string' && input.back.startsWith('/admin') ? input.back : '/admin';
  redirect(res, back);
}

function serveStatic(req, res, pathname) {
  const file = path.normalize(path.join(PUBLIC_DIR, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 404, 'Not found');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp' };
    const ext = path.extname(file);
    send(res, 200, data, { 'Content-Type': types[ext] || 'application/octet-stream', 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400' });
  });
}

// ---------- admin views ----------

function layout(title, body) {
  return `<!doctype html>
<html lang="en-AU"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} · ${esc(config.business.name)}</title>
<link rel="icon" href="/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow:wght@400;500;600;700&family=Barlow+Condensed:wght@600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/styles.css">
</head><body class="admin">${body}</body></html>`;
}

function loginPage(error = '') {
  return layout('Admin login', `
<main class="login-wrap">
  <form class="card login-card" method="post" action="/admin/login">
    <img src="/logo.png" alt="${esc(config.business.name)}" class="login-logo">
    <h1>Workshop admin</h1>
    ${error ? `<p class="alert alert-error" role="alert">${esc(error)}</p>` : ''}
    <label class="field"><span>Password</span>
      <input type="password" name="password" autocomplete="current-password" required autofocus>
    </label>
    <button class="btn btn-primary btn-block" type="submit">Log in</button>
    <a class="muted-link" href="/">Back to booking form</a>
  </form>
</main>`);
}

const STATUS_TABS = [
  { key: 'pending', label: 'Pending' },
  { key: 'approved', label: 'Approved' },
  { key: 'declined', label: 'Declined' },
  { key: 'all', label: 'All' },
];

function dashboardPage(url) {
  const tab = STATUS_TABS.some((t) => t.key === url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
  const when = url.searchParams.get('when') === 'past' ? 'past' : 'upcoming';
  const q = (url.searchParams.get('q') || '').trim().slice(0, 60);
  const today = todayInWorkshop();

  const counts = Object.fromEntries(db.prepare(`SELECT status, COUNT(*) AS n FROM bookings WHERE pref_date >= ? GROUP BY status`).all(today).map((r) => [r.status, r.n]));

  const where = [];
  const params = {};
  if (tab !== 'all') { where.push('status = :status'); params.status = tab; }
  if (when === 'upcoming') where.push('pref_date >= :today'); else where.push('pref_date < :today');
  params.today = today;
  if (q) {
    where.push(`(name LIKE :q OR phone LIKE :q OR email LIKE :q OR rego LIKE :q OR ref LIKE :q OR vehicle_make LIKE :q OR vehicle_model LIKE :q)`);
    params.q = `%${q}%`;
  }
  const order = when === 'upcoming' ? 'pref_date ASC, pref_time ASC' : 'pref_date DESC, pref_time DESC';
  const rows = db.prepare(`SELECT * FROM bookings WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 300`).all(params);

  // Approved bookings per day, to help avoid overbooking.
  const approvedPerDay = Object.fromEntries(db.prepare(`SELECT pref_date, COUNT(*) AS n FROM bookings WHERE status = 'approved' AND pref_date >= ? GROUP BY pref_date`).all(today).map((r) => [r.pref_date, r.n]));

  const back = url.pathname + url.search;
  const qs = (overrides) => {
    const p = new URLSearchParams({ status: tab, when, ...(q ? { q } : {}), ...overrides });
    return '/admin?' + p.toString();
  };

  const tabs = STATUS_TABS.map((t) => {
    const n = t.key === 'all' ? Object.values(counts).reduce((a, b) => a + b, 0) : counts[t.key] || 0;
    return `<a class="tab ${t.key === tab ? 'active' : ''} tab-${t.key}" href="${esc(qs({ status: t.key }))}">${t.label}${when === 'upcoming' ? ` <span class="count">${n}</span>` : ''}</a>`;
  }).join('');

  const cards = rows.map((b) => {
    const vehicle = [b.vehicle_year, b.vehicle_make, b.vehicle_model].filter(Boolean).join(' ');
    const sameDay = approvedPerDay[b.pref_date] || 0;
    const othersApproved = sameDay - (b.status === 'approved' ? 1 : 0);
    const isToday = b.pref_date === today;
    const mailSubject = encodeURIComponent(`Your booking with ${config.business.name} (${b.ref})`);
    return `
<article class="card booking status-${b.status}">
  <header class="booking-head">
    <div>
      <div class="booking-when">${esc(fmtDate(b.pref_date))} <span>· ${esc(fmtTime(b.pref_time))}</span>${isToday ? ' <em class="pill pill-today">Today</em>' : ''}</div>
      <div class="booking-service">${esc(b.service)}</div>
    </div>
    <span class="pill pill-${b.status}">${b.status}</span>
  </header>
  <dl class="booking-grid">
    <div><dt>Customer</dt><dd>${esc(b.name)}</dd></div>
    <div><dt>Phone</dt><dd><a href="tel:${esc(b.phone.replace(/[^\d+]/g, ''))}">${esc(b.phone)}</a></dd></div>
    <div><dt>Email</dt><dd><a href="mailto:${esc(b.email)}?subject=${mailSubject}">${esc(b.email)}</a></dd></div>
    <div><dt>Vehicle</dt><dd>${esc(vehicle)}</dd></div>
    <div><dt>Rego</dt><dd class="rego">${esc(b.rego)}</dd></div>
    <div><dt>Reference</dt><dd class="mono">${esc(b.ref)}</dd></div>
  </dl>
  ${b.notes ? `<div class="booking-notes"><strong>Customer notes</strong><p>${esc(b.notes)}</p></div>` : ''}
  ${b.admin_note ? `<div class="booking-notes admin-note"><strong>Message to customer</strong><p>${esc(b.admin_note)}</p></div>` : ''}
  ${othersApproved > 0 ? `<p class="hint">${othersApproved} other approved booking${othersApproved === 1 ? '' : 's'} on this day.</p>` : ''}
  <footer class="booking-foot">
    <span class="muted">Requested ${esc(fmtStamp(b.created_at))}${b.decided_at ? ` · ${b.status} ${esc(fmtStamp(b.decided_at))}` : ''}</span>
    <form method="post" action="/admin/bookings/${b.id}" class="decision">
      <input type="hidden" name="back" value="${esc(back)}">
      ${b.status === 'pending' ? `
        <input type="text" name="admin_note" maxlength="500" placeholder="Optional message to customer" aria-label="Optional message to customer">
        <button class="btn btn-decline" name="action" value="decline" type="submit">Decline</button>
        <button class="btn btn-approve" name="action" value="approve" type="submit">Approve</button>`
      : `<button class="btn btn-ghost" name="action" value="pending" type="submit">Move back to pending</button>`}
    </form>
  </footer>
</article>`;
  }).join('');

  const empty = `<div class="empty card"><p>${tab === 'pending' && when === 'upcoming' && !q ? 'No pending requests. You’re all caught up.' : 'No bookings match.'}</p></div>`;

  return layout('Bookings', `
<header class="admin-bar">
  <a href="/admin" class="admin-brand"><img src="/logo.png" alt="${esc(config.business.name)}"></a>
  <span class="admin-title">Bookings</span>
  <form method="post" action="/admin/logout"><button class="btn btn-ghost-dark" type="submit">Log out</button></form>
</header>
<main class="admin-main">
  <nav class="tabs">${tabs}</nav>
  <div class="toolbar">
    <div class="seg">
      <a class="${when === 'upcoming' ? 'active' : ''}" href="${esc(qs({ when: 'upcoming' }))}">Upcoming</a>
      <a class="${when === 'past' ? 'active' : ''}" href="${esc(qs({ when: 'past' }))}">Past</a>
    </div>
    <form method="get" action="/admin" class="search">
      <input type="hidden" name="status" value="${esc(tab)}"><input type="hidden" name="when" value="${esc(when)}">
      <input type="search" name="q" value="${esc(q)}" placeholder="Search name, phone, rego, ref…" aria-label="Search bookings">
    </form>
  </div>
  <section class="booking-list">${cards || empty}</section>
</main>`);
}

// ---------- server ----------

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;

    if (method === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (method === 'GET' && pathname === '/api/config') return handleConfig(req, res);
    if (method === 'POST' && pathname === '/api/bookings') return handleCreateBooking(req, res);

    if (pathname === '/admin' || pathname === '/admin/') {
      if (method !== 'GET') return send(res, 405, 'Method not allowed');
      return isAdmin(req) ? sendHtml(res, 200, dashboardPage(url)) : sendHtml(res, 200, loginPage());
    }
    if (method === 'POST' && pathname === '/admin/login') return handleLogin(req, res);
    if (method === 'POST' && pathname === '/admin/logout') return redirect(res, '/admin', { 'Set-Cookie': clearSessionCookie });
    const m = pathname.match(/^\/admin\/bookings\/(\d+)$/);
    if (method === 'POST' && m) return handleDecision(req, res, Number(m[1]));

    if (method === 'GET' || method === 'HEAD') return serveStatic(req, res, pathname);
    send(res, 404, 'Not found');
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, 'Something went wrong.');
  }
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Impact Auto Care bookings running on http://localhost:${PORT}  (admin: /admin)`));
}

module.exports = { server, db, validateBooking };
