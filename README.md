# PayoutPool

Tier-1 lead-capture funnel monetized with interstitial/popunder advertising
and optional CPA offers. One static `index.html` plus a small Cloudflare Worker for storage.

```
index.html      the funnel (all CSS + JS inline, no build step)
winners.html    published results + draw rules
terms.html     terms of entry (16 sections: eligibility, Rounds, prize, draw, taxes, liability)
privacy.html    what is collected, who it is shared with, how to opt out
404.html        not-found page
legal.css       shared styles for the four pages above
favicon.svg     icon (also used as apple-touch-icon)
favicon.ico     legacy /favicon.ico fallback so older clients do not 404
og.jpg          1200x630 social card (generated)
_headers        Cloudflare Pages security/cache headers
robots.txt      crawl rules + sitemap pointer
worker/         Cloudflare Worker + KV: /capture, /feed, /hit, /winners
```

## Deploy — Cloudflare Pages

1. Push this repo to GitHub.
2. Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git → pick the repo.
3. Build command: *(none)*. Build output directory: `/`. Framework preset: None.
4. After the first deploy, add your custom domain under **Custom domains**. Cloudflare Pages
   does not use a `CNAME` file (that is a GitHub Pages mechanism) — if you deploy to GitHub
   Pages instead, add `CNAME` containing your bare domain.

## Configure

Everything you must set lives in the `CONFIG` object at the top of the `<script>` in
`index.html`, plus the `YOURDOMAIN.com` strings in `<head>`.

