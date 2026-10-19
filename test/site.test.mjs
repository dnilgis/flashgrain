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

// Central times as UTC: CST is UTC-6 from Nov 1 2026.
const at = (iso) => new Date(iso);

test("cbotOpen: Thanksgiving Thu Nov 26 2026 closed all day, no Wed or Thu night session", () => {
  const FG = loadFG(CAL);
  assert.equal(FG.cbotOpen(at("2026-11-25T17:00:00Z")), true, "Wed 11 AM CT: normal day");
  assert.equal(FG.cbotOpen(at("2026-11-26T02:00:00Z")), false, "Wed 8 PM CT: overnight into Thanksgiving does not open");
  assert.equal(FG.cbotOpen(at("2026-11-26T16:00:00Z")), false, "Thu 10 AM CT: holiday");
  assert.equal(FG.cbotOpen(at("2026-11-27T02:00:00Z")), false, "Thu 8 PM CT: no night session before the half day");
  assert.equal(FG.cbotOpen(at("2026-11-27T12:00:00Z")), false, "Fri 6 AM CT: still no overnight");
});

test("cbotOpen: Fri Nov 27 2026 early close 12:05 PM CT", () => {
  const FG = loadFG(CAL);
  assert.equal(FG.cbotOpen(at("2026-11-27T15:00:00Z")), true, "Fri 9 AM CT open");
  assert.equal(FG.cbotOpen(at("2026-11-27T18:04:00Z")), true, "12:04 PM CT open");
  assert.equal(FG.cbotOpen(at("2026-11-27T18:05:00Z")), false, "12:05 PM CT closed");
  assert.equal(FG.cbotOpen(at("2026-11-27T19:00:00Z")), false, "1 PM CT closed");
});

test("cbotOpen: Christmas and New Year 2026-27, normal weeks unchanged", () => {
  const FG = loadFG(CAL);
  assert.equal(FG.cbotOpen(at("2026-12-25T16:00:00Z")), false, "Fri Dec 25");
  assert.equal(FG.cbotOpen(at("2026-12-25T02:00:00Z")), false, "Thu Dec 24 8 PM CT: overnight into Christmas");
  assert.equal(FG.cbotOpen(at("2027-01-01T16:00:00Z")), false, "Fri Jan 1");
  assert.equal(FG.cbotOpen(at("2027-01-04T02:00:00Z")), true, "Sun Jan 3 8 PM CT: opens as usual");
  for (const FGx of [FG, loadFG()]) {
    assert.equal(FGx.cbotOpen(at("2026-10-19T15:00:00Z")), true, "Mon 10 AM CDT");
    assert.equal(FGx.cbotOpen(at("2026-10-19T18:50:00Z")), false, "Mon 1:50 PM CDT, after the 1:20 close");
    assert.equal(FGx.cbotOpen(at("2026-10-20T01:00:00Z")), true, "Mon 8 PM CDT overnight");
    assert.equal(FGx.cbotOpen(at("2026-10-24T17:00:00Z")), false, "Saturday");
    assert.equal(FGx.cbotOpen(at("2026-10-26T00:30:00Z")), true, "Sun 7:30 PM CDT");
  }
  const none = loadFG();
  assert.equal(none.cbotOpen(at("2026-11-26T16:00:00Z")), true, "without the calendar file: weekly hours only, as before");
});

test("closeLabel: harvester run time (quote_time_source run) over weekends, holidays and early closes", () => {
  const FG = loadFG(CAL);
  assert.equal(FG.closeLabel("2026-10-24T09:10:00"), "Fri close", "Saturday read");
  assert.equal(FG.closeLabel("2026-10-25T18:00:00"), "Fri close", "Sunday before the open");
  assert.equal(FG.closeLabel("2026-10-25T19:10:00"), "Sun 7:10 PM", "Sunday night session: a live time");
  assert.equal(FG.closeLabel("2026-10-19T13:50:00"), "Mon close", "after the 1:20 close");
  assert.equal(FG.closeLabel("2026-10-19T10:00:00"), "Mon 10 AM");
  assert.equal(FG.closeLabel("2026-11-26T10:00:00"), "Wed close", "Thanksgiving read");
  assert.equal(FG.closeLabel("2026-11-26T20:00:00"), "Wed close", "Thanksgiving night, no session");
  assert.equal(FG.closeLabel("2026-11-27T06:00:00"), "Wed close", "Friday before the half day opens");
  assert.equal(FG.closeLabel("2026-11-27T12:30:00"), "Fri close", "after the 12:05 early close");
  assert.equal(FG.closeLabel("2026-11-28T09:00:00"), "Fri close");
  assert.equal(FG.closeLabel(null), "", "null quote_time breaks nothing");
  assert.equal(loadFG().closeLabel("2026-10-24T09:10:00"), "Fri close", "no calendar: as before");
});
