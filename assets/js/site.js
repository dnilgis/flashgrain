/* Flash Grain site script.
   Reads data/site.json (edited in /admin) and data/bids.json (written by the harvester).
   Cash = futures (bids.json) + basis (site.json). Helpers are on window.FG for the admin page. */
(function () {
  var DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  var DAYN = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
  var MONTH = { F: 'Jan', G: 'Feb', H: 'Mar', J: 'Apr', K: 'May', M: 'Jun', N: 'Jul', Q: 'Aug', U: 'Sep', V: 'Oct', X: 'Nov', Z: 'Dec' };
  var TZ = 'America/Chicago';
  var FEED_MAX_AGE_MIN = 120; // harvester heartbeat older than this = feed down, cash withheld

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function num(v) { return typeof v === 'number' && isFinite(v); }
  function money(v) { return (Math.round(v * 100 + 1e-9) / 100).toFixed(2); }
  function basis(v) { var r = Math.round(v * 100 + 1e-9) / 100; return (r < 0 ? '-' : r > 0 ? '+' : '') + Math.abs(r).toFixed(2); }
  // 5.0175 -> 501'6 ; change 0.0175 -> +1'6 ; 0 -> unch
  function cents8(v, signed) {
    var c = Math.round(Math.abs(v) * 800) / 8, w = Math.floor(c), e = Math.round((c - w) * 8), s = w + "'" + e;
    if (!signed) return (v < 0 ? '-' : '') + s;
    return v > 0 ? '+' + s : v < 0 ? '−' + s : 'unch';
  }
  function cents8Words(v, signed) {
    var c = Math.round(Math.abs(v) * 800) / 8, w = Math.floor(c), e = Math.round((c - w) * 8);
    var s = w === 0 ? e + ' eighths of a cent' : w + (w === 1 ? ' cent' : ' cents') + (e ? ' and ' + e + ' eighths' : '');
    return signed ? (v > 0 ? 'up ' + s : v < 0 ? 'down ' + s : 'unchanged') : s;
  }
  function monthOf(sym) { var m = /([A-Z])(\d)?$/.exec(sym || ''); return m ? MONTH[m[1]] : ''; }
  function parseH(h) {
    var m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(h || '');
    if (m) return { o: +m[1] * 60 + +m[2], c: +m[3] * 60 + +m[4] };
    return h === 'closed' ? 'closed' : 'call'; // anything unreadable: tell people to call, never say closed
  }
  function clock(min, short) {
    min = ((min % 1440) + 1440) % 1440;
    var h = Math.floor(min / 60), m = min % 60, h12 = h % 12 || 12;
    return h12 + (m ? ':' + (m < 10 ? '0' : '') + m : '') + (short ? '' : (h < 12 ? ' AM' : ' PM'));
  }
  function hText(h) {
    var p = parseH(h);
    if (p.o != null) return clock(p.o, true) + '–' + clock(p.c, true);
    return p === 'call' ? 'Call ahead' : 'Closed';
  }
  function summary(hours, sep) {
    if (!hours) return '';
    var groups = [];
    DAYS.forEach(function (d) {
      var t = hText(hours[d]), g = groups[groups.length - 1];
      if (g && g.t === t) g.to = d; else groups.push({ from: d, to: d, t: t });
    });
    if (groups.length === 1) return groups[0].t === 'Call ahead' ? 'Call ahead' : 'Daily ' + groups[0].t;
    return groups.map(function (g) {
      var span = g.from === g.to ? DAYN[g.from] : DAYN[g.from] + '–' + DAYN[g.to];
      return span + ' ' + (g.t === 'Closed' || g.t === 'Call ahead' ? g.t.toLowerCase() : g.t);
    }).join(sep || ' · ');
  }
  function central(d) {
    var o = {};
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: 'numeric', hour12: false })
      .formatToParts(d || new Date()).forEach(function (p) { o[p.type] = p.value; });
    return { day: o.weekday.toLowerCase().slice(0, 3), min: (+o.hour % 24) * 60 + +o.minute, ymd: o.year + '-' + o.month + '-' + o.day };
  }
  function addDays(s, n) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n, 12)).toISOString().slice(0, 10); }
  function dowOf(s) { return (new Date(s + 'T12:00:00Z').getUTCDay() + 6) % 7; } // index into DAYS (mon = 0)
  function holiday(s) { return !!(CAL && CAL.holidays && CAL.holidays.indexOf(s) >= 0); }
  // Minutes after midnight that grains close on an early-close day ("12:05" -> 725), or null.
  function earlyClose(s) { var m = /^(\d{1,2}):(\d{2})$/.exec(CAL && CAL.early_close && CAL.early_close[s] || ''); return m ? +m[1] * 60 + +m[2] : null; }
  function dayClose(s) { var e = earlyClose(s); return e == null ? 800 : Math.min(800, e); }
  // The overnight session that opens at 7 PM on Central date s trades for the next day. None on Fri/Sat, none
  // into a holiday, and none on a holiday night before an early-close day (Thanksgiving: no Thursday night).
  function eveningOpen(s) {
    var i = dowOf(s), next = addDays(s, 1);
    if (!(i === 6 || i <= 3) || holiday(next)) return false;
    return !(holiday(s) && earlyClose(next) != null);
  }
  // CBOT corn/soy: Sun-Fri 7:00 PM - 7:45 AM and Mon-Fri 8:30 AM - 1:20 PM Central, less the holidays and early
  // closes in data/cbot.json. No calendar file: weekly hours only.
  function cbotOpen(d) {
    var n = central(d), i = DAYS.indexOf(n.day), wk = i <= 4;
    if (wk && !holiday(n.ymd) && n.min >= 510 && n.min < dayClose(n.ymd)) return true;
    if (wk && n.min < 465 && eveningOpen(addDays(n.ymd, -1))) return true;
    if (n.min >= 1140 && eveningOpen(n.ymd)) return true;
    return false;
  }
  function openState(loc, bare) {
    if (!loc || !loc.hours) return '';
    var n = central(), i = DAYS.indexOf(n.day), today = parseH(loc.hours[n.day]), name = bare ? '' : esc(loc.name) + ' ';
    if (bare) {
      if (today === 'call') return '<b>Call ahead</b> today';
      if (today.o != null && n.min >= today.o && n.min < today.c) return '<b class="on">Open now</b> until ' + clock(today.c);
    }
    if (today === 'call') return '<b>' + name + '</b>call ahead to deliver';
    if (today.o != null && n.min >= today.o && n.min < today.c) return '<b class="on">' + name + 'open now</b> until ' + clock(today.c);
    for (var k = 0; k < 7; k++) {
      var d = DAYS[(i + k) % 7], p = parseH(loc.hours[d]), when = k === 0 ? 'today' : k === 1 ? 'tomorrow' : DAYN[d];
      if (p.o != null && (k > 0 || n.min < p.o)) return '<b>' + name + 'closed</b> · opens ' + when + ' ' + clock(p.o);
      if (p === 'call' && k > 0) return '<b>' + name + 'closed today</b> · call ahead ' + when;
    }
    return '<b>' + name + 'closed</b>';
  }
  // Google Maps directions from wherever the farmer is. A street address (incl. Wisconsin rural W2306-style) goes in as-is; a town alone is
  // searched with the business name so Google can find the yard. No address, no link (never a guessed pin).
  function mapUrl(l) {
    var pin = /^\s*(-?\d{1,3}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/.exec(l.pin || ''), a = (l.address || '').trim();
    if (pin) return 'https://www.google.com/maps/dir/?api=1&destination=' + pin[1] + ',' + pin[2]; // exact pin beats an address
    if (!a) return '';
    var q = /^[NSEW]?\d/i.test(a) ? a : 'Flash Grain, ' + a;
    return 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(q);
  }
  // "2026-09-30T19:33:00" (Central wall time) -> "Wed 7:33 PM"
  function wall(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
    if (!m) return '';
    var wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    return wd + ' ' + clock(+m[4] * 60 + +m[5]);
  }
  // With CBOT shut, a stamp read after the close (or over a weekend or holiday) is the last close, not a trade
  // at that minute: the backup feed, and the harvester's run time (quote_time_source "run"), stamp when the price
  // was READ. Say "Fri close" instead of "Fri 4:25 PM". Inside a session it is a plain wall time.
  function closeLabel(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
    if (!m) return '';
    var s = m[1] + '-' + m[2] + '-' + m[3], min = +m[4] * 60 + +m[5], i = dowOf(s);
    var name = function (x) { return new Date(x + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) + ' close'; };
    var lastDay = function (x) { for (var k = 0; k < 10 && (dowOf(x) > 4 || holiday(x)); k++) x = addDays(x, -1); return x; };
    if (min >= 1140 && eveningOpen(s)) return wall(iso);
    if (i > 4 || holiday(s)) return name(lastDay(s));
    if (min < 465) return eveningOpen(addDays(s, -1)) ? wall(iso) : name(lastDay(addDays(s, -1)));
    if (min >= dayClose(s)) return name(s);
    return wall(iso);
  }
  // "Oct 26" -> "2026-10"; "Fall 26" -> "2026-12" (harvest runs to year end). Unknown labels never expire.
  function labelUntil(label) {
    var M = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
    var m = /^\s*([a-z]{3})[a-z]*\.?\s+'?(\d{2}|\d{4})\s*$/i.exec(label || ''), y, mo;
    if (!m) return '';
    y = m[2].length === 2 ? 2000 + +m[2] : +m[2];
    mo = m[1].toLowerCase() === 'fal' ? 12 : M[m[1].toLowerCase()];
    return mo ? y + '-' + ('0' + mo).slice(-2) : '';
  }
  function ageMin(isoZ) { var t = Date.parse(isoZ || ''); return isNaN(t) ? Infinity : (Date.now() - t) / 60000; }

  // ---------- CBOT calendar (data/cbot.json, written by tools/cbot_calendar.py) ----------
  // Holidays, early closes, first notice (fnd) and last trading day (ltd) per contract. Missing file = no calendar:
  // nothing expires and only the weekly hours apply, as before the file existed. tools/feed.mjs sets FG_CBOT first.
  var CAL = null;
  function setCalendar(c) { CAL = c && typeof c === 'object' ? c : null; return CAL; }
  if (window.FG_CBOT) setCalendar(window.FG_CBOT);
  function ymd(d) { return (d || new Date()).toLocaleDateString('en-CA', { timeZone: TZ }); } // Central date, YYYY-MM-DD
  function contractDates(sym) { return CAL && CAL.contracts && CAL.contracts[sym] || null; }
  // A contract is expired from the Central day after its last trading day. Its last price is a final settle,
  // not a market: a cash bid built on it would be a guess.
  function expired(sym, d) { var c = contractDates(sym); return !!(c && /^\d{4}-\d{2}-\d{2}$/.test(c.ltd || '') && ymd(d) > c.ltd); }
  // The futures quote a row may use, or null: no quote, no price, or the contract has expired. The page and
  // tools/feed.mjs both go through this, so a row is dashed on the page exactly when it leaves the feed.
  function quote(sym, futures, d) {
    var f = futures && futures[sym];
    if (!f || !num(f.price) || expired(sym, d)) return null;
    return f;
  }
  var calReady = Promise.resolve(CAL);
  if (!CAL && typeof fetch === 'function') {
    try {
      // site.js sits in assets/js/, the calendar in data/: works from / and from /admin/ alike.
      var calUrl = new URL('../../data/cbot.json', (document.currentScript && document.currentScript.src) || location.href).href;
      calReady = fetch(calUrl).then(function (r) { return r.ok ? r.json() : null; }).then(setCalendar, function () { return null; });
    } catch (e) {}
  }

  window.FG = { labelUntil: labelUntil, cbotOpen: cbotOpen, ageMin: ageMin, closeLabel: closeLabel, DAYS: DAYS, DAYN: DAYN, money: money, basis: basis, cents8: cents8, summary: summary, parseH: parseH, esc: esc, monthOf: monthOf, num: num,
    setCalendar: setCalendar, calReady: calReady, contractDates: contractDates, holiday: holiday, earlyClose: earlyClose, expired: expired, quote: quote, ymd: ymd };

  // ---------- page ----------
  // The bolt plays on every load, except for people who asked their device for less motion: then it never shows.
  var strike = document.getElementById('strike');
  if (strike) {
    var still = false; try { still = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) {}
    if (still) strike.remove();
    else setTimeout(function () { if (strike.parentNode) strike.remove(); }, 1300);
  }
  var board = document.getElementById('board');
  if (!board) {
    // Pages without the board (offers): only the portal link from /admin (site.json portal_url).
    if (document.querySelector && document.querySelector('[data-portal]') && typeof fetch === 'function') {
      fetch('data/site.json', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
        if (/^https:\/\//.test(s.portal_url || '')) [].forEach.call(document.querySelectorAll('[data-portal]'), function (a) { a.href = s.portal_url; });
      }).catch(function () {});
    }
    return;
  }
  var $ = function (id) { return document.getElementById(id); };
  function safe(fn) { try { fn(); } catch (e) { if (window.console) console.error(e); } }
  function getJSON(u) {
    return fetch(u + (u.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
  }

  var SITE, BIDS, current, segIds = '';
  // Flash what changed when a refresh brings new prices (not on first load, not on a location switch).
  var lastCash = {}, lastQuote = null, flashNext = false;
  try { current = localStorage.getItem('fg-loc') || undefined; } catch (e) {}
  // ?loc=granton opens that yard (links from Google and texts). An id that is not a bid location is ignored.
  try { var qLoc = new URLSearchParams(location.search).get('loc'); if (qLoc) current = qLoc.toLowerCase(); } catch (e) {}

  var FALLBACK_TEL = '715-653-6585';
  function phone() { return (SITE && SITE.business && SITE.business.phone) || FALLBACK_TEL; }
  function callMsg(lead) {
    // The message sits in its own row at the top of the board, where the cash prices would be, so showing it
    // only pushes down what is below the board (no layout jump above the fold).
    var m = $('feed-msg'); $('msg-body').hidden = false;
    m.innerHTML = esc(lead) + ' Call <a href="tel:' + esc(phone().replace(/\D/g, '')) + '">' + esc(phone()) + '</a> for today’s bid.';
  }
  function feedState() {
    if (!BIDS || !BIDS.futures || typeof BIDS.futures !== 'object') return 'none';
    var any = (SITE.bids && SITE.bids.rows || []).some(function (r) { var f = BIDS.futures[r.symbol]; return r.show && f && num(f.price); });
    if (!any) return 'none';
    return ageMin(BIDS.checked || BIDS.updated) > FEED_MAX_AGE_MIN ? 'down' : 'ok';
  }

  function renderBoard() {
    var bidLocs = SITE.locations.filter(function (l) { return l.bids; });
    if (!bidLocs.some(function (l) { return l.id === current; })) current = bidLocs.length ? bidLocs[0].id : null;
    var loc = bidLocs.filter(function (l) { return l.id === current; })[0];
    $('open').innerHTML = openState(loc);
    $('bids-loc').textContent = loc ? loc.name : '';
    var cap = board.parentNode.querySelector('caption'); if (cap) cap.textContent = (loc ? loc.name + ' ' : '') + 'cash bids by delivery period';
    var feed = feedState(), market = cbotOpen();

    // stamp
    var st = $('stamp'), txt;
    if (feed === 'none') txt = 'Futures unavailable';
    else if (feed === 'down') {
      // Over a day stale, "since Fri 8:40 AM" could be any Friday: add the date.
      var downAt = BIDS.checked || BIDS.updated, longAgo = ageMin(downAt) > 24 * 60;
      txt = 'Bids not updating since ' + new Date(Date.parse(downAt)).toLocaleString('en-US', longAgo
        ? { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
        : { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    }
    else {
      // Lead with when the harvester last checked (every 10 minutes). Closed market: say whose close the prices are.
      var chk = new Date(Date.parse(BIDS.checked || BIDS.updated)).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
      var cl = !market && BIDS.quote_time ? closeLabel(BIDS.quote_time) : '';
      txt = 'Checked ' + chk + (market ? '' : ' · CBOT closed' + (/close$/.test(cl) ? ', prices at ' + cl : ''));
    }
    $('asof').textContent = txt;
    st.className = 'stamp' + (feed === 'ok' && market ? ' live' : '') + (feed !== 'ok' ? ' warn' : '');
    var bset = SITE.bids.basis_set ? new Date(SITE.bids.basis_set) : null;
    $('basis-set').textContent = bset && !isNaN(bset) ? 'Basis set ' + bset.toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

    // rows grouped by commodity in first-appearance order
    var groups = [], by = {};
    var ymNow = new Date().toLocaleDateString('en-CA', { timeZone: TZ }).slice(0, 7);
    SITE.bids.rows.forEach(function (r) {
      if (!r.show) return;
      var u = labelUntil(r.label); if (u && u < ymNow) return; // a delivery month that has passed drops off by itself
      if (!by[r.commodity]) { by[r.commodity] = []; groups.push(r.commodity); }
      by[r.commodity].push(r);
    });
    var html = '', months = [], anyExpired = false;
    groups.forEach(function (c) {
      html += '<tbody><tr class="grp"><th scope="rowgroup" colspan="4" class="c">' + esc(c) + '</th></tr>';
      by[c].forEach(function (r) {
        var f = quote(r.symbol, BIDS && BIDS.futures), b = r.basis ? r.basis[current] : null, gone = expired(r.symbol);
        var hasB = num(b), hasF = !!f, show = hasB && hasF && feed === 'ok';
        var m = monthOf(r.symbol); if (m && months.indexOf(c + ': ' + m) < 0) months.push(c + ': ' + m);
        if (gone) anyExpired = true;
        var ch = hasF && num(f.change) ? '<span class="' + (f.change > 0 ? 'up' : f.change < 0 ? 'dn' : 'fl') + '" aria-hidden="true">' + cents8(f.change, true) + '</span>' : '';
        var dash = '<span class="pend" aria-label="not available">—</span>';
        // Phones under 400px hide the futures column; the same quote shows small under the cash instead.
        var mini = hasF ? '<span class="fmini"><span class="vh">' + esc(m + ' futures ' + cents8Words(f.price) + (num(f.change) ? ', ' + cents8Words(f.change, true) : '')) + '</span><span aria-hidden="true">' + esc(m) + ' ' + cents8(f.price) + ch + '</span></span>'
          : gone ? '<span class="fmini">' + esc(m) + ' futures expired</span>' : '';
        var k = current + '|' + r.commodity + '|' + r.label, val = show ? '$' + money(f.price + b) : '';
        html += '<tr><th scope="row" class="c sub">' + esc(r.label) + '</th>'
          + '<td class="cash" data-k="' + esc(k) + '" data-v="' + esc(val) + '">' + (show ? val : dash) + mini + '</td>'
          + '<td>' + (hasB ? basis(b) : dash) + '</td>'
          + '<td class="fut"' + (hasF ? ' aria-label="' + esc(m + ' futures ' + cents8Words(f.price) + (num(f.change) ? ', ' + cents8Words(f.change, true) : '')) + '"' : '') + '>'
          + (hasF ? '<span aria-hidden="true">' + cents8(f.price) + '</span>' + ch : gone ? '<span class="pend">' + esc(m) + ' expired</span>' : dash) + '</td></tr>';
      });
      html += '</tbody>';
    });
    var table = board.parentNode;
    [].slice.call(table.querySelectorAll('tbody:not(#msg-body)')).forEach(function (t) { t.remove(); });
    if (!html) html = '<tbody><tr><td colspan="4" class="pend">No bids posted. Call ' + esc(phone()) + '.</td></tr></tbody>';
    table.insertAdjacentHTML('beforeend', html);
    board = table.querySelector('tbody:not(#msg-body)');

    // flash: cash cells whose value moved since the last refresh, and the stamp when the quote time moved
    var flash = flashNext; flashNext = false;
    table.querySelectorAll('td.cash[data-k]').forEach(function (td) {
      var k = td.getAttribute('data-k'), v = td.getAttribute('data-v');
      if (flash && v && lastCash[k] && lastCash[k] !== v) td.classList.add('tick');
      if (v) lastCash[k] = v;
    });
    var q = BIDS && (BIDS.checked || BIDS.updated) || null;
    if (flash && q && lastQuote && q !== lastQuote) { st.classList.remove('tick'); void st.offsetWidth; st.classList.add('tick'); }
    if (q) lastQuote = q;

    if (feed === 'ok') { $('msg-body').hidden = true; $('feed-msg').innerHTML = ''; }
    else callMsg('Cash prices are hidden until the futures feed is back.');
    $('bids-note').textContent = 'Cash = CBOT futures + basis, $/bu. ' + (months.length ? months.join(', ') + ' futures. ' : '')
      + (anyExpired ? 'Expired = that futures contract has stopped trading. Call for a bid. ' : '') + (SITE.bids.footnote || '');
  }

  function render() {
    safe(function () {
      // No phone in site.json (or no business block at all): keep the number printed in the HTML, never an empty tel: link.
      var biz = SITE.business || {}, tel = phone().replace(/\D/g, '');
      document.querySelectorAll('[data-tel]').forEach(function (a) { a.href = 'tel:' + tel; });
      var call = document.querySelector('.call');
      if (call) call.innerHTML = esc(phone()) + (biz.phone_note ? '<span><span class="vh">, </span>' + esc(biz.phone_note) + '</span>' : '');
    });
    safe(function () {
      // Alert bar. notice_until (YYYY-MM-DD, Central) hides it after that day without anyone remembering to.
      var until = SITE.notice_until || '', today = new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      var list = (until && today > until) ? [] : (SITE.notices || []).filter(Boolean);
      $('notices').innerHTML = list.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
      $('alert').hidden = !list.length;
    });
    safe(function () {
      var tel = phone().replace(/\D/g, '');
      $('loc-list').innerHTML = SITE.locations.map(function (l) {
        var s = l.hours ? summary(l.hours) : '', now = l.hours ? openState(l, true) : '';
        var url = mapUrl(l), note = l.note && s.toLowerCase().indexOf(l.note.toLowerCase()) < 0 ? l.note : '';
        return '<li class="loc"><div class="loc-top"><b>' + esc(l.name) + '</b>' + (now ? '<span class="loc-now">' + now + '</span>' : '') + '</div>'
          + (l.address || s ? '<p class="loc-info">' + [l.address, s].filter(Boolean).map(esc).join(' · ') + '</p>' : '')
          + (note ? '<p class="loc-note">' + esc(note) + '</p>' : '')
          + '<p class="loc-acts">' + (url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">Directions<span class="vh"> to ' + esc(l.name) + ', opens Google Maps</span></a>' : '')
          + '<a href="tel:' + tel + '">Call<span class="vh"> about ' + esc(l.name) + '</span></a></p></li>';
      }).join('');
    });
    safe(function () {
      var t = SITE.lime.towns || [];
      $('lime-text').innerHTML = (SITE.lime.taking_orders ? 'Taking orders. ' : 'Not taking orders right now. ')
        + (t.length ? 'Spreading in <em>' + t.slice(0, -1).map(esc).join(', ') + '</em>' + (t.length > 1 ? ' and ' : '') + '<em>' + esc(t[t.length - 1]) + '.</em>' : '');
    });
    safe(function () { if (/^https:\/\//.test(SITE.portal_url || '')) [].forEach.call(document.querySelectorAll('[data-portal]'), function (a) { a.href = SITE.portal_url; }); });
    safe(function () {
      var bidLocs = SITE.locations.filter(function (l) { return l.bids; }), ids = bidLocs.map(function (l) { return l.id; }).join('|');
      if (!bidLocs.some(function (l) { return l.id === current; })) current = bidLocs.length ? bidLocs[0].id : null;
      var seg = $('seg');
      if (ids !== segIds) { // rebuild only when the location list changes, so keyboard focus survives refreshes
        segIds = ids;
        seg.innerHTML = bidLocs.map(function (l) { return '<button type="button" data-id="' + esc(l.id) + '">' + esc(l.name) + '</button>'; }).join('');
        seg.querySelectorAll('button').forEach(function (b) { b.onclick = function () {
          current = b.getAttribute('data-id'); try { localStorage.setItem('fg-loc', current); } catch (e) {}
          renderBoard(); paintSeg();
        }; });
      }
      paintSeg();
    });
    try { renderBoard(); } catch (e) { if (window.console) console.error(e); callMsg('Bids are not showing right now.'); }
  }
  function paintSeg() { $('seg').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-id') === current)); }); }

  var failedAt = null;
  function load() {
    return Promise.all([getJSON('data/site.json'), getJSON('data/bids.json').catch(function () { return BIDS || null; }), calReady])
      .then(function (r) {
        if (SITE && BIDS && r[1] && (r[1].checked !== BIDS.checked || JSON.stringify(r[1].futures) !== JSON.stringify(BIDS.futures))) flashNext = true;
        SITE = r[0]; BIDS = r[1]; failedAt = null;
      })
      .then(function () { render(); })
      .catch(function () {
        if (SITE) { try { renderBoard(); } catch (e) { callMsg('Bids are not showing right now.'); } return; } // keep the last good board on a failed refresh
        callMsg('Bids are not loading.');
      });
  }
  load();
  setInterval(function () { if (!document.hidden) load(); }, 2 * 60 * 1000); // two small files; new prices show within 2 minutes of a harvest
  document.addEventListener('visibilitychange', function () { if (!document.hidden) load(); });

  // ---------- weather (National Weather Service, no key) ----------
  (function () {
    var el = $('wx'); if (!el) return;
    var LAT = 44.9611, LON = -90.7999, NWS = 'https://forecast.weather.gov/MapClick.php?lat=' + LAT + '&lon=' + LON;
    function get(u) { return fetch(u, { headers: { Accept: 'application/geo+json' } }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); }); }
    function deg(d) { return ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(d / 45) % 8]; }
    function n0(v) { v = Math.round(+v); return isFinite(v) ? v : '–'; }
    function hrLabel(iso) { var hh = +String(iso).slice(11, 13); return hh === 0 ? '12a' : hh < 12 ? hh + 'a' : hh === 12 ? '12p' : (hh - 12) + 'p'; } // NWS times carry Thorp's offset
    function wind(s) { return esc(String(s || '').replace(/ to /, '–').replace(/ mph$/, '')); }
    get('https://api.weather.gov/points/' + LAT + ',' + LON).then(function (pj) {
      var pt = pj.properties;
      return Promise.all([get(pt.forecast), get(pt.forecastHourly), get(pt.observationStations)]).then(function (r) {
        var fc = r[0], hr = r[1], st = r[2];
        return get(st.features[0].id + '/observations/latest').then(function (o) { return o.properties; }, function () { return null; })
          .then(function (obs) {
            var now = hr.properties.periods[0], radar = pt.radarStation;
            var ok = function (q) { return obs && obs[q] && obs[q].value != null; };
            var t = ok('temperature') ? n0(obs.temperature.value * 9 / 5 + 32) : n0(now.temperature);
            var cond = obs && obs.textDescription ? obs.textDescription : now.shortForecast;
            var wnd = ok('windSpeed') ? n0(obs.windSpeed.value * 0.621371) + ' mph' : String(now.windSpeed || '');
            var wdir = ok('windDirection') ? deg(obs.windDirection.value) : now.windDirection;
            var rh = ok('relativeHumidity') ? n0(obs.relativeHumidity.value) + '% humidity' : '';
            var h = hr.properties.periods.slice(0, 12).map(function (p) {
              var pp = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value;
              return '<div>' + hrLabel(p.startTime) + '<b>' + n0(p.temperature) + '&deg;</b><i>' + wind(p.windSpeed) + ' ' + esc(p.windDirection) + '</i><i>' + (pp ? n0(pp) + '% rain' : '&nbsp;') + '</i></div>';
            }).join('');
            var byDay = {}, order = [];
            fc.properties.periods.forEach(function (p) { var k = String(p.startTime).slice(0, 10); if (!byDay[k]) { byDay[k] = {}; order.push(k); } byDay[k][p.isDaytime ? 'day' : 'night'] = p; });
            var dl = order.slice(0, 7).map(function (k, i) {
              var d = byDay[k], p = d.day || d.night, name = i === 0 ? 'Today' : new Date(k + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
              var pp = p.probabilityOfPrecipitation && p.probabilityOfPrecipitation.value;
              return '<li><b>' + name + '</b><span>' + esc(p.shortForecast) + '</span><em><small>' + (pp ? n0(pp) + '%' : '') + '</small>' + (d.day ? n0(d.day.temperature) + '&deg;' : '') + (d.night ? ' <span class="lo">/ ' + n0(d.night.temperature) + '&deg;</span>' : '') + '</em></li>';
            }).join('');
            var when = obs && obs.timestamp ? new Date(obs.timestamp).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : '';
            el.className = '';
            el.innerHTML = '<div class="wx-now"><div class="t">' + t + '<sup>&deg;F</sup></div><div class="c">' + esc(cond) + '</div><div class="d">Wind ' + esc(wdir) + ' ' + esc(wnd) + (rh ? ' &middot; ' + rh : '') + (when ? ' &middot; Thorp, as of ' + when : '') + '</div></div>'
              + '<div class="wx-hr" tabindex="0" role="region" aria-label="Hourly forecast, next 12 hours. Scrolls sideways.">' + h + '</div><ul class="wx-days">' + dl + '</ul>'
              + (radar ? '<div class="wx-radar"><img alt="Radar loop, ' + esc(radar) + '" loading="lazy" decoding="async" src="https://radar.weather.gov/ridge/standard/' + esc(radar) + '_loop.gif"></div>' : '')
              + '<p class="wx-cap"><span>National Weather Service, ' + esc(pt.gridId) + ' office' + (radar ? ' &middot; radar ' + esc(radar) : '') + '</span><a href="' + NWS + '" target="_blank" rel="noopener">Full forecast &rarr;</a></p>';
            // No inline onerror (the page's CSP blocks inline handlers): a radar loop that fails to load is removed.
            var img = el.querySelector('.wx-radar img');
            if (img) img.addEventListener('error', function () { if (img.parentNode && img.parentNode.parentNode) img.parentNode.remove(); });
          });
      });
    }).catch(function () {
      el.className = 'wx-err';
      el.innerHTML = 'Forecast is not loading right now. <a href="' + NWS + '" target="_blank" rel="noopener">Open the NWS forecast for Thorp &rarr;</a>';
    });
  })();
})();
