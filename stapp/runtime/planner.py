"""ST's task/calendar rules over Radicale. Only the private Unix socket is exposed.

Radicale owns content. SQLite is a write-ahead operation journal, not another
task database. One conditional CalDAV PUT commits each mutation, including a
recurring completion and its history. The journal reconciles interrupted writes.
"""

import argparse
import base64
import copy
import hashlib
import json
import os
import re
import socketserver
import sqlite3
import threading
import time
import urllib.error
import urllib.request
import uuid
import xml.etree.ElementTree as ET
from datetime import date, datetime, time as day_time, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

from dateutil import rrule
from dateutil.relativedelta import relativedelta
from icalendar import Calendar, Event, Journal, Todo

UTC = timezone.utc
NAMESPACE = uuid.UUID("1d5da7b3-45c9-4f97-8e2b-06983418e7a1")
FREQUENCIES = {"daily": rrule.DAILY, "weekly": rrule.WEEKLY,
               "monthly": rrule.MONTHLY, "yearly": rrule.YEARLY}
WEEKDAYS = dict(zip(["MO", "TU", "WE", "TH", "FR", "SA", "SU"],
                    [rrule.MO, rrule.TU, rrule.WE, rrule.TH, rrule.FR, rrule.SA, rrule.SU]))
MAX_BYTES = 4 * 1024 * 1024


class PlannerError(Exception):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def require(condition, message, status=400):
    if not condition:
        raise PlannerError(message, status)


def uid(value):
    try:
        return str(uuid.UUID(str(value)))
    except (ValueError, TypeError, AttributeError):
        raise PlannerError("Invalid record ID") from None


def instant(value, zone):
    """Parse an all-day date or local/offset time; reject nonexistent DST times."""
    require(isinstance(value, str), "Expected an ISO date or date/time")
    try:
        tz = ZoneInfo(zone)
        if len(value) == 10:
            return date.fromisoformat(value)
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if result.tzinfo is None:
            naive = result
            result = result.replace(tzinfo=tz)
            require(result.astimezone(UTC).astimezone(tz).replace(tzinfo=None) == naive,
                    "This local time does not exist because of daylight saving")
            require(result.replace(fold=0).utcoffset() == result.replace(fold=1).utcoffset(),
                    "Ambiguous local time: include an explicit UTC offset")
        return result.astimezone(tz)
    except (ValueError, KeyError):
        raise PlannerError("Invalid date/time or IANA time zone") from None


def as_datetime(value, zone):
    return value if isinstance(value, datetime) else datetime.combine(value, day_time(), ZoneInfo(zone))


def serial(value):
    return value.isoformat()


def valid_time(value):
    return value.astimezone(UTC).astimezone(value.tzinfo).replace(tzinfo=None) == value.replace(tzinfo=None)


def next_due(record, completed_at):
    rule = record.get("recurrence")
    if not rule:
        return None
    # Count actual occurrences, including the initial due date. A generated
    # local time skipped for DST must not consume one of those occurrences.
    if rule.get("count") and record["recurrence_completed"] + 1 >= rule["count"]:
        return None
    zone = record["zone"]
    current = instant(record["due"], zone)
    anchor = instant(record["recurrence_anchor"], zone)
    if rule["mode"] == "completion":
        start = completed_at.astimezone(ZoneInfo(zone))
        if not isinstance(current, datetime):
            start = start.date()
        units = {"daily": "days", "weekly": "weeks", "monthly": "months", "yearly": "years"}
        next_value = start + relativedelta(**{units[rule["frequency"]]: rule["interval"]})
        if isinstance(next_value, datetime):
            # A completion-relative interval landing in a DST gap moves forward
            # by the gap, preserving elapsed wall-clock intent as closely as possible.
            next_value = next_value.astimezone(UTC).astimezone(ZoneInfo(zone))
    else:
        options = {"dtstart": as_datetime(anchor, zone), "interval": rule["interval"]}
        if rule.get("weekdays"):
            options["byweekday"] = [WEEKDAYS[x] for x in rule["weekdays"]]
        series = rrule.rrule(FREQUENCIES[rule["frequency"]], **options)
        next_value = series.after(as_datetime(current, zone))
        # RFC recurrence omits nonexistent local times rather than shifting them.
        for _ in range(8):
            if next_value is None or valid_time(next_value):
                break
            next_value = series.after(next_value)
        if next_value is None:
            return None
        require(valid_time(next_value), "Could not determine the next recurrence")
        if not isinstance(current, datetime):
            next_value = next_value.date()
    if rule.get("until") and as_datetime(next_value, zone) > as_datetime(instant(rule["until"], zone), zone):
        return None
    return serial(next_value)


