"""Read-only resource inventory. Never forward credentials or invoke skills/MCP tools."""


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
