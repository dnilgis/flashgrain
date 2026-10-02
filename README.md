# Flash Grain website

Static site for Flash Grain LLC, Thorp and Granton, WI. GitHub Pages, no framework, no build step.
Staging at flshgrn.com.

## Folders

```
index.html            home: bids, hours, weather, locations, lime, target offers
discounts.html        2026 discount schedule
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
data/refs/<id>.json   nearby elevators' own posted bids (Ace Ethanol, Northside). Written by the harvester.
tools/harvest.py      reads DTN, decodes, checks, writes data/bids.json; --refs reads DTN reference boards
tools/refs_bushel.mjs reads Bushel reference boards (Ace Ethanol)
tools/vendor/parse.mjs  board parser copied from dnilgis/bids (header says which commit)
.github/workflows/harvest.yml   runs the harvester
CNAME                 flshgrn.com
robots.txt            staging: blocks search engines
```

## How a bid gets on the page

Cash = futures (data/bids.json, from DTN) + basis (data/site.json, from /admin), per location.
DTN's own basis is shown in /admin next to each row for reference; it does not reach the site.
Every admin save lists the cash prices it will change and warns on a positive basis, a basis more
than 25 cents from DTN's, or a shown row with no futures quote.

What the public page does when data is old:
- Harvester heartbeat (`checked`) older than 2 hours: cash column hidden, "Bids not updating" shown, call prompt.
- CBOT closed (weekends, 1:20 PM to 7 PM, 7:45 to 8:30 AM): stamp says "CBOT closed", the live dot stops. Exchange holidays are not modelled.
- The basis date ("Basis set ...") is written by the admin on any save that changes a price.

When DTN is down: the harvester falls back to Yahoo Finance futures, then to agsist's data/prices.json
(only if under 2 hours old). A backup price more than 15% from DTN's last price is refused.
bids.json records `futures_source` (dtn, yahoo, agsist); /admin says so on load. Contracts the backup
has no quote for (often the far-out years) show a dash, not a guess.

Nearby bids: site.json `references` lists other elevators' boards (Ace Ethanol Stanley corn, Northside
Loyal soybeans). They print below Jeff's bids, labelled as that elevator's price, never mixed into his.
Hidden on the page if not read in 2 hours. Show/hide and the location name are in /admin. If a board
lists several locations and none matches, the Actions log prints the names it found.

## Admin key (one time per person)

Works for the repo owner. A fine-grained key cannot reach a personal repo for a collaborator
(GitHub limitation), so before Jeff gets his own key, transfer the repo to an organization he is a
member of (or to his account), then follow the same steps.

1. github.com > profile picture > Settings > Developer settings > Personal access tokens > Fine-grained tokens > Generate new token.
2. Name: `flashgrain admin`. Expiration: 90 days (GitHub emails before it expires).
3. Repository access: Only select repositories > `flashgrain`.
4. Permissions > Repository permissions > Contents: Read and write. Leave everything else at No access.
5. Generate, copy, paste into flshgrn.com/admin, tick Remember, Load.

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

A run with no price change commits nothing, except a heartbeat once an hour. A contract that fails
cash == futures + basis is dropped and logged; if no corn or no soybean contract survives, the run
fails, writes nothing, and GitHub emails you. If the heartbeat stops for 2 hours, the public page
hides cash and tells people to call.

After the first harvester commit, check the Actions tab for a `pages-build-deployment` run, to
confirm harvester commits rebuild the site.

## Launch checklist (when moving to flashgrain.com)

- Delete the `Disallow` line in robots.txt.
- Delete `<meta name="robots" content="noindex, nofollow">` from index.html and discounts.html (keep it on admin and 404).
- Change CNAME to the new domain; repoint DNS (Jeff's login).
- Change `flshgrn.com` in the canonical and og: tags of index.html and discounts.html.
- Decide whether flashgrains.com stays on DTN: the harvester reads it and the portal button links to it.
