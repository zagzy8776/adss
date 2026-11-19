# PayoutPool

> **Current live-source architecture (November 2026):** The optional Cloudflare Worker /capture form and the independent Neon-backed cash-prize wheel are separate systems. Completing the form, clicking advertisements, or sharing a link does not alter wheel odds or create a cash entitlement. The configured $5,000 USD pool contains $5/$20/$100 inventory. /api/activity publishes the daily spin cap. The eight-segment wheel is explicitly illustrative, not a probability chart. Monetag automatic overlay tags are disabled; Google AdSense and configured non-intrusive display positions remain. A distinct approved 300×250 creative is needed for AD_SLOT_WHEEL, which is empty by default. Site operator still needs a real support channel, privacy retention policy and a verified payout process. Earlier examples and historical descriptions below may document legacy funnel behavior, not the current user-facing rules.\n\n
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
| `INTERSTITIAL_HTML` | a creative for the full-screen break: a vignette `<script>` (closing tag written `<\/script>`), an `<img>`/`<iframe>` block, or a bare `https://` iframe URL | a zone that is **not** already on the page (Adsterra has no interstitial format) |
| `INTERSTITIAL_TRIGGER` | `"show_312446"` (default) — show the zone that is *already* loaded in `<head>` at the break, instead of pasting it a second time. Blank = no hook | `typeof window.show_<zone>` in the console |
| `INTERSTITIAL_ON` | `"done"` (default), `"gate"`, `"both"` or `"off"` — which moment the break runs | your call |
| `INTERSTITIAL_SKIP` | seconds Continue stays locked, `5` by default, `0` = live at once | your call |
| `AD_DIRECT_LINK` | a direct-link URL, opened in a new tab | any network's Direct Link product |
| `AD_DIRECT_LINK_ON` | `"done"` (default) or `"gate"` | see ad slots below |
| `SECOND_POP` | `true`/`false` — re-call `window.__pop()` on the confirmed screen | Adsterra exposes the hook |
| `AD_EVERY_TAP` | `true` (default) = fire on all 3 taps, like the original build; `false` = gate tap only | your call |
| `GATE_DOUBLE_FIRE` | `false` (default) = one fire on the gate tap; `true` = two, matching the original 4 fires | your call |
| `AD_BURST` | networks fired per tap, `1`–`n` — default `2` = every gate network pops on the same tap | your call |
| `AD_REPEAT_POP` | `true` (default) = a network may pop again on the next tap; `false` = once per network per visit | your call |
| `AD_SLOT_HELD` | reserved box under the "slot held for" timer | any network's banner code |
| `AD_SLOT_CARD` | reserved box inside the step card, above the CTA | banner code, or a `video:` / `vast:` creative |
| `AD_SLOT_BELOW` | reserved box below the card | banner code |
| `AD_SLOT_CAPTURE` | reserved box inside the contact card, above the email field | banner code (300×250 / 320×100), or `video:` / `vast:` |
| `AD_SLOT_DONE` | reserved box on the "Entry confirmed" screen, under the referral code | banner code, or `video:` / `vast:` |
| `AD_SLOT_GATE` | ad inside the sponsored interstitial (replaces the house preview) | banner / native code, or `video:` / `vast:` |
| `AD_SLOT_STICKY` | 320×50 anchor pinned to the bottom edge, with a close button | anchor/banner code |
| `AD_PLACEHOLDERS` | `true` (default) = empty slots stay in the page but draw nothing; `false` = empty slots are removed from the DOM | your call |
| `CAPTURE_ENDPOINT` | `https://api.yourdomain.com/capture` | your Worker (below) |
| `FEED_URL` | `https://api.yourdomain.com/feed` | same Worker |
| `HIT_URL` | `https://api.yourdomain.com/hit` | same Worker |
| `ONESIGNAL_APP_ID` | the UUID from OneSignal | OneSignal → Settings → Keys & IDs |
| `GOOGLE_ADSENSE_CLIENT` | the publisher client ID (`ca-pub-...`) | Google AdSense → Ads → Ads.txt |
| `SUPPORT_EMAIL` | a monitored inbox | you |
| `ONESIGNAL_APP_ID` | the UUID from OneSignal | OneSignal → Settings → Keys & IDs |
| `SUPPORT_EMAIL` | a monitored inbox | you |
| `POOL_AMOUNT` | the prize string every `data-pool` element is rewritten from (`"$5,000"` currently configured) | your call — keep `terms.html` 5.1, the `<title>` and `og:title` in step |
| `OFFERS` | array of `{t,s,u,k}` CPA links | CPAGrip / OGAds, filtered to your traffic |

