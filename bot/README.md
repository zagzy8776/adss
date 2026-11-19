# bot — click + funnel analytics

A single-file Python 3.8+ bot that reads the Cloudflare Worker's `/stats`
endpoint and reports the funnel. Stdlib only: no `pip install`.

```
python bot/pp_analytics.py health
python bot/pp_analytics.py stats
python bot/pp_analytics.py stats --json
python bot/pp_analytics.py geo
python bot/pp_analytics.py watch --interval 15
python bot/pp_analytics.py report --days 30 --out reports
python bot/pp_analytics.py selftest
```

## Token

`/stats` and `/geo` are gated on the same `ADMIN_TOKEN` secret the worker already uses for
`/winners`.

```
setx PP_ADMIN_TOKEN "your-token"      :: Windows, new shells only
export PP_ADMIN_TOKEN=your-token      # macOS / Linux
```

Or pass `--token` / `--api` on the command line. Default API:
`https://payoutpool-api.payoutpool.workers.dev`.

## What it detects

`watch` takes a `/stats` snapshot, then one per interval, and prints the delta
for every counter that moved. Alerts:

| code | meaning |
| --- | --- |
| `CLICKS WITHOUT TRAFFIC` | click/ad events arrived with no new page views — cached page, reopened tab, or injected clicks |
| `BURST` | one counter grew by `--storm` (default 25) inside a single window |
| `CAPTURE GAP` | 5+ capture forms shown since the last confirmed entry |
| `LEAD LEAK` | capture views recorded but zero `done` |
| `FORM STARVED` | under 5% of views reach the form |
| `CLICK HEAVY` | more than 8 click events per visit (expected at `AD_BURST: 2`) |

It does not call traffic fraudulent. It points at the windows worth a look.

## Where the traffic is

`geo` reads the Worker's `GET /geo`, which is built at the edge from `request.cf` on each
page view — no IP database here, no cookie, no lookup call. It prints:

* **countries** — visits and share, biggest first, top 15 shown
* **regions** — the subdivisions the visits land in (`US-CA`, `GB-ENG`, …)
* **value tiers** — `TIER1` / `TIER2` are sets at the top of `pp_analytics.py`. Edit them to match
  the payout sheet of whichever network pays you; anything else is tier 3
* **signals** — `tz-mismatch`: the browser's clock zone against the connection's. A device in
  `Europe/Berlin` arriving from a Lagos IP is a proxy, a VPN or a resold address, and that is the
  traffic that gets clawed back at settlement

| code | meaning |
| --- | --- |
| `GEO CLUSTER` | one country is ≥ 70% of visits — one source, one payout risk |
| `PROXY HEAVY` | ≥ 15% of visits report a clock zone the connection is not in |
| `LOW VALUE GEO` | ≥ 60% of visits are tier 3 — a first-world CPM plan is not reachable |
| `NO COUNTRY` | the edge resolved no country for half the visits — local `wrangler dev`, or a stripping proxy |
| `NO GEO` | no counters at all — `HIT_URL` empty, or `/hit` never receives `view` |

`report` writes the same geo data into the JSON, adds a `## Geo` section to the Markdown and
`geo,<CC>,<visits>` rows to the CSV. If an older deploy has no `/geo`, the report says so and is
written without it.

## Tests

```
python bot/pp_analytics.py selftest
python -m unittest discover -s bot -p "test_*.py" -v
```

`test_pp_analytics.py` starts a throwaway HTTP server that mimics the worker,
so the tests exercise the real urllib path, the token header, the 401 path and
the file writing — with no network and no Cloudflare account.

The bot never reads or prints a visitor's email or phone. `/stats` and `/geo` return
counters only.
