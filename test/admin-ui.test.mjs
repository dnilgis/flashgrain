// The admin page in a real browser, GitHub stubbed with this repo's own files (no token, no network).
// Needs Playwright and Chromium; skips when they are not installed. PLAYWRIGHT_DIR and CHROMIUM override the paths.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PW = process.env.PLAYWRIGHT_DIR || '/home/user/node_modules/playwright';
const CHROME = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
let chromium = null;
try { chromium = createRequire(import.meta.url)(PW).chromium; } catch (e) { /* skipped below */ }
const skip = !chromium || !existsSync(CHROME) ? 'Playwright or Chromium not installed' : false;

const fx = f => readFileSync(join(ROOT, 'test/fixtures', f), 'utf8');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
let server, base, browser;
before(async () => {
  if (skip) return;
  server = createServer((q, r) => {
    let p = decodeURIComponent(q.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
    // the page reads ace.json from the site; serve the fixture so the test never depends on today's board
    const f = p === '/data/refs/ace.json' ? join(ROOT, 'test/fixtures/admin-ref-ace.json') : join(ROOT, p);
    if (!f.startsWith(ROOT) || !existsSync(f)) { r.writeHead(404); return r.end(); }
    r.writeHead(200, { 'content-type': TYPES[extname(f)] || 'application/octet-stream' }); r.end(readFileSync(f));
  });
  await new Promise(res => server.listen(0, '127.0.0.1', res));
  base = 'http://127.0.0.1:' + server.address().port;
  browser = await chromium.launch({ executablePath: CHROME });
});
after(async () => { if (browser) await browser.close(); if (server) server.close(); });

const b64 = s => Buffer.from(s).toString('base64');
const H = { 'access-control-allow-origin': '*' };
// now: fake clock (ISO). site/bids/cbot: file text served by the GitHub stub. Returns the page and the stub's state.
async function open(o = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  if (o.now) await ctx.addInitScript(`(() => { const off = ${Date.parse(o.now)} - Date.now(), D = Date;
    class FD extends D { constructor(...a) { if (a.length) super(...a); else super(D.now() + off); } static now() { return D.now() + off; } } Date = FD; })();`);
  await ctx.addInitScript(`localStorage.setItem('fg-token', 'NOT_A_REAL_TOKEN')`); // remembered key: the page loads by itself
  const page = await ctx.newPage();
  const st = { site: o.site || fx('admin-site.json'), files: { 'bids.json': o.bids || fx('admin-bids.json'), 'cbot.json': o.cbot || null }, puts: [], dialogs: 0, on409: o.on409 };
  page.on('dialog', d => { st.dialogs++; d.dismiss(); });
  await page.route('https://raw.githubusercontent.com/**', r => r.fulfill({ status: 404, body: '' }));
  await page.route('https://api.github.com/**', async r => {
    const u = r.request().url();
    if (r.request().method() === 'PUT') {
      const body = JSON.parse(r.request().postData()); st.puts.push(JSON.parse(Buffer.from(body.content, 'base64').toString()));
      if (st.on409) { st.site = JSON.stringify(st.on409(JSON.parse(st.site))); st.on409 = null; return r.fulfill({ status: 409, headers: H, contentType: 'application/json', body: '{"message":"does not match"}' }); }
      st.site = Buffer.from(body.content, 'base64').toString();
      return r.fulfill({ status: 200, headers: H, contentType: 'application/json', body: JSON.stringify({ content: { sha: 's' + st.puts.length }, commit: { html_url: 'https://github.com/x' } }) });
    }
    const name = Object.keys(st.files).find(k => u.includes('data/' + k)), text = name ? st.files[name] : st.site;
    if (text == null) return r.fulfill({ status: 404, headers: H, contentType: 'application/json', body: '{"message":"Not Found"}' });
    return r.fulfill({ status: 200, headers: H, contentType: 'application/json', body: JSON.stringify({ sha: 'sha' + text.length, content: b64(text) }) });
  });
  await page.goto(base + '/admin/');
  await page.waitForSelector('#editor:not([hidden])');
  return { page, st, ctx };
}
const rowOf = (page, com, label) => page.evaluate(([com, label]) => {
  for (const r of document.querySelectorAll('.bl-row')) if (r.closest('.bl-crop').querySelector('h3').textContent === com && r.querySelector('.bl-name').textContent === label) return '.bl-row[data-c="' + r.dataset.c + '"]';
}, [com, label]);

test('Jeff\'s morning: remembered key, Fall 26 corn -0.60 to -0.58, publish in 3 taps, no native dialog', { skip }, async () => {
  const { page, st, ctx } = await open();
  const R = await rowOf(page, 'Corn', 'Fall 26');
  await page.fill(R + ' [data-b=thorp]', '-0.58');                      // tap 1 + typing
  await page.click('#save');                                          // tap 2
  assert.equal(await page.evaluate(() => document.activeElement.id), 'sheet-back'); // Publish is never the default
  await page.click('#sheet-ok');                                      // tap 3
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('status2').textContent));
  assert.equal(st.dialogs, 0);
  assert.deepEqual(st.puts[0].bids.rows[0].basis, { thorp: -0.58, granton: -0.58 });
  await ctx.close();
});

