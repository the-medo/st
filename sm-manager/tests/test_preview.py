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

    def test_gateway_and_agents_share_a_private_preview_credential(self):
        with tempfile.TemporaryDirectory() as directory:
            gateway = Path(directory) / 'gateway.json'
            gateway.write_text(json.dumps({'ownerLogin': 'owner@example.test'}))
            auth_file, token = preview.provision_auth(gateway)
            self.assertGreaterEqual(len(token), 48)
            self.assertEqual(json.loads(gateway.read_text())['ovisToken'], token)
            self.assertIn('OVIS_TOKEN=' + preview.p.unit_quote(token), auth_file.read_text())
            self.assertEqual(auth_file.stat().st_mode & 0o777, 0o600)
            self.assertEqual(gateway.stat().st_mode & 0o777, 0o600)
            self.assertEqual(preview.provision_auth(gateway)[1], token)
            unit = preview.unit('test', ['/bin/bun', 'index.ts'], Path('/private/original.env'),
                                {'PORT': 19000}, auth_file=auth_file)
            self.assertLess(unit.index('EnvironmentFile=/private/original.env'), unit.index('EnvironmentFile=' + str(auth_file)))
            self.assertNotIn(token, unit)
            self.assertNotIn('OVIS_TOKEN=', unit)

    def test_private_credential_requires_an_owner_gate(self):
        with tempfile.TemporaryDirectory() as directory:
            gateway = Path(directory) / 'gateway.json'
            gateway.write_text('{}')
            with self.assertRaises(ValueError): preview.provision_auth(gateway)
            self.assertFalse((gateway.parent / 'agents-auth.env').exists())

    def test_ready_requires_authentication_not_just_http_200(self):
        from unittest.mock import Mock
        response = Mock(status=200)
        response.read.return_value = b'{"auth":{"required":true,"authenticated":false}}'
        connection = Mock()
        connection.getresponse.return_value = response
        with patch('http.client.HTTPConnection', return_value=connection), patch.object(preview.time, 'monotonic', side_effect=[0, 1, 31]), patch.object(preview.time, 'sleep'):
            with self.assertRaisesRegex(RuntimeError, 'sign-in did not become ready'):
                preview.wait_ovis(19000, path='/agents/api/health?scope=bridge')
        response.read.return_value = b'{"auth":{"required":true,"authenticated":true}}'
        with patch('http.client.HTTPConnection', return_value=connection):
            preview.wait_ovis(19000, 'fixture-secret')
        connection.request.assert_called_with('GET', '/api/health?scope=bridge', headers={'Authorization': 'Bearer fixture-secret'})
