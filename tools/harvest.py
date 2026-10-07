"""Flash Grain bid harvester.

Reads the DTN cash bid page, decodes it, checks it, writes data/bids.json.
Run by .github/workflows/harvest.yml. Standard library only.

  python tools/harvest.py                    fetch live, write data/bids.json if needed
  python tools/harvest.py --file page.html   decode a saved page, print JSON, write nothing

Published:
  futures   {symbol: {price, change, time}}  the site adds Jeff's basis (data/site.json) to these
  dtn       {location_id: [{label, commodity, symbol, cash, basis}]}  DTN's own bid, for /admin reference only
  quote_time  latest futures trade time on the page (Central), when the page carries it
  checked     last time the harvester ran successfully (heartbeat, at least hourly)

How DTN hides numbers: cash and basis cells are printed as displayNumber(x, 2) where
x = real value + a per-page offset. The offset is the sum of the `x = x - (v)` terms
whose `if (a <= b)` guard is true inside function displayNumber. Futures price and
change are printed plain in cents and eighths (501'6 = 501.75 cents).

The table is read by structure, not by token order: each <td> is placed under its
column header, so a blank cell stays blank and cannot shift a later value left.
Location and commodity come from the table's own row-group headers, not a fixed list.

Guards:
  - a column is used only if its futures price and month are both present
  - a DTN row whose cash != futures + basis (1 cent) is dropped and printed; the contract's
    futures are still published if another location's row for it passes, or it has no cash row
  - if no corn or no soybean contract survives, nothing is written and the run fails,
    so the site keeps the last good file
  - a location that posts bids in data/site.json but is missing from DTN is printed as a warning
"""
import html, json, os, re, sys, time, urllib.request
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser

URLS = [  # cash bid page first: it carries per-contract trade times
    "https://www.flashgrains.com/index.cfm?show=11&mid=3",
    "https://www.flashgrains.com/index.cfm",
    "https://flashgrains.com/index.cfm?show=11&mid=3",
]
OUT = os.path.join(os.path.dirname(__file__), "..", "data", "bids.json")
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36"
HEARTBEAT = timedelta(minutes=55)  # rewrite `checked` at least this often, even with no price change
FIELDS = {"cash price": "cash", "basis": "basis", "futures month": "symbol",
          "futures price": "futures", "futures change": "change", "futures chg": "change"}


def eighths(tok):
    """501'6 -> 5.0175 dollars. -0'4 -> -0.005."""
    tok = tok.strip()
    neg = tok.startswith("-")
    w, e = tok.lstrip("+-").split("'")
    v = (int(w) + int(e) / 8) / 100
    return round(-v if neg else v, 5)


ARITH = re.compile(r"^[0-9.+\-*/()=;<>!x]*$")


def _strip_if(st):
    """Split `if(cond)assign` into (cond, assign); (None, st) when there is no condition."""
    if not st.startswith("if("):
        return None, st
    depth = 0
    for i in range(2, len(st)):
        if st[i] == "(":
            depth += 1
        elif st[i] == ")":
            depth -= 1
            if depth == 0:
                return st[3:i], st[i + 1:]
    raise ValueError("unbalanced if( in displayNumber")


def _body_offset(body):
    """Run displayNumber's body at x = 0, the way the browser would.

    The body may only contain digits, `. + - * / ( ) = ; < > !` and the letter x
    (plus `if(`), so it can compute a number and nothing else; anything outside
    that is refused, never evaluated. Running it, rather than pattern-matching the
    terms, is what keeps us right when DTN changes `<=` to `>=` or nests its signs:
    a regex that misses a term shifts cash and basis together, which our
    cash == futures + basis check cannot see."""
    if not ARITH.match(body.replace("if(", "(")):
        bad = sorted(set(re.sub(r"[0-9.+\-*/()=;<>!x]", "", body.replace("if(", "("))))
        raise ValueError("displayNumber body is not plain arithmetic (found %s)" % "".join(bad))
    x = 0.0
    for st in [t for t in body.split(";") if t]:
        cond, assign = _strip_if(st)
        if not re.match(r"^x=[^=]", assign):
            raise ValueError("displayNumber statement does not assign x: %r" % st[:60])
        if cond is not None:
            c = cond.replace("!==", "!=").replace("===", "==")
            if not eval(c, {"__builtins__": {}}, {"x": x}):  # whitelisted arithmetic only, see ARITH
                continue
        x = float(eval(assign[2:], {"__builtins__": {}}, {"x": x}))
    return x


