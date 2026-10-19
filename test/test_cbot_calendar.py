import json, os, sys, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "tools"))
import cbot_calendar  # noqa: E402


class Calendar(unittest.TestCase):
    def test_selftest(self):
        self.assertEqual(cbot_calendar.selftest(), 0)

    def test_committed_file_matches_the_rules(self):
        """data/cbot.json is what the tool writes today, apart from the 'checked' date."""
        have = json.load(open(os.path.join(ROOT, "data", "cbot.json")))
        want = cbot_calendar.calendar()
        for k in ("holidays", "early_close", "contracts"):
            self.assertEqual(have[k], want[k], k)

    def test_real_case_fall26_beans(self):
        """Fall 26 soybeans ride @S6X: first notice Fri Oct 30, last trade Fri Nov 13 2026."""
        c = json.load(open(os.path.join(ROOT, "data", "cbot.json")))["contracts"]
        self.assertEqual(c["@S6X"], {"fnd": "2026-10-30", "ltd": "2026-11-13"})
        self.assertEqual(c["@C6Z"], {"fnd": "2026-11-30", "ltd": "2026-12-14"})
        self.assertEqual(c["@C7N"]["ltd"], "2027-07-14")


if __name__ == "__main__":
    unittest.main()
