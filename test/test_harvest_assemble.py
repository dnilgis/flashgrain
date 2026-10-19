"""tools/harvest.py assemble(): one harvest with the network mocked. Fixtures are the real files of Oct 19 2026."""
import copy, io, json, os, sys, unittest
from contextlib import redirect_stderr, redirect_stdout
from datetime import datetime, timezone

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "tools"))
import harvest  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
CAL = json.load(open(os.path.join(ROOT, "data", "cbot.json")))
OLD = json.load(open(os.path.join(FIX, "bids-2026-10-19.json")))
SITE = json.load(open(os.path.join(FIX, "site-shown-2026-10-19.json")))
WANTED = sorted({r["symbol"] for r in SITE["bids"]["rows"]})


def dtn_page(old=OLD):
    """What build() returned on Oct 19: DTN posts all six contracts, no trade times."""
    return lambda: ({"quote_time": None, "dtn_as_of": None, "futures": copy.deepcopy(old["futures"]),
                     "dtn": copy.deepcopy(old["dtn"])}, old["source"])


def no_backup(symbols, last):
    return {}, None, []


def run(now, fetch=None, backup=no_backup, old=OLD):
    err = io.StringIO()
    with redirect_stderr(err), redirect_stdout(io.StringIO()):
        out = harvest.assemble(copy.deepcopy(old), WANTED, SITE, now, fetch or dtn_page(old), backup, CAL)
    return out, err.getvalue()


class Expiry(unittest.TestCase):
    def test_before_ltd_all_six(self):
        out, _ = run(datetime(2026, 11, 13, 18, 0, tzinfo=timezone.utc))
        self.assertIn("@S6X", out["futures"], "Nov 13 is @S6X's last trading day: still quoted")

    def test_after_ltd_nov_beans_dropped(self):
        """Real case: Fall 26 soybeans ride @S6X (LTD Fri Nov 13 2026). From Nov 14 any quote is the final
        settle, which DTN or Yahoo keeps serving; it must not be published."""
        asked = []

        def backup(symbols, last):
            asked.extend(symbols)
            return {}, None, []
        out, err = run(datetime(2026, 11, 16, 15, 0, tzinfo=timezone.utc), backup=backup)
        self.assertNotIn("@S6X", out["futures"])
        self.assertNotIn("@S6X", asked, "no backup fetched for an expired contract")
        self.assertIn("@C6Z", out["futures"])
        self.assertIn("@S6X", err)

    def test_after_ltd_dec_corn(self):
        out, _ = run(datetime(2026, 12, 15, 15, 0, tzinfo=timezone.utc))
        self.assertNotIn("@C6Z", out["futures"])
        self.assertNotIn("@S6X", out["futures"])
        self.assertIn("@C7Z", out["futures"])


if __name__ == "__main__":
    unittest.main()
