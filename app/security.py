"""Opaque sessions, per-session CSRF protection, and persisted rate limits."""
import hashlib
import hmac
import secrets
import time
import threading
from datetime import datetime, timezone
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from fastapi import HTTPException, Request
from . import config, db

hasher = PasswordHasher(time_cost=2, memory_cost=65536, parallelism=2)
DUMMY_HASH = hasher.hash(secrets.token_urlsafe(32))
# Bound concurrent Argon2 memory use on a small, single-store host.
PASSWORD_SLOTS = threading.BoundedSemaphore(2)

def hash_password(value):
    with PASSWORD_SLOTS:
        return hasher.hash(value)

def digest(value: str) -> str:
    return hashlib.sha256(value.encode()).hexdigest()

def keyed(value: str) -> str:
    return hmac.new(config.secret_key().encode(), value.encode(), hashlib.sha256).hexdigest()

def tracking_token(idempotency_key: str) -> str:
    return keyed('tracking:'+idempotency_key)

def verify_password(stored, supplied):
    try:
        with PASSWORD_SLOTS:
            return hasher.verify(stored,supplied)
    except (VerificationError, InvalidHashError):
        return False

def rate_limit(key: str, limit: int, seconds: int):
    now=int(time.time())
    bucket=keyed('rate:'+key)
    with db.transaction() as c:
        row=c.execute('SELECT * FROM rate_limits WHERE bucket=?',(bucket,)).fetchone()
        if row and row['expires']>now:
            if row['count']>=limit:
                raise HTTPException(429,'操作太頻繁，請稍候再試',headers={'Retry-After':str(row['expires']-now)})
            c.execute('UPDATE rate_limits SET count=count+1 WHERE bucket=?',(bucket,))
        else:
            c.execute('INSERT OR REPLACE INTO rate_limits(bucket,count,expires) VALUES(?,1,?)',(bucket,now+seconds))

def peer(request: Request):
    # Uvicorn resolves trusted proxy addresses. Never trust arbitrary forwarded headers here.
    return request.client.host if request.client else 'unknown'

def session(request: Request, roles=('owner','cashier','kitchen')):
    token=request.cookies.get('gugu_session','')
    if not token or len(token)>200: raise HTTPException(401,'請先登入店家工作台')
    with db.read() as c:
        row=c.execute('SELECT u.id,u.username,u.name,u.role,s.csrf FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>? AND u.active=1',
                      (digest(token),int(time.time()))).fetchone()
    if not row: raise HTTPException(401,'登入已逾時，請重新登入')
    if row['role'] not in roles: raise HTTPException(403,'這個帳號沒有此操作權限')
    if request.method not in ('GET','HEAD'):
        provided=request.headers.get('x-csrf-token','')
        if not hmac.compare_digest(provided,row['csrf']): raise HTTPException(403,'驗證失敗，請重新整理後再試')
    return dict(row)

def add_user(username,name,role,password):
    stamp=datetime.now(timezone.utc).isoformat()
    with db.transaction() as c:
        c.execute('INSERT INTO users(username,name,role,password_hash,created_at) VALUES(?,?,?,?,?)',
                  (username,name,role,hash_password(password),stamp))

class BodyLimitMiddleware:
    """Cap streamed request bodies before JSON parsing, not only Content-Length."""
    def __init__(self, app, limit=65536): self.app,self.limit=app,limit
    async def __call__(self, scope, receive, send):
        if scope['type']!='http' or scope['method'] in ('GET','HEAD','OPTIONS'):
            return await self.app(scope,receive,send)
        chunks=[]; total=0
        while True:
            message=await receive()
            if message['type']=='http.disconnect': return
            chunk=message.get('body',b''); total+=len(chunk)
            if total>self.limit:
                from starlette.responses import JSONResponse
                return await JSONResponse({'detail':'送出內容過大'},status_code=413)(scope,receive,send)
            chunks.append(chunk)
            if not message.get('more_body'): break
        sent=False
        async def buffered_receive():
            nonlocal sent
            if not sent:
                sent=True
                return {'type':'http.request','body':b''.join(chunks),'more_body':False}
            return await receive()
        await self.app(scope,buffered_receive,send)
