// Sends email over SMTP (Google Workspace, Microsoft 365, or your web host's mail server).
// With no SMTP settings, emails are kept in memory and shown at /dev/outbox for testing.
const nodemailer = require("nodemailer");

const outbox = [];
let transport = null;

if ((process.env.DIESEL_SMTP_HOST ?? process.env.SMTP_HOST)) {
  const port = Number((process.env.DIESEL_SMTP_PORT ?? process.env.SMTP_PORT) || 587);
  transport = nodemailer.createTransport({
    host: (process.env.DIESEL_SMTP_HOST ?? process.env.SMTP_HOST),
    port,
    secure: port === 465,
    auth: { user: (process.env.DIESEL_SMTP_USER ?? process.env.SMTP_USER), pass: (process.env.DIESEL_SMTP_PASS ?? process.env.SMTP_PASS) }
  });
}

const FROM = (process.env.DIESEL_MAIL_FROM ?? process.env.MAIL_FROM) || `Impact Diesel Group <${(process.env.DIESEL_WORKSHOP_EMAIL ?? process.env.WORKSHOP_EMAIL) || "service@impactdiesel.com.au"}>`;

async function send({ to, subject, html, text, replyTo }) {
  const msg = { from: FROM, to, subject, html, text, replyTo };
  if (!transport) {
    outbox.unshift({ ...msg, at: new Date().toISOString() });
    outbox.length = Math.min(outbox.length, 50);
    console.log(`[mail:dev] to=${to} subject="${subject}"`);
    return;
  }
  await transport.sendMail(msg);
}

module.exports = { send, outbox, live: () => !!transport };
