"""Bounded, read-only AirQ polling and independent 30-day sensor history."""
import json
import math
import re
import sqlite3
import threading
import time
from pathlib import Path
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .history import RETENTION, RETENTION_HOURS

POLL_SECONDS = 60
STALE_SECONDS = 300
MAX_RESPONSE_BYTES = 256 * 1024
BUCKET_SECONDS = (60, 300, 900, 1800, 3600, 21600, 86400)
MAX_CHART_BUCKETS = 1440
METRICS = {
    "co2": ("scd40", "co2", 1, 40000),
    "pm1": ("sen55", "pm1.0", 0, 1000),
    "pm25": ("sen55", "pm2.5", 0, 1000),
    "pm4": ("sen55", "pm4.0", 0, 1000),
    "pm10": ("sen55", "pm10.0", 0, 1000),
    "temperature": ("sen55", "temperature", -40, 85),
    "humidity": ("sen55", "humidity", 0, 100),
    "voc": ("sen55", "voc", 1, 500),
    "nox": ("sen55", "nox", 1, 500),
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def parse_sample(payload, now):
    if not isinstance(payload, dict) or payload.get("code") != 200:
        raise ValueError("AirQ did not return a successful reading")
    data = payload.get("data")
    if not isinstance(data, dict):
        raise ValueError("Missing AirQ data")
    try:
        timestamp = int(data["updateTime"])
    except (KeyError, ValueError, TypeError, OverflowError):
        raise ValueError("Missing AirQ publication time") from None
    if not 0 < timestamp <= now + POLL_SECONDS:
        raise ValueError("Invalid AirQ publication time")
    raw = data.get("value")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except ValueError:
            # Stock firmware publishes JSON with escaped quotes, without the
            # outer string delimiters. Decode that layer, then the object.
            raw = json.loads(json.loads('"' + raw + '"'))
    if not isinstance(raw, dict):
        raise ValueError("Invalid AirQ sensor data")
    values = {}
    for name, (sensor, key, low, high) in METRICS.items():
        group = raw.get(sensor)
        value = group.get(key) if isinstance(group, dict) else None
        values[name] = (float(value) if type(value) in (int, float)
                        and math.isfinite(value) and low <= value <= high else None)
    if not any(value is not None for value in values.values()):
        raise ValueError("No valid AirQ measurements")
    return {"timestamp": timestamp, **values}


def daily_average(rows, now):
    """Time-weight observed readings, never carrying one across an outage.

    Hold each reading for at most two polls. Coverage is explicit; 90% is our
    display completeness rule, not a WHO monitoring/certification standard.
    """
    result = {}
    for key in ("pm25", "pm10"):
        total = covered = 0
        for i, row in enumerate(rows):
            end = min(now, row["timestamp"] + 2 * POLL_SECONDS,
                      rows[i + 1]["timestamp"] if i + 1 < len(rows) else now)
            duration = max(0, end - max(now - 86400, row["timestamp"]))
            if row[key] is not None:
                covered += duration
                total += row[key] * duration
        result[key] = {"value": total / covered if covered else None,
                       "coverage": covered / 86400, "complete": covered >= 0.9 * 86400}
    return result


class AirQuality:
    def __init__(self, config):
        self.device = config.get("air_quality_device", "").upper()
        if self.device and not re.fullmatch(r"[0-9A-F]{12}", self.device):
            raise ValueError("air_quality_device must be a 12-character MAC address")
        self.enabled = bool(self.device)
        self.source_url = f"https://airq.m5stack.com/{self.device}" if self.enabled else None
        self.raw_url = f"https://ezdata2.m5stack.com/api/v2/{self.device}/dataMacByKey/raw" if self.enabled else None
        directory = Path(config["data_dir"])
        directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(directory / "air-quality.sqlite", check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=3000")
        columns = ", ".join(f"{name} REAL" for name in METRICS)
        self.db.execute(f"""CREATE TABLE IF NOT EXISTS readings (
            device TEXT NOT NULL, timestamp INTEGER NOT NULL, {columns},
            PRIMARY KEY (device, timestamp)) WITHOUT ROWID""")
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.checked_at = None
        self.error = None

    def poll(self, now=None):
        if not self.enabled:
            return
        now = time.time() if now is None else now
        error = None
        sample = None
        try:
            request = Request(self.raw_url, headers={"Accept": "application/json", "User-Agent": "SMManager/0.1"})
            with build_opener(NoRedirect).open(request, timeout=10) as response:
                body = response.read(MAX_RESPONSE_BYTES + 1)
            if len(body) > MAX_RESPONSE_BYTES:
                raise ValueError("AirQ response exceeds limit")
            sample = parse_sample(json.loads(body), now)
        except (OSError, ValueError, TypeError, RecursionError):
            error = "Could not fetch a valid AirQ reading. Retrying every minute."
        with self.lock, self.db:
            if sample and sample["timestamp"] >= now - RETENTION:
                placeholders = ",".join("?" for _ in range(len(METRICS) + 2))
                self.db.execute(f"INSERT OR IGNORE INTO readings VALUES ({placeholders})",
                                (self.device, sample["timestamp"], *(sample[key] for key in METRICS)))
            self.db.execute("DELETE FROM readings WHERE timestamp < ?", (now - RETENTION,))
            self.checked_at, self.error = now, error

    def query(self, hours=24, now=None, bucket_seconds=None):
        if not math.isfinite(hours) or not 0.25 <= hours <= RETENTION_HOURS:
            raise ValueError(f"Use hours=0.25..{RETENTION_HOURS}")
        now = time.time() if now is None else now
        minimum_bucket = max(POLL_SECONDS, math.ceil(hours * 3600 / MAX_CHART_BUCKETS))
        if bucket_seconds is not None and (
                type(bucket_seconds) is not int or bucket_seconds not in BUCKET_SECONDS
                or not minimum_bucket <= bucket_seconds <= hours * 3600):
            raise ValueError("Choose a supported bucket size for this time range")
        bucket = bucket_seconds or max(POLL_SECONDS, math.ceil(hours * 3600 / 360))
        aggregations = ", ".join(f"AVG({key}) AS {key}, MAX({key}) AS {key}_peak" for key in METRICS)
        with self.lock:
            latest = self.db.execute("SELECT * FROM readings WHERE device=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp DESC LIMIT 1",
                                     (self.device, now - RETENTION, now)).fetchone()
            points = self.db.execute(f"""SELECT MIN(timestamp) AS timestamp, {aggregations}
                FROM readings WHERE device=? AND timestamp>=? AND timestamp<=?
                GROUP BY CAST(timestamp / ? AS INTEGER) ORDER BY timestamp""",
                (self.device, now - hours * 3600, now, bucket)).fetchall()
            daily = self.db.execute("SELECT timestamp, pm25, pm10 FROM readings WHERE device=? AND timestamp>=? AND timestamp<=? ORDER BY timestamp",
                                    (self.device, now - 86400 - 2 * POLL_SECONDS, now)).fetchall()
            first = self.db.execute("SELECT MIN(timestamp) FROM readings WHERE device=? AND timestamp>=? AND timestamp<=?",
                                    (self.device, now - RETENTION, now)).fetchone()[0]
            checked_at, error = self.checked_at, self.error
        latest = dict(latest) if latest else None
        if latest:
            latest.pop("device")
        stale = not latest or now - latest["timestamp"] > STALE_SECONDS
        return {"enabled": self.enabled, "source_url": self.source_url, "raw_url": self.raw_url,
                "latest": latest, "stale": stale, "checked_at": checked_at, "error": error,
                "now": now, "hours": hours, "bucket_seconds": bucket, "poll_seconds": POLL_SECONDS,
                "started_at": first, "points": [dict(row) for row in points],
                "daily": daily_average(daily, now)}

    def run(self):
        while not self.stop_event.is_set():
            self.poll()
            self.stop_event.wait(POLL_SECONDS)

    def close(self):
        with self.lock:
            self.db.close()