class DAV:
    def __init__(self, config):
        self.url = config["url"].rstrip("/") + "/"
        require(self.url.startswith(("http://127.0.0.1:", "https://")), "CalDAV requires HTTPS or loopback HTTP")
        credentials = (config["username"] + ":" + config["password"]).encode()
        self.authorization = "Basic " + base64.b64encode(credentials).decode()
        # Do not forward credentials through an unexpected redirect.
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *args, **kwargs):
                return None
        self.opener = urllib.request.build_opener(NoRedirect)

    def request(self, method, path="", data=None, headers=None):
        request = urllib.request.Request(self.url + path, data=data, method=method,
                                        headers={"Authorization": self.authorization, **(headers or {})})
        try:
            with self.opener.open(request, timeout=8) as response:
                body = response.read(MAX_BYTES + 1)
                require(len(body) <= MAX_BYTES, "CalDAV response is too large", 502)
                return body, response.headers
        except urllib.error.HTTPError as error:
            code = error.code
            error.close()
            if code == 404:
                raise PlannerError("Record not found", 404) from None
            if code == 412:
                raise PlannerError("Record changed; reload before editing", 409) from None
            raise PlannerError(f"CalDAV returned HTTP {code}", 502) from None
        except (OSError, urllib.error.URLError):
            raise PlannerError("Radicale is unavailable", 503) from None

    def ensure_collection(self):
        try:
            self.request("PROPFIND", headers={"Depth": "0"})
            return
        except PlannerError as error:
            if error.status != 404:
                raise
        body = b'''<?xml version="1.0"?><C:mkcalendar xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:set><D:prop><D:displayname>S.T. Planner</D:displayname><C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/><C:comp name="VJOURNAL"/></C:supported-calendar-component-set></D:prop></D:set></C:mkcalendar>'''
        self.request("MKCALENDAR", data=body, headers={"Content-Type": "application/xml"})

    def get(self, record_id):
        data, headers = self.request("GET", uid(record_id) + ".ics")
        return decode(data, headers.get("ETag"))

    def all(self):
        body = b'''<?xml version="1.0"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"/></C:filter></C:calendar-query>'''
        data, _ = self.request("REPORT", data=body, headers={"Depth": "1", "Content-Type": "application/xml"})
        records = []
        for response in ET.fromstring(data).findall("{DAV:}response"):
            for propstat in response.findall("{DAV:}propstat"):
                if " 200 " not in propstat.findtext("{DAV:}status", ""):
                    continue
                prop = propstat.find("{DAV:}prop")
                content = prop.findtext("{urn:ietf:params:xml:ns:caldav}calendar-data")
                if content:
                    record = decode(content.encode(), prop.findtext("{DAV:}getetag"))
                    if record:
                        records.append(record)
        return records


def decode(data, etag):
    calendar = Calendar.from_ical(data)
    for component in calendar.subcomponents:
        if "X-STAPP-DATA" in component:
            value = json.loads(base64.urlsafe_b64decode(str(component["X-STAPP-DATA"])))
            require(value.get("schema") == 1, "Unsupported planner record schema", 502)
            if value.get("kind") == "project":
                value.setdefault("color", "#8aa7ff")
                value.setdefault("visible_on_screen", True)
            value["version"] = etag
            return value
    raise PlannerError("Unmanaged calendar object in ST's private collection", 502)


