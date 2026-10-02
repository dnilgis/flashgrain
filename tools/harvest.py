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


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--file":
        print(json.dumps(build(open(sys.argv[2], encoding="latin-1").read()), indent=1))
        return
    data, url = fetch()
    try:
        site = json.load(open(os.path.join(os.path.dirname(__file__), "..", "data", "site.json")))
        for l in site.get("locations", []):
            if l.get("bids") and l.get("id") not in data["dtn"]:
                print("warning: %s posts bids on the site but DTN has no rows for it (DTN has: %s)"
                      % (l.get("id"), ", ".join(sorted(data["dtn"]))), file=sys.stderr)
    except Exception as e:
        print("warning: could not compare with site.json:", e, file=sys.stderr)
    try:
        old = json.load(open(OUT))
    except Exception:
        old = {}
    now = datetime.now(timezone.utc)
    same = old.get("futures") == data["futures"] and old.get("dtn") == data["dtn"]
    try:
        fresh = now - datetime.strptime(old.get("checked", ""), "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc) < HEARTBEAT
    except (ValueError, TypeError):
        fresh = False
    if same and fresh:
        print("no change", data["quote_time"])
        return
    stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
    out = {"checked": stamp, "updated": stamp if not same else old.get("updated", stamp), "source": url, **data}
    with open(OUT, "w") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    print("wrote", "heartbeat" if same else "new prices", data["quote_time"])


if __name__ == "__main__":
    main()
