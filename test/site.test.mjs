// node --test test/   (pure helpers of assets/js/site.js, loaded in a vm like tools/feed.mjs does)
import test from "node:test";
import assert from "node:assert/strict";
import { loadFG, fixture } from "./site-lib.mjs";

const CAL = fixture("site-cbot.json");
const BIDS = fixture("site-bids.json"); // real data/bids.json of 2026-10-19 18:50Z

test("expiry: Nov 26 soybeans (@S6X, LTD Fri Nov 13 2026) quote until the 13th, dash from the 14th (Central)", () => {
  const FG = loadFG(CAL);
  assert.equal(FG.quote("@S6X", BIDS.futures, new Date("2026-10-19T19:00:00Z")).price, 12.535);
  assert.equal(FG.expired("@S6X", new Date("2026-11-13T20:00:00Z")), false, "last trading day itself still trades");
  assert.equal(FG.expired("@S6X", new Date("2026-11-14T05:30:00Z")), false, "Nov 13 11:30 PM CT is still the 13th");
  assert.equal(FG.expired("@S6X", new Date("2026-11-14T06:30:00Z")), true, "Nov 14 12:30 AM CT");
  assert.equal(FG.quote("@S6X", BIDS.futures, new Date("2026-11-16T15:00:00Z")), null, "Yahoo's final settle is not a price to bid on");
});

test("expiry: Dec 26 corn LTD Mon Dec 14, July 27 corn LTD Jul 14 2027", () => {
  const FG = loadFG(CAL);
  assert.equal(FG.expired("@C6Z", new Date("2026-12-14T18:00:00Z")), false);
  assert.equal(FG.expired("@C6Z", new Date("2026-12-15T18:00:00Z")), true);
  assert.equal(FG.expired("@C7N", new Date("2027-07-15T18:00:00Z")), true);
  assert.equal(FG.quote("@C7Z", BIDS.futures, new Date("2026-12-15T18:00:00Z")).price, 5.0425, "Dec 27 still trades");
});

test("expiry: no calendar, or a contract not in it, behaves as before", () => {
  const FG = loadFG();
  assert.equal(FG.expired("@S6X", new Date("2026-12-01T18:00:00Z")), false);
  assert.equal(FG.quote("@S6X", BIDS.futures, new Date("2026-12-01T18:00:00Z")).price, 12.535);
  const FG2 = loadFG(CAL);
  assert.equal(FG2.expired("@C8Z", new Date("2029-01-01T18:00:00Z")), false);
  assert.equal(FG2.quote("@C9H", BIDS.futures), null, "no quote at all is still null");
  assert.equal(FG2.quote("@C6Z", { "@C6Z": { price: null } }), null, "null price is null");
});
