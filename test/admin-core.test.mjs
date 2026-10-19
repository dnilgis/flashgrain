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
