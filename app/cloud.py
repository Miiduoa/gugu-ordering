"""Password-gated Render staging. This entrypoint deliberately refuses live mode."""
import asyncio
from contextlib import asynccontextmanager
import hashlib
import hmac
import html
import os
import secrets
import time
from urllib.parse import parse_qs

from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, RedirectResponse, PlainTextResponse
from . import config, db, security
from .main import app as core, lifespan as core_lifespan

COOKIE = 'gugu_test_access'
TTL = 8 * 60 * 60


def validate_environment():
    if config.MODE != 'demo':
        raise RuntimeError('The cloud staging entrypoint cannot run in live mode')
    for key in ('STAGING_PASSWORD_HASH', 'INITIAL_OWNER_PASSWORD_HASH'):
        if not os.getenv(key, '').startswith('$argon2id$'):
            raise RuntimeError(f'{key} must be an Argon2id password hash')
    if not config.SECURE or not config.PUBLIC_ORIGIN.startswith('https://'):
        raise RuntimeError('Staging requires HTTPS and secure cookies')
    if '*' in config.HOSTS:
        raise RuntimeError('Use an explicit host allowlist')


def signature(value):
    return hmac.new(config.secret_key().encode(), ('staging:'+value).encode(), hashlib.sha256).hexdigest()


def issue_ticket():
    payload = f'{int(time.time())}.{secrets.token_hex(16)}'
    return payload + '.' + signature(payload)


def valid_ticket(ticket):
    try:
        if len(ticket) > 180:
            return False
        issued, nonce, mac = ticket.split('.')
        age = int(time.time()) - int(issued)
        return 0 <= age < TTL and len(nonce) == 32 and hmac.compare_digest(signature(issued+'.'+nonce), mac)
    except (ValueError, TypeError):
        return False


def gate_page(error=''):
    message = f'<p class="error" role="alert">{html.escape(error)}</p>' if error else ''
    return '''<!doctype html><html lang="zh-Hant"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">
<title>穀穀健康廚房・測試入口</title><style>
*{box-sizing:border-box}body{margin:0;background:#f6f5ef;color:#20342d;font:16px/1.7 -apple-system,BlinkMacSystemFont,"Noto Sans TC",sans-serif;min-height:100dvh;display:grid;place-items:center;padding:24px}
main{width:min(100%,440px);background:white;border:1px solid #dfe5dd;border-radius:20px;padding:clamp(24px,6vw,42px);box-shadow:0 15px 50px #20342d0a}
small{font-weight:700;letter-spacing:.15em;color:#677967}h1{font-size:28px;line-height:1.4;margin:12px 0}p{color:#627269}label{display:block;font-weight:650;margin:26px 0 8px}
input,button{font:inherit;width:100%;min-height:48px;border-radius:10px}input{border:1px solid #b3c0b2;padding:10px 12px}button{margin-top:18px;background:#284d3c;color:white;border:0;font-weight:700;cursor:pointer}input:focus,button:focus-visible{outline:3px solid #96b3a1;outline-offset:3px}.notice{margin:24px 0 0;padding-top:20px;border-top:1px solid #e6ebe3;font-size:14px}.error{color:#a33428}</style>
<main><small>PRIVATE TEST ENVIRONMENT</small><h1>穀穀健康廚房<br>點餐系統測試</h1><p>這裡不是正式點餐網站。請使用提供給你的測試密碼進入。</p>'''+message+'''
<form method="post" action="/test-access"><label for="password">測試入口密碼</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128" autofocus><button type="submit">進入測試系統</button></form><p class="notice">僅供操作驗收，請勿填入真實個資。所有訂單均為測試，不會通知店家或實際出餐；資料可能在休眠或重新部署後清除。</p></main></html>'''


class StagingGate:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        request = Request(scope, receive)
        path = scope['path']
        headers = {'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow',
                   'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
                   'Referrer-Policy': 'no-referrer',
                   'Strict-Transport-Security': 'max-age=31536000',
                   'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"}
        # Health checks contain no customer data and are the only public API.
        if path == '/api/health' and request.method in ('GET', 'HEAD'):
            return await self.app(scope, receive, send)
        if request.headers.get('host', '').split(':')[0] not in config.HOSTS:
            return await PlainTextResponse('Invalid host', status_code=400, headers=headers)(scope, receive, send)
        if path == '/robots.txt':
            return await PlainTextResponse('User-agent: *\nDisallow: /\n', headers=headers)(scope, receive, send)
        if path == '/test-access':
            if request.method == 'GET':
                response = HTMLResponse(gate_page(), headers=headers)
            elif request.method == 'POST':
                origin = request.headers.get('origin')
                if origin and origin != config.PUBLIC_ORIGIN:
                    return await PlainTextResponse('Invalid origin', status_code=403, headers=headers)(scope, receive, send)
                if request.headers.get('content-type', '').split(';')[0] != 'application/x-www-form-urlencoded':
                    return await PlainTextResponse('Unsupported form', status_code=415, headers=headers)(scope, receive, send)
                data = bytearray()
                async for chunk in request.stream():
                    data.extend(chunk)
                    if len(data) > 2048:
                        return await PlainTextResponse('Form too large', status_code=413, headers=headers)(scope, receive, send)
                try:
                    security.rate_limit('staging-gate:'+security.peer(request), 12, 600)
                except Exception as exc:
                    if getattr(exc, 'status_code', None) != 429:
                        raise
                    return await HTMLResponse(gate_page('嘗試次數過多，請稍後再試。'), status_code=429,
                                              headers={**headers, 'Retry-After': '600'})(scope, receive, send)
                try:
                    value = parse_qs(data.decode('utf-8'), max_num_fields=3).get('password', [''])[0]
                except (UnicodeError, ValueError):
                    value = ''
                valid = len(value) <= 128 and await asyncio.to_thread(
                    security.verify_password, os.environ['STAGING_PASSWORD_HASH'], value)
                if valid:
                    response = RedirectResponse('/', status_code=303, headers=headers)
                    response.set_cookie(COOKIE, issue_ticket(), max_age=TTL, httponly=True,
                                        secure=True, samesite='strict', path='/')
                else:
                    response = HTMLResponse(gate_page('密碼不正確，請重新輸入。'), status_code=401, headers=headers)
            else:
                response = PlainTextResponse('Method not allowed', status_code=405, headers=headers)
            return await response(scope, receive, send)
        if not valid_ticket(request.cookies.get(COOKIE, '')):
            if path.startswith('/api/'):
                response = JSONResponse({'detail': '僅限授權測試，請先輸入測試入口密碼。'}, status_code=403, headers=headers)
            else:
                response = RedirectResponse('/test-access', status_code=303, headers=headers)
            return await response(scope, receive, send)
        return await self.app(scope, receive, send)


@asynccontextmanager
async def staging_lifespan(app):
    validate_environment()
    db.initialize()
    with db.transaction() as c:
        # Bootstrap only on a fresh staging database. Never overwrite a changed password.
        if not c.execute("SELECT 1 FROM users WHERE username='owner'").fetchone():
            c.execute('INSERT INTO users(username,name,role,password_hash,created_at) VALUES(?,?,?,?,?)',
                      ('owner', '測試管理者', 'owner', os.environ['INITIAL_OWNER_PASSWORD_HASH'],
                       time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())))
    async with core_lifespan(app):
        yield


core.router.lifespan_context = staging_lifespan
app = StagingGate(core)
