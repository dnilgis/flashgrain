// Pure admin rules (assets/js/admin.js FGA), run in node. Cases come from the real site.json, bids.json and reviewer C's findings.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
const A = require('../assets/js/admin.js');
const fx = f => JSON.parse(readFileSync(new URL('./fixtures/' + f, import.meta.url), 'utf8'));

test('basis parsing keeps its old readings', () => {
  assert.equal(A.parseBasis('-0.60'), -0.6);
  assert.equal(A.parseBasis(' −.6 '), -0.6);
  assert.equal(A.parseBasis('-0,60'), -0.6);
  assert.ok(Number.isNaN(A.parseBasis('-60c')));
});

test('documented hours rule unchanged: 8-5 is 8 AM to 5 PM, 8-12 is 8 to noon', () => {
  assert.equal(A.textToHours('8-5'), '08:00-17:00');
  assert.equal(A.textToHours('8-12'), '08:00-12:00');
  assert.equal(A.textToHours('7:30-4:30'), '07:30-16:30');
  assert.equal(A.textToHours('7a-9p'), '07:00-21:00');
  assert.equal(A.textToHours('Call'), 'call');
  assert.equal(A.textToHours('open late'), null);
});

test('hours "7-9" and "6-10" are asked, not guessed (reviewer C3)', () => {
  assert.deepEqual(A.hoursAsk('7-9'), { am: '07:00-09:00', pm: '07:00-21:00' });
  assert.deepEqual(A.hoursAsk('6-10'), { am: '06:00-10:00', pm: '06:00-22:00' });
  assert.equal(A.hoursWords(A.hoursAsk('7-9').pm), '7 AM to 9 PM');
  // documented readings stay silent
  for (const t of ['8-5', '8-12', '7a-9p', '7-9a', '7:30-4:30', '6-5', 'call', 'closed', '8-17']) assert.equal(A.hoursAsk(t), null, t);
});

// Real case: site.json and bids.json as committed Oct 19 2026.
const SITE = () => fx('admin-site.json');
const BIDS = fx('admin-bids.json');
const LOCS = [{ id: 'thorp', name: 'Thorp' }, { id: 'granton', name: 'Granton' }];
const fut = s => (BIDS.futures[s] ? BIDS.futures[s].price : (s === '@S7F' ? 12.665 : null));
const row = (D, com, label) => D.bids.rows.find(r => r.commodity === com && r.label === label);

test('typo guard: -0.06 for -0.60 on Fall 26 corn, one warning for both yards, in cents with the cash effect (C4)', () => {
  const O = SITE(), D = SITE();
  row(D, 'Corn', 'Fall 26').basis = { thorp: -0.06, granton: -0.06 };
  const rv = A.review(D, O, LOCS, true, fut);
  assert.deepEqual(rv.warn, ['Thorp and Granton Corn Fall 26: -0.06 is 54 cents higher than your last -0.60. Cash goes up 54 cents.']);
  assert.deepEqual(rv.lines, ['Thorp and Granton Corn Fall 26: cash $4.07 to $4.61 (basis -0.06)']);
});

test('typo guard: a newly turned-on month compares with the nearest shown month of the same crop (C4)', () => {
  const O = SITE(), D = SITE();
  D.bids.rows.push({ commodity: 'Corn', label: 'Nov 26', symbol: '@C6Z', show: true, basis: { thorp: -0.05, granton: -0.05 } });
  const rv = A.review(D, O, LOCS, true, fut);
  assert.deepEqual(rv.warn, ['Thorp and Granton Corn Nov 26 (new): -0.05 is 55 cents higher than your Fall 26 basis -0.60.']);
  assert.deepEqual(rv.lines, ['Thorp and Granton Corn Nov 26: cash new to $4.62 (basis -0.05)']);
});