`YOURDOMAIN.com` appears in `<head>` four times: canonical, `og:url`, `og:image`, `twitter:image`.
Those must be absolute URLs — scrapers do not run JavaScript, so they cannot be resolved at runtime.

`<head>` also carries two Monetag tags — zone `312446` (`quge5.com`) and zone `12299927`
(`al5sm.com`). Each is its own `<script>` element, so adding or removing one is a single line and
cannot break the inline block below. Two zones on one page means two OnClick passes per tap: if the
dashboard flags it or fill drops, delete the `312446` line and keep the other.

below `<meta charset>` instead, and re-check the offset after touching the top of `<head>`.

An async Google AdSense tag (`adsbygoogle.js?client=ca-pub-9906406019954985`) sits next to them. It loads from
`https://pagead2.googlesyndication.com` and the CSP `script-src https:` already allows it; the client ID is
read from `CONFIG.GOOGLE_ADSENSE_CLIENT`.

ClickAdy ownership is proven by `<meta name="clckd" content="…">`, taken from ClickAdy → Add site.
Both sit **above** `<meta charset>`, because MultiTag must be the first thing after `<head>`. That
puts a hard limit on the block: HTML only honours a charset declaration inside the first 1024 bytes,
and this page declares it at byte 680. Any comment added above those tags eats that window — move it
below `<meta charset>` instead, and re-check the offset after touching the top of `<head>`.

It has to be in the HTML the crawler downloads — a script-injected meta will not verify — so it
lives in `<head>` and stays there after approval. ClickAdy's zone snippet is a normal ad tag, not a
popunder helper: put it in `CONFIG.POPUNDER_TAG` like any other network tag.

### Google AdSense

An async AdSense tag sits in `<head>` next to the Monetag zones:
```html
<script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-9906406019954985" crossorigin="anonymous"></script>
```
The client ID is also in `CONFIG.GOOGLE_ADSENSE_CLIENT`, so it is one string to change. The tag is
`async` and `crossorigin="anonymous"` — both are required for the script to load at all. The CSP
`script-src https:` already permits it, so nothing else needs to move.

AdSense does not have its own slot container here: it fills whatever `<ins class="adsbygoogle">` or
`<ins>` the creative itself injects, so it runs alongside the seven reserved boxes rather than in
one of them. That keeps it out of the funnel's reserved positions and means an AdSense creative never
collides with a Monetag or Adsterra unit. If you want it in a specific box, paste an
`adsbygoogle` `<ins>` into `AD_SLOT_*` like any other banner HTML.

To turn it off, set `GOOGLE_ADSENSE_CLIENT: ""` — the `<script>` is skipped and the page still
renders. The probe `_head.mjs` checks that the tag is present and inside `<head>`.

**Nothing fails silently.**
popunder helper: put it in `CONFIG.POPUNDER_TAG` like any other network tag.

**Nothing fails silently.** Any key left empty logs a `[PayoutPool]` warning to the console at
boot, an empty `CAPTURE_ENDPOINT` logs a hard error on submit, and a failed POST is buffered in
localStorage and retried on the next visit. `window.__ppMissing` lists every unset key.

## Ad slots

| Slot | Key | Fires | Cap per visitor | `/hit` event |
|---|---|---|---|---|
| Under the timer | `AD_SLOT_HELD` | on load, always visible | 1 box | — |
| Above the CTA | `AD_SLOT_CARD` | on load, every step | 1 box | — |
| Below the card | `AD_SLOT_BELOW` | on load | 1 box | — |
| In the contact card | `AD_SLOT_CAPTURE` | when step 5 appears | 1 box | — |
| Confirmed screen | `AD_SLOT_DONE` | after the lead is stored | 1 box | — |
| Inside the gate | `AD_SLOT_GATE` | when the interstitial opens | 1 box | `ad_inter` |
| Bottom anchor | `AD_SLOT_STICKY` | on load, until closed | 1 box | `ad_stick_x` |
| Popunder script | `POPUNDER_TAG` / `AD_NETWORKS[].popunder` | on every monetisable tap (see below) | `AD_BURST` per tap, repeat per `AD_REPEAT_POP` | `ad_<id>`, `ad_pop` |
| Network re-call | `SECOND_POP` | confirmed screen, +1.2s | 1 | `ad_second` |
| Direct link | `AD_DIRECT_LINK` | `AD_DIRECT_LINK_ON` | 1 tab total | `ad_direct` |
| Interstitial | `INTERSTITIAL_TRIGGER` (zone hook) or `INTERSTITIAL_HTML` | `INTERSTITIAL_ON` = confirmed screen (default) or gate, `INTERSTITIAL_SKIP`s hold | 1 per pageload per stage | `ad_inter`, `interstitial_done` |
| CPA offers | `OFFERS` | confirmed screen | 5 links shown | `offer_click` |

