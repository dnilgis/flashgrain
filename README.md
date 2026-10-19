# Flash Grain website

Static site for Flash Grain LLC, Thorp and Granton, WI. GitHub Pages, no framework, no build step.
Staging at flshgrn.com.

## Folders

```
index.html            home: bids, hours, weather, locations, lime, target offers
discounts.html        2026 discount schedule. Stays exactly as Jeff gave it (Sig, Oct 19 2026); change only on Jeff's word.
offers.html           target offers: one short address (/offers) that opens the DTN offer portal, with the login and order videos
404.html
admin/index.html      edit panel (hours, basis, which bid rows show, notices, lime, contact)
assets/css/site.css   one stylesheet for every page
assets/css/admin.css  admin-only styles
assets/js/site.js     renders bids and hours from data/, weather, intro bolt
assets/js/admin.js    admin panel logic, saves data/site.json to this repo
assets/img/            bolt.svg, apple-touch-icon.png, og.png (link preview image)
assets/fonts/          self-hosted Barlow, Barlow Condensed, JetBrains Mono (OFL, see LICENSE.txt)
favicon.ico
data/site.json        everything Jeff can change. Edited by /admin. Do not hand-edit unless you mean it.
data/bids.json        futures, trade time, heartbeat, DTN reference. Written by the harvester. Never hand-edit.
data/cbot.json        CBOT calendar: exchange holidays, early closes, first notice and last trading day per contract. Written by tools/cbot_calendar.py, once a year.
data/refs/<id>.json   nearby elevators' own posted bids (Ace Ethanol, Northside). Written by the harvester.
feed/<yard>.json      posted cash bids as a feed (emmert-cash-bids/2) for dnilgis/bids. Written by tools/feed.mjs every harvest.
tools/feed.mjs        builds feed/*.json with site.js's own money(), so it matches the page to the cent; --selftest
tools/harvest.py      reads DTN, decodes, checks, writes data/bids.json; --refs reads DTN reference boards; --selftest
tools/cbot_calendar.py writes data/cbot.json from CME's rules; --selftest
tools/refs_bushel.mjs reads Bushel reference boards (Ace Ethanol)
tools/vendor/parse.mjs  board parser copied from dnilgis/bids (header says which commit)
.github/workflows/harvest.yml   runs the harvester (its selftest first)
.github/workflows/test.yml      every test on each push and pull request
test/                 python unittest (test_*.py), node:test (*.mjs), fixtures copied from real data
CNAME                 flshgrn.com
robots.txt            staging: blocks search engines
sitemap.xml           public pages for search engines; uses the current domain, change it at launch with the rest
```

## How a bid gets on the page

Cash = futures (data/bids.json) + basis (data/site.json, from /admin), per location.
Jeff sets basis only here. Since 2026-10-07 he no longer posts bids to DTN; DTN still runs the
target-offer portal (www.flashgrains.com) and its board is still where the harvester reads futures.
Third-party widgets (DTN's included) only ever go on the site inside an iframe, never as a script on our
own pages: a script on flshgrn.com could read the admin key a browser has remembered.
Every admin save opens a review sheet that lists the cash prices it will change, with Back focused and
Publish a deliberate tap. It warns on a positive basis, a basis more than 25 cents from the last saved
value or, for a month just turned on or a changed contract, from the nearest shown month of the same
crop (typo guard, in cents with the cash effect), and on a shown row with no futures quote.
Also in /admin: unpublished edits are kept on the device and offered back; each changed row has "Back to
saved" and the save bar has "Discard all changes"; a save that collides with another device keeps both
sets of changes when they touched different boxes and asks only on a real clash; hours like "7-9" ask
"7 AM to 9 PM?"; each row shows the nearby elevator's bid for the same month; a yellow card warns 5
business days before a shown row's contract hits first notice, and one tap moves it to the next contract
with a suggested basis that keeps cash the same (Jeff confirms). With Remember ticked the panel loads by
itself. Download (a copy of site.json) is under Advanced.

What the public page does when data is old:
- Harvester heartbeat (`checked`) older than 2 hours: cash column hidden, "Bids not updating" shown, call prompt.
- CBOT closed (weekends, 1:20 PM to 7 PM, 7:45 to 8:30 AM, exchange holidays, 12:05 PM early closes from data/cbot.json): stamp says "CBOT closed", the live dot stops.
- The basis date ("Basis set ...") is written by the admin on any save that changes a price.
- The feed (feed/<yard>.json) follows the page: status "stale" past the same 2 hours, an expired or past row
  is left out. dnilgis/bids withdraws Flash Grain's prices at 2 hours too, through a per-source `maxAgeH` in its
  sources/flashgrain-*.json (set in the bids repo), so the page, the feed and the bids board agree.

Futures: DTN's board first (it answers: on Oct 19 2026 every harvest read all six contracts from it; it timed
out for a few days in mid October), then live elevator boards (via dnilgis/bids), Yahoo, agsist's
data/prices.json (under 2 hours old), Ace's board (corn). A backup price is refused when it is more than 15%
or more than $1.00 corn / $2.00 soybeans from DTN's last price for that contract; a contract DTN never quoted
is refused when it is more than 30% from DTN's nearest contract of the same crop (catches cents for dollars
and the wrong crop). The day's change for a board price comes from agsist's settle, only when that file is fresh.

