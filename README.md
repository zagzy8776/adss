# PayoutPool

Tier-1 (US + Canada) lead-capture funnel monetized with interstitial/popunder advertising
and optional CPA offers. One static `index.html` plus a small Cloudflare Worker for storage.

```
index.html      the funnel (all CSS + JS inline, no build step)
winners.html    published results + draw rules
terms.html      official rules (eligibility, dates, ARV, odds, SMS terms)
privacy.html    what is collected, who it is shared with, how to opt out
404.html        not-found page
legal.css       shared styles for the four pages above
favicon.svg     icon (also used as apple-touch-icon)
favicon.ico     legacy /favicon.ico fallback so older clients do not 404
og.jpg          1200x630 social card (generated)
_headers        Cloudflare Pages security/cache headers
robots.txt      crawl rules + sitemap pointer
worker/         Cloudflare Worker + KV: /capture, /feed, /hit
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
| `POPUNDER_TAG` | network script URL **or** the full `<script>` snippet | Adsterra → Websites → Add site → Popunder tag |
| `INTERSTITIAL_HTML` | the vignette/interstitial `<script>` or `<iframe>` snippet | Monetag → OnClick/Vignette zone |
| `AD_DIRECT_LINK` | a direct-link URL, opened in a new tab | any network's Direct Link product |
| `AD_DIRECT_LINK_ON` | `"done"` (default) or `"gate"` | see ad slots below |
| `SECOND_POP` | `true`/`false` — re-call `window.__pop()` on the confirmed screen | Adsterra exposes the hook |
| `AD_EVERY_TAP` | `true` (default) = fire on all 3 taps, like the original build; `false` = gate tap only | your call |
| `GATE_DOUBLE_FIRE` | `false` (default) = one fire on the gate tap; `true` = two, matching the original 4 fires | your call |
| `CAPTURE_ENDPOINT` | `https://api.yourdomain.com/capture` | your Worker (below) |
| `FEED_URL` | `https://api.yourdomain.com/feed` | same Worker |
| `HIT_URL` | `https://api.yourdomain.com/hit` | same Worker |
| `ONESIGNAL_APP_ID` | the UUID from OneSignal | OneSignal → Settings → Keys & IDs |
| `SPONSOR` | the real legal entity running this | **you must supply this** |
| `SUPPORT_EMAIL` | a monitored inbox | you |
| `OFFERS` | array of `{t,s,u,k}` CPA links | CPAGrip / OGAds, filtered to US + CA |

`YOURDOMAIN.com` appears in `<head>` four times: canonical, `og:url`, `og:image`, `twitter:image`.
Those must be absolute URLs — scrapers do not run JavaScript, so they cannot be resolved at runtime.

**Nothing fails silently.** Any key left empty logs a `[PayoutPool]` warning to the console at
boot, an empty `CAPTURE_ENDPOINT` logs a hard error on submit, and a failed POST is buffered in
localStorage and retried on the next visit. `window.__ppMissing` lists every unset key.

## Ad slots

| Slot | Key | Fires | Cap per visitor | `/hit` event |
|---|---|---|---|---|
| Popunder script | `POPUNDER_TAG` | every tap if `AD_EVERY_TAP`, else the gate tap | 1 script, N fires | `ad_pop` |
| Network re-call | `SECOND_POP` | confirmed screen, +1.2s | 1 | `ad_second` |
| Direct link | `AD_DIRECT_LINK` | `AD_DIRECT_LINK_ON` | 1 tab total | `ad_direct` |
| Interstitial | `INTERSTITIAL_HTML` | gate tap, 5s skip | 1 per pageload | `ad_inter` |
| CPA offers | `OFFERS` | confirmed screen | 5 links shown | `offer_click` |

The direct link deliberately **does not** fire on the gate tap by default. `window.open` on that
tap moves focus to the new tab, so the visitor never sees the interstitial and never submits the
form — you would trade a lead (worth $0.50–$3) for a direct-link click (worth $0.005–$0.02).
With `AD_DIRECT_LINK_ON: "gate"` you get the aggressive variant; the default opens the tab after
the lead is in KV, or on exit-intent if the visitor saw the form and started leaving.

Verify what actually fired, in the console:

```js
__ppAdReport()
// { configured: { popunder: true, popHook: true, direct: true, interstitial: true, offers: 3 },
//   fired: { gateTaps: 1, directTab: true, secondPop: true } }
```

`popHook: false` means your network does not expose `window.__pop`, so `SECOND_POP` cannot do
anything regardless of the setting.

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
| `/health` | GET | liveness + KV binding check |

Reading leads back out: `npx wrangler kv key list --namespace-id=<id>` or wire the KV namespace to
a Google Sheet with a scheduled Worker. KV is eventually consistent (≈60 s), which is fine for
this funnel and costs nothing at these volumes.

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
- **One ad fire per tap.** `fireAd()` runs on each tap while `AD_EVERY_TAP` is true (the original
  build's behaviour, 3 fires); the gate tap adds its own fire, and `GATE_DOUBLE_FIRE` restores the
  original 4th. `openInterstitial()` never fires a second time on its own. The direct link is capped
  at one tab per visitor and waits for the lead instead of competing with the interstitial.
- **Reduced motion freezes the ticker** (`animation: none`, single non-duplicated list, scrollable)
  instead of snapping to a random offset.
- **Push is actually requested** — `OneSignal.Notifications.requestPermission()` runs from the
  alerts button, inside a user gesture (iOS requires this) and never on page load.
- **Honeypot + dedupe** — hidden `company` field with a fake-success response, and one submission
  per device per 24 hours.
- **Accessibility** — real `<label>`s, `role="dialog"` + `aria-modal` + focus trap + focus return
  on the interstitial, visible focus rings, `aria-invalid` on failed fields, `aria-live` toast.
- **Contrast** — fine print moved from `#4d535c` (≈3:1) to `#8b93a1` (≈5.4:1) at 10px.
- **Exit intent now includes step 1**, the highest-intent exit point.
- **Claim counter drifts upward** instead of oscillating in place.
- **Deadline failures are visible** — failed captures log `console.error`, buffer to
  `pp_buf`, and retry on the next load. No more silent `catch {}`.
- **Compliance** — SMS consent checkbox with frequency/STOP/rates language, sponsor identity in
  the footer, no-purchase/eligibility/odds/ARV disclosures, and real Terms, Privacy and Winners
  pages (they previously 404'd).

Still on you (cannot be coded):

1. Replace `YOURDOMAIN.com` (4 places in `<head>`, plus `worker/wrangler.toml` and the mailto links).
2. Replace `[OPERATOR ENTITY]`, `[STREET ADDRESS]`, `[START DATE]`, `[END DATE]`, `[STATE/PROVINCE]`
   in `terms.html`, `privacy.html`, `winners.html`, `404.html` and `CONFIG.SPONSOR`.
3. Supply the ad tags and offer links — until then the page earns nothing, and says so in the console.
4. Deploy the Worker, or delete the email/phone step and keep push-only.
5. **Actually run a real draw.** The page promises `$5,000`. Invented winners with invented
   amounts, and no sponsor behind them, is the part no code change can fix.

## Local testing

```bash
npx serve .          # or: python -m http.server
```

Open on a 390px-wide viewport. Check `console` for the `[PayoutPool]` setup warnings; they are
expected until `CONFIG` is filled.

