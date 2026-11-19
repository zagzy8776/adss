#!/usr/bin/env python3
"""
PayoutPool click + funnel analytics bot
=======================================

Reads the Cloudflare Worker's /stats endpoint (the KV counters that /hit writes
from index.html) and turns them into three things the operator actually needs:

  * funnel table   -- view -> step_1 -> step_2 -> step_3 -> capture_view -> done
  * click detector -- per-interval deltas for every ad_* / click event, with
                      alerts for clicks that arrive without traffic, click
                      storms, and capture views that never become entries
  * report         -- JSON + CSV + Markdown under reports/

Stdlib only (urllib), so it runs on any machine with Python 3.8+ and no pip.

    python bot/pp_analytics.py health
    python bot/pp_analytics.py stats
    python bot/pp_analytics.py watch --interval 15
    python bot/pp_analytics.py report --days 30
    python bot/pp_analytics.py selftest

Configuration, in priority order: command line flags, environment variables,
then the defaults below.

    PP_API            https://payoutpool-api.payoutpool.workers.dev
    PP_ADMIN_TOKEN    the same ADMIN_TOKEN secret wrangler holds for /winners

/stats is token gated on purpose: traffic numbers are the operator's, not the
public's. Nothing in this bot reads or prints a visitor's email or phone.
"""

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

DEFAULT_API = "https://payoutpool-api.payoutpool.workers.dev"
USER_AGENT = "payoutpool-analytics/1.0"

# Order matters: each row is the previous row's denominator.
FUNNEL = ["view", "step_1", "step_2", "step_3", "capture_view", "done"]

# Click-ish events that existed before the network registry.
FIXED_CLICKS = ["ad", "ad_pop", "ad_direct", "ad_inter", "ad_second",
                "ad_stick_x", "offer_click"]

# Every network fire is ad_<id> (see AD_EVENT_RE in worker/worker.js).
CLICK_PREFIX = "ad_"

LABELS = {
    "view": "page view",
    "step_1": "step 1",
    "step_2": "step 2 (save my position)",
    "step_3": "step 3",
    "capture_view": "capture form shown",
    "done": "entry confirmed",
}


class ApiError(Exception):
    """Anything the operator can act on: bad token, wrong URL, worker down."""


def now_utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")


def get_json(url, token=None, timeout=20):
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    })
    if token:
        req.add_header("X-Admin-Token", token)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise ApiError("HTTP %d from %s %s" % (exc.code, url, body or exc.reason))
    except urllib.error.URLError as exc:
        raise ApiError("cannot reach %s: %s" % (url, exc.reason))
    try:
        return json.loads(raw)
    except ValueError:
        raise ApiError("%s did not return JSON: %r" % (url, raw[:160]))


def fetch_stats(api, token, days):
    """One /stats call, shape-checked. Raises ApiError with a usable message."""
    if not token:
        raise ApiError("no admin token: pass --token or set PP_ADMIN_TOKEN "
                       "(same value as the worker's ADMIN_TOKEN secret)")
    url = api.rstrip("/") + "/stats?days=" + str(max(1, min(90, int(days))))
    payload = get_json(url, token)
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise ApiError("unexpected /stats payload: %r" % (payload,))
    totals = {}
    for key, value in (payload.get("totals") or {}).items():
        try:
            totals[str(key)] = int(value)
        except (TypeError, ValueError):
            continue
    payload["totals"] = totals
    payload.setdefault("series", {})
    payload.setdefault("days", [])
    return payload


def click_events(totals):
    """Click-ish counters, network fires included, in a stable order."""
    out = [e for e in FIXED_CLICKS if totals.get(e)]
    out += sorted(e for e in totals
                  if e.startswith(CLICK_PREFIX) and e not in FIXED_CLICKS and totals[e])
    return out


def pct(part, whole):
    if not whole:
        return None
    return 100.0 * part / whole


def fmt_pct(part, whole):
    value = pct(part, whole)
    return "   n/a" if value is None else "%5.1f%%" % value


def bar(value, peak, width=18):
    if not peak or not value:
        return ""
    return "#" * max(1, int(round(width * value / float(peak))))


def table(rows, headers):
    """Fixed-width ASCII table. rows is a list of lists of str."""
    widths = [len(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], len(str(cell)))
    line = "  ".join(h.ljust(widths[i]) for i, h in enumerate(headers))
    out = [line, "  ".join("-" * w for w in widths)]
    for row in rows:
        out.append("  ".join(str(c).ljust(widths[i]) for i, c in enumerate(row)))
    return "\n".join(out)


