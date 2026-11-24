"""Private, chunked attachments uploaded from the desktop that chose them."""
import os
import base64
import fcntl
import hashlib
import json
from pathlib import Path
import re
import uuid

ROOT = Path(os.environ.get('ST_OVIS_ATTACHMENTS', str(Path.home()/'.local/share/herdr-codex-attachments'))).expanduser()
MAX_FILE = 20*1024*1024


def location(thread, attachment):
    return ROOT/str(uuid.UUID(thread))/str(uuid.UUID(attachment))


def upload(payload):
    operation, thread = payload['operation'], payload['threadId']
    if operation == 'upload_start':
        size = payload.get('size')
        if not isinstance(size,int) or not 0<=size<=MAX_FILE:raise ValueError('Attach files up to 20 MiB each.')
        name = re.sub(r'[\x00-\x1f<>:"/\\|?*]', '_', str(payload.get('name') or 'attachment')).strip('. ')[:160] or 'attachment'
        attachment = str(uuid.uuid4());folder = location(thread,attachment);folder.mkdir(parents=True,mode=0o700)
        data={'id':attachment,'name':name,'size':size,'sha256':payload.get('sha256'),'complete':False}
        (folder/'metadata.json').write_text(json.dumps(data));(folder/'upload.part').touch(mode=0o600)
        return data
    folder = location(thread,payload['attachmentId'])
    with (folder/'lock').open('w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        meta = json.loads((folder/'metadata.json').read_text())
        if operation=='upload_chunk':
            data=base64.b64decode(payload['base64'],validate=True)
            if len(data)>49152:raise ValueError('Upload chunk is too large.')
            partial=folder/'upload.part'
            if meta['complete']:raise ValueError('This upload has already finished.')
            if payload['offset']!=partial.stat().st_size:raise ValueError('Upload position mismatch; retry attaching the file.')
            if partial.stat().st_size+len(data)>meta['size']:raise ValueError('Upload exceeds the announced file size.')
            with partial.open('ab') as stream:stream.write(data)
            return {'offset':partial.stat().st_size}
        if operation=='upload_finish':
            if meta['complete']:return meta
            partial=folder/'upload.part';data=partial.read_bytes()
            if len(data)!=meta['size'] or hashlib.sha256(data).hexdigest()!=meta['sha256']:
                raise ValueError('The attachment transfer is incomplete; retry attaching it.')
            (folder/'files').mkdir(mode=0o700,exist_ok=True)
            path=folder/'files'/meta['name'];partial.replace(path);path.chmod(0o600)
            image = data.startswith((b'\x89PNG\r\n\x1a\n',b'\xff\xd8\xff')) or (data.startswith(b'RIFF') and data[8:12]==b'WEBP')
            meta.update(complete=True,path=str(path),kind='image' if image else 'file')
            (folder/'metadata.json').write_text(json.dumps(meta));return meta
    raise ValueError('Unknown upload operation.')


def selected(thread, ids):
    if not isinstance(ids,list) or len(ids)>8:raise ValueError('Attach at most eight files per message.')
    result=[]
    for attachment in ids:
        folder=location(thread,attachment)
        meta=json.loads((folder/'metadata.json').read_text())
        if not meta.get('complete') or not Path(meta['path']).is_file():raise ValueError('An attachment is not ready. Attach it again.')
        result.append(meta)
    return result