test('typo guard: a changed contract still compares with the saved basis and states the cash move (C4)', () => {
  const O = SITE(), D = SITE(), r = row(D, 'Soybeans', 'Fall 26');
  r.symbol = '@S7F'; r.basis = { thorp: -0.45, granton: -0.45 }; // Nov 26 12.535 -> Jan 27 12.665
  const rv = A.review(D, O, LOCS, true, fut);
  assert.deepEqual(rv.warn, ['Thorp and Granton Soybeans Fall 26: -0.45 is 30 cents higher than your last -0.75. Cash goes up 43 cents.']);
  assert.equal(rv.lines[0], 'Soybeans Fall 26: futures Nov 26 to Jan 27.');
});

test('typo guard: Granton far from Thorp is flagged when the yards differ; small moves stay quiet', () => {
  const O = SITE(), D = SITE();
  row(D, 'Corn', 'Fall 26').basis = { thorp: -0.58, granton: -0.95 };
  const rv = A.review(D, O, LOCS, false, fut);
  assert.deepEqual(rv.warn, ['Granton Corn Fall 26: -0.95 is 35 cents lower than your last -0.60. Cash goes down 35 cents.', 'Granton Corn Fall 26: -0.95 is 37 cents lower than Thorp -0.58.']);
  const quiet = SITE(); row(quiet, 'Corn', 'Fall 26').basis = { thorp: -0.58, granton: -0.58 };
  assert.deepEqual(A.review(quiet, O, LOCS, true, fut).warn, []);
});

test('save errors in plain words (C5): 401, no signal, 5xx', () => {
  assert.equal(A.errWords({ status: 401, message: 'Bad credentials' }, 'save'), 'Your key ran out or was deleted. Nothing saved. Make a new one (steps under "No key yet" in Change key) and paste it.');
  assert.equal(A.errWords({ offline: true, message: 'Failed to fetch' }, 'save'), 'No signal. Nothing saved. Try again.');
  assert.match(A.errWords({ status: 502 }, 'save'), /^GitHub is having trouble\. Nothing saved\./);
  assert.doesNotMatch(A.errWords({ status: 401, message: 'Bad credentials' }, 'save'), /Bad credentials/);
});

test('key expiry read from GitHub header', () => {
  assert.equal(A.expiryFromHeader('2027-01-17 06:00:00 UTC'), '2027-01-17');
  assert.equal(A.expiryFromHeader('2027-01-17 00:00:00 -0600'), '2027-01-17');
  assert.equal(A.expiryFromHeader(null), null);
});

test('merge: the other save touched different fields, both kept (C2)', () => {
  const base = SITE(), mine = SITE(), theirs = SITE();
  row(mine, 'Corn', 'Fall 26').basis = { thorp: -0.58, granton: -0.58 };
  mine.bids.basis_set = '2026-10-20T11:05:00Z';
  theirs.business.phone_note = 'call';                       // reviewer C's real 409 case
  theirs.notices = ['Closed Friday at noon'];
  const m = A.merge3(base, mine, theirs);
  assert.deepEqual(m.clashes, []);
  assert.equal(m.merged.business.phone_note, 'call');
  assert.deepEqual(m.merged.notices, ['Closed Friday at noon']);
  assert.deepEqual(row(m.merged, 'Corn', 'Fall 26').basis, { thorp: -0.58, granton: -0.58 });
  assert.equal(m.merged.bids.basis_set, '2026-10-20T11:05:00Z');
  assert.deepEqual(Object.keys(m.merged), Object.keys(theirs));
});

test('merge: rows matched by crop and month; a real clash is reported, not guessed', () => {
  const base = SITE(), mine = SITE(), theirs = SITE();
  row(mine, 'Corn', 'Fall 26').basis.thorp = -0.58;
  row(theirs, 'Corn', 'Fall 26').basis.thorp = -0.62;
  theirs.bids.rows.push({ commodity: 'Corn', label: 'Nov 26', symbol: '@C6Z', show: true, basis: { thorp: -0.55, granton: -0.55 } });
  row(mine, 'Soybeans', 'Fall 28').show = false;
  const m = A.merge3(base, mine, theirs);
  assert.equal(m.clashes.length, 1);
  assert.equal(A.pathWords(m.clashes[0].path), 'Corn Fall 26, Thorp basis');
  assert.equal(A.pathWords(['locations', 'thorp', 'hours', 'mon']), 'Thorp, Mon hours');
  assert.equal(row(m.merged, 'Corn', 'Fall 26').basis.thorp, -0.62);       // theirs unless told otherwise
  assert.equal(row(A.merge3(base, mine, theirs, true).merged, 'Corn', 'Fall 26').basis.thorp, -0.58);
  assert.ok(row(m.merged, 'Corn', 'Nov 26'));                              // their new row kept
  assert.equal(row(m.merged, 'Soybeans', 'Fall 28').show, false);          // my change kept
});

