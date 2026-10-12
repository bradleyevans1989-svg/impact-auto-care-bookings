(function () {
  'use strict';
  var form = document.getElementById('booking-form');
  var formError = document.getElementById('form-error');
  var submitBtn = document.getElementById('submit-btn');
  var dateInput = form.elements.pref_date;
  var dateHelp = document.getElementById('date-help');
  var cfg = null;

  function fmtDate(ymd) {
    return new Date(ymd + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  function weekday(ymd) { return new Date(ymd + 'T00:00:00Z').getUTCDay(); }

  function setFieldError(name, msg) {
    var el = form.querySelector('.err[data-for="' + name + '"]');
    var input = form.elements[name];
    if (el) el.textContent = msg || '';
    if (input) {
      input.classList.toggle('invalid', !!msg);
      if (msg) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    }
  }
  function clearErrors() {
    form.querySelectorAll('.err').forEach(function (el) { setFieldError(el.dataset.for, ''); });
    formError.hidden = true;
  }

  function checkDate() {
    var v = dateInput.value;
    dateHelp.textContent = '';
    if (!v || !cfg) return true;
    if (v < cfg.minDate || v > cfg.maxDate) { setFieldError('pref_date', 'Please choose a date between ' + fmtDate(cfg.minDate) + ' and ' + fmtDate(cfg.maxDate) + '.'); return false; }
    if (cfg.openDays.indexOf(weekday(v)) === -1) { setFieldError('pref_date', 'We are closed on ' + new Date(v + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'long', timeZone: 'UTC' }) + 's. Please choose a weekday.'); return false; }
    if (cfg.closedDates.indexOf(v) !== -1) { setFieldError('pref_date', 'We are closed that day (public holiday). Please choose another date.'); return false; }
    setFieldError('pref_date', '');
    dateHelp.textContent = fmtDate(v);
    return true;
  }

  fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) {
    cfg = c;
    var svc = form.elements.service;
    c.services.forEach(function (s) { svc.add(new Option(s, s)); });
    var t = form.elements.pref_time;
    c.dropOffTimes.forEach(function (x) { t.add(new Option(x.label, x.value)); });
    dateInput.min = c.minDate;
    dateInput.max = c.maxDate;
    document.getElementById('hours').textContent = 'Workshop hours: ' + c.hoursText + '. Closed weekends and public holidays.';
  }).catch(function () {
    formError.textContent = 'The booking form could not load. Please call us on 0403 136 074.';
    formError.hidden = false;
  });

  dateInput.addEventListener('change', checkDate);
  form.elements.rego.addEventListener('input', function (e) { e.target.value = e.target.value.toUpperCase(); });
  form.addEventListener('input', function (e) { if (e.target.name && e.target.name !== 'pref_date') setFieldError(e.target.name, ''); });

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearErrors();
    var ok = true;
    ['name', 'phone', 'email', 'vehicle_make', 'vehicle_model', 'rego', 'service', 'pref_date', 'pref_time'].forEach(function (n) {
      if (!form.elements[n].value.trim()) { setFieldError(n, 'Required.'); ok = false; }
    });
    if (form.elements.email.value && !form.elements.email.checkValidity()) { setFieldError('email', 'Please enter a valid email address.'); ok = false; }
    if (!checkDate()) ok = false;
    if (!ok) {
      var first = form.querySelector('.invalid');
      if (first) first.focus();
      return;
    }

    var data = {};
    new FormData(form).forEach(function (v, k) { data[k] = v; });
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    fetch('/api/bookings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
      .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
      .then(function (res) {
        if (res.status === 201 || res.body.ok) {
          document.getElementById('success-ref').textContent = res.body.ref;
          document.getElementById('success-summary').textContent =
            data.service + ' for your ' + data.vehicle_make + ' ' + data.vehicle_model + ' (' + data.rego.toUpperCase() + '), ' +
            fmtDate(data.pref_date) + ' at ' + form.elements.pref_time.selectedOptions[0].text + '.';
          form.hidden = true;
          var s = document.getElementById('success');
          s.hidden = false;
          s.focus();
          window.scrollTo({ top: 0, behavior: 'smooth' });
          return;
        }
        var fields = res.body.fields || {};
        Object.keys(fields).forEach(function (k) { setFieldError(k, fields[k]); });
        formError.textContent = res.body.error || 'Something went wrong. Please try again or call us.';
        formError.hidden = false;
        formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
      })
      .catch(function () {
        formError.textContent = 'We couldn’t send your request. Please check your connection, or call us on 0403 136 074.';
        formError.hidden = false;
      })
      .finally(function () {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Request booking';
      });
  });

  document.getElementById('another-btn').addEventListener('click', function () {
    form.reset();
    dateHelp.textContent = '';
    document.getElementById('success').hidden = true;
    form.hidden = false;
    form.elements.name.focus();
  });
})();
