import json
import unittest
from unittest.mock import Mock
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

    def test_native_evidence_survives_normalization_without_inference_from_text(self):
        read = normalize_item({'type': 'commandExecution', 'id': 'a', 'status': 'completed', 'exitCode': 0, 'cwd': '/repo', 'command': 'cat skills/a/SKILL.md', 'commandActions': [{'type': 'read', 'path': 'skills/a/SKILL.md'}, {'type': 'search', 'path': 'SKILL.md'}]})
        self.assertEqual(read['commandActions'], [{'type': 'read', 'path': '/repo/skills/a/SKILL.md'}])
        self.assertEqual(read['exitCode'], 0)
        call = normalize_item({'type': 'mcpToolCall', 'id': 'b', 'status': 'completed', 'server': 'docs', 'tool': 'search', 'result': {'isError': True}})
        self.assertEqual(call['mcp'], {'server': 'docs', 'tool': 'search', 'status': 'failed'})
        dynamic = normalize_item({'type': 'dynamicToolCall', 'tool': 'mcp__docs__search'})
        self.assertNotIn('mcp', dynamic)

if __name__ == '__main__': unittest.main()