def funnel_rows(totals):
    peak = max([totals.get(e, 0) for e in FUNNEL] + [1])
    rows, prev = [], None
    for event in FUNNEL:
        n = totals.get(event, 0)
        rows.append([
            event,
            str(n),
            fmt_pct(n, totals.get("view", 0)).strip(),
            "-" if prev is None else fmt_pct(n, prev).strip(),
            bar(n, peak),
        ])
        prev = n
    return rows


def static_alerts(totals):
    """What one snapshot can say without a second sample."""
    out = []
    views = totals.get("view", 0)
    seen = totals.get("capture_view", 0)
    done = totals.get("done", 0)
    clicks = sum(totals.get(e, 0) for e in click_events(totals))

    if seen and not done:
        out.append(("warn", "LEAD LEAK",
                    "%d capture forms shown, 0 confirmed - check the /capture POST"
                    % seen))
    if views >= 20 and seen and (pct(seen, views) or 0) < 5:
        out.append(("warn", "FORM STARVED",
                    "only %.1f%% of views reach the form" % pct(seen, views)))
    if not clicks and views:
        out.append(("info", "NO AD EVENTS",
                    "no ad_* or click counters at all - is a tag live?"))
    if views and clicks > views * 8:
        out.append(("info", "CLICK HEAVY",
                    "%d click events for %d views (%.1f per visit) - expected with "
                    "AD_BURST 2, worth watching if a network complains"
                    % (clicks, views, clicks / float(views))))
    return out


class ClickDetector:
    """Two /stats snapshots in, click deltas and alerts out.

    It does not declare traffic fraudulent; it points at the windows that
    deserve a look: clicks with no page views, bursts far above normal, and
    capture forms that never turn into entries.
    """

    def __init__(self, storm=25):
        self.storm = max(1, int(storm))
        self.prev = None
        self.windows = 0
        self.gap = 0

    def observe(self, totals):
        cur = {str(e): int(v) for e, v in (totals or {}).items()}
        if self.prev is None:
            self.prev = cur
            return {}, []

        deltas = {}
        for event in set(cur) | set(self.prev):
            d = cur.get(event, 0) - self.prev.get(event, 0)
            if d > 0:
                deltas[event] = d
        self.prev = cur
        self.windows += 1

        alerts = []
        views = deltas.get("view", 0)
        clicks = sum(v for e, v in deltas.items()
                     if e in FIXED_CLICKS or e.startswith(CLICK_PREFIX))

        if clicks and not views:
            alerts.append(("warn", "CLICKS WITHOUT TRAFFIC",
                           "%d click event(s), 0 new views in this window - cached "
                           "page, reopened tab, or injected clicks" % clicks))
        for event, value in sorted(deltas.items(), key=lambda kv: -kv[1]):
            if value >= self.storm:
                alerts.append(("warn", "BURST",
                               "%s +%d in one window (threshold %d)"
                               % (event, value, self.storm)))

        self.gap += deltas.get("capture_view", 0)
        if deltas.get("done", 0):
            self.gap = 0
        elif self.gap >= 5:
            alerts.append(("warn", "CAPTURE GAP",
                           "%d capture views since the last confirmed entry" % self.gap))
            self.gap = 0
        return deltas, alerts


def render_stats(payload, as_json=False):
    if as_json:
        return json.dumps(payload, indent=2, sort_keys=True)

    totals = payload.get("totals", {})
    views = totals.get("view", 0)
    window = payload.get("window") or {}
    out = [
        "PayoutPool /stats   %s" % now_utc(),
        "window %sd since %s   scan: %s"
        % (window.get("days", "?"), window.get("since", "?"),
           payload.get("scan", "?")),
        "",
        "FUNNEL",
        table(funnel_rows(totals),
              ["event", "count", "of views", "step CR", ""]),
    ]

    clicks = click_events(totals)
    out += ["", "CLICKS / AD EVENTS"]
    if clicks:
        peak = max(totals.get(e, 0) for e in clicks)
        out.append(table(
            [[e, str(totals.get(e, 0)), fmt_pct(totals.get(e, 0), views).strip(),
              bar(totals.get(e, 0), peak)] for e in clicks],
            ["event", "count", "of views", ""]))
    else:
        out.append("  none recorded yet")

    out += ["", "ALERTS"]
    alerts = static_alerts(totals)
    if not alerts:
        out.append("  none")
    for level, code, message in alerts:
        out.append("  [%s] %s: %s" % (level.upper(), code, message))
    return "\n".join(out)


