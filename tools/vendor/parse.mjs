/* VENDORED from dnilgis/bids lib/parse.mjs at commit e4ba740, unchanged below this comment.
 * Used by tools/refs_bushel.mjs to read Bushel cashbidssingle boards (Ace Ethanol).
 * To update: copy the file again from dnilgis/bids and keep this header. */
/**
 * Adaptive cash-bid table parser.
 *
 * Written to survive layout churn on hosted elevator bid boards, where the
 * tables are server-rendered but the exact markup, column order and class
 * names differ per site and change when the host re-themes.
 *
 * Big River's board is FarmCentric: the page pulls portal.farmcentric.com and
 * its classes are fcControls*. It is NOT AgriCharts and NOT Barchart. An
 * earlier session asserted AgriCharts on nothing but co-occurrence in search
 * results, was asked "are u sure", and was wrong. This header said AgriCharts
 * for weeks after the rest of the kit was corrected. Do not reintroduce a
 * vendor name here that has not been read off the page itself.
 *
 * Strategy: find every <table> (including ones nested inside layout tables),
 * score each on whether its header row looks like a cash-bid table, then map
 * columns by header TEXT rather than by position. Nothing here depends on
 * class names, ids, or column order.
 *
 * Pure ES module with no dependencies, so the test suite exercises exactly the
 * code that runs in the job.
 */

/* ------------------------------------------------------------------ */
/* text helpers                                                        */
/* ------------------------------------------------------------------ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '-', mdash: '-', minus: '-', cent: 'c', deg: ' ',
};

export function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

export function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse a price-ish cell. Handles $4.32, 4.32, -.35, (0.35) as negative,
 * +0.02, 3.9500, and returns null for "N/A", "—", "", "Closed", etc.
 */
export function parseNum(text) {
  if (text == null) return null;
  let t = String(text).trim();
  if (!t) return null;
  let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  t = t.replace(/[$,\s]/g, '');
  const m = t.match(/^([+-]?)(\d*\.?\d+)/);
  if (!m) return null;
  const v = parseFloat(m[2]);
  if (!Number.isFinite(v)) return null;
  return (neg || m[1] === '-') ? -v : v;
}

/**
 * Normalize a basis quote to CENTS.
 *
 * Sites publish basis either as dollars (-0.35) or as cents (-35).
 *
 * THE MAGNITUDE HEURISTIC HAD A CLIFF AT THREE DOLLARS -- 2026-08-20.
 *
 * The old rule was magnitude alone: under 3 means dollars, 3 or over means
 * cents. New-crop soybean basis reaches minus three dollars in a weak market,
 * and on the day it crosses that line the published figure changes by 100x:
 *
 *     -2.99  ->  -299     correct
 *     -3.00  ->     -3    wrong, and the row before it on the same board is right
 *
 * Nothing downstream could see it. `checkIdentity` reads `basis` in DOLLARS,
 * so cash - basis = futures still balances on a row whose published
 * `basisCents` is out by a factor of a hundred, and `basisCents` is what the
 * Emmert sites render.
 *
 * So decide on the TEXT, which is what actually carries the unit: a board
 * quoting dollars writes a decimal point ("-0.52", "-.35", "-3.0500"), a board
 * quoting cents writes a bare integer ("-52"). The magnitude rule is kept only
 * for callers that have no text to offer, and `checkBasisUnits` in board.mjs
 * now cross-checks the result against cash and the futures quote, so a unit
 * error can no longer publish however it got here.
 */
export function basisToCents(v, raw) {
  if (v == null) return null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (/\.\d/.test(t)) return Math.round(v * 100);  // a decimal point means dollars
    if (t !== '') return Math.round(v);               // a bare integer means cents
  }
  return Math.abs(v) < 3 ? Math.round(v * 100) : Math.round(v);
}

/* ------------------------------------------------------------------ */
/* table extraction (depth-aware, so layout nesting can't break it)    */
/* ------------------------------------------------------------------ */