test('futures source per contract: says plainly when a shown price is not DTN (verdict 2)', () => {
  const shown = ['@C6Z', '@C7Z', '@S6X', '@S7F'];
  const b = Object.assign({}, BIDS, { futures_sources: { '@C6Z': 'dtn', '@C7Z': 'yahoo', '@S6X': 'dtn' } });
  assert.deepEqual(A.futuresSources(b, shown), { notDtn: [{ sym: '@C7Z', src: 'yahoo' }], missing: ['@S7F'], mixed: '' });
  // the file as it is today (no futures_sources, futures_source "dtn"): all DTN
  assert.deepEqual(A.futuresSources(BIDS, ['@C6Z', '@S6X']), { notDtn: [], missing: [], mixed: '' });
  assert.equal(A.futuresSources(Object.assign({}, BIDS, { futures_source: 'dtn+yahoo' }), ['@C6Z']).mixed, 'dtn+yahoo');
});

test('key expiry: warns from 14 days out, quiet before, says expired after', () => {
  assert.deepEqual(A.keyState('', '2026-10-19'), { level: 'unknown' });
  assert.equal(A.keyState('2027-01-17', '2026-10-19').level, 'ok');
  assert.deepEqual(A.keyState('2026-11-02', '2026-10-19'), { level: 'soon', days: 14, exp: '2026-11-02' });
  assert.equal(A.keyState('2026-11-03', '2026-10-19').level, 'ok');
  assert.equal(A.keyState('2026-10-18', '2026-10-19').level, 'expired');
});

const CAL = fx('admin-cbot.json');
test('contract calendar: file dates, and the CME rule agrees with them (verdict 1)', () => {
  assert.deepEqual(A.contractDates('@S6X', CAL), { fnd: '2026-10-30', ltd: '2026-11-13' });
  for (const s of Object.keys(CAL.contracts)) assert.deepEqual(A.contractDates(s, { holidays: CAL.holidays, contracts: {} }), CAL.contracts[s], s);
  assert.equal(A.dayWords('2026-10-30'), 'Fri Oct 30');
  assert.equal(A.nextContract('@S6X'), '@S7F');
  assert.equal(A.nextContract('@C6Z'), '@C7H');
  assert.equal(A.nextContract('@S7U'), '@S7X');
});

test('roll: Fall 26 soybeans on Nov 26 futures, real dates', () => {
  assert.equal(A.rollState('@S6X', '2026-10-19', CAL), null);                    // 9 business days out
  assert.equal(A.rollState('@S6X', '2026-10-23', CAL).level, 'near');            // Oct 26-30 is 5
  assert.equal(A.rollState('@S6X', '2026-10-22', CAL), null);
  assert.equal(A.rollState('@S6X', '2026-10-30', CAL).level, 'notice');
  assert.equal(A.rollState('@S6X', '2026-11-13', CAL).level, 'notice');          // last trade day itself
  assert.equal(A.rollState('@S6X', '2026-11-14', CAL).level, 'expired');
  assert.equal(A.rollState('@C6Z', '2026-11-20', CAL).level, 'near');            // Thanksgiving Nov 26 not counted
  assert.equal(A.rollState('@C6Z', '2026-11-19', CAL), null);
  // keep cash the same: -0.75 on Nov 12.535 -> Jan 12.665 gives -0.88
  assert.equal(A.rollBasis(-0.75, 12.535, 12.665), -0.88);
  assert.equal(A.rollBasis(-0.75, 12.535, null), null);
});