def cmd_health(api):
    base = api.rstrip("/")
    payload = get_json(base + "/health")
    print("%s\n  ok=%s kv=%s" % (base, payload.get("ok"), payload.get("kv")))
    return 0 if payload.get("ok") else 1


def cmd_stats(api, token, days, as_json):
    payload = fetch_stats(api, token, days)
    print(render_stats(payload, as_json=as_json))
    return 0


def cmd_watch(api, token, days, interval, iterations, storm):
    detector = ClickDetector(storm=storm)
    detector.observe(fetch_stats(api, token, days)["totals"])
    print("watching %s every %gs (storm >= %d per window) - Ctrl-C to stop"
          % (api, interval, storm))
    windows = 0
    try:
        while iterations <= 0 or windows < iterations:
            time.sleep(interval)
            windows += 1
            totals = fetch_stats(api, token, days)["totals"]
            deltas, alerts = detector.observe(totals)
            stamp = datetime.now().strftime("%H:%M:%S")
            if deltas:
                body = "  ".join("%s +%d" % (e, deltas[e])
                                 for e in sorted(deltas, key=lambda k: -deltas[k]))
                print("%s  %s" % (stamp, body))
            else:
                print("%s  (no change)" % stamp)
            for level, code, message in alerts:
                print("        [%s] %s: %s" % (level.upper(), code, message))
            sys.stdout.flush()
    except KeyboardInterrupt:
        print("\nstopped after %d window(s)" % detector.windows)
    return 0


