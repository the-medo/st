import contextlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('preview_ovis', Path(__file__).resolve().parents[1] / 'scripts/preview-ovis.py')
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)


class PreviewTests(unittest.TestCase):
    def test_private_environment_is_overridden_at_exec_not_by_environment_directive(self):
        value = preview.unit('test', ['/bin/bun', 'index.ts'], Path('/private/with space/env'), {'PORT': 19000})
        self.assertIn('EnvironmentFile=/private/with\\x20space/env', value)
        self.assertIn('ExecStart="/usr/bin/env" "PORT=19000" "/bin/bun"', value)
        self.assertNotIn('Environment="PORT=', value)

    def test_failed_ovis_activation_restores_previous_preview(self):
        with tempfile.TemporaryDirectory() as directory, contextlib.ExitStack() as stack:
            root = Path(directory)
            env = root / 'private.env'
            env.touch()
            unit = root / 'preview.service'
            config = root / 'monitor.json'
            saved = root / 'profile.json'
            previous = {'source': str(preview.p.ROOT), 'port': 19000, 'host': 'fixture.test:19000', 'url': 'https://fixture.test:19000', 'target': 'http://127.0.0.1:19000'}
            unit.write_text(preview.p.MARKER + '\noriginal service')
            config.write_text(json.dumps({'allowed_hosts': ['127.0.0.1']}))
            saved.write_text(json.dumps(previous))
            originals = [f.read_text() for f in [unit, config, saved]]
            stack.enter_context(patch.object(preview.p, 'BASE', root))
            stack.enter_context(patch.object(preview.p, 'UNIT', unit))
            stack.enter_context(patch.object(preview.p, 'NAME', unit.name))
            stack.enter_context(patch.object(preview.shutil, 'which', return_value='/bin/true'))
            stack.enter_context(patch.object(preview.socket, 'socket'))
            stack.enter_context(patch.object(preview.sys, 'argv', ['preview-ovis.py','--env-file',str(env),'--bun','/bin/true']))
            def answer(*args):
                if args[1:3] == ('serve','status'):
                    return json.dumps({'Web': {previous['host']: {'Handlers': {'/': {'Proxy': previous['target']}}}}})
                if args[1] == 'status':
                    return json.dumps({'Self': {'UserID': 1}, 'User': {'1': {'LoginName': 'fixture@example.test'}}})
                return ''
            calls = stack.enter_context(patch.object(preview.p, 'run', side_effect=answer))
            stop = stack.enter_context(patch.object(preview.subprocess, 'run'))
            stack.enter_context(patch.object(preview.p, 'wait'))
            stack.enter_context(patch.object(preview, 'wait_ovis', side_effect=RuntimeError('fixture failure')))
            with self.assertRaisesRegex(RuntimeError, 'fixture failure'):
                preview.main()
            self.assertEqual([f.read_text() for f in [unit, config, saved]], originals)
            self.assertEqual(stop.call_args.args[0], ['systemctl','--user','disable','--now','preview-monitor.service','preview-ovis.service'])
            self.assertEqual(calls.call_args.args, ('systemctl','--user','restart','preview.service'))
