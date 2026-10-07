// Writes feed/<location>.json: Flash Grain's posted cash bids as a machine-readable feed,
// one file per yard, in the emmert-cash-bids/2 schema that dnilgis/bids already reads for
// Badger Grain and Midwest Commodity (lib/adapters/emmert.mjs there).
//
// The numbers are the public page's numbers, computed by the page's own code: site.js is
// loaded and its money() and labelUntil() are called, so a row is in the feed exactly when
// it is on flshgrn.com and its cash is the same cent. A second copy of that arithmetic here
// would be the copy that drifts.
//
// Cash and basis only. No futures price goes in the feed (same as the Emmert feeds), so
// nothing exchange-licensed is republished by it.
//
//   node tools/feed.mjs             write feed/*.json from data/site.json + data/bids.json
//   node tools/feed.mjs --selftest  no files, no network
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FEED_MAX_AGE_MIN = 120; // site.js withholds cash past this; the feed withdraws at the same line
const TZ = "America/Chicago";

function pageHelpers() {
  const window = {};
  const document = { getElementById: () => null }; // no board: site.js exports FG and stops
  vm.runInNewContext(readFileSync(join(ROOT, "assets/js/site.js"), "utf8"), { window, document, Intl, Date, Math });
  if (!window.FG || typeof window.FG.money !== "function" || typeof window.FG.labelUntil !== "function")
    throw new Error("site.js did not export FG.money / FG.labelUntil");
  return window.FG;
}

// One yard's feed. now: Date. Returns the object written to feed/<id>.json.
export function build(site, bids, locId, now, FG) {
  const ymNow = now.toLocaleDateString("en-CA", { timeZone: TZ }).slice(0, 7);
  const ageMin = (now.getTime() - Date.parse(bids.checked || bids.updated || "")) / 60000;
  const fresh = Number.isFinite(ageMin) && ageMin <= FEED_MAX_AGE_MIN;
  const out = [];
  for (const r of site.bids.rows) {
    if (!r.show) continue;
    const u = FG.labelUntil(r.label);
    if (u && u < ymNow) continue; // delivery period over: off the page, off the feed
    const f = bids.futures && bids.futures[r.symbol];
    const b = r.basis ? r.basis[locId] : null;
    if (typeof b !== "number" || !isFinite(b) || !f || typeof f.price !== "number" || !isFinite(f.price)) continue;
    out.push({ commodity: r.commodity, delivery: r.label, basis: Number(FG.basis(b)), cashPrice: Number(FG.money(f.price + b)) });
  }
  return {
    schema: "emmert-cash-bids/2",
    generated: now.toISOString(),
    observed: bids.checked || null, // when the harvester last checked the futures behind these prices
    pricedAt: bids.updated || null, // when those futures last moved
    status: fresh && out.length ? "ok" : fresh ? "no-bids" : "stale",
    terms: {
      note: "Flash Grain's own posted cash bids and basis, as shown on flshgrn.com. No exchange-licensed futures prices are included. Bids are indications, not offers, and change without notice. Call the elevator to confirm before hauling.",
      contact: (site.business && site.business.email) || null,
    },
    location: (site.locations.find((l) => l.id === locId) || {}).name || locId,
    count: out.length,
    bids: out,
  };
}

function selftest() {
  const FG = pageHelpers();
  const ok = (c, m) => { if (!c) { console.error("FAIL " + m); process.exitCode = 1; } else console.log("ok   " + m); };
  const now = new Date("2026-10-07T18:00:00Z");
  const site = {
    business: { email: "office@example.com" },
    locations: [{ id: "thorp", name: "Thorp", bids: true }, { id: "granton", name: "Granton", bids: true }],
    bids: { rows: [
      { commodity: "Corn", label: "Fall 26", symbol: "@C6Z", show: true, basis: { thorp: -0.6, granton: -0.55 } },
      { commodity: "Corn", label: "Sep 26", symbol: "@C6U", show: true, basis: { thorp: -0.5 } },     // past: dropped
      { commodity: "Corn", label: "Mar 27", symbol: "@C7H", show: false, basis: { thorp: -0.4 } },    // off: dropped
      { commodity: "Soybeans", label: "Fall 26", symbol: "@S6X", show: true, basis: { thorp: -0.75 } },
      { commodity: "Soybeans", label: "Jan 27", symbol: "@S7F", show: true, basis: { thorp: -0.7 } }, // no futures: dropped
    ] },
  };
  const bids = { checked: "2026-10-07T17:55:00Z", updated: "2026-10-07T17:41:00Z",
    futures: { "@C6Z": { price: 5.0125 }, "@C6U": { price: 4.9 }, "@S6X": { price: 12.9425 } } };
  const t = build(site, bids, "thorp", now, FG);
  ok(t.status === "ok" && t.count === 2, "thorp: 2 rows on the page -> 2 rows in the feed, status ok");
  ok(t.bids[0].cashPrice === Number(FG.money(5.0125 - 0.6)) && t.bids[0].cashPrice === 4.41, "cash is the page's money(): 501'2 - 0.60 = 4.41");
  ok(t.bids[1].cashPrice === 12.19, "beans 1294'2 - 0.75 = 12.19 (page rounding)");
  ok(!JSON.stringify(t).includes("5.0125") && !("futures" in t.bids[0]), "no futures price in the feed");
  ok(t.observed === bids.checked && t.pricedAt === bids.updated, "observed = harvester check, pricedAt = last move");
  const g = build(site, bids, "granton", now, FG);
  ok(g.count === 1 && g.bids[0].basis === -0.55 && g.location === "Granton", "granton uses its own basis; rows without a granton basis are left out");
  const stale = build(site, { ...bids, checked: "2026-10-07T15:00:00Z" }, "thorp", now, FG);
  ok(stale.status === "stale", "harvester silent 3h -> status stale (the page hides cash at 2h too)");
  const none = build({ ...site, bids: { rows: [] } }, bids, "thorp", now, FG);
  ok(none.status === "no-bids" && none.count === 0, "nothing posted -> status no-bids");
}

if (process.argv.includes("--selftest")) selftest();
else {
  const FG = pageHelpers();
  const site = JSON.parse(readFileSync(join(ROOT, "data/site.json"), "utf8"));
  const bids = JSON.parse(readFileSync(join(ROOT, "data/bids.json"), "utf8"));
  const now = new Date();
  mkdirSync(join(ROOT, "feed"), { recursive: true });
  for (const l of site.locations.filter((x) => x.bids)) {
    const f = build(site, bids, l.id, now, FG);
    writeFileSync(join(ROOT, "feed", l.id + ".json"), JSON.stringify(f, null, 1) + "\n");
    console.log(`feed/${l.id}.json: ${f.status}, ${f.count} row(s)`);
  }
}
