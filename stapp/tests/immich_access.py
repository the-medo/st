"""Access policy checks; never contact Google or a real Immich instance."""

import importlib.util
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy/immich"))
spec = importlib.util.spec_from_file_location("configure_access", ROOT / "deploy/immich/configure-access.py")
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)


class Access(unittest.TestCase):
    def test_registration_stays_closed_and_google_needs_credentials(self):
        prepared = access.oauth_settings({"enabled": False, "autoRegister": True}, "https://photos.example")
        self.assertFalse(prepared["autoRegister"])
        self.assertFalse(prepared["enabled"])
        configured = access.oauth_settings(prepared, "https://photos.example", ("client", "secret"))
        self.assertTrue(configured["enabled"])
        self.assertFalse(configured["autoRegister"])
        self.assertFalse(configured["autoLaunch"])
        self.assertEqual(configured["mobileRedirectUri"], "https://photos.example/api/oauth/mobile-redirect")
        self.assertEqual(configured["scope"], "openid email profile")

    def test_existing_non_allowed_users_are_not_silently_preserved_or_deleted(self):
        allowed = access.allowed_emails(["Owner@Example.com", "partner@example.com"])
        access.validate_users([{"email": "owner@example.com"}], allowed)
        with self.assertRaisesRegex(ValueError, "outside the requested allowlist"):
            access.validate_users([{"email": "third@example.com"}], allowed)

    def test_mobile_and_web_redirects_required_before_enabling(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "client.json"
            web = {"client_id": "test.apps.googleusercontent.com", "client_secret": "private-test",
                   "redirect_uris": ["https://photos.example/auth/login", "https://photos.example/user-settings"]}
            path.write_text(json.dumps({"web": web}))
            with self.assertRaisesRegex(ValueError, "three documented"):
                access.google_credentials(path, "https://photos.example")
            web["redirect_uris"].append("https://photos.example/api/oauth/mobile-redirect")
            path.write_text(json.dumps({"web": web}))
            self.assertEqual(access.google_credentials(path, "https://photos.example")[0], web["client_id"])


if __name__ == "__main__":
    unittest.main()
