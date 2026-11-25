"""Read-only GitHub Projects/PR dashboard, with a shared on-demand hourly cache."""
import copy
from datetime import date, timedelta
import json
import os
import re
import subprocess
import threading
import time

TTL = 3600
RETRY_AFTER = 300
REFRESH_COOLDOWN = 30

PROJECT_QUERY = """
query($org: String!, $number: Int!, $cursor: String) {
  organization(login: $org) { projectV2(number: $number) {
    title url
    fields(first: 100) { pageInfo { hasNextPage } nodes {
      ... on ProjectV2IterationField { name configuration {
        iterations { id title startDate duration }
        completedIterations { id title startDate duration }
      } }
    } }
    items(first: 100, after: $cursor) { pageInfo { hasNextPage endCursor } nodes {
      id type isArchived updatedAt
      fieldValues(first: 100) { pageInfo { hasNextPage } nodes {
        ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldIterationValue { iterationId title field { ... on ProjectV2FieldCommon { name } } }
        ... on ProjectV2ItemFieldPullRequestValue { pullRequests(first: 20) { nodes { number title url state } } }
      } }
      content {
        ... on Issue { title number url state updatedAt repository { nameWithOwner }
          assignees(first: 100) { nodes { login } } labels(first: 20) { nodes { name } } }
        ... on PullRequest { title number url state updatedAt repository { nameWithOwner }
          assignees(first: 100) { nodes { login } } labels(first: 20) { nodes { name } } }
        ... on DraftIssue { title updatedAt assignees(first: 100) { nodes { login } } }
      }
    } }
  } }
}
"""
PRS_QUERY = """
query($search: String!, $cursor: String) {
  search(query: $search, type: ISSUE, first: 50, after: $cursor) {
    issueCount pageInfo { hasNextPage endCursor } nodes {
      ... on PullRequest {
        id title number url updatedAt isDraft mergeable
        repository { nameWithOwner } additions deletions
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}
"""


class GitHubUnavailable(Exception):
    pass


def error_message(message):
    """Never forward CLI stderr, credentials, private file paths or raw API errors."""
    message = message.lower()
    if 'read:project' in message or 'insufficient_scopes' in message:
        return 'Project access needs read:project. On the server, run gh auth refresh -h github.com -s read:project.'
    if 'rate limit' in message or 'rate_limit' in message:
        return 'GitHub rate limit reached. Cached data is retained; try again later.'
    if any(word in message for word in ('authentication', 'bad credentials', 'gh auth login', 'not logged')):
        return 'GitHub login unavailable. Sign in with gh auth login on the server.'
    if 'saml' in message or 'sso' in message:
        return 'Authorize the server’s GitHub login for the organization’s SSO.'
    return 'GitHub could not be reached or access was denied. Check the server login and organization access, then refresh.'


def graphql(query, variables=None, binary='gh'):
    try:
        result = subprocess.run(
            [binary, 'api', '--hostname', 'github.com', 'graphql', '--input', '-'],
            input=json.dumps({'query': query, 'variables': variables or {}}),
            capture_output=True, text=True, timeout=45,
            env={**os.environ, 'GH_PROMPT_DISABLED': '1', 'GH_DEBUG': ''},
        )
    except FileNotFoundError:
        raise GitHubUnavailable('Install GitHub CLI on the server and sign in with gh auth login.') from None
    except (OSError, subprocess.TimeoutExpired):
        raise GitHubUnavailable('GitHub request timed out or the CLI is unavailable. Try refreshing shortly.') from None
    try:
        response = json.loads(result.stdout)
    except ValueError:
        raise GitHubUnavailable(error_message(result.stderr)) from None
    if result.returncode or response.get('errors'):
        raise GitHubUnavailable(error_message(json.dumps(response.get('errors', [])) + result.stderr))
    if not isinstance(response.get('data'), dict):
        raise GitHubUnavailable('GitHub returned an incomplete response. Try refreshing shortly.')
    return response['data']


def nodes(connection):
    return [node for node in (connection or {}).get('nodes', []) if node]


