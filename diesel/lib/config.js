// Business settings shared by the server and the booking form.
const TZ = "Australia/Sydney";

const BUSINESS = {
  name: "Impact Diesel Group",
  phone: "0431 104 104",
  address: "9 Resolution Drive, Unanderra NSW 2526",
  workshopEmail: (process.env.DIESEL_WORKSHOP_EMAIL ?? process.env.WORKSHOP_EMAIL) || "service@impactdiesel.com.au"
};

const SERVICES = [
  "Engine servicing", "Cooling systems", "Brakes", "Suspension", "Transmission & driveline",
  "Diesel diagnostics", "Air conditioning", "Electrical repairs", "Exhaust systems", "Hydraulics & air",
  "Fleet maintenance", "Vehicle inspection / pink & blue slip", "Trailer servicing"
];

const TYPES = ["Prime mover", "Rigid truck", "Light truck / tipper", "Trailer", "Bus / coach", "Plant or machinery", "Other"];

// Drop-off windows, 8am to 6pm.
const SLOTS = [["08:00", "8:00 am"], ["10:00", "10:00 am"], ["12:00", "12:00 pm"], ["14:00", "2:00 pm"], ["16:00", "4:00 pm"], ["18:00", "6:00 pm"]];

const BOOK_AHEAD_DAYS = 60;

const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Dates are plain "YYYY-MM-DD" strings in Sydney time; do the arithmetic in UTC so no timezone can shift them.
const parseKey = k => { const [y, m, d] = k.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const toKey = d => d.toISOString().slice(0, 10);
const todayKey = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const addDays = (k, n) => { const d = parseKey(k); d.setUTCDate(d.getUTCDate() + n); return toKey(d); };
const dow = k => parseKey(k).getUTCDay();
const fmtLong = k => { const d = parseKey(k); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const fmtShort = k => { const d = parseKey(k); return `${DOW[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
const slotLabel = t => (SLOTS.find(s => s[0] === t) || [t, t])[1];

function dayBookable(k) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  const today = todayKey();
  return k > today && k <= addDays(today, BOOK_AHEAD_DAYS) && dow(k) !== 0;
}

module.exports = { TZ, BUSINESS, SERVICES, TYPES, SLOTS, BOOK_AHEAD_DAYS, todayKey, addDays, dow, fmtLong, fmtShort, slotLabel, dayBookable };
