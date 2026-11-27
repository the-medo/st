import base64
from concurrent.futures import ThreadPoolExecutor
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import shutil
import threading
import unittest
import sqlite3
import subprocess
import sys
import os
from sm_manager.artifact_context import Projects, ContextError
from unittest.mock import Mock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from sm_manager.artifacts import ArtifactError, Conflict, Library, NotFound
from sm_manager.server import handler_for


def payload(body=b"<h1>Diagram</h1>", **extra):
    return {"title": "Architecture", "project": "Example", "entrypoint": "index.html", "files": [
        {"path": "index.html", "base64": base64.b64encode(body).decode()},
        {"path": "source/notes.md", "role": "source", "base64": base64.b64encode(b"Private editable source").decode()},
    ], **extra}


def project_settings(root):
    sidebar = Path(root) / "agents"
    sidebar.mkdir()
    (sidebar / "projects.json").write_text(json.dumps({"projects": [
        {"id":"example", "name":"Example", "path":str(Path(root)/"repo"), "appearance":{"iconText":"EX","titleColor":"#abcdef"}},
        {"id":"other", "name":"Other project", "path":str(Path(root)/"other")},
        {"id":"st", "name":"S. T.", "path":str(Path(root)/"st")},
    ]}))
    return {"agents_data_dir":str(sidebar), "codex_home":str(Path(root)/"codex")}


class ArtifactsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.library = Library({"data_dir": self.tmp.name, "publish_url": "https://artifacts.example.test", **project_settings(self.tmp.name)})

    def test_projects_are_canonical_and_follow_agents_appearance(self):
        one = self.library.save(payload(project="s.t.", folder="Ignored folder"))
        two = self.library.save(payload(project="ST"))
        self.assertEqual(one["project"], "st")
        self.assertEqual(two["project"], "st")
        self.assertNotIn("folder", one)
        with self.assertRaises(ContextError):
            self.library.save(payload(project="Invented project"))
        self.assertEqual(self.library.save(payload(project=""))["project"], "")
        root = Path(self.library.settings["agents_data_dir"])
        (root/"appearance.json").write_text(json.dumps({"example":{"iconText":"NEW", "borderColor":"#123456"}}))
        (root/"organization.json").write_text(json.dumps({"projectOrder":["st","example"],"projects":{}}))
        projects = Projects(self.library.settings).items
        self.assertEqual([p["id"] for p in projects], ["st","example","other"])
        self.assertEqual(projects[1]["appearance"], {"iconText":"NEW","titleColor":"#abcdef","borderColor":"#123456"})

    def test_legacy_project_names_migrate_without_changing_identity_or_history(self):
        item = self.library.save(payload())
        with self.library.connect() as db:
            db.execute("UPDATE artifacts SET project='S.T.',project_id=NULL,folder='Old folder' WHERE id=?", (item["id"],))
        migrated = Library(self.library.settings).get(item["id"])
        self.assertEqual(migrated["project"], "st")
        self.assertEqual(migrated["revision"], 1)
        self.assertEqual(migrated["manifest"],item["manifest"])
        self.assertNotIn("folder",migrated)
        with self.library.connect() as db:
            self.assertEqual(db.execute("SELECT project,folder FROM artifacts WHERE id=?", (item["id"],)).fetchone()[0], "S.T.")

    def test_original_conversation_survives_edits_restores_and_organization(self):
        thread = "00000000-0000-4000-8000-000000000001"
        item = self.library.save(payload(source_chat=thread))
        self.library.save(payload(base_revision=1),item["id"])
        restored = self.library.restore(item["id"],1,2)
        self.assertEqual(restored["source_chat"],thread)
        self.assertEqual(self.library.metadata(item["id"],{"title":"Moved","project":"other"})["source_chat"],thread)
        with self.assertRaises(ArtifactError):
            self.library.save(payload(base_revision=3,source_chat="00000000-0000-4000-8000-000000000002"),item["id"])
        older = self.library.save(payload())
        linked = self.library.link_origin(older["id"],thread)
        self.assertEqual(linked["source_chat"],thread)
        self.assertEqual(linked["revision"],1)
        with self.assertRaises(Conflict):
            self.library.link_origin(older["id"],"00000000-0000-4000-8000-000000000002")

    def test_catalog_unavailable_does_not_unassign_stored_projects(self):
        item = self.library.save(payload())
        Path(self.library.settings["agents_data_dir"],"projects.json").unlink()
        offline = Library(self.library.settings)
        self.assertTrue(offline.projects.error)
        self.assertEqual(offline.get(item["id"])["project"],"example")
        update = payload(base_revision=1)
        del update["project"]
        self.assertEqual(offline.save(update,item["id"])["project"],"example")
        with self.assertRaises(ContextError):
            offline.save(payload())

    def test_cli_infers_registered_worktree_and_captures_original_conversation(self):
        root = Path(self.tmp.name)
        repo = root/"repo"
        subprocess.run(["git","init",str(repo)],check=True,capture_output=True)
        subprocess.run(["git","-C",str(repo),"-c","user.email=fixture@example.test","-c","user.name=Fixture","-c","core.hooksPath=/dev/null","-c","commit.gpgsign=false","commit","--allow-empty","-m","Fixture"],check=True,capture_output=True)
        worktree = root/"linked-checkout"
        subprocess.run(["git","-C",str(repo),"worktree","add","--detach",str(worktree)],check=True,capture_output=True)
        self.assertEqual(self.library.projects.infer(worktree),"example")
        thread = "00000000-0000-4000-8000-000000000001"
        codex = root/"codex"; codex.mkdir()
        with sqlite3.connect(codex/"state_5.sqlite") as db:
            db.execute("CREATE TABLE threads(id TEXT PRIMARY KEY,cwd TEXT,project_id TEXT)")
            db.execute("INSERT INTO threads VALUES(?,?,?)", (thread,str(worktree),"example"))
        # The command can run from an output directory; the creating chat owns
        # the project, and its metadata is read without touching its history.
        cfg = root/"config.json";cfg.write_text(json.dumps(self.library.settings))
        output = root/"diagram.html";output.write_text("<h1>Fixture</h1>")
        cli = Path(__file__).resolve().parents[1]/"scripts/artifacts.py"
        run = subprocess.run([sys.executable,str(cli),"--config",str(cfg),"create",str(output),"--title","Fixture"],cwd=root,capture_output=True,text=True,env={**os.environ,"CODEX_THREAD_ID":thread})
        self.assertEqual(run.returncode,0,run.stderr)
        item = json.loads(run.stdout)
        self.assertEqual(item["source_chat"],thread)
        self.assertEqual(item["project"],"example")
        checked = self.library.checkout(item["id"])
        saved = subprocess.run([sys.executable,str(cli),"--config",str(cfg),"save",checked["directory"]],cwd=root,capture_output=True,text=True,env={**os.environ,"CODEX_THREAD_ID":"00000000-0000-4000-8000-000000000002"})
        self.assertEqual(saved.returncode,0,saved.stderr)
        self.assertEqual(json.loads(saved.stdout)["source_chat"],thread)

    def test_diagram_editor_survives_revisions_checkout_and_restore_with_private_source(self):
        editor = {"type": "excalidraw", "source": "source/diagram.excalidraw"}
        data = {"title": "Flow", "entrypoint": "diagram.svg", "editor": editor, "files": [
            {"path": "diagram.svg", "base64": base64.b64encode(b'<svg xmlns="http://www.w3.org/2000/svg"/>').decode()},
            {"path": editor["source"], "role": "source", "base64": base64.b64encode(b'{"type":"excalidraw","elements":[]}').decode()},
        ]}
        one = self.library.save(data)
        self.assertEqual(self.library.list()[0]["editor"], editor)
        work = self.library.checkout(one["id"])
        self.assertEqual(work["editor"], editor)
        self.assertEqual(json.loads(Path(work["directory"], ".artifact.json").read_text())["editor"], editor)
        update = {key: value for key, value in data.items() if key != "editor"}
        two = self.library.save({**update, "base_revision": 1}, one["id"])
        self.assertEqual(two["manifest"]["editor"], editor)
        with self.assertRaises(Conflict):
            self.library.save({**data, "base_revision": 1}, one["id"])
        self.library._remote = Mock(return_value={})
        self.library.publish(one["id"], 2)
        self.assertEqual([f["path"] for f in self.library._remote.call_args.args[2]["files"]], ["diagram.svg"])
        generic = self.library.save(payload(base_revision=2, editor=None), one["id"])
        self.assertNotIn("editor", generic["manifest"])
        restored = self.library.restore(one["id"], 1, 3)
        self.assertEqual(restored["manifest"]["editor"], editor)
        generic_restored = self.library.restore(one["id"], 3, 4)
        self.assertNotIn("editor", generic_restored["manifest"])
        for invalid in ({"type":"unknown", "source":editor["source"]}, {"type":"excalidraw", "source":"diagram.svg"}):
            with self.subTest(editor=invalid), self.assertRaises(ArtifactError):
                self.library.save({**data, "editor": invalid})
        data["files"][1]["role"] = "output"
        with self.assertRaises(ArtifactError):
            self.library.save(data)

    def test_revisions_survive_checkout_removal_and_stale_edits_conflict(self):
        one = self.library.save(payload())
        work = self.library.checkout(one["id"])
        self.assertEqual(Path(work["directory"], "index.html").read_bytes(), b"<h1>Diagram</h1>")
        shutil.rmtree(work["directory"])
        self.assertEqual(self.library.file(one["id"], 1, "index.html")[1], b"<h1>Diagram</h1>")
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
        uncertain = self.library.get(item["id"])
        self.assertTrue(uncertain["publication_pending"])
        self.assertIsNotNone(uncertain["share_url"])
        self.library._remote = Mock(return_value={})
        shared = self.library.publish(item["id"], 1)
        self.assertEqual(self.library._remote.call_args.args[1], attempted)
        self.assertFalse(shared["publication_pending"])
        self.assertTrue(shared["share_url"].endswith(attempted.rsplit("/", 1)[-1] + "/"))

    def test_slow_publication_allows_saves_and_revocation_is_ordered_after_it(self):
        item = self.library.save(payload())
        entered, release = threading.Event(), threading.Event()
        calls = []
        def remote(method, path, *args, **kwargs):
            calls.append((method, path))
            if path.startswith("/admin/objects/"):
                entered.set()
                if not release.wait(5):
                    raise RuntimeError("Test upload timed out")
            return {}
        self.library._remote = remote
        with ThreadPoolExecutor(max_workers=3) as pool:
            publishing = pool.submit(self.library.publish, item["id"], 1)
            self.assertTrue(entered.wait(2))
            try:
                edited = pool.submit(self.library.save, payload(base_revision=1), item["id"]).result(timeout=2)
                self.assertEqual(edited["revision"], 2)
                revoking = pool.submit(self.library.unpublish, item["id"])
            finally:
                release.set()
            publishing.result(timeout=3)
            revoked = revoking.result(timeout=3)
        self.assertIsNone(revoked["published_revision"])
        self.assertFalse(revoked["publication_pending"])
        self.assertEqual([call[0] for call in calls], ["PUT", "PUT", "DELETE"])

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
        config_path.write_text(json.dumps({"data_dir": str(Path(self.tmp.name) / "data"), **project_settings(self.tmp.name)}))
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
        refused.exception.close()
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
        preview = item["preview_base"]
        headers = {"Sec-Fetch-Site": "cross-site", "Origin": "null"}
        with urlopen(Request(self.base + preview + "index.html", headers=headers)) as response:
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "*")
        for invalid in (preview + "source/notes.md", preview.replace(item["id"], "a" * 32) + "index.html"):
            with self.assertRaises(HTTPError) as denied:
                urlopen(Request(self.base + invalid, headers=headers))
            self.assertIn(denied.exception.code, (403, 404))
            denied.exception.close()
        with patch("sm_manager.artifact_http.time.time", return_value=9999999999):
            with self.assertRaises(HTTPError) as denied:
                urlopen(Request(self.base + preview + "index.html", headers=headers))
            self.assertEqual(denied.exception.code, 403)
            denied.exception.close()
        request = Request(self.base + "/api/artifacts", headers={"Sec-Fetch-Site": "cross-site"})
        with self.assertRaises(HTTPError) as refused:
            urlopen(request)
        self.assertEqual(refused.exception.code, 403)
        refused.exception.close()


if __name__ == "__main__":
    unittest.main()