test('typo -0.06 for -0.60 is shown in yellow on the review sheet, in cents with the cash effect (C4)', { skip }, async () => {
  const { page, st, ctx } = await open();
  await page.fill(await rowOf(page, 'Corn', 'Fall 26') + ' [data-b=thorp]', '-.06');
  await page.click('#save');
  assert.deepEqual(await page.$$eval('#sheet .sh-warn li', l => l.map(x => x.textContent)), ['Thorp and Granton Corn Fall 26: -0.06 is 54 cents higher than your last -0.60. Cash goes up 54 cents.']);
  await page.click('#sheet-back');
  assert.equal(st.puts.length, 0);
  await ctx.close();
});

test('save conflict: the other save touched another field, both kept without asking (C2)', { skip }, async () => {
  const { page, st, ctx } = await open({ on409: d => { d.business.phone_note = 'call'; return d; } });
  await page.fill('#notices', 'Open late Saturday');
  await page.click('#save');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('status2').textContent));
  const last = st.puts[st.puts.length - 1];
  assert.equal(st.puts.length, 2);
  assert.deepEqual(last.notices, ['Open late Saturday']);
  assert.equal(last.business.phone_note, 'call');
  await ctx.close();
});

test('hours "7-9" is asked, and saving waits for the answer (C3)', { skip }, async () => {
  const { page, st, ctx } = await open();
  const box = '#hours input[data-loc=thorp][data-d=mon]';
  await page.fill(box, '7-9'); await page.$eval(box, e => e.blur());
  assert.deepEqual(await page.$$eval('#hours-ask .a-pick', l => l.map(x => x.textContent)), ['7 AM to 9 PM', '7 AM to 9 AM']);
  await page.click('#save');                                     // the box gets the focus back: a real tap blurs it next
  assert.equal(st.puts.length, 0);
  assert.equal(await page.evaluate(() => document.activeElement.dataset.d), 'mon');
  assert.match(await page.$eval('#problems', e => e.textContent), /is "7-9" 7 AM to 9 PM or 7 AM to 9 AM\?/);
  await page.click('#hours-ask .a-pick >> nth=0');
  await page.click('#save');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('status2').textContent));
  assert.equal(st.puts[0].locations[0].hours.mon, '07:00-21:00');
  await ctx.close();
});

test('roll: Fall 26 soybeans on Nov 26 futures, Mon Oct 26: card, one tap to Jan 27, basis keeps cash (verdict 1)', { skip }, async () => {
  const bids = JSON.parse(fx('admin-bids.json')); bids.futures['@S7F'] = { price: 12.665, change: 0, time: null };
  const { page, st, ctx } = await open({ now: '2026-10-26T13:00:00Z', cbot: fx('admin-cbot.json'), bids: JSON.stringify(bids) });
  const cards = await page.$$eval('#cards .a-card', l => l.map(c => c.querySelector('p').textContent));
  assert.deepEqual(cards, ['Fall 26 soybeans use Nov 26 futures. First notice Fri Oct 30, last trade Fri Nov 13. Move to Jan 27?']);
  await page.click('#cards .a-main');
  const R = await rowOf(page, 'Soybeans', 'Fall 26');
  assert.equal(await page.$eval(R + ' [data-b=thorp]', e => e.value), '-0.88');
  assert.equal(await page.$eval(R + ' .bl-cash', e => e.textContent), '$11.79');
  await page.click('#save');
  assert.match(await page.$eval('#sheet .sh-warn', e => e.textContent), /-0\.88 is the suggested one/);
  await page.click('#sheet-ok');
  await page.waitForFunction(() => /^Saved/.test(document.getElementById('status2').textContent));
  const r = st.puts[0].bids.rows.find(x => x.commodity === 'Soybeans' && x.label === 'Fall 26');
  assert.deepEqual([r.symbol, r.basis], ['@S7F', { thorp: -0.88, granton: -0.88 }]);
  await ctx.close();
});

test('roll: past last trade the card is red and says the site shows a dash', { skip }, async () => {
  const { page, ctx } = await open({ now: '2026-11-16T13:00:00Z', cbot: fx('admin-cbot.json') });
  const c = await page.$eval('#cards .a-card', e => [e.className, e.textContent]);
  assert.equal(c[0], 'a-card stop');
  assert.match(c[1], /stopped trading Fri Nov 13\. The site shows a dash for this row until you move it\./);
  await ctx.close();
});
