#!/usr/bin/env python3
"""Initialize a new private Immich instance and give S.T. a read-only API key."""

import argparse
import json
import os
from pathlib import Path
import secrets
import urllib.request

from manage import CONFIG, private_json


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", required=True)
    parser.add_argument("--name", default="Owner")
    args = parser.parse_args()
    os.umask(0o077)
    deployment = json.loads(CONFIG.read_text())
    base = f"http://127.0.0.1:{deployment['port']}/api"
    config = CONFIG.with_name("immich.json")
    credentials = CONFIG.with_name("immich-initial-login.json")
    if config.exists():
        raise SystemExit("S.T. already has an Immich configuration; refusing to replace its key")

    def request(path, body=None, token=None, method=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(base + path, headers=headers, method=method,
                                     data=None if body is None else json.dumps(body).encode())
        with urllib.request.urlopen(req, timeout=20) as response:
            return json.load(response)

    if not credentials.exists():
        initial = {"email": args.email, "name": args.name, "password": secrets.token_urlsafe(24)}
        private_json(credentials, initial)
        request("/auth/admin-sign-up", initial)
    initial = json.loads(credentials.read_text())
    session = request("/auth/login", {k: initial[k] for k in ["email", "password"]})["accessToken"]
    key = request("/api-keys", {"name": "S.T. read-only photos",
                              "permissions": ["asset.read", "asset.view", "album.read", "user.read"]}, session)
    private_json(config, {"api_url": base, "url": deployment["url"], "api_key": key["secret"]})
    settings = request("/system-config", token=session)
    settings["server"]["externalDomain"] = deployment["url"]
    request("/system-config", settings, session, "PUT")
    request("/auth/logout", {}, session)
    print(f"Created admin and read-only S.T. connection. Initial login: {credentials}")
    print("Change the initial password in Immich, then remove the initial-login file.")


if __name__ == "__main__":
    main()