/** Return every table in the document as {start, end, inner, before}. */
export function sliceTables(html) {
  const tagRe = /<(\/?)table\b[^>]*>/gi;
  const stack = [];
  const out = [];
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    if (m[1] === '/') {
      const open = stack.pop();
      if (open === undefined) continue;
      out.push({
        start: open.start,
        end: tagRe.lastIndex,
        inner: html.slice(open.innerStart, m.index),
        before: html.slice(Math.max(0, open.start - 4000), open.start),
      });
    } else if (!/\/>$/.test(m[0])) {
      stack.push({ start: m.index, innerStart: tagRe.lastIndex });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** Rows of one table, with any nested tables blanked out first. */
function rowsOf(innerHtml) {
  // Blank nested tables so an outer layout table doesn't swallow inner rows.
  let s = innerHtml;
  const nested = sliceTables(s);
  if (nested.length) {
    // Only top-level nested tables matter; replace from the end to keep offsets.
    const top = [];
    let cursor = -1;
    for (const t of nested) {
      if (t.start > cursor) { top.push(t); cursor = t.end; }
    }
    for (let i = top.length - 1; i >= 0; i--) {
      s = s.slice(0, top[i].start) + ' ' + s.slice(top[i].end);
    }
  }
  const rows = [];
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(s)) !== null) {
    const cells = [];
    const cellRe = /<(t[hd])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    let c;
    while ((c = cellRe.exec(m[1])) !== null) {
      const span = /colspan\s*=\s*"?(\d+)/i.exec(c[2]);
      cells.push({
        text: stripTags(c[3]),
        header: c[1].toLowerCase() === 'th',
        colspan: span ? parseInt(span[1], 10) : 1,
      });
    }
    if (cells.length) rows.push(cells);
  }
  return rows;
}

/* ------------------------------------------------------------------ */
/* column mapping by header text                                       */
/* ------------------------------------------------------------------ */

const COLUMN_PATTERNS = [
  ['basis', /\bbasis\b/i],
  ['change', /\b(change|chg|net\s*chg|net)\b/i],
  // "Futures Month" must be tested before both "Futures" and the delivery
  // pattern (which matches the bare word "month"), or it steals a column.
  ['futuresMonth', /\b(futures\s*month|contract\s*month|board\s*month)\b/i],
  ['futures', /\b(futures|board|month\s*symbol|symbol)\b/i],
  /* THE CLOCK ON THEIR FUTURES CELL.
   *
   * Added 2026-08-19. Their board grew a seventh column, "Last Trade", giving
   * the time each futures quote was struck -- and it is the only thing on the
   * page that can tell a stale futures cell from a moved column. Both look
   * identical to the identity check: cash minus basis does not equal the
   * quote, and the size of the gap says nothing about which it was.
   *
   * Captured for the log, NOT for the published file. It changes on nearly
   * every poll, and `priceChanged` diffs the published rows, so carrying it
   * in the file would commit a "price change" every few minutes recording
   * nothing but their clock ticking.
   *
   * Must be tested before `updated`, whose pattern matches the bare word
   * "time" and would otherwise take a column named "Last Trade Time". */
  ['lastTrade', /\blast\s*trade\b/i],
  ['delivery', /\b(delivery|deliv|shipment|ship|period|movement|month|time\s*frame)\b/i],
  ['cash', /\b(cash|bid|price|net\s*price|cash\s*price)\b/i],
  ['commodity', /\b(commodity|grain|product|crop)\b/i],
  ['location', /\b(location|elevator|facility|plant|branch|site|city|terminal)\b/i],
  ['updated', /\b(updated|as\s*of|time)\b/i],
];

/** Map header cells -> {field: columnIndex}. Returns null if not bid-like. */
export function mapHeader(cells) {
  const map = {};
  cells.forEach((cell, i) => {
    const t = cell.text;
    if (!t) return;
    for (const [field, re] of COLUMN_PATTERNS) {
      if (map[field] !== undefined) continue;
      if (re.test(t)) { map[field] = i; break; }
    }
  });
  // A cash-bid table must quote a price or a basis, and must say what the
  // quote is FOR (a commodity or a delivery period).
  const hasQuote = map.cash !== undefined || map.basis !== undefined;
  const hasSubject = map.commodity !== undefined || map.delivery !== undefined;
  return hasQuote && hasSubject ? map : null;
}

