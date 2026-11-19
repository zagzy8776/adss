"""End-to-end checks for pp_analytics.py against a local fake worker.

No network, no real token, no Cloudflare. Run:

    python -m unittest discover -s bot -p "test_*.py" -v
"""

import contextlib
import csv
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pp_analytics as bot  # noqa: E402

TOKEN = "test-token"

STATS = {
    "ok": True,
    "generatedAt": "2026-11-19T10:00:00.000Z",
    "window": {"days": 7, "since": "2026-11-13"},
    "days": ["2026-11-18", "2026-11-19"],
    "series": {
        "view": {"2026-11-18": 20, "2026-11-19": 10},
        "step_1": {"2026-11-18": 15, "2026-11-19": 8},
        "step_2": {"2026-11-18": 9, "2026-11-19": 5},
        "capture_view": {"2026-11-18": 4, "2026-11-19": 2},
        "ad_monetag": {"2026-11-18": 18, "2026-11-19": 9},
        "ad_adsterra": {"2026-11-18": 6, "2026-11-19": 3},
    },
    "totals": {
        "view": 30, "step_1": 23, "step_2": 14, "capture_view": 6,
        "ad_monetag": 27, "ad_adsterra": 9,
    },
    "scan": "complete",
}


GEO = {
    "ok": True,
    "generatedAt": "2026-11-19T10:00:00.000Z",
    "window": {"days": 7, "since": "2026-11-13"},
    "visits": 100,
    "countries": [
        {"cc": "US", "visits": 52, "share": 0.52},
        {"cc": "DE", "visits": 18, "share": 0.18},
        {"cc": "IN", "visits": 20, "share": 0.20},
        {"cc": "NG", "visits": 10, "share": 0.10},
    ],
    "regions": [{"region": "US-CA", "visits": 30}, {"region": "DE-BE", "visits": 12}],
    "signals": {"tz-mismatch": 22},
    "scan": "complete",
}


class FakeWorker(BaseHTTPRequestHandler):
    def _send(self, code, body):
        raw = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, {"ok": True, "kv": "ok"})
        if self.path.startswith("/stats"):
            if self.headers.get("X-Admin-Token") != TOKEN:
                return self._send(401, {"ok": False, "error": "unauthorized"})
            return self._send(200, STATS)
        if self.path.startswith("/geo"):
            if self.headers.get("X-Admin-Token") != TOKEN:
                return self._send(401, {"ok": False, "error": "unauthorized"})
            return self._send(200, GEO)
        return self._send(404, {"ok": False, "error": "not-found"})

    def log_message(self, *args):
        pass


class BotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeWorker)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.api = "http://127.0.0.1:%d" % cls.server.server_address[1]

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def run_bot(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = bot.main(argv)
        return code, out.getvalue(), err.getvalue()

    def test_stats_table(self):
        code, out, _ = self.run_bot(["--api", self.api, "--token", TOKEN, "stats"])
        self.assertEqual(code, 0)
        self.assertIn("FUNNEL", out)
        self.assertIn("ad_monetag", out)
        self.assertIn("ad_adsterra", out)
        # 23 of 30 step_1 = 76.7%
        self.assertIn("76.7%", out)

    def test_stats_json_is_raw_payload(self):
        code, out, _ = self.run_bot(["--api", self.api, "--token", TOKEN,
                                     "stats", "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["totals"]["view"], 30)

    def test_days_flag_lands_in_query(self):
        seen = {}

        class Recorder(FakeWorker):
            def do_GET(self):
                seen["path"] = self.path
                FakeWorker.do_GET(self)

        srv = ThreadingHTTPServer(("127.0.0.1", 0), Recorder)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            base = "http://127.0.0.1:%d" % srv.server_address[1]
            code, _, _ = self.run_bot(["--api", base, "--token", TOKEN,
                                       "stats", "--days", "30"])
            self.assertEqual(code, 0)
            self.assertTrue(seen["path"].startswith("/stats?days=30"), seen["path"])
        finally:
            srv.shutdown()
            srv.server_close()

    def test_bad_token_is_reported(self):
        code, _, err = self.run_bot(["--api", self.api, "--token", "nope", "stats"])
        self.assertEqual(code, 2)
        self.assertIn("HTTP 401", err)

    def test_missing_token_is_reported_before_the_call(self):
        code, _, err = self.run_bot(["--api", self.api, "--token", "", "stats"])
        self.assertEqual(code, 2)
        self.assertIn("no admin token", err)

    def test_health(self):
        code, out, _ = self.run_bot(["--api", self.api, "health"])
        self.assertEqual(code, 0)
        self.assertIn("kv=ok", out)

    def test_geo_table(self):
        code, out, _ = self.run_bot(["--api", self.api, "--token", TOKEN, "geo"])
        self.assertEqual(code, 0)
        self.assertIn("COUNTRIES", out)
        self.assertIn("United States", out)
        self.assertIn("US-CA", out)          # subdivisions survive the round trip
        self.assertIn("tier 1", out)
        self.assertIn("tz-mismatch", out)
        # 52 + 18 = 70% tier 1; 20% India is tier 3
        self.assertIn("70.0%", out)
        self.assertIn("PROXY HEAVY", out)    # 22 mismatches in 100 visits

    def test_geo_json_is_normalised(self):
        code, out, _ = self.run_bot(["--api", self.api, "--token", TOKEN,
                                     "geo", "--json"])
        self.assertEqual(code, 0)
        payload = json.loads(out)
        self.assertEqual(payload["visits"], 100)
        self.assertEqual(payload["countries"][0]["cc"], "US")
        # share is recomputed from the counts, not trusted from the wire
        self.assertAlmostEqual(payload["countries"][0]["share"], 52.0, places=3)

    def test_geo_bad_token_is_reported(self):
        code, _, err = self.run_bot(["--api", self.api, "--token", "nope", "geo"])
        self.assertEqual(code, 2)
        self.assertIn("HTTP 401", err)

    def test_geo_missing_token_is_reported_before_the_call(self):
        code, _, err = self.run_bot(["--api", self.api, "--token", "", "geo"])
        self.assertEqual(code, 2)
        self.assertIn("no admin token", err)

    def test_report_writes_json_csv_md(self):
        with tempfile.TemporaryDirectory() as tmp:
            code, out, _ = self.run_bot(["--api", self.api, "--token", TOKEN,
                                         "--days", "7", "report", "--out", tmp])
            self.assertEqual(code, 0)
            files = sorted(os.listdir(tmp))
            self.assertEqual(len(files), 3, files)

            with open(os.path.join(tmp, [f for f in files if f.endswith(".json")][0]),
                      encoding="utf-8") as fh:
                data = json.load(fh)
            self.assertEqual(data["totals"]["ad_adsterra"], 9)
            self.assertEqual(data["geo"]["visits"], 100)

            with open(os.path.join(tmp, [f for f in files if f.endswith(".csv")][0]),
                      encoding="utf-8", newline="") as fh:
                rows = list(csv.reader(fh))
            self.assertEqual(rows[0], ["day", "event", "count"])
            self.assertTrue(any(r == ["all", "view", "30"] for r in rows), rows[-6:])
            self.assertTrue(any(r[:2] == ["geo", "US"] for r in rows), rows[-6:])

            with open(os.path.join(tmp, [f for f in files if f.endswith(".md")][0]),
                      encoding="utf-8") as fh:
                md = fh.read()
            self.assertIn("| step_1 | 23 |", md)
            self.assertIn("## Alerts", md)
            self.assertIn("## Geo", md)
            self.assertIn("United States", md)
            self.assertIn(".csv", out)

    def test_watch_prints_one_window(self):
        code, out, _ = self.run_bot(["--api", self.api, "--token", TOKEN,
                                     "watch", "--interval", "0", "--iterations", "1"])
        self.assertEqual(code, 0)
        self.assertIn("watching", out)
        self.assertIn("(no change)", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
