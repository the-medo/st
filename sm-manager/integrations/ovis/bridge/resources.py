"""Read-only resource inventory. Never forward credentials or invoke skills/MCP tools."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import json
import shutil
import subprocess
import tempfile


def inventory(client, thread_id, cwd):
    result = {'skills': [], 'servers': [], 'errors': []}
    try:
        response = client.rpc('skills/list', {'cwds': [cwd]})
        entries = [entry for entry in response['data'] if entry['cwd'] == cwd]
        if not entries:
            raise ValueError('Missing project inventory')
        for entry in entries:
            for skill in entry['skills']:
                result['skills'].append({key: skill.get(key) for key in
                                        ('name', 'description', 'path', 'scope', 'enabled', 'pluginId')})
            if entry.get('errors'):
                result['errors'].append('Some skill files could not be loaded by the agent.')
    except Exception:
        result['errors'].append('The agent could not report its skills. Refresh to retry.')
    try:
        cursor, seen = None, set()
        for _ in range(20):
            response = client.rpc('mcpServerStatus/list', {'threadId': thread_id, 'limit': 100,
                                                         'detail': 'toolsAndAuthOnly', **({'cursor': cursor} if cursor else {})})
            for server in response['data']:
                result['servers'].append({
                    'name': server['name'], 'status': server.get('runtimeStatus') or 'unknown',
                    'authStatus': server.get('authStatus', 'unknown'),
                    'environmentId': server.get('environmentId'), 'pluginId': server.get('pluginId'),
                    'tools': [{'name': tool['name'], 'description': tool.get('description') or ''}
                              for tool in server.get('tools', {}).values()],
                    'toolsUnavailable': bool(server.get('toolsError')),
                })
            cursor = response.get('nextCursor')
            if not cursor:
                break
            if cursor in seen:
                raise ValueError('Repeated inventory page')
            seen.add(cursor)
        else:
            raise ValueError('Inventory page limit reached')
    except Exception:
        result['errors'].append('MCP inventory is incomplete or unavailable for this conversation.')
    return result


def cli_json(binary, args, cwd):
    # Fixed argv only, no shell. File-backed output bounds the amount read into memory.
    with tempfile.TemporaryFile() as output:
        process = subprocess.run([binary, *args, '--json'], cwd=cwd, stdout=output,
                                 stderr=subprocess.DEVNULL, timeout=20, check=False)
        if process.returncode != 0:
            raise ValueError('Read failed')
        output.seek(0)
        data = output.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            raise ValueError('Inventory too large')
        return json.loads(data)


def skillshare(cwd, check=False):
    binary = shutil.which('skillshare')
    if not binary:
        return {'installed': False, 'checked': False, 'rows': [], 'errors': []}
    scopes = [('global', Path.home(), '-g')]
    for parent in (Path(cwd), *Path(cwd).parents):
        if any((parent / folder / 'config.yaml').is_file() for folder in ('.skillshare', 'skillshare')):
            scopes.append(('project', parent, '-p'))
            break
    rows, errors = [], []
    for scope, directory, flag in scopes:
        commands = {'list': ['list', '--all', flag], 'diff': ['diff', flag], 'mcp': ['mcp', 'list', flag]}
        if check:
            commands['check'] = ['check', flag]
        raw = {}
        with ThreadPoolExecutor(max_workers=4) as pool:
            jobs = {name: pool.submit(cli_json, binary, args, directory) for name, args in commands.items()}
            for name, job in jobs.items():
                try:
                    value = job.result()
                    if not isinstance(value, list if name == 'list' else dict):
                        raise ValueError('Unexpected response')
                    raw[name] = value
                except Exception:
                    errors.append(f'Skillshare {scope} {name} could not be read. Refresh to retry.')
        pending = {(item.get('kind', 'skill'), item['name'].removesuffix('.md')) for target in raw.get('diff', {}).get('targets', [])
                   for item in target.get('items', []) if item.get('is_sync')}
        checks = {item['name']: item.get('status') for item in raw.get('check', {}).get('skills', [])}
        updates = {name for name, status in checks.items() if status == 'update_available'}
        behind = {item['name'] for item in raw.get('check', {}).get('tracked_repos', [])
                  if item.get('status') == 'behind'}
        for item in raw.get('list', []):
            name = item.get('name', '')
            kind = 'agent' if item.get('kind') == 'agent' else 'skill'
            rows.append({'name': name, 'kind': kind, 'scope': scope,
                         'sync': 'off' if item.get('disabled') else 'unknown' if not raw.get('diff', {}).get('targets') else 'pending' if (kind, name.removesuffix('.md')) in pending else 'synced',
                         'update': 'available' if kind == 'skill' and (name in updates or item.get('relPath') in updates or item.get('repoName') in behind) else
                                   'current' if kind == 'skill' and checks.get(item.get('relPath'), checks.get(name)) == 'up_to_date' else 'unknown'})
        servers = {}
        for item in raw.get('mcp', {}).get('changes', []):
            servers[item['name']] = servers.get(item['name'], False) or item.get('action') not in (None, '', 'unchanged')
        rows.extend({'name': name, 'kind': 'mcp', 'scope': scope, 'sync': 'pending' if waiting else 'synced', 'update': 'unknown'}
                    for name, waiting in servers.items())
    return {'installed': True, 'checked': check, 'rows': rows, 'errors': errors}