/** Nearest heading text above a table — often the location name. */
function headingBefore(before) {
  const heads = [...before.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi)];
  if (heads.length) {
    const t = stripTags(heads[heads.length - 1][1]);
    if (t) return t;
  }
  const caps = [...before.matchAll(/<caption\b[^>]*>([\s\S]*?)<\/caption>/gi)];
  if (caps.length) {
    const t = stripTags(caps[caps.length - 1][1]);
    if (t) return t;
  }
  return null;
}

const JUNK_ROW = /^(commodity|cash bids?|prices?|delivery|basis|futures|change)$/i;

/* ------------------------------------------------------------------ */
/* main entry points                                                   */
/* ------------------------------------------------------------------ */

/**
 * Everything the parser can see, for the /debug route: every table, its
 * header row, whether it mapped, and a couple of sample rows.
 */
export function describeTables(html) {
  return sliceTables(html).map((t, i) => {
    const rows = rowsOf(t.inner);
    const headerRow = rows.find((r) => mapHeader(r) !== null);
    return {
      index: i,
      rows: rows.length,
      heading: headingBefore(t.before),
      headerCells: headerRow ? headerRow.map((c) => c.text) : null,
      mapped: headerRow ? mapHeader(headerRow) : null,
      sample: rows.slice(0, 4).map((r) => r.map((c) => c.text)),
    };
  });
}

/* ------------------------------------------------------------------ */
/* layout B: column-lists (FarmCentric fcControls, Bushel, and similar) */
/* ------------------------------------------------------------------ */
/*
 * These sites don't use tables for cash bids at all. A block looks like:
 *
 *   <h3 class='fcControls'>CORN</h3>
 *   <ul class='sixColumnsBigFirst fcControlsSubHdr'>
 *     <li class='c1'><h4>Delivery</h4></li><li class='c2'><h4>Bid</h4></li> …
 *   <ul class='sixColumnsBigFirst fcControls1'>
 *     <li class='c1'><span>August</span><img onclick="showChart('…CashBidsLocationID=2121…')"></li>
 *     <li class='c2'>4.0750</li><li class='c3'>-0.5200</li> …
 *
 * Two things make this parseable reliably:
 *   1. the header <ul> gives the column meaning, same as a <thead>
 *   2. every data row carries CashBidsLocationID in its chart link — a numeric
 *      location key, far safer to filter on than a display name
 *
 * One page contains a tab panel per location, so /cashbidssingle-2121 holds
 * every location's bids; the id is what tells them apart.
 */

