"""Bounded, read-only Immich adapter. Credentials stay on the STapp host."""

import base64
import json
import os
from pathlib import Path
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid

MAX_BYTES = 5_000_000


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never forward a private API key to another endpoint.
        return None


class Photos:
    def __init__(self, config):
        self.url = config["api_url"].rstrip("/")
        self.public = config["url"].rstrip("/")
        self.key = config.get("api_key", "")
        if not isinstance(self.key, str) or any(ord(c) < 33 or ord(c) > 126 for c in self.key):
            raise ValueError("Invalid API key in private Immich configuration")
        for url in [self.url, self.public]:
            parsed = urllib.parse.urlsplit(url)
            if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
                raise ValueError("Invalid Immich URL in private configuration")
        self.opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def request(self, path, body=None, authenticated=True, binary=False):
        if authenticated and not self.key:
            raise ValueError("Create a read-only Immich API key and save it in the host photo configuration")
        headers = {"Accept": "application/json"}
        if authenticated:
            headers["x-api-key"] = self.key
        if body is not None:
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(self.url + path, headers=headers,
                                     data=None if body is None else json.dumps(body).encode())
        try:
            with self.opener.open(req, timeout=12) as response:
                data = response.read(MAX_BYTES + 1)
        except urllib.error.HTTPError as exc:
            code = exc.code
            exc.close()
            raise ValueError(f"Immich returned HTTP {code}; check availability and API key permissions") from None
        except TimeoutError:
            raise ValueError("Immich timed out; initial model loading/indexing may still be running. Retry shortly") from None
        except OSError:
            raise ValueError("Immich unavailable; check the backend and NAS connection") from None
        if len(data) > MAX_BYTES:
            raise ValueError("Immich response exceeds 5 MB")
        return data if binary else json.loads(data)

    def asset(self, item):
        asset_id = str(uuid.UUID(item["id"]))
        return {"id": asset_id, "name": item.get("originalFileName"),
                "type": item.get("type"), "taken": item.get("fileCreatedAt"),
                "url": f"{self.public}/photos/{asset_id}"}

    def call(self, action, args):
        if action == "photos_status":
            ping = self.request("/server/ping", authenticated=False)
            version = self.request("/server/version", authenticated=False)
            account = self.request("/users/me") if self.key else {}
            return {"online": ping.get("res") == "pong", "url": self.public,
                    "version": version, "library_connected": bool(account), "account": account.get("name")}
        if action == "photos_albums":
            albums = self.request("/albums")
            return [{"id": a["id"], "name": a["albumName"], "assets": a.get("assetCount"),
                     "url": f"{self.public}/albums/{a['id']}"} for a in albums]
        if action in {"photos_recent", "photos_search"}:
            limit = args.get("limit", 20)
            page = args.get("page", 1)
            if type(limit) is not int or not 1 <= limit <= 100 or type(page) is not int or not 1 <= page <= 10000:
                raise ValueError("limit must be 1–100 and page 1–10000")
            body = {"size": limit, "page": page, "visibility": "timeline", "withDeleted": False}
            path = "/search/metadata"
            if action == "photos_search":
                query = args.get("query", "")
                if not isinstance(query, str) or not query.strip() or len(query) > 500:
                    raise ValueError("Provide a search query of 1–500 characters")
                if args.get("semantic", False):
                    path = "/search/smart"
                    body["query"] = query
                else:
                    body["originalFileName"] = query
            else:
                body["order"] = "desc"
            found = self.request(path, body)["assets"]
            return {"items": [self.asset(a) for a in found["items"]],
                    "next_page": found.get("nextPage"), "total": found.get("total")}
        if action == "photos_show":
            asset_id = str(uuid.UUID(args["id"]))
            info = self.request(f"/assets/{asset_id}")
            if info.get("visibility") in {"locked", "hidden"} or info.get("isTrashed"):
                raise ValueError("Hidden, locked or trashed photos cannot be shown on the faceplate")
            data = self.request(f"/assets/{asset_id}/thumbnail?size=preview", binary=True)
            if not data.startswith(b"\xff\xd8\xff"):
                raise ValueError("Faceplate needs a JPEG preview; select JPEG in Immich preview settings")
            return {"id": asset_id, "data": base64.b64encode(data).decode()}
        raise ValueError("Unknown photo action")


def main():
    config = Path(os.environ.get("STAPP_PHOTOS_CONFIG", str(Path.home() / ".config/stapp/immich.json")))
    if not config.is_file():
        raise ValueError("Immich is not configured; see docs/immich.md")
    if config.stat().st_mode & 0o077:
        raise ValueError("Immich configuration must be private (chmod 600)")
    request = json.loads(sys.stdin.buffer.read(16385))
    print(json.dumps({"result": Photos(json.loads(config.read_text())).call(request["name"], request["args"])}))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, OSError):
        # Expected operational messages are safe; never serialize config or response bodies.
        error = sys.exc_info()[1]
        print(json.dumps({"error": str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
                          else "Invalid or unavailable Immich configuration/response"}))