def encode(record):
    calendar = Calendar()
    calendar.add("prodid", "-//S.T.//Planner 1//EN")
    calendar.add("version", "2.0")
    component = {"task": Todo, "event": Event, "project": Journal}[record["kind"]]()
    component.add("uid", record["id"])
    component.add("dtstamp", datetime.now(UTC))
    component.add("summary", record["title"])
    component.add("description", record.get("body", ""))
    component.add("sequence", record["revision"])
    if record["kind"] == "task":
        component.add("status", "COMPLETED" if record["done"] else "NEEDS-ACTION")
        component.add("percent-complete", 100 if record["done"] else 0)
        component.add("priority", record["priority"])
        if record.get("labels"):
            component.add("categories", record["labels"])
        if record.get("parent_id"):
            component.add("related-to", record["parent_id"], parameters={"RELTYPE": "PARENT"})
        if record.get("due"):
            component.add("due", instant(record["due"], record["zone"]))
        rule = record.get("recurrence")
        if rule and rule["mode"] == "due":
            component.add("dtstart", instant(record["recurrence_anchor"], record["zone"]))
            fields = {"freq": rule["frequency"].upper(), "interval": rule["interval"]}
            if rule.get("weekdays"):
                fields["byday"] = rule["weekdays"]
            if rule.get("count"):
                fields["count"] = rule["count"]
            if rule.get("until"):
                until = instant(rule["until"], record["zone"])
                fields["until"] = until.astimezone(UTC) if isinstance(until, datetime) else until
            component.add("rrule", fields)
        if record.get("completed_at"):
            component.add("completed", datetime.fromisoformat(record["completed_at"]))
    elif record["kind"] == "event":
        component.add("dtstart", instant(record["starts"], record["zone"]))
        if record.get("ends"):
            component.add("dtend", instant(record["ends"], record["zone"]))
    # Base64 avoids unknown-property TEXT escaping differences between vobject
    # (Radicale) and icalendar while retaining one atomic iCalendar resource.
    metadata = json.dumps(record, ensure_ascii=False, separators=(",", ":")).encode()
    component.add("X-STAPP-DATA", base64.urlsafe_b64encode(metadata).decode())
    calendar.add_component(component)
    return calendar.to_ical()


