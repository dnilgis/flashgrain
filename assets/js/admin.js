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
  function dtnFor(locId, row) {
    var list = BIDS && BIDS.dtn && BIDS.dtn[locId];
    if (!Array.isArray(list)) return null;
    var hits = list.filter(function (d) { return d.symbol === row.symbol; });
    return hits.filter(function (d) { return d.label === row.label; })[0] || (hits.length === 1 ? hits[0] : null);
  }
  function bidLocs(s) { return (s || S).locations.filter(function (l) { return l.bids; }); }

  // ---------- connect ----------
  ['repo', 'branch'].forEach(function (k) { var v = stored('fg-' + k); if (v) $(k).value = v; });
  var t = stored('fg-token'); if (t) { $('token').value = t; $('remember').checked = true; }
  $('forget').onclick = function () { store('fg-token', null); $('token').value = ''; $('remember').checked = false; status('Key removed from this device.'); };

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
        hoursCache = {}; draw(); $('editor').hidden = false; setDirty(false);
        status('Loaded. Cash previews use futures from ' + (BIDS && BIDS.quote_time ? BIDS.quote_time.replace('T', ' ').slice(0, 16) + ' Central' : 'the last harvest')
          + (BIDS && BIDS.futures_source && BIDS.futures_source !== 'dtn' ? ' (backup feed: ' + BIDS.futures_source + ', because DTN was down)' : '') + '.');
      }).catch(function (e) {
        status(e.status === 401 ? 'Key rejected. Check it was copied whole and has not expired.'
          : e.status === 404 ? 'Repo or file not found, or the key has no access to this repo.'
          : 'Load failed: ' + e.message, true);
      });
  };

  // ---------- draw ----------
  function drawBids() {
    var locs = bidLocs();
    var h = '<thead><tr><th>Show</th><th>Delivery</th>'
      + locs.map(function (l) { return '<th>' + esc(l.name) + ' basis</th>'; }).join('')
      + locs.map(function (l) { return '<th>' + esc(l.name) + ' cash</th>'; }).join('')
      + '<th>DTN basis</th><th>Commodity</th><th>Futures</th><th><span class="vh">Move or remove</span></th></tr></thead><tbody>';
    S.bids.rows.forEach(function (r, i) {
      var f = BIDS && BIDS.futures && BIDS.futures[r.symbol];
      h += '<tr data-i="' + i + '"><td><input type="checkbox" data-f="show" aria-label="Show ' + esc(r.commodity + ' ' + r.label) + '"' + (r.show ? ' checked' : '') + '></td>'
        + '<td><input class="lab" data-f="label" value="' + esc(r.label) + '" aria-label="Delivery label"><span class="ref com">' + esc(r.commodity) + '</span></td>'
        + locs.map(function (l) { var b = r.basis && r.basis[l.id]; return '<td><input class="num" type="text" inputmode="text" autocomplete="off" spellcheck="false" placeholder="-0.60" data-b="' + esc(l.id) + '" aria-label="' + esc(l.name + ' basis, ' + r.commodity + ' ' + r.label) + '" value="' + (FG.num(b) ? b.toFixed(2) : '') + '"></td>'; }).join('')
        + locs.map(function (l) { var b = r.basis && r.basis[l.id]; return '<td class="prev" data-p="' + esc(l.id) + '">' + (f && FG.num(b) ? FG.money(f.price + b) : '—') + '</td>'; }).join('')
        + '<td class="ref">' + locs.map(function (l) { var d = dtnFor(l.id, r); return d ? FG.basis(d.basis) : '—'; }).join(' / ') + '</td>'
        + '<td><input class="lab" data-f="commodity" value="' + esc(r.commodity) + '" list="coms" aria-label="Commodity"></td>'
        + '<td><input class="sym" data-f="symbol" value="' + esc(r.symbol) + '" aria-label="Futures symbol"><span class="ref">' + (f ? FG.cents8(f.price) : 'no quote') + '</span></td>'
        + '<td class="acts"><button class="a-btn sm" data-a="up" type="button" aria-label="Move up">↑</button><button class="a-btn sm" data-a="dn" type="button" aria-label="Move down">↓</button><button class="a-btn sm" data-a="rm" type="button" aria-label="Remove row">✕</button></td></tr>';
    });
    $('bids-t').innerHTML = h + '</tbody>';
    $('fut-asof').textContent = 'Basis is almost always negative: type the minus. Futures symbols: @C corn, @S soybeans; month letter Z Dec, X Nov, H Mar, K May, N Jul, U Sep; the digit is the year (6 = 2026).';
  }

  function drawHours() {
    $('hours').innerHTML = S.locations.filter(function (l) { return l.hours; }).map(function (l) {
      return '<div class="a-hrs" data-loc="' + esc(l.id) + '"><h3>' + esc(l.name) + '</h3>' + FG.DAYS.map(function (d) {
        var p = FG.parseH(l.hours[d]), mode = p.o != null ? 'open' : p;
        var tm = function (m) { return m == null ? '' : ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + m % 60).slice(-2); };
        return '<div class="a-day" data-d="' + d + '"><b>' + FG.DAYN[d] + '</b><select aria-label="' + esc(l.name + ' ' + FG.DAYN[d]) + '">'
          + ['open', 'call', 'closed'].map(function (m) { return '<option value="' + m + '"' + (m === mode ? ' selected' : '') + '>' + { open: 'Open', call: 'Call ahead', closed: 'Closed' }[m] + '</option>'; }).join('')
          + '</select><input type="time" aria-label="opens" value="' + tm(p.o) + '"' + (mode === 'open' ? '' : ' disabled') + '><input type="time" aria-label="closes" value="' + tm(p.c) + '"' + (mode === 'open' ? '' : ' disabled') + '></div>';
      }).join('') + '</div>';
    }).join('');
    $('hours').querySelectorAll('select').forEach(function (sel) {
      sel.onchange = function () {
        var ins = sel.parentNode.querySelectorAll('input');
        ins.forEach(function (i) { i.disabled = sel.value !== 'open'; });
        if (sel.value === 'open' && !ins[0].value) { ins[0].value = '08:00'; ins[1].value = '17:00'; }
      };
    });
  }

  function drawLocs() {
    $('locs').innerHTML = S.locations.map(function (l, i) {
      return '<div class="a-loc" data-i="' + i + '"><div class="a-grid">'
        + '<label>Name<input data-f="name" value="' + esc(l.name) + '"></label>'
        + '<label>Address<input data-f="address" value="' + esc(l.address) + '"></label>'
        + '<label>Map pin (lat, long)<input data-f="pin" value="' + esc(l.pin || '') + '" placeholder="optional, e.g. 44.944867,-90.835861" inputmode="decimal"></label>'
        + '<label class="wide">Note<input data-f="note" value="' + esc(l.note) + '"></label></div>'
        + '<label class="a-check"><input type="checkbox" data-f="bids"' + (l.bids ? ' checked' : '') + '> Posts bids (gets a tab and a basis column)</label>'
        + '<label class="a-check"><input type="checkbox" data-f="hashours"' + (l.hours ? ' checked' : '') + '> Has hours</label></div>';
    }).join('');
  }

  function drawRefs() {
    $('refs-admin').innerHTML = (S.references || []).map(function (r, i) {
      return '<div class="a-loc" data-r="' + i + '"><label class="a-check"><input type="checkbox" data-f="show"' + (r.show ? ' checked' : '') + '> Show ' + esc(r.name) + ' (' + esc(r.place) + ') ' + esc(r.commodity.toLowerCase()) + '</label>'
        + '<div class="a-grid"><label>Location name on their board<input data-f="location" value="' + esc(r.location || '') + '" placeholder="only needed if their board lists several"></label></div>'
        + '<p class="a-help" data-st="' + esc(r.id) + '">Checking\u2026</p></div>';
    }).join('');
    (S.references || []).forEach(function (r) {
      fetch('../data/refs/' + encodeURIComponent(r.id) + '.json?t=' + Date.now(), { cache: 'no-store' })
        .then(function (x) { if (!x.ok) throw 0; return x.json(); })
        .then(function (d) {
          var el = document.querySelector('[data-st="' + r.id + '"]'), when = function (t) { return new Date(t).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }); };
          if (!el) return;
          var ok = d.rows && d.rows.length && d.checked ? d.rows.length + ' rows, last read ' + when(d.checked) + '.' : 'Never read.';
          var bad = d.error && (!d.checked || d.error_at > d.checked) ? ' Last try ' + when(d.error_at) + ' failed: ' + d.error : '';
          el.textContent = ok + bad;
        })
        .catch(function () { var el = document.querySelector('[data-st="' + r.id + '"]'); if (el) el.textContent = 'Not read yet. If this stays, check the harvester log in the Actions tab.'; });
    });
  }

  function draw() {
    drawBids(); drawHours(); drawLocs(); drawRefs();
    $('notices').value = (S.notices || []).join('\n');
    $('lime-open').checked = !!S.lime.taking_orders;
    $('lime-towns').value = (S.lime.towns || []).join(', ');
    $('phone').value = S.business.phone; $('phone-note').value = S.business.phone_note; $('email').value = S.business.email;
    $('portal').value = S.portal_url || ''; $('footnote').value = S.bids.footnote || '';
  }

  function readHours(D, flag) {
    $('hours').querySelectorAll('.a-hrs').forEach(function (div) {
      var l = D.locations.filter(function (x) { return x.id === div.dataset.loc; })[0];
      if (!l || !l.hours) return;
      div.querySelectorAll('.a-day').forEach(function (row) {
        var sel = row.querySelector('select'), ins = row.querySelectorAll('input');
        if (sel.value !== 'open') { l.hours[row.dataset.d] = sel.value; return; }
        if (!ins[0].value || !ins[1].value || ins[0].value >= ins[1].value) { flag(row, l.name + ' ' + FG.DAYN[row.dataset.d] + ': opening time must be before closing time.'); return; }
        l.hours[row.dataset.d] = ins[0].value + '-' + ins[1].value;
      });
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

    var locIds = bidLocs(D).map(function (l) { return l.id; }), rows = [];
    $('bids-t').querySelectorAll('tbody tr').forEach(function (tr) {
      var r = clone(S.bids.rows[+tr.dataset.i]);
      r.show = tr.querySelector('[data-f=show]').checked;
      r.commodity = tr.querySelector('[data-f=commodity]').value.trim();
      r.label = tr.querySelector('[data-f=label]').value.trim();
      var sym = tr.querySelector('[data-f=symbol]'); r.symbol = sym.value.trim().toUpperCase();
      var want = PREFIX[r.commodity.toLowerCase()];
      if (!/^@[A-Z]{1,3}\d[FGHJKMNQUVXZ]$/.test(r.symbol)) flag(sym, 'Futures symbol "' + r.symbol + '" is not in the form @C6Z.');
      else if (want && r.symbol.indexOf(want) !== 0) flag(sym, r.commodity + ' ' + r.label + ': symbol ' + r.symbol + ' is not a ' + r.commodity.toLowerCase() + ' contract (' + want + '...).');
      if (!r.commodity) flag(tr.querySelector('[data-f=commodity]'), 'A bid row has no commodity.');
      if (!r.label) flag(tr.querySelector('[data-f=label]'), 'A bid row has no delivery label.');
      r.basis = r.basis || {};
      tr.querySelectorAll('[data-b]').forEach(function (inp) {
        var v = inp.value.trim(), id = inp.dataset.b;
        if (v === '') { delete r.basis[id]; if (r.show && locIds.indexOf(id) >= 0) flag(inp, r.commodity + ' ' + r.label + ': basis is empty but the row is shown.'); return; }
        var n = parseBasis(v);
        if (!FG.num(n)) { flag(inp, 'Basis "' + v + '" is not a number.'); return; }
        if (Math.abs(n) > 3) { flag(inp, 'Basis "' + v + '" is outside -3.00 to +3.00.'); return; }
        r.basis[id] = n;
      });
      rows.push(r);
    });
    D.bids.rows = rows;
    D.bids.footnote = $('footnote').value.trim();
    $('refs-admin').querySelectorAll('[data-r]').forEach(function (div) {
      var r = D.references[+div.dataset.r];
      r.show = div.querySelector('[data-f=show]').checked;
      r.location = div.querySelector('[data-f=location]').value.trim() || null;
    });
    D.notices = $('notices').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
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
  $('bids-t').addEventListener('click', function (e) {
    var a = e.target.dataset && e.target.dataset.a; if (!a) return;
    var i = +e.target.closest('tr').dataset.i;
    if (a === 'rm' && !confirm('Remove ' + S.bids.rows[i].commodity + ' ' + S.bids.rows[i].label + '?')) return;
    apply(function () {
      var R = S.bids.rows;
      if (a === 'rm') R.splice(i, 1);
      if (a === 'up' && i > 0) R.splice(i - 1, 0, R.splice(i, 1)[0]);
      if (a === 'dn' && i < R.length - 1) R.splice(i + 1, 0, R.splice(i, 1)[0]);
      drawBids();
    });
  });
  $('bids-t').addEventListener('input', function (e) {
    if (!e.target.dataset.b && e.target.dataset.f !== 'symbol') return;
    var tr = e.target.closest('tr'), sym = tr.querySelector('[data-f=symbol]').value.trim().toUpperCase(), f = BIDS && BIDS.futures && BIDS.futures[sym];
    tr.querySelectorAll('[data-b]').forEach(function (inp) {
      var n = parseBasis(inp.value), cell = tr.querySelector('[data-p="' + inp.dataset.b + '"]');
      if (cell) cell.textContent = f && FG.num(n) ? FG.money(f.price + n) : '—';
    });
  });
  $('editor').addEventListener('input', function () { setDirty(true); });
  $('editor').addEventListener('change', function () { setDirty(true); });
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  $('add-row').onclick = function () {
    apply(function () {
      var last = S.bids.rows[S.bids.rows.length - 1] || { commodity: 'Corn' };
      S.bids.rows.push({ commodity: last.commodity, label: '', symbol: '', show: false, basis: {} }); drawBids();
    });
  };
  $('copy-dtn').onclick = function () {
    if (!BIDS || !BIDS.dtn) return status('No DTN basis to copy.', true);
    var n = 0;
    $('bids-t').querySelectorAll('tbody tr').forEach(function (tr) {
      var r = S.bids.rows[+tr.dataset.i];
      tr.querySelectorAll('[data-b]').forEach(function (inp) { var d = dtnFor(inp.dataset.b, r); if (d) { inp.value = d.basis.toFixed(2); n++; } });
      tr.querySelector('[data-b]') && tr.querySelector('[data-b]').dispatchEvent(new Event('input', { bubbles: true }));
    });
    setDirty(true); status('Copied ' + n + ' basis values from DTN. Not saved yet.');
  };
  $('locs').addEventListener('change', function (e) {
    if (apply()) { drawBids(); drawHours(); }
    else if (e.target.type === 'checkbox') e.target.checked = !e.target.checked; // fix the other field first
  });

  // ---------- save ----------
  function priceReview(D) {
    var lines = [], warn = [];
    D.bids.rows.forEach(function (r) {
      var o = ORIG.bids.rows.filter(function (x) { return x.symbol === r.symbol && x.label === r.label && x.commodity === r.commodity; })[0];
      var f = BIDS && BIDS.futures && BIDS.futures[r.symbol];
      if (r.show && !f) warn.push(r.commodity + ' ' + r.label + ': no futures quote for ' + r.symbol + ', the site will show a dash.');
      bidLocs(D).forEach(function (l) {
        var b = r.basis[l.id], ob = o && o.basis ? o.basis[l.id] : undefined, d = dtnFor(l.id, r);
        if (r.show && FG.num(b) && b > 0) warn.push(l.name + ' ' + r.commodity + ' ' + r.label + ': basis is POSITIVE (' + FG.basis(b) + ').');
        if (r.show && FG.num(b) && d && Math.abs(b - d.basis) > 0.25) warn.push(l.name + ' ' + r.commodity + ' ' + r.label + ': ' + FG.basis(b) + ' is ' + FG.money(Math.abs(b - d.basis)) + ' away from DTN (' + FG.basis(d.basis) + ').');
        if (FG.num(b) && b !== ob && f) lines.push(l.name + ' ' + r.commodity + ' ' + r.label + ': cash ' + (FG.num(ob) ? FG.money(f.price + ob) : '—') + ' → ' + FG.money(f.price + b) + ' (basis ' + FG.basis(b) + ')');
      });
    });
    return { lines: lines, warn: warn };
  }

  $('save').onclick = function () {
    if (saving) return;
    var c = collect();
    if (c.bad.length) return status(c.bad[0] + (c.bad.length > 1 ? ' (+' + (c.bad.length - 1) + ' more)' : ''), true);
    var D = c.draft, rv = priceReview(D);
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