bids.json records where each price came from: `futures_sources` {contract: dtn, boards, yahoo, agsist or ace},
and `futures_source` sums it up ("dtn" only when every contract came from DTN, "mixed" when some did).
`dtn_futures` holds only prices DTN itself gave. `quote_time` is when the prices are as of, and
`quote_time_source` says how we know: DTN's trade times, DTN's "Price as of" stamp, the backup's own time,
or "run" (DTN printed no time, so the harvester's run time; true since mid October 2026). A contract no
source has shows a dash, not a guess.

Nearby bids: site.json `references` lists other elevators' boards (Ace Ethanol Stanley corn, Northside
Loyal soybeans). Shown ONLY in /admin, as a reference while setting basis. Never on the public site,
never mixed into Jeff's prices. The location name is set in /admin. If a board lists several locations
and none matches, the error printed in /admin names the ones it found.

## Delivery months

/admin lists every delivery period per crop: the next 12 months plus Fall of this year and the next two.
Tap a month on, type its basis; months already past drop off the site by themselves ("Oct 26" runs to
the end of October, "Fall 26" to the end of December). Futures by the usual rule: the nearest listed
contract at or after the delivery month (corn H K N U Z, soybeans F H K N Q U X); Fall = Dec corn / Nov
soybeans. "Edit contracts" overrides the symbol per month.

The harvester fetches futures for every month that is on. DTN's board only posts Jeff's own Fall rows,
so other contracts come from the backups above, in that order. A contract none of
them carries shows a dash and the save warns first. Since 2026-10-07 agsist fetches every corn and soybean
contract through Dec 28 corn and Nov 28 soybeans, so a dash today means the feed is down, not missing.

## Contract roll

Every futures contract stops trading. Its last trading day (LTD) is the business day before the 15th of the
contract month; first notice day (FND) is the last business day of the month before. Fall 26 soybeans ride Nov
26 futures (@S6X): FND Fri Oct 30 2026, LTD Fri Nov 13. Dec 26 corn (@C6Z): FND Mon Nov 30, LTD Mon Dec 14.
data/cbot.json lists both dates for every corn and soybean contract through 2029.

- From 5 business days before FND, /admin shows a card on each shown row riding that contract, with the next
  contract and the spread, so Jeff can move the row and set its new basis. Which contract and which basis
  is Jeff's call; the site never rolls a row by itself.
- From the day after LTD (Central), the harvester publishes no price for that contract (the last one would
  be the final settle, frozen), the page shows a dash on that row and the feed leaves it out, until the row
  is moved to a live contract in /admin.