def cmd_report(api, token, days, outdir):
    payload = fetch_stats(api, token, days)
    totals = payload["totals"]
    os.makedirs(outdir, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    base = os.path.join(outdir, "report-" + stamp)

    alerts = [{"level": lv, "code": code, "message": msg}
              for lv, code, msg in static_alerts(totals)]

    with open(base + ".json", "w", encoding="utf-8") as fh:
        json.dump({
            "generatedAt": now_utc(),
            "window": payload.get("window"),
            "totals": totals,
            "funnel": funnel_rows(totals),
            "clicks": {e: totals.get(e, 0) for e in click_events(totals)},
            "alerts": alerts,
            "series": payload.get("series"),
        }, fh, indent=2, sort_keys=True)

    with open(base + ".csv", "w", encoding="utf-8", newline="") as fh:
        writer = csv.writer(fh)
        writer.writerow(["day", "event", "count"])
        for event in sorted(payload["series"]):
            for day in sorted(payload["series"][event]):
                writer.writerow([day, event, payload["series"][event][day]])
        for event in sorted(totals):
            writer.writerow(["all", event, totals[event]])

    window = payload.get("window") or {}
    md = [
        "# PayoutPool report",
        "",
        "- generated: " + now_utc(),
        "- window: last %s days (since %s)" % (window.get("days"), window.get("since")),
        "- scan: " + str(payload.get("scan")),
        "",
        "## Funnel",
        "",
        "| event | count | of views | step CR |",
        "| --- | ---: | ---: | ---: |",
    ]
    for row in funnel_rows(totals):
        md.append("| %s | %s | %s | %s |" % (row[0], row[1], row[2], row[3]))
    md += ["", "## Clicks / ad events", "",
           "| event | count | of views |", "| --- | ---: | ---: |"]
    for event in click_events(totals):
        md.append("| %s | %d | %s |"
                  % (event, totals.get(event, 0),
                     fmt_pct(totals.get(event, 0), totals.get("view", 0)).strip()))
    md += ["", "## Alerts", ""]
    md += ["- **%s** %s" % (a["code"], a["message"]) for a in alerts] or ["- none"]
    with open(base + ".md", "w", encoding="utf-8") as fh:
        fh.write("\n".join(md) + "\n")

    print(render_stats(payload))
    print("\nwrote %s.json\n      %s.csv\n      %s.md" % (base, base, base))
    return 0


def selftest():
    """Offline checks. No network, no token - run this after any edit."""
    failures = []

    def check(name, cond, detail=""):
        if cond:
            print("  pass  " + name)
        else:
            failures.append(name)
            print("  FAIL  " + name + ("  (" + detail + ")" if detail else ""))

    totals = {"view": 40, "step_1": 30, "step_2": 20, "step_3": 10,
              "capture_view": 8, "done": 0, "ad_netA": 12, "ad": 5}
    rows = funnel_rows(totals)

    check("pct", abs(pct(1, 4) - 25.0) < 1e-9)
    check("pct of nothing is None", pct(1, 0) is None)
    check("fmt_pct n/a", fmt_pct(1, 0).strip() == "n/a")
    check("funnel keeps order", [r[0] for r in rows] == FUNNEL)
    check("step CR uses previous row", rows[1][3] == "75.0%", rows[1][3])
    check("click_events finds ad_*", "ad_netA" in click_events(totals))

    codes = [a[1] for a in static_alerts(totals)]
    check("static alert: lead leak", "LEAD LEAK" in codes, str(codes))

    codes = [a[1] for a in static_alerts({"view": 10, "ad": 1, "done": 1})]
    check("static alert: none on healthy snapshot", "LEAD LEAK" not in codes, str(codes))

    det = ClickDetector(storm=5)
    det.observe({"view": 100, "ad_netA": 10})
    deltas, alerts = det.observe({"view": 100, "ad_netA": 14})
    check("detector delta", deltas.get("ad_netA") == 4, str(deltas))
    codes = [a[1] for a in alerts]
    check("detector: clicks without traffic", "CLICKS WITHOUT TRAFFIC" in codes, str(codes))

    det2 = ClickDetector(storm=5)
    det2.observe({"view": 0})
    deltas, alerts = det2.observe({"view": 50})
    codes = [a[1] for a in alerts]
    check("detector: quiet window is quiet",
          "CLICKS WITHOUT TRAFFIC" not in codes and deltas.get("view") == 50, str(codes))

    det3 = ClickDetector(storm=5)
    det3.observe({"view": 0, "ad": 0})
    deltas, alerts = det3.observe({"view": 60, "ad": 9})
    check("detector: burst", "BURST" in [a[1] for a in alerts])

    text = render_stats({"totals": totals,
                         "window": {"days": 7, "since": "2026-01-01"},
                         "scan": "complete"})
    check("render: funnel header", "FUNNEL" in text)
    check("render: network row", "ad_netA" in text)
    check("render: json mode",
          json.loads(render_stats({"totals": totals}, True))["totals"]["view"] == 40)

    print("")
    if failures:
        print("%d check(s) failed: %s" % (len(failures), ", ".join(failures)))
        return 1
    print("all checks passed")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        prog="pp_analytics.py",
        description="PayoutPool click + funnel analytics bot (stdlib only).")
    parser.add_argument("--api", default=os.environ.get("PP_API", DEFAULT_API),
                        help="worker base URL (default: %(default)s)")
    parser.add_argument("--token", default=os.environ.get("PP_ADMIN_TOKEN", ""),
                        help="/stats token, or set PP_ADMIN_TOKEN")
    parser.add_argument("--days", type=int, default=14,
                        help="window in days, 1-90 (default: %(default)s)")

    # SUPPRESS so a flag typed before the subcommand is not reset by it.
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument("--api", default=argparse.SUPPRESS)
    common.add_argument("--token", default=argparse.SUPPRESS)
    common.add_argument("--days", type=int, default=argparse.SUPPRESS)

    sub = parser.add_subparsers(dest="cmd")
    sub.required = True
    sub.add_parser("health", parents=[common], help="worker liveness + KV binding")
    p_stats = sub.add_parser("stats", parents=[common], help="one snapshot: funnel + clicks")
    p_stats.add_argument("--json", action="store_true", help="print the raw /stats payload")
    p_watch = sub.add_parser("watch", parents=[common],
                             help="poll /stats and print click deltas + alerts")
    p_watch.add_argument("--interval", type=float, default=15.0, help="seconds between polls")
    p_watch.add_argument("--iterations", type=int, default=0, help="stop after N windows (0 = forever)")
    p_watch.add_argument("--storm", type=int, default=25, help="alert when one event grows by N in a window")
    p_report = sub.add_parser("report", parents=[common],
                              help="write JSON + CSV + Markdown to a folder")
    p_report.add_argument("--out", default="reports", help="output folder (default: %(default)s)")
    sub.add_parser("selftest", help="offline checks of the maths and the detector")

    args = parser.parse_args(argv)

    try:
        if args.cmd == "health":
            return cmd_health(args.api)
        if args.cmd == "stats":
            return cmd_stats(args.api, args.token, args.days, args.json)
        if args.cmd == "watch":
            return cmd_watch(args.api, args.token, args.days,
                             args.interval, args.iterations, args.storm)
        if args.cmd == "report":
            return cmd_report(args.api, args.token, args.days, args.out)
        return selftest()
    except ApiError as exc:
        sys.stderr.write("error: %s\n" % exc)
        return 2


if __name__ == "__main__":
    sys.exit(main())

