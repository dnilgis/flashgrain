import json, os, sys, unittest
from datetime import datetime, timedelta, timezone

ROOT = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, os.path.join(ROOT, "tools"))
import harvest  # noqa: E402

CAL = json.load(open(os.path.join(ROOT, "data", "cbot.json")))


def old_closed_since(n):
    """The rule before holidays were modelled (git 731accd), on a Central wall time."""
    d, m = n.weekday(), n.hour * 60 + n.minute
    day = lambda back, hh, mm: (n - timedelta(days=back)).replace(hour=hh, minute=mm, second=0, microsecond=0)
    if d <= 4 and 465 <= m < 510:
        return day(0, 7, 45)
    if d <= 4 and 800 <= m < 1140 and d != 4:
        return day(0, 13, 20)
    if d == 4 and m >= 800:
        return day(0, 13, 20)
    if d == 5:
        return day(1, 13, 20)
    if d == 6 and m < 1140:
        return day(2, 13, 20)
    return None


def ct(s):
    """'2026-11-26T10:00' Central (CST in late Nov, UTC-6; CDT UTC-5 before Nov 1) -> UTC datetime."""
    n = datetime.strptime(s, "%Y-%m-%dT%H:%M")
    for off in (5, 6):
        u = (n + timedelta(hours=off)).replace(tzinfo=timezone.utc)
        if harvest._ct(u) == n:
            return u
    raise ValueError(s)


class Clock(unittest.TestCase):
    def test_ordinary_week_unchanged(self):
        """Oct 19-25 2026 has no holiday: every 5 minutes, same answer as the old rule."""
        t = ct("2026-10-19T00:00")
        while t < ct("2026-10-26T00:00"):
            self.assertEqual(harvest.closed_since(t, CAL), old_closed_since(harvest._ct(t)), harvest._ct(t))
            t += timedelta(minutes=5)

    def test_thanksgiving_2026(self):
        cs = lambda s: harvest.closed_since(ct(s), CAL)
        wed_close = datetime(2026, 11, 25, 13, 20)
        self.assertEqual(cs("2026-11-25T20:00"), wed_close, "no Wed night session before Thanksgiving")
        self.assertEqual(cs("2026-11-26T10:00"), wed_close, "Thanksgiving Day: closed since Wed 1:20 PM")
        self.assertEqual(cs("2026-11-26T20:00"), wed_close, "no Thanksgiving night session")
        self.assertIsNone(cs("2026-11-27T09:00"), "Fri after Thanksgiving opens 8:30 AM")
        self.assertEqual(cs("2026-11-27T12:30"), datetime(2026, 11, 27, 12, 5), "early close 12:05 PM")
        self.assertEqual(cs("2026-11-28T10:00"), datetime(2026, 11, 27, 12, 5), "Saturday: Friday's 12:05 close")
        self.assertIsNone(cs("2026-11-29T19:30"), "reopens Sunday 7 PM")

    def test_christmas_and_new_year(self):
        cs = lambda s: harvest.closed_since(ct(s), CAL)
        self.assertEqual(cs("2026-12-24T13:00"), datetime(2026, 12, 24, 12, 5))
        self.assertEqual(cs("2026-12-25T12:00"), datetime(2026, 12, 24, 12, 5))
        self.assertEqual(cs("2027-01-01T12:00"), datetime(2026, 12, 31, 13, 20))
        self.assertEqual(cs("2027-01-01T19:30"), datetime(2026, 12, 31, 13, 20), "New Year's Day is a Friday: shut to Sunday")
        self.assertEqual(cs("2027-01-17T20:00"), datetime(2027, 1, 15, 13, 20), "no Sunday night session before MLK Day")
        self.assertEqual(cs("2027-01-18T10:00"), datetime(2027, 1, 15, 13, 20), "MLK Day closed")
        self.assertIsNone(cs("2027-01-18T19:30"), "reopens MLK evening for Tuesday")

    def test_no_calendar_behaves_as_before(self):
        t = ct("2026-11-26T10:00")
        self.assertEqual(harvest.closed_since(t, {"holidays": []}), None)

    def test_expired(self):
        from datetime import date
        self.assertFalse(harvest.expired("@S6X", date(2026, 11, 13), CAL), "last trading day itself still trades")
        self.assertTrue(harvest.expired("@S6X", date(2026, 11, 14), CAL))
        self.assertFalse(harvest.expired("@C6Z", date(2026, 11, 14), CAL))
        self.assertFalse(harvest.expired("@W6Z", date(2030, 1, 1), CAL), "unknown contract never expires")


if __name__ == "__main__":
    unittest.main()
