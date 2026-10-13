// Email bodies. Inline styles only, since mail apps ignore stylesheets.
const { BUSINESS, fmtLong, fmtShort, slotLabel, dow } = require("./config");

const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ORANGE = "#e8590c", INK = "#0d1217", MUTED = "#5b6570", LINE = "#d5d9de";

const wrap = inner => `<!doctype html><html><body style="margin:0;padding:24px 12px;background:#eef0f2;font-family:Arial,Helvetica,sans-serif;color:${INK}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;margin:0 auto;background:#ffffff;border:1px solid ${LINE};border-radius:6px">
<tr><td style="padding:18px 24px;border-bottom:3px solid ${INK};font-weight:800;font-size:20px;letter-spacing:.02em;text-transform:uppercase">Impact Diesel <span style="color:${ORANGE}">Group</span></td></tr>
<tr><td style="padding:22px 24px;font-size:15px;line-height:1.5">${inner}</td></tr>
<tr><td style="padding:14px 24px;border-top:1px solid ${LINE};font-size:12px;color:${MUTED}">${BUSINESS.name} · ${BUSINESS.address}<br>Workshop and 24-hour breakdowns: ${BUSINESS.phone}</td></tr>
</table></body></html>`;

const button = (href, label, bg = INK) =>
  `<a href="${esc(href)}" style="display:inline-block;background:${bg};color:#ffffff;text-decoration:none;font-weight:700;font-size:14px;text-transform:uppercase;letter-spacing:.03em;padding:10px 16px;border-radius:4px">${esc(label)}</a>`;

const plate = rego => `<span style="display:inline-block;background:#f7d117;color:#111;border:2px solid #111;border-radius:4px;font-family:Consolas,Menlo,monospace;font-weight:700;padding:0 6px;letter-spacing:.06em">${esc(rego)}</span>`;

const big = (d, t) => `<div style="font-size:26px;font-weight:800;text-transform:uppercase;line-height:1.15;margin:14px 0">${esc(fmtLong(d))}<br>Drop-off ${esc(slotLabel(t))}</div>`;

function details(b) {
  const row = (k, v) => v ? `<tr><td style="padding:3px 16px 3px 0;color:${MUTED};vertical-align:top;white-space:nowrap">${k}</td><td style="padding:3px 0">${v}</td></tr>` : "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="font-size:14px;margin:12px 0">
${row("Ref", esc(b.ref))}
${row("Customer", esc(b.name) + (b.company ? ", " + esc(b.company) : ""))}
${row("Phone", esc(b.phone))}
${row("Email", esc(b.email))}
${row("Rego", plate(b.rego) + " " + esc(b.plateState))}
${row("Vehicle", esc(b.type) + (b.make ? ", " + esc(b.make) : ""))}
${row("Odometer", b.odo ? Number(b.odo).toLocaleString("en-AU") + " km / hrs" : "")}
${row("Work", esc(b.services.join(", ")) || "See notes")}
${row("Notes", esc(b.notes).replace(/\n/g, "<br>"))}
</table>`;
}

const detailsText = b => [
  `Ref: ${b.ref}`, `Customer: ${b.name}${b.company ? ", " + b.company : ""}`, `Phone: ${b.phone}`, `Email: ${b.email}`,
  `Rego: ${b.rego} ${b.plateState}`, `Vehicle: ${b.type}${b.make ? ", " + b.make : ""}`, b.odo ? `Odometer: ${b.odo}` : "",
  `Work: ${b.services.join(", ") || "See notes"}`, b.notes ? `Notes: ${b.notes}` : ""
].filter(Boolean).join("\n");

const RANK = ["1st", "2nd", "3rd"];

// To the workshop: a new request with one button per preferred time.
function workshopRequest(b, links) {
  const subject = `Booking request ${b.ref}: ${b.rego} ${b.make || b.type}${b.prevRef ? " (new times)" : ""}`;
  const slots = b.picks.map((p, i) => `<tr>
<td style="padding:10px 12px;border:1px solid ${LINE};border-right:0;font-weight:800;color:${ORANGE};font-size:18px">${RANK[i]}</td>
<td style="padding:10px 12px;border-top:1px solid ${LINE};border-bottom:1px solid ${LINE}"><b>${esc(fmtLong(p.d))}</b><br><span style="color:${MUTED};font-size:13px">Drop-off ${esc(slotLabel(p.t))}${dow(p.d) === 6 ? " · Saturday appointment" : ""}</span></td>
<td style="padding:10px 12px;border:1px solid ${LINE};border-left:0;text-align:right">${button(links.confirm[i], "Confirm")}</td></tr>`).join("");
  const html = wrap(`
<p style="margin:0 0 6px;font-size:20px;font-weight:800;text-transform:uppercase">${esc(b.name)} wants to book in ${esc(b.rego)}</p>
${b.prevRef ? `<p style="margin:0 0 8px;color:${MUTED}">They couldn't make your suggested time for ${esc(b.prevRef)} and picked new options.</p>` : ""}
${details(b)}
<p style="margin:18px 0 8px;font-weight:700">Their preferred drop-off times</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;border-spacing:0 6px">${slots}</table>
<p style="margin:16px 0">${button(links.propose, "None work, suggest another time", ORANGE)}</p>
<p style="margin:0;font-size:13px;color:${MUTED}">Each button opens a page where you confirm with one more tap, then the customer is emailed automatically. Hit reply to email ${esc(b.name.split(" ")[0])} directly.</p>`);
  const text = `${b.name} wants to book in ${b.rego}.\n\n${detailsText(b)}\n\nPreferred times:\n${b.picks.map((p, i) => `${RANK[i]}: ${fmtLong(p.d)} drop-off ${slotLabel(p.t)}\n  Confirm: ${links.confirm[i]}`).join("\n")}\n\nNone work? Suggest another time: ${links.propose}`;
  return { subject, html, text };
}

// To the customer: we got your request.
function customerReceived(b) {
  const subject = `We've got your booking request for ${b.rego}`;
  const html = wrap(`
<p style="margin:0">Hi ${esc(b.name.split(" ")[0])},</p>
<p>Thanks for your booking request. The workshop will check the times you picked and email you to confirm one, usually the same working day.</p>
<p style="margin:0;font-weight:700">Times you picked</p>
<ul style="margin:6px 0 14px;padding-left:20px">${b.picks.map((p, i) => `<li>${RANK[i]}: ${esc(fmtLong(p.d))}, drop-off ${esc(slotLabel(p.t))}</li>`).join("")}</ul>
${details(b)}
<p style="font-size:13px;color:${MUTED}">Broken down? Don't wait for email. Call ${BUSINESS.phone}, 24 hours.</p>`);
  const text = `Hi ${b.name.split(" ")[0]},\n\nThanks for your booking request. The workshop will confirm one of these times by email:\n${b.picks.map((p, i) => `${RANK[i]}: ${fmtLong(p.d)}, drop-off ${slotLabel(p.t)}`).join("\n")}\n\n${detailsText(b)}`;
  return { subject, html, text };
}