class Planner:
    def __init__(self, config, data):
        self.dav = DAV(config)
        self.zone = config.get("zone", "Europe/Prague")
        self.lock = threading.RLock()
        self.data = Path(data)
        self.data.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.db = sqlite3.connect(self.data / "planner-operations.sqlite", check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS operations (key TEXT PRIMARY KEY, hash TEXT NOT NULL, body BLOB NOT NULL, etag TEXT, result TEXT)")
        self.cache = None
        self.cached_at = 0

    def listing(self, fresh=False):
        if fresh or self.cache is None or time.monotonic() - self.cached_at > 3:
            self.cache = self.dav.all()
            self.cached_at = time.monotonic()
        # History is available through get_record without inflating every SSE
        # frame, widget refresh or model task listing.
        visible = [{k: v for k, v in r.items() if k not in ("history", "last_operation")}
                   for r in self.cache if not r.get("deleted")]
        return {"records": [r for r in visible if r["kind"] != "project"],
                "projects": [r for r in visible if r["kind"] == "project"], "status": "ok"}

    def validate(self, record):
        require(record["kind"] in ("task", "event", "project"), "Invalid record kind")
        title = record["title"]
        require(isinstance(title, str) and 0 < len(title.strip()) <= 4000, "Expected a title up to 4000 characters")
        record["title"] = title.strip()
        require(isinstance(record.get("body", ""), str) and len(record.get("body", "")) <= 32000, "Description is too long")
        require(isinstance(record.get("done"), bool), "Expected a completion boolean")
        if record["kind"] == "project":
            color = record.setdefault("color", "#8aa7ff")
            require(isinstance(color, str) and re.fullmatch(r"#[0-9a-fA-F]{6}", color), "Choose a six-digit hex project color")
            record["color"] = color.lower()
            require(type(record.setdefault("visible_on_screen", True)) is bool, "Screen visibility must be a boolean")
        try:
            ZoneInfo(record["zone"])
        except (KeyError, TypeError, ValueError):
            raise PlannerError("Invalid IANA time zone") from None
        for key in ("due", "starts", "ends"):
            if record.get(key):
                record[key] = serial(instant(record[key], record["zone"]))
        if record["kind"] == "event":
            require(record.get("starts"), "Events need a start date/time")
            require(not record.get("recurrence"), "Recurring events are not implemented yet")
            if record.get("ends"):
                start, end = instant(record["starts"], record["zone"]), instant(record["ends"], record["zone"])
                require(type(start) is type(end) and end > start, "Event end must follow start and use the same date/time type")
        if record["kind"] == "task":
            require(type(record["priority"]) is int and 0 <= record["priority"] <= 9, "Priority must be 0–9 (1 is highest, 0 is unset)")
            require(isinstance(record["labels"], list) and len(record["labels"]) <= 50 and all(isinstance(x, str) and 0 < len(x) <= 100 for x in record["labels"]), "Invalid labels")
            rule = record.get("recurrence")
            if rule is not None:
                require(isinstance(rule, dict), "Recurrence must be an object or null")
                require(set(rule) <= {"frequency", "interval", "mode", "weekdays", "until", "count"}, "Unknown recurrence field")
                require(rule.get("frequency") in FREQUENCIES, "Recurrence must be daily, weekly, monthly or yearly")
                rule.setdefault("interval", 1)
                rule.setdefault("mode", "due")
                require(type(rule["interval"]) is int and 1 <= rule["interval"] <= 100, "Recurrence interval must be 1–100")
                require(rule["mode"] in ("due", "completion"), "Recurrence mode must be due or completion")
                require(record.get("due"), "A recurring task needs a due date")
                if rule.get("weekdays") is not None:
                    require(isinstance(rule["weekdays"], list) and 0 < len(rule["weekdays"]) <= 7 and all(x in WEEKDAYS for x in rule["weekdays"]), "Invalid recurrence weekdays")
                    require(rule["frequency"] == "weekly" and rule["mode"] == "due", "Weekdays require weekly due-date recurrence")
                if rule.get("count") is not None:
                    require(type(rule["count"]) is int and 1 <= rule["count"] <= 10000, "Recurrence count must be 1–10000")
                require(not (rule.get("until") and rule.get("count")), "Choose an end date or occurrence count")
                if rule.get("until"):
                    end = instant(rule["until"], record["zone"])
                    due = instant(record["due"], record["zone"])
                    require(type(end) is type(due) and end >= due, "Recurrence end must be at or after the due date with the same date/time type")
            for key, kind in (("project_id", "project"), ("parent_id", "task")):
                if record.get(key):
                    require(record[key] != record["id"], "A record cannot contain itself")
                    related = self.dav.get(record[key])
                    require(related["kind"] == kind and not related.get("deleted"), "Related record is unavailable")
                    if key == "parent_id":
                        require(related.get("project_id") == record.get("project_id"), "Subtasks must belong to the parent's project")
                        visited = {record["id"]}
                        while related:
                            require(related["id"] not in visited, "Subtask cycle")
                            visited.add(related["id"])
                            require(len(visited) <= 50, "Subtask nesting exceeds 50 levels")
                            related = self.dav.get(related["parent_id"]) if related.get("parent_id") else None

    def prepare(self, action, args, key):
        old = None
        if args.get("id"):
            old = self.dav.get(args["id"])
            require(not old.get("deleted"), "Record not found", 404)
            require(args.get("version") == old["version"], "Record changed; reload before editing", 409)
        require(action == "save" or old is not None, "This operation needs a record ID")
        record = copy.deepcopy(old) if old else {
            "schema": 1, "id": str(uuid.uuid5(NAMESPACE, key)), "kind": args.get("kind"),
            "title": "", "body": "", "zone": self.zone, "done": False,
            "priority": 0, "labels": [], "project_id": None, "parent_id": None,
            "recurrence": None, "revision": -1, "history": [], "completion_count": 0,
            "recurrence_completed": 0,
        }
        if action == "save":
            allowed = {"id", "version", "kind", "title", "body", "zone", "due", "starts", "ends", "priority", "labels", "project_id", "parent_id", "recurrence", "done", "color", "visible_on_screen"}
            require(set(args) <= allowed, "Unknown record field")
            require(not old or args.get("kind", old["kind"]) == old["kind"], "Cannot change record kind")
            require(record["kind"] == "project" or not ({"color", "visible_on_screen"} & set(args)), "Color and screen visibility belong to projects")
            for field in allowed - {"id", "version", "done"}:
                if field in args:
                    record[field] = copy.deepcopy(args[field])
            if record["kind"] == "task" and args.get("done") is True:
                require(old is not None and set(args) <= {"id", "version", "kind", "title", "done"}, "Complete a saved task separately")
                return self.prepare("complete", {"id": old["id"], "version": old["version"]}, key)
            if "done" in args:
                require(type(args["done"]) is bool, "Expected completion boolean")
                record["done"] = args["done"]
                if not args["done"]:
                    record.pop("completed_at", None)
            # Clients commonly resend the zone while renaming a task. Only a
            # real schedule change starts a new recurrence sequence.
            if any(k in args and (old is None or args[k] != old.get(k)) for k in ("recurrence", "due", "zone")):
                record["recurrence_anchor"] = record.get("due")
                record["recurrence_completed"] = 0
            self.validate(record)
            if old and old["kind"] == "task" and old.get("project_id") != record.get("project_id"):
                require(not any(r.get("parent_id") == old["id"] for r in self.listing(True)["records"]), "Move subtasks before moving their parent to another project")
        elif action == "complete":
            require(set(args) <= {"id", "version"}, "Unknown completion field")
            require(record["kind"] == "task", "Only tasks can be completed")
            require(not record["done"], "Task is already completed", 409)
            now = datetime.now(UTC)
            following = next_due(record, now)
            record["history"] = (record["history"] + [{"completed_at": serial(now), "due": record.get("due")}])[-256:]
            record["completion_count"] += 1
            record["recurrence_completed"] += 1
            record["last_completed_at"] = serial(now)
            record["done"] = following is None
            if following:
                record["due"] = following
            else:
                record["completed_at"] = serial(now)
        elif action == "delete":
            require(set(args) <= {"id", "version"}, "Unknown delete field")
            all_records = self.listing(True)["records"]
            require(not any(r.get("parent_id") == record["id"] or r.get("project_id") == record["id"] for r in all_records), "Remove or move child tasks before deleting this record")
            # A tombstone lets an interrupted delete be reconciled atomically.
            record["deleted"] = True
        else:
            raise PlannerError("Unknown planner action")
        record.pop("version", None)
        record["revision"] += 1
        record["last_operation"] = key
        record["updated_at"] = serial(datetime.now(UTC))
        return record, old["version"] if old else None

    def mutate(self, action, args, key):
        require(isinstance(key, str) and 0 < len(key) <= 200, "An idempotency key is required")
        signature = hashlib.sha256(json.dumps([action, args], sort_keys=True).encode()).hexdigest()
        operation = self.db.execute("SELECT hash,body,etag,result FROM operations WHERE key=?", (key,)).fetchone()
        if operation:
            require(operation[0] == signature, "Idempotency key already used with different input", 409)
            if operation[3]:
                return json.loads(operation[3])
            body, etag = operation[1:3]
            prepared = decode(body, None)
        else:
            prepared, etag = self.prepare(action, args, key)
            body = encode(prepared)
            with self.db:
                self.db.execute("INSERT INTO operations VALUES(?,?,?,?,NULL)", (key, signature, body, etag))
        # Read first even on retry: a process may have died after PUT succeeded.
        try:
            current = self.dav.get(prepared["id"])
        except PlannerError as error:
            if error.status != 404:
                raise
            current = None
        if current and current.get("last_operation") == key:
            result = current
        else:
            require((current is None and etag is None) or (current is not None and current["version"] == etag),
                    "Record changed before this operation could be reconciled", 409)
            condition = {"If-Match": etag} if etag else {"If-None-Match": "*"}
            self.dav.request("PUT", prepared["id"] + ".ics", body,
                             {"Content-Type": "text/calendar; charset=utf-8", **condition})
            result = self.dav.get(prepared["id"])
            require(result.get("last_operation") == key, "Record changed after saving; reload it", 409)
        with self.db:
            self.db.execute("UPDATE operations SET result=? WHERE key=?", (json.dumps(result), key))
        self.cache = None
        return result

    def call(self, request):
        with self.lock:
            require(isinstance(request, dict), "Expected a request object")
            action = request.get("action")
            args = request.get("args", {})
            require(isinstance(args, dict), "Expected object arguments")
            if action == "list":
                return self.listing(bool(args.get("fresh")))
            if action == "get":
                result = self.dav.get(args.get("id"))
                require(not result.get("deleted"), "Record not found", 404)
                return result
            return self.mutate(action, args, request.get("key"))


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        self.request.settimeout(15)
        line = self.rfile.readline(MAX_BYTES + 1)
        try:
            require(len(line) <= MAX_BYTES, "Request is too large")
            result = self.server.planner.call(json.loads(line))
            response = {"result": result}
        except PlannerError as error:
            response = {"error": str(error), "status": error.status}
        except Exception:
            # Do not leak CalDAV authentication or calendar bodies in errors.
            response = {"error": "Planner could not process this request", "status": 500}
        self.wfile.write(json.dumps(response).encode() + b"\n")


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--data", required=True)
    parser.add_argument("--socket", required=True)
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(Path(args.config).read_text())
    if config.get("backend") == "dave":
        from planner_dave import DavePlanner
        planner = DavePlanner(config, args.data, Planner, PlannerError)
    else:
        planner = Planner(config, args.data)
    planner.dav.ensure_collection()
    socket_path = Path(args.socket)
    if socket_path.exists():
        import socket
        with socket.socket(socket.AF_UNIX) as probe:
            try:
                probe.connect(str(socket_path))
            except ConnectionRefusedError:
                socket_path.unlink()
            else:
                raise SystemExit("Planner already running")
    with Server(str(socket_path), Handler) as server:
        server.planner = planner
        try:
            server.serve_forever()
        finally:
            socket_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