| Key | What to paste | Where to get it |
|---|---|---|
| `SITE_URL` | `https://yourdomain.com` (blank = auto-detect from the browser) | your domain |
| `POPUNDER_TAG` | one popunder script URL — shorthand for a single-entry `AD_NETWORKS` | Adsterra → Websites → Add site → Popunder tag |
| `AD_NETWORKS` | array of network objects, so two networks can share the funnel — see [Two networks at once](#two-networks-at-once) | any network |
| `INTERSTITIAL_HTML` | the vignette/interstitial `<script>` or `<iframe>` snippet | Monetag → OnClick/Vignette zone |
| `AD_DIRECT_LINK` | a direct-link URL, opened in a new tab | any network's Direct Link product |
| `AD_DIRECT_LINK_ON` | `"done"` (default) or `"gate"` | see ad slots below |
| `SECOND_POP` | `true`/`false` — re-call `window.__pop()` on the confirmed screen | Adsterra exposes the hook |
| `AD_EVERY_TAP` | `true` (default) = fire on all 3 taps, like the original build; `false` = gate tap only | your call |
| `GATE_DOUBLE_FIRE` | `false` (default) = one fire on the gate tap; `true` = two, matching the original 4 fires | your call |
| `AD_BURST` | networks fired per tap, `1`–`n` — default `2` = every gate network pops on the same tap | your call |
| `AD_REPEAT_POP` | `true` (default) = a network may pop again on the next tap; `false` = once per network per visit | your call |
| `AD_SLOT_HELD` | reserved box under the "slot held for" timer | any network's banner code |
| `AD_SLOT_CARD` | reserved box inside the step card, above the CTA | banner code |
| `AD_SLOT_AFTER` | reserved box directly under the CTA ("Save my position") | banner code |
| `AD_SLOT_BELOW` | reserved box below the card | banner code |
| `AD_SLOT_CAPTURE` | reserved box inside the contact card, above the email field | banner code (300×250 / 320×100) |
| `AD_SLOT_DONE` | reserved box on the "Entry confirmed" screen, under the referral code | banner code |
| `AD_SLOT_GATE` | ad inside the sponsored interstitial (replaces the house preview) | banner / native code |
| `AD_SLOT_STICKY` | 320×50 anchor pinned to the bottom edge, with a close button | anchor/banner code |
| `AD_PLACEHOLDERS` | `true` (default) = empty slots show a dashed `AD` box; `false` = empty slots are removed | your call |
| `CAPTURE_ENDPOINT` | `https://api.yourdomain.com/capture` | your Worker (below) |
| `FEED_URL` | `https://api.yourdomain.com/feed` | same Worker |
| `HIT_URL` | `https://api.yourdomain.com/hit` | same Worker |
| `ONESIGNAL_APP_ID` | the UUID from OneSignal | OneSignal → Settings → Keys & IDs |
| `SUPPORT_EMAIL` | a monitored inbox | you |
| `OFFERS` | array of `{t,s,u,k}` CPA links | CPAGrip / OGAds, filtered to your traffic |

`YOURDOMAIN.com` appears in `<head>` four times: canonical, `og:url`, `og:image`, `twitter:image`.
Those must be absolute URLs — scrapers do not run JavaScript, so they cannot be resolved at runtime.

`<head>` also carries two Monetag tags — zone `312446` (`quge5.com`) and zone `12299927`
(`al5sm.com`). Each is its own `<script>` element, so adding or removing one is a single line and
cannot break the inline block below. Two zones on one page means two OnClick passes per tap: if the
dashboard flags it or fill drops, delete the `312446` line and keep the other.

Both sit **above** `<meta charset>`, because MultiTag must be the first thing after `<head>`. That
puts a hard limit on the block: HTML only honours a charset declaration inside the first 1024 bytes,
and this page declares it at byte 680. Any comment added above those tags eats that window — move it
below `<meta charset>` instead, and re-check the offset after touching the top of `<head>`.

ClickAdy ownership is proven by `<meta name="clckd" content="…">`, taken from ClickAdy → Add site.
It has to be in the HTML the crawler downloads — a script-injected meta will not verify — so it
lives in `<head>` and stays there after approval. ClickAdy's zone snippet is a normal ad tag, not a
popunder helper: put it in `CONFIG.POPUNDER_TAG` like any other network tag.

**Nothing fails silently.** Any key left empty logs a `[PayoutPool]` warning to the console at
boot, an empty `CAPTURE_ENDPOINT` logs a hard error on submit, and a failed POST is buffered in
localStorage and retried on the next visit. `window.__ppMissing` lists every unset key.

## Ad slots

| Slot | Key | Fires | Cap per visitor | `/hit` event |
|---|---|---|---|---|
| Under the timer | `AD_SLOT_HELD` | on load, always visible | 1 box | — |
| Above the CTA | `AD_SLOT_CARD` | on load, every step | 1 box | — |
| Under the CTA | `AD_SLOT_AFTER` | on load, every step | 1 box | — |
| Below the card | `AD_SLOT_BELOW` | on load | 1 box | — |
| In the contact card | `AD_SLOT_CAPTURE` | when step 5 appears | 1 box | — |
| Confirmed screen | `AD_SLOT_DONE` | after the lead is stored | 1 box | — |
| Inside the gate | `AD_SLOT_GATE` | when the interstitial opens | 1 box | `ad_inter` |
| Bottom anchor | `AD_SLOT_STICKY` | on load, until closed | 1 box | `ad_stick_x` |
| Popunder script | `POPUNDER_TAG` / `AD_NETWORKS[].popunder` | on every monetisable tap (see below) | `AD_BURST` per tap, repeat per `AD_REPEAT_POP` | `ad_<id>`, `ad_pop` |
| Network re-call | `SECOND_POP` | confirmed screen, +1.2s | 1 | `ad_second` |
| Direct link | `AD_DIRECT_LINK` | `AD_DIRECT_LINK_ON` | 1 tab total | `ad_direct` |
| Interstitial | `INTERSTITIAL_HTML` | gate tap, 5s skip | 1 per pageload | `ad_inter` |
| CPA offers | `OFFERS` | confirmed screen | 5 links shown | `offer_click` |

The eight `AD_SLOT_*` boxes are real reserved containers: each accepts banner HTML (an `<iframe>`,
`<ins>`, `<img>`, or a script snippet) or a bare `https://` iframe URL. Script tags are re-created
after insertion, because `innerHTML` alone never executes them — so a standard network tag works.
Every box is in the funnel where a visitor is looking, so a display campaign can run alongside the
popunder without waiting for a click. `CONFIG.AD_PLACEHOLDERS` keeps the dashed outline visible
while a slot is empty; the bottom anchor has no placeholder (an empty fixed bar would look broken)
and never comes back once a visitor closes it (`pp_stickx` in localStorage).

Density is a money question, not a "more boxes = more revenue" one. Past roughly four display units
per viewport, fill rate and CPM both fall and the form completion rate drops with them — the lead is
the better-paying event. If you add a network, prefer a second **anchor** (`AD_SLOT_STICKY`) or a
300×250 in `AD_SLOT_CAPTURE`, not another box stacked on the first screen.

The direct link deliberately **does not** fire on the gate tap by default. `window.open` on that
tap moves focus to the new tab, so the visitor never sees the interstitial and never submits the
form — you would trade a lead (worth $0.50–$3) for a direct-link click (worth $0.005–$0.02).
With `AD_DIRECT_LINK_ON: "gate"` you get the aggressive variant; the default opens the tab after
the lead is in KV, or on exit-intent if the visitor saw the form and started leaving.

## Two networks at once

`AD_NETWORKS` takes one object per network. A creative pasted straight into an `AD_SLOT_*` key
always wins; otherwise each box is offered to the networks that list it, and they rotate per
visitor on a persisted cursor, so neither network takes every impression. `POPUNDER_TAG` still
works — it is simply treated as one more network in the pool.

```js
AD_NETWORKS: [
  { id: 'monetag', head: true, weight: 1,          // its tag is already in <head>
    slots: { BELOW: 'script:https://quge5.com/88/zzz.js' } },
  { id: 'adsterra',
    popunder: 'https://cdn.net/popunder.js',
    fireOn: 'done',                                // never the gate tap
    weight: 1,
    slots: { DONE: 'script:https://cdn.net/300x250.js' } }
]
```

A creative is `script:<src>` (a script tag), a bare `https://` URL (an iframe), or raw HTML.
The `script:` form exists because a bare URL is an iframe: pasting just a script's `src` would
render an empty frame. And never paste a real closing script tag into `index.html` — it ends the
inline script early and takes the page down with it. Inside a string, write it as `<\/script>`.

Three rules the code enforces, and why:

- **Every gate network on every gate tap.** `pickPopunders(stage)` returns up to `AD_BURST` networks
  (default `2`) and `AD_REPEAT_POP: true` (default) lets the same network pop again on the next tap.
  With two gate networks installed that is two pops per tap, on three funnel taps plus the sponsored
  break and the submit — the aggressive setting. Set `AD_BURST: 1` and `AD_REPEAT_POP: false` to get
  back to one pop per tap and one per network per visit. Two networks popping on one tap is the
  double-billing complaint that gets an arbitrage account suspended, so the switch is deliberate.
- **`fireOn: 'gate' | 'done'`.** An always-on OnClick tag in `<head>` already pops on the gate tap.
  Give a second popunder network `'done'` and it fires after the lead is in KV instead. The stage
  filter runs before the burst, so a `'done'` network can never leak onto a funnel tap. Each fire
  is tracked as `ad_<id>`, so `/hit` says which network actually earned.

`weight` is an integer 1–10: `3` is the same as listing that network three times in the rotation.

Verify what actually fired, in the console:

```js
__ppAdReport()
// { networks: [ { id: 'adsterra', head: false, popunder: true, fireOn: 'done',
//                 slots: ['DONE'], popped: 2 } ],
//   configured: { popHook: true, direct: true, interstitial: true, offers: 3,
//                 burst: 2, repeatPop: true },
//   fired: { gateTaps: 3, directTab: false, secondPop: false } }
```

`popHook: false` means your network does not expose `window.__pop`, so `SECOND_POP` cannot do
anything regardless of the setting.

## Wiring Adsterra

Adsterra hands out four different kinds of code. Three of them map straight onto a key; the mapping
is not obvious, and pasting the wrong one is why a box renders empty:

| What Adsterra gives you | Where it goes | Notes |
|---|---|---|
| **Popunder → Script URL** (`https://pl…profitablecpmgate.com/xx/yy/zz/script.js`) | `AD_NETWORKS[].popunder` | loads on every gate tap; tracked as `ad_adsterra` |
| **Banner** `300x250`, `468x60`, `320x50` | `AD_SLOT_*` or `AD_NETWORKS[].slots` | copy the **invoke.js** URL, prefix it with `script:` |
| **Native banner** | `AD_SLOT_*` as raw HTML | needs its script *and* its `<div id="container-…">` together |
| **Direct link** | `AD_DIRECT_LINK` | one tab per visitor, after the lead by default |

The banner snippet Adsterra shows is two `<script>` tags — `atOptions = {...}` then `invoke.js`.
`runScripts()` rebuilds them in document order, so the inline one defines `atOptions` before
`invoke.js` runs: **paste just the `invoke.js` URL** with a `script:` prefix and it works. If you
prefer the whole snippet, paste it as raw HTML and write the closing tags as `<\/script>`.

```js
AD_NETWORKS: [
  { id: 'adsterra',
    popunder: 'https://pl01234567.profitablecpmgate.com/xx/yy/zz/script.js',
    fireOn: 'gate',
    weight: 1,
    slots: {
      HELD: 'script:https://www.highperformanceformat.com/abcdef/invoke.js',
      CARD: 'script:https://www.highperformanceformat.com/abcdef/invoke.js',
      AFTER: '',
      BELOW: '',
      CAPTURE: 'script:https://www.highperformanceformat.com/ghijkl/invoke.js',
      DONE: 'script:https://www.highperformanceformat.com/mnopqr/invoke.js',
      GATE: '',
      STICKY: 'script:https://www.highperformanceformat.com/stuvwx/invoke.js'
    } }
]
```

Fill `AFTER` and `GATE` last, if at all: the gate already carries the popunder and the sponsored
break, and two units stacked there is the placement that gets a visitor to close the tab.

A network only counts as wired once it has a `popunder` or at least one slot; an entry with every
URL still empty does **not** silence the boot warning, so a half-pasted block cannot look healthy.

Verify the page before and after, in the console:

```js
__ppAdReport().networks        // [] before, [{ id: 'adsterra', popped: … }] after
document.querySelectorAll('.ad.fill, .adBox.filled').length   // boxes that took a creative
```


## Worker — storage for captures and the feed

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create PP      # copy the printed id into wrangler.toml
npx wrangler deploy
```

Then set `ALLOWED_ORIGIN` in `worker/wrangler.toml` to your real origin, redeploy, and paste the
three URLs into `CONFIG`.

| Route | Method | Purpose |
|---|---|---|
| `/capture` | POST | validates, rate-limits to 5/IP/hour, stores the lead in KV, appends a masked row to the feed |
| `/feed` | GET | last 40 entries as `{n,p,t}` — first letter + `•••`, city/region, timestamp |
| `/hit` | POST | increments an allow-listed funnel counter (`step_1`, `ad`, `done`, …) |
| `/winners` | GET | published draw results, newest round first, cached 5 min |
| `/winners` | POST | publishes one round (needs `X-Admin-Token`); re-posting a round replaces it |
| `/winners?round=…` | DELETE | unpublishes one round (needs `X-Admin-Token`) |
| `/health` | GET | liveness + KV binding check |

### Publishing a round (the winners "database")

No separate database is needed: the draws are already listed in KV under `winners`, and
`winners.html` renders them. Turn writes on once, then publish after each draw.

```bash
cd worker
npx wrangler secret put ADMIN_TOKEN          # pick a long random string
# then, after drawing:
curl -X POST https://api.yourdomain.com/winners \
  -H "X-Admin-Token: $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"round":"November 2026","drawDate":"2026-12-03",
       "rows":[{"name":"Priya S.","region":"ON","amount":"$250"}]}'
