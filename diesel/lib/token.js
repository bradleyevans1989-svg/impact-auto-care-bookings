// Signed, tamper-proof links. The booking travels inside the link itself,
// so the app needs no database: the email thread is the record.
const crypto = require("node:crypto");

const SECRET = (process.env.DIESEL_LINK_SECRET ?? process.env.LINK_SECRET) || "dev-only-secret-change-me";
const TTL_DAYS = 45;

const b64 = buf => Buffer.from(buf).toString("base64url");
const mac = data => crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

function sign(payload) {
  const body = b64(JSON.stringify({ ...payload, exp: Date.now() + TTL_DAYS * 864e5 }));
  return `${body}.${mac(body)}`;
}

function verify(token) {
  if (typeof token !== "string" || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = mac(body);
  if (!sig || sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!data.exp || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}

module.exports = { sign, verify };
