/* Reference bids from Bushel "cashbidssingle" boards (Ace Ethanol, Stanley).
 *
 * Reads every entry in data/site.json `references` whose platform is "bushel",
 * parses the board with the vendored dnilgis/bids parser, keeps only the rows for
 * the named location and commodity, checks each row (cash = futures + basis, to
 * the cent), and writes data/refs/<id>.json.
 *
 *   node tools/refs_bushel.mjs                 fetch live, write if changed (or hourly heartbeat)
 *   node tools/refs_bushel.mjs --file page.html <id>   parse a saved page, print, write nothing
 *
 * A board page can carry several locations at once (Big River's carries seven).
 * Rows are kept only where the location name contains `location` from site.json;
 * if nothing matches, nothing is written and the locations that WERE found are
 * printed, so the right name can be set in one look.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractBids } from "./vendor/parse.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";
const HEARTBEAT_MS = 55 * 60 * 1000;

export function pick(html, ref) {
  const all = extractBids(html, ref.url);
  const locs = [...new Set(all.map((r) => r.location))];
  const coms = [...new Set(all.map((r) => r.commodity))];
  const want = (ref.location || "").toLowerCase();
  const com = (ref.commodity || "").toLowerCase();
  const rows = all.filter((r) => (!want || String(r.location).toLowerCase().includes(want))
    && String(r.commodity).toLowerCase().includes(com));
  if (!want && locs.length > 1) throw new Error(`the page has ${locs.length} locations (${locs.join(", ")}); set the location name for ${ref.id} in /admin`);
  if (!all.length) throw new Error(`no bids on the page (${html.length} bytes); served a shell or the layout changed`);
  if (!rows.length) throw new Error(`no ${ref.commodity} rows for location "${ref.location}". Locations on the page: ${locs.join(", ")}. Commodities: ${coms.join(", ")}`);
  const out = [], dropped = [];
  for (const r of rows) {
    if (r.cash == null || r.basis == null) { dropped.push(`${r.delivery}: no cash or basis`); continue; }
    if (r.futuresPrice != null && Math.abs((r.cash - r.basis) * 100 - r.futuresPrice) > 1.01) {
      dropped.push(`${r.delivery}: cash ${r.cash} - basis ${r.basis} != futures ${r.futuresPrice}c`); continue;
    }
    out.push({ label: r.delivery, cash: r.cash, basis: r.basis, futures_month: r.futures,
      futures: r.futuresPrice == null ? null : Math.round(r.futuresPrice * 100) / 10000 });
  }
  if (!out.length) throw new Error(`every ${ref.commodity} row failed its check: ${dropped.join("; ")}`);
  return { rows: out, dropped };
}

async function fetchPage(url) {
  let last;
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } catch (e) { last = e; await new Promise((s) => setTimeout(s, 5000)); }
  }
  throw new Error(`fetch failed: ${last && last.message}`);
}

// Why a read failed goes into the file (rows untouched): rewritten only when the reason changes, or hourly.
function noteError(path, ref, e) {
  const old = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : { id: ref.id, source: ref.url, rows: [] };
  const msg = String(e && e.message || e).slice(0, 400), now = new Date();
  if (old.error === msg && now - new Date(old.error_at || 0) < HEARTBEAT_MS) return;
  old.error = msg; old.error_at = now.toISOString().replace(/\.\d+Z$/, "Z");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(old, null, 1) + "\n");
}

async function main() {
  const site = JSON.parse(readFileSync(join(ROOT, "data/site.json"), "utf8"));
  const refs = (site.references || []).filter((r) => r.platform === "bushel");
  if (process.argv[2] === "--file") {
    const ref = refs.find((r) => r.id === process.argv[4]);
    console.log(JSON.stringify(pick(readFileSync(process.argv[3], "utf8"), ref), null, 1));
    return;
  }
  let failed = 0;
  for (const ref of refs) {
    const path = join(ROOT, "data/refs", `${ref.id}.json`);
    try {
      const { rows, dropped } = pick(await fetchPage(ref.url), ref);
      dropped.forEach((d) => console.error(`${ref.id} dropped: ${d}`));
      const old = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
      const now = new Date();
      const same = JSON.stringify(old.rows) === JSON.stringify(rows);
      if (same && now - new Date(old.checked || 0) < HEARTBEAT_MS) { console.log(`${ref.id}: no change`); continue; }
      const stamp = now.toISOString().replace(/\.\d+Z$/, "Z");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ id: ref.id, checked: stamp, updated: same ? old.updated || stamp : stamp,
        source: ref.url, quote_time: null, rows }, null, 1) + "\n");
      console.log(`${ref.id}: wrote ${rows.length} rows${same ? " (heartbeat)" : ""}`);
    } catch (e) {
      failed++;
      console.error(`${ref.id}: ${e.message}; rows left unchanged`);
      noteError(path, ref, e);
    }
  }
  if (failed) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
