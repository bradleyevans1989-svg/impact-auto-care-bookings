'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'iac-test-'));
process.env.ADMIN_PASSWORD = 'test-password';
const { server } = require('../server');
const config = require('../config');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => server.close());

function nextOpenDay() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone });
  const d = new Date(fmt.format(new Date()) + 'T00:00:00Z');
  do d.setUTCDate(d.getUTCDate() + 1);
  while (!config.openDays.includes(d.getUTCDay()) || config.closedDates.includes(d.toISOString().slice(0, 10)));
  return d.toISOString().slice(0, 10);
}
function nextClosedDay() {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: config.timezone });
  const d = new Date(fmt.format(new Date()) + 'T00:00:00Z');
  do d.setUTCDate(d.getUTCDate() + 1); while (config.openDays.includes(d.getUTCDay()));
  return d.toISOString().slice(0, 10);
}

const valid = () => ({
  name: 'Jane Citizen', phone: '0412 345 678', email: 'jane@example.com',
  vehicle_make: 'Toyota', vehicle_model: 'Hilux', vehicle_year: '2019', rego: 'abc-12d',
  service: 'Logbook service', pref_date: nextOpenDay(), pref_time: '09:00', notes: 'Squeaky brakes <b>bold</b>',
});
const post = (p, body, headers = {}) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), redirect: 'manual' });

let cookie;

test('rejects invalid booking with field errors', async () => {
  const r = await post('/api/bookings', { ...valid(), email: 'nope', pref_date: nextClosedDay(), service: 'Free car' });
  assert.equal(r.status, 422);
  const body = await r.json();
  assert.ok(body.fields.email && body.fields.pref_date && body.fields.service);
});

test('accepts a valid booking as pending', async () => {
  const r = await post('/api/bookings', valid());
  assert.equal(r.status, 201);
  const body = await r.json();
  assert.match(body.ref, /^IAC-[A-Z0-9]{6}$/);
});

test('admin dashboard requires login', async () => {
  const r = await fetch(base + '/admin');
  const html = await r.text();
  assert.match(html, /type="password"/);
  assert.doesNotMatch(html, /Jane Citizen/);
});

test('wrong password is rejected', async () => {
  const r = await fetch(base + '/admin/login', { method: 'POST', body: new URLSearchParams({ password: 'nope' }), redirect: 'manual' });
  assert.equal(r.status, 401);
});

test('login, see pending booking escaped, approve it', async () => {
  const r = await fetch(base + '/admin/login', { method: 'POST', body: new URLSearchParams({ password: 'test-password' }), redirect: 'manual' });
  assert.equal(r.status, 303);
  cookie = r.headers.get('set-cookie').split(';')[0];
  const html = await (await fetch(base + '/admin', { headers: { cookie } })).text();
  assert.match(html, /Jane Citizen/);
  assert.match(html, /ABC12D/);
  assert.match(html, /&lt;b&gt;bold&lt;\/b&gt;/);
  const id = html.match(/action="\/admin\/bookings\/(\d+)"/)[1];

  const d = await fetch(base + `/admin/bookings/${id}`, { method: 'POST', headers: { cookie }, body: new URLSearchParams({ action: 'approve', admin_note: 'See you then' }), redirect: 'manual' });
  assert.equal(d.status, 303);
  const approved = await (await fetch(base + '/admin?status=approved', { headers: { cookie } })).text();
  assert.match(approved, /Jane Citizen/);
  assert.match(approved, /See you then/);
  const pending = await (await fetch(base + '/admin?status=pending', { headers: { cookie } })).text();
  assert.doesNotMatch(pending, /Jane Citizen/);
});

test('decision without session or from another origin is refused', async () => {
  const noAuth = await fetch(base + '/admin/bookings/1', { method: 'POST', body: new URLSearchParams({ action: 'decline' }), redirect: 'manual' });
  assert.equal(noAuth.status, 303);
  assert.equal(noAuth.headers.get('location'), '/admin');
  const cross = await fetch(base + '/admin/bookings/1', { method: 'POST', headers: { cookie, origin: 'https://evil.example' }, body: new URLSearchParams({ action: 'decline' }), redirect: 'manual' });
  assert.equal(cross.status, 403);
});

test('forged cookie is rejected', async () => {
  const html = await (await fetch(base + '/admin', { headers: { cookie: `iac_admin=admin.${Date.now() + 1e9}.forged` } })).text();
  assert.match(html, /type="password"/);
});

test('static files cannot escape public dir', async () => {
  const r = await fetch(base + '/..%2fserver.js');
  assert.equal(r.status, 404);
});