def normalize_item(item, project_url, sprint_field, status_field):
    content = item.get('content')
    if not content or item.get('isArchived'):
        return None
    fields = nodes(item.get('fieldValues'))
    values = {field.get('field', {}).get('name', '').casefold(): field for field in fields}
    sprint = values.get(sprint_field.casefold(), {})
    status = values.get(status_field.casefold(), {}).get('name') or content.get('state', 'No status').title()
    return {
        'id': item['id'], 'kind': item['type'], 'title': content['title'],
        'number': content.get('number'), 'url': content.get('url') or project_url,
        'repository': (content.get('repository') or {}).get('nameWithOwner', ''),
        'state': content.get('state', ''), 'status': status,
        'completed': status.strip().casefold() in ('done', 'delivered'),
        'assignees': [user['login'] for user in nodes(content.get('assignees'))],
        'labels': [label['name'] for label in nodes(content.get('labels'))],
        'sprint_id': sprint.get('iterationId'), 'sprint': sprint.get('title'),
        'updated_at': content.get('updatedAt') or item['updatedAt'],
        'pull_requests': [pr for field in fields for pr in nodes(field.get('pullRequests'))],
    }


def current_iteration(iterations, today=None):
    today = today or date.today()
    for iteration in iterations:
        start = date.fromisoformat(iteration['startDate'])
        end = start + timedelta(days=iteration['duration'])
        if start <= today < end:
            return {**iteration, 'endDate': (end - timedelta(days=1)).isoformat()}
    return None