```

- Without `ADMIN_TOKEN` the endpoint answers `503 publishing-disabled`; with it, an anonymous
  caller gets `401 unauthorized`. There is no way for a visitor to inject a name.
- Max 20 rows per round, 24 rounds kept; strings are stripped to 40 chars and control characters
  are removed, so a pasted row cannot break the table.
- `GET /winners` and `/feed` are public by design. `/feed` only ever exposes a masked display name
  (`M•••`) and a coarse region; `/winners` is the consented, published list.
- Last step: paste `https://api.yourdomain.com/winners` into `WINNERS_URL` at the bottom of
  `winners.html`. Empty = the static "No results published yet" row stays, which is also what the
  page shows before your first real draw.

Reading leads back out: `npx wrangler kv key list --namespace-id=<id>` or wire the KV namespace to
a Google Sheet with a scheduled Worker. KV is eventually consistent (≈60 s), which is fine for
this funnel and costs nothing at these volumes.

## Analytics bot — clicks and funnel, from the terminal

`bot/pp_analytics.py` is a stdlib-only Python 3.8+ CLI over the Worker's `GET /stats`
(token = the same `ADMIN_TOKEN` secret). It never touches a visitor's email or phone; `/stats`
returns counters only.

```bash
python bot/pp_analytics.py health
python bot/pp_analytics.py stats                 # funnel + clicks table
python bot/pp_analytics.py watch --interval 15   # live click deltas + alerts
python bot/pp_analytics.py report --days 30      # writes reports/*.json|.csv|.md
python bot/pp_analytics.py selftest              # offline checks
```