def offset(src):
    """The hidden constant: real value = printed number - offset.

    Every definition of displayNumber on the page is evaluated and they must
    agree. The page also prints the same constant in a `NoScrapeOffset` comment;
    when it is there, ours must match it exactly or nothing is published."""
    ats = [m.start() for m in re.finditer(r"function\s+displayNumber\s*\(", src)]
    if not ats:
        raise ValueError("displayNumber function not found")
    found = set()
    for at in ats:
        o, e = src.find("{", at), src.find("document.write", at)
        if o < 0 or e < 0 or o > e:
            continue
        body = re.sub(r"\s+", "", src[o + 1:e])
        if body:
            found.add(round(-_body_offset(body), 4))
    if len(found) != 1:
        raise ValueError("displayNumber offsets disagree or none decoded: %s" % sorted(found))
    off = found.pop()
    if off == 0:
        raise ValueError("displayNumber offset is 0, which DTN has never served; refusing")
    stated = re.search(r"NoScrapeOffset:\s*(-?[\d.]+)", src)
    if stated and abs(float(stated.group(1)) - off) > 1e-4:
        raise ValueError("decoded offset %s does not match the page's own NoScrapeOffset %s; refusing" % (off, stated.group(1)))
    return off


class Grid(HTMLParser):
    """Collects every DataGrid table as {caption, cols:[labels], rows:[{th:[(scope,text)], td:[cell]}]}.
    A cell is {text, num (displayNumber arg or None), title}."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self.t, self.cell, self.in_caption, self.in_script, self.th = [], None, None, False, False, None

    def handle_starttag(self, tag, a):
        a = dict(a)
        if tag == "table" and "DataGrid" in (a.get("class") or ""):
            self.t = {"caption": "", "cols": [], "rows": []}
            self.tables.append(self.t)
        if not self.t:
            return
        if tag == "caption":
            self.in_caption = True
        elif tag == "tr":
            self.t["rows"].append({"th": [], "td": []})
        elif tag == "th":
            self.th = {"scope": a.get("scope", ""), "text": ""}
        elif tag == "td" and self.t["rows"]:
            self.cell = {"text": "", "num": None, "title": None}
        elif tag == "script":
            self.in_script = True
        if self.cell is not None and a.get("title") and re.match(r"\d{2}/\d{2}/\d{4} ", a["title"]):
            self.cell["title"] = a["title"]

    def handle_endtag(self, tag):
        if not self.t:
            return
        if tag == "table":
            self.t = None
        elif tag == "caption":
            self.in_caption = False
        elif tag == "script":
            self.in_script = False
        elif tag == "th" and self.th is not None:
            txt = " ".join(self.th["text"].split())
            if self.th["scope"] == "col":
                self.t["cols"].append(txt)
            elif self.t["rows"]:
                self.t["rows"][-1]["th"].append((self.th["scope"], txt))
            self.th = None
        elif tag == "td" and self.cell is not None:
            self.cell["text"] = " ".join(self.cell["text"].split())
            self.t["rows"][-1]["td"].append(self.cell)
            self.cell = None

    def handle_data(self, d):
        if not self.t:
            return
        if self.in_caption:
            self.t["caption"] += d
        elif self.in_script and self.cell is not None:
            m = re.search(r"displayNumber\(\s*(-?[\d.]+)", d)
            if m:
                self.cell["num"] = float(m.group(1))
        elif self.th is not None:
            self.th["text"] += d
        elif self.cell is not None:
            self.cell["text"] += d


def central(title):
    """'09/30/2026 7:33:00 PM CST' -> ISO in Central local time. DTN labels these CST year-round,
    but they are Central local (a 7:33 PM 'CST' cell on a page built 7:44 PM CDT)."""
    try:
        dt = datetime.strptime(title.rsplit(" ", 1)[0], "%m/%d/%Y %I:%M:%S %p")
        return dt.strftime("%Y-%m-%dT%H:%M:%S")
    except Exception:
        return None


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def decode(src):
    off = offset(src)
    g = Grid()
    g.feed(src)
    cells = {}  # (loc, commodity, col) -> {field: value}
    as_of = re.search(r"Price as of ([^.<]*)\.", src)
    for t in g.tables:
        cols = t["cols"]
        cap = " ".join(t["caption"].split())
        loc, com = None, cap or None
        # Two layouts. Home page: one table per commodity (caption), row group = location.
        # Cash page: one table, nested row groups = location, then commodity. A row that
        # opens both carries two row-group headers: the first is the location.
        nested = any(sum(1 for sc, _ in r["th"] if sc == "rowgroup") >= 2 for r in t["rows"])
        for r in t["rows"]:
            label = None
            groups = [txt for sc, txt in r["th"] if sc == "rowgroup" and txt]
            if len(groups) >= 2:
                loc, com = groups[0], groups[1]
            elif len(groups) == 1:
                if cap or not nested:
                    loc = groups[0]
                else:
                    com = groups[0]
            for scope, txt in r["th"]:
                if scope == "row":
                    label = FIELDS.get(txt.lower())
            if not label or not loc or not com:
                continue
            for i, c in enumerate(r["td"]):
                key = (loc, com, i)
                d = cells.setdefault(key, {"label": cols[i] if i < len(cols) else str(i)})
                if label in ("cash", "basis"):
                    if c["num"] is not None:
                        d[label] = round(c["num"] - off, 4)
                elif label == "symbol":
                    m = re.search(r"@[A-Z]{1,3}\d[A-Z]", c["text"])
                    if m:
                        d["symbol"] = m.group(0)
                else:
                    m = re.search(r"[+-]?\d+'\d", c["text"])
                    if m:
                        d[label] = eighths(m.group(0))
                    if label == "futures" and c["title"]:
                        d["time"] = central(c["title"])
    return cells, (as_of.group(1).strip() if as_of else None)


def build(src):
    cells, as_of = decode(src)
    futures, dtn, problems = {}, {}, []
    for (loc, com, _), c in sorted(cells.items()):
        if "symbol" not in c or "futures" not in c:
            continue  # blank column (DTN's cash page has an empty column per delivery period)
        sym = c["symbol"]
        if "cash" in c and "basis" in c and abs(c["cash"] - (c["futures"] + c["basis"])) > 0.0101:
            problems.append("%s %s %s %s: cash %.4f != futures %.4f + basis %.4f"
                            % (loc, com, c["label"], sym, c["cash"], c["futures"], c["basis"]))
            continue
        f = futures.setdefault(sym, {"price": c["futures"], "change": c.get("change"), "time": c.get("time")})
        if abs(f["price"] - c["futures"]) > 1e-9:
            problems.append("%s quoted at two prices (%s vs %s); keeping the first" % (sym, f["price"], c["futures"]))
        if "cash" in c and "basis" in c:
            dtn.setdefault(slug(loc), []).append({"label": c["label"], "commodity": com.title(), "symbol": sym,
                                                  "cash": round(c["cash"], 2), "basis": round(c["basis"], 2)})
    for p in problems:
        print("dropped:", p, file=sys.stderr)
    if not any(k.startswith("@C") for k in futures) or not any(k.startswith("@S") for k in futures):
        raise ValueError("no corn or no soybean contract survived the checks: %s; problems: %s" % (sorted(futures), problems))
    times = [f["time"] for f in futures.values() if f.get("time")]
    return {"quote_time": max(times) if times else None, "dtn_as_of": as_of, "futures": futures, "dtn": dtn}


ROOTS = {"@C": "ZC", "@S": "ZS", "@W": "ZW"}
AGSIST = "https://raw.githubusercontent.com/dnilgis/agsist/main/data/prices.json"
BACKUP_MAX_AGE = timedelta(hours=2)

# Futures as printed on live elevator boards, read by dnilgis/bids every few minutes. Five companies on four
# platforms, so no one feed decides the price; the middle value per contract is used, and at least two must agree.
BOARDS = ["adm-hoopestonil", "nexus-denisonia", "chsherman-glenwood", "farmerscooperative-mccooljunction", "premiercooperative1-dewey"]
BOARDS_URL = "https://raw.githubusercontent.com/dnilgis/bids/main/data/%s.json"
BOARDS_MAX_AGE = timedelta(minutes=45)


def board_futures(symbols):
    """{symbol: {price, change, time}} from the BOARDS consensus, for the symbols at least two boards carry."""
    seen, times, notes = {}, [], []
    since = closed_since()
    for b in BOARDS:
        try:
            d = _get(BOARDS_URL % b)
            pa = datetime.strptime(d["pricedAt"][:19], "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
            if datetime.now(timezone.utc) - pa > BOARDS_MAX_AGE and not (since and _ct(pa) >= since):
                raise ValueError("priced %s ago" % (datetime.now(timezone.utc) - pa))
            for r in d.get("bids") or []:
                m = re.match(r"^Z([CS])([FHKNQUXZ])(\d{1,2})$", r.get("futuresMonth") or "")
                if m and isinstance(r.get("futuresPriceCents"), (int, float)):
                    sym = "@%s%s%s" % (m.group(1), m.group(3)[-1], m.group(2))
                    seen.setdefault(sym, {})[b] = r["futuresPriceCents"]
            times.append(pa)
        except Exception as e:
            notes.append("board %s: %s" % (b, e))
    got = {}
    for sym in symbols:
        vals = sorted(seen.get(sym, {}).values())
        if not vals:
            continue
        mid = vals[len(vals) // 2] if len(vals) % 2 else (vals[len(vals) // 2 - 1] + vals[len(vals) // 2]) / 2
        agree = [v for v in vals if abs(v - mid) / mid <= 0.03]
        if len(agree) < 2:
            notes.append("board %s: only %d board(s) agree" % (sym, len(agree)))
            continue
        got[sym] = {"price": round(mid / 100, 5), "change": None, "time": _central_iso(max(times).timestamp()) if times else None}
    return got, notes


def _ct(utc):
    """UTC datetime -> naive US Central wall time (same DST rule as _central_iso)."""
    return datetime.strptime(_central_iso(utc.timestamp()), "%Y-%m-%dT%H:%M:%S")


def closed_since(now_utc=None):
    """If CBOT corn/soy is closed right now, the Central wall time its last session ended; else None.
    Sessions: Sun-Fri 7:00 PM - 7:45 AM and Mon-Fri 8:30 AM - 1:20 PM Central. Holidays not modelled.
    While closed, a price read after this moment IS the close and stays right until the market reopens."""
    n = _ct(now_utc or datetime.now(timezone.utc))
    d, m = n.weekday(), n.hour * 60 + n.minute  # Mon=0 .. Sun=6
    day = lambda back, hh, mm: (n - timedelta(days=back)).replace(hour=hh, minute=mm, second=0, microsecond=0)
    if d <= 4 and 465 <= m < 510:
        return day(0, 7, 45)                     # morning break between overnight and day session
    if d <= 4 and 800 <= m < 1140 and d != 4:
        return day(0, 13, 20)                    # Mon-Thu afternoon, reopens 7 PM
    if d == 4 and m >= 800:
        return day(0, 13, 20)                    # Friday after the close
    if d == 5:
        return day(1, 13, 20)                    # Saturday
    if d == 6 and m < 1140:
        return day(2, 13, 20)                    # Sunday before 7 PM
    return None
SANITY = 0.15  # a backup price more than 15% from the last DTN price for that contract is refused


def yahoo_ticker(sym, today=None):
    """@C6Z -> ZCZ26.CBT. The single year digit is resolved to the nearest year not in the past decade."""
    m = re.match(r"^(@[A-Z])([0-9])([FGHJKMNQUVXZ])$", sym)
    if not m or m.group(1) not in ROOTS:
        return None
    y = (today or datetime.now(timezone.utc)).year
    year = y // 10 * 10 + int(m.group(2))
    if year < y - 1:
        year += 10
    return "%s%s%02d.CBT" % (ROOTS[m.group(1)], m.group(3), year % 100)


def _get(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def _central_iso(epoch):
    """Unix seconds -> Central wall time ISO, matching quote_time from DTN's cell titles."""
    utc = datetime.fromtimestamp(epoch, timezone.utc)
    # US Central: CDT (UTC-5) from 2nd Sun Mar 2:00 to 1st Sun Nov 2:00, else CST (UTC-6)
    y = utc.year
    mar = datetime(y, 3, 8, 8, tzinfo=timezone.utc)
    mar += timedelta(days=(6 - mar.weekday()) % 7)
    nov = datetime(y, 11, 1, 7, tzinfo=timezone.utc)
    nov += timedelta(days=(6 - nov.weekday()) % 7)
    off = -5 if mar <= utc < nov else -6
    return (utc + timedelta(hours=off)).strftime("%Y-%m-%dT%H:%M:%S")


