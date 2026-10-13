'use strict';
// Impact Diesel booking app, served under /diesel by the same server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'idg-test-'));
process.env.ADMIN_PASSWORD = 'test-password';
const { server } = require('../server');

let base;
test.before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => server.close());

const outbox = async () => (await fetch(`${base}/diesel/dev/outbox.json`)).json();
const linkIn = (html, re) => html.match(re)[0].replace(/&amp;/g, '&');

function weekdaysAhead(n) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' });
  const d = new Date(fmt.format(new Date()) + 'T00:00:00Z');
  const out = [];
  while (out.length < n) { d.setUTCDate(d.getUTCDate() + 1); if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10)); }
  return out;
}

const booking = () => {
  const [a, b] = weekdaysAhead(3).slice(1);
  return {
    name: 'Dave Morrison', phone: '0412 555 019', email: 'dave@example.com', rego: 'XN42KD', plateState: 'NSW',
    type: 'Prime mover', make: 'Kenworth T610', odo: '684200', services: ['Brakes'], notes: '',
    picks: [{ d: a, t: '08:00' }, { d: b, t: '10:00' }],
  };
};

test('/diesel redirects to /diesel/ and serves the form', async () => {
  const r = await fetch(`${base}/diesel`, { redirect: 'manual' });
  assert.strictEqual(r.status, 301);
  assert.strictEqual(r.headers.get('location'), '/diesel/');
  const page = await (await fetch(`${base}/diesel/`)).text();
  assert.match(page, /Impact Diesel/);
  assert.match(page, /src="book.js"/);
  assert.strictEqual((await fetch(`${base}/diesel/book.js`)).status, 200);
});

test('auto care form is unaffected', async () => {
  const page = await (await fetch(`${base}/`)).text();
  assert.doesNotMatch(page, /Impact Diesel/);
});

test('rejects an incomplete diesel booking', async () => {
  const r = await fetch(`${base}/diesel/api/book`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) });
  assert.strictEqual(r.status, 400);
});

test('request, confirm and suggest-a-time flow sends the right emails', async () => {
  const r = await fetch(`${base}/diesel/api/book`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(booking()) });
  assert.strictEqual(r.status, 200);
  const { ref } = await r.json();
  let mail = await outbox();
  const request = mail.find((m) => m.subject.includes(ref));
  assert.strictEqual(request.to, 'service@impactdiesel.com.au');
  assert.ok(mail.some((m) => m.to === 'dave@example.com' && /got your booking request/.test(m.subject)));

  // Workshop confirms the 1st choice
  const confirm = linkIn(request.html, /http:\/\/[^"]+\/diesel\/w\/confirm\?t=[^"]+&amp;i=0/);
  const page = await (await fetch(confirm)).text();
  assert.match(page, /action="\/diesel\/w\/confirm"/);
  const u = new URL(confirm);
  const done = await fetch(`${base}/diesel/w/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: u.searchParams.get('t'), i: '0' }) });
  assert.match(await done.text(), /booked in/);
  mail = await outbox();
  assert.ok(mail.some((m) => m.to === 'dave@example.com' && /^Booking confirmed/.test(m.subject)));

  // Workshop suggests another time, customer accepts
  const propose = new URL(linkIn(request.html, /http:\/\/[^"]+\/diesel\/w\/propose\?t=[^"]+/));
  const day = weekdaysAhead(8)[7];
  await fetch(`${base}/diesel/w/propose`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ t: propose.searchParams.get('t'), d: day, time: '14:00', msg: '' }) });
  mail = await outbox();
  const suggestion = mail.find((m) => /^New time suggested/.test(m.subject));
  const accept = new URL(linkIn(suggestion.html, /http:\/\/[^"]+\/diesel\/c\/accept\?p=[^"]+/));
  const accepted = await fetch(`${base}/diesel/c/accept`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ p: accept.searchParams.get('p') }) });
  assert.match(await accepted.text(), /See you then/);
  mail = await outbox();
  assert.ok(mail.some((m) => m.to === 'service@impactdiesel.com.au' && /accepted/.test(m.html)));
});

test('a tampered link is refused', async () => {
  const r = await fetch(`${base}/diesel/w/confirm?t=abc.def&i=0`);
  assert.strictEqual(r.status, 400);
});
