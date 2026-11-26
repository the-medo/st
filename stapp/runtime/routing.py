"""Clef Flash context hints. A failed classifier never loses or authorizes a request."""
import concurrent.futures
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import hashlib
import json
import math
import os
from pathlib import Path
import re
import threading
import time
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError('Classifier redirects are disabled')


def catalog_path():
    return Path(os.getenv('STAPP_ROUTING_CATALOG', Path(os.environ.get('STAPP_DATA', Path.home()/'.local/share/stapp'))/'assistant/routing/catalog.json'))


def load_catalog():
    catalog = json.loads(catalog_path().read_text())
    ids = [r['id'] for r in catalog['routes']]
    if len(ids) != len(set(ids)) or 'other' not in ids:
        raise ValueError('Invalid capability catalog')
    return catalog


class Router:
    def __init__(self, config=None, opener=None, deadline=2):
        self.config = Path(config or os.getenv('STAPP_CF_CONFIG', Path.home()/'.config/st-assistant/cloudflare.json'))
        self.opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        self.deadline = deadline
        self.pool = concurrent.futures.ThreadPoolExecutor(max_workers=1, thread_name_prefix='clef')
        self.lock = threading.Lock()
        self.pending = None
        self.retry_at = 0
        self.bad_credential = None
        self.health = {'status': 'not_checked'}

    def credentials(self):
        config = json.loads(self.config.read_text())
        account = config['account_id']
        if not re.fullmatch('[a-f0-9]{32}', account):
            raise ValueError('Invalid account')
        path = Path(config['api_token_file']).expanduser()
        if not path.is_absolute():
            path = self.config.parent/path
        token = path.read_text().strip()
        if not token or any(c.isspace() for c in token):
            raise ValueError('Invalid token')
        return account, token, hashlib.sha256((account+token).encode()).digest()

    def _request(self, account, token, body):
        url = f'https://api.cloudflare.com/client/v4/accounts/{account}/ai/run/@cf/cloudflare/clef-flash'
        req = urllib.request.Request(url, data=body, headers={'Authorization': 'Bearer '+token, 'Content-Type': 'application/json'})
        with self.opener.open(req, timeout=self.deadline) as response:
            raw = response.read(256_001)
            if len(raw) > 256_000:
                raise ValueError('Oversized response')
            envelope = json.loads(raw)
        if envelope.get('success') is not True:
            raise ValueError('Rejected response')
        return envelope['result']

    def decide(self, job, catalog):
        start = time.monotonic()
        result = {'provider': 'cloudflare', 'model': 'clef-flash', 'catalog_version': catalog['catalog_version'],
                  'effective_route': 'other', 'role': 'advisory'}
        def finish(reason, **extra):
            result.update(reason=reason, elapsed_ms=round((time.monotonic()-start)*1000, 2), **extra)
            self.health = {'status': reason, 'checked_at': datetime.now(timezone.utc).isoformat()}
            return result
        if job.get('thread'):
            return finish('continuation')
        if job.get('project') != 'assistant':
            return finish('project', effective_route='agents')
        if os.getenv('STAPP_ROUTER', 'clef-flash') == 'disabled':
            return finish('disabled')
        criteria = {r['id']: r['description'] for r in catalog['routes']}
        body = json.dumps({'model': 'clef-flash', 'state': job['text'], 'questions': {'route': {
            'type': 'choice', 'instructions': catalog['instructions'], 'criteria': criteria}}}, ensure_ascii=False).encode()
        # Conservative byte bound includes state and criteria, leaving 4,576 tokens
        # for framing. Never truncate a transcript to fit the 24,576-token window.
        if len(body) > 20_000:
            return finish('input_budget')
        try:
            account, token, fingerprint = self.credentials()
        except (OSError, KeyError, ValueError, TypeError):
            return finish('missing_or_invalid_credentials')
        with self.lock:
            if self.bad_credential == fingerprint:
                return finish('authentication')
            if time.monotonic() < self.retry_at:
                return finish('backoff')
            if self.pending is not None and not self.pending.done():
                return finish('busy')
            self.pending = future = self.pool.submit(self._request, account, token, body)
        try:
            raw = future.result(timeout=max(.001, self.deadline-(time.monotonic()-start)))
            answer = raw['answers']['route']
            probabilities = answer['probabilities']
            if raw.get('truncated') or set(probabilities) != set(criteria):
                raise ValueError('Invalid labels or truncation')
            if any(isinstance(p,bool) or not isinstance(p,(int,float)) or not math.isfinite(p) or not 0 <= p <= 1 for p in probabilities.values()):
                raise ValueError('Invalid probabilities')
            ranked = sorted(probabilities.values(), reverse=True)
            choice = answer['choice']
            if abs(sum(ranked)-1) > .02 or choice not in criteria or probabilities[choice] != ranked[0]:
                raise ValueError('Invalid choice')
            policy = catalog['provisional_policy']
            uncertain = ranked[0] < policy['minimum_probability'] or ranked[0]-ranked[1] < policy['minimum_margin']
            return finish('uncertain' if uncertain else 'classified', raw_choice=choice,
                          effective_route='other' if uncertain else choice, probabilities=probabilities,
                          usage=raw.get('usage', {}))
        except urllib.error.HTTPError as error:
            if error.code in (401,403):
                self.bad_credential = fingerprint
                return finish('authentication', http_status=error.code)
            delay = 30
            if error.code == 429:
                value = error.headers.get('Retry-After', '30')
                try:
                    delay = max(1,float(value))
                except ValueError:
                    try: delay = max(1,(parsedate_to_datetime(value)-datetime.now(timezone.utc)).total_seconds())
                    except (ValueError,TypeError): pass
            self.retry_at = time.monotonic()+min(delay,86400)
            return finish('rate_limit' if error.code == 429 else 'provider_error', http_status=error.code)
        except concurrent.futures.TimeoutError:
            self.retry_at = time.monotonic()+5
            return finish('timeout')
        except Exception:
            self.retry_at = time.monotonic()+5
            return finish('invalid_or_unavailable')


ROUTER = Router()


def build_context(job, decision, catalog):
    selected = next((r for r in catalog['routes'] if r['id']==decision['effective_route']), next(r for r in catalog['routes'] if r['id']=='other'))
    # Only trusted packaged manuals, never model-generated paths or transcript paths.
    root = Path(os.getenv('STAPP_MANUALS', Path(job['cwd'])/'manuals')).resolve()
    excerpts = []
    remaining = 6000
    for manual in selected.get('manuals', []):
        relative = Path(manual)
        if relative.is_absolute() or '..' in relative.parts or relative.suffix != '.md':
            continue
        path = (root/relative).resolve()
        if not path.is_relative_to(root) or not path.is_file():
            continue
        text = path.read_text()[:remaining]
        excerpts.append({'source': manual, 'text': text})
        remaining -= len(text)
        if remaining <= 0: break
    return {'transcript': job['text'], 'request_id': job['id'], 'origin_device': job['device'],
            'received_at': datetime.now(timezone.utc).isoformat(), 'timezone': os.getenv('TZ','Europe/Paris'),
            'routing': decision, 'initial_context': excerpts,
            'capabilities': [{'id':r['id'],'description':r['description'],'status':r['status']} for r in catalog['routes']],
            'instructions': 'Routing is advisory. Preserve the complete request. Use discover_capability for other domains. Use ST tools for confirmed changes. Unavailable adapters must be reported honestly. Return display_text, concise speech_text (at most 45 words), and status.'}
