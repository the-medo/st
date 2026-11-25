import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from scripts import manage, production, updater


class ProductionTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.config_path = self.root / 'config.json'
        self.runtime = self.root / 'runtime'
        self.runtime.mkdir()
        self.unit = self.root / manage.SERVICE
        self.config = {'port': 8790, 'public_url': 'https://st.example.test', 'allowed_hosts': ['localhost'],
            'data_dir': str(self.root / 'data'), 'deployment_dir': str(self.root / 'deployment'),
            'v2': {'bun': '/bin/true', 'env_file': str(self.root / 'private env'), 'monitor_port': 8791,
                   'ovis_port': 8792, 'owner_login': 'owner@example.test', 'state_dir': str(self.root / 'state'),
                   'identity_origin': 'https://node.example.ts.net:8790'}}
        for name, value in [('config_path', lambda: self.config_path), ('UNIT', self.unit), ('CLI', self.root / 'sm')]:
            p = patch.object(manage, name, value)
            p.start()
            self.addCleanup(p.stop)

    def test_three_services_use_private_configs_and_external_runtime_is_not_owned(self):
        units = production.render_units(self.config, self.runtime, '/bin:/usr/bin')
        self.assertEqual(set(units), {manage.SERVICE, *production.CHILDREN})
        self.assertIn('After=sm-manager-prepare.service sm-manager-monitor.service sm-manager-ovis.service', units[manage.SERVICE])
        for child in (production.MONITOR, production.OVIS):
            self.assertIn('PartOf=sm-manager.service', units[child])
            self.assertIn('After=sm-manager-prepare.service', units[child])
        self.assertNotIn('ExecStartPre=', units[manage.SERVICE])
        self.assertIn('updater.py" "prepare"', units[production.PREPARE])
        base, monitor, gateway, environment = production.paths(self.config)
        self.assertEqual(json.loads(monitor.read_text())['port'], 8791)
        self.assertEqual(json.loads(monitor.read_text())['data_dir'], self.config['data_dir'])
        value = json.loads(gateway.read_text())
        self.assertEqual(value['ownerAuth']['origin'], self.config['v2']['identity_origin'])
        self.assertIn('OVIS_TOKEN=', environment.read_text())
        self.assertNotIn(value['ovisToken'], units[production.OVIS])
        self.assertLess(units[production.OVIS].index('private env'), units[production.OVIS].index('ovis.env'))
        production.render_units(self.config, self.runtime, '/bin:/usr/bin')
        self.assertEqual(json.loads(gateway.read_text())['ownerAuth'], value['ownerAuth'])
        for path in (monitor, gateway, environment):
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        if shutil.which('systemd-analyze'):
            for name, content in units.items():
                self.unit.with_name(name).write_text(content)
            self.unit.with_name(manage.FACEPLATE_SERVICE).write_text('[Service]\nExecStart=/bin/true\n')
            result = subprocess.run(['systemd-analyze', '--user', 'verify', *[str(self.unit.with_name(name)) for name in units]],
                capture_output=True, text=True, env={**os.environ, 'XDG_RUNTIME_DIR': str(self.root)})
            self.assertEqual(result.returncode, 0, result.stderr)
            # systemd returns zero even when it ignores a malformed EnvironmentFile.
            self.assertEqual(result.stderr.strip(), '')

    def test_failed_activation_restores_config_units_and_preserves_data(self):
        original = {key: value for key, value in self.config.items() if key != 'v2'}
        self.config_path.write_text(json.dumps(original))
        self.unit.write_text(manage.MARKER + '\nprevious unit')
        history = Path(self.config['data_dir']) / 'history.sqlite3'
        history.parent.mkdir()
        history.write_bytes(b'private history fixture')
        def install(*args, **kwargs):
            self.unit.write_text('candidate unit')
            production.render_units(self.config, self.runtime, '/bin')
            raise RuntimeError('candidate failed')
        with patch.object(manage, 'install', side_effect=install), patch.object(manage, 'run') as commands:
            with self.assertRaisesRegex(RuntimeError, 'candidate failed'):
                production.activate(self.config)
        self.assertEqual(json.loads(self.config_path.read_text()), original)
        self.assertIn('previous unit', self.unit.read_text())
        self.assertEqual(history.read_bytes(), b'private history fixture')
        self.assertFalse(production.paths(self.config)[2].exists())
        calls = [call.args[0] for call in commands.call_args_list]
        self.assertEqual(calls[0], ['systemctl', '--user', 'stop', manage.SERVICE, *production.CHILDREN])
        self.assertEqual(calls[-1], ['systemctl', '--user', 'start', manage.SERVICE])
        # Restoring an absent private directory permits a clean retry.
        production.render_units(self.config, self.runtime, '/bin')

    def test_failed_health_and_explicit_rollback_restore_previous_installation(self):
        original = {key: value for key, value in self.config.items() if key != 'v2'}
        self.config_path.write_text(json.dumps(original))
        self.unit.write_text(manage.MARKER + '\nprevious unit')
        def install(*args, **kwargs):
            for name, content in production.render_units(self.config, self.runtime, '/bin').items():
                self.unit.with_name(name).write_text(content)
        with patch.object(manage, 'install', side_effect=install), patch.object(manage, 'run'), \
                patch.object(updater, 'Deployment') as deployment:
            deployment.return_value.healthy.return_value = False
            with self.assertRaisesRegex(RuntimeError, 'did not become healthy'):
                production.activate(self.config)
            self.assertEqual(json.loads(self.config_path.read_text()), original)
            self.assertFalse(self.unit.with_name(production.OVIS).exists())
            deployment.return_value.healthy.return_value = True
            saved = production.activate(self.config)
            base = production.paths(self.config)[0]
            production.write(base / 'rollback', str(saved))
            production.rollback()
            self.assertEqual(json.loads(self.config_path.read_text()), original)
            self.assertIn('previous unit', self.unit.read_text())
            self.assertFalse(base.exists())

    def test_updater_controls_all_and_only_web_services(self):
        self.config_path.write_text(json.dumps(self.config))
        deployment = object.__new__(updater.Deployment)
        deployment.settings = {'config_path': str(self.config_path)}
        with patch.object(updater, 'run') as run:
            deployment.service('stop')
            self.assertEqual(run.call_args.args[0], ['systemctl', '--user', 'stop', manage.SERVICE, production.MONITOR, production.OVIS])
            deployment.service('is-active')
            self.assertEqual(run.call_args.args[0], ['systemctl', '--user', 'is-active', manage.SERVICE])

    def test_health_requires_monitor_gateway_and_authenticated_agents(self):
        self.config_path.write_text(json.dumps(self.config))
        deployment = object.__new__(updater.Deployment)
        deployment.settings = {'config_path': str(self.config_path)}
        for authenticated in (False, True):
            with self.subTest(authenticated=authenticated), \
                    patch.object(updater.urllib.request, 'build_opener') as opener, \
                    patch.object(updater.time, 'monotonic', side_effect=[0, 1, 100]), \
                    patch.object(updater.time, 'sleep'):
                opener.return_value.open.side_effect = [io.BytesIO(json.dumps(value).encode()) for value in
                    ({'status': 'ok'}, {'status': 'ok'}, {'ok': True, 'auth': {'authenticated': authenticated}})]
                self.assertEqual(deployment.healthy(), authenticated)
                urls = [call.args[0] for call in opener.return_value.open.call_args_list]
                self.assertEqual(urls, ['http://127.0.0.1:8790' + path for path in
                    ('/api/health', '/api/gateway-health', '/agents/api/health?scope=bridge')])

    def test_unrelated_private_directory_is_not_overwritten(self):
        base = production.paths(self.config)[0]
        base.mkdir()
        with self.assertRaisesRegex(RuntimeError, 'another installation'):
            production.render_units(self.config, self.runtime, '/bin')
        self.assertEqual(list(base.iterdir()), [])
