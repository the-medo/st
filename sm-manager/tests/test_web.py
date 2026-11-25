import json
from pathlib import Path
import tempfile
import unittest

from sm_manager.home import ui_config
from sm_manager.web import asset


class ConsoleAssetsTests(unittest.TestCase):
    def test_only_manifest_assets_and_known_pages_are_served(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.vite').mkdir()
            (root / 'assets').mkdir()
            (root / '.vite/manifest.json').write_text(json.dumps({'main': {'file': 'assets/main-hash.js', 'css': ['assets/main-hash.css']}}))
            for name in ['index.html', 'assets/main-hash.js', 'assets/main-hash.css', 'private.json']:
                (root / name).write_text('fixture')
            self.assertEqual(asset('/overview', root)[0].name, 'index.html')
            self.assertEqual(asset('/github', root)[0].name, 'index.html')
            self.assertIsNone(asset('/codex', root))
            self.assertEqual(asset('/ovis/chat/fixture', root)[1], 'no-store')
            self.assertIn('immutable', asset('/assets/main-hash.js', root)[1])
            for path in ['/private.json', '/assets/missing.js', '/api/missing', '/.vite/manifest.json', '/../private.json', '/assets/../../private.json']:
                self.assertIsNone(asset(path, root), path)
            (root / 'assets/main-hash.js').unlink()
            (root / 'assets/main-hash.js').symlink_to('/etc/passwd')
            self.assertIsNone(asset('/assets/main-hash.js', root))

    def test_ui_configuration_does_not_expose_private_settings(self):
        value = ui_config({'secret': 'DO_NOT_EXPOSE', 'dave_credentials_path': '/private/login', 'printer_url': 'javascript:bad', 'home_links': [{'name':'Books', 'url':'https://books.example.test'}]})
        self.assertEqual(set(value), {'services', 'planner', 'ovis', 'printer_url'})
        self.assertIsNone(value['printer_url'])
        self.assertEqual(value['services'][0]['name'], 'Books')
        self.assertNotIn('DO_NOT_EXPOSE', json.dumps(value))
