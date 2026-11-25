import json
import http.client
from http.server import ThreadingHTTPServer
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from sm_manager.home import ui_config
from sm_manager.web import asset
from sm_manager.server import handler_for


class ConsoleAssetsTests(unittest.TestCase):
    def test_external_links_can_open_only_top_level_console_pages(self):
        with tempfile.TemporaryDirectory() as directory, patch('sm_manager.web.WEB', Path(directory)):
            (Path(directory) / 'index.html').write_text('<h1>Console fixture</h1>')
            config = {'frontend': 'react', 'port': 0, 'allowed_hosts': ['localhost']}
            server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(None, config))
            config['port'] = server.server_port
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()

            def request(path, headers=None, method='GET'):
                connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
                connection.request(method, path, headers={
                    'Host': f'localhost:{server.server_port}',
                    'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Dest': 'document', **(headers or {}),
                })
                response = connection.getresponse()
                result = response.status, response.read()
                connection.close()
                return result

            try:
                for path in ['/', '/overview?workmode=1', '/projects', '/agents', '/agents/chat/example',
                             '/agents/session/example', '/planner/tasks', '/planner/calendar']:
                    self.assertEqual(request(path), (200, b'<h1>Console fixture</h1>'), path)
                for path in ['/api/snapshot', '/api/night-mode', '/planner/api/tasks',
                             '/planner/calendar?st-embedded=1', '/assets/example.js']:
                    self.assertEqual(request(path)[0], 403, path)
                for headers in [{'Sec-Fetch-Mode': 'cors'}, {'Sec-Fetch-Mode': 'no-cors'},
                                {'Sec-Fetch-Dest': 'iframe'}, {'Sec-Fetch-Dest': 'empty'},
                                {'Origin': 'https://elsewhere.example'}, {'Host': 'elsewhere.example'}]:
                    self.assertEqual(request('/', headers)[0], 403, headers)
                self.assertEqual(request('/', method='POST')[0], 403)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

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
            self.assertEqual(asset('/agents/chat/fixture', root)[1], 'no-store')
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
