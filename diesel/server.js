// Impact Diesel Group booking app.
// Customer picks up to 3 drop-off times -> workshop gets an email with Confirm buttons
// -> workshop confirms one or suggests another time -> customer is emailed automatically.
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { sign, verify } = require("./lib/token");
const mail = require("./lib/mail");
const emails = require("./lib/emails");
const cfg = require("./lib/config");

const PORT = Number(process.env.PORT || 3000);
// Set DIESEL_PREFIX (e.g. "/diesel") to serve the app under a path inside another app.
const PREFIX = (process.env.DIESEL_PREFIX || "").replace(/\/$/, "");
const PUBLIC = path.join(__dirname, "public");
const esc = emails.esc;

/* ---------- helpers ---------- */
function baseUrl(req) {
  if ((process.env.DIESEL_BASE_URL ?? process.env.BASE_URL)) return (process.env.DIESEL_BASE_URL ?? process.env.BASE_URL).replace(/\/$/, "");
  const proto = (req.headers["x-forwarded-proto"] || "http").split(",")[0];
  return `${proto}://${req.headers.host}`;
}

function send(res, status, body, type = "text/html; charset=utf-8", extra = {}) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...extra });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj), "application/json");

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const type = req.headers["content-type"] || "";
      try { resolve(type.includes("json") ? JSON.parse(raw || "{}") : Object.fromEntries(new URLSearchParams(raw))); }
      catch { reject(new Error("bad body")); }
    });
    req.on("error", reject);
  });
}

// Workshop and customer action pages: never framed by other sites, never indexed.
const PRIVATE_HEADERS = { "X-Frame-Options": "DENY", "X-Robots-Tag": "noindex", "Referrer-Policy": "no-referrer" };

function page(title, inner) {
  return `<!doctype html><html lang="en-AU"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} · Impact Diesel Group</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@600;700;800&family=Barlow:wght@400;500;600&family=JetBrains+Mono:wght@500;700&display=swap">
<link rel="stylesheet" href="${PREFIX}/style.css"></head><body><div class="wrap">
<header class="top"><div class="brand"><div class="name">Impact Diesel <span>Group</span></div><div class="tag">Workshop bookings</div></div></header>
<div class="page">${inner}</div></div></body></html>`;
}

const errorPage = (res, msg) => send(res, 400, page("Link problem", `<div class="panel done"><h2>This link doesn't work</h2><p>${esc(msg)}</p><p class="note">Call ${cfg.BUSINESS.phone} if you need a hand.</p></div>`), undefined, PRIVATE_HEADERS);

function kv(b) {
  const row = (k, v) => v ? `<dt>${k}</dt><dd>${v}</dd>` : "";
  return `<dl class="kv">${row("Ref", esc(b.ref))}${row("Customer", esc(b.name) + (b.company ? ", " + esc(b.company) : ""))}${row("Contact", esc(b.phone) + " · " + esc(b.email))}
${row("Rego", `<span class="mini-plate">${esc(b.rego)}</span> ${esc(b.plateState)}`)}${row("Vehicle", esc(b.type) + (b.make ? ", " + esc(b.make) : ""))}
${row("Odometer", b.odo ? Number(b.odo).toLocaleString("en-AU") : "")}${row("Work", esc(b.services.join(", ")) || "See notes")}${row("Notes", esc(b.notes))}</dl>`;
}

const bigWhen = (d, t) => `<div class="big-when">${esc(cfg.fmtLong(d))}<br>Drop-off ${esc(cfg.slotLabel(t))}</div>`;

/* ---------- validation ---------- */
const clean = (v, max = 200) => String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function validateBooking(body) {
  const b = {
    name: clean(body.name, 80), company: clean(body.company, 80), phone: clean(body.phone, 30), email: clean(body.email, 120).toLowerCase(),
    rego: clean(body.rego, 8).toUpperCase().replace(/[^A-Z0-9]/g, ""), plateState: clean(body.plateState, 3).toUpperCase(),
    type: cfg.TYPES.includes(body.type) ? body.type : "Other", make: clean(body.make, 80),
    odo: /^\d{1,7}$/.test(String(body.odo ?? "").trim()) ? String(body.odo).trim() : "",
    services: Array.isArray(body.services) ? body.services.filter(s => cfg.SERVICES.includes(s)) : [],
    notes: String(body.notes ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, " ").trim().slice(0, 1000),
    picks: Array.isArray(body.picks) ? body.picks.slice(0, 3).map(p => ({ d: String(p?.d ?? ""), t: String(p?.t ?? "") })) : []
  };
  const errors = [];
  if (!b.name) errors.push("your name");
  if (!/^[\d\s+()-]{8,}$/.test(b.phone)) errors.push("a contact number");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) errors.push("a valid email");
  if (b.rego.length < 2) errors.push("the rego");
  if (!["NSW", "VIC", "QLD", "ACT", "SA", "WA", "TAS", "NT"].includes(b.plateState)) b.plateState = "NSW";
  if (!b.services.length && !b.notes) errors.push("what needs doing");
  const validPicks = b.picks.filter(p => cfg.dayBookable(p.d) && cfg.SLOTS.some(s => s[0] === p.t));
  const unique = validPicks.filter((p, i) => validPicks.findIndex(q => q.d === p.d && q.t === p.t) === i);
  if (!unique.length) errors.push("at least one preferred drop-off time");
  b.picks = unique;
  return { b, errors };
}

