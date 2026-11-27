import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from sm_manager.artifacts import ArtifactError, Conflict, Library, NotFound
from sm_manager.server import handler_for


def payload(body=b"<h1>Diagram</h1>", **extra):
    return {"title": "Architecture", "project": "Example", "entrypoint": "index.html", "files": [
        {"path": "index.html", "base64": base64.b64encode(body).decode()},
        {"path": "source/notes.md", "role": "source", "base64": base64.b64encode(b"Private editable source").decode()},
    ], **extra}


class ArtifactsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.library = Library({"data_dir": self.tmp.name, "publish_url": "https://artifacts.example.test"})

    def test_revisions_survive_checkout_removal_and_stale_edits_conflict(self):
        one = self.library.save(payload())
        work = self.library.checkout(one["id"])
        self.assertEqual(Path(work["directory"], "index.html").read_bytes(), b"<h1>Diagram</h1>")
        two = self.library.save(payload(b"<h1>Improved</h1>", base_revision=1), one["id"])
        self.assertEqual(two["id"], one["id"])
        self.assertEqual(two["revision"], 2)
        self.assertEqual(self.library.file(one["id"], 1, "index.html")[1], b"<h1>Diagram</h1>")
        with self.assertRaises(Conflict):
            self.library.save(payload(base_revision=1), one["id"])
        restored = self.library.restore(one["id"], 1, 2)
        self.assertEqual(restored["revision"], 3)
        self.assertEqual(self.library.file(one["id"], 3, "index.html")[1], b"<h1>Diagram</h1>")

    def test_two_agents_cannot_silently_overwrite_each_other(self):
        item = self.library.save(payload())
        def edit(_):
            try:
                return self.library.save(payload(base_revision=1), item["id"])["revision"]
            except Conflict:
                return "conflict"
        with ThreadPoolExecutor(max_workers=2) as workers:
            result = list(workers.map(edit, range(2)))
        self.assertCountEqual(result, [2, "conflict"])

    def test_publishing_is_explicit_and_source_is_excluded(self):
        item = self.library.save(payload())
        self.library._remote = Mock(return_value={"published": True})
        shared = self.library.publish(item["id"], 1)
        sent = self.library._remote.call_args.args[2]
        self.assertEqual([f["path"] for f in sent["files"]], ["index.html"])
        edited = self.library.save(payload(b"New", base_revision=1), item["id"])
        self.assertEqual(edited["published_revision"], 1)
        self.assertEqual(edited["share_url"], shared["share_url"])
        with self.assertRaises(Conflict):
            self.library.publish(item["id"], 1)
        republished = self.library.publish(item["id"], 2)
        self.assertEqual(republished["share_url"], shared["share_url"])
        revoked = self.library.unpublish(item["id"])
        self.assertIsNone(revoked["share_url"])
        self.assertIsNone(revoked["published_revision"])

    def test_lost_publish_response_keeps_the_same_recoverable_identity(self):
        item = self.library.save(payload())
        def interrupted(method, path, *args, **kwargs):
            if path.startswith("/admin/shares/"):
                raise ArtifactError("Network interrupted")
            return {}
        self.library._remote = Mock(side_effect=interrupted)
        with self.assertRaises(ArtifactError):
            self.library.publish(item["id"], 1)
        attempted = self.library._remote.call_args.args[1]
        self.library._remote = Mock(return_value={})
        shared = self.library.publish(item["id"], 1)
        self.assertEqual(self.library._remote.call_args.args[1], attempted)
        self.assertTrue(shared["share_url"].endswith(attempted.rsplit("/", 1)[-1] + "/"))

    def test_invalid_paths_duplicate_files_and_missing_entrypoint_are_rejected(self):
        for path in ("../secret", "/etc/passwd", "source/../../secret", "x\\y", "a//b", "a/%2e%2e/b"):
            data = payload()
            data["files"][0]["path"] = path
            with self.subTest(path=path), self.assertRaises(ArtifactError):
                self.library.save(data)
        data = payload()
        data["files"].append(data["files"][0])
        with self.assertRaises(ArtifactError):
            self.library.save(data)
        with self.assertRaises(ArtifactError):
            self.library.save(payload(entrypoint="source/notes.md"))
        item = self.library.save(payload())
        with self.assertRaises(NotFound):
            self.library.file(item["id"], 1, "unlisted.html")

    def test_organization_does_not_change_identity_or_file_history(self):
        item = self.library.save(payload())
        changed = self.library.metadata(item["id"], {"title": "New title", "project": "Other project", "folder": "Diagrams"})
        self.assertEqual(changed["id"], item["id"])
        self.assertEqual(changed["revision"], 1)
        self.assertEqual(self.library.list("Other project")[0]["id"], item["id"])


class ArtifactHttpTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        config_path = Path(self.tmp.name) / "config.json"
        config_path.write_text(json.dumps({"data_dir": str(Path(self.tmp.name) / "data")}))
        config = {"port": 0, "allowed_hosts": ["127.0.0.1"], "artifacts_config_path": str(config_path)}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), handler_for(None, config, github=Mock()))
        config["port"] = self.server.server_port
        thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(self.server.server_close)
        self.addCleanup(self.server.shutdown)
        self.base = f"http://127.0.0.1:{self.server.server_port}"

    def test_owner_session_required_and_html_preview_is_sandboxed(self):
        with urlopen(self.base + "/api/artifacts") as response:
            token = json.load(response)["token"]
        request = Request(self.base + "/api/artifacts", data=json.dumps(payload()).encode(), headers={"Content-Type": "application/json"})
        with self.assertRaises(HTTPError) as refused:
            urlopen(request)
        self.assertEqual(refused.exception.code, 403)
        request.add_header("X-ST-Artifacts-Token", token)
        with urlopen(request) as response:
            item = json.load(response)
        path = f"/api/artifacts/{item['id']}/revisions/1/files/"
        with urlopen(self.base + path + "index.html") as response:
            policy = response.headers["Content-Security-Policy"]
            self.assertIn("sandbox allow-scripts", policy)
            self.assertNotIn("allow-same-origin", policy)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        with urlopen(self.base + path + "source/notes.md") as response:
            self.assertEqual(response.headers["Content-Disposition"], "attachment")
        request = Request(self.base + "/api/artifacts", headers={"Sec-Fetch-Site": "cross-site"})
        with self.assertRaises(HTTPError) as refused:
            urlopen(request)
        self.assertEqual(refused.exception.code, 403)


if __name__ == "__main__":
    unittest.main()