`watch` compares consecutive `/stats` snapshots and reports what moved: which network's `ad_<id>`
counter fired, how many steps were taken, whether a capture view ever became an entry. Alerts:

| code | meaning |
|---|---|
| `CLICKS WITHOUT TRAFFIC` | ad/click events with no new page views — cached page, reopened tab, or injected clicks |
| `BURST` | one counter grew by `--storm` (default 25) inside a single window |
| `CAPTURE GAP` | 5+ capture forms shown since the last confirmed entry |
| `LEAD LEAK` | capture views recorded, zero `done` |
| `FORM STARVED` | under 5% of views reach the form |
| `CLICK HEAVY` | more than 8 click events per visit (normal at `AD_BURST: 2`) |

Tests: `python -m unittest discover -s bot -p "test_*.py" -v` starts a throwaway HTTP server that
mimics the Worker, so the urllib path, the `X-Admin-Token` header, the 401 and the file writing are
all exercised with no network. `bot/README.md` has the details.

## What changed from the previous build

Fixed:

- **Referral codes no longer collide.** `?ref=` is stored in `pp_inbound`; your own code is
  generated once into `pp_code`. Previously both used `pp_ref`, so every downstream share
  advertised the original referrer.
- **The countdown re-rolls instead of dying at 00:00.** `refreshDeadline()` issues a fresh
  15-minute window whenever the stored one has expired, and the in-page timer does the same.
