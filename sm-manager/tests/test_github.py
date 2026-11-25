from datetime import date
import http.client
from http.server import ThreadingHTTPServer
import json
import subprocess
import threading
import unittest
from unittest.mock import Mock, patch

from sm_manager.github import GitHubDashboard, GitHubUnavailable, current_iteration, graphql
from sm_manager.server import handler_for


def item(key, status='Todo', assignee='owner', sprint='current', kind='ISSUE', **extra):
    return {
        'id': key, 'type': kind, 'isArchived': False, 'updatedAt': '2026-11-25T10:00:00Z',
        'fieldValues': {'pageInfo': {'hasNextPage': False}, 'nodes': [
            {'name': status, 'field': {'name': 'Status'}},
            {'iterationId': sprint, 'title': sprint, 'field': {'name': 'Sprint'}},
            {'pullRequests': {'nodes': [{'number': 7, 'title': 'Fix', 'url': 'https://github.com/test/repo/pull/7', 'state': 'OPEN'}]}},
        ]},
        'content': {'title': key, 'number': 1, 'url': 'https://github.com/test/repo/issues/1',
                    'state': 'CLOSED' if status == 'Done' else 'OPEN', 'repository': {'nameWithOwner': 'test/repo'},
                    'assignees': {'nodes': [{'login': assignee}]}, 'labels': {'nodes': [{'name': 'bug'}]}},
        **extra,
    }


ITERATIONS = [
    {'id': 'past', 'title': 'Previous', 'startDate': '2026-11-06', 'duration': 14},
    {'id': 'current', 'title': 'Sprint 19', 'startDate': '2026-11-20', 'duration': 14},
    {'id': 'next', 'title': 'Next', 'startDate': '2026-12-04', 'duration': 14},
]


def project_page(items, cursor=None):
    return {'organization': {'projectV2': {
        'title': 'Project', 'url': 'https://github.com/orgs/test/projects/6',
        'fields': {'pageInfo': {'hasNextPage': False}, 'nodes': [{
            'name': 'Sprint', 'configuration': {'iterations': ITERATIONS[1:], 'completedIterations': ITERATIONS[:1]},
        }]},
        'items': {'nodes': items, 'pageInfo': {'hasNextPage': bool(cursor), 'endCursor': cursor}},
    }}}


def pr_page(cursor=None):
    return {'search': {'issueCount': 2, 'pageInfo': {'hasNextPage': bool(cursor), 'endCursor': cursor}, 'nodes': [{
        'id': cursor or 'second', 'title': 'Feature', 'number': 2, 'url': 'https://github.com/test/repo/pull/2',
        'updatedAt': '2026-11-25T10:00:00Z', 'isDraft': True, 'reviewDecision': 'REVIEW_REQUIRED',
        'mergeable': 'CONFLICTING', 'repository': {'nameWithOwner': 'test/repo'},
        'additions': 4, 'deletions': 1, 'commits': {'nodes': [{'commit': {'statusCheckRollup': {'state': 'FAILURE'}}}]},
    }]}}


