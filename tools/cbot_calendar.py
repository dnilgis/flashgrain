"""CBOT corn and soybean calendar: exchange holidays, early closes, first notice and last trading days.

  python tools/cbot_calendar.py             write data/cbot.json
  python tools/cbot_calendar.py --selftest  check known dates, write nothing

Read by tools/harvest.py (market open/closed, expired contracts), assets/js/site.js and tools/feed.mjs
(a row past its contract's last trading day shows a dash) and /admin (contract roll warning).
Run once a year, after CME publishes the next year's holiday calendar, and compare the holidays it prints.

Rules (CME Rulebook, chapters 10 and 11):
  last trading day (LTD) = the business day before the 15th calendar day of the contract month
  first notice day (FND) = the last business day of the month before the contract month
  business day = a weekday that is not an exchange holiday
Symbols are DTN style: @C / @S + last digit of the year + month code (@C6Z = Dec 2026 corn).
"""
import json, os, sys
from datetime import date, timedelta

OUT = os.path.join(os.path.dirname(__file__), "..", "data", "cbot.json")
YEARS = range(2026, 2030)
CORN, SOY = "HKNUZ", "FHKNQUX"
MONTH = {"F": 1, "G": 2, "H": 3, "J": 4, "K": 5, "M": 6, "N": 7, "Q": 8, "U": 9, "V": 10, "X": 11, "Z": 12}
GRAIN_EARLY = "12:05"  # CME's holiday notice for Nov 27 2026: grains close 12:05 CT


def easter(y):
    """Gregorian Easter Sunday (Anonymous / Meeus algorithm)."""
    a, b, c = y % 19, y // 100, y % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mo = (h + l - 7 * m + 114) // 31
    return date(y, mo, (h + l - 7 * m + 114) % 31 + 1)


def nth(y, mo, wd, n):
    """n-th weekday wd (Mon=0) of a month; n=-1 for the last one."""
    if n > 0:
        d = date(y, mo, 1)
        return d + timedelta(days=(wd - d.weekday()) % 7 + 7 * (n - 1))
    d = date(y, mo + 1, 1) - timedelta(days=1) if mo < 12 else date(y, 12, 31)
    return d - timedelta(days=(d.weekday() - wd) % 7)


def observed(d):
    """Saturday holiday -> Friday, Sunday -> Monday. New Year's Day on a Saturday is not moved back into
    the old year (CME stayed open Dec 31 2021)."""
    if d.weekday() == 5:
        return None if (d.month, d.day) == (1, 1) else d - timedelta(days=1)
    if d.weekday() == 6:
        return d + timedelta(days=1)
    return d


def holidays(y):
    fixed = [date(y, 1, 1), date(y, 6, 19), date(y, 7, 4), date(y, 12, 25)]
    out = [observed(d) for d in fixed]
    out += [nth(y, 1, 0, 3), nth(y, 2, 0, 3), easter(y) - timedelta(days=2), nth(y, 5, 0, -1),
            nth(y, 9, 0, 1), nth(y, 11, 3, 4)]  # MLK, Presidents, Good Friday, Memorial, Labor, Thanksgiving
    return sorted(d for d in out if d)


def early_closes(y, hol):
    """Day after Thanksgiving, and Christmas Eve when it is a business day."""
    out = [nth(y, 11, 3, 4) + timedelta(days=1)]
    xe = date(y, 12, 24)
    if xe.weekday() < 5 and xe not in hol:
        out.append(xe)
    return out


def calendar():
    hol = set()
    for y in YEARS:
        hol.update(holidays(y))
    early = {}
    for y in YEARS:
        for d in early_closes(y, hol):
            early[d.isoformat()] = GRAIN_EARLY
    biz = lambda d: d.weekday() < 5 and d not in hol

    def prev_biz(d):
        while not biz(d):
            d -= timedelta(days=1)
        return d

    contracts = {}
    for y in YEARS:
        for root, months in (("@C", CORN), ("@S", SOY)):
            for code in months:
                mo = MONTH[code]
                ltd = prev_biz(date(y, mo, 14))
                fnd = prev_biz(date(y, mo, 1) - timedelta(days=1))
                contracts["%s%d%s" % (root, y % 10, code)] = {"fnd": fnd.isoformat(), "ltd": ltd.isoformat()}
    return {
        "about": ("CBOT corn and soybean calendar: exchange holidays, early closes, first notice and last trading days. "
                  "Written by tools/cbot_calendar.py. Update once a year. Holidays are by CME's standing rule (New Year, "
                  "MLK, Presidents, Good Friday, Memorial, Juneteenth, July 4, Labor, Thanksgiving, Christmas; Saturday "
                  "moves to Friday, Sunday to Monday), not checked one by one against cmegroup.com, which could not be "
                  "reached when this was written. Early closes (12:05 CT, day after Thanksgiving and Christmas Eve) are "
                  "by rule too; only Nov 27 2026 12:05 was seen quoted from CME's holiday page. Check each new year."),
        "checked": date.today().isoformat(),
        "holidays": sorted(d.isoformat() for d in hol),
        "early_close": dict(sorted(early.items())),
        "contracts": dict(sorted(contracts.items(), key=lambda kv: (kv[0][:2], kv[0][2], MONTH[kv[0][3]]))),
    }


def selftest():
    c = calendar()
    k = c["contracts"]
    checks = [
        (k["@S6X"] == {"fnd": "2026-10-30", "ltd": "2026-11-13"}, "@S6X FND Fri Oct 30 2026, LTD Fri Nov 13"),
        (k["@C6Z"] == {"fnd": "2026-11-30", "ltd": "2026-12-14"}, "@C6Z FND Mon Nov 30 2026, LTD Mon Dec 14"),
        (k["@C7N"]["ltd"] == "2027-07-14", "@C7N LTD Wed Jul 14 2027"),
        (k["@S7F"]["fnd"] == "2026-12-31", "@S7F FND Thu Dec 31 2026 (Jan 1 is a holiday, not a business day)"),
        (k["@C7H"]["fnd"] == "2027-02-26", "@C7H FND Fri Feb 26 2027"),
        ("2026-11-26" in c["holidays"] and "2026-12-25" in c["holidays"] and "2027-01-01" in c["holidays"],
         "Thanksgiving, Christmas 2026 and New Year 2027 are holidays"),
        ("2026-07-03" in c["holidays"], "July 4 2026 is a Saturday: observed Fri Jul 3"),
        ("2027-03-26" in c["holidays"] and "2028-04-14" in c["holidays"], "Good Friday 2027 Mar 26, 2028 Apr 14"),
        ("2027-12-31" not in c["holidays"], "New Year 2028 on a Saturday: Dec 31 2027 stays open"),
        (c["early_close"].get("2026-11-27") == "12:05" and c["early_close"].get("2026-12-24") == "12:05",
         "early close 12:05 on Nov 27 and Dec 24 2026"),
        ("2027-12-24" not in c["early_close"], "Christmas 2027 observed Fri Dec 24: closed, not early"),
        (len(k) == 4 * (len(CORN) + len(SOY)), "every corn and soybean contract 2026 to 2029"),
    ]
    bad = 0
    for ok, msg in checks:
        print(("ok   " if ok else "FAIL ") + msg)
        bad += not ok
    return bad


if __name__ == "__main__":
    if "--selftest" in sys.argv:
        sys.exit(1 if selftest() else 0)
    with open(OUT, "w") as f:
        json.dump(calendar(), f, indent=1)
        f.write("\n")
    print("wrote", OUT)