// Simple per-IP limit so the form can't be used to spam the inbox.
const hits = new Map();
function rateLimited(req) {
  const ip = (req.headers["x-forwarded-for"] || req.socket.remoteAddress || "").split(",")[0].trim();
  const now = Date.now(), list = (hits.get(ip) || []).filter(t => now - t < 3600e3);
  list.push(now); hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > 8;
}

/* ---------- routes ---------- */
// Returns false when the request isn't for this app (only possible with a PREFIX).
async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  if (PREFIX && url.pathname === PREFIX) { res.writeHead(301, { Location: PREFIX + "/" + url.search }); res.end(); return true; }
  if (PREFIX && !url.pathname.startsWith(PREFIX + "/")) return false;
  const p = url.pathname.slice(PREFIX.length);
  const base = baseUrl(req) + PREFIX;

  // Static files
  if (req.method === "GET" && (p === "/" || p === "/book")) return send(res, 200, fs.readFileSync(path.join(PUBLIC, "book.html")));
  if (req.method === "GET" && ["/style.css", "/book.js"].includes(p)) {
    return send(res, 200, fs.readFileSync(path.join(PUBLIC, p)), p.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8", { "Cache-Control": "public, max-age=300" });
  }
  if (req.method === "GET" && p === "/healthz") return send(res, 200, "ok", "text/plain");

  // Form settings (services, times, today's date in Sydney)
  if (req.method === "GET" && p === "/api/config") {
    return json(res, 200, { services: cfg.SERVICES, types: cfg.TYPES, slots: cfg.SLOTS, today: cfg.todayKey(), aheadDays: cfg.BOOK_AHEAD_DAYS, phone: cfg.BUSINESS.phone });
  }

  // Prefill the form when a customer asks for other times
  if (req.method === "GET" && p === "/api/prefill") {
    const data = verify(url.searchParams.get("r"));
    if (!data || data.k !== "redo") return json(res, 400, { error: "This link has expired." });
    const { picks, ref, ...rest } = data.b;
    return json(res, 200, { ...rest, prevRef: ref });
  }

  // New booking request
  if (req.method === "POST" && p === "/api/book") {
    let body; try { body = await readBody(req); } catch { return json(res, 400, { error: "Something went wrong reading the form. Please try again." }); }
    if (body.website) return json(res, 200, { ok: true }); // honeypot: bots fill hidden fields
    if (rateLimited(req)) return json(res, 429, { error: `Too many requests. Please call ${cfg.BUSINESS.phone}.` });
    const { b, errors } = validateBooking(body);
    if (errors.length) return json(res, 400, { error: "Please add " + errors.join(", ") + "." });
    b.ref = "IDG-" + crypto.randomBytes(3).toString("hex").toUpperCase();
    const prev = body.prevRef && /^IDG-[0-9A-F]{6}$/.test(body.prevRef) ? body.prevRef : "";
    if (prev) b.prevRef = prev;

    const t = sign({ k: "req", b });
    const links = { confirm: b.picks.map((_, i) => `${base}/w/confirm?t=${t}&i=${i}`), propose: `${base}/w/propose?t=${t}` };
    try {
      const w = emails.workshopRequest(b, links);
      await mail.send({ to: cfg.BUSINESS.workshopEmail, replyTo: `${b.name} <${b.email}>`, ...w });
      const c = emails.customerReceived(b);
      await mail.send({ to: b.email, ...c });
    } catch (e) {
      console.error("mail failed", e);
      return json(res, 502, { error: `We couldn't send your request. Please call ${cfg.BUSINESS.phone}.` });
    }
    return json(res, 200, { ok: true, ref: b.ref, email: b.email });
  }

  // Workshop: confirm one of the customer's times
  if (p === "/w/confirm") {
    const src = req.method === "POST" ? await readBody(req).catch(() => ({})) : Object.fromEntries(url.searchParams);
    const data = verify(src.t);
    if (!data || data.k !== "req") return errorPage(res, "It has expired or been changed. Open the latest booking email and try again.");
    const b = data.b, i = Number(src.i), pick = b.picks[i];
    if (!pick) return errorPage(res, "That time isn't part of this booking.");
    if (req.method === "GET") {
      return send(res, 200, page("Confirm booking", `<div class="panel done">
<span class="status pending">Not confirmed yet</span>
<h2>Confirm ${esc(b.rego)} for this time?</h2>${bigWhen(pick.d, pick.t)}${kv(b)}
<form method="post" action="${PREFIX}/w/confirm"><input type="hidden" name="t" value="${esc(src.t)}"><input type="hidden" name="i" value="${i}">
<div class="or"><button class="btn ok" type="submit">Confirm and email ${esc(b.name.split(" ")[0])}</button><a class="btn ghost" href="${PREFIX}/w/propose?t=${esc(src.t)}">Suggest a different time</a></div></form>
<p class="note">Already confirmed this one? Pressing again sends ${esc(b.name.split(" ")[0])} a second copy of the same confirmation.</p></div>`), undefined, PRIVATE_HEADERS);
    }
    await mail.send({ to: b.email, replyTo: cfg.BUSINESS.workshopEmail, ...emails.customerConfirmed(b, pick.d, pick.t) });
    await mail.send({ to: cfg.BUSINESS.workshopEmail, ...emails.workshopBooked(b, pick.d, pick.t, `You confirmed ${b.ref}. ${b.name} has been emailed.`) });
    return send(res, 200, page("Booking confirmed", `<div class="panel done"><span class="status ok">Confirmed · customer emailed</span>
<h2>${esc(b.rego)} is booked in</h2>${bigWhen(pick.d, pick.t)}<p>${esc(b.name)} has been sent a confirmation at ${esc(b.email)}. A copy is in your inbox for your records.</p></div>`), undefined, PRIVATE_HEADERS);
  }

  // Workshop: suggest a different time
  if (p === "/w/propose") {
    const src = req.method === "POST" ? await readBody(req).catch(() => ({})) : Object.fromEntries(url.searchParams);
    const data = verify(src.t);
    if (!data || data.k !== "req") return errorPage(res, "It has expired or been changed. Open the latest booking email and try again.");
    const b = data.b, first = b.name.split(" ")[0];
    if (req.method === "GET") {
      const days = []; let k = cfg.todayKey();
      while (days.length < 45) { k = cfg.addDays(k, 1); if (cfg.dow(k) !== 0) days.push(k); }
      const picked = b.picks.map(x => `${cfg.fmtShort(x.d)} ${cfg.slotLabel(x.t)}`).join(", ");
      return send(res, 200, page("Suggest a time", `<div class="panel done">
<h2>Suggest another time for ${esc(b.rego)}</h2><p class="note">${esc(first)} asked for: ${esc(picked)}</p>
<form method="post" action="${PREFIX}/w/propose" class="propose"><input type="hidden" name="t" value="${esc(src.t)}">
<div class="grid"><label class="f">Day<select name="d" required>${days.map(d => `<option value="${d}">${esc(cfg.fmtLong(d))}</option>`).join("")}</select></label>
<label class="f">Drop-off<select name="time" required>${cfg.SLOTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label></div>
<label class="f">Message to ${esc(first)} <span class="opt">optional</span><textarea name="msg" maxlength="600">Sorry ${esc(first)}, we're booked out on those days. Can you do this instead?</textarea></label>
<div class="or"><button class="btn primary" type="submit">Send this time to ${esc(first)}</button></div></form>${kv(b)}</div>`), undefined, PRIVATE_HEADERS);
    }
    const d = String(src.d || ""), time = String(src.time || "");
    if (!cfg.dayBookable(d) || !cfg.SLOTS.some(s => s[0] === time)) return errorPage(res, "Pick a day in the next few weeks (not a Sunday) and a drop-off time.");
    const msg = clean(src.msg, 600);
    const links = {
      accept: `${base}/c/accept?p=${sign({ k: "prop", b, d, t: time })}`,
      other: `${base}/?r=${sign({ k: "redo", b })}`
    };
    await mail.send({ to: b.email, replyTo: cfg.BUSINESS.workshopEmail, ...emails.customerProposal(b, d, time, msg, links) });
    return send(res, 200, page("Time suggested", `<div class="panel done"><span class="status prop">Sent · waiting on customer</span>
<h2>New time sent to ${esc(first)}</h2>${bigWhen(d, time)}<p>${esc(first)} can accept it with one tap or pick other times. Either way you'll get an email.</p></div>`), undefined, PRIVATE_HEADERS);
  }

  // Customer: accept the workshop's suggested time
  if (p === "/c/accept") {
    const src = req.method === "POST" ? await readBody(req).catch(() => ({})) : Object.fromEntries(url.searchParams);
    const data = verify(src.p);
    if (!data || data.k !== "prop") return errorPage(res, `It may have expired. Please call ${cfg.BUSINESS.phone} and we'll sort out a time.`);
    const { b, d, t } = data;
    if (req.method === "GET") {
      return send(res, 200, page("Accept time", `<div class="panel done"><span class="status prop">Suggested by the workshop</span>
<h2>Book ${esc(b.rego)} in for this time?</h2>${bigWhen(d, t)}<p class="addr">${cfg.BUSINESS.address}</p>
<form method="post" action="${PREFIX}/c/accept"><input type="hidden" name="p" value="${esc(src.p)}"><div class="or"><button class="btn ok" type="submit">Yes, book it in</button>
<a class="btn ghost" href="${PREFIX}/?r=${esc(sign({ k: "redo", b }))}">Pick other times</a></div></form></div>`), undefined, PRIVATE_HEADERS);
    }
    await mail.send({ to: b.email, replyTo: cfg.BUSINESS.workshopEmail, ...emails.customerConfirmed(b, d, t) });
    await mail.send({ to: cfg.BUSINESS.workshopEmail, replyTo: `${b.name} <${b.email}>`, ...emails.workshopBooked(b, d, t, `${b.name} accepted the time you suggested for ${b.ref}.`) });
    return send(res, 200, page("Booked in", `<div class="panel done"><span class="status ok">Booked in</span><h2>See you then</h2>${bigWhen(d, t)}
<p>We've emailed your confirmation to ${esc(b.email)}.</p><p class="addr"><b>Drop off at</b><br>${cfg.BUSINESS.address}</p></div>`), undefined, PRIVATE_HEADERS);
  }

  // Test inbox, only when no real mail server is set up
  // Online, it needs ?key=OUTBOX_KEY so customer details stay private.
  const outboxOpen = !mail.live() && ((process.env.DIESEL_OUTBOX_KEY ?? process.env.OUTBOX_KEY) ? url.searchParams.get("key") === (process.env.DIESEL_OUTBOX_KEY ?? process.env.OUTBOX_KEY) : process.env.NODE_ENV !== "production");
  if (req.method === "GET" && p === "/dev/outbox.json" && outboxOpen) return json(res, 200, mail.outbox);
  if (req.method === "GET" && p === "/dev/outbox" && outboxOpen) {
    const items = mail.outbox.map(m => `<details class="panel" style="margin-bottom:10px"><summary style="padding:12px 16px;cursor:pointer"><b>${esc(m.subject)}</b><br><span class="note">To ${esc(m.to)} · ${esc(m.at)}</span></summary><iframe sandbox="allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation" style="width:100%;height:640px;border:0" srcdoc="${esc(m.html)}"></iframe></details>`).join("");
    return send(res, 200, page("Test outbox", `<h2 style="margin-bottom:12px">Test outbox</h2><p class="note">No mail server is set up, so emails land here instead of being sent.</p>${items || "<p>No emails yet.</p>"}`));
  }

  send(res, 404, page("Not found", `<div class="panel done"><h2>Page not found</h2><p><a href="${PREFIX}/">Book a service</a></p></div>`));
}

async function handleSafely(req, res) {
  try { return (await handle(req, res)) !== false; }
  catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, page("Error", `<div class="panel done"><h2>Something went wrong</h2><p>Please try again, or call ${cfg.BUSINESS.phone}.</p></div>`));
    return true;
  }
}

if (require.main === module) {
  http.createServer(handleSafely).listen(PORT, () => console.log(`Booking app on :${PORT}${PREFIX} (mail: ${mail.live() ? "SMTP" : "test outbox at /dev/outbox"})`));
}

module.exports = { handle: handleSafely };