class GitHubTests(unittest.TestCase):
    def dashboard(self, request=None, clock=lambda: 1000):
        return GitHubDashboard({'github': {'organization': 'test', 'username': 'Owner'}}, request=request, clock=clock)

    def test_current_iteration_boundaries(self):
        for day, expected in [('2026-11-19', 'past'), ('2026-11-20', 'current'), ('2026-12-03', 'current'), ('2026-12-04', 'next')]:
            self.assertEqual(current_iteration(ITERATIONS, date.fromisoformat(day))['id'], expected)
        self.assertEqual(current_iteration(ITERATIONS, date(2026, 11, 25))['endDate'], '2026-12-03')
        self.assertIsNone(current_iteration(ITERATIONS, date(2027, 1, 1)))

    def test_all_project_pages_assignment_completed_and_backlog(self):
        request = Mock(side_effect=[
            project_page([item('active'), item('done', 'Done'), item('other', assignee='someone'), item('archived', isArchived=True)], 'page2'),
            project_page([item('delivered', 'Delivered'), item('old', sprint='past'), item('future', sprint='next'), item('draft', kind='DRAFT_ISSUE'), item('redacted', content=None)]),
        ])
        dashboard = self.dashboard(request)
        project = dashboard.fetch_project()
        self.assertEqual(request.call_args_list[1].args[1]['cursor'], 'page2')
        self.assertEqual(len(project['items']), 7)
        self.assertEqual(project['items'][0]['pull_requests'][0]['number'], 7)
        dashboard.sections['project'] = {'data': project, 'updated_at': 1000, 'error': None}
        dashboard.last_attempt = 1000
        with patch('sm_manager.github.current_iteration', return_value=current_iteration(ITERATIONS, date(2026, 11, 25))):
            result = dashboard.get()['project']['data']
        self.assertEqual([task['id'] for task in result['sprint_tasks']], ['active', 'done', 'delivered', 'draft'])
        self.assertEqual([task['id'] for task in result['backlog']], ['active', 'other', 'old', 'future'])
        self.assertIn('items', dashboard.sections['project']['data'])  # Projection doesn't mutate cache.

    def test_pr_pagination_drafts_and_checks(self):
        request = Mock(side_effect=[pr_page('next'), pr_page()])
        rows = self.dashboard(request).fetch_prs()
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[0]['draft'])
        self.assertEqual(rows[0]['checks'], 'FAILURE')
        self.assertEqual(rows[0]['mergeable'], 'CONFLICTING')
        self.assertIn('org:test author:Owner is:pr is:open', request.call_args_list[0].args[1]['search'])
        self.assertEqual(request.call_args_list[1].args[1]['cursor'], 'next')

    def test_partial_or_over_limit_data_is_not_published(self):
        page = project_page([item('good')])
        page['organization']['projectV2']['items']['nodes'][0]['fieldValues']['pageInfo']['hasNextPage'] = True
        with self.assertRaises(GitHubUnavailable):
            self.dashboard(Mock(return_value=page)).fetch_project()
        page = pr_page()
        page['search']['issueCount'] = 1001
        with self.assertRaises(GitHubUnavailable):
            self.dashboard(Mock(return_value=page)).fetch_prs()

    def test_refresh_coalesces_caches_and_manual_refresh_is_bounded(self):
        now = [1000]
        dashboard = self.dashboard(clock=lambda: now[0])
        with patch('sm_manager.github.threading.Thread') as thread:
            self.assertTrue(dashboard.get()['refreshing'])
            dashboard.get(force=True)
            self.assertEqual(thread.call_count, 1)
            dashboard.refreshing = False
            dashboard.get(force=True)
            self.assertEqual(thread.call_count, 1)
            now[0] += 30
            dashboard.get(force=True)
            self.assertEqual(thread.call_count, 2)
            dashboard.refreshing = False
            now[0] += 3599
            dashboard.get()
            self.assertEqual(thread.call_count, 2)
            now[0] += 1
            dashboard.get()
            self.assertEqual(thread.call_count, 3)

    def test_failure_keeps_last_success_and_other_section_updates(self):
        dashboard = self.dashboard()
        dashboard.last_attempt = 1000
        previous = {'title': 'Saved', 'iterations': ITERATIONS, 'items': []}
        dashboard.sections['project'] = {'data': previous, 'updated_at': 900, 'error': None}
        dashboard.fetch_project = Mock(side_effect=GitHubUnavailable('Project access unavailable'))
        dashboard.fetch_prs = Mock(return_value=[])
        dashboard._refresh()
        self.assertEqual(dashboard.sections['project']['data'], previous)
        self.assertEqual(dashboard.sections['project']['updated_at'], 900)
        self.assertEqual(dashboard.sections['pull_requests']['data'], [])
        self.assertIsNone(dashboard.sections['pull_requests']['error'])
        self.assertTrue(dashboard.get()['project']['stale'])
        self.assertFalse(dashboard.refreshing)

    def test_cli_never_returns_raw_errors_or_authentication(self):
        for response in [
            subprocess.CompletedProcess([], 1, '{"errors":[{"message":"read:project private-secret"}]}', 'private-secret'),
            subprocess.CompletedProcess([], 1, '', 'private-secret gh auth login'),
            subprocess.CompletedProcess([], 1, '', 'private-secret unexpected'),
        ]:
            with patch('sm_manager.github.subprocess.run', return_value=response) as run:
                with self.assertRaises(GitHubUnavailable) as error:
                    graphql('query { viewer { login } }')
                self.assertNotIn('private-secret', str(error.exception))
                self.assertEqual(run.call_args.args[0][-2:], ['--input', '-'])
                self.assertNotIn('shell', run.call_args.kwargs)
        with patch('sm_manager.github.subprocess.run', side_effect=subprocess.TimeoutExpired('gh', 45)):
            with self.assertRaises(GitHubUnavailable): graphql('query {}')

    def test_api_checks_access_and_returns_private_uncached_response(self):
        github = Mock()
        github.get.return_value = {'refreshing': True}
        server = ThreadingHTTPServer(('127.0.0.1', 0), handler_for(Mock(), {'port': 0, 'allowed_hosts': ['localhost']}, github=github))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        def request(headers):
            connection = http.client.HTTPConnection('127.0.0.1', server.server_port)
            try:
                connection.request('GET', '/api/github?refresh=1', headers={'Host': 'localhost', **headers})
                response = connection.getresponse()
                return response.status, response.getheader('Cache-Control'), json.loads(response.read())
            finally: connection.close()
        for headers in ({'Host': 'evil.test'}, {'Origin': 'https://evil.test'}, {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(request(headers)[0], 403)
        github.get.assert_not_called()
        self.assertEqual(request({}), (200, 'no-store', {'refreshing': True}))
        github.get.assert_called_once_with(force=True)
