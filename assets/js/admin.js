/* Flash Grain admin. Loads data/site.json from GitHub, edits it, saves it back with one commit.
   Needs a GitHub key with Contents: Read and write on this one repo (see README).
   Basis typed here sets the public cash price, so every save shows the price changes and asks first. */
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var FG = window.FG, esc = FG.esc;
  var API = 'https://api.github.com/repos/';
  var PATH = 'data/site.json';
  var S = null, ORIG = null, SHA = null, BIDS = null, dirty = false, saving = false, hoursCache = {};
  var PREFIX = { corn: '@C', soybeans: '@S', wheat: '@W' };

  function status(msg, err, link) {
    [$('status'), $('status2')].forEach(function (e) {
      e.textContent = msg; e.className = 'a-status' + (err ? ' err' : '');
      if (link) { var a = document.createElement('a'); a.href = link; a.target = '_blank'; a.rel = 'noopener'; a.textContent = ' See the change →'; e.appendChild(a); }
    });
  }
  function setDirty(v) { dirty = v; $('dirty').textContent = v ? 'Unsaved changes' : ''; }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function stored(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function b64enc(str) { var b = new TextEncoder().encode(str), s = ''; b.forEach(function (c) { s += String.fromCharCode(c); }); return btoa(s); }
  function b64dec(b64) { var s = atob(b64.replace(/\s/g, '')), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return new TextDecoder().decode(a); }
  function gh(path, opts) {
    opts = opts || {};
    opts.headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + $('token').value.trim(), 'X-GitHub-Api-Version': '2022-11-28' };
    return fetch(API + $('repo').value.trim() + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.message || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function ref() { return '?ref=' + encodeURIComponent($('branch').value.trim()); }
  // "-0.60", "−.6", " -0,60 " -> -0.6 ; anything else -> NaN
  function parseBasis(v) {
    v = String(v).replace(/[−–—]/g, '-').replace(/,/g, '.').replace(/\s+/g, '');
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(v) ? Math.round(Number(v) * 100) / 100 : NaN;
  }
  function bidLocs(s) { return (s || S).locations.filter(function (l) { return l.bids; }); }

  // ---------- connect ----------
  ['repo', 'branch'].forEach(function (k) { var v = stored('fg-' + k); if (v) $(k).value = v; });
  var t = stored('fg-token'); if (t) { $('token').value = t; $('remember').checked = true; }
  $('forget').onclick = function () { store('fg-token', null); $('token').value = ''; $('remember').checked = false; status('Key removed from this device.'); };

  // Futures for previews: the harvester's file first, then agsist's price file, then Ace's board (corn).
  // The site itself only ever uses what the harvester writes; this is so Jeff sees a cash number before saving.
  function loadFutures() {
    FUT = {};
    var MC = { Jan: 'F', Mar: 'H', May: 'K', Jul: 'N', Aug: 'Q', Sep: 'U', Nov: 'X', Dec: 'Z' };
    var ace = fetch('../data/refs/ace.json?t=' + Date.now(), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      (d && d.rows || []).forEach(function (x) { var m = /^(\w{3}) (\d\d) Corn$/.exec(x.futures_month || ''); if (m && MC[m[1]] && FG.num(x.futures)) FUT['@C' + m[2].slice(-1) + MC[m[1]]] = { price: x.futures, from: 'Ace' }; });
    }, function () {});
    var ags = fetch('https://raw.githubusercontent.com/dnilgis/agsist/main/data/prices.json', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
      Object.keys(d && d.quotes || {}).forEach(function (k) { var q = d.quotes[k], m = /^Z([CS])([FHKNQUXZ])(\d\d)\.CBT$/.exec(q && q.ticker || ''); if (m && FG.num(q.close)) FUT['@' + m[1] + m[3].slice(-1) + m[2]] = { price: q.close / 100, from: 'agsist' }; });
    }, function () {});
    return Promise.all([ace, ags]).then(function () { Object.keys(BIDS && BIDS.futures || {}).forEach(function (k) { FUT[k] = BIDS.futures[k]; }); });
  }

  $('load').onclick = function () {
    if (!$('token').value.trim()) return status('Paste your GitHub key first.', true);
    if (dirty && !confirm('You have unsaved changes. Load the saved version and throw them away?')) return;
    store('fg-repo', $('repo').value.trim()); store('fg-branch', $('branch').value.trim());
    store('fg-token', $('remember').checked ? $('token').value.trim() : null);
    status('Loading…');
    Promise.all([gh('/contents/' + PATH + ref()), gh('/contents/data/bids.json' + ref()).catch(function () { return null; })])
      .then(function (r) {
        SHA = r[0].sha; S = JSON.parse(b64dec(r[0].content)); ORIG = clone(S);
        BIDS = r[1] ? JSON.parse(b64dec(r[1].content)) : null;
        hoursCache = {};
        return loadFutures().then(function () { draw(); $('editor').hidden = false; setDirty(false); });
      }).then(function () {
        $('connect').hidden = true; $('change-key').hidden = false; drawChips();
        status('Loaded.');
      }).catch(function (e) {
        status(e.status === 401 ? 'Key rejected. Check it was copied whole and has not expired.'
          : e.status === 404 ? 'Repo or file not found, or the key has no access to this repo.'
          : 'Load failed: ' + e.message, true);
      });
  };

  $('change-key').onclick = function () { $('connect').hidden = !$('connect').hidden; if (!$('connect').hidden) $('token').focus(); };

  // ---------- status strip ----------
  var REFST = {};
  var SRC = { dtn: 'DTN', boards: 'elevator boards', agsist: 'AGSIST', yahoo: 'Yahoo', ace: 'Ace' };
  function chip(cls, html) { return '<li class="' + cls + '">' + html + '</li>'; }
  function drawChips() {
    var out = [], b = BIDS;
    if (b) {
      var src = b.futures_source || 'dtn', age = FG.ageMin(b.checked || b.updated);
      out.push(chip('ok', 'Futures <b>' + esc(src.split('+').map(function (x) { return SRC[x] || x; }).join(' + ')) + '</b>'));
      var t = new Date(Date.parse(b.checked || b.updated)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      out.push(chip(age > 25 ? 'bad' : 'ok', 'Checked <b>' + esc(t) + '</b> · ' + (isFinite(age) ? Math.max(0, Math.round(age)) + ' min ago' : '?')));
    } else out.push(chip('bad', 'Feed <b>no data</b>'));
    out.push(FG.cbotOpen() ? chip('ok', 'CBOT <b>open</b>') : chip('', 'CBOT <b>closed</b>'));
    (S && S.references || []).forEach(function (r) {
      var st = REFST[r.id];
      var nm = esc(r.name.split(' ')[0]);
      out.push(st === true ? chip('ok', nm + ' <b>read</b>') : st === false ? chip('bad', nm + ' <b>failing</b>') : chip('', nm + ' <b>…</b>'));
    });
    $('chips').innerHTML = out.join('');
  }
  setInterval(function () { if (S) drawChips(); }, 60000);

  // ---------- draw ----------
  // ---------- delivery list: every period, a switch each, basis when on ----------
  // Periods: the next 12 calendar months plus Fall of this year and the next two. Futures by the usual rule:
  // the nearest listed contract at or after the delivery month (corn H K N U Z, soybeans F H K N Q U X);
  // Fall = Dec corn / Nov soybeans. Overridable per row under "Edit rows".
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var LISTED = { '@C': { 3: 'H', 5: 'K', 7: 'N', 9: 'U', 12: 'Z' }, '@S': { 1: 'F', 3: 'H', 5: 'K', 7: 'N', 8: 'Q', 9: 'U', 11: 'X' } };
  var CODEMON = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };
  var FUT = {}, CAT = [], SAME = true;
  function contractFor(pfx, y, m) {
    var ms = Object.keys(LISTED[pfx]).map(Number);
    for (var k = 0; k < 2; k++) { var hit = ms.filter(function (x) { return k || x >= m; })[0]; if (hit) return pfx + ((y + k) % 10) + LISTED[pfx][hit]; }
  }
  function nowYM() { var p = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); return p.slice(0, 7); }
  function symName(sym) { var m = /^@[A-Z]+(\d)([A-Z])$/.exec(sym || ''); return m ? MON[CODEMON[m[2]] - 1] + ' ' + (20 + +m[1]) : esc(sym || ''); }
  function buildCatalog() {
    var now = nowYM(), y0 = +now.slice(0, 4), m0 = +now.slice(5, 7), coms = [];
    S.bids.rows.concat([{ commodity: 'Corn' }, { commodity: 'Soybeans' }]).forEach(function (r) { if (coms.indexOf(r.commodity) < 0 && PREFIX[(r.commodity || '').toLowerCase()]) coms.push(r.commodity); });
    var have = {}; S.bids.rows.forEach(function (r) { have[r.commodity + '|' + r.label] = r; });
    var out = [];
    coms.forEach(function (c) {
      var pfx = PREFIX[c.toLowerCase()], list = [];
      for (var k = 0; k < 3; k++) { var y = y0 + k; list.push({ label: 'Fall ' + (y % 100), until: y + '-12', sort: y + '-11b', symbol: pfx + (y % 10) + (pfx === '@C' ? 'Z' : 'X') }); }
      for (var j = 0; j < 12; j++) { var mm = (m0 - 1 + j) % 12 + 1, yy = y0 + Math.floor((m0 - 1 + j) / 12), u = yy + '-' + ('0' + mm).slice(-2); list.push({ label: MON[mm - 1] + ' ' + (yy % 100), until: u, sort: u, symbol: contractFor(pfx, yy, mm) }); }
      list.forEach(function (p) { p.commodity = c; p.key = c + '|' + p.label; p.row = have[p.key] || null; if (p.row) { p.symbol = p.row.symbol || p.symbol; delete have[p.key]; } });
      S.bids.rows.forEach(function (r) { // kept rows with labels the catalog does not generate (custom, or not yet expired)
        var k = r.commodity + '|' + r.label; if (r.commodity !== c || !have[k]) return;
        var u = FG.labelUntil(r.label); if (u && u < now) return; // past: dropped
        list.push({ commodity: c, label: r.label, until: u, sort: u || '9999', symbol: r.symbol, key: k, row: r }); delete have[k];
      });
      list.sort(function (a, b) { return a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0; });
      out = out.concat(list);
    });
    return out;
  }
  function futFor(sym) { return FUT[sym] || null; }
  function drawBids() {
    var locs = bidLocs(); CAT = buildCatalog();
    SAME = locs.length > 1 && S.bids.rows.every(function (r) { var b = r.basis || {}; return locs.every(function (l) { return b[l.id] === b[locs[0].id]; }); });
    $('same-wrap').hidden = locs.length < 2;
    $('same').checked = SAME; $('same-lab').textContent = locs.slice(1).map(function (l) { return l.name; }).join(', ') + ' uses ' + (locs[0] ? locs[0].name : '') + ' basis';
    var h = '', coms = [];
    CAT.forEach(function (p) { if (coms.indexOf(p.commodity) < 0) coms.push(p.commodity); });
    coms.forEach(function (c) {
      var items = CAT.map(function (p, i) { return { p: p, i: i }; }).filter(function (x) { return x.p.commodity === c; });
      h += '<div class="bl-crop"><h3 class="bl-grp" id="g-' + esc(c) + '">' + esc(c) + '</h3>'
        + '<div class="bl-chips" role="group" aria-labelledby="g-' + esc(c) + '">' + items.map(function (x) {
          var on = !!(x.p.row && x.p.row.show);
          return '<label class="chip"><input type="checkbox" id="bl' + x.i + '" data-f="show" data-c="' + x.i + '"' + (on ? ' checked' : '') + '><span>' + esc(x.p.label) + '</span><span class="vh"> ' + esc(c) + ', show on site</span></label>';
        }).join('') + '</div>'
        + '<div class="bl-rows">' + items.map(function (x) {
          var p = x.p, r = p.row || {}, f = futFor(p.symbol);
          return '<div class="bl-row' + (r.show ? ' on' : '') + '" data-c="' + x.i + '">'
            + '<span class="bl-name">' + esc(p.label) + '</span>'
            + '<span class="bl-fut">' + symName(p.symbol) + ' <b>' + (f ? FG.cents8(f.price) : 'no quote') + '</b><input class="sym" data-f="symbol" value="' + esc(p.symbol) + '" aria-label="Futures symbol, ' + esc(c + ' ' + p.label) + '"></span>'
            + '<span class="bl-locs">' + locs.map(function (l, li) {
              var b = r.basis && r.basis[l.id];
              return '<span class="bl-loc' + (li ? ' follow' : '') + '"><span class="bl-ln">' + esc(l.name) + '</span>'
                + '<input class="num" data-b="' + esc(l.id) + '" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="-0.60" value="' + (FG.num(b) ? b.toFixed(2) : '') + '" aria-label="' + esc(l.name + ' basis, ' + c + ' ' + p.label) + '">'
                + '<span class="bl-cash" data-p="' + esc(l.id) + '"></span></span>';
            }).join('') + '</span></div>';
        }).join('') + '<p class="bl-none">Nothing on. Tap a month above to post it.</p></div></div>';
    });
    $('bids-list').innerHTML = h;
    $('bids-list').classList.toggle('same', SAME);
    $('bids-list').querySelectorAll('.bl-row').forEach(previewRow);
    $('fut-asof').textContent = 'Symbol: @C corn, @S soybeans, the year digit (6 = 2026), then the month letter: F Jan, H Mar, K May, N Jul, Q Aug, U Sep, X Nov, Z Dec.';
  }
  function previewRow(row) {
    var p = CAT[+row.dataset.c], sym = (row.querySelector('[data-f=symbol]').value || '').trim().toUpperCase(), f = futFor(sym);
    var first = row.querySelector('[data-b]');
    row.querySelectorAll('.bl-loc').forEach(function (box, li) {
      var inp = box.querySelector('[data-b]'), n = parseBasis(SAME && li ? first.value : inp.value), cell = box.querySelector('.bl-cash');
      cell.textContent = f && FG.num(n) ? '$' + FG.money(f.price + n) : '';
    });
    row.querySelector('.bl-fut b').textContent = f ? FG.cents8(f.price) : 'no quote';
  }
  $('bids-list').addEventListener('change', function (e) {
    if (e.target.dataset.f !== 'show') return;
    var row = $('bids-list').querySelector('.bl-row[data-c="' + e.target.dataset.c + '"]'), on = e.target.checked; row.classList.toggle('on', on);
    if (on) { // put the cursor in an empty basis box
      var inp = row.querySelector('[data-b]');
      previewRow(row); if (!inp.value) inp.focus();
    }
  });
  $('bids-list').addEventListener('input', function (e) { var row = e.target.closest('.bl-row'); if (row) previewRow(row); });
  $('same').onchange = function () { SAME = this.checked; $('bids-list').classList.toggle('same', SAME); $('bids-list').querySelectorAll('.bl-row').forEach(previewRow); setDirty(true); };
  $('edit-rows').onclick = function () {
    var on = !$('bids-list').classList.contains('editing');
    $('bids-list').classList.toggle('editing', on); document.querySelector('.p-bids').classList.toggle('editing', on);
    this.setAttribute('aria-pressed', String(on)); this.textContent = on ? 'Done' : 'Edit contracts';
  };
  function readBids(D, flag) {
    var locIds = bidLocs(D).map(function (l) { return l.id; }), rows = [], order = {};
    $('bids-list').querySelectorAll('.bl-row').forEach(function (row) {
      var p = CAT[+row.dataset.c], show = $('bl' + row.dataset.c).checked;
      var sym = row.querySelector('[data-f=symbol]'), symbol = sym.value.trim().toUpperCase(), want = PREFIX[p.commodity.toLowerCase()];
      var r = p.row ? clone(p.row) : { commodity: p.commodity, label: p.label };
      r.symbol = symbol; r.show = show; r.basis = clone(r.basis || {});
      var ins = row.querySelectorAll('[data-b]'), firstV = ins[0] ? ins[0].value.trim() : '';
      ins.forEach(function (inp, li) {
        var v = SAME && li ? firstV : inp.value.trim(), id = inp.dataset.b;
        if (v === '') { delete r.basis[id]; if (show && locIds.indexOf(id) >= 0) flag(inp, p.commodity + ' ' + p.label + ': turned on but no basis.'); return; }
        var n = parseBasis(v);
        if (!FG.num(n)) { flag(inp, 'Basis "' + v + '" is not a number.'); return; }
        if (Math.abs(n) > 3) { flag(inp, 'Basis "' + v + '" is outside -3.00 to +3.00.'); return; }
        r.basis[id] = n;
      });
      if (show || p.row) {
        if (!/^@[A-Z]{1,3}\d[FGHJKMNQUVXZ]$/.test(symbol)) flag(sym, p.commodity + ' ' + p.label + ': futures symbol "' + symbol + '" is not in the form @C6Z.');
        else if (want && symbol.indexOf(want) !== 0) flag(sym, p.commodity + ' ' + p.label + ': ' + symbol + ' is not a ' + p.commodity.toLowerCase() + ' contract.');
      }
      // keep a row that is on, or one already on file; a period never turned on is not written
      if (show || p.row) { order[p.commodity + '|' + p.label] = p.sort + '|' + (rows.length + 1000); rows.push(r); }
    });
    var cOrder = []; rows.forEach(function (r) { if (cOrder.indexOf(r.commodity) < 0) cOrder.push(r.commodity); });
    rows.sort(function (a, b) {
      var ca = cOrder.indexOf(a.commodity), cb = cOrder.indexOf(b.commodity); if (ca !== cb) return ca - cb;
      var ka = order[a.commodity + '|' + a.label], kb = order[b.commodity + '|' + b.label]; return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    D.bids.rows = rows;
    return locIds;
  }

  // Hours as typed text: "8-5", "7:30-4:30", "8a-12p", "call", "closed". Shown back as "8a–5p" so the reading is visible.
  function hoursToText(v) {
    var p = FG.parseH(v);
    if (p === 'call') return 'Call'; if (p === 'closed') return 'Closed';
    var t = function (m) { var h = Math.floor(m / 60) % 24, mm = m % 60; return (h % 12 || 12) + (mm ? ':' + ('0' + mm).slice(-2) : '') + (h < 12 ? 'a' : 'p'); };
    return t(p.o) + '–' + t(p.c);
  }
  function textToHours(t) {
    t = String(t || '').toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, '').replace(/to/g, '-');
    if (/^(call|callahead|c)$/.test(t)) return 'call';
    if (/^(closed|close|x)$/.test(t)) return 'closed';
    var m = /^(\d{1,2})(?::(\d{2}))?(a|am|p|pm)?-(\d{1,2})(?::(\d{2}))?(a|am|p|pm)?$/.exec(t);
    if (!m) return null;
    var mins = function (h, mm, suf) {
      h = +h; mm = +(mm || 0); if (mm > 59 || h > 24) return NaN;
      if (suf) { if (h > 12 || h === 0) return NaN; return (suf[0] === 'p' ? (h % 12) + 12 : h % 12) * 60 + mm; }
      return h * 60 + mm;
    };
    var o = mins(m[1], m[2], m[3]), c = mins(m[4], m[5], m[6]);
    // bare closing hour at or before the opening hour is afternoon: 8-5 is 8 AM to 5 PM; 8-12 is 8 to noon
    if (!m[6] && +m[4] > 0 && +m[4] < 12 && c <= o) c += 12 * 60;
    if (!(o >= 0 && c > o && c <= 1440)) return null;
    var hh = function (x) { return ('0' + Math.floor(x / 60)).slice(-2) + ':' + ('0' + x % 60).slice(-2); };
    return hh(o) + '-' + hh(c);
  }
  function drawHours() {
    var locs = S.locations.filter(function (l) { return l.hours; });
    $('hours').innerHTML = '<thead><tr><th><span class="vh">Day</span></th>' + locs.map(function (l) { return '<th scope="col">' + esc(l.name) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + FG.DAYS.map(function (d) {
        return '<tr><th scope="row">' + FG.DAYN[d] + '</th>' + locs.map(function (l) {
          return '<td><input data-loc="' + esc(l.id) + '" data-d="' + d + '" value="' + esc(hoursToText(l.hours[d])) + '" aria-label="' + esc(l.name + ' ' + FG.DAYN[d] + ' hours') + '" autocomplete="off" spellcheck="false"></td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
    $('hours').querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('blur', function () { var v = textToHours(inp.value); if (v) inp.value = hoursToText(v); });
    });
  }


  function drawLocs() {
    $('locs').innerHTML = S.locations.map(function (l, i) {
      return '<div class="a-loc" data-i="' + i + '"><h3 class="a-ref-h">' + esc(l.name) + '</h3><div class="a-grid">'
        + '<label>Name<input data-f="name" value="' + esc(l.name) + '"></label>'
        + '<label>Address<input data-f="address" value="' + esc(l.address) + '"></label>'
        + '<label>Map pin (lat, long)<input data-f="pin" value="' + esc(l.pin || '') + '" placeholder="optional, e.g. 44.944867,-90.835861" inputmode="decimal"></label>'
        + '<label class="wide">Note<textarea class="a-short" rows="2" data-f="note">' + esc(l.note) + '</textarea></label></div>'
        + '<label class="a-check"><input type="checkbox" data-f="bids"' + (l.bids ? ' checked' : '') + '> Posts bids (gets a tab and a basis column)</label>'
        + '<label class="a-check"><input type="checkbox" data-f="hashours"' + (l.hours ? ' checked' : '') + '> Has hours</label></div>';
    }).join('');
  }

  function drawRefs() {
    $('refs-admin').innerHTML = (S.references || []).map(function (r, i) {
      return '<div class="a-ref" data-r="' + i + '"><h3 class="a-ref-h">' + esc(r.name) + ' <span>' + esc(r.place) + ' · ' + esc(r.commodity) + '</span></h3>'
        + '<p class="a-help" data-st="' + esc(r.id) + '">Checking…</p>'
        + '<div data-rt="' + esc(r.id) + '"></div>'
        + '<details class="a-mini"><summary>Board setting</summary><label>Location name on their board<input data-f="location" value="' + esc(r.location || '') + '" placeholder="only if their board lists several"></label></details></div>';
    }).join('');
    (S.references || []).forEach(function (r) {
      var el = function () { return document.querySelector('[data-st="' + r.id + '"]'); };
      fetch('../data/refs/' + encodeURIComponent(r.id) + '.json?t=' + Date.now(), { cache: 'no-store' })
        .then(function (x) { if (!x.ok) throw 0; return x.json(); })
        .then(function (d) {
          var when = function (t) { return new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
          var rows = d.rows || [], ok = rows.length && d.checked ? 'Read ' + when(d.checked) + '.' : 'Never read.';
          var bad = d.error && (!d.checked || d.error_at > d.checked) ? ' Last try ' + when(d.error_at) + ' failed: ' + d.error : '';
          if (el()) el().textContent = ok + bad;
          REFST[r.id] = !!(rows.length && !bad); drawChips();
          var box = document.querySelector('[data-rt="' + r.id + '"]'), row = function (x) {
            return '<tr><td>' + esc(x.label) + '</td><td class="prev">' + (FG.num(x.cash) ? '$' + FG.money(x.cash) : '—') + '</td><td>' + (FG.num(x.basis) ? FG.basis(x.basis) : '—') + '</td><td class="ref">' + esc(x.futures_month || '') + '</td></tr>';
          };
          if (box && rows.length) box.innerHTML = '<table class="a-bids a-reft" tabindex="0" aria-label="' + esc(r.name) + ' bids"><thead><tr><th>Delivery</th><th>Cash</th><th>Basis</th><th>Futures</th></tr></thead><tbody>' + rows.slice(0, 4).map(row).join('') + '</tbody></table>'
            + (rows.length > 4 ? '<details class="a-mini"><summary>' + (rows.length - 4) + ' more months</summary><table class="a-bids a-reft" tabindex="0" aria-label="More months"><tbody>' + rows.slice(4).map(row).join('') + '</tbody></table></details>' : '');
        })
        .catch(function () { REFST[r.id] = false; drawChips(); if (el()) el().textContent = 'Not read yet.'; });
    });
  }

  function draw() {
    drawBids(); drawHours(); drawLocs(); drawRefs();
    $('notices').value = (S.notices || []).join('\n');
    $('notice-until').value = S.notice_until || '';
    $('lime-open').checked = !!S.lime.taking_orders;
    $('lime-towns').value = (S.lime.towns || []).join(', ');
    $('phone').value = S.business.phone; $('phone-note').value = S.business.phone_note; $('email').value = S.business.email;
    $('portal').value = S.portal_url || ''; $('footnote').value = S.bids.footnote || '';
  }

  function readHours(D, flag) {
    $('hours').querySelectorAll('input[data-loc]').forEach(function (inp) {
      var l = D.locations.filter(function (x) { return x.id === inp.dataset.loc; })[0];
      if (!l || !l.hours) return;
      var v = textToHours(inp.value);
      if (!v) { flag(inp, l.name + ' ' + FG.DAYN[inp.dataset.d] + ': "' + inp.value + '" is not hours. Type 8-5, call or closed.'); return; }
      l.hours[inp.dataset.d] = v;
    });
  }


  // ---------- read the form into a draft; S is only replaced when the draft is valid ----------
  function collect() {
    var D = clone(S), bad = [];
    document.querySelectorAll('.bad').forEach(function (e) { e.classList.remove('bad'); });
    var flag = function (el, why) { el.classList.add('bad'); bad.push(why); };

    readHours(D, flag);
    $('locs').querySelectorAll('.a-loc').forEach(function (div) {
      var l = D.locations[+div.dataset.i];
      ['name', 'address', 'note', 'pin'].forEach(function (f) { l[f] = div.querySelector('[data-f=' + f + ']').value.trim(); });
      if (l.pin && !/^-?\d{1,3}\.\d+\s*,\s*-?\d{1,3}\.\d+$/.test(l.pin)) flag(div.querySelector('[data-f=pin]'), 'Map pin must look like 44.944867,-90.835861');
      if (!l.name) flag(div.querySelector('[data-f=name]'), 'A location has no name.');
      l.bids = div.querySelector('[data-f=bids]').checked;
      var wantH = div.querySelector('[data-f=hashours]').checked;
      if (!wantH && l.hours) { hoursCache[l.id] = l.hours; l.hours = null; }
      else if (wantH && !l.hours) { l.hours = hoursCache[l.id] || (function () { var h = {}; FG.DAYS.forEach(function (d) { h[d] = 'call'; }); return h; })(); }
    });

    var locIds = readBids(D, flag);
    D.bids.footnote = $('footnote').value.trim();
    $('refs-admin').querySelectorAll('[data-r]').forEach(function (div) {
      var r = D.references[+div.dataset.r];
      var lv = div.querySelector('[data-f=location]').value.trim(); r.location = lv || (r.location === null ? null : ''); // blank stays as loaded
    });
    D.notices = $('notices').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    var nu = $('notice-until').value; if (nu) D.notice_until = nu; else if ('notice_until' in D) D.notice_until = ''; // blank stays as loaded
    D.lime.taking_orders = $('lime-open').checked;
    D.lime.towns = $('lime-towns').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    D.business.phone = $('phone').value.trim(); D.business.phone_note = $('phone-note').value.trim(); D.business.email = $('email').value.trim();
    if (D.business.phone.replace(/\D/g, '').length !== 10) flag($('phone'), 'Phone number needs 10 digits.');
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(D.business.email)) flag($('email'), 'Email address does not look right.');
    D.portal_url = $('portal').value.trim();
    if (!/^https:\/\/\S+$/.test(D.portal_url)) flag($('portal'), 'Portal link must start with https://');
    if (!locIds.length) bad.push('At least one location has to post bids.');
    if (!D.locations.some(function (l) { return l.hours; })) bad.push('At least one location needs hours.');
    return { draft: D, bad: bad };
  }
  function apply(op) {
    var c = collect();
    if (c.bad.length) { status(c.bad[0] + (c.bad.length > 1 ? ' (+' + (c.bad.length - 1) + ' more)' : ''), true); return false; }
    S = c.draft; if (op) op(); setDirty(true);
    // Clear an old error AFTER the current click lands: clearing it now shrinks the sticky save bar between
    // mousedown and mouseup (blur fires 'change' first), the Save button moves, and the click is lost.
    if ($('status2').classList.contains('err')) setTimeout(function () { if (!saving && $('status2').classList.contains('err') && !collect().bad.length) status(''); }, 300);
    return true;
  }

  // ---------- row buttons, live preview, dirty tracking ----------
  $('editor').addEventListener('input', function () { setDirty(true); });
  $('editor').addEventListener('change', function () { setDirty(true); });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  $('locs').addEventListener('change', function (e) {
    if (apply()) { drawBids(); drawHours(); }
    else if (e.target.type === 'checkbox') e.target.checked = !e.target.checked; // fix the other field first
  });

  // ---------- save ----------
  function priceReview(D) {
    var lines = [], warn = [];
    D.bids.rows.forEach(function (r) {
      var o = ORIG.bids.rows.filter(function (x) { return x.symbol === r.symbol && x.label === r.label && x.commodity === r.commodity; })[0];
      var f = futFor(r.symbol);
      if (r.show && !f) warn.push(r.commodity + ' ' + r.label + ': no futures quote for ' + r.symbol + ' yet. The site shows a dash until the next check finds one.');
      bidLocs(D).forEach(function (l) {
        var b = r.basis[l.id], ob = o && o.basis ? o.basis[l.id] : undefined;
        if (r.show && FG.num(b) && b > 0) warn.push(l.name + ' ' + r.commodity + ' ' + r.label + ': basis is POSITIVE (' + FG.basis(b) + ').');
        // typo guard: a basis that jumps more than 25 cents from what was saved
        if (r.show && FG.num(b) && FG.num(ob) && Math.abs(b - ob) > 0.25) warn.push(l.name + ' ' + r.commodity + ' ' + r.label + ': ' + FG.basis(b) + ' is ' + FG.money(Math.abs(b - ob)) + ' away from the saved ' + FG.basis(ob) + '.');
        if (FG.num(b) && b !== ob && f) lines.push(l.name + ' ' + r.commodity + ' ' + r.label + ': cash ' + (FG.num(ob) ? FG.money(f.price + ob) : '—') + ' → ' + FG.money(f.price + b) + ' (basis ' + FG.basis(b) + ')');
      });
    });
    return { lines: lines, warn: warn };
  }

  $('save').onclick = function () {
    if (saving) return;
    var c = collect();
    if (c.bad.length) return status(c.bad[0] + (c.bad.length > 1 ? ' (+' + (c.bad.length - 1) + ' more)' : ''), true);
    var D = c.draft;
    if (JSON.stringify(D) === JSON.stringify(ORIG)) { setDirty(false); return status('Nothing to save. The site already has this version.'); }
    var rv = priceReview(D);
    if (rv.warn.length || rv.lines.length) {
      var msg = (rv.warn.length ? 'CHECK THESE FIRST:\n' + rv.warn.join('\n') + '\n\n' : '') + (rv.lines.length ? 'Price changes going live:\n' + rv.lines.join('\n') + '\n\n' : '') + 'Save to the site?';
      if (!confirm(msg)) return status('Not saved.');
    }
    if (rv.lines.length) D.bids.basis_set = new Date().toISOString();
    var body = JSON.stringify(D, null, 2) + '\n';
    if (body === JSON.stringify(ORIG, null, 2) + '\n') { setDirty(false); return status('Nothing to save. The site already has this version.'); }
    saving = true; $('save').disabled = true; $('editor').inert = true; status('Saving…');
    gh('/contents/' + PATH, { method: 'PUT', body: JSON.stringify({ message: 'admin: update site.json', content: b64enc(body), sha: SHA, branch: $('branch').value.trim() }) })
      .then(function (j) {
        SHA = j.content.sha; S = D; ORIG = clone(D); setDirty(false); drawBids();
        status('Saved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + '. The site shows it in 1–3 minutes; pages already open update within 5.', false, j.commit && j.commit.html_url);
      })
      .catch(function (e) {
        if (e.status !== 409) return status(e.status === 403 || e.status === 404 ? 'Key cannot write to this repo. It needs Contents: Read and write.' : 'Save failed: ' + e.message, true);
        return gh('/contents/' + PATH + ref()).then(function (cur) {
          if (b64dec(cur.content) === body) { SHA = cur.sha; S = D; ORIG = clone(D); setDirty(false); return status('Saved.'); }
          status('Someone saved a different version since you loaded. Your edits are still on this page. Note them, press Load, and enter them again.', true);
        });
      })
      .catch(function (e) { status('Save failed: ' + e.message + '. Your edits are still on this page.', true); })
      .then(function () { saving = false; $('save').disabled = false; $('editor').inert = false; });
  };
  $('download').onclick = function () {
    var c = collect(); if (c.bad.length) return status(c.bad[0], true);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(c.draft, null, 2) + '\n'], { type: 'application/json' }));
    a.download = 'site.json'; a.click();
  };
})();
