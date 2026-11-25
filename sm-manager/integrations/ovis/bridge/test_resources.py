import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from . import resources
from .chat_service import normalize_item


class ResourceTests(unittest.TestCase):
    def test_inventory_is_thread_scoped_paginated_and_only_exposes_presentation_fields(self):
        client = Mock()
        client.rpc.side_effect = [
            {'data': [{'cwd': '/fixture', 'skills': [{'name': 'review', 'path': '/skills/review/SKILL.md', 'enabled': True, 'scope': 'user', 'description': 'Review changes', 'dependencies': {'secret': 'DO_NOT_EXPOSE'}}], 'errors': []}]},
            {'data': [{'name': 'docs', 'runtimeStatus': 'connected', 'authStatus': 'oAuth', 'tools': {'search': {'name': 'search', 'description': 'Search docs', 'inputSchema': {'secret': 'DO_NOT_EXPOSE'}}}, 'env': {'TOKEN': 'DO_NOT_EXPOSE'}, 'toolsError': None}], 'nextCursor': 'page2'},
            {'data': [{'name': 'offline', 'tools': {}, 'toolsError': 'DO_NOT_EXPOSE'}]},
        ]
        result = resources.inventory(client, 'thread-a', '/fixture')
        self.assertEqual(result['skills'][0]['name'], 'review')
        self.assertEqual(result['servers'][1]['status'], 'unknown')
        self.assertTrue(result['servers'][1]['toolsUnavailable'])
        self.assertNotIn('DO_NOT_EXPOSE', json.dumps(result))
        for call in client.rpc.call_args_list[1:]:
            self.assertEqual(call.args[1]['threadId'], 'thread-a')
        self.assertEqual(client.rpc.call_args_list[2].args[1]['cursor'], 'page2')

    def test_failure_remains_unknown_and_preserves_other_inventory(self):
        client = Mock()
        client.rpc.side_effect = [RuntimeError('SECRET'), {'data': []}]
        result = resources.inventory(client, 'thread', '/fixture')
        self.assertEqual(len(result['errors']), 1)
        self.assertNotIn('SECRET', json.dumps(result))

    def test_missing_skillshare_does_not_run_or_initialize_anything(self):
        with patch.object(resources.shutil, 'which', return_value=None), patch.object(resources.subprocess, 'run') as run:
            self.assertFalse(resources.skillshare('/fixture')['installed'])
            run.assert_not_called()

    def test_sync_and_upstream_are_independent_unknown_until_confirmed(self):
        with tempfile.TemporaryDirectory() as root:
            def cli(binary, args, cwd):
                self.assertNotIn(args[0], ('init', 'sync', 'update', 'install'))
                if args[0] == 'list': return [{'name': 'review'}, {'name': 'local'}, {'name': 'off', 'disabled': True}]
                if args[0] == 'diff': return {'targets': [{'name': 'codex', 'items': [{'name': 'review', 'is_sync': True}]}]}
                if args[0] == 'mcp': return {'changes': [{'name': 'docs', 'action': 'modify'}, {'name': 'docs', 'action': 'unchanged'}]}
                if args[0] == 'check': return {'skills': [{'name': 'review', 'status': 'update_available'}, {'name': 'local', 'status': 'local'}]}
                raise AssertionError(args)
            with patch.object(resources.shutil, 'which', return_value='/fixture/skillshare'), patch.object(resources, 'cli_json', side_effect=cli):
                first = resources.skillshare(root)
                self.assertTrue(all(row['update'] == 'unknown' for row in first['rows']))
                checked = resources.skillshare(root, check=True)
                rows = {row['name']: row for row in checked['rows']}
                self.assertEqual(rows['review']['update'], 'available')
                self.assertEqual(rows['local']['update'], 'unknown')
                self.assertEqual(rows['off']['sync'], 'off')
                self.assertEqual(rows['docs']['sync'], 'pending')
            with patch.object(resources.shutil, 'which', return_value='/fixture/skillshare'), patch.object(resources, 'cli_json', side_effect=lambda binary, args, cwd: [{'name': 'review'}] if args[0] == 'list' else (_ for _ in ()).throw(RuntimeError('SECRET'))):
                failed = resources.skillshare(root)
                self.assertEqual(failed['rows'][0]['sync'], 'unknown')
                self.assertNotIn('SECRET', json.dumps(failed))

    def test_native_evidence_survives_normalization_without_inference_from_text(self):
        read = normalize_item({'type': 'commandExecution', 'id': 'a', 'status': 'completed', 'exitCode': 0, 'cwd': '/repo', 'command': 'cat skills/a/SKILL.md', 'commandActions': [{'type': 'read', 'path': 'skills/a/SKILL.md'}, {'type': 'search', 'path': 'SKILL.md'}]})
        self.assertEqual(read['commandActions'], [{'type': 'read', 'path': '/repo/skills/a/SKILL.md'}])
        self.assertEqual(read['exitCode'], 0)
        call = normalize_item({'type': 'mcpToolCall', 'id': 'b', 'status': 'completed', 'server': 'docs', 'tool': 'search', 'result': {'isError': True}})
        self.assertEqual(call['mcp'], {'server': 'docs', 'tool': 'search', 'status': 'failed'})
        dynamic = normalize_item({'type': 'dynamicToolCall', 'tool': 'mcp__docs__search'})
        self.assertNotIn('mcp', dynamic)

if __name__ == '__main__': unittest.main()
