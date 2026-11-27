"""Real console asset/header delivery with synthetic APIs, never a collector."""
import json
import os
from http.server import ThreadingHTTPServer
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from sm_manager.server import handler_for
from urllib.parse import urlsplit

apis = json.loads(sys.stdin.readline())
config = {'frontend': 'react', 'port': 0, 'allowed_hosts': ['127.0.0.1']}
if os.environ.get('ST_ARTIFACTS_FIXTURE_CONFIG'):
    from sm_manager.artifacts import Library
    config['artifacts_config_path'] = os.environ['ST_ARTIFACTS_FIXTURE_CONFIG']
    # Only this synthetic test process skips the external publishing transport.
    Library._remote = lambda self, *args, **kwargs: {}
Base = handler_for(None, config)


class Fixture(Base):
    def do_GET(self):
        path = urlsplit(self.path).path
        if path in apis:
            if error := self.access_error():
                return self.respond(403, {'error': error})
            return self.respond(200, apis[path])
        super().do_GET()


server = ThreadingHTTPServer(('127.0.0.1', 0), Fixture)
config['port'] = server.server_port
print(server.server_port, flush=True)
server.serve_forever()
