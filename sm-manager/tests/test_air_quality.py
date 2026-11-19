import http.client
import json
import tempfile
import threading
import unittest
from contextlib import closing
from http.server import ThreadingHTTPServer
from unittest.mock import Mock, patch

from sm_manager.air_quality import AirQuality, MAX_RESPONSE_BYTES, NoRedirect, daily_average, parse_sample
from sm_manager.history import RETENTION
from sm_manager.server import handler_for

NOW = 1_800_000_000
DEVICE = "AABBCCDDEEFF"


def payload(timestamp=NOW, raw=None, escaped=False):
    if raw is None:
        raw = {"scd40": {"co2": 900}, "sen55": {"pm2.5": 17, "pm10.0": 24,
               "temperature": 23.5, "humidity": 45, "voc": 0, "nox": None}}
    value = json.dumps(raw)
    if escaped:
        value = json.dumps(value)[1:-1]
    return {"code": 200, "data": {"updateTime": str(timestamp), "value": value,
                                  "dataToken": "must-not-be-exposed"}}


class AirQualityTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.config = {"data_dir": temp.name, "air_quality_device": DEVICE}
        self.air = AirQuality(self.config)
        self.addCleanup(self.air.close)

    def poll(self, data, now=NOW):
        body = json.dumps(data).encode() if not isinstance(data, bytes) else data
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = body
        with patch("sm_manager.air_quality.build_opener") as opener:
            opener.return_value.open.return_value = response
            self.air.poll(now)
            self.assertEqual(opener.call_args.args, (NoRedirect,))
            request = opener.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, f"https://ezdata2.m5stack.com/api/v2/{DEVICE}/dataMacByKey/raw")
            self.assertEqual(opener.return_value.open.call_args.kwargs["timeout"], 10)
            response.read.assert_called_once_with(MAX_RESPONSE_BYTES + 1)

    def test_standard_and_stock_escaped_json_preserve_missing_gas_values(self):
        for escaped in (True, False):
            sample = parse_sample(payload(escaped=escaped), NOW)
            self.assertEqual(sample["co2"], 900)
            self.assertEqual(sample["pm25"], 17)
            self.assertIsNone(sample["voc"])
            self.assertIsNone(sample["nox"])
            self.assertNotIn("dataToken", sample)
        raw = {"scd40": {"co2": 700}, "profile": {"nickname": 'Room "A" \\ north'}}
        self.assertEqual(parse_sample(payload(raw=raw, escaped=True), NOW)["co2"], 700)

    def test_invalid_metrics_never_become_zero_or_nonfinite(self):
        raw = {"scd40": {"co2": True}, "sen55": {"pm2.5": -1, "pm10.0": float("nan"),
               "temperature": 24, "humidity": 101, "voc": 501, "nox": "12"}}
        sample = parse_sample(payload(raw=raw), NOW)
        self.assertEqual(sample["temperature"], 24)
        self.assertTrue(all(sample[key] is None for key in ("co2", "pm25", "pm10", "humidity", "voc", "nox")))
        for raw in (None, [], {}, {"sen55": []}):
            data = payload()
            data["data"]["value"] = raw
            with self.assertRaises(ValueError):
                parse_sample(data, NOW)

    def test_invalid_envelopes_and_timestamps(self):
        for data in (None, [], {"code": 500}, payload(NOW + 3600), payload(0), payload(-1)):
            with self.subTest(data=data), self.assertRaises(ValueError):
                parse_sample(data, NOW)
        for timestamp in (None, "garbage", float("inf")):
            data = payload()
            data["data"]["updateTime"] = timestamp
            with self.assertRaises(ValueError):
                parse_sample(data, NOW)

    def test_poll_deduplicates_uses_source_time_and_restores_after_restart(self):
        self.poll(payload())
        self.poll(payload(), NOW + 600)
        data = self.air.query(now=NOW + 600)
        self.assertTrue(data["stale"])
        self.assertEqual(data["latest"]["timestamp"], NOW)
        self.assertEqual(len(data["points"]), 1)
        self.assertEqual(data["checked_at"], NOW + 600)
        restored = AirQuality(self.config)
        try:
            self.assertEqual(restored.query(now=NOW + 600)["latest"], data["latest"])
        finally:
            restored.close()
        self.poll(payload(NOW - 60), NOW + 600)
        self.assertEqual(self.air.query(now=NOW + 600)["latest"]["timestamp"], NOW)

    def test_network_and_payload_failures_keep_previous_data_and_recover(self):
        self.poll(payload())
        for data in (b"not-json", b"x" * (MAX_RESPONSE_BYTES + 1), {"code": 403}):
            self.poll(data, NOW + 60)
            result = self.air.query(now=NOW + 60)
            self.assertIsNotNone(result["error"])
            self.assertEqual(result["latest"]["timestamp"], NOW)
        with patch("sm_manager.air_quality.build_opener") as opener:
            opener.return_value.open.side_effect = OSError("private detail")
            self.air.poll(NOW + 600)
        result = self.air.query(now=NOW + 600)
        self.assertTrue(result["stale"])
        self.assertNotIn("private detail", result["error"])
        self.poll(payload(NOW + 600), NOW + 600)
        self.assertIsNone(self.air.query(now=NOW + 600)["error"])

    def test_retention_prunes_even_on_failure_and_bounds_query(self):
        self.poll(payload())
        self.poll(b"invalid", NOW + RETENTION + 1)
        self.assertIsNone(self.air.query(now=NOW + RETENTION + 1)["latest"])
        self.assertEqual(self.air.db.execute("SELECT COUNT(*) FROM readings").fetchone()[0], 0)
        for hours in (0, -1, 721, float("nan"), float("inf")):
            with self.assertRaises(ValueError):
                self.air.query(hours, NOW)
        self.poll(payload(NOW - RETENTION - 1))
        self.assertIsNone(self.air.query(now=NOW)["latest"])

    def test_range_buckets_preserve_spike_and_missing_values(self):
        self.poll(payload(NOW - 5, {"scd40": {"co2": 2000}}))
        self.poll(payload(NOW - 1, {"scd40": {"co2": 500}}))
        result = self.air.query(24, NOW)
        self.assertEqual(len(result["points"]), 1)
        point = result["points"][0]
        self.assertEqual(point["co2"], 1250)
        self.assertEqual(point["co2_peak"], 2000)
        self.assertIsNone(point["voc"])
        self.assertIsNone(point["voc_peak"])
        self.assertEqual(self.air.query(24, NOW + 86401)["points"], [])

    def test_daily_average_requires_coverage_and_does_not_bridge_outages(self):
        rows = [{"timestamp": NOW - 86400 + i * 60, "pm25": 20, "pm10": None} for i in range(1440)]
        result = daily_average(rows, NOW)
        self.assertTrue(result["pm25"]["complete"])
        self.assertEqual(result["pm25"]["value"], 20)
        self.assertEqual(result["pm25"]["coverage"], 1)
        self.assertFalse(result["pm10"]["complete"])
        self.assertIsNone(result["pm10"]["value"])
        result = daily_average([rows[0], rows[-1]], NOW)["pm25"]
        self.assertAlmostEqual(result["coverage"], 180 / 86400)
        self.assertFalse(result["complete"])
        self.assertEqual(daily_average([], NOW)["pm25"]["coverage"], 0)

    def test_selected_bucket_changes_aggregation_without_losing_peaks(self):
        for offset, co2 in ((290, 500), (230, 2000), (170, 800)):
            self.poll(payload(NOW - offset, {"scd40": {"co2": co2}}))
        fine = self.air.query(6, NOW, bucket_seconds=60)
        coarse = self.air.query(6, NOW, bucket_seconds=300)
        self.assertEqual(fine["bucket_seconds"], 60)
        self.assertEqual(len(fine["points"]), 3)
        self.assertEqual(coarse["bucket_seconds"], 300)
        self.assertEqual(len(coarse["points"]), 1)
        self.assertEqual(coarse["points"][0]["co2"], 1100)
        self.assertEqual(coarse["points"][0]["co2_peak"], 2000)
        self.assertEqual(fine["latest"], coarse["latest"])
        self.assertEqual(fine["daily"], coarse["daily"])

    def test_bucket_validation_and_automatic_resolution_keep_queries_bounded(self):
        for bucket in (0, -1, 1, 120, True, 300.0, "300", float("nan"), float("inf")):
            with self.subTest(bucket=bucket), self.assertRaises(ValueError):
                self.air.query(6, NOW, bucket_seconds=bucket)
        for hours, bucket in ((720, 60), (168, 300), (1, 86400)):
            with self.subTest(hours=hours, bucket=bucket), self.assertRaises(ValueError):
                self.air.query(hours, NOW, bucket_seconds=bucket)
        self.assertEqual(self.air.query(24, NOW)["bucket_seconds"], 240)
        self.assertEqual(self.air.query(720, NOW)["bucket_seconds"], 7200)
        self.assertEqual(self.air.query(720, NOW, bucket_seconds=1800)["bucket_seconds"], 1800)
        self.assertEqual(self.air.query(24, NOW, bucket_seconds=60)["bucket_seconds"], 60)

    def test_devices_are_isolated_disabled_does_not_poll_and_redirects_blocked(self):
        self.poll(payload())
        other = AirQuality({**self.config, "air_quality_device": "000000000001"})
        disabled = AirQuality({"data_dir": self.config["data_dir"]})
        try:
            self.assertIsNone(other.query(now=NOW)["latest"])
            with patch("sm_manager.air_quality.build_opener") as opener:
                disabled.poll()
                opener.assert_not_called()
            self.assertFalse(disabled.query()["enabled"])
        finally:
            other.close()
            disabled.close()
        for device in ("https://internal", "AABBCCDDEEFF/../other", "abc"):
            with self.assertRaises(ValueError):
                AirQuality({**self.config, "air_quality_device": device})
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, "", {}, "http://localhost"))

    def test_api_works_before_host_snapshot_and_retains_access_boundaries(self):
        config = {"port": 0, "allowed_hosts": ["localhost"]}
        collector = Mock()
        collector.get_snapshot.return_value = None
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(collector, config, self.air))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)

        def request(path="/api/air-quality", **headers):
            with closing(http.client.HTTPConnection("127.0.0.1", server.server_port)) as client:
                client.request("GET", path, headers={"Host": "localhost", **headers})
                response = client.getresponse()
                return response.status, response.read(), response.headers

        status, body, headers = request()
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)["points"], [])
        self.assertEqual(headers["Cache-Control"], "no-store")
        self.assertNotIn("Access-Control-Allow-Origin", headers)
        for query in ("NaN", "inf", "721", "bad", "0"):
            self.assertEqual(request("/api/air-quality?hours=" + query)[0], 400)
        for query in ("60", "300", "900", "1800", "3600", "21600", "auto"):
            status, body, _ = request("/api/air-quality?hours=6&bucket=" + query)
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body)["bucket_seconds"], 60 if query == "auto" else int(query))
        for query in ("NaN", "inf", "bad", "0", "120", "300.5", "86400"):
            self.assertEqual(request("/api/air-quality?hours=6&bucket=" + query)[0], 400)
        self.assertEqual(request("/api/air-quality?hours=720&bucket=60")[0], 400)
        for headers in ({"Host": "evil.test"}, {"Origin": "https://evil.test"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(request(**headers)[0], 403)
        self.assertEqual(request("/air-quality.js")[0], 200)
        self.assertEqual(request("/air-quality.sqlite")[0], 404)
        collector.get_snapshot.assert_not_called()


if __name__ == "__main__":
    unittest.main()
