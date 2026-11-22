#!/usr/bin/env python3
"""Set the canonical HTTPS origin and restrict Google sign-in to provisioned users."""

import argparse
import datetime
import json
import os
from pathlib import Path
import secrets
import sys
import urllib.error
import urllib.parse
import urllib.request

from manage import CONFIG, private_json


def origin(value):
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
            or parsed.path not in {"", "/"} or parsed.query or parsed.fragment):
        raise ValueError("Use an HTTPS origin without a path, query or credentials")
    return value.rstrip("/")


def allowed_emails(values):
    emails = {email.strip().lower() for email in values}
    if not emails or any(email.count("@") != 1 or any(c.isspace() for c in email) for email in emails):
        raise ValueError("Specify the exact allowed email addresses")
    return emails


def validate_users(users, allowed):
    extra = [user["email"] for user in users if user["email"].lower() not in allowed]
    if extra:
        raise ValueError("Existing users are outside the requested allowlist; review them in Administration before continuing")


def google_credentials(path, url):
    config = json.loads(Path(path).read_text())
    web = config.get("web", {})
    expected = {url + suffix for suffix in ["/auth/login", "/user-settings", "/api/oauth/mobile-redirect"]}
    if not expected.issubset(set(web.get("redirect_uris", []))):
        raise ValueError("Google web client must include all three documented redirect URIs")
    if not web.get("client_id", "").endswith(".apps.googleusercontent.com") or not web.get("client_secret"):
        raise ValueError("Expected a downloaded Google Web application client JSON")
    return web["client_id"], web["client_secret"]


def oauth_settings(current, url, credentials=None):
    settings = dict(current, autoRegister=False, autoLaunch=False,
                    issuerUrl="https://accounts.google.com", scope="openid email profile",
                    signingAlgorithm="RS256", buttonText="Sign in with Google", prompt="select_account",
                    mobileOverrideEnabled=True, mobileRedirectUri=url + "/api/oauth/mobile-redirect",
                    allowInsecureRequests=False)
    if credentials:
        settings.update(clientId=credentials[0], clientSecret=credentials[1], enabled=True)
    elif not settings.get("enabled"):
        settings["enabled"] = False
    elif current.get("issuerUrl") != "https://accounts.google.com":
        raise ValueError("Existing OAuth provider is not Google; supply a Google client explicitly")
    return settings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", required=True)
    parser.add_argument("--allow-email", action="append", required=True)
    parser.add_argument("--google-client", help="Downloaded Google Web application JSON; omit to prepare access before enabling Google")
    parser.add_argument("--admin-login", type=Path, default=CONFIG.with_name("immich-initial-login.json"),
                        help="Private JSON containing the current admin email/password")
    args = parser.parse_args()
    os.umask(0o077)
    url = origin(args.url)
    allowed = allowed_emails(args.allow_email)
    credentials = google_credentials(args.google_client, url) if args.google_client else None
    deployment = json.loads(CONFIG.read_text())
    base = f"http://127.0.0.1:{deployment['port']}/api"
    if args.admin_login.stat().st_mode & 0o077:
        raise ValueError("Admin login file must be private (chmod 600)")
    login = json.loads(args.admin_login.read_text())
    if login["email"].lower() not in allowed:
        raise ValueError("The current admin must be included in the allowlist")
    token = None

    def request(path, body=None, method=None):
        headers = {"Content-Type": "application/json"}
        if token:
            headers["Authorization"] = "Bearer " + token
        req = urllib.request.Request(base + path, headers=headers, method=method,
                                     data=None if body is None else json.dumps(body).encode())
        try:
            with urllib.request.urlopen(req, timeout=30) as response:
                data = response.read()
                return json.loads(data) if data else None
        except urllib.error.HTTPError as exc:
            code = exc.code
            exc.close()
            raise ValueError(f"Immich returned HTTP {code}; check the current admin credentials/configuration") from None

    token = request("/auth/login", {key: login[key] for key in ["email", "password"]})["accessToken"]
    try:
        users = request("/admin/users")
        validate_users(users, allowed)
        settings = request("/system-config")
        backup = CONFIG.parent / ("immich-access-before-" + datetime.datetime.now().strftime("%Y%m%dT%H%M%S%f") + ".json")
        private_json(backup, settings)
        # Disable automatic registration before adding users, regardless of Google readiness.
        settings["oauth"] = oauth_settings(settings["oauth"], url, credentials)
        settings["server"]["externalDomain"] = url
        request("/system-config", settings, "PUT")
        created_path = CONFIG.with_name("immich-created-users.json")
        created = json.loads(created_path.read_text()) if created_path.exists() else {}
        for email in sorted(allowed - {user["email"].lower() for user in users}):
            password = secrets.token_urlsafe(32)
            created[email] = {"email": email, "password": password}
            private_json(created_path, created)
            request("/admin/users", {"email": email, "name": email.split("@")[0], "password": password,
                                     "isAdmin": False, "shouldChangePassword": False, "notify": False})
        validate_users(request("/admin/users"), allowed)
        actual = request("/system-config")
        if actual["oauth"]["autoRegister"] or actual["server"]["externalDomain"] != url:
            raise RuntimeError("Immich did not retain the requested access settings")
        for path in [CONFIG, CONFIG.with_name("immich.json")]:
            value = json.loads(path.read_text())
            value["url"] = url
            private_json(path, value)
        private_json(CONFIG.with_name("immich-access.json"), {"url": url, "allowed_emails": sorted(allowed),
                                                             "google_enabled": actual["oauth"]["enabled"]})
        print(json.dumps({"url": url, "allowed_users": len(allowed), "auto_register": False,
                          "google_enabled": actual["oauth"]["enabled"], "password_login": actual["passwordLogin"]["enabled"]}))
    finally:
        request("/auth/logout", {})


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError) as error:
        sys.exit(str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError)
                 else "Cannot read the private configuration or apply Immich access settings")
