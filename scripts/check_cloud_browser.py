"""Native HTTPS browser acceptance; uses only disposable synthetic data.

The local certificate is trusted only in these isolated browser contexts.
The public Render smoke check uses normal TLS verification and no credentials.
"""
import json
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import time

import httpx
from argon2 import PasswordHasher
from playwright.sync_api import sync_playwright, expect

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'test-artifacts'
OUT.mkdir(exist_ok=True)
PUBLIC = 'https://gugu-ordering-staging.onrender.com'
BASE = 'https://127.0.0.1:8766'
checks = []
errors = []


def record(name):
    checks.append(name)
    print('PASS:', name, flush=True)


with tempfile.TemporaryDirectory(prefix='gugu-cloud-browser-') as tmp:
    folder = Path(tmp)
    entry, owner = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
    hasher = PasswordHasher(time_cost=2, memory_cost=65536, parallelism=2)
    env = {**os.environ, 'APP_MODE': 'demo', 'COOKIE_SECURE': '1',
           'PUBLIC_ORIGIN': BASE, 'ALLOWED_HOSTS': '127.0.0.1',
           'DATA_DIR': tmp, 'DATABASE_PATH': str(folder / 'test.sqlite3'),
           'SECRET_KEY': secrets.token_urlsafe(48),
           'STAGING_PASSWORD_HASH': hasher.hash(entry),
           'INITIAL_OWNER_PASSWORD_HASH': hasher.hash(owner)}
    cert, key = folder / 'cert.pem', folder / 'key.pem'
    subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                    '-keyout', str(key), '-out', str(cert), '-days', '1',
                    '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'],
                   check=True, capture_output=True)
    with (OUT / 'cloud-server.log').open('w') as log:
        process = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'app.cloud:app',
                    '--host', '127.0.0.1', '--port', '8766', '--no-access-log',
                    '--ssl-keyfile', str(key), '--ssl-certfile', str(cert)],
                    cwd=ROOT, env=env, stdout=log, stderr=log)
        try:
            with httpx.Client(base_url=BASE, verify=False, timeout=2) as local:
                for attempt in range(100):
                    try:
                        if local.get('/api/health').status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    time.sleep(.15)
                else:
                    raise RuntimeError('Local HTTPS test server did not start')
            with sync_playwright() as p:
                browser = p.chromium.launch(headless=True)
                mobile = browser.new_context(viewport={'width': 390, 'height': 844},
                    is_mobile=True, has_touch=True, locale='zh-TW',
                    timezone_id='Asia/Taipei', ignore_https_errors=True)
                staff = browser.new_context(viewport={'width': 1440, 'height': 1000},
                    locale='zh-TW', timezone_id='Asia/Taipei', ignore_https_errors=True)
                phone, desk = mobile.new_page(), staff.new_page()
                for page in (phone, desk):
                    page.on('pageerror', lambda error: errors.append(str(error)))
                    page.goto(BASE + '/')
                    expect(page.locator('h1')).to_contain_text('點餐系統測試')
                    assert '/test-access' in page.url
                    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
                phone.screenshot(path=str(OUT / 'gate-mobile.png'), full_page=True)
                assert mobile.request.post(BASE + '/api/orders', data={}).status == 403
                record('Anonymous browser is gated and cannot create orders')
                phone.locator('input[name=password]').fill('invalid-test-password')
                phone.locator('button[type=submit]').click()
                expect(phone.locator('[role=alert]')).to_contain_text('密碼不正確')
                for page in (phone, desk):
                    page.locator('input[name=password]').fill(entry)
                    page.locator('button[type=submit]').click()
                    expect(page.locator('.meal-card')).to_have_count(8)
                ticket = next(c for c in mobile.cookies() if c['name'] == 'gugu_test_access')
                assert ticket['secure'] and ticket['httpOnly'] and ticket['sameSite'] == 'Strict'
                record('Native HTTPS gate login, Secure HttpOnly cookie, CSS and JavaScript work')
                phone.screenshot(path=str(OUT / 'customer-mobile.png'), full_page=True)
                desk.screenshot(path=str(OUT / 'customer-desktop.png'), full_page=True)
                phone.locator('#pickup-day').select_option(index=1)
                phone.locator('[data-action=product][data-id=pork]').click()
                phone.locator('input[name=choice-rice][value=half]').check()
                phone.locator('#product-form input[name=note]').fill('測試訂單，不需要餐具')
                phone.locator('#product-form button[type=submit]').click()
                phone.locator('[data-action=mobile-cart]').click()
                phone.locator('#mobile-cart-dialog [data-action=checkout]').click()
                phone.locator('#checkout-form input[name=consent]').check()
                phone.screenshot(path=str(OUT / 'checkout-mobile.png'), full_page=True)
                phone.locator('#checkout-form button[type=submit]').click()
                expect(phone.locator('.ticket-number')).to_have_text('A001')
                day = phone.evaluate('state.track.day')
                record('Mobile order customization, checkout, database write and private tracking work')
                desk.goto(BASE + '/staff/')
                expect(desk.locator('#login-form')).to_be_visible()
                desk.locator('input[name=username]').fill('owner')
                desk.locator('input[name=password]').fill(owner)
                desk.locator('#login-form button[type=submit]').click()
                expect(desk.locator('#staff-day')).to_be_visible()
                desk.locator('#staff-day').fill(day)
                desk.locator('#staff-day').dispatch_event('change')
                expect(desk.locator('.order-card')).to_have_count(1)
                session = next(c for c in staff.cookies() if c['name'] == 'gugu_session')
                assert session['secure'] and session['httpOnly']
                desk.screenshot(path=str(OUT / 'staff-desktop.png'), full_page=True)
                record('Independent staff login and browser session see the customer order')
                for command in ('accept', 'prepare', 'ready'):
                    desk.locator(f'[data-command={command}]').click()
                    time.sleep(.2)
                expect(phone.locator('.ticket-top strong')).to_have_text('可以取餐', timeout=15000)
                record('Accept, prepare and ready statuses synchronize to customer browser')
                desk.locator('[data-command=pay]').click()
                desk.locator('#action-form input[name=confirm_cash]').check()
                desk.locator('#action-form button[type=submit]').click()
                desk.locator('[data-command=complete]').click()
                expect(phone.locator('.ticket-top strong')).to_have_text('已取餐', timeout=15000)
                phone.reload()
                expect(phone.locator('.ticket-top strong')).to_have_text('已取餐')
                phone.screenshot(path=str(OUT / 'tracking-mobile.png'), full_page=True)
                record('Cash confirmation, handover and reload retain the completed order')
                for tab in ('inventory', 'reports', 'settings', 'users', 'audit'):
                    desk.locator(f'[data-tab={tab}]').click()
                    expect(desk.locator('#staff-content')).not_to_have_text('正在讀取…')
                    assert 'undefined' not in desk.locator('#staff-content').inner_text()
                record('Inventory, reports, business settings, staff and audit screens load')
                assert not errors, errors
                record('No unhandled JavaScript errors in customer or staff browser')
                # Public deployed service: never pass a credential or create an order.
                public = browser.new_context(viewport={'width': 390, 'height': 844},
                    locale='zh-TW', timezone_id='Asia/Taipei')
                live = public.new_page()
                live.goto(PUBLIC + '/test-access', wait_until='domcontentloaded', timeout=120000)
                expect(live.locator('h1')).to_contain_text('點餐系統測試')
                assert live.evaluate('document.documentElement.scrollWidth <= innerWidth')
                health = public.request.get(PUBLIC + '/api/health', timeout=120000)
                assert health.status == 200 and health.json()['mode'] == 'demo'
                assert public.request.get(PUBLIC + '/api/menu').status == 403
                assert public.request.post(PUBLIC + '/api/orders', data={}).status == 403
                assert public.request.get(PUBLIC + '/robots.txt').text().strip().endswith('Disallow: /')
                live.screenshot(path=str(OUT / 'render-live-gate-mobile.png'), full_page=True)
                record('Public Render HTTPS, demo health, mobile gate and anonymous-order rejection verified')
                browser.close()
        finally:
            process.terminate()
            process.wait(timeout=10)
(OUT / 'cloud-browser-results.json').write_text(json.dumps({
    'passed': len(checks), 'checks': checks, 'javascript_errors': errors,
    'transport': 'native Chromium browser HTTPS',
    'scope': 'Authenticated full flow uses isolated local HTTPS with disposable data. Public Render URL verified anonymously; no real orders or customer data used.'
}, ensure_ascii=False, indent=2))
print(json.dumps({'passed': len(checks), 'checks': checks}, ensure_ascii=False, indent=2))
