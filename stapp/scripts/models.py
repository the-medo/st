"""Install checksum-pinned speech assets. Python is used only by the Linux installer."""
import hashlib
import json
import shutil
import sys
import tarfile
import urllib.request
from pathlib import Path


def install(root, assets=None):
    assets = assets or Path(__file__).resolve().parents[1]/'assistant/audio'
    root.mkdir(parents=True, exist_ok=True)
    for model in json.loads((assets/'models.json').read_text()):
        path = root/model['file']
        if not path.exists():
            temp = path.with_suffix('.download')
            urllib.request.urlretrieve(model['url'],temp)
            if hashlib.file_digest(temp.open('rb'),'sha256').hexdigest()!=model['sha256']:
                temp.unlink();raise RuntimeError('Model checksum mismatch: '+model['file'])
            temp.replace(path)
        with path.open('rb') as stream:
            if hashlib.file_digest(stream,'sha256').hexdigest()!=model['sha256']:
                raise RuntimeError('Model checksum mismatch; remove and retry: '+str(path))
        if 'directory' in model:
            marker=root/model['directory']/'.st-verified'
            if not marker.exists() or marker.read_text()!=model['sha256']:
                with tarfile.open(path) as archive:archive.extractall(root,filter='data')
                marker.write_text(model['sha256'])
    shutil.copy2(assets/'st-keywords.txt',root/'st-keywords.txt')

if __name__=='__main__':
    install(Path(sys.argv[1]),Path(sys.argv[2]) if len(sys.argv)>2 else None)