def backup_futures(symbols, last_dtn):
    """Delayed CBOT futures for contracts DTN cannot give us: live elevator boards (via dnilgis/bids), then
    Yahoo Finance, then agsist's prices.json, then (corn only) Ace Ethanol's board.
    Returns ({symbol: {price, change, time}}, source) for the symbols it could get and verify."""
    got, used, notes = {}, set(), []
    try:  # live elevator boards first: they update all day, and GitHub's runners can always reach them
        got, bnotes = board_futures(symbols)
        notes += bnotes
        if got:
            used.add("boards")
    except Exception as e:
        notes.append("boards: %s" % e)
    for sym in [x for x in symbols if x not in got]:  # Yahoo, contract by contract
        t = yahoo_ticker(sym)
        if not t:
            continue
        try:
            meta = _get("https://query1.finance.yahoo.com/v8/finance/chart/%s?range=1d&interval=1d" % t)["chart"]["result"][0]["meta"]
            px, prev = meta.get("regularMarketPrice"), meta.get("chartPreviousClose") or meta.get("previousClose")
            if px is None:
                continue
            got[sym] = {"price": round(px / 100, 5), "change": round((px - prev) / 100, 5) if prev is not None else None,
                        "time": _central_iso(meta["regularMarketTime"]) if meta.get("regularMarketTime") else None}
            used.add("yahoo")
        except Exception as e:
            notes.append("yahoo %s: %s" % (t, e))
            print("backup yahoo %s (%s): %s" % (sym, t, e), file=sys.stderr)
    missing = [s for s in symbols if s not in got]
    if missing:  # agsist's own Yahoo pull, if it is fresh
        try:
            d = _get(AGSIST)
            fetched = datetime.strptime(d["fetched"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            since = closed_since()
            if datetime.now(timezone.utc) - fetched > BACKUP_MAX_AGE and not (since and _ct(fetched) >= since):
                raise ValueError("agsist prices.json is %s old" % (datetime.now(timezone.utc) - fetched))
            by_ticker = {q.get("ticker"): q for q in d.get("quotes", {}).values() if isinstance(q, dict)}
            for sym in missing:
                q = by_ticker.get(yahoo_ticker(sym))
                if q and q.get("close") is not None:
                    got[sym] = {"price": round(q["close"] / 100, 5),
                                "change": round(q["netChange"] / 100, 5) if q.get("netChange") is not None else None,
                                "time": _central_iso(fetched.timestamp())}
                    used.add("agsist")
        except Exception as e:
            notes.append("agsist: %s" % e)
            print("backup agsist: %s" % e, file=sys.stderr)
    missing = [s for s in symbols if s not in got and s.startswith("@C")]
    if missing:  # Ace Ethanol's own board (read by refs_bushel.mjs) lists the corn curve with each row
        try:
            d = json.load(open(os.path.join(os.path.dirname(__file__), "..", "data", "refs", "ace.json")))
            chk = datetime.strptime(d["checked"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
            since = closed_since()
            if datetime.now(timezone.utc) - chk > BACKUP_MAX_AGE and not (since and _ct(chk) >= since):
                raise ValueError("ace.json is %s old" % (datetime.now(timezone.utc) - chk))
            code = {"Mar": "H", "May": "K", "Jul": "N", "Sep": "U", "Dec": "Z"}
            for r in d.get("rows", []):
                m = re.match(r"^(\w{3}) (\d\d) Corn$", r.get("futures_month") or "")
                sym = m and m.group(1) in code and "@C%s%s" % (m.group(2)[-1], code[m.group(1)])
                if sym in missing and isinstance(r.get("futures"), (int, float)) and sym not in got:
                    got[sym] = {"price": round(r["futures"], 5), "change": None, "time": _central_iso(chk.timestamp())}
                    used.add("ace")
        except Exception as e:
            notes.append("ace: %s" % e)
            print("backup ace: %s" % e, file=sys.stderr)
    for sym in list(got):  # refuse anything that disagrees wildly with the last DTN price (units, wrong contract)
        ref = (last_dtn or {}).get(sym, {}).get("price")
        if ref and abs(got[sym]["price"] - ref) / ref > SANITY:
            notes.append("%s refused: %.4f vs last DTN %.4f" % (sym, got[sym]["price"], ref))
            print("backup %s refused: %.4f vs last DTN %.4f" % (sym, got[sym]["price"], ref), file=sys.stderr)
            del got[sym]
    return got, "+".join(sorted(used)) or None, notes


def fetch():
    last = None
    for attempt in range(2):
        for url in URLS:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
                with urllib.request.urlopen(req, timeout=20) as r:
                    src = r.read().decode("latin-1")
                return build(src), url
            except Exception as e:  # next URL, then retry the set once
                last = "%s: %s" % (url, e)
                print("fail", last, file=sys.stderr)
        time.sleep(10)
    raise SystemExit("all fetches failed; bids.json left unchanged. last error: %s" % last)


REFS_DIR = os.path.join(os.path.dirname(__file__), "..", "data", "refs")


def pick_ref(src, ref):
    """Rows for one reference elevator from a DTN AgHost board: its location, its commodity, checked."""
    cells, as_of = decode(src)
    locs = sorted({k[0] for k in cells})
    coms = sorted({k[1] for k in cells})
    want, com = (ref.get("location") or "").lower(), ref["commodity"].upper()
    if not want and len(locs) > 1:
        raise ValueError("the page has %d locations (%s); set `location` for %s in site.json" % (len(locs), ", ".join(locs), ref["id"]))
    rows, dropped = [], []
    for (loc, c, _), d in sorted(cells.items(), key=lambda kv: kv[0][2]):
        if (want and want not in loc.lower()) or com not in c.upper():
            continue
        if "symbol" not in d or "futures" not in d or "cash" not in d or "basis" not in d:
            continue
        if abs(d["cash"] - (d["futures"] + d["basis"])) > 0.0101:
            dropped.append("%s: cash %.4f != futures %.4f + basis %.4f" % (d["label"], d["cash"], d["futures"], d["basis"]))
            continue
        rows.append({"label": d["label"], "cash": round(d["cash"], 4), "basis": round(d["basis"], 4),
                     "futures_month": d["symbol"], "futures": d["futures"], "time": d.get("time")})
    if not rows:
        raise ValueError("no %s rows for %r. Locations: %s. Commodities: %s. %s" % (
            ref["commodity"], ref.get("location"), ", ".join(locs) or "none", ", ".join(coms) or "none", "; ".join(dropped)))
    times = [r["time"] for r in rows if r.get("time")]
    return {"rows": rows, "quote_time": max(times) if times else None, "dtn_as_of": as_of, "dropped": dropped}


def note_ref_error(path, ref, e):
    """Write why a reference read failed into its file (rows untouched), so /admin and the repo
    show the reason without opening the Actions log. Rewritten only when the reason changes or hourly."""
    try:
        old = json.load(open(path))
    except Exception:
        old = {"id": ref["id"], "source": ref["url"], "rows": []}
    msg, now = str(e)[:400], datetime.now(timezone.utc)
    try:
        recent = now - datetime.strptime(old.get("error_at", ""), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) < HEARTBEAT
    except (ValueError, TypeError):
        recent = False
    if old.get("error") == msg and recent:
        return
    old.update(error=msg, error_at=now.strftime("%Y-%m-%dT%H:%M:%SZ"))
    os.makedirs(REFS_DIR, exist_ok=True)
    with open(path, "w") as f:
        json.dump(old, f, indent=1)
        f.write("\n")


def harvest_refs():
    """Reference elevators on DTN AgHost (platform "aghost" in data/site.json `references`).
    Never logs in: a page served without prices publishes nothing."""
    site = json.load(open(os.path.join(os.path.dirname(__file__), "..", "data", "site.json")))
    failed = 0
    for ref in [r for r in site.get("references", []) if r.get("platform") == "aghost"]:
        path = os.path.join(REFS_DIR, ref["id"] + ".json")
        try:
            req = urllib.request.Request(ref["url"], headers={"User-Agent": UA, "Accept": "text/html"})
            with urllib.request.urlopen(req, timeout=20) as r:
                src = r.read().decode("latin-1")
            calls = len(re.findall(r"displayNumber\(\s*-?[\d.]+", src))
            if calls <= 1:
                txt = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", src)).strip()[:160]
                where = r.geturl() if r.geturl() != ref["url"] else ""
                raise ValueError("page served without prices (%d bytes, %d price calls%s); not logging in. Page says: %s"
                                 % (len(src), calls, ", redirected to " + where if where else "", txt or "(nothing)"))
            got = pick_ref(src, ref)
            for d in got.pop("dropped"):
                print("%s dropped: %s" % (ref["id"], d), file=sys.stderr)
            try:
                old = json.load(open(path))
            except Exception:
                old = {}
            now = datetime.now(timezone.utc)
            same = old.get("rows") == got["rows"]
            try:
                fresh = now - datetime.strptime(old.get("checked", ""), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) < HEARTBEAT
            except (ValueError, TypeError):
                fresh = False
            if same and fresh:
                print("%s: no change" % ref["id"])
                continue
            stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
            os.makedirs(REFS_DIR, exist_ok=True)
            with open(path, "w") as f:
                json.dump({"id": ref["id"], "checked": stamp, "updated": stamp if not same else old.get("updated", stamp),
                           "source": ref["url"], **got}, f, indent=1)
                f.write("\n")
            print("%s: wrote %d rows" % (ref["id"], len(got["rows"])))
        except Exception as e:
            failed += 1
            print("%s: %s; rows left unchanged" % (ref["id"], e), file=sys.stderr)
            note_ref_error(path, ref, e)
    if failed:
        raise SystemExit(1)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--refs":
        harvest_refs()
        return
    if len(sys.argv) == 4 and sys.argv[1] == "--ref-file":
        site = json.load(open(os.path.join(os.path.dirname(__file__), "..", "data", "site.json")))
        ref = [r for r in site["references"] if r["id"] == sys.argv[3]][0]
        print(json.dumps(pick_ref(open(sys.argv[2], encoding="latin-1").read(), ref), indent=1))
        return
    if len(sys.argv) == 3 and sys.argv[1] == "--file":
        print(json.dumps(build(open(sys.argv[2], encoding="latin-1").read()), indent=1))
        return
    try:
        old = json.load(open(OUT))
    except Exception:
        old = {}
    try:  # every contract a shown row needs, including months DTN's own board does not post
        site = json.load(open(os.path.join(os.path.dirname(__file__), "..", "data", "site.json")))
        wanted = sorted({r["symbol"] for r in site["bids"]["rows"] if r.get("show") and r.get("symbol")})
    except Exception:
        wanted = sorted((old.get("futures") or {}).keys())
    try:
        data, url = fetch()
        extra = [s for s in wanted if s not in data["futures"]]
        if extra:
            fut, src, notes = backup_futures(extra, old.get("dtn_futures"))
            data["futures"].update(fut)
            if fut:
                data["extra_futures_source"] = src
                print("DTN board lacks %s; filled %s from %s" % (", ".join(extra), ", ".join(sorted(fut)) or "none", src))
            if notes:
                data["backup_notes"] = [n[:200] for n in notes]
    except SystemExit as dtn_down:
        print(dtn_down, file=sys.stderr)
        fut, src, notes = backup_futures(wanted, old.get("dtn_futures") or old.get("futures"))
        if not any(k.startswith("@C") for k in fut) or not any(k.startswith("@S") for k in fut):
            # Market closed and the stored prices were read after the last session ended: they ARE the close
            # and cannot have moved. Keep them and record the check, so the site does not go dark all weekend.
            since, qt = closed_since(), old.get("quote_time")
            if since and qt and old.get("futures") and datetime.strptime(qt[:19], "%Y-%m-%dT%H:%M:%S") >= since:
                print("DTN and backups unavailable; CBOT closed since %s and stored prices (%s) are that close; keeping them" % (since, qt))
                fut, src = old["futures"], old.get("futures_source", "dtn")
                notes = notes + ["kept the close: CBOT closed since %s" % since.strftime("%a %H:%M")]
            else:
                raise SystemExit("DTN down and the backup feed did not cover corn and soybeans; bids.json left unchanged")
        times = [f["time"] for f in fut.values() if f.get("time")]
        data = {"quote_time": max(times) if times else None, "dtn_as_of": None, "futures": fut,
                "dtn": old.get("dtn", {}), "futures_source": src,
                "dtn_error": str(dtn_down)[:300], "backup_notes": [n[:200] for n in notes]}
        url = "backup:" + src
        print("DTN down; using backup futures from %s for %s" % (src, ", ".join(sorted(fut))))
    try:
        site = json.load(open(os.path.join(os.path.dirname(__file__), "..", "data", "site.json")))
        for l in site.get("locations", []):
            if l.get("bids") and l.get("id") not in data["dtn"]:
                print("warning: %s posts bids on the site but DTN has no rows for it (DTN has: %s)"
                      % (l.get("id"), ", ".join(sorted(data["dtn"]))), file=sys.stderr)
    except Exception as e:
        print("warning: could not compare with site.json:", e, file=sys.stderr)
    now = datetime.now(timezone.utc)
    same = old.get("futures") == data["futures"] and old.get("dtn") == data["dtn"]
    try:
        fresh = now - datetime.strptime(old.get("checked", ""), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) < HEARTBEAT
    except (ValueError, TypeError):
        fresh = False
    # bids.json is written on EVERY run, so `checked` (the time the site shows) moves every 10 minutes even
    # when prices do not. The site's own "not updating" warning reads the same field.
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    data.setdefault("futures_source", "dtn")
    if data["futures_source"] == "dtn":
        data["dtn_futures"] = data["futures"]
    else:
        data["dtn_futures"] = old.get("dtn_futures") or old.get("futures")
    out = {"checked": stamp, "updated": stamp if not same else old.get("updated", stamp), "source": url, **data}
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print("wrote", "check (no price change)" if same else "new prices", data["quote_time"])


if __name__ == "__main__":
    main()