class GitHubDashboard:
    def __init__(self, config, request=None, clock=time.time):
        settings = config.get('github', {})
        self.org = settings.get('organization', 'ydistri')
        self.number = int(settings.get('project_number', 6))
        self.username = settings.get('username', '')
        if (not re.fullmatch(r'[A-Za-z0-9-]+', self.org) or self.number < 1 or
                (self.username and not re.fullmatch(r'[A-Za-z0-9-]+', self.username))):
            raise ValueError('Invalid GitHub organization, project number or username')
        self.sprint_field = settings.get('sprint_field', 'Sprint')
        self.status_field = settings.get('status_field', 'Status')
        self.project_url = f'https://github.com/orgs/{self.org}/projects/{self.number}'
        self.request = request or (lambda query, variables=None: graphql(query, variables, settings.get('gh_binary', 'gh')))
        self.clock = clock
        self.lock = threading.Lock()
        self.refreshing = False
        self.last_attempt = None
        self.sections = {key: {'data': None, 'updated_at': None, 'error': None} for key in ('project', 'pull_requests')}

    def fetch_project(self):
        cursor, items, iterations, title = None, [], [], ''
        # Bound work, but fail visibly instead of silently presenting a partial board.
        for _ in range(100):
            result = self.request(PROJECT_QUERY, {'org': self.org, 'number': self.number, 'cursor': cursor})
            project = (result.get('organization') or {}).get('projectV2')
            if not project:
                raise GitHubUnavailable('Project not found. Check organization access and the project number.')
            title = project['title']
            if project['fields']['pageInfo']['hasNextPage']:
                raise GitHubUnavailable('This project has too many fields to read completely.')
            iteration_field = next((field for field in nodes(project['fields']) if field.get('name', '').casefold() == self.sprint_field.casefold()), None)
            if not iteration_field:
                raise GitHubUnavailable(f'No iteration field named {self.sprint_field}. Check github.sprint_field in the server configuration.')
            iterations = iteration_field['configuration']['iterations'] + iteration_field['configuration']['completedIterations']
            for item in nodes(project['items']):
                if item['fieldValues']['pageInfo']['hasNextPage']:
                    raise GitHubUnavailable('A project item has too many fields to read completely.')
                normalized = normalize_item(item, self.project_url, self.sprint_field, self.status_field)
                if normalized:
                    items.append(normalized)
            page = project['items']['pageInfo']
            if not page['hasNextPage']:
                return {'title': title, 'iterations': iterations, 'items': items}
            if not page['endCursor'] or page['endCursor'] == cursor:
                break
            cursor = page['endCursor']
        raise GitHubUnavailable('Project is too large to fetch completely. Cached data is retained.')

    def fetch_prs(self):
        cursor, rows = None, []
        for _ in range(20):
            result = self.request(PRS_QUERY, {'search': f'org:{self.org} author:{self.username} is:pr is:open sort:updated-desc', 'cursor': cursor})['search']
            if result['issueCount'] > 1000:
                raise GitHubUnavailable('GitHub search exceeds 1,000 pull requests. Results would be incomplete.')
            for pr in nodes(result):
                commits = nodes(pr.get('commits'))
                checks = (commits[-1]['commit'].get('statusCheckRollup') or {}).get('state') if commits else None
                rows.append({
                    'id': pr['id'], 'title': pr['title'], 'number': pr['number'], 'url': pr['url'],
                    'repository': pr['repository']['nameWithOwner'], 'draft': pr['isDraft'],
                    'mergeable': pr['mergeable'], 'checks': checks,
                    'additions': pr['additions'], 'deletions': pr['deletions'], 'updated_at': pr['updatedAt'],
                })
            page = result['pageInfo']
            if not page['hasNextPage']:
                return rows
            if not page['endCursor'] or page['endCursor'] == cursor:
                break
            cursor = page['endCursor']
        raise GitHubUnavailable('Pull request pagination was incomplete. Cached data is retained.')

    def _refresh(self):
        try:
            if not self.username:
                username = self.request('query { viewer { login } }')['viewer']['login']
                with self.lock:
                    self.username = username
            for key, fetch in (('pull_requests', self.fetch_prs), ('project', self.fetch_project)):
                try:
                    data = fetch()
                    with self.lock:
                        self.sections[key] = {'data': data, 'updated_at': self.clock(), 'error': None}
                except (GitHubUnavailable, KeyError, TypeError, ValueError) as error:
                    with self.lock:
                        self.sections[key]['error'] = str(error) if isinstance(error, GitHubUnavailable) else 'GitHub returned unexpected data. Try refreshing shortly.'
        except (GitHubUnavailable, KeyError, TypeError, ValueError) as error:
            with self.lock:
                for section in self.sections.values():
                    section['error'] = str(error) if isinstance(error, GitHubUnavailable) else 'GitHub returned unexpected data. Try refreshing shortly.'
        finally:
            with self.lock:
                self.refreshing = False

    def get(self, force=False):
        with self.lock:
            now = self.clock()
            age = float('inf') if self.last_attempt is None else now - self.last_attempt
            interval = RETRY_AFTER if any(s['error'] for s in self.sections.values()) else TTL
            if not self.refreshing and age >= (REFRESH_COOLDOWN if force else interval):
                self.refreshing = True
                self.last_attempt = now
                age = 0
                threading.Thread(target=self._refresh, name='github-refresh', daemon=True).start()
            result = copy.deepcopy(self.sections)
            result.update(organization=self.org, username=self.username, project_url=self.project_url,
                          sprint_url=self.project_url + '/views/2', backlog_url=self.project_url + '/views/5',
                          refreshing=self.refreshing, refresh_after=max(0, REFRESH_COOLDOWN - age), cache_seconds=TTL)
        for key in ('project', 'pull_requests'):
            section = result[key]
            section['stale'] = section['data'] is not None and (bool(section['error']) or now - section['updated_at'] >= TTL)
        project = result['project']['data']
        if project is not None:
            current = current_iteration(project.pop('iterations'))
            items = project.pop('items')
            project['current_sprint'] = current
            assigned = [item for item in items if result['username'].casefold() in [a.casefold() for a in item['assignees']]]
            project['sprint_tasks'] = [item for item in assigned if current and item['sprint_id'] == current['id']]
            # Personal backlog: assigned issues excluding Done and Delivered.
            project['backlog'] = [item for item in assigned if item['kind'] == 'ISSUE' and not item['completed']]
        return result