/** Map numeric location ids to names using the site's own nav links. */
export function locationNames(html) {
  const map = new Map();
  for (const m of html.matchAll(/cashbidssingle-(\d+)['"]?\s*>\s*([^<]{1,60})</gi)) {
    const name = stripTags(m[2]);
    if (name && !map.has(m[1])) map.set(m[1], name);
  }
  return map;
}

/* THE LOCATIONS ARE A TAB STRIP, AND THE TABS ARE NOT LINKS.
 *
 * Run 91871303720 read Hillsdale Elevator Company: 18 locations, 126 rows, and
 * not one "cashbidssingle-<id>" reference in 267,641 bytes, so every location
 * came back as "location 3559". The names were on the page the whole time:
 *
 *   <div id='CashBidsLocationTabs_100'>
 *     <ul class='resp-tabs-list'>
 *       <li><div><span>Hillsdale/Fenton</span></div></li>
 *       <li><div><span>Annawan</span></div></li>          … 18 of them
 *     </ul>
 *     <div class='resp-tabs-container'>
 *       <div> … rows carrying CashBidsLocationID=3559 … </div>
 *       <div> … CashBidsLocationID=3560 … </div>
 *
 * A responsive tab widget: the strip and the panels are siblings, written in
 * one pass by the same control, so the nth tab labels the nth panel.
 *
 * THE CONTAINER ID IS THE DISCRIMINATOR, NOT THE POSITION OF THE <ul>. That
 * page has TWO `resp-tabs-list` strips and the first one is the FUTURES
 * commodity tabs -- Corn, Soybeans, Wheat, Live Cattle. Taking "the tab strip"
 * would have named eighteen elevators after cattle contracts. The cash-bid
 * strip is the one inside `<div id="CashBidsLocationTabs…">`, which the vendor
 * names for us.
 *
 * THIS IS POSITIONAL, WHICH IS WHY THE COUNTS MUST AGREE. Pairing by position
 * is the weakest join in this repository, so it is only made when the strip
 * has exactly as many tabs as the board has distinct location ids. Eighteen
 * and eighteen is a widget rendered in step; anything else is a page whose
 * shape has changed, and a wrong town on a real elevator is worse than no town
 * at all. On a disagreement this returns nothing and the ids stand.
 *
 * Measured across the eight boards captured 2026-09-04: Hillsdale 18/18, and
 * Dakota Midland one tab ("Voltaire") for a board that keys no rows at all --
 * the single-location case, which is why zero ids and one tab still answers. */
export function locationTabNames(html) {
  const s = String(html ?? "");
  const box = s.match(
    /<div[^>]*id=["']CashBidsLocationTabs[^"']*["'][^>]*>[\s\S]*?<ul[^>]*class=["'][^"']*\bresp-tabs-list\b[^"']*["'][^>]*>([\s\S]*?)<\/ul>/i);
  if (!box) return { names: [], why: "no CashBidsLocationTabs strip on the page" };
  const names = [...box[1].matchAll(/<span[^>]*>([^<]{1,60})<\/span>/gi)]
    .map((m) => stripTags(m[1])).filter(Boolean);
  return { names, why: names.length ? null : "the tab strip carries no span labels" };
}

/** Names for ids the nav did not give, from the tab strip, or an empty map. */
export function tabLocationNames(html, ids) {
  const { names } = locationTabNames(html);
  if (!names.length) return new Map();
  const seen = [...new Set(ids.filter((i) => i != null).map(String))];
  if (seen.length && seen.length !== names.length) return new Map();
  if (!seen.length) return names.length === 1 ? new Map([[null, names[0]]]) : new Map();
  return new Map(seen.map((id, i) => [id, names[i]]));
}

/** The status letter their futures cell carries after the price, or null.
 *
 * Once a contract settles the cell becomes "473-0s" -- the trailing "s" is
 * "settled", not part of the number. Diagnostic only: it is NOT published, for
 * the same reason the Last Trade column is not. It flips once a day at 1:20pm
 * Central and `priceChanged()` diffs the published rows, so carrying it would
 * commit a "price change" every afternoon recording nothing but their clock. */
export function tickFlag(text) {
  if (text == null) return null;
  /* A SETTLE MARKER IS NOT ONLY EVER ON A TICK QUOTE.
   *
   * This matched `\d+-\d+` and nothing else, so it read the "s" on Big River's
   * `513-6s` and dropped it from Ace Ethanol's `4.7875s` -- the same vendor
   * family, the same meaning, a different way of writing the number. Found
   * 2026-08-20 from Sig's paste of aceethanol.com/cashbidssingle-3578, where
   * every one of fourteen rows carries the marker and none of them was flagged.
   *
   * Ticks, eighths with an apostrophe, and plain decimals all now count. The
   * flag is still diagnostic and is still never published. */
  const m = String(text).trim()
    .match(/^[+-]?\d+(?:[-'\u2019]\d+|\.\d+)?([a-zA-Z]+)$/);
  return m ? m[1].toLowerCase() : null;
}

/** "459-4" -> 459.5 ; "+0-4" -> 0.5 ; "513-6s" -> 513.75 ; plain numbers pass through.
 *
 * THE SETTLE FLAG -- 2026-08-19.
 * Their board appends a status letter to the futures price once the contract
 * settles: "513-6s". Until this was fixed the pattern was anchored with `$`
 * and made no allowance for it, so a settled quote fell through to parseNum(),
 * whose own regex is NOT end-anchored:
 *
 *     parseNum("513-6s")  ->  513        the eighths silently discarded
 *
 * Two rows quoting Mar 27 corn at 513-6s were read as 513, the identity came
 * out 0.75c short, and the reader refused a board that was entirely correct.
 * Every run after the 1:20pm settle failed the same way, the feed froze at
 * 18:16Z, and both Emmert sites were eleven hours from withdrawing a price.
 *
 * WHY IT HID. The truncation is invisible whenever a contract settles on a
 * whole cent: "473-0s" and "498-0s" parse to 473 and 498, which are the right
 * answers, by luck. It shows only on a contract settling on an eighth, and
 * only after 1:20pm Central. On 2026-08-19 Sep 26 and Dec 26 settled flat
 * while Mar 27 settled 513-6 -- which is why exactly two of seven rows failed,
 * and why the diagnosis kept coming back as "their board disagrees with
 * itself". It did not. We were reading it wrong.
 *
 * NO SILENT FALLBACK. A string that starts like a tick quote and does not
 * fully parse now returns null, which refuses, rather than a truncated number
 * that balances nowhere and blames the source. Absent beats wrong. */
export function parseTicks(text) {
  if (text == null) return null;
  const t = String(text).trim();

  /* THE SEPARATOR IS NOT ALWAYS A HYPHEN -- 2026-08-20.
   *
   * Big River writes Sep corn as "459-2". DTN's cash-bids widget, seen on
   * agpartners.net, writes the same quote as "478'6" -- an apostrophe, which is
   * the ordinary trade notation for eighths and is what the CME itself prints.
   * The hyphen-only pattern did not match it, the tick-shaped refusal below did
   * not match it either, and parseNum() then returned the leading integer:
   *
   *     parseTicks("478'6")  ->  478        the six eighths silently discarded
   *
   * Three quarters of a cent, thrown away with no signal, on every row. This is
   * the settle-flag bug of 2026-08-19 arriving through a different door, and it
   * is why that one's rule was written down: a number that parses is not a
   * number that parsed correctly.
   *
   * Confirmed against their own board before changing anything: Ag Partners
   * shows cash 4.35, basis -0.43, futures 478'6. 4.35 + 0.43 is 4.78, which is
   * NOT 478.75 -- until you notice their cash cell is rounded to two decimals
   * and the underlying figure is 4.3575. Three rows check out that way
   * (4.3575/-0.43/478'6, 4.3775/-0.41/478'6, 4.4675/-0.57/503'6), so the
   * apostrophe really is eighths and their display really is rounded. Both
   * facts matter: the second is why that source will need cashRoundingCents. */
  const m = t.match(/^([+-]?)(\d+)['\u2019-](\d+)([a-zA-Z]*)$/);
  if (m) {
    const eighths = parseInt(m[3], 10);
    /* Their grid is eighths, so the fraction is 0-7. Anything else is a format
       we have not seen, and guessing is how a wrong number gets published with
       confidence. */
    if (!(eighths >= 0 && eighths <= 7)) return null;
    const v = parseInt(m[2], 10) + eighths / 8;
    return m[1] === '-' ? -v : v;
  }

  /* Tick-shaped but unparsed. parseNum() would return the leading integer and
     throw the fraction away -- the exact bug above. Refuse instead. */
  if (/^[+-]?\d+['\u2019-]\d+/.test(t)) return null;

  return parseNum(t);
}

function listCells(inner) {
  const cells = [];
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(inner)) !== null) cells.push({ html: m[1], text: stripTags(m[1]) });
  return cells;
}

/* THE HEADING ABOVE THE BOARD IS THE LOCATION, WHEN THE NAV WILL NOT SAY.
 *
 * locationNames() reads this vendor's nav links, and on 2026-09-04 the board
 * sweep asked 32 of their sites and found NO "cashbidssingle-<id>" reference
 * at all -- not one, in 238,098 bytes of Adell Cooperative. Eighty locations
 * posting real prices came back as "location 2451", which is not a town and
 * cannot be joined to any directory.
 *
 * What they DO all carry, measured across the seven boards captured in
 * fixtures/board-sweep/, is an <h2 class="fcControls"> immediately above the
 * commodity <h3>s, and six of the seven put the location in it:
 *
 *     Agassiz Valley Grain     AVG Barnesville
 *     Berthold Farmers         Berthold
 *     Cameron Coop             Cameron Coop
 *     Country Grain Co-op      Eldridge
 *     Crossroads Coop          Bridgeport
 *     Dakota Midland Grain     Voltaire
 *     Adell Cooperative        Cash Bids          <- boilerplate, refused
 *
 * The seventh is why this list exists. A heading that says "Cash Bids" is the
 * page's own furniture, and filing it as a town would put a place called Cash
 * Bids on a map -- the exact failure Rule 1 is about. A refused heading leaves
 * the location as "location <id>", which is honest and joins to nothing.
 *
 * Their sidebars carry h2s too ("Markets", "News", "Announcements"), and those
 * open blocks whose rows have no cash and no basis, so they are dropped before
 * a location is ever asked for. */
const LOCATION_HEADING_BOILER =
  /^(cash\s*bids?|grain\s*bids?|cash\s*prices?|bids?|prices?|markets?|futures|news|hours|weather|announcements?|quotes?|home)$/i;

export function locationHeading(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 60 || t.length < 2) return null;
  if (LOCATION_HEADING_BOILER.test(t)) return null;
  /* A heading that ENDS in boilerplate is a section title, not a place:
     "Berthold Farmers Announcements" is not the Berthold location. */
  if (/\b(announcements?|updates?|news|markets?|futures|weather|hours)$/i.test(t)) return null;
  return t;
}

export function extractListBids(html, source = '') {
  const names = locationNames(html);
  /* THE TAB STRIP, IF THE NAV DID NOT ANSWER. Read once, from the ids the
     board actually carries, so the count check has the real denominator. */
  const idsInOrder = [];
  for (const m of String(html).matchAll(/CashBidsLocationID=(\d+)/gi))
    if (!idsInOrder.includes(m[1])) idsInOrder.push(m[1]);
  const tabNames = tabLocationNames(html, idsInOrder);
  const out = [];
  // Page order, captured as it is read. The board lists deliveries
  // nearest-first, and that ordering is information: it cannot be recovered
  // from the labels, because Boyceville writes them as month NAMES and
  // alphabetical order is not delivery order. Keep it rather than infer it.
  let seq = 0;

  // One ordered pass so headings, header rows and data rows stay in sequence.
  const token =
    /<h3\b[^>]*>([\s\S]*?)<\/h3>|<ul\b[^>]*class=["'][^"']*fcControlsSubHdr[^"']*["'][^>]*>([\s\S]*?)<\/ul>|<ul\b[^>]*class=["'][^"']*fcControls\d[^"']*["'][^>]*>([\s\S]*?)<\/ul>|<h2\b[^>]*>([\s\S]*?)<\/h2>/gi;

  let commodity = null;
  let heading = null;
  let map = null;
  let m;

  while ((m = token.exec(html)) !== null) {
    if (m[4] !== undefined) { heading = locationHeading(stripTags(m[4])); continue; }
    if (m[1] !== undefined) {
      const t = stripTags(m[1]);
      if (t && t.length < 40) commodity = titleCase(t);
      continue;
    }
    if (m[2] !== undefined) {
      map = mapHeader(listCells(m[2]).map((c) => ({ text: c.text, header: true, colspan: 1 })));
      continue;
    }
    if (m[3] === undefined || !map) continue;

    const cells = listCells(m[3]);
    const val = (f) => (map[f] === undefined ? '' : (cells[map[f]]?.text ?? ''));
    const cash = parseNum(val('cash'));
    const basis = parseNum(val('basis'));
    if (cash === null && basis === null) continue;

    const rowHtml = m[3];
    const locId = (rowHtml.match(/CashBidsLocationID=(\d+)/i) || [])[1] || null;
    const commodityId = (rowHtml.match(/cashBidsCommodityID=(\d+)/i) || [])[1] || null;
    /* THE NAV FIRST, ALWAYS. Big River and Ace Ethanol name their locations in
       their own links and that is the stronger evidence -- it is keyed on the
       id the row itself carries, where a heading is only keyed on position.
       The heading is the fallback, not the preference. */
    /* FOUR ANSWERS, WEAKEST LAST.
       1. the nav link, keyed on the id the row itself carries
       2. the tab strip, paired by position with the counts checked
       3. the heading above the board, when there is one location to head
       4. the id, which is honest and joins to nothing */
    const location = (locId && names.get(locId))
      || (locId ? tabNames.get(locId) : tabNames.get(null))
      || heading
      || `location ${locId || 'unknown'}`;

    out.push({
      seq: seq++,
      source,
      locationId: locId,
      location: clean(location),
      section: null,
      commodity: clean(commodity || 'unknown'),
      commodityId,
      delivery: clean(val('delivery') || val('futuresMonth') || 'spot'),
      cash,
      basis,
      basisCents: basisToCents(basis, val('basis')),
      futures: clean(val('futuresMonth')) || clean(val('futures')) || null,
      futuresPrice: parseTicks(val('futures')),
      // Their own timestamp on the futures cell, verbatim ("08:36 AM"), or
      // null on a board that does not carry the column. Diagnostic only.
      futuresAt: clean(val('lastTrade')) || null,
      // "s" once the contract has settled. Diagnostic only; never published.
      futuresFlag: tickFlag(val('futures')),
      change: parseTicks(val('change')),
      raw: cells.map((c) => c.text).filter(Boolean).join(' | '),
    });
  }
  return out;
}

const titleCase = (s) =>
  String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Extract cash bids from a page — column-list layout first, then tables.
 * @returns {Array<{location,locationId,commodity,delivery,cash,basis,basisCents,futures,change,source,raw}>}
 */
export function extractBids(html, source = '') {
  return dedupe([...extractListBids(html, source), ...extractTableBids(html, source)]);
}

/** The original table-based parser, kept for sites that do use <table>. */
export function extractTableBids(html, source = '') {
  const out = [];
  const tables = sliceTables(html);

  for (const t of tables) {
    const rows = rowsOf(t.inner);
    if (rows.length < 2) continue;

    let map = null;
    let headerIdx = -1;
    for (let i = 0; i < Math.min(rows.length, 6); i++) {
      const m = mapHeader(rows[i]);
      if (m) { map = m; headerIdx = i; break; }
    }
    if (!map) continue;

    const width = rows[headerIdx].length;
    const tableHeading = headingBefore(t.before);
    let sectionLabel = null; // set by single-cell rows inside the table

    // If a table carries SEVERAL full-width banner rows, those banners are
    // grouping separators (one per location) and outrank the page heading.
    // A single banner is usually just a sub-caption, so the heading wins.
    const bannerCount = rows
      .slice(headerIdx + 1)
      .filter((r) => (r.length === 1 || r[0]?.colspan >= width) && r.map((c) => c.text).join(' ').trim())
      .length;
    const bannersAreLocations = bannerCount >= 2;

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const cells = rows[i];
      const val = (field) =>
        map[field] === undefined ? '' : (cells[map[field]]?.text ?? '');

      // A full-width single cell is a location/section banner, not a bid.
      const spanned = cells.length === 1 || cells[0]?.colspan >= width;
      if (spanned) {
        const label = cells.map((c) => c.text).join(' ').trim();
        if (label && !JUNK_ROW.test(label) && label.length < 120) sectionLabel = label;
        continue;
      }
      if (cells.length < 2) continue;
      if (cells.every((c) => c.header)) continue; // repeated header

      const cash = parseNum(val('cash'));
      const basis = parseNum(val('basis'));
      if (cash === null && basis === null) continue; // no quote on this row

      const location =
        val('location') ||
        (bannersAreLocations ? sectionLabel : null) ||
        tableHeading ||
        sectionLabel ||
        hostOf(source) ||
        'unknown';
      const commodity = val('commodity') || sectionLabel || 'unknown';
      const delivery = val('delivery') || val('futures') || 'spot';

      out.push({
        source,
        locationId: null,
        location: clean(location),
        section: clean(sectionLabel) || null,
        commodity: clean(commodity),
        delivery: clean(delivery),
        cash,
        basis,
        basisCents: basisToCents(basis, val('basis')),
        // The month label is the useful identifier; a "Futures" column that
        // holds a price is captured separately.
        futures: clean(val('futuresMonth')) || clean(val('futures')) || null,
        futuresPrice: map.futuresMonth === undefined ? null : parseTicks(val('futures')),
        futuresAt: clean(val('lastTrade')) || null,
        // "s" once the contract has settled. Diagnostic only; never published.
        futuresFlag: tickFlag(val('futures')),
        change: parseNum(val('change')),
        raw: cells.map((c) => c.text).join(' | '),
      });
    }
  }
  return dedupe(out);
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

/** Stable identity for a quote across polls. */
export function bidKey(b) {
  return `${b.location}␟${b.commodity}␟${b.delivery}`;
}

function dedupe(bids) {
  const seen = new Map();
  for (const b of bids) {
    const k = bidKey(b);
    // Later duplicates win only if they carry more information.
    const prev = seen.get(k);
    if (!prev || (prev.cash === null && b.cash !== null) || (prev.basis === null && b.basis !== null)) {
      seen.set(k, b);
    }
  }
  return [...seen.values()];
}

/* ---------------------------------------------------------------------------
 * The identity check.
 *
 * On a priced row this board carries a cash bid, a basis and a futures quote,
 * and the three agree: cash - basis == futures. That is not a nicety, it is the
 * only check here that proves we read the RIGHT COLUMNS rather than merely
 * plausible numbers. The sanity band, the max-move rail and the freshness gate
 * all test whether a value looks reasonable. None of them notices a page that
 * quietly reordered its columns while every value stayed in range.
 *
 * Verified against the real Boyceville capture: agrees to four decimals on all
 * seven rows.
 *
 * UNITS. cash and basis are DOLLARS. futuresPrice is CENTS, because parseTicks
 * reads "459-4" as 459.5 cents. Getting that backwards makes this pass on
 * everything, which is worse than not having it.
 *
 * TOLERANCE. One eighth of a cent is 0.125c, so the tolerance has to sit below
 * that or a one-eighth misread slips through. 0.05c leaves room for float noise
 * and nothing else.
 * --------------------------------------------------------------------------- */
export function checkIdentity(rows, tolCents = 0.05) {
  const bad = [];
  for (const r of rows || []) {
    if (r.cash == null || r.basis == null || r.futuresPrice == null) continue;
    const derivedCents = (r.cash - r.basis) * 100;
    const off = Math.abs(r.futuresPrice - derivedCents);
    if (off > tolCents) {
      bad.push({
        location: r.location, commodity: r.commodity, delivery: r.delivery,
        cash: r.cash, basis: r.basis, quotedCents: r.futuresPrice,
        derivedCents: Number(derivedCents.toFixed(4)),
        offCents: Number(off.toFixed(4)),
        /* SIGNED, BECAUSE THE DIRECTION IS EVIDENCE AND WAS BEING THROWN AWAY.
         *
         * `offCents` is a magnitude, and every caller printed it with a "+"
         * hard-coded, so a log line said "+0.5c" whichever way the row was
         * out. Seven rows all out in the SAME direction is a board whose
         * futures column is behind its cash; seven rows out in scattered
         * directions is not. That distinction was unreadable from the log of
         * a failure we then had to explain. */
        signedCents: Number((r.futuresPrice - derivedCents).toFixed(4)),
        futuresAt: r.futuresAt ?? null,
        futuresFlag: r.futuresFlag ?? null,
      });
    }
  }
  return bad;
}

/* ---------------------------------------------------------------------------
 * Keep one location's rows.
 *
 * ONE PAGE CARRIES EVERY LOCATION. /cashbidssingle-2121 is the Boyceville URL
 * and it also serves Dyersville, Galva, West Burlington, Monmouth, Aledo and
 * Biddles as tab panels, all present in the HTML. Skip this and Dyersville's
 * bids end up on Wheeler's board, looking entirely plausible.
 *
 * Keyed on the numeric CashBidsLocationID rather than the display name,
 * because an id survives them renaming or re-casing a location.
 * --------------------------------------------------------------------------- */
/* ABSENT IS NOT A VALUE, AND IT USED TO MATCH EVERYTHING -- 2026-08-20.
 *
 * The comparison was `String(b.locationId) === String(locationId)`. When a
 * manifest carried no `locationId` and the rows carried none either, that
 * became `"undefined" === "undefined"` and every row on the page was kept.
 * The `first-party` adapter reads a bids.json we wrote, whose published rows
 * have no locationId field at all, so it is exactly the path where both sides
 * are absent -- and the failure this function exists to prevent, Dyersville's
 * bids on Wheeler's board, is what came out.
 *
 * `null` and `undefined` and `""` all mean the same thing here -- this page
 * does not key its rows by location -- so they are normalised to one value and
 * a source has to say `"locationId": null` out loud to get it. buildFile
 * refuses a manifest that leaves the key out entirely. */
export const normLocationId = (v) =>
  (v === undefined || v === null || v === '' ? null : String(v));

export function filterLocation(bids, locationId) {
  const locations = [...new Set(bids.map(
    (b) => `${b.location}${b.locationId ? ` (${b.locationId})` : ''}`))];
  const want = normLocationId(locationId);
  const kept = bids.filter((b) => normLocationId(b.locationId) === want);
  return { kept, dropped: bids.length - kept.length, locations };
}
