/* Flash Grain admin. Loads data/site.json from GitHub, edits it, saves it back with one commit.
   Needs a GitHub key with Contents: Read and write on this one repo (steps in the panel and the README).
   Basis typed here sets the public cash price, so every save shows the price changes and asks first.
   FGA below holds the pure rules (no page, no network) so test/admin-core.test.mjs can run them in node. */
var FGA = (function () {
  // "-0.60", "−.6", " -0,60 " -> -0.6 ; anything else -> NaN
  function parseBasis(v) {
    v = String(v).replace(/[−–—]/g, '-').replace(/,/g, '.').replace(/\s+/g, '');
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(v) ? Math.round(Number(v) * 100) / 100 : NaN;
  }
  // Hours as typed: "8-5", "7:30-4:30", "8a-12p", "call", "closed" -> "08:00-17:00" / "call" / "closed" / null.
  function hoursParts(t) {
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
    var o = mins(m[1], m[2], m[3]), c = mins(m[4], m[5], m[6]), shifted = false;
    // bare closing hour at or before the opening hour is afternoon: 8-5 is 8 AM to 5 PM; 8-12 is 8 to noon
    if (!m[6] && +m[4] > 0 && +m[4] < 12 && c <= o) { c += 12 * 60; shifted = true; }
    return { o: o, c: c, bareClose: !m[6], openPM: !!(m[3] && m[3][0] === 'p'), shifted: shifted };
  }
  function hhmm(x) { return ('0' + Math.floor(x / 60)).slice(-2) + ':' + ('0' + x % 60).slice(-2); }
  function textToHours(t) {
    var p = hoursParts(t);
    if (p === null || typeof p === 'string') return p;
    if (!(p.o >= 0 && p.c > p.o && p.c <= 1440)) return null;
    return hhmm(p.o) + '-' + hhmm(p.c);
  }
  // "7-9", "6-10": a bare closing hour that lands 4 hours or less after opening, still in the morning. The documented
  // rule reads it as a short morning; it is more often an evening close typed without the PM. Ask, never guess.
  function hoursAsk(t) {
    var p = hoursParts(t);
    if (!p || typeof p === 'string' || !p.bareClose || p.shifted || p.openPM) return null;
    if (!(p.o >= 0 && p.c > p.o && p.c < 720 && p.c - p.o <= 240 && p.c + 720 <= 1440)) return null;
    return { am: hhmm(p.o) + '-' + hhmm(p.c), pm: hhmm(p.o) + '-' + hhmm(p.c + 720) };
  }
  // 420 -> "7 AM", 750 -> "12:30 PM", 1440 -> "midnight"
  function clockWords(m) {
    if (m === 1440 || m === 0) return 'midnight';
    var h = Math.floor(m / 60), mm = m % 60;
    return (h % 12 || 12) + (mm ? ':' + ('0' + mm).slice(-2) : '') + (h < 12 ? ' AM' : ' PM');
  }
  function hoursWords(v) { // "07:00-21:00" -> "7 AM to 9 PM"
    var m = /^(\d\d):(\d\d)-(\d\d):(\d\d)$/.exec(v || '');
    return m ? clockWords(+m[1] * 60 + +m[2]) + ' to ' + clockWords(+m[3] * 60 + +m[4]) : v === 'call' ? 'Call' : v === 'closed' ? 'Closed' : '';
  }
  // ---------- money words ----------
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function r2(v) { return Math.round(v * 100 + (v < 0 ? -1e-9 : 1e-9)) / 100; }
  function money(v) { return r2(v).toFixed(2); }
  function basisTxt(v) { var r = r2(v); return (r < 0 ? '-' : r > 0 ? '+' : '') + Math.abs(r).toFixed(2); }
  function centsTxt(d) { var c = Math.round(Math.abs(d) * 100); return c === 1 ? '1 cent' : c + ' cents'; }

  // ---------- contracts ----------
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var CODEMON = { F: 1, G: 2, H: 3, J: 4, K: 5, M: 6, N: 7, Q: 8, U: 9, V: 10, X: 11, Z: 12 };
  var LISTED = { '@C': { 3: 'H', 5: 'K', 7: 'N', 9: 'U', 12: 'Z' }, '@S': { 1: 'F', 3: 'H', 5: 'K', 7: 'N', 8: 'Q', 9: 'U', 11: 'X' } };
  function symName(sym) { var m = /^@[A-Z]+(\d)([A-Z])$/.exec(sym || ''); return m && CODEMON[m[2]] ? MON[CODEMON[m[2]] - 1] + ' ' + (20 + +m[1]) : String(sym || ''); }
  // "Fall 26" -> month number 2026*12+11 (Nov, harvest), "Oct 26" -> 2026*12+10; else NaN. For "nearest month" only.
  function labelMonth(label) {
    var m = /^\s*([a-z]{3})[a-z]*\.?\s+'?(\d{2}|\d{4})\s*$/i.exec(label || '');
    if (!m) return NaN;
    var y = m[2].length === 2 ? 2000 + +m[2] : +m[2], k = m[1].toLowerCase();
    var mo = k === 'fal' ? 11 : MON.map(function (x) { return x.toLowerCase(); }).indexOf(k) + 1;
    return mo ? y * 12 + mo : NaN;
  }

  // ---------- contract calendar: first notice (FND) and last trade (LTD), from data/cbot.json ----------
  // cal: { holidays: ["YYYY-MM-DD"], contracts: { "@S6X": { fnd, ltd } } }. A contract the file lacks falls back to
  // the CME rule: FND = last business day of the month before; LTD = business day before the 15th.
  function symYM(sym) { var m = /^(@[A-Z]+)(\d)([FGHJKMNQUVXZ])$/.exec(sym || ''); return m ? { pfx: m[1], y: 2020 + +m[2], m: CODEMON[m[3]] } : null; }
  function iso(y, m, d) { var t = new Date(Date.UTC(y, m - 1, d)); return t.toISOString().slice(0, 10); }
  function isBiz(d, hol) { var w = new Date(d + 'T00:00:00Z').getUTCDay(); return w > 0 && w < 6 && (hol || []).indexOf(d) < 0; }
  function addDays(d, n) { var t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
  function contractDates(sym, cal) {
    var c = cal && cal.contracts && cal.contracts[sym];
    if (c && c.fnd && c.ltd) return { fnd: c.fnd, ltd: c.ltd };
    var p = symYM(sym), hol = cal && cal.holidays || [];
    if (!p) return null;
    var ltd = iso(p.y, p.m, 14); while (!isBiz(ltd, hol)) ltd = addDays(ltd, -1);
    var fnd = addDays(iso(p.y, p.m, 1), -1); while (!isBiz(fnd, hol)) fnd = addDays(fnd, -1);
    return { fnd: fnd, ltd: ltd };
  }
  function bizBetween(a, b, hol) { var n = 0; for (var d = addDays(a, 1); d <= b; d = addDays(d, 1)) if (isBiz(d, hol)) n++; return n; }
  // null, or { level: 'near' (5 business days or less before FND) | 'notice' (FND to LTD) | 'expired' (after LTD) }
  function rollState(sym, today, cal) {
    var d = contractDates(sym, cal); if (!d) return null;
    var lv = today > d.ltd ? 'expired' : today >= d.fnd ? 'notice' : bizBetween(today, d.fnd, cal && cal.holidays) <= 5 ? 'near' : null;
    return lv ? { level: lv, fnd: d.fnd, ltd: d.ltd } : null;
  }
  // the next listed contract of the same crop: @S6X -> @S7F, @C6Z -> @C7H
  function nextContract(sym) {
    var p = symYM(sym), L = p && LISTED[p.pfx]; if (!L) return null;
    var ms = Object.keys(L).map(Number).sort(function (a, b) { return a - b; }), hit = ms.filter(function (x) { return x > p.m; })[0], y = p.y;
    if (!hit) { hit = ms[0]; y++; }
    return p.pfx + (y % 10) + L[hit];
  }
  // new basis that keeps cash where it is: basis + (old futures - new futures)
  function rollBasis(b, oldF, newF) { return isNum(b) && isNum(oldF) && isNum(newF) ? r2(b + oldF - newF) : null; }
  function dayWords(d) { var t = new Date(d + 'T12:00:00Z'); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][t.getUTCDay()] + ' ' + MON[t.getUTCMonth()] + ' ' + t.getUTCDate(); }

  // ---------- nearby bids next to Jeff's own row ----------
  // refs: [{ name, commodity, rows: [{label: "Oct 2026", cash, basis, futures_month: "Dec 26 Corn"}] }].
  // The same delivery month first; Fall falls back to the first month on the same futures contract.
  var MC = { Jan: 'F', Mar: 'H', May: 'K', Jul: 'N', Aug: 'Q', Sep: 'U', Nov: 'X', Dec: 'Z' };
  function refSym(fm) { var m = /^(\w{3}) (\d\d) (Corn|Soybeans)$/.exec(fm || ''); return m && MC[m[1]] ? (m[3] === 'Corn' ? '@C' : '@S') + m[2].slice(-1) + MC[m[1]] : ''; }
  function nearbyFor(row, refs) {
    var out = [], me = labelMonth(row.label);
    (refs || []).forEach(function (ref) {
      if (!ref || ref.commodity !== row.commodity) return;
      var rows = (ref.rows || []).filter(function (x) { return isNum(x.cash); });
      var hit = rows.filter(function (x) { return labelMonth(x.label) === me && refSym(x.futures_month) === row.symbol; })[0]
        || rows.filter(function (x) { return labelMonth(x.label) === me; })[0]
        || rows.filter(function (x) { return refSym(x.futures_month) === row.symbol; })[0];
      if (hit) out.push({ name: ref.name, label: hit.label, cash: hit.cash, basis: hit.basis });
    });
    return out;
  }

  // ---------- price review: every cash change, and every number that looks like a typo ----------
  // D, O: new and saved site.json. locs: [{id, name}] that post bids. same: Granton uses Thorp basis.
  // fut(sym) -> futures price or null. Returns { lines: [cash changes], warn: [check these], off: [rows taken down] }.
  var JUMP = 0.25;
  function review(D, O, locs, same, fut) {
    var lines = [], warn = [], off = [];
    var key = function (r) { return r.commodity + '|' + r.label; };
    var saved = {}; (O.bids.rows || []).forEach(function (r) { saved[key(r)] = r; });
    var useLocs = same && locs.length > 1 ? [locs[0]] : locs;
    var locName = function (l) { return same && locs.length > 1 ? locs.map(function (x) { return x.name; }).join(' and ') : l.name; };
    // nearest month of the same crop that was showing, with a basis for this yard
    var nearest = function (r, lid) {
      var me = labelMonth(r.label), best = null, bd = Infinity;
      (O.bids.rows || []).forEach(function (o) {
        if (o.commodity !== r.commodity || !o.show || key(o) === key(r) || !isNum(o.basis && o.basis[lid])) return;
        var d = Math.abs(labelMonth(o.label) - me); if (!isFinite(d)) d = 999;
        if (d < bd) { bd = d; best = o; }
      });
      return best;
    };
    (D.bids.rows || []).forEach(function (r) {
      var o = saved[key(r)], name = r.commodity + ' ' + r.label;
      if (!r.show) { if (o && o.show) off.push(name + ': taken off the site.'); return; }
      var fNew = fut(r.symbol), wasOn = !!(o && o.show), moved = !!(o && o.symbol !== r.symbol), fOld = o ? fut(o.symbol) : null;
      if (!isNum(fNew)) warn.push(name + ': no futures price for ' + symName(r.symbol) + ' yet. The site shows a dash until one comes in.');
      if (moved && wasOn) lines.push(name + ': futures ' + symName(o.symbol) + ' to ' + symName(r.symbol) + '.');
      useLocs.forEach(function (l, li) {
        var b = r.basis && r.basis[l.id], ob = wasOn && o.basis ? o.basis[l.id] : undefined, who = locName(l) + ' ' + name;
        if (!isNum(b)) return;
        if (b > 0) warn.push(who + ': basis is POSITIVE (' + basisTxt(b) + '), cash above futures.');
        if (isNum(ob)) {
          if (Math.abs(b - ob) > JUMP + 1e-9) {
            var up = b > ob, cash = moved && isNum(fNew) && isNum(fOld) ? (fNew + b) - (fOld + ob) : b - ob;
            warn.push(who + ': ' + basisTxt(b) + ' is ' + centsTxt(b - ob) + (up ? ' higher' : ' lower') + ' than your last ' + basisTxt(ob) + '. Cash goes ' + (cash >= 0 ? 'up ' : 'down ') + centsTxt(cash) + '.');
          }
        } else {
          var n = nearest(r, l.id);
          if (n && Math.abs(b - n.basis[l.id]) > JUMP + 1e-9) warn.push(who + ' (new): ' + basisTxt(b) + ' is ' + centsTxt(b - n.basis[l.id]) + (b > n.basis[l.id] ? ' higher' : ' lower') + ' than your ' + n.label + ' basis ' + basisTxt(n.basis[l.id]) + '.');
        }
        if (!same && li > 0) { // the other yard against the first
          var b0 = r.basis[locs[0].id];
          if (isNum(b0) && Math.abs(b - b0) > JUMP + 1e-9) warn.push(who + ': ' + basisTxt(b) + ' is ' + centsTxt(b - b0) + (b > b0 ? ' higher' : ' lower') + ' than ' + locs[0].name + ' ' + basisTxt(b0) + '.');
        }
        if (isNum(fNew) && (b !== ob || moved || !wasOn)) {
          var was = !wasOn ? 'new' : isNum(ob) && isNum(fOld) ? '$' + money(fOld + ob) : 'no price';
          lines.push(who + ': cash ' + was + ' to $' + money(fNew + b) + ' (basis ' + basisTxt(b) + ')');
        }
      });
    });
    return { lines: lines, warn: warn, off: off };
  }

  // ---------- three-way merge: two saves made from the same loaded copy ----------
  // base: what both started from; mine: Jeff's page; theirs: what is on GitHub now. Fields only one side changed
  // are kept from that side. A field both changed to different values is a clash: mine wins when mineWins, else theirs.
  // Lists of rows, locations and boards are matched by commodity+label or id, so two people can touch different rows.
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function rowKey(x) { return isObj(x) ? (x.id != null ? 'id:' + x.id : x.commodity != null && x.label != null ? x.commodity + '|' + x.label : null) : null; }
  function merge3(base, mine, theirs, mineWins) {
    var clashes = [];
    function m(b, a, t, path) {
      if (same(a, b)) return t;
      if (same(t, b) || same(a, t)) return a;
      if (path[path.length - 1] === 'basis_set') return String(a || '') > String(t || '') ? a : t; // a stamp: keep the later one
      if (isObj(a) && isObj(t)) {
        var out = {}, bb = isObj(b) ? b : {};
        Object.keys(t).concat(Object.keys(a).filter(function (k) { return !(k in t); })).forEach(function (k) {
          var v = m(bb[k], a[k], t[k], path.concat(k)); if (v !== undefined) out[k] = v;
        });
        return out;
      }
      if (Array.isArray(a) && Array.isArray(t) && a.concat(t, Array.isArray(b) ? b : []).every(rowKey)) {
        var map = function (arr) { var o = {}; (Array.isArray(arr) ? arr : []).forEach(function (x) { o[rowKey(x)] = x; }); return o; };
        var B = map(b), M = map(a), T = map(t), keys = [], res = [];
        a.concat(t).forEach(function (x) { var k = rowKey(x); if (keys.indexOf(k) < 0) keys.push(k); });
        keys.forEach(function (k) { var v = m(B[k], M[k], T[k], path.concat(k.replace(/^id:/, ''))); if (v !== undefined) res.push(v); });
        return res;
      }
      clashes.push({ path: path, mine: a, theirs: t });
      return mineWins ? a : t;
    }
    return { merged: m(base, mine, theirs, []), clashes: clashes };
  }
  // ["bids","rows","Corn|Fall 26","basis","thorp"] -> "Corn Fall 26, basis, thorp"
  function pathWords(path) {
    var cap = function (x) { x = String(x).replace('|', ' ').replace(/_/g, ' '); return x.charAt(0).toUpperCase() + x.slice(1); };
    var p = path.filter(function (x) { return ['bids', 'rows', 'locations', 'references', 'business', 'lime'].indexOf(x) < 0; }), out = [];
    for (var i = 0; i < p.length; i++) {
      if ((p[i] === 'basis' || p[i] === 'hours') && i + 1 < p.length) { out.push(cap(p[i + 1]) + ' ' + p[i]); i++; } else out.push(cap(p[i]));
    }
    return out.join(', ') || 'The whole file';
  }

  // ---------- errors in plain words ----------
  // e.status from GitHub, e.offline when the request never left the phone. what: 'save' or 'load'.
  function errWords(e, what) {
    var none = what === 'save' ? 'Nothing saved.' : 'Nothing loaded.';
    if (e.offline) return 'No signal. ' + none + ' Try again.';
    if (e.status === 401) return 'Your key ran out or was deleted. ' + none + ' Make a new one (steps under "No key yet" in Change key) and paste it.';
    if (e.status === 403 || (what === 'save' && e.status === 404)) return 'This key cannot ' + what + ' the site. It needs Contents: Read and write on flashgrain. ' + none;
    if (e.status === 404) return 'Repo or file not found, or the key has no access to this repo. ' + none;
    if (e.status >= 500) return 'GitHub is having trouble. ' + none + ' Try again in a minute.';
    return 'GitHub said no (' + (e.message || 'error ' + e.status) + '). ' + none + ' Try again in a minute.';
  }
  // Where each shown contract's futures came from. bids: data/bids.json; syms: symbols of rows on the site.
  // Uses futures_sources {sym: source} when the harvester writes it, else the old one-word futures_source.
  function futuresSources(bids, syms) {
    var per = bids && bids.futures_sources, all = (bids && bids.futures_source) || 'dtn', out = { notDtn: [], missing: [], mixed: !per && all.indexOf('+') >= 0 ? all : '' };
    syms.forEach(function (s) {
      if (!bids || !bids.futures || !bids.futures[s] || !isNum(bids.futures[s].price)) return out.missing.push(s);
      if (out.mixed) return;
      var src = per ? per[s] : all;
      if (src !== 'dtn') out.notDtn.push({ sym: s, src: src || 'unknown' });
    });
    return out;
  }
  // Key expiry: exp and today as YYYY-MM-DD. Warns 14 days out; quiet before that.
  function keyState(exp, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exp || '')) return { level: 'unknown' };
    var days = Math.round((Date.parse(exp + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 864e5);
    return { level: days < 0 ? 'expired' : days <= 14 ? 'soon' : 'ok', days: days, exp: exp };
  }
  function cropOf(sym) { return /^@C/.test(sym) ? 'corn' : /^@S/.test(sym) ? 'soybeans' : /^@W/.test(sym) ? 'wheat' : ''; }
  // GitHub's key-expiry header, "2026-12-01 00:00:00 UTC" or "2026-12-01 00:00:00 -0600" -> "2026-12-01"
  function expiryFromHeader(h) { var m = /^(\d{4}-\d{2}-\d{2})/.exec(h || ''); return m ? m[1] : null; }

  return { parseBasis: parseBasis, textToHours: textToHours, hoursParts: hoursParts, hhmm: hhmm, hoursAsk: hoursAsk, hoursWords: hoursWords, clockWords: clockWords,
    money: money, basisTxt: basisTxt, centsTxt: centsTxt, symName: symName, labelMonth: labelMonth, review: review,
    merge3: merge3, pathWords: pathWords, errWords: errWords, expiryFromHeader: expiryFromHeader, futuresSources: futuresSources, cropOf: cropOf, keyState: keyState, contractDates: contractDates, rollState: rollState, nextContract: nextContract, rollBasis: rollBasis, dayWords: dayWords, nearbyFor: nearbyFor,
    MON: MON, CODEMON: CODEMON, LISTED: LISTED };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = FGA;

if (typeof window !== 'undefined' && window.document) (function () {
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
  function setDirty(v) { dirty = v; $('dirty').textContent = v ? 'Unsaved changes' : ''; $('discard').hidden = !v; }
  function store(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }
  function stored(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function b64enc(str) { var b = new TextEncoder().encode(str), s = ''; b.forEach(function (c) { s += String.fromCharCode(c); }); return btoa(s); }
  function b64dec(b64) { var s = atob(b64.replace(/\s/g, '')), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return new TextDecoder().decode(a); }
  function gh(path, opts) {
    opts = opts || {};
    opts.headers = { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + $('token').value.trim(), 'X-GitHub-Api-Version': '2022-11-28' };
    return fetch(API + $('repo').value.trim() + path, opts).then(function (r) {
      // GitHub sends the key's expiry on every call (github-authentication-token-expiration). Its CORS rules hide the
      // header from browsers today; when it is readable it fills Key expires by itself, so Jeff never types it.
      var hx = FGA.expiryFromHeader(r.headers.get('github-authentication-token-expiration'));
      if (hx && r.ok) { $('key-exp').value = hx; store('fg-key-exp', hx); }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) { var e = new Error(j.message || ('HTTP ' + r.status)); e.status = r.status; throw e; }
        return j;
      });
    }, function () { var e = new Error('offline'); e.offline = true; throw e; }); // the request never reached GitHub
  }
  function ref() { return '?ref=' + encodeURIComponent($('branch').value.trim()); }
  var parseBasis = FGA.parseBasis, textToHours = FGA.textToHours;
  function bidLocs(s) { return (s || S).locations.filter(function (l) { return l.bids; }); }

  // ---------- connect ----------
  ['repo', 'branch'].forEach(function (k) {
    var v = stored('fg-' + k); if (v) $(k).value = v;
    if ($(k).value !== $(k).defaultValue) $(k).closest('details').open = true; // never hide a changed repo or branch
  });
  var kx = stored('fg-key-exp'); if (kx) $('key-exp').value = kx;
  $('key-exp').onchange = function () { store('fg-key-exp', $('key-exp').value || null); if (S) drawChips(); };
  var t = stored('fg-token'); if (t) { $('token').value = t; $('remember').checked = true; }
  $('forget').onclick = function () { store('fg-token', null); store('fg-key-exp', null); $('key-exp').value = ''; $('token').value = ''; $('remember').checked = false; status('Key removed from this device.'); };

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
    if (S && dirty) { // a new key mid-edit (the old one ran out): keep every change, just use the new key
      store('fg-token', $('remember').checked ? $('token').value.trim() : null); store('fg-key-exp', $('key-exp').value || null);
      $('connect').hidden = true; drawChips();
      return status('New key in. Your changes are still here. Press Save to site.');
    }
    store('fg-repo', $('repo').value.trim()); store('fg-branch', $('branch').value.trim());
    store('fg-token', $('remember').checked ? $('token').value.trim() : null);
    store('fg-key-exp', $('key-exp').value || null);
    status('Loading…');
    var opt = function (path) { return gh('/contents/' + path + ref()).then(function (j) { return JSON.parse(b64dec(j.content)); }).catch(function () { return null; }); };
    Promise.all([gh('/contents/' + PATH + ref()), opt('data/bids.json'), opt('data/cbot.json')])
      .then(function (r) {
        SHA = r[0].sha; S = JSON.parse(b64dec(r[0].content)); ORIG = clone(S);
        BIDS = r[1]; CAL = r[2] || { holidays: [], contracts: {} }; // no file yet: the CME rule alone
        hoursCache = {};
        return loadFutures().then(function () { draw(); $('editor').hidden = false; setDirty(false); });
      }).then(function () {
        $('connect').hidden = true; $('change-key').hidden = false; drawChips();
        status('Loaded.');
      }).then(offerDraft).catch(function (e) {
        status(e.status === 401 ? 'Key not accepted. Check it was copied whole. If it ran out or was deleted, make a new one: steps under "No key yet" below.' : FGA.errWords(e, 'load'), true);
      });
  };

  $('change-key').onclick = function () { $('connect').hidden = !$('connect').hidden; if (!$('connect').hidden) $('token').focus(); };

  // ---------- status strip ----------
  var REFST = {}, REFDATA = [];
  var SRC = { dtn: 'DTN', boards: 'elevator boards', agsist: 'AGSIST', yahoo: 'Yahoo', ace: 'Ace' };
  function chip(cls, html) { return '<li class="' + cls + '">' + html + '</li>'; }
  function drawChips() {
    var out = [], b = BIDS;
    if (b) {
      var age = FG.ageMin(b.checked || b.updated), shown = [];
      (S ? S.bids.rows : []).forEach(function (r) { if (r.show && shown.indexOf(r.symbol) < 0) shown.push(r.symbol); });
      var fs = FGA.futuresSources(b, shown);
      // say plainly when a price on the site is not DTN's, contract by contract
      if (fs.mixed) out.push(chip('bad', 'Futures <b>' + esc(fs.mixed.split('+').map(function (x) { return SRC[x] || x; }).join(' + ')) + '</b>, some not DTN'));
      else if (!fs.notDtn.length && !fs.missing.length) out.push(chip('ok', 'Futures <b>DTN</b>'));
      fs.notDtn.forEach(function (x) { out.push(chip('bad', esc(FGA.symName(x.sym) + ' ' + FGA.cropOf(x.sym)) + ' <b>' + esc(SRC[x.src] || x.src) + ', not DTN</b>')); });
      fs.missing.forEach(function (s) { out.push(chip('bad', esc(FGA.symName(s) + ' ' + FGA.cropOf(s)) + ' <b>no price</b>')); });
      var t = new Date(Date.parse(b.checked || b.updated)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
      out.push(chip(age > 25 ? 'bad' : 'ok', 'Checked <b>' + esc(t) + '</b> · ' + (isFinite(age) ? Math.max(0, Math.round(age)) + ' min ago' : '?')));
    } else out.push(chip('bad', 'Feed <b>no data</b>'));
    out.push(FG.cbotOpen() ? chip('ok', 'CBOT <b>open</b>') : chip('', 'CBOT <b>closed</b>'));
    out.push(keyChip());
    (S && S.references || []).forEach(function (r) {
      var st = REFST[r.id];
      var nm = esc(r.name.split(' ')[0]);
      out.push(st === true ? chip('ok', nm + ' <b>read</b>') : st === false ? chip('bad', nm + ' <b>failing</b>') : chip('', nm + ' <b>…</b>'));
    });
    $('chips').innerHTML = out.join('');
  }
  setInterval(function () { if (S) drawChips(); }, 60000);
  // Key expiry, from the date typed under the key (GitHub shows it when the key is made). Warns 14 days out.
  function keyChip() {
    var now = new Date(), k = FGA.keyState($('key-exp').value, now.getFullYear() + '-' + ('0' + (now.getMonth() + 1)).slice(-2) + '-' + ('0' + now.getDate()).slice(-2));
    if (k.level === 'unknown') return chip('', 'Key expiry <b>not set</b>');
    if (k.level === 'ok') return ''; // known and more than 14 days off: nothing to nag about
    var when = new Date(k.exp + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    if (k.level === 'expired') return chip('bad', 'Key <b>expired ' + esc(when) + '</b>, make a new one');
    return chip('bad', 'Key expires <b>' + esc(when) + '</b> · ' + (k.days === 0 ? 'today' : k.days === 1 ? 'tomorrow' : k.days + ' days') + ', make a new one');
  }

  // ---------- draw ----------
  // ---------- delivery list: every period, a switch each, basis when on ----------
  // Periods: the next 12 calendar months plus Fall of this year and the next two. Futures by the usual rule:
  // the nearest listed contract at or after the delivery month (corn H K N U Z, soybeans F H K N Q U X);
  // Fall = Dec corn / Nov soybeans. Overridable per row under "Edit rows".
  var MON = FGA.MON, LISTED = FGA.LISTED;
  var FUT = {}, CAT = [], SAME = true, CAL = { holidays: [], contracts: {} };
  function contractFor(pfx, y, m) {
    var ms = Object.keys(LISTED[pfx]).map(Number);
    for (var k = 0; k < 2; k++) { var hit = ms.filter(function (x) { return k || x >= m; })[0]; if (hit) return pfx + ((y + k) % 10) + LISTED[pfx][hit]; }
  }
  function nowYM() { var p = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); return p.slice(0, 7); }
  function symName(sym) { return esc(FGA.symName(sym)); }
  function buildCatalog() {
    var now = nowYM(), y0 = +now.slice(0, 4), m0 = +now.slice(5, 7), coms = [];
    S.bids.rows.concat([{ commodity: 'Corn' }, { commodity: 'Soybeans' }]).forEach(function (r) { if (coms.indexOf(r.commodity) < 0 && PREFIX[(r.commodity || '').toLowerCase()]) coms.push(r.commodity); });
    var have = {}; S.bids.rows.forEach(function (r) { have[r.commodity + '|' + r.label] = r; });
    var out = [];
    coms.forEach(function (c) {
      var pfx = PREFIX[c.toLowerCase()], list = [];
      for (var k = 0; k < 3; k++) { var y = y0 + k; list.push({ label: 'Fall ' + (y % 100), until: y + '-12', sort: y + '-11b', symbol: pfx + (y % 10) + (pfx === '@C' ? 'Z' : 'X') }); }
      for (var j = 0; j < 12; j++) { var mm = (m0 - 1 + j) % 12 + 1, yy = y0 + Math.floor((m0 - 1 + j) / 12), u = yy + '-' + ('0' + mm).slice(-2); list.push({ label: MON[mm - 1] + ' ' + (yy % 100), until: u, sort: u, symbol: contractFor(pfx, yy, mm) }); }
      list.forEach(function (p) { p.commodity = c; p.key = c + '|' + p.label; p.row = have[p.key] || null; p.defSymbol = p.symbol; if (p.row) { p.symbol = p.row.symbol || p.symbol; delete have[p.key]; } });
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
            + '<span class="bl-fut"><span class="bl-sn">' + symName(p.symbol) + '</span> <b>' + (f ? FG.cents8(f.price) : 'no quote') + '</b><span class="bl-src"></span><input class="sym" data-f="symbol" value="' + esc(p.symbol) + '" aria-label="Futures symbol, ' + esc(c + ' ' + p.label) + '"></span>'
            + '<span class="bl-locs">' + locs.map(function (l, li) {
              var b = r.basis && r.basis[l.id];
              return '<span class="bl-loc' + (li ? ' follow' : '') + '"><span class="bl-ln">' + esc(l.name) + '</span>'
                + '<input class="num" data-b="' + esc(l.id) + '" type="text" inputmode="decimal" autocomplete="off" spellcheck="false" placeholder="-0.60" value="' + (FG.num(b) ? b.toFixed(2) : '') + '" aria-label="' + esc(l.name + ' basis, ' + c + ' ' + p.label) + '">'
                + '<span class="bl-cash" data-p="' + esc(l.id) + '"></span></span>';
            }).join('') + '<button class="a-btn sm bl-undo" type="button" hidden>Back to saved</button></span><span class="bl-near"></span></div>';
        }).join('') + '<p class="bl-none">Nothing on. Tap a month above to post it.</p></div></div>';
    });
    $('bids-list').innerHTML = h;
    $('bids-list').classList.toggle('same', SAME);
    $('bids-list').querySelectorAll('.bl-row').forEach(function (row) { previewRow(row); markRow(row); });
    drawRoll();
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
    row.querySelector('.bl-sn').textContent = FGA.symName(sym);
    // not DTN, or only a preview the site does not have: say so next to the price
    var per = BIDS && BIDS.futures_sources, src = f && f.from ? f.from + ', preview only' : per && per[sym] && per[sym] !== 'dtn' ? (SRC[per[sym]] || per[sym]) + ', not DTN' : '';
    row.querySelector('.bl-src').textContent = src ? ' ' + src : '';
    // nearby elevators' bid for the same month, and how Jeff's cash sits against it
    var mine = f && FG.num(parseBasis(first.value)) ? f.price + parseBasis(first.value) : null;
    row.querySelector('.bl-near').innerHTML = FGA.nearbyFor({ commodity: p.commodity, label: p.label, symbol: sym }, REFDATA).map(function (n) {
      var d = FG.num(mine) ? Math.round((mine - n.cash) * 100) : null;
      return '<span>' + esc(n.name.split(' ')[0] + ' ' + n.label.replace(/ 20(\d\d)$/, ' $1')) + ' <b>$' + FG.money(n.cash) + '</b>' + (FG.num(n.basis) ? ' (' + FG.basis(n.basis) + ')' : '')
        + (d === null ? '' : d === 0 ? ', same as yours' : ', yours ' + FGA.centsTxt(d / 100) + (d > 0 ? ' over' : ' under')) + '</span>';
    }).join('');
  }
  $('bids-list').addEventListener('change', function (e) {
    if (e.target.dataset.f !== 'show') return;
    var row = $('bids-list').querySelector('.bl-row[data-c="' + e.target.dataset.c + '"]'), on = e.target.checked; row.classList.toggle('on', on);
    if (on) { // put the cursor in an empty basis box
      var inp = row.querySelector('[data-b]');
      previewRow(row); if (!inp.value) inp.focus();
    }
    drawRoll();
  });

  // ---------- contract roll: a card for every row on the site whose futures are near first notice or past it ----------
  function centralToday() { return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }); }
  function drawRoll() {
    $('cards').querySelectorAll('[data-card^="roll-"]').forEach(function (c) { c.remove(); });
    var today = centralToday();
    $('bids-list').querySelectorAll('.bl-row').forEach(function (row) {
      if (!$('bl' + row.dataset.c).checked) return;
      var p = CAT[+row.dataset.c], sym = row.querySelector('[data-f=symbol]').value.trim().toUpperCase(), st = FGA.rollState(sym, today, CAL);
      if (!st) return;
      var nx = FGA.nextContract(sym), what = '<b>' + esc(p.label + ' ' + p.commodity.toLowerCase()) + '</b> use ' + esc(FGA.symName(sym)) + ' futures';
      var html = st.level === 'expired'
        ? what + ', which stopped trading ' + esc(FGA.dayWords(st.ltd)) + '. The site shows a dash for this row until you move it.'
        : what + '. First notice ' + esc(FGA.dayWords(st.fnd)) + ', last trade ' + esc(FGA.dayWords(st.ltd)) + '.';
      html += nx ? ' Move to ' + esc(FGA.symName(nx)) + '?' : '';
      card('roll-' + row.dataset.c, st.level === 'expired' ? 'stop' : 'warn', html, nx ? [['Move to ' + FGA.symName(nx), function () { moveRow(row, nx); }]] : []);
    });
  }
  // Switch a row to the next contract and suggest the basis that keeps cash where it is. Jeff confirms it.
  function moveRow(row, nx) {
    var symIn = row.querySelector('[data-f=symbol]'), old = symIn.value.trim().toUpperCase(), fo = futFor(old), fn = futFor(nx);
    symIn.value = nx;
    var note = row.querySelector('.bl-sugg'); if (note) note.remove();
    var ins = row.querySelectorAll('[data-b]'), first = null, said = '';
    ins.forEach(function (inp, li) {
      if (SAME && li) return;
      var b = parseBasis(inp.value), nb = FGA.rollBasis(b, fo && fo.price, fn && fn.price);
      if (nb === null) return;
      inp.value = nb.toFixed(2); inp.classList.add('sugg'); first = first || inp;
      if (!said) said = FGA.basisTxt(nb) + ' keeps cash at $' + FG.money(fo.price + b) + ' (' + FGA.symName(nx) + ' is ' + FGA.centsTxt(fn.price - fo.price) + (fn.price >= fo.price ? ' over ' : ' under ') + FGA.symName(old) + ')';
    });
    note = document.createElement('span'); note.className = 'bl-sugg';
    note.textContent = said ? 'Suggested basis ' + said + '. Check it before you publish.'
      : !fn ? 'No ' + FGA.symName(nx) + ' price yet, so no suggested basis. Set it yourself; the site shows a dash until a price comes in.'
      : 'No ' + FGA.symName(old) + ' price to compare, so no suggested basis. Set it yourself.';
    row.appendChild(note);
    previewRow(row); markRow(row); setDirty(true); keepDraft(); drawRoll();
    row.scrollIntoView({ block: 'center' }); (first || ins[0]).focus({ preventScroll: true });
  }
  $('bids-list').addEventListener('input', function (e) {
    if (e.target.classList.contains('sugg')) { e.target.classList.remove('sugg'); var n = e.target.closest('.bl-row').querySelector('.bl-sugg'); if (n && !e.target.closest('.bl-row').querySelector('.sugg')) n.remove(); }
    if (e.target.dataset.f === 'symbol') drawRoll();
  });
  $('bids-list').addEventListener('input', function (e) { var row = e.target.closest('.bl-row'); if (row) { previewRow(row); markRow(row); } });
  $('bids-list').addEventListener('change', function (e) { var row = e.target.closest('.bl-row') || $('bids-list').querySelector('.bl-row[data-c="' + e.target.dataset.c + '"]'); if (row) markRow(row); });
  $('bids-list').addEventListener('click', function (e) { if (e.target.classList.contains('bl-undo')) undoRow(e.target.closest('.bl-row')); });

  // ---------- undo: one row back to what the site has, or every change thrown away ----------
  function savedRow(p) { return (ORIG.bids.rows || []).filter(function (r) { return r.commodity === p.commodity && r.label === p.label; })[0] || null; }
  function rowChanged(row) {
    var p = CAT[+row.dataset.c], o = savedRow(p), ins = row.querySelectorAll('[data-b]');
    if ($('bl' + row.dataset.c).checked !== !!(o && o.show)) return true;
    if (row.querySelector('[data-f=symbol]').value.trim().toUpperCase() !== (o ? o.symbol : p.defSymbol)) return true;
    for (var li = 0; li < ins.length; li++) {
      var v = (SAME && li ? ins[0] : ins[li]).value.trim(), was = o && o.basis ? o.basis[ins[li].dataset.b] : undefined;
      if (v === '' ? FG.num(was) : parseBasis(v) !== was) return true;
    }
    return false;
  }
  function markRow(row) { row.querySelector('.bl-undo').hidden = !rowChanged(row); }
  function undoRow(row) {
    var p = CAT[+row.dataset.c], o = savedRow(p), on = !!(o && o.show);
    $('bl' + row.dataset.c).checked = on; row.classList.toggle('on', on);
    row.querySelector('[data-f=symbol]').value = o ? o.symbol : p.defSymbol;
    row.querySelectorAll('[data-b]').forEach(function (inp) { var b = o && o.basis ? o.basis[inp.dataset.b] : undefined; inp.value = FG.num(b) ? b.toFixed(2) : ''; inp.classList.remove('bad', 'sugg'); });
    var note = row.querySelector('.bl-sugg'); if (note) note.remove();
    previewRow(row); markRow(row); recheckDirty(); drawRoll();
    row.querySelector('[data-b]').focus();
  }
  // dirty means the form differs from what the site has, not just that a key was pressed
  function recheckDirty() {
    if (!S) return;
    var d = collect(true).draft;
    if (JSON.stringify(d) === JSON.stringify(ORIG)) { setDirty(false); dropDraft(); } else setDirty(true);
  }
  $('discard').onclick = function () {
    sheet({ title: 'Throw away every change?', html: '<p>Everything you changed since loading goes back to what the site has now. Nothing is published.</p>', ok: 'Throw away', back: 'Keep them', danger: true })
      .then(function (yes) {
        if (!yes) return;
        S = clone(ORIG); draw(); setDirty(false); dropDraft(); problems(null); closeCard('draft');
        status('Changes thrown away. This is what the site has.');
      });
  };
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
        // with one basis for both yards the second box is hidden: report the first box, once
        var fl = SAME && li ? function () {} : flag, who = (SAME ? '' : inp.closest('.bl-loc').querySelector('.bl-ln').textContent + ' ') + p.commodity + ' ' + p.label;
        if (v === '') { delete r.basis[id]; if (show && locIds.indexOf(id) >= 0) fl(inp, who + ': turned on but no basis.'); return; }
        var n = parseBasis(v);
        if (!FG.num(n)) { fl(inp, who + ': basis "' + v + '" is not a number.'); return; }
        if (Math.abs(n) > 3) { fl(inp, who + ': basis "' + v + '" is outside -3.00 to +3.00.'); return; }
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
  function drawHours() {
    var locs = S.locations.filter(function (l) { return l.hours; });
    $('hours').innerHTML = '<thead><tr><th><span class="vh">Day</span></th>' + locs.map(function (l) { return '<th scope="col">' + esc(l.name) + '</th>'; }).join('') + '</tr></thead><tbody>'
      + FG.DAYS.map(function (d) {
        return '<tr><th scope="row">' + FG.DAYN[d] + '</th>' + locs.map(function (l) {
          return '<td><input data-loc="' + esc(l.id) + '" data-d="' + d + '" value="' + esc(hoursToText(l.hours[d])) + '" aria-label="' + esc(l.name + ' ' + FG.DAYN[d] + ' hours') + '" autocomplete="off" spellcheck="false"></td>';
        }).join('') + '</tr>';
      }).join('') + '</tbody>';
    $('hours').querySelectorAll('input').forEach(function (inp) {
      inp.addEventListener('blur', function () {
        var ask = FGA.hoursAsk(inp.value);
        if (ask) return askHours(inp, ask);
        if ($('hours-ask').dataset.for === inp.dataset.loc + inp.dataset.d) { $('hours-ask').hidden = true; $('hours-ask').dataset.for = ''; }
        var v = textToHours(inp.value); if (v) inp.value = hoursToText(v);
      });
    });
    $('hours-ask').hidden = true; $('hours-ask').dataset.for = '';
  }
  function hoursName(inp) { var l = S.locations.filter(function (x) { return x.id === inp.dataset.loc; })[0]; return (l ? l.name : '') + ' ' + FG.DAYN[inp.dataset.d]; }
  // Ask in the page which reading Jeff meant, big, with one button per reading. Saving waits until he picks.
  function askHours(inp, ask) {
    var box = $('hours-ask'), raw = inp.value.trim();
    box.dataset.for = inp.dataset.loc + inp.dataset.d;
    box.innerHTML = '<p class="a-ask-q">' + esc(hoursName(inp)) + ': <b>' + esc(raw) + '</b>. Which one?</p><div class="a-actions">'
      + '<button class="a-btn a-pick" type="button" data-v="' + ask.pm + '">' + esc(FGA.hoursWords(ask.pm)) + '</button>'
      + '<button class="a-btn a-pick" type="button" data-v="' + ask.am + '">' + esc(FGA.hoursWords(ask.am)) + '</button></div>';
    box.hidden = false;
    box.querySelectorAll('.a-pick').forEach(function (b) {
      b.onclick = function () {
        inp.value = hoursToText(b.dataset.v); inp.classList.remove('bad'); setDirty(true);
        box.innerHTML = '<p class="a-ask-q">' + esc(hoursName(inp)) + ': <b>' + esc(FGA.hoursWords(b.dataset.v)) + '</b></p>';
        box.dataset.for = '';
      };
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
          REFDATA = REFDATA.filter(function (x) { return x.id !== r.id; }).concat([{ id: r.id, name: r.name, commodity: r.commodity, rows: rows }]);
          $('bids-list').querySelectorAll('.bl-row').forEach(previewRow);
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

  function readHours(D, flag, quiet) {
    $('hours').querySelectorAll('input[data-loc]').forEach(function (inp) {
      var l = D.locations.filter(function (x) { return x.id === inp.dataset.loc; })[0];
      if (!l || !l.hours) return;
      var ask = FGA.hoursAsk(inp.value);
      if (ask) { flag(inp, l.name + ' ' + FG.DAYN[inp.dataset.d] + ': is "' + inp.value.trim() + '" ' + FGA.hoursWords(ask.pm) + ' or ' + FGA.hoursWords(ask.am) + '? Tap one under the hours.'); if (!quiet && $('hours-ask').hidden) askHours(inp, ask); return; }
      var v = textToHours(inp.value);
      if (!v) { flag(inp, l.name + ' ' + FG.DAYN[inp.dataset.d] + ': "' + inp.value + '" is not hours. Type 8-5, call or closed.'); return; }
      l.hours[inp.dataset.d] = v;
    });
  }


  // ---------- read the form into a draft; S is only replaced when the draft is valid ----------
  function collect(quiet) { // quiet: read only, leave the red outlines alone (for the draft)
    var D = clone(S), bad = [], els = [];
    if (!quiet) document.querySelectorAll('.bad').forEach(function (e) { e.classList.remove('bad'); });
    var flag = function (el, why) { if (!quiet) el.classList.add('bad'); bad.push(why); els.push(el); };

    readHours(D, flag, quiet);
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
    if (!locIds.length) { bad.push('At least one location has to post bids.'); els.push(null); }
    if (!D.locations.some(function (l) { return l.hours; })) { bad.push('At least one location needs hours.'); els.push(null); }
    return { draft: D, bad: bad, els: els };
  }
  // Every problem in a list at the save button, each one a tap away; the first box is scrolled to and focused.
  function problems(c, go) {
    var ul = $('problems');
    if (!c || !c.bad.length) { ul.innerHTML = ''; ul.hidden = true; return; }
    var ord = c.bad.map(function (w, i) { return i; }).sort(function (i, j) { // page order, top to bottom
      var a = c.els[i], b = c.els[j]; if (!a || !b) return a ? -1 : b ? 1 : i - j;
      return a === b ? i - j : a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
    });
    c = { bad: ord.map(function (i) { return c.bad[i]; }), els: ord.map(function (i) { return c.els[i]; }) };
    status(c.bad.length === 1 ? 'One thing to fix before saving:' : c.bad.length + ' things to fix before saving:', true);
    ul.innerHTML = c.bad.map(function (w, i) { return '<li><button type="button" class="a-prob" data-i="' + i + '">' + esc(w) + '</button></li>'; }).join('');
    ul.hidden = false;
    ul.querySelectorAll('.a-prob').forEach(function (b) { b.onclick = function () { reveal(c.els[+b.dataset.i]); }; });
    if (go) reveal(c.els.filter(Boolean)[0]);
  }
  function reveal(el) {
    if (!el) return;
    for (var d = el.closest('details'); d; d = d.parentElement && d.parentElement.closest('details')) d.open = true;
    if (el.matches('.sym') && !$('bids-list').classList.contains('editing')) $('edit-rows').click();
    var crop = el.closest('.bl-crop'); if (crop) crop.classList.add('more');
    el.scrollIntoView({ block: 'center' }); el.focus({ preventScroll: true });
  }
  function apply(op) {
    var c = collect();
    if (c.bad.length) { problems(c, false); return false; }
    S = c.draft; if (op) op(); setDirty(true);
    // Clear an old error AFTER the current click lands: clearing it now shrinks the sticky save bar between
    // mousedown and mouseup (blur fires 'change' first), the Save button moves, and the click is lost.
    if ($('status2').classList.contains('err')) setTimeout(function () { if (!saving && $('status2').classList.contains('err') && !collect().bad.length) { status(''); problems(null); } }, 300);
    return true;
  }

  // ---------- row buttons, live preview, dirty tracking ----------
  $('editor').addEventListener('input', function () { setDirty(true); });
  $('editor').addEventListener('change', function () { setDirty(true); });

  // ---------- draft: every change is kept on this device until it is published ----------
  // A dead battery, a lost signal or a closed tab costs nothing: on the next load the page offers it back.
  var DRAFT = 'fg-draft', draftTimer = null;
  function keepDraft() {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(function () {
      if (!S || !dirty) return;
      recheckDirty(); if (!dirty) return;
      store(DRAFT, JSON.stringify({ at: new Date().toISOString(), repo: $('repo').value.trim(), branch: $('branch').value.trim(), base: ORIG, draft: collect(true).draft }));
    }, 400);
  }
  function dropDraft() { clearTimeout(draftTimer); store(DRAFT, null); }
  $('editor').addEventListener('input', keepDraft);
  $('editor').addEventListener('change', keepDraft);
  function offerDraft() {
    var d = null; try { d = JSON.parse(stored(DRAFT) || 'null'); } catch (e) {}
    if (!d || !d.draft || !d.base || d.repo !== $('repo').value.trim() || d.branch !== $('branch').value.trim()) return;
    var m = FGA.merge3(d.base, d.draft, S, true);
    if (JSON.stringify(m.merged) === JSON.stringify(S)) return dropDraft();
    var when = new Date(d.at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    card('draft', 'warn', 'Changes from ' + esc(when) + ' were never published.', [
      ['Bring them back', function () { S = m.merged; draw(); setDirty(true); keepDraft(); closeCard('draft'); status('Your changes are back. Check them, then Save to site.'); }],
      ['Throw them away', function () { dropDraft(); closeCard('draft'); }]
    ]);
  }
  // Cards: the yellow (warn) or red (bad) notes at the top of Cash bids. id keeps one card per subject.
  function card(id, kind, html, buttons) {
    closeCard(id);
    var c = document.createElement('div'); c.className = 'a-card ' + kind; c.dataset.card = id; c.setAttribute('role', 'status');
    c.innerHTML = '<p>' + html + '</p>' + (buttons && buttons.length ? '<div class="a-actions"></div>' : '');
    (buttons || []).forEach(function (b, i) {
      var el = document.createElement('button'); el.type = 'button'; el.className = i ? 'a-btn' : 'a-btn a-main'; el.textContent = b[0]; el.onclick = b[1];
      c.querySelector('.a-actions').appendChild(el);
    });
    $('cards').appendChild(c); return c;
  }
  function closeCard(id) { var c = $('cards').querySelector('[data-card="' + id + '"]'); if (c) c.remove(); }
  window.addEventListener('beforeunload', function (e) { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
  $('locs').addEventListener('change', function (e) {
    if (apply()) { drawBids(); drawHours(); }
    else if (e.target.type === 'checkbox') e.target.checked = !e.target.checked; // fix the other field first
  });

  // ---------- save ----------
  function priceReview(D) {
    var rv = FGA.review(D, ORIG, bidLocs(D), SAME, function (sym) { var f = futFor(sym); return f ? f.price : null; });
    $('bids-list').querySelectorAll('.bl-row').forEach(function (row) { // a suggested basis left as suggested
      var p = CAT[+row.dataset.c], i = row.querySelector('.sugg');
      if (i && $('bl' + row.dataset.c).checked) rv.warn.unshift(p.commodity + ' ' + p.label + ': basis ' + i.value + ' is the suggested one for the new contract. Is it what you want to pay?');
    });
    return rv;
  }

  // In-page review sheet instead of confirm(): Back has the focus, Publish only arms after a moment so the tap
  // that opened the sheet cannot land on it. Resolves true for the main button, false for Back or Escape.
  var sheetDone = null;
  function sheet(o) {
    var d = $('sheet'), ok = $('sheet-ok');
    if (sheetDone) sheetDone(false);
    $('sheet-title').textContent = o.title; $('sheet-body').innerHTML = o.html;
    ok.textContent = o.ok; $('sheet-back').textContent = o.back || 'Back';
    ok.className = 'cta' + (o.danger ? ' danger' : ''); ok.disabled = true; setTimeout(function () { ok.disabled = false; }, 600);
    if (d.showModal) d.showModal(); else d.setAttribute('open', '');
    $('sheet-back').focus(); d.querySelector('.sheet-in').scrollTop = 0;
    return new Promise(function (res) {
      sheetDone = function (v) { sheetDone = null; if (d.close) d.close(); else d.removeAttribute('open'); res(v); };
      ok.onclick = function () { sheetDone(true); };
      $('sheet-back').onclick = function () { sheetDone(false); };
      d.oncancel = function (e) { e.preventDefault(); sheetDone(false); };
    });
  }
  var PARTS = [['notices', 'Alert bar'], ['notice_until', 'Alert bar'], ['lime', 'Lime'], ['business', 'Contact'], ['portal_url', 'Contact'], ['references', 'Nearby bids'], ['locations', 'Hours and locations']];
  function reviewHtml(D, rv) {
    var li = function (a) { return a.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join(''); }, h = '';
    if (rv.warn.length) h += '<h3 class="sh-h">Check these first</h3><ul class="sh-warn">' + li(rv.warn) + '</ul>';
    if (rv.lines.length || rv.off.length) h += '<h3 class="sh-h">Going on the site</h3><ul class="sh-lines">' + li(rv.lines.concat(rv.off)) + '</ul>';
    var also = []; PARTS.forEach(function (p) { if (JSON.stringify(D[p[0]]) !== JSON.stringify(ORIG[p[0]]) && also.indexOf(p[1]) < 0) also.push(p[1]); });
    if (D.bids.footnote !== ORIG.bids.footnote && also.indexOf('Footnote') < 0) also.push('Footnote');
    if (also.length) h += '<p class="sh-also">Also changing: ' + esc(also.join(', ')) + '.</p>';
    return h;
  }

  $('save').onclick = function () {
    if (saving) return;
    var c = collect();
    if (c.bad.length) return problems(c, true);
    problems(null);
    var D = c.draft;
    if (JSON.stringify(D) === JSON.stringify(ORIG)) { setDirty(false); return status('Nothing to save. The site already has this version.'); }
    var rv = priceReview(D);
    if (!rv.warn.length && !rv.lines.length && !rv.off.length) return publish(D, rv);
    sheet({ title: rv.warn.length ? 'Check before publishing' : 'Publish these prices?', html: reviewHtml(D, rv), ok: 'Publish', back: 'Back' })
      .then(function (yes) { if (yes) publish(D, rv); else status('Not published. Your changes are still here.'); });
  };
  function publish(D, rv) {
    if (rv.lines.length || rv.off.length) D.bids.basis_set = new Date().toISOString();
    if (JSON.stringify(D) === JSON.stringify(ORIG)) { setDirty(false); return status('Nothing to save. The site already has this version.'); }
    saving = true; $('save').disabled = true; $('editor').inert = true; status('Saving…');
    put(D, false, 0).catch(saveFailed).then(function () { saving = false; $('save').disabled = false; $('editor').inert = false; });
  }
  // One PUT. On 409 (someone saved since this page loaded) fetch their version and merge: fields only one side
  // changed are kept from that side and the merge is saved at once. Only a box both changed is asked about.
  function put(D, merged, tries) {
    var body = JSON.stringify(D, null, 2) + '\n';
    return gh('/contents/' + PATH, { method: 'PUT', body: JSON.stringify({ message: 'admin: update site.json', content: b64enc(body), sha: SHA, branch: $('branch').value.trim() }) })
      .then(function (j) {
        SHA = j.content.sha; S = D; ORIG = clone(D); setDirty(false); dropDraft(); if (merged) draw(); else drawBids();
        status('Saved ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) + (merged ? ', with the other save kept too' : '') + '. The site shows it in 1–3 minutes; pages already open update within 5.', false, j.commit && j.commit.html_url);
      }, function (e) {
        if (e.status !== 409 || tries > 2) throw e;
        return gh('/contents/' + PATH + ref()).then(function (cur) {
          var text = b64dec(cur.content), base = ORIG, theirs = JSON.parse(text);
          if (text === body) { SHA = cur.sha; S = D; ORIG = clone(D); setDirty(false); dropDraft(); return status('Saved.'); }
          SHA = cur.sha; ORIG = theirs;
          var m = FGA.merge3(base, D, theirs, false);
          if (!m.clashes.length) { status('Someone else saved too. Adding your changes to theirs…'); return put(m.merged, true, tries + 1); }
          var li = m.clashes.map(function (c) { return '<li>' + esc(FGA.pathWords(c.path)) + ': yours <b>' + esc(show(c.mine)) + '</b>, theirs <b>' + esc(show(c.theirs)) + '</b></li>'; }).join('');
          $('editor').inert = false;
          return sheet({ title: 'Someone else changed the same boxes', html: '<p>Since you loaded, another save changed these too:</p><ul class="sh-warn">' + li + '</ul><p class="sh-also">Everything else from both saves is kept either way.</p>', ok: 'Publish mine', back: 'Keep theirs' })
            .then(function (mine) {
              $('editor').inert = true;
              if (mine) return put(FGA.merge3(base, D, theirs, true).merged, true, tries + 1);
              S = m.merged; draw(); setDirty(JSON.stringify(S) !== JSON.stringify(ORIG)); keepDraft();
              status(dirty ? 'Kept theirs. Your other changes are on the page, not published yet: press Save to site.' : 'Kept theirs. Nothing else to publish.');
            });
        });
      });
  }
  function show(v) { return v === undefined ? '(none)' : typeof v === 'number' ? FGA.basisTxt(v) : typeof v === 'string' ? v : JSON.stringify(v); }
  function saveFailed(e) {
    status(FGA.errWords(e, 'save') + ' Your changes are kept on this device.', true);
    if (e.status === 401) { $('connect').hidden = false; $('token').value = ''; store('fg-token', null); $('token').focus(); }
  }
  $('download').onclick = function () {
    var c = collect(); if (c.bad.length) return problems(c, true);
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(c.draft, null, 2) + '\n'], { type: 'application/json' }));
    a.download = 'site.json'; a.click();
  };
})();
