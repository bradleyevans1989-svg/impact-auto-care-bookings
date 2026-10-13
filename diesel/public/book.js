(() => {
  const view = document.getElementById("view");
  const params = new URLSearchParams(location.search);
  const embedded = params.has("embed") || window.self !== window.top;
  if (embedded) document.body.classList.add("embed");

  const DOW = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
  const MON = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;" }[c]));
  // Dates are "YYYY-MM-DD" strings; arithmetic in UTC so the viewer's timezone can't shift them.
  const parse = k => { const [y,m,d] = k.split("-").map(Number); return new Date(Date.UTC(y, m-1, d)); };
  const toKey = d => d.toISOString().slice(0, 10);
  const add = (k, n) => { const d = parse(k); d.setUTCDate(d.getUTCDate() + n); return toKey(d); };
  const fmtLong = k => { const d = parse(k); return `${DOW[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };

  let C; // server config
  const f = { name:"", company:"", phone:"", email:"", rego:"", plateState:"NSW", type:"Prime mover", make:"", odo:"", services:[], notes:"", picks:[], prevRef:"" };
  let calMonth, selDay = null, error = "", sending = false;

  // Keep the parent page's iframe sized to the form.
  function reportHeight() { if (embedded) parent.postMessage({ idgBookingHeight: document.documentElement.scrollHeight }, "*"); }
  new ResizeObserver(reportHeight).observe(document.body);

  const slotLabel = t => (C.slots.find(s => s[0] === t) || [t, t])[1];
  const bookable = k => k > C.today && k <= add(C.today, C.aheadDays) && parse(k).getUTCDay() !== 0;

  async function start() {
    try { C = await (await fetch("api/config")).json(); }
    catch { view.innerHTML = `<div class="panel empty-state">The booking form didn't load. Please refresh, or call 0431 104 104.</div>`; return; }
    const t = parse(C.today); calMonth = { y: t.getUTCFullYear(), m: t.getUTCMonth() };
    const r = params.get("r");
    if (r) {
      try {
        const res = await fetch("api/prefill?r=" + encodeURIComponent(r));
        if (res.ok) Object.assign(f, await res.json());
      } catch {}
    }
    renderForm();
  }

  function renderForm() {
    view.innerHTML = `
    <div class="panel">
      <form id="bk" novalidate>
        ${f.prevRef ? `<fieldset><span class="status prop">Picking new times for ${esc(f.rego)}</span><p style="margin:0">Your details are filled in from last time. Choose some new drop-off times below and send it through.</p></fieldset>` : ""}
        <fieldset>
          <legend><h2>Your details</h2><span class="sub">So we can confirm the booking</span></legend>
          <div class="grid">
            <label class="f">Name<input id="name" type="text" value="${esc(f.name)}" autocomplete="name" required></label>
            <label class="f">Company <span class="opt">optional</span><input id="company" type="text" value="${esc(f.company)}" autocomplete="organization"></label>
            <label class="f">Mobile<input id="phone" type="tel" value="${esc(f.phone)}" autocomplete="tel" required></label>
            <label class="f">Email<input id="email" type="email" value="${esc(f.email)}" autocomplete="email" required></label>
          </div>
          <label class="hp" aria-hidden="true">Website<input id="website" type="text" tabindex="-1" autocomplete="off"></label>
        </fieldset>

        <fieldset>
          <legend><h2>Vehicle</h2><span class="sub">Truck, trailer or plant</span></legend>
          <div class="plate-row">
            <label class="f">Registration
              <span class="plate">
                <input id="rego" type="text" maxlength="8" value="${esc(f.rego)}" aria-label="Registration number" spellcheck="false" autocapitalize="characters" placeholder="ABC12D">
                <select id="plateState" aria-label="Registration state">${["NSW","VIC","QLD","ACT","SA","WA","TAS","NT"].map(s => `<option ${s===f.plateState?"selected":""}>${s}</option>`).join("")}</select>
              </span>
            </label>
            <div class="grid" style="flex:1 1 260px; min-width:0;">
              <label class="f">Vehicle type<select id="type">${C.types.map(t => `<option ${t===f.type?"selected":""}>${esc(t)}</option>`).join("")}</select></label>
              <label class="f">Make and model <span class="opt">optional</span><input id="make" type="text" value="${esc(f.make)}" placeholder="e.g. Kenworth T610"></label>
              <label class="f">Odometer (km) <span class="opt">or engine hours</span><input id="odo" type="text" inputmode="numeric" value="${esc(f.odo)}"></label>
            </div>
          </div>
        </fieldset>

        <fieldset>
          <legend><h2>What needs doing</h2><span class="sub">Pick any that apply</span></legend>
          <div class="chips">${C.services.map((s,i) => `<label class="chip"><input type="checkbox" id="svc${i}" ${f.services.includes(s)?"checked":""}><span>${esc(s)}</span></label>`).join("")}</div>
          <label class="f">Anything we should know? <span class="opt">symptoms, fault codes, load</span><textarea id="notes" maxlength="1000">${esc(f.notes)}</textarea></label>
          <div class="breakdown">Broken down on the road? Don't book online. Call our 24-hour line on <b>${esc(C.phone)}</b>.</div>
        </fieldset>

        <fieldset>
          <legend><h2>Preferred drop-off times</h2><span class="sub">Choose up to 3, in order of preference</span></legend>
          <div class="sched">
            <div>
              <div class="cal-head">
                <button type="button" class="x" id="prevM" aria-label="Previous month">‹</button>
                <span class="m" id="mLabel"></span>
                <button type="button" class="x" id="nextM" aria-label="Next month">›</button>
              </div>
              <div class="cal" id="cal"></div>
              <p class="note">Drop-offs 8am to 6pm on weekdays. Saturdays are by appointment, so we'll confirm those with you.</p>
            </div>
            <div>
              <div class="times-h" id="timesH"></div>
              <div class="times" id="times"></div>
              <div class="picks" id="picks"></div>
            </div>
          </div>
        </fieldset>
      </form>
      <div class="actions">
        <span class="note">We'll email you once the workshop confirms a time.</span>
        <span id="formErr" class="err" role="alert">${esc(error)}</span>
        <button type="button" class="btn primary" id="submit">Send booking request</button>
      </div>
    </div>`;
    drawCal(); drawTimes(); drawPicks();
    view.querySelector("#prevM").onclick = () => moveMonth(-1);
    view.querySelector("#nextM").onclick = () => moveMonth(1);
    view.querySelector("#bk").addEventListener("input", readForm);
    view.querySelector("#submit").onclick = submit;
  }

  function moveMonth(n) {
    let { y, m } = calMonth; m += n; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; }
    const first = `${y}-${String(m+1).padStart(2,"0")}-01`;
    const t = parse(C.today), lastAllowed = add(C.today, C.aheadDays);
    if (y * 12 + m < t.getUTCFullYear() * 12 + t.getUTCMonth() || first > lastAllowed) return;
    calMonth = { y, m }; drawCal();
  }

  function readForm() {
    const $ = id => view.querySelector("#" + id);
    f.name = $("name").value.trim(); f.company = $("company").value.trim(); f.phone = $("phone").value.trim(); f.email = $("email").value.trim();
    f.rego = $("rego").value.toUpperCase().replace(/[^A-Z0-9]/g, ""); f.plateState = $("plateState").value; f.type = $("type").value;
    f.make = $("make").value.trim(); f.odo = $("odo").value.replace(/\D/g, ""); f.notes = $("notes").value.trim();
    f.services = C.services.filter((s,i) => $("svc"+i).checked);
  }

  function drawCal() {
    const { y, m } = calMonth;
    view.querySelector("#mLabel").textContent = `${MONTHS[m]} ${y}`;
    const firstDow = (new Date(Date.UTC(y, m, 1)).getUTCDay() + 6) % 7; // Monday first
    const days = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    let html = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"].map(d => `<div class="dow">${d}</div>`).join("");
    for (let i = 0; i < firstDow; i++) html += `<div class="blank"></div>`;
    for (let n = 1; n <= days; n++) {
      const k = `${y}-${String(m+1).padStart(2,"0")}-${String(n).padStart(2,"0")}`, ok = bookable(k), sat = parse(k).getUTCDay() === 6;
      const pi = f.picks.findIndex(p => p.d === k);
      html += `<button type="button" class="day ${sat?"sat":""} ${selDay===k?"sel":""}" data-k="${k}" aria-disabled="${!ok}" aria-label="${fmtLong(k)}${ok?"":", not available"}">${n}${pi>-1?`<span class="pin">${pi+1}</span>`:""}</button>`;
    }
    const cal = view.querySelector("#cal"); cal.innerHTML = html;
    cal.querySelectorAll(".day").forEach(b => b.onclick = () => { if (b.getAttribute("aria-disabled") === "true") return; selDay = b.dataset.k; drawCal(); drawTimes(); });
  }

  function drawTimes() {
    const h = view.querySelector("#timesH"), t = view.querySelector("#times");
    if (!selDay) { h.textContent = "Pick a day on the calendar"; t.innerHTML = ""; return; }
    const sat = parse(selDay).getUTCDay() === 6, full = f.picks.length >= 3;
    h.textContent = `Drop-off on ${fmtLong(selDay)}${sat ? " (by appointment)" : ""}`;
    t.innerHTML = C.slots.map(([v, l]) => {
      const taken = f.picks.some(p => p.d === selDay && p.t === v);
      return `<button type="button" class="time" data-t="${v}" aria-disabled="${taken || full}"><b>${l}</b><small>${taken ? "Already chosen" : full ? "3 already chosen" : "Add as an option"}</small></button>`;
    }).join("");
    t.querySelectorAll(".time").forEach(b => b.onclick = () => {
      if (b.getAttribute("aria-disabled") === "true") return;
      f.picks.push({ d: selDay, t: b.dataset.t }); error = ""; view.querySelector("#formErr").textContent = "";
      drawCal(); drawTimes(); drawPicks();
    });
  }

  function drawPicks() {
    const p = view.querySelector("#picks");
    p.innerHTML = [0,1,2].map(i => f.picks[i]
      ? `<div class="pick"><span class="rank">${["1st","2nd","3rd"][i]}</span><span class="when"><b>${fmtLong(f.picks[i].d)}</b><small>Drop-off ${slotLabel(f.picks[i].t)}</small></span><button type="button" class="x" data-i="${i}" aria-label="Remove option ${i+1}">×</button></div>`
      : `<div class="pick empty"><span class="rank">${["1st","2nd","3rd"][i]}</span><span class="when">${i === f.picks.length ? "Pick a day, then a time" : "Optional"}</span><span></span></div>`).join("");
    p.querySelectorAll(".x").forEach(b => b.onclick = () => { f.picks.splice(+b.dataset.i, 1); drawCal(); drawTimes(); drawPicks(); });
  }

  async function submit() {
    if (sending) return;
    readForm();
    const miss = [];
    if (!f.name) miss.push("your name");
    if (f.phone.replace(/\D/g, "").length < 8) miss.push("a contact number");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email)) miss.push("a valid email");
    if (f.rego.length < 2) miss.push("the rego");
    if (!f.services.length && !f.notes) miss.push("what needs doing");
    if (!f.picks.length) miss.push("at least one drop-off time");
    const errEl = view.querySelector("#formErr"), btn = view.querySelector("#submit");
    if (miss.length) { error = "Please add " + miss.join(", ") + "."; errEl.textContent = error; return; }
    sending = true; btn.disabled = true; btn.textContent = "Sending…"; errEl.textContent = "";
    try {
      const res = await fetch("api/book", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...f, website: view.querySelector("#website").value }) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.error || "We couldn't send your request. Please try again or call 0431 104 104.");
      done(out);
    } catch (e) {
      errEl.textContent = e.message; btn.disabled = false; btn.textContent = "Send booking request"; sending = false;
    }
  }

  function done(out) {
    view.innerHTML = `<div class="panel done">
      <span class="status pending">Request sent · ref ${esc(out.ref)}</span>
      <h2>Thanks ${esc(f.name.split(" ")[0])}, we've got it</h2>
      <p style="margin:0">The workshop will check your times and email <b>${esc(out.email)}</b> to confirm one. We've sent you a copy of your request.</p>
      <div class="picks">${f.picks.map((p,i) => `<div class="pick"><span class="rank">${["1st","2nd","3rd"][i]}</span><span class="when"><b>${fmtLong(p.d)}</b><small>Drop-off ${slotLabel(p.t)}</small></span><span></span></div>`).join("")}</div>
      <p class="note">Need it sooner or broken down? Call ${esc(C.phone)}.</p>
    </div>`;
    if (embedded) parent.postMessage({ idgBookingScrollTop: true }, "*");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  start();
})();