The seven `AD_SLOT_*` boxes are real reserved containers: each accepts banner HTML (an `<iframe>`,
`<ins>`, `<img>`, or a script snippet) or a bare `https://` iframe URL. Script tags are re-created
after insertion, because `innerHTML` alone never executes them — so a standard network tag works.
Every box is in the funnel where a visitor is looking, so a display campaign can run alongside the
popunder without waiting for a click. An unsold slot draws nothing at all — no dashed frame, no
`AD` caption, no height — so a visitor reading the funnel sees a finished page rather than a page
with labelled holes in it, while the element keeps its place so a creative that arrives still lands
where it belongs. Add `?addebug=1` to the URL to outline every unsold slot while you are placing a
tag, and set `CONFIG.AD_PLACEHOLDERS: false` to remove empty boxes from the DOM instead of leaving
them in place. The bottom anchor has no empty state at all (an empty fixed bar would look broken)
and never comes back once a visitor closes it (`pp_stickx` in localStorage).

There is deliberately **no box directly under the CTA** any more. The 468×60 that used to sit
between "Confirm and continue" and the "no payment details" line competed with the button for the
same tap, and the entry is the better-paying event. Its Adsterra zone still exists; restoring it is
one `<aside class="adbox inset" id="adAfter" data-slot="after">` in the step card plus one
`mountAd('adAfter', slotHtml('AFTER', CONFIG.AD_SLOT_AFTER), 'AD')` line.

Density is a money question, not a "more boxes = more revenue" one. Past roughly four display units
per viewport, fill rate and CPM both fall and the form completion rate drops with them — the lead is
the better-paying event. If you add a network, prefer a second **anchor** (`AD_SLOT_STICKY`) or a
300×250 in `AD_SLOT_CAPTURE`, not another box stacked on the first screen.

### Video creatives

Any slot — and `INTERSTITIAL_HTML` — also accepts two video forms, so a video zone needs no extra
config key:

```js
AD_SLOT_GATE: 'video:https://cdn.example.com/spot.mp4|poster=https://cdn.example.com/spot.jpg|click=https://advertiser.example',
AD_SLOT_DONE: 'vast:https://ads.example.com/vast?zone=123&cb=[CACHEBUSTING]'
```

- `video:` is a plain file. It is mounted muted, looped, `playsinline` and only **plays while a
  third of it is on screen** — an offscreen video keeps decoding and keeps being counted as shown
  to somebody who has scrolled past it. `poster=` and `click=` are optional; a click-through
  becomes a real `<a target="_blank" rel="noopener">`, not a popunder.
- `vast:` is a VAST 2–4 tag. The XML is fetched, **one wrapper is followed**, the largest mp4/webm
  `<MediaFile>` wins, and `<Impression>`, `<Tracking event="start|complete">` and `<ClickThrough>`
  are honoured. Wrapper and inline pixels both fire, with `[CACHEBUSTING]` / `[TIMESTAMP]` /
  `[RANDOM]` replaced per request. The ad server has to send `Access-Control-Allow-Origin` (most
  do); when it does not, the console says so instead of leaving a silent hole.

Put video in the **break** (`AD_SLOT_GATE`) and on the **confirmed screen** (`AD_SLOT_DONE`): those
are the two moments a visitor is already stopped in front of a panel. A video in `AD_SLOT_CARD` is
allowed and usually a mistake — on a phone it pushes the CTA under the fold. `/stats` separates
pasted from played: `ad_video` (the file started), `ad_vast` (a tag resolved and its impression
fired), `ad_video_click`. `node _advid.mjs` checks all of it against a local mp4 and a wrapper tag.

The direct link deliberately **does not** fire on the gate tap by default. `window.open` on that
tap moves focus to the new tab, so the visitor never sees the interstitial and never submits the
form — you would trade a lead (worth $0.50–$3) for a direct-link click (worth $0.005–$0.02).
With `AD_DIRECT_LINK_ON: "gate"` you get the aggressive variant; the default opens the tab after
the lead is in KV, or on exit-intent if the visitor saw the form and started leaving.