Once a year (December, after CME publishes next year's holidays): run `python tools/cbot_calendar.py`,
compare its holidays and early closes with cmegroup.com's holiday calendar, and commit data/cbot.json. The
holidays in it today are by CME's standing rule, not checked date by date (the "about" line says so).

## Tests

    python tools/cbot_calendar.py --selftest
    python tools/harvest.py --selftest          saved DTN page in test/fixtures, market clock, calendar
    python -m unittest discover -s test -p "test_*.py"
    node tools/feed.mjs --selftest
    node --test test/*.mjs

All of them run in .github/workflows/test.yml on each push; the harvester's selftest also runs before every harvest.

## Admin key (one time per person)

Works for the repo owner. A fine-grained key cannot reach a personal repo for a collaborator
(GitHub limitation), so before Jeff gets his own key, transfer the repo to an organization he is a
member of (or to his account), then follow the same steps.

1. github.com > profile picture > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token.
2. Name: `flashgrain admin`. Expiration: 90 days (GitHub emails before it expires).
3. Repository access: Only select repositories > `flashgrain`.
4. Permissions > Repository permissions > Contents: Read and write. Leave everything else at No access.
5. Generate, copy, paste into flshgrn.com/admin, tick Remember, Load. Next time the panel loads by itself.

Lost the device? Delete the token on that same GitHub page. The panel stops saving instantly.

## Harvester clock (cron-job.org)

GitHub's own hourly schedule (minute 7) is only a backup: GitHub runs it late or skips it under load.
cron-job.org is the real clock, same as the Emmert sites.

1. Make a second fine-grained token: `flashgrain harvest trigger`, only the `flashgrain` repo, permission Actions: Read and write. Nothing else.
2. cron-job.org > Create cronjob.
   - URL: `https://api.github.com/repos/dnilgis/flashgrain/actions/workflows/harvest.yml/dispatches`
   - Schedule: every 10 minutes.
   - Advanced > Request method: POST.
   - Headers: `Authorization: Bearer <that token>` · `Accept: application/vnd.github+json` · `X-GitHub-Api-Version: 2022-11-28`
   - Body: `{"ref":"main"}`
3. Save, run once by hand, then check the repo's Actions tab for a green run.

Every run writes data/bids.json (its `checked` time is the heartbeat the page reads), so every run makes a
commit and a Pages build: about 6 an hour, around the clock. A contract that fails
cash == futures + basis is dropped and logged; if no corn or no soybean contract survives, the run
fails, writes nothing, and GitHub emails you. If the heartbeat stops for 2 hours, the public page
hides cash and tells people to call.

After the first harvester commit, check the Actions tab for a `pages-build-deployment` run, to
confirm harvester commits rebuild the site.

## Launch checklist (when moving to flashgrain.com)

Sig's plan (Oct 19 2026, not today): flashgrain.com AND flashgrains.com both end up pointing at this repo.
GitHub Pages serves one custom domain, so flashgrain.com goes in CNAME and the other names forward to it
with a registrar 301 (path kept): flashgrains.com, and flshgrn.com, so links already texted keep working.

WARNING: www.flashgrains.com today hosts DTN's target-offer portal (site.json `portal_url`, offers.html,
the buttons on index.html). Before flashgrains.com moves, Jeff gets DTN to serve the portal at another
address and updates the portal link in /admin, or every offer button breaks. The harvester also reads
futures from www.flashgrains.com (URLS in tools/harvest.py): move those to DTN's new address the same day.

1. `grep -rn flshgrn . --exclude-dir=.git` and change every hit outside feed/ (they rewrite themselves on the next harvest):
   - CNAME (the new domain).
   - index.html: canonical, og:url, og:image, and the 11 URLs in the JSON-LD block (`@id`, `url`, `logo`, `image`).
   - discounts.html and offers.html: canonical, og:url, og:image.
   - sitemap.xml: every `<loc>`.
   - tools/feed.mjs needs no edit: its note reads CNAME.
2. robots.txt: delete the `Disallow` line and add `Sitemap: https://<new domain>/sitemap.xml`.
3. Delete `<meta name="robots" content="noindex, nofollow">` from index.html, discounts.html and offers.html (keep it on admin and 404).
4. DNS (Jeff's login): the new domain to GitHub Pages; flashgrains.com and flshgrn.com to the registrar's 301
   forward to it. Repo Settings > Pages: custom domain, then tick Enforce HTTPS once the certificate is issued.
5. Same hour: in dnilgis/bids, change `url` in sources/flashgrain-thorp.json and flashgrain-granton.json to the
   new domain's /feed/thorp.json and /feed/granton.json (the forward covers the gap, but do not lean on it).
6. Google Search Console: add the new domain, submit the sitemap, use Change of Address from flshgrn.com if it
   was ever verified. Google Business Profile for each yard: website link to the new domain, hours matching
   /admin.
7. Check: the home page, /offers, /discounts.html, /admin on the new domain; an old flshgrn.com link lands on
   the same page; the next harvest's feed/*.json says the new domain in its note.
