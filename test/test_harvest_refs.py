import os, sys, unittest

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "tools"))
import harvest  # noqa: E402

PAGE = open(os.path.join(os.path.dirname(__file__), "fixtures", "dtn-cash-page.html"), encoding="latin-1").read()
NORTHSIDE = {"id": "northside", "commodity": "Soybeans", "location": None}  # as in data/site.json


class RefErrors(unittest.TestCase):
    def test_northside_empty_board_plain_words(self):
        """Real case: data/refs/northside.json said 'no Soybeans rows for None. Locations: none. ...'."""
        empty = PAGE.split("<table")[0] + "</body></html>"
        with self.assertRaises(ValueError) as e:
            harvest.pick_ref(empty, NORTHSIDE)
        msg = str(e.exception)
        self.assertEqual(msg, "their board showed no soybean bids (no bid table on the page).")
        self.assertNotIn("None", msg)

    def test_wrong_location_names_the_ones_found(self):
        with self.assertRaises(ValueError) as e:
            harvest.pick_ref(PAGE, {"id": "x", "commodity": "Soybeans", "location": "Loyal"})
        self.assertIn("at Loyal. Locations on the board: Thorp.", str(e.exception))

    def test_found(self):
        got = harvest.pick_ref(PAGE, NORTHSIDE)
        self.assertEqual(got["rows"][0]["futures_month"], "@S6X")
        self.assertEqual(got["rows"][0]["cash"], 11.79)
