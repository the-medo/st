"""Faceplate/MCP contract backed by the same DAVe API used by the ST web UI.

Radicale is the content store. Local SQLite stores only operation receipts and
faceplate visibility preferences. DAVe owns task completion and recurrence.
"""

import copy
import hashlib
import http.client
import json
import time
import uuid
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from http.cookies import SimpleCookie
from urllib.parse import quote, urlencode, urlsplit

NAMESPACE = uuid.UUID("6993f297-b10a-448d-aef2-ffae19bc2bb0")


def identity(value):
    try:
        return str(uuid.UUID(value))
    except ValueError:
        return str(uuid.uuid5(NAMESPACE, value))


class DavePlanner:
    def __init__(self, config, data, legacy_class, error_class):
        self.error = error_class
        self.legacy = legacy_class(config, data)
        self.storage_type = type(self.legacy.dav)
        self.legacy.dav = self
        self.legacy.listing = self.listing
        self.dav = self
        self.db = self.legacy.db
        self.lock = self.legacy.lock
        self.config = config
        self.zone = config.get("zone", "Europe/Prague")
        self.endpoint = urlsplit(config["dave_url"])
        self.require(self.endpoint.scheme == "http" and self.endpoint.hostname == "127.0.0.1"
                     and self.endpoint.port and not self.endpoint.username
                     and self.endpoint.path in ("", "/") and not self.endpoint.query and not self.endpoint.fragment,
                     "DAVe must use a loopback HTTP endpoint")
        self.default_id = config.get("default_calendar_id", "planner")
        self.cookie = None
        self.cached_at = 0
        self.sources = {}
        self.calendars = []
        self.result = None
        self.synced = False
        self.db.execute("CREATE TABLE IF NOT EXISTS dave_operations (key TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT)")
        self.db.execute("CREATE TABLE IF NOT EXISTS dave_visibility (id TEXT PRIMARY KEY, visible INTEGER NOT NULL)")

    def require(self, condition, message, status=400):
        if not condition:
            raise self.error(message, status)

    def request(self, method, path, data=None, retry=True):
        if self.cookie is None and path != "/api/auth/login":
            self.request("POST", "/api/auth/login", {k: self.config[k] for k in ("username", "password")})
        connection = http.client.HTTPConnection("127.0.0.1", self.endpoint.port, timeout=8)
        headers = {"Content-Type": "application/json"} if data is not None else {}
        if self.cookie:
            headers["Cookie"] = self.cookie
        try:
            connection.request(method, path, json.dumps(data).encode() if data is not None else None, headers)
            response = connection.getresponse()
            body = response.read(4 * 1024 * 1024 + 1)
            self.require(len(body) <= 4 * 1024 * 1024, "Planner response is too large", 502)
            value = json.loads(body) if body else None
            if response.status == 401 and retry and path != "/api/auth/login" and value == {"error": "Not authenticated", "statusCode": 401}:
                self.cookie = None
                return self.request(method, path, data, retry=False)
            if response.status >= 400:
                status = 409 if response.status in (409, 412) else response.status
                message = value.get("error", "Planner request failed") if isinstance(value, dict) else "Planner request failed"
                if response.status >= 500 or path == "/api/auth/login":
                    message, status = "Shared planner temporarily unavailable", 503
                raise self.error(message, status)
            if path == "/api/auth/login":
                cookies = SimpleCookie(response.getheader("Set-Cookie", ""))
                self.require("dave_session" in cookies, "Shared planner login failed", 503)
                self.cookie = "dave_session=" + cookies["dave_session"].value
            return value
        except (OSError, http.client.HTTPException, ValueError) as error:
            raise self.error("Shared planner temporarily unavailable", 503) from error
        finally:
            connection.close()

    def ensure_collection(self):
        calendars = self.request("GET", "/api/calendars")
        self.require(any(c["id"] == self.default_id for c in calendars), "Shared planner default calendar is missing", 503)

    def base_record(self, kind, record_id, title, version):
        return {"schema": 1, "id": record_id, "kind": kind, "title": title,
                "body": "", "zone": self.zone, "done": False, "priority": 0,
                "labels": [], "project_id": None, "parent_id": None, "recurrence": None,
                "revision": 0, "history": [], "completion_count": 0,
                "recurrence_completed": 0, "version": version}

    def project_id(self, calendar):
        return identity("calendar:" + calendar["url"])

    def project(self, calendar):
        record_id = self.project_id(calendar)
        row = self.db.execute("SELECT visible FROM dave_visibility WHERE id=?", (record_id,)).fetchone()
        visible = bool(row[0]) if row else True
        settings = {k: calendar.get(k) for k in ("id", "displayName", "description", "color", "components")}
        version = hashlib.sha256(json.dumps([settings, visible], sort_keys=True).encode()).hexdigest()
        record = self.base_record("project", record_id, calendar["displayName"], version)
        record.update(color=(calendar.get("color") or "#8aa7ff")[:7], visible_on_screen=visible)
        self.sources[record_id] = ("project", calendar)
        return record

    def task(self, task):
        data = task["data"]
        record_id = identity(task["uid"])
        record = self.base_record("task", record_id, data["summary"], task["etag"])
        record.update(body=data.get("description", ""), due=data.get("due"),
                      done=data.get("status") in ("COMPLETED", "CANCELLED"),
                      priority=data.get("priority") or 0, labels=data.get("categories", []),
                      completed_at=data.get("completed"), recurrence_rule=data.get("rrule"))
        calendar = next((c for c in self.calendars if c["url"] == task["collectionUrl"]), None)
        if calendar and calendar["id"] != self.default_id:
            record["project_id"] = self.project_id(calendar)
        parent = next((r["relatedUid"] for r in data.get("relations", []) if r["reltype"] == "PARENT"), None)
        record["parent_id"] = identity(parent) if parent else None
        self.sources[record_id] = ("task", task)
        return record

    def event(self, event):
        data = event["data"]
        record_id = identity(event["id"] + (":" + data["recurrenceId"] if data.get("recurrenceId") else ""))
        record = self.base_record("event", record_id, data["summary"], event["etag"])
        record.update(body=data.get("description", ""), starts=data["start"], ends=data.get("end") if data.get("end") != data["start"] else None,
                      zone=data.get("tzid") or self.zone)
        self.sources[record_id] = ("event", event)
        return record

    def listing(self, fresh=False):
        if self.result is not None and not fresh and time.monotonic() - self.cached_at < 3:
            return copy.deepcopy(self.result)
        self.calendars = self.request("GET", "/api/calendars")
        if not self.synced or fresh:
            self.request("POST", "/api/sync/tasks", {})
            self.synced = True
        self.sources = {}
        projects = [self.project(c) for c in self.calendars if "VTODO" in c["components"] and c["id"] != self.default_id]
        tasks = self.request("GET", "/api/tasks")["tasks"]
        records = [self.task(t) for t in tasks if not t["data"].get("recurringInstance")]
        now = datetime.now(timezone.utc)
        # DAVe expands recurring events. Keep the faceplate/MCP projection bounded;
        # the full calendar and archived task search remain available in DAVe.
        window = urlencode({"start": (now - timedelta(days=366)).isoformat(),
                            "end": (now + timedelta(days=730)).isoformat()})
        for calendar in self.calendars:
            if "VEVENT" in calendar["components"]:
                events = self.request("GET", "/api/calendars/" + quote(calendar["id"], safe="") + "/events?" + window)
                records.extend(self.event(e) for e in events)
        self.result = {"records": records, "projects": projects, "status": "ok"}
        self.cached_at = time.monotonic()
        return copy.deepcopy(self.result)

    def get(self, record_id):
        self.listing()
        source = self.sources.get(record_id)
        self.require(source, "Record not found", 404)
        kind, raw = source
        if kind == "task":
            return self.task(self.request("GET", "/api/tasks/" + quote(raw["uid"], safe="")))
        return self.project(raw) if kind == "project" else self.event(raw)

    def collection(self, project_id=None, component="VTODO"):
        calendar = next((c for c in self.calendars if
                         (self.project_id(c) == project_id if project_id else c["id"] == self.default_id)), None)
        self.require(calendar and component in calendar["components"], "Choose a compatible planner collection")
        return calendar

    def recurrence(self, rule, zone):
        if not rule:
            return ""
        self.require(rule.get("mode", "due") == "due", "The shared DAVe planner uses scheduled recurrence; completion-relative recurrence is unsupported")
        fields = ["FREQ=" + rule["frequency"].upper(), "INTERVAL=" + str(rule.get("interval", 1))]
        if rule.get("weekdays"):
            fields.append("BYDAY=" + ",".join(rule["weekdays"]))
        if rule.get("count"):
            fields.append("COUNT=" + str(rule["count"]))
        if rule.get("until"):
            value = rule["until"]
            if len(value) == 10:
                value = value.replace("-", "")
            else:
                from zoneinfo import ZoneInfo
                value = datetime.fromisoformat(value.replace("Z", "+00:00"))
                value = value.replace(tzinfo=ZoneInfo(zone)) if value.tzinfo is None else value
                value = value.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            fields.append("UNTIL=" + value)
        return ";".join(fields)

    def mutate(self, action, args, key):
        self.require(isinstance(key, str) and 0 < len(key) <= 200, "An idempotency key is required")
        signature = hashlib.sha256(json.dumps([action, args], sort_keys=True).encode()).hexdigest()
        receipt = self.db.execute("SELECT signature,result FROM dave_operations WHERE key=?", (key,)).fetchone()
        if receipt:
            self.require(receipt[0] == signature, "Idempotency key already used with different input", 409)
            self.require(receipt[1] is not None, "Previous operation may have succeeded. Reload before making another change.", 409)
            return json.loads(receipt[1])
        self.listing(True)
        old = self.get(args["id"]) if args.get("id") else None
        source = self.sources.get(args.get("id"))
        # Reuse the faceplate's field, relation, ETag and project validation.
        # Completion itself is delegated to DAVe below, including RRULE handling.
        record, _ = self.legacy.prepare(action, args, key)
        kind = record["kind"]
        completing = action == "complete" or (action == "save" and args.get("done") is True)
        raw = source[1] if source else None
        payload = None
        if action == "delete":
            if kind == "project":
                path = "/api/calendars/" + quote(raw["id"], safe="")
                # Calendar deletion also removes events/notes: require it to be
                # empty, even though the faceplate's project editor lists tasks.
                self.require(not any(r.get("project_id") == record["id"] for r in self.result["records"]), "Move tasks before deleting this project")
                self.require(raw["components"] == ["VTODO"], "Delete mixed calendars from DAVe after reviewing their contents")
                home = self.config["url"].rstrip("/").rsplit("/", 1)[0] + "/"
                self.require(raw["url"].startswith(home), "Project is outside this planner account")
                storage = self.storage_type({**self.config, "url": raw["url"]})
                contents, _ = storage.request("PROPFIND", headers={"Depth": "1"})
                self.require(len(ET.fromstring(contents).findall("{DAV:}response")) == 1,
                             "This project still contains archived items; review them in DAVe before deleting it")
            elif kind == "task":
                path = "/api/tasks/" + quote(raw["uid"], safe="") + "?" + urlencode({"etag": old["version"]})
            else:
                path = "/api/events/" + quote(raw["id"], safe="") + "?" + urlencode({"etag": old["version"], "calendarId": raw["calendarId"],
                    **({"scope": "this", "recurrenceId": raw["data"]["recurrenceId"], "allDay": str(raw["data"]["allDay"]).lower()} if raw["data"].get("recurrenceId") else {})})
            method = "DELETE"
        elif kind == "project":
            method = "PATCH" if raw else "POST"
            path = "/api/calendars" + ("/" + quote(raw["id"], safe="") if raw else "")
            payload = {"displayName": record["title"], "color": record["color"]}
            if not raw:
                payload["components"] = ["VTODO"]
        elif kind == "task":
            calendar = self.collection(record.get("project_id"))
            data = copy.deepcopy(raw["data"]) if raw else {"uid": record["id"], "dtstart": None, "completed": None, "alarms": [], "rrule": None}
            data.update(summary=record["title"], description=record["body"], priority=record["priority"],
                        categories=record["labels"], collectionUrl=calendar["url"], due=record.get("due"),
                        relations=[r for r in data.get("relations", []) if r["reltype"] != "PARENT"])
            if record.get("parent_id"):
                data["relations"].append({"reltype": "PARENT", "relatedUid": self.sources[record["parent_id"]][1]["uid"]})
            if "recurrence" in args:
                data["rrule"] = self.recurrence(record["recurrence"], record["zone"])
                if data["rrule"]:
                    data["dtstart"] = record["due"]
            if completing or not raw or "done" in args:
                data.update(status="COMPLETED" if completing else "NEEDS-ACTION", percentComplete=100 if completing else 0, completed=None)
            method = "PUT" if raw else "POST"
            path = "/api/tasks" + ("/" + quote(raw["uid"], safe="") if raw else "")
            payload = {"data": data, **({"etag": old["version"]} if raw else {})}
        else:
            calendar = self.collection(component="VEVENT") if not raw else None
            data = copy.deepcopy(raw["data"]) if raw else {"uid": record["id"], "calendarId": calendar["id"], "location": "", "recurrenceRule": None, "recurrenceId": None, "alarms": [], "attendees": [], "color": None}
            all_day = len(record["starts"]) == 10
            end = record.get("ends") or (raw["data"].get("end") if raw else None) or (datetime.fromisoformat(record["starts"]) + (timedelta(days=1) if all_day else timedelta(hours=1))).isoformat()
            if all_day:
                end = end[:10]
            data.update(summary=record["title"], description=record["body"], start=record["starts"], end=end, allDay=all_day, tzid=None if all_day else record["zone"])
            method = "PUT" if raw else "POST"
            path = "/api/events/" + quote(raw["id"], safe="") if raw else "/api/calendars/" + quote(calendar["id"], safe="") + "/events"
            payload = {"data": data, **({"etag": old["version"], "scope": "this" if data.get("recurrenceId") else "all"} if raw else {})}
        # A receipt is durable before sending a write. Ambiguous failures must
        # never replay a recurring completion or a partially completed move.
        with self.db:
            self.db.execute("INSERT INTO dave_operations VALUES(?,?,NULL)", (key, signature))
        response = self.request(method, path, payload)
        self.cached_at = 0
        if action == "delete":
            result = {**record, "deleted": True}
        elif kind == "task":
            result = self.task(response)
        elif kind == "event":
            result = self.event(response)
        else:
            # DAVe returns the complete calendar list; a new calendar is the one
            # absent from our pre-write catalog, irrespective of duplicate names.
            known = {c["id"] for c in self.calendars}
            calendar = next(c for c in response if c["id"] == raw["id"]) if raw else next(c for c in response if c["id"] not in known)
            with self.db:
                self.db.execute("INSERT OR REPLACE INTO dave_visibility VALUES(?,?)", (self.project_id(calendar), int(record.get("visible_on_screen", True))))
            result = self.project(calendar)
        with self.db:
            self.db.execute("UPDATE dave_operations SET result=? WHERE key=?", (json.dumps(result), key))
        return result

    def call(self, request):
        with self.lock:
            self.require(isinstance(request, dict) and isinstance(request.get("args", {}), dict), "Expected a request object")
            action, args = request.get("action"), request.get("args", {})
            if action == "list":
                return self.listing(bool(args.get("fresh")))
            if action == "get":
                return self.get(args.get("id"))
            return self.mutate(action, args, request.get("key"))
