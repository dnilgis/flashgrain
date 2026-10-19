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
