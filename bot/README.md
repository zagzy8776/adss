# bot — click + funnel analytics

A single-file Python 3.8+ bot that reads the Cloudflare Worker's `/stats`
endpoint and reports the funnel. Stdlib only: no `pip install`.

```
python bot/pp_analytics.py health
python bot/pp_analytics.py stats
python bot/pp_analytics.py stats --json
python bot/pp_analytics.py watch --interval 15
python bot/pp_analytics.py report --days 30 --out reports
python bot/pp_analytics.py selftest
```

## Token

`/stats` is gated on the same `ADMIN_TOKEN` secret the worker already uses for
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

## Tests

```
python bot/pp_analytics.py selftest
python -m unittest discover -s bot -p "test_*.py" -v
```

`test_pp_analytics.py` starts a throwaway HTTP server that mimics the worker,
so the tests exercise the real urllib path, the token header, the 401 path and
the file writing — with no network and no Cloudflare account.

The bot never reads or prints a visitor's email or phone. `/stats` returns
counters only.