## The full-screen break — and what to wire into it

The overlay (`#inter`) is a real full-screen placement: it covers the page, freezes scrolling, and
holds its Continue button for `INTERSTITIAL_SKIP` seconds. By default it sits on the **confirmed
screen** (`INTERSTITIAL_ON: "done"`), right where the `$500` lands.

The site already loads Monetag's MultiTag for zones `312446` and `12299927` in `<head>`, so that
zone is paid inventory from the first byte. The break asks it to show its own full-screen instead of
loading the same tag a second time:

```js
INTERSTITIAL_TRIGGER: "show_312446",   // default - the zone already in <head>
INTERSTITIAL_ON: "done",               // last screen, where the $500 lands
```

`show_312446()` is what `tag.min.js` registers once the zone can open a full-screen. Check it in the
console: `typeof window.show_312446`. If it is `"undefined"`, that zone has no full-screen format
enabled — turn one on for the zone in the Monetag dashboard (Interstitial / Vignette), or paste a
creative as below. The page says so on its own four seconds after load, and until then the break
stays shut instead of pausing in front of the confirmed card for nothing.

When the hook answers, our overlay never opens: the network's full-screen *is* the break. Stacking
both would be two full-screen ads on one visit.

### Pasting a tag instead

Only for a zone that is **not** already on the page:

```js
INTERSTITIAL_ON: "done",
INTERSTITIAL_HTML: "<div id='z1'></div><script src='//libtl.com/sdk.js' data-zone='1234567' data-sdk='show_1234567'><\/script>",
```

Four rules, and each one is a page-killer or an account risk if ignored:

1. **Escape the closing tag.** A literal `</script>` inside `CONFIG` ends the page's `<script>` block
   and the entire funnel stops working. Write `<\/script>`. (A tag with no closing tag — a bare
   `<img>` or `<iframe>` — needs no escaping.)
2. **Never paste a zone that is already loaded.** The head MultiTag is zone `312446`; pasting its
   snippet a second time loads one zone twice in a pageview, which double-counts the impression and
   reads as invalid traffic. `injectPlacement` refuses it with a console warning and the break falls
   back to the house panel, so the mistake is loud instead of expensive. Use
   `INTERSTITIAL_TRIGGER` for that zone.
3. **The tag goes in its own column, under the house panel.** The `$500` copy stays visible while
   the partner creative renders below it, instead of the tag wiping the panel out.
4. **Scripts are re-created after insertion**, because `innerHTML` never executes them. That is what
   makes a pasted `data-zone` snippet actually load rather than quietly render an empty div.

**A hosted creative URL only?** Paste just the `https://…` URL: it renders as a 300×250 iframe
(`?click=`, `?size=` and the like still work). No escaping needed.

**Adsterra has no interstitial format.** Its full-page products are Popunder and Social Bar, and its
display units are iframes. So there are two honest options for this screen on Adsterra: put a
320×50/300×250 unit in `AD_SLOT_GATE` (or `AD_SLOT_DONE`) and let it sit *inside* the break, or fill
the break from Monetag and keep Adsterra for the banners and the popunder.

### Which moment it runs

| Value | Gate tap (step 3) | Confirmed screen (after submit) |
|---|---|---|
| `"gate"` | break opens, Continue → form | nothing |
| `"done"` (default) | tap goes straight to the form | break opens over the confirmed card, when it has an ad |
| `"both"` | break opens | break opens again |
| `"off"` | tap goes straight to the form | nothing |

The gate break is part of the funnel and runs even with nothing sold in it — it holds the position
while the form is one tap away. The confirmed-screen break has to **pay**: a live trigger or a pasted
placement, otherwise the funnel skips it and lets the direct tab and the confirmed card (which
already carries `AD_SLOT_DONE`) do the work.

### Behaviour worth knowing

- A network vignette usually opens itself on load, wherever its script runs. If it already covers the
  page, set `INTERSTITIAL_ON: "off"` and let it be the only full-screen — otherwise you are stacking
  two, which is the double-billing pattern that gets accounts suspended.
- When the break is due on the confirmed screen, the direct-link tab is **skipped** for that visit
  (`finish(true)`): two full-screen monetisations at the same instant means the visitor sees whichever
  loads last and the other is wasted.
- A returning visitor who reloads the confirmed screen is **not** trapped: the break only runs on a
  real completion, not on the boot path.