- **Queue number is generated once and persisted** (`pp_queue`), so the copy, the card, and a
  reload all show the same position. The hardcoded `#1,247` is gone.
- **Progress bar and label agree.** Progress is `(step − 1) / 5`, so `STEP 1 OF 5` is 0%,
  `STEP 5 OF 5` is 80%, and submitted is 100%. The step array is indexed before any increment,
  so step 1 actually renders.
- **Ads fire on every click that matters.** `fireAd()` runs on `Confirm and continue →`, on
  `Save my position →`, on the sponsored gate tap, on `Continue` out of the sponsored break, and on
  a valid form submit; `finish()` then fires the `'done'` stage. `GATE_DOUBLE_FIRE` adds the
  original extra gate fire. `__ppAdReport().fired.gateTaps` counts every fire, so the tap map is
  auditable instead of assumed. The direct link is still capped at one tab per visitor.
- **Reduced motion freezes the ticker** (`animation: none`, single non-duplicated list, scrollable)
  instead of snapping to a random offset.
- **Push is actually requested** — `OneSignal.Notifications.requestPermission()` runs from the
  alerts button, inside a user gesture (iOS requires this) and never on page load.
- **Honeypot + dedupe** — hidden `company` field with a fake-success response, and one submission
  per device per 24 hours.
- **Accessibility** — real `<label>`s, `role="dialog"` + `aria-modal` + focus trap + focus return
  on the interstitial, visible focus rings, `aria-invalid` on failed fields, `aria-live` toast.
- **Contrast** — small text set at `#8b93a1` (≈5.4:1) on the card background at 10px.
- **Exit intent now includes step 1**, the highest-intent exit point.
- **Claim counter drifts upward** instead of oscillating in place.
- **Deadline failures are visible** — failed captures log `console.error`, buffer to
  `pp_buf`, and retry on the next load. No more silent `catch {}`.
- **Worldwide.** No region gate, no US/Canada phone rule: `validPhone()` accepts 7–15 digits with an
  optional `+` country code, the Worker's `PHONE_RE` does the same, and the copy no longer claims a
  territory. A `+44`, `+234` or `+55` number submits exactly like a `+1`.
- **Eight reserved ad boxes** (`AD_SLOT_*`, above): each fills from CONFIG and shows a dashed outline
  while empty, so the placements are visible before the tags arrive. The two new funnel positions
  (`AD_SLOT_CAPTURE`, `AD_SLOT_DONE`), the dismissible bottom anchor (`AD_SLOT_STICKY`) and script-tag
  activation were added on top of the original five.
- **Winners are real, not hand-edited HTML.** `POST /winners` stores a round in KV behind an admin
  token and `winners.html` renders it; until then the page shows the honest "no results" row.
- **Compliance** — SMS consent checkbox with frequency/STOP/rates language, and real Terms, Privacy
  and Winners pages (they previously 404'd).

Still on you (cannot be coded):

1. Replace `YOURDOMAIN.com` (4 places in `<head>`, plus `worker/wrangler.toml` and the mailto links).
2. Rounds are calendar months by definition (section 2). If you want fixed dates instead, edit section 2
   of `terms.html` and the date line on `winners.html`.
3. Paste the ad tags into the eight `AD_SLOT_*` keys, `AD_NETWORKS` (or the single-network
   `POPUNDER_TAG`) / `INTERSTITIAL_HTML` / `AD_DIRECT_LINK`, and `OFFERS` — until then the page
   earns nothing.
4. Deploy the Worker, set `ADMIN_TOKEN`, and paste its URLs into `CONFIG` plus `WINNERS_URL`.
   The same token is what `bot/pp_analytics.py` passes as `--token` (or `PP_ADMIN_TOKEN`) to read
   `/stats`.
5. **Actually run a real draw.** The page promises `$5,000`, so publish the real result with
   `POST /winners` rather than leaving the placeholder row up.

## Local testing

```bash
npx serve .          # or: python -m http.server
```

Open on a 390px-wide viewport. Check `console` for the `[PayoutPool]` setup warnings; they are
expected until `CONFIG` is filled.

