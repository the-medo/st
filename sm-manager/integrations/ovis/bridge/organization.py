"""Project order and scoped folders; never moves a checkout or changes Codex history."""
import fcntl
import json
import uuid


def load(root):
    path = root / 'organization.json'
    return json.loads(path.read_text()) if path.exists() else {'revision': 0, 'projects': {}}


def project_order(data, projects):
    """Keep known saved IDs first, then append newly configured projects."""
    known = set(projects)
    return list(dict.fromkeys([key for key in data.get('projectOrder', []) if key in known] + list(projects)))


def save(root, data):
    # Both callers hold organization.lock, including while reading the old state.
    data['revision'] += 1
    temporary = root / 'organization.json.tmp'
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')
    temporary.chmod(0o600)
    temporary.replace(root / 'organization.json')


def move_project(root, projects, change):
    project, relative, direction = change.get('projectId'), change.get('relativeTo'), change.get('direction')
    if project not in projects or relative not in projects:
        raise ValueError('That project no longer exists. Refresh and try again.')
    if project == relative or direction not in ('up', 'down'):
        raise ValueError('Choose a neighboring project and move up or down.')
    with (root / 'organization.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = load(root)
        before = project_order(data, projects)
        order = [key for key in before if key != project]
        order.insert(order.index(relative) + (direction == 'down'), project)
        if order != before:
            data['projectOrder'] = order
            save(root, data)
        return {'ok': True, 'revision': data['revision'], 'projectOrder': order}


def update(root, projects, chat_projects, change):
    if change.get('operation') == 'move-project':
        return move_project(root, projects, change)
    project = change.get('projectId')
    if project not in projects:
        raise ValueError('Unknown project.')
    with (root / 'organization.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        data = load(root)
        group = data['projects'].setdefault(project, {'folders': [], 'chats': {}})
        operation = change.get('operation')
        folder_id = change.get('folderId')
        folder = next((x for x in group['folders'] if x['id'] == folder_id), None)
        if operation in ('create', 'rename'):
            name = ' '.join(str(change.get('name', '')).split())
            if not name or len(name) > 60:
                raise ValueError('Folder names must contain 1–60 characters.')
            if any(f['id'] != folder_id and f['name'].casefold() == name.casefold() for f in group['folders']):
                raise ValueError('This project already has a folder with that name.')
            if operation == 'create':
                if len(group['folders']) >= 100:
                    raise ValueError('This project already has 100 folders.')
                folder = {'id': str(uuid.uuid4()), 'name': name}
                group['folders'].append(folder)
            elif folder:
                folder['name'] = name
            else:
                raise ValueError('That folder no longer exists. Refresh and try again.')
        elif operation == 'delete':
            if not folder:
                raise ValueError('That folder no longer exists.')
            group['folders'] = [f for f in group['folders'] if f['id'] != folder_id]
            group['chats'] = {k: v for k, v in group['chats'].items() if v != folder_id}
        elif operation == 'move':
            thread = change.get('threadId')
            if chat_projects.get(thread) != project:
                raise ValueError('The conversation does not belong to this project.')
            if folder_id and not folder:
                raise ValueError('Choose a folder from this project.')
            if folder_id:
                group['chats'][thread] = folder_id
            else:
                group['chats'].pop(thread, None)
        else:
            raise ValueError('Unknown folder action.')
        save(root, data)
        return {'ok': True, 'revision': data['revision'], 'folder': folder}
