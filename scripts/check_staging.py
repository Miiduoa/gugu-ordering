"""Run isolated HTTPS-cookie and access-gate checks without a network connection."""
import json
import os
from pathlib import Path
import sys
import tempfile
from argon2 import PasswordHasher

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
PASSWORD = 'test-entry-only-7cZ6yKfx'
OWNER = 'test-owner-only-hR3py57n'
hasher = PasswordHasher(time_cost=2, memory_cost=65536, parallelism=2)
checks = []

def check(name, value):
    if not value:
        raise AssertionError(name)
    checks.append(name)

with tempfile.TemporaryDirectory(prefix='gugu-gate-check-') as tmp:
    os.environ.update(APP_MODE='demo', DATA_DIR=tmp, COOKIE_SECURE='1',
                      PUBLIC_ORIGIN='https://testserver', ALLOWED_HOSTS='testserver',
                      SECRET_KEY='automated-test-only-'+'s'*48,
                      STAGING_PASSWORD_HASH=hasher.hash(PASSWORD),
                      INITIAL_OWNER_PASSWORD_HASH=hasher.hash(OWNER))
    from fastapi.testclient import TestClient
    from app.cloud import app, valid_ticket, issue_ticket, validate_environment
    from app import config, db
    with TestClient(app, base_url='https://testserver', follow_redirects=False) as client:
        check('public health', client.get('/api/health').json()['mode'] == 'demo')
        check('anonymous menu blocked', client.get('/api/menu').status_code == 403)
        check('anonymous order blocked', client.post('/api/orders', json={}).status_code == 403)
        check('homepage gated', client.get('/').status_code == 303)
        check('staff gated', client.get('/staff/').status_code == 303)
        check('noindex', client.get('/test-access').headers.get('x-robots-tag') == 'noindex, nofollow')
        check('crawler blocked', 'Disallow: /' in client.get('/robots.txt').text)
        check('bad host blocked', client.get('/test-access', headers={'host':'evil.example'}).status_code == 400)
        check('bad origin blocked', client.post('/test-access', data={'password':PASSWORD}, headers={'origin':'https://evil.example'}).status_code == 403)
        check('oversized form blocked', client.post('/test-access', data={'password':'x'*3000}).status_code == 413)
        check('bad password denied', client.post('/test-access', data={'password':'wrong'}).status_code == 401)
        response = client.post('/test-access', data={'password':PASSWORD}, headers={'origin':'https://testserver'})
        check('entry accepted', response.status_code == 303)
        cookie = response.headers['set-cookie'].lower()
        check('secure entry cookie', all(x in cookie for x in ('secure','httponly','samesite=strict')))
        check('menu unlocked', len(client.get('/api/menu').json()['products']) > 0)
        check('html loaded', client.get('/').status_code == 200)
        check('css loaded', client.get('/static/app.css').status_code == 200)
        check('javascript loaded', client.get('/static/app.js').status_code == 200)
        check('staff still requires login', client.get('/api/auth/me').status_code == 401)
        headers = {'X-Requested-With':'Gugu','Origin':'https://testserver'}
        response = client.post('/api/auth/login', json={'username':'owner','password':OWNER}, headers=headers)
        check('independent owner login', response.status_code == 200 and response.json()['user']['role'] == 'owner')
        check('secure owner session', 'secure' in response.headers['set-cookie'].lower())
        check('authenticated session valid', client.get('/api/auth/me').status_code == 200)
        check('ticket verified', valid_ticket(issue_ticket()))
        check('forged ticket blocked', not valid_ticket('0.'+'a'*32+'.'+'b'*64))
        previous = config.MODE
        config.MODE = 'live'
        try:
            validate_environment()
            raise AssertionError('live mode was allowed')
        except RuntimeError:
            checks.append('live mode refused')
        finally:
            config.MODE = previous
    with TestClient(app, base_url='https://testserver') as client:
        with db.read() as c:
            check('restart does not duplicate owner', c.execute("SELECT COUNT(*) FROM users WHERE username='owner'").fetchone()[0] == 1)
print(json.dumps({'passed':len(checks),'checks':checks}, ensure_ascii=False, indent=2))
