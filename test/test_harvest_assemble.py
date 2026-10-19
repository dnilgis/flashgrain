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


class Sources(unittest.TestCase):
    NOW = datetime(2026, 10, 19, 18, 50, tzinfo=timezone.utc)

    def test_all_dtn(self):
        out, _ = run(self.NOW)
        self.assertEqual(out["futures_source"], "dtn")
        self.assertEqual(set(out["futures_sources"].values()), {"dtn"})
        self.assertEqual(sorted(out["futures_sources"]), WANTED)

    def test_backup_fills_a_month_dtn_lacks(self):
        """Jeff turns on Mar 27 corn (@C7H): DTN's board does not post it, the elevator boards do. The file used
        to say futures_source "dtn" and copy the board price into dtn_futures as if DTN had quoted it."""
        seen = {}

        def backup(symbols, last):
            seen["last"] = dict(last)
            return {"@C7H": {"price": 4.855, "change": None, "time": None}}, {"@C7H": "boards"}, []
        old = copy.deepcopy(OLD)
        with redirect_stderr(io.StringIO()), redirect_stdout(io.StringIO()):
            out = harvest.assemble(old, WANTED + ["@C7H"], SITE, self.NOW, dtn_page(), backup, CAL)
        self.assertEqual(out["futures_sources"]["@C7H"], "boards")
        self.assertEqual(out["futures_sources"]["@C6Z"], "dtn")
        self.assertEqual(out["futures_source"], "mixed")
        self.assertEqual(out["extra_futures_source"], "boards")
        self.assertNotIn("@C7H", out["dtn_futures"], "a board price is never stored as DTN's")
        self.assertIn("@C6Z", seen["last"], "backups are checked against today's DTN prices")

    def test_dtn_down_keeps_old_dtn_yardstick(self):
        def down():
            raise SystemExit("all fetches failed")

        def backup(symbols, last):
            fut = {s: {"price": OLD["futures"][s]["price"] + 0.01, "change": None, "time": "2026-10-19T13:40:00"} for s in symbols}
            return fut, {s: ("agsist" if s.endswith("8X") else "boards") for s in symbols}, []
        out, _ = run(self.NOW, fetch=down, backup=backup)
        self.assertEqual(out["futures_source"], "agsist+boards")
        self.assertEqual(out["dtn_futures"], OLD["dtn_futures"], "dtn_futures keeps DTN's last own prices")


class Sanity(unittest.TestCase):
    LAST = OLD["dtn_futures"]  # Oct 19: @C6Z 4.67, @C7Z 5.0425, @S6X 12.535 ...

    def test_same_contract(self):
        self.assertIsNone(harvest.sanity("@C6Z", 4.70, self.LAST))
        self.assertIn("refused", harvest.sanity("@C6Z", 5.50, self.LAST), "18% off")
        self.assertIn("refused", harvest.sanity("@C6Z", 9.10, {"@C6Z": {"price": 8.00}}), "13.75% but $1.10: past the corn band")
        self.assertIsNone(harvest.sanity("@S6X", 13.90, {"@S6X": {"price": 12.535}}), "$1.37 and 11%: inside both")

    def test_backup_only_contract_vs_neighbour(self):
        """A contract DTN never posted used to pass with no check at all."""
        self.assertIsNone(harvest.sanity("@C7H", 4.855, self.LAST), "Mar 27 corn near Dec 26 4.67")
        self.assertIn("@C6Z", harvest.sanity("@C7H", 485.5, self.LAST), "cents for dollars")
        self.assertIn("refused", harvest.sanity("@C7H", 12.40, self.LAST), "a soybean price on a corn contract")
        self.assertIsNone(harvest.sanity("@S7F", 12.70, self.LAST))
        self.assertIsNone(harvest.sanity("@C7H", 4.855, {}), "nothing from DTN to compare with: allowed, as before")

    def test_source_label(self):
        self.assertEqual(harvest.source_label({"@C6Z": "dtn"}), "dtn")
        self.assertEqual(harvest.source_label({"@C6Z": "dtn", "@C7H": "boards"}), "mixed")
        self.assertEqual(harvest.source_label({"@C6Z": "yahoo", "@S6X": "agsist+boards"}), "agsist+boards+yahoo")


class BackupFutures(unittest.TestCase):
    def test_refused_board_price_leaves_no_source(self):
        saved = harvest.board_futures, harvest._get

        def boom(url, timeout=20):
            raise OSError("offline in tests")
        harvest.board_futures = lambda syms: ({"@C7H": {"price": 485.5, "change": None, "time": None},
                                               "@C7K": {"price": 4.93, "change": None, "time": None}}, [])
        harvest._get = boom
        try:
            with redirect_stderr(io.StringIO()):
                got, src, notes = harvest.backup_futures(["@C7H", "@C7K"], OLD["dtn_futures"])
        finally:
            harvest.board_futures, harvest._get = saved
        self.assertEqual(sorted(got), ["@C7K"])
        self.assertEqual(src, {"@C7K": "boards"})
        self.assertTrue(any("@C7H refused" in n for n in notes))
