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
    new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false })
      .formatToParts(d || new Date()).forEach(function (p) { o[p.type] = p.value; });
    return { day: o.weekday.toLowerCase().slice(0, 3), min: (+o.hour % 24) * 60 + +o.minute };
  }
  // CBOT corn/soy: Sun-Fri 7:00 PM - 7:45 AM and Mon-Fri 8:30 AM - 1:20 PM Central. Exchange holidays not modelled.
  function cbotOpen(d) {
    var n = central(d), i = DAYS.indexOf(n.day), wk = i <= 4;
    if (wk && n.min >= 510 && n.min < 800) return true;
    if (wk && n.min < 465) return true;
    if ((n.day === 'sun' || i <= 3) && n.min >= 1140) return true;
    return false;
  }
  function openState(loc) {
    if (!loc || !loc.hours) return '';
    var n = central(), i = DAYS.indexOf(n.day), today = parseH(loc.hours[n.day]), name = esc(loc.name);
    if (today === 'call') return '<b>' + name + '</b> call ahead to deliver';
    if (today.o != null && n.min >= today.o && n.min < today.c) return '<b class="on">' + name + ' open now</b> until ' + clock(today.c);
    for (var k = 0; k < 7; k++) {
      var d = DAYS[(i + k) % 7], p = parseH(loc.hours[d]), when = k === 0 ? 'today' : k === 1 ? 'tomorrow' : DAYN[d];
      if (p.o != null && (k > 0 || n.min < p.o)) return '<b>' + name + ' closed</b> · opens ' + when + ' ' + clock(p.o);
      if (p === 'call' && k > 0) return '<b>' + name + ' closed today</b> · call ahead ' + when;
    }
    return '<b>' + name + ' closed</b>';
  }
  // "2026-09-30T19:33:00" (Central wall time) -> "Wed 7:33 PM"
  function wall(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(iso || '');
    if (!m) return '';
    var wd = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    return wd + ' ' + clock(+m[4] * 60 + +m[5]);
  }
  function ageMin(isoZ) { var t = Date.parse(isoZ || ''); return isNaN(t) ? Infinity : (Date.now() - t) / 60000; }

  window.FG = { DAYS: DAYS, DAYN: DAYN, money: money, basis: basis, cents8: cents8, summary: summary, parseH: parseH, esc: esc, monthOf: monthOf, num: num };

  // ---------- page ----------
  var strike = document.getElementById('strike');
  if (strike) {
    try { if (localStorage.getItem('fg-struck')) strike.remove(); else localStorage.setItem('fg-struck', '1'); } catch (e) {}
    setTimeout(function () { if (strike.parentNode) strike.remove(); }, 1300);
  }
  var board = document.getElementById('board');
  if (!board) return;
  var $ = function (id) { return document.getElementById(id); };
  function safe(fn) { try { fn(); } catch (e) { if (window.console) console.error(e); } }
  function getJSON(u) {
    return fetch(u + (u.indexOf('?') < 0 ? '?' : '&') + 't=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error(u + ' ' + r.status); return r.json(); });
  }

  var SITE, BIDS, current, segIds = '';

  var FALLBACK_TEL = '715-653-6585';
  function phone() { return (SITE && SITE.business && SITE.business.phone) || FALLBACK_TEL; }
  function callMsg(lead) {
    var m = $('feed-msg'); m.hidden = false;
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
    var feed = feedState(), market = cbotOpen();

    // stamp
    var st = $('stamp'), txt;
    if (feed === 'none') txt = 'Futures unavailable';
    else if (feed === 'down') txt = 'Bids not updating since ' + new Date(Date.parse(BIDS.checked || BIDS.updated)).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
    else txt = 'Futures ' + (BIDS.quote_time ? wall(BIDS.quote_time) : BIDS.dtn_as_of || '') + (market ? '' : ' · CBOT closed');
    $('asof').textContent = txt;
    st.className = 'stamp' + (feed === 'ok' && market ? ' live' : '') + (feed !== 'ok' ? ' warn' : '');
    var bset = SITE.bids.basis_set ? new Date(SITE.bids.basis_set) : null;
    $('basis-set').textContent = bset && !isNaN(bset) ? 'Basis set ' + bset.toLocaleString('en-US', { timeZone: TZ, weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';

    // rows grouped by commodity in first-appearance order
    var groups = [], by = {};
    SITE.bids.rows.forEach(function (r) {
      if (!r.show) return;
      if (!by[r.commodity]) { by[r.commodity] = []; groups.push(r.commodity); }
      by[r.commodity].push(r);
    });
    var html = '', months = [];
    groups.forEach(function (c) {
      html += '<tbody><tr class="grp"><th scope="rowgroup" colspan="4" class="c">' + esc(c) + '</th></tr>';
      by[c].forEach(function (r) {
        var f = BIDS && BIDS.futures && BIDS.futures[r.symbol], b = r.basis ? r.basis[current] : null;
        var hasB = num(b), hasF = f && num(f.price), show = hasB && hasF && feed === 'ok';
        var m = monthOf(r.symbol); if (m && months.indexOf(c + ': ' + m) < 0) months.push(c + ': ' + m);
        var ch = hasF && num(f.change) ? '<span class="' + (f.change > 0 ? 'up' : f.change < 0 ? 'dn' : 'fl') + '" aria-hidden="true">' + cents8(f.change, true) + '</span>' : '';
        var dash = '<span class="pend" aria-label="not available">—</span>';
        html += '<tr><th scope="row" class="c sub">' + esc(r.label) + '</th>'
          + '<td class="cash">' + (show ? '$' + money(f.price + b) : dash) + '</td>'
          + '<td>' + (hasB ? basis(b) : dash) + '</td>'
          + '<td class="fut"' + (hasF ? ' aria-label="' + esc(m + ' futures ' + cents8Words(f.price) + (num(f.change) ? ', ' + cents8Words(f.change, true) : '')) + '"' : '') + '>'
          + (hasF ? '<span aria-hidden="true">' + cents8(f.price) + '</span>' + ch : dash) + '</td></tr>';
      });
      html += '</tbody>';
    });
    var table = board.parentNode;
    [].slice.call(table.querySelectorAll('tbody')).forEach(function (t) { t.remove(); });
    if (!html) html = '<tbody><tr><td colspan="4" class="pend">No bids posted. Call ' + esc(phone()) + '.</td></tr></tbody>';
    table.insertAdjacentHTML('beforeend', html);
    board = table.querySelector('tbody');

    if (feed === 'ok') { $('feed-msg').hidden = true; $('feed-msg').innerHTML = ''; }
    else callMsg('Cash prices are hidden until the futures feed is back.');
    $('bids-note').textContent = 'Cash = CBOT futures + basis, $/bu. ' + (months.length ? months.join(', ') + ' futures. ' : '') + (SITE.bids.footnote || '');
  }

  function render() {
    var biz = SITE.business, tel = (biz.phone || '').replace(/\D/g, '');
    safe(function () {
      document.querySelectorAll('[data-tel]').forEach(function (a) { a.href = 'tel:' + tel; });
      var call = document.querySelector('.call');
      if (call) call.innerHTML = esc(biz.phone) + '<span><span class="vh">, </span>' + esc(biz.phone_note) + '</span>';
    });
    safe(function () { $('notices').innerHTML = (SITE.notices || []).filter(Boolean).map(function (n) { return '<li>' + esc(n) + '</li>'; }).join(''); });
    safe(function () {
      var withH = SITE.locations.filter(function (l) { return l.hours; }), main = withH[0];
      if (!main) return;
      $('when').innerHTML = esc(summary(main.hours)) + '<small>' + esc(main.name) + '. ' + withH.slice(1).map(function (l) { return esc(l.name) + ' ' + esc(summary(l.hours, ', ')); }).join('. ') + '.</small>';
    });
    safe(function () {
      $('loc-list').innerHTML = SITE.locations.map(function (l) {
        var s = l.hours ? summary(l.hours) : '', note = l.note && s.toLowerCase().indexOf(l.note.toLowerCase()) < 0 ? l.note : '';
        return '<li><b>' + esc(l.name) + '</b><span>' + [l.address, s, note].filter(Boolean).map(esc).join(' · ') + '</span></li>';
      }).join('');
    });
    safe(function () {
      var t = SITE.lime.towns || [];
      $('lime-text').innerHTML = (SITE.lime.taking_orders ? 'Taking orders. ' : 'Not taking orders right now. ')
        + (t.length ? 'Spreading in <em>' + t.slice(0, -1).map(esc).join(', ') + '</em>' + (t.length > 1 ? ' and ' : '') + '<em>' + esc(t[t.length - 1]) + '.</em>' : '');
    });
    safe(function () { if (/^https:\/\//.test(SITE.portal_url || '')) $('portal').href = SITE.portal_url; });
    safe(function () {
      var bidLocs = SITE.locations.filter(function (l) { return l.bids; }), ids = bidLocs.map(function (l) { return l.id; }).join('|');
      if (!bidLocs.some(function (l) { return l.id === current; })) current = bidLocs.length ? bidLocs[0].id : null;
      var seg = $('seg');
      if (ids !== segIds) { // rebuild only when the location list changes, so keyboard focus survives refreshes
        segIds = ids;
        seg.innerHTML = bidLocs.map(function (l) { return '<button type="button" data-id="' + esc(l.id) + '">' + esc(l.name) + '</button>'; }).join('');
        seg.querySelectorAll('button').forEach(function (b) { b.onclick = function () { current = b.getAttribute('data-id'); renderBoard(); paintSeg(); }; });
      }
      paintSeg();
    });
    try { renderBoard(); } catch (e) { if (window.console) console.error(e); callMsg('Bids are not showing right now.'); }
  }
  function paintSeg() { $('seg').querySelectorAll('button').forEach(function (x) { x.setAttribute('aria-pressed', String(x.getAttribute('data-id') === current)); }); }

  var failedAt = null;
  function load() {
    return Promise.all([getJSON('data/site.json'), getJSON('data/bids.json').catch(function () { return BIDS || null; })])
      .then(function (r) { SITE = r[0]; BIDS = r[1]; failedAt = null; render(); })
      .catch(function () {
        if (SITE) { try { renderBoard(); } catch (e) { callMsg('Bids are not showing right now.'); } return; } // keep the last good board on a failed refresh
        callMsg('Bids are not loading.');
      });
  }
  load();
  setInterval(function () { if (!document.hidden) load(); }, 5 * 60 * 1000);
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
              + '<div class="wx-hr">' + h + '</div><ul class="wx-days">' + dl + '</ul>'
              + (radar ? '<div class="wx-radar"><img alt="Radar loop, ' + esc(radar) + '" loading="lazy" decoding="async" src="https://radar.weather.gov/ridge/standard/' + esc(radar) + '_loop.gif" onerror="this.parentNode.remove()"></div>' : '')
              + '<p class="wx-cap"><span>National Weather Service, ' + esc(pt.gridId) + ' office' + (radar ? ' &middot; radar ' + esc(radar) : '') + '</span><a href="' + NWS + '" target="_blank" rel="noopener">Full forecast &rarr;</a></p>';
          });
      });
    }).catch(function () {
      el.className = 'wx-err';
      el.innerHTML = 'Forecast is not loading right now. <a href="' + NWS + '" target="_blank" rel="noopener">Open the NWS forecast for Thorp &rarr;</a>';
    });
  })();
})();