// To the customer: confirmed.
function customerConfirmed(b, d, t) {
  const subject = `Booking confirmed: ${b.rego}, ${fmtShort(d)} ${slotLabel(t)}`;
  const html = wrap(`
<p style="margin:0">Hi ${esc(b.name.split(" ")[0])}, you're booked in.</p>
${big(d, t)}
<p style="margin:0"><b>Drop off at</b><br>${BUSINESS.address}</p>
${details(b)}
<p style="font-size:13px;color:${MUTED}">Need to change it? Reply to this email or call ${BUSINESS.phone}.</p>`);
  const text = `Hi ${b.name.split(" ")[0]}, you're booked in.\n\n${fmtLong(d)}, drop-off ${slotLabel(t)}\n${BUSINESS.address}\n\n${detailsText(b)}\n\nNeed to change it? Reply or call ${BUSINESS.phone}.`;
  return { subject, html, text };
}

// To the workshop: a record of what was booked, easy to search for later.
function workshopBooked(b, d, t, how) {
  const subject = `Booked: ${b.rego} ${fmtShort(d)} ${slotLabel(t)} (${b.ref})`;
  const html = wrap(`<p style="margin:0">${esc(how)}</p>${big(d, t)}${details(b)}`);
  return { subject, html, text: `${how}\n\n${fmtLong(d)}, drop-off ${slotLabel(t)}\n\n${detailsText(b)}` };
}

// To the customer: none of your times work, how about this one?
function customerProposal(b, d, t, msg, links) {
  const subject = `New time suggested for ${b.rego}: ${fmtShort(d)} ${slotLabel(t)}`;
  const html = wrap(`
<p style="margin:0">Hi ${esc(b.name.split(" ")[0])},</p>
<p>${msg ? esc(msg).replace(/\n/g, "<br>") : "Unfortunately none of the times you picked are free. Can you do this instead?"}</p>
${big(d, t)}
<p style="margin:16px 0">${button(links.accept, "Accept this time", "#1f7a46")} &nbsp; ${button(links.other, "Pick other times")}</p>
${details(b)}`);
  const text = `Hi ${b.name.split(" ")[0]},\n\n${msg || "None of the times you picked are free. Can you do this instead?"}\n\n${fmtLong(d)}, drop-off ${slotLabel(t)}\n\nAccept: ${links.accept}\nPick other times: ${links.other}`;
  return { subject, html, text };
}

module.exports = { workshopRequest, customerReceived, customerConfirmed, workshopBooked, customerProposal, esc, details };