- Continue on the gate break still fires the network (highest-intent tap of the funnel). Continue on
  the end-of-funnel break only closes — the lead is already stored, and a second pop there would be
  a second pop for one visit.

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
//   configured: { popHook: true, direct: true, interstitial: false,
//                 trigger: 'show_312446', hookLive: true, breakStage: 'done',
//                 offers: 3, burst: 2, repeatPop: true },
//   fired: { gateTaps: 3, directTab: false, secondPop: false } }
```

`popHook: false` means your network does not expose `window.__pop`, so `SECOND_POP` cannot do
anything regardless of the setting.

## Wiring Adsterra

Adsterra hands out four different kinds of code. Three of them map onto a config key; the mapping
is not obvious, and pasting the wrong one is why a box renders empty:

| What Adsterra gives you | Where it goes | Form |
|---|---|---|
| **Banner** `300x250`, `320x50`, `728x90` … | `AD_NETWORKS[].slots` | `adsterra:<key>/<w>x<h>` |
| **Popunder → Script URL** | `AD_NETWORKS[].popunder` | bare URL, injected on the tap |
| **Native banner** | `AD_SLOT_*` | raw HTML: its script *and* its `<div id="container-…">` |
| **Direct link** | `AD_DIRECT_LINK` | bare URL, one tab per visitor |

`<key>` is the last path segment of the `invoke.js` URL Adsterra shows you
(`https://bancadeltempoidea.org/22/<key>`), and `<w>x<h>` is the size the zone was created
with. Five units are wired today — `HELD 320x50`, `CARD 300x250`,
`BELOW 728x90`, `CAPTURE 160x300`, `DONE 160x600` — plus the Popunder zone on the same network
object, so one `/hit` id (`ad_adsterra`) covers the banners and the pops.

**Do not paste the two-`<script>` snippet**, even though it looks self-contained. `atOptions`
is one global, and the loader reads it and then deletes it:

```js
if (window['atOptions'] && isObject(window[...])) merge(...), delete window['atOptions'];
```

Five copies on one page overwrite each other before the earlier loaders have read theirs, so
every box comes out at the *last* unit's size, or blank. `mountUnit()` instead sets
`atOptions`, inserts that unit's loader, waits for the loader to consume (delete) it, and only
then starts the next unit — one queue for the whole page. `node _admap.mjs` asserts the key
each loader actually read, so a regression here fails the probe rather than silently
half-filling the page.

Two rules that come with that:

- **One unit per key.** Loading the same zone twice per page doubles its impressions and reads
  as invalid traffic, which is why `GATE` and `STICKY` stay empty until you create a second
  `300x250` (break) and a second `320x50` (bottom bar).
- **Units wider than the column are scaled.** A 728x90 in a 358px column is clipped, not
  shrunk, so `fitUnit()` applies `transform: scale()` and hands the box the scaled height.

```js
AD_NETWORKS: [
  { id: 'adsterra',
    popunder: 'https://aarems.org/1/7e78107f…',   // ← Popunder → Script URL
    fireOn: 'gate',
    weight: 1,
    slots: {
      HELD:    'adsterra:83ffc72d…/320x50',
      CARD:    'adsterra:81c79547…/300x250',
      BELOW:   'adsterra:0fbe28a3…/728x90',
      CAPTURE: 'adsterra:819964b8…/160x300',
      DONE:    'adsterra:0ebe3930…/160x600',
      GATE: '', STICKY: ''
    } }
]
```

`popunder` is the Popunder zone's own Script URL, not a snippet: the tag arms itself when it loads
and pops on the visitor's **next** click. That is why it is loaded from the tap that asks for it
(`fireAd`) instead of sitting in `<head>` — a tag loaded at boot would spend the visitor's first tap
before the funnel has engaged anyone, and one loaded on the confirmed screen would wait for a click
that never comes. The injected `<script>` keeps the `data-cfasync="false"` the network's snippet
ships with; without it a Cloudflare Rocket Loader zone defers the tag past the tap and the pop
never happens. `node _admap.mjs` walks the funnel and asserts one load per `fireAd` (five taps,
four fires — the `Continue` out of the break does not fire again), with no false
"earned nothing" warning.

A network only counts as wired once it has a `popunder` or at least one slot; an entry with every
URL still empty does **not** silence the boot warning, so a half-pasted block cannot look healthy.

Verify in the console, before and after a paste:

```js
__ppAdReport().networks                            // [] once, [{ id: 'adsterra', … }] now
document.querySelectorAll('.adbox.filled').length  // boxes that took a creative: 6
window.__unitLog                                   // (probe only) what each loader read
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
| `/stats` | GET | aggregates those counters for N days (needs `X-Admin-Token`) |
| `/geo` | GET | visits per country / subdivision for N days, plus the timezone-mismatch signal (needs `X-Admin-Token`) |
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

`bot/pp_analytics.py` is a stdlib-only Python 3.8+ CLI over the Worker's `GET /stats` and
`GET /geo`
(token = the same `ADMIN_TOKEN` secret). It never touches a visitor's email or phone; `/stats`
returns counters only.

```bash
python bot/pp_analytics.py health
python bot/pp_analytics.py stats                 # funnel + clicks table
python bot/pp_analytics.py geo                   # countries, value tiers, proxy signal
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

`geo` is the other half of the picture: `GET /geo` is written at the edge from `request.cf` on every
page view, so it costs the page nothing and needs no IP database. It prints visits per country and
subdivision, splits them into **value tiers** (`TIER1` / `TIER2` sets at the top of the file — edit
them to match your payout sheet, and the tier line becomes your own numbers), and reports the
`tz-mismatch` signal: the worker compares the connection's timezone with the one the browser sends,
so a device in `Europe/Berlin` arriving from a Lagos IP shows up as a count instead of a surprise
chargeback. Its alerts are `GEO CLUSTER` (one country ≥ 70% of visits), `PROXY HEAVY` (≥ 15%
mismatched), `LOW VALUE GEO` (≥ 60% tier 3) and `NO COUNTRY` (the edge resolved nothing — local
`wrangler dev` traffic).

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
- **Seven reserved ad boxes** (`AD_SLOT_*`, above): each fills from CONFIG and appears at the size of
  the creative. An unsold slot is invisible and takes no space — no dashed `AD` frame for a visitor
  to wonder about — but keeps its position in the page; `?addebug=1` outlines every unsold slot while
  you are wiring a network. The two new funnel positions
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
3. Adsterra's popunder and its five banner units are wired; what is still blank is `AD_DIRECT_LINK`,
   `OFFERS`, push (`ONESIGNAL_APP_ID` / `PUSH_TAG`), and the two boxes that need units of their own
   (`GATE` 300x250, `STICKY` 320x50) — until those are pasted the page earns from banners and pops
   only. The full-screen break needs no paste: it uses the zone already in `<head>`
   (`INTERSTITIAL_TRIGGER`).
4. Deploy the Worker, set `ADMIN_TOKEN`, and paste its URLs into `CONFIG` plus `WINNERS_URL`.
   The same token is what `bot/pp_analytics.py` passes as `--token` (or `PP_ADMIN_TOKEN`) to read
   `/stats`.
5. **Actually run a real draw.** The page promises `$500`, so publish the real result with
   `POST /winners` rather than leaving the placeholder row up.

## Local testing

```bash
npx serve .          # or: python -m http.server
```

Open on a 390px-wide viewport. Check `console` for the `[PayoutPool]` setup warnings; they are
expected until `CONFIG` is filled.

### The probes

Headless Chrome drives the real page; no network leaves the machine. Each one prints `PASS/FAIL` per
assertion and a `n/n passed` line, and exits non-zero on any failure.

| Probe | What it proves |
|---|---|
| `node _head.mjs` | head order: Monetag tags and `meta charset` in the right place |
| `node _admap.mjs` | all seven boxes: which unit fills which slot, right key, right size, unsold slots invisible |
| `node _advid.mjs` | video creatives: `video:` attributes + play-only-when-visible, `vast:` wrapper hop, pixels, 720p pick, click-through |
| `node _adsnet.mjs` | `AD_NETWORKS` arbitration: rotation per visitor, `AD_BURST`, `fireOn: 'done'` confinement |
| `node _adinter.mjs` | the full-screen break: `INTERSTITIAL_ON` done/gate/both/off, the zone hook path, hold timer, returning visitor, pasted tag + escaping, duplicate-zone refusal |
| `node _adtag.mjs` / `node _adtag2.mjs` | the live network tags as shipped |
| `node _adview.mjs` | screenshots of the funnel, plain and with `?addebug=1` |
| `node _adlive.mjs` | a real Adsterra render attempt (expected to render nothing off an unapproved domain) |
| `node _swtest2.mjs` | the push service worker |
| `node _wtest.mjs` | the Worker with a fake KV: `/hit` allow-list, `/stats` and `/geo` token gates, country rollup, tz mismatch, lead record |


