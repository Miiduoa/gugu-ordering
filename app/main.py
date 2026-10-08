from contextlib import asynccontextmanager
from datetime import date, timedelta
from io import BytesIO, StringIO
from pathlib import Path
import asyncio
import csv
import html
import json
import logging
import secrets
import sqlite3
import time
import uuid
from fastapi import FastAPI, Request, HTTPException, Query
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse, FileResponse, Response, HTMLResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware
from . import config, db, service as svc, security as sec
from .schemas import (OrderInput, TokenInput, CancelInput, LoginInput, PasswordInput,
                      ActionInput, ProductInput, StockInput, SettingsInput, PauseInput,
                      UserInput, UserUpdate)

log=logging.getLogger('gugu')
ROOT=config.ROOT

async def housekeeping():
    while True:
        await asyncio.sleep(30)
        try: await asyncio.to_thread(svc.maintenance)
        except Exception: log.exception('Maintenance failed; check persistent disk and database health')

@asynccontextmanager
async def lifespan(app):
    db.initialize(); config.secret_key()
    task=asyncio.create_task(housekeeping())
    yield
    task.cancel()
    try: await task
    except asyncio.CancelledError: pass

app=FastAPI(title='穀穀點餐 API',version='1.0.0',lifespan=lifespan,docs_url=None,redoc_url=None,openapi_url=None)
app.add_middleware(TrustedHostMiddleware,allowed_hosts=config.HOSTS)
app.add_middleware(sec.BodyLimitMiddleware)

@app.middleware('http')
async def guards(request,call_next):
    if request.url.path.startswith('/api/') and request.method not in ('GET','HEAD','OPTIONS'):
        origins={config.PUBLIC_ORIGIN}
        if config.MODE=='demo': origins.add(str(request.base_url).rstrip('/'))
        origin=request.headers.get('origin')
        if origin and origin not in origins:
            return JSONResponse({'detail':'不允許跨網站操作'},status_code=403)
        if request.headers.get('x-requested-with')!='Gugu':
            return JSONResponse({'detail':'缺少請求驗證標頭'},status_code=403)
        if request.headers.get('content-type','').split(';')[0]!='application/json':
            return JSONResponse({'detail':'請使用 JSON 格式'},status_code=415)
    response=await call_next(request)
    response.headers['X-Content-Type-Options']='nosniff'
    response.headers['X-Frame-Options']='DENY'
    response.headers['Referrer-Policy']='no-referrer'
    response.headers['Permissions-Policy']='camera=(), microphone=(), geolocation=()'
    response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'"
    if request.url.path.startswith('/api/') or request.url.path.startswith('/staff'):
        response.headers['Cache-Control']='no-store'
    if config.MODE=='demo': response.headers['X-Robots-Tag']='noindex, nofollow'
    if config.SECURE: response.headers['Strict-Transport-Security']='max-age=31536000'
    return response

@app.exception_handler(RequestValidationError)
async def validation_error(request,exc):
    errors=exc.errors()
    text=str(errors[0].get('msg','資料格式錯誤')).replace('Value error, ','')
    return JSONResponse({'detail':'資料格式不正確：'+text,'fields':['.'.join(str(x) for x in e['loc'][1:]) for e in errors]},status_code=422)

@app.exception_handler(sqlite3.OperationalError)
async def busy_error(request,exc):
    log.error('Database unavailable: %s',type(exc).__name__)
    return JSONResponse({'detail':'系統忙碌，請稍後重試；請勿關閉尚未確認的訂單頁面'},status_code=503,headers={'Retry-After':'3'})

@app.get('/api/health')
def health():
    with db.read() as c: c.execute('SELECT 1').fetchone()
    return {'ok':True,'mode':config.MODE,'version':'1.0.0'}

@app.get('/api/store')
def get_store():
    with db.read() as c: s=db.settings(c)
    return {**s,'mode':config.MODE,'timezone':'Asia/Taipei','today':str(svc.now().date()),'server_time':svc.stamp(),
            'accepting':svc.accepting_now(s),
            'payment_methods':['cash_on_pickup']}

def valid_day(day):
    if not svc.now().date()<=day<=svc.now().date()+timedelta(days=7): svc.fail(422,'日期需在今天至未來 7 天內')

@app.get('/api/menu')
def menu(day:date|None=None):
    day=day or svc.now().date(); valid_day(day)
    with db.read() as c:
        rows=c.execute('SELECT p.*,i.remaining FROM products p LEFT JOIN inventory i ON p.id=i.product_id AND i.day=? WHERE p.active=1 ORDER BY p.sort,p.id',(str(day),)).fetchall()
    return {'day':str(day),'products':[product_json(r) for r in rows]}

def product_json(row):
    p=dict(row); p['options']=json.loads(p['options'])
    if p.get('remaining') is None: p['remaining']=p['daily_stock']
    p['active']=bool(p['active']); p['sold_out']=bool(p['sold_out'])
    return p

@app.get('/api/slots')
def slots(day:date):
    valid_day(day)
    with db.read() as c:
        s=db.settings(c)
        data=svc.slot_list(c,str(day),s) if svc.accepting_now(s) else []
    return {'day':str(day),'slots':data,'unit':'份'}

@app.post('/api/orders',status_code=201)
def create_order(payload:OrderInput,request:Request):
    sec.rate_limit('order:'+sec.peer(request),40,600)
    return svc.create_order(payload)

@app.post('/api/order/track')
def track(payload:TokenInput,request:Request):
    sec.rate_limit('track:'+sec.peer(request),600,60)
    with db.transaction() as c:
        svc.expire_pending(c)
        return svc.serialize(c,svc.get_by_token(c,payload.token))

@app.post('/api/order/cancel')
def cancel(payload:CancelInput,request:Request):
    sec.rate_limit('cancel:'+sec.peer(request),30,60)
    return svc.customer_cancel(payload.token,payload.version)

@app.post('/api/order/qr')
def order_qr(payload:TokenInput,request:Request):
    sec.rate_limit('qr:'+sec.peer(request),30,60)
    with db.read() as c: svc.get_by_token(c,payload.token)
    return qr_response(f'{config.PUBLIC_ORIGIN}/#order={payload.token}')

def qr_response(value):
    import qrcode
    buf=BytesIO(); qrcode.make(value,box_size=8,border=3).save(buf,format='PNG')
    return Response(buf.getvalue(),media_type='image/png',headers={'Cache-Control':'no-store'})

@app.get('/api/board')
def board():
    with db.read() as c:
        rows=c.execute("SELECT number,status,slot FROM orders WHERE day=? AND status IN ('accepted','preparing','ready') ORDER BY slot,id LIMIT 100",(str(svc.now().date()),)).fetchall()
    return {'orders':[dict(r) for r in rows],'time':svc.stamp(),'mode':config.MODE}

@app.post('/api/auth/login')
def login(payload:LoginInput,request:Request):
    sec.rate_limit('login-ip:'+sec.peer(request),15,600)
    sec.rate_limit('login-user:'+payload.username.lower(),8,600)
    with db.read() as c:
        row=c.execute('SELECT * FROM users WHERE username=?',(payload.username,)).fetchone()
    ok=sec.verify_password(row['password_hash'] if row else sec.DUMMY_HASH,payload.password)
    if not ok or not row or not row['active']: svc.fail(401,'帳號或密碼不正確')
    token=secrets.token_urlsafe(40); csrf=secrets.token_urlsafe(32)
    with db.transaction() as c:
        c.execute('INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)',(sec.digest(token),row['id'],csrf,int(time.time())+8*3600))
        svc.event(c,None,row['id'],'login','店家帳號登入')
    response=JSONResponse({'user':{k:row[k] for k in ('id','username','name','role')},'csrf':csrf})
    response.set_cookie('gugu_session',token,max_age=8*3600,httponly=True,secure=config.SECURE,samesite='strict',path='/')
    return response

@app.get('/api/auth/me')
def me(request:Request):
    user=sec.session(request)
    return {'user':{k:v for k,v in user.items() if k!='csrf'},'csrf':user['csrf']}

@app.post('/api/auth/logout')
def logout(request:Request):
    user=sec.session(request)
    with db.transaction() as c:
        c.execute('DELETE FROM sessions WHERE token_hash=?',(sec.digest(request.cookies.get('gugu_session','')),))
    r=JSONResponse({'ok':True}); r.delete_cookie('gugu_session',path='/'); return r

@app.post('/api/auth/password')
def change_password(payload:PasswordInput,request:Request):
    user=sec.session(request)
    sec.rate_limit('password:'+str(user['id']),6,600)
    with db.read() as c: row=c.execute('SELECT password_hash FROM users WHERE id=?',(user['id'],)).fetchone()
    if not sec.verify_password(row['password_hash'],payload.current_password): svc.fail(403,'目前密碼不正確')
    hashed=sec.hash_password(payload.new_password)
    with db.transaction() as c:
        c.execute('UPDATE users SET password_hash=? WHERE id=?',(hashed,user['id']))
        c.execute('DELETE FROM sessions WHERE user_id=?',(user['id'],))
        svc.event(c,None,user['id'],'password_changed','已更新密碼並登出所有裝置')
    r=JSONResponse({'ok':True}); r.delete_cookie('gugu_session',path='/'); return r

@app.get('/api/staff/orders')
def staff_orders(request:Request,day:date|None=None,offset:int=Query(0,ge=0),limit:int=Query(100,ge=1,le=200)):
    user=sec.session(request); day=day or svc.now().date()
    with db.transaction() as c:
        svc.expire_pending(c)
        count=c.execute('SELECT COUNT(*) n FROM orders WHERE day=?',(str(day),)).fetchone()['n']
        rows=c.execute("SELECT * FROM orders WHERE day=? ORDER BY CASE WHEN status IN ('pending','accepted','preparing','ready') THEN 0 ELSE 1 END,slot,id LIMIT ? OFFSET ?",(str(day),limit,offset)).fetchall()
        return {'orders':[svc.serialize(c,r,staff=True,role=user['role']) for r in rows],'total':count,'offset':offset,'limit':limit,'server_time':svc.stamp()}

@app.get('/api/staff/pending-dates')
def pending_dates(request:Request):
    sec.session(request)
    with db.transaction() as c:
        svc.expire_pending(c)
        rows=c.execute("SELECT day,COUNT(*) pending,MAX(id) latest FROM orders WHERE status='pending' GROUP BY day ORDER BY day").fetchall()
        return {'dates':[dict(r) for r in rows]}

@app.post('/api/staff/orders/{public_id}/action')
def staff_action(public_id:str,payload:ActionInput,request:Request):
    return svc.act(public_id,payload,sec.session(request))

@app.get('/api/staff/products')
def staff_products(request:Request,day:date|None=None):
    sec.session(request,('owner','cashier')); day=day or svc.now().date(); valid_day(day)
    with db.read() as c:
        rows=c.execute('SELECT p.*,i.remaining FROM products p LEFT JOIN inventory i ON p.id=i.product_id AND i.day=? ORDER BY p.sort,p.id',(str(day),)).fetchall()
    return {'products':[product_json(r) for r in rows],'day':str(day)}

@app.post('/api/staff/products')
def save_product(payload:ProductInput,request:Request):
    user=sec.session(request,('owner',)); p=payload.model_dump(); p['options']=json.dumps(p['options'],ensure_ascii=False)
    with db.transaction() as c:
        old=c.execute('SELECT * FROM products WHERE id=?',(p['id'],)).fetchone()
        if old:
            if old['version']!=p['version']: svc.fail(409,'餐點已被修改，請重新整理')
            c.execute('UPDATE products SET name=?,description=?,category=?,price=?,daily_stock=?,active=?,sold_out=?,kind=?,options=?,version=version+1 WHERE id=?',
                      tuple(p[k] for k in ('name','description','category','price','daily_stock','active','sold_out','kind','options','id')))
        else:
            if p['version']!=0: svc.fail(409,'餐點不存在')
            c.execute('INSERT INTO products(id,name,description,category,price,daily_stock,active,sold_out,kind,options) VALUES(?,?,?,?,?,?,?,?,?,?)',
                      tuple(p[k] for k in ('id','name','description','category','price','daily_stock','active','sold_out','kind','options')))
        svc.event(c,None,user['id'],'menu_updated',p['id'])
    return {'ok':True}

@app.post('/api/staff/stock')
def stock(payload:StockInput,request:Request):
    user=sec.session(request,('owner','cashier')); valid_day(payload.day)
    with db.transaction() as c:
        p=c.execute('SELECT * FROM products WHERE id=?',(payload.product_id,)).fetchone()
        if not p: svc.fail(404,'餐點不存在')
        old=svc.inventory(c,str(payload.day),p)
        if old!=payload.expected_remaining: svc.fail(409,'庫存剛被其他訂單更新，請重新整理再調整')
        c.execute('UPDATE inventory SET remaining=? WHERE day=? AND product_id=?',(payload.remaining,str(payload.day),payload.product_id))
        svc.event(c,None,user['id'],'stock_updated',f'{payload.day} {payload.product_id}: {old}→{payload.remaining}；{payload.reason}')
    return {'ok':True}

@app.post('/api/staff/settings')
def save_settings(payload:SettingsInput,request:Request):
    user=sec.session(request,('owner',)); s=payload.model_dump(mode='json'); version=s.pop('version')
    with db.transaction() as c:
        old=db.settings(c)
        if old['version']!=version: svc.fail(409,'營業設定已更新，請重新整理')
        if old['slot_minutes']!=s['slot_minutes'] and c.execute("SELECT 1 FROM orders WHERE day>=? AND status IN ('pending','accepted','preparing','ready') LIMIT 1",(str(svc.now().date()),)).fetchone():
            svc.fail(409,'仍有未完成預約，暫時不能變更時段長度')
        if s['verified'] and not c.execute('SELECT 1 FROM products WHERE active=1 LIMIT 1').fetchone(): svc.fail(422,'請先建立正式菜單')
        c.execute('UPDATE settings SET data=?,version=version+1 WHERE id=1',(json.dumps(s,ensure_ascii=False),))
        svc.event(c,None,user['id'],'settings_updated','營業設定已更新')
    return {'ok':True}

@app.post('/api/staff/pause')
def pause(payload:PauseInput,request:Request):
    user=sec.session(request,('owner','cashier'))
    with db.transaction() as c:
        s=db.settings(c)
        if s.pop('version')!=payload.version: svc.fail(409,'設定已更新，請重新整理')
        s['paused']=payload.paused
        c.execute('UPDATE settings SET data=?,version=version+1 WHERE id=1',(json.dumps(s,ensure_ascii=False),))
        svc.event(c,None,user['id'],'paused' if payload.paused else 'resumed','暫停接單' if payload.paused else '恢復接單')
    return {'ok':True}

@app.get('/api/staff/reports')
def reports(request:Request,day:date|None=None):
    sec.session(request,('owner',)); day=day or svc.now().date()
    with db.read() as c:
        rows=c.execute('SELECT * FROM orders WHERE day=?',(str(day),)).fetchall()
        ledger=c.execute("SELECT kind,COALESCE(SUM(amount),0) amount,COUNT(*) n FROM payments WHERE substr(created_at,1,10)=? GROUP BY kind",(str(day),)).fetchall()
        products={}
        for r in rows:
            if r['status']=='completed' and r['payment']=='paid':
                for item in json.loads(r['items']):
                    p=products.setdefault(item['product_id'],{'name':item['name'],'quantity':0,'total':0})
                    p['quantity']+=item['quantity']; p['total']+=item['line_total']
        statuses={state:sum(r['status']==state for r in rows) for state in (*svc.ACTIVE,*svc.TERMINAL)}
        cash=sum(r['amount'] for r in ledger if r['kind']=='cash'); refund=-sum(r['amount'] for r in ledger if r['kind']=='refund')
    return {'day':str(day),'orders':len(rows),'states':statuses,'cash_received':cash,'cash_refunded':refund,'net_cash':cash-refund,
            'completed_total':sum(r['total'] for r in rows if r['status']=='completed' and r['payment']=='paid'),
            'products':sorted(products.values(),key=lambda x:-x['quantity'])}

@app.get('/api/staff/export')
def export(request:Request,day:date|None=None):
    user=sec.session(request,('owner',)); day=day or svc.now().date()
    buf=StringIO(); writer=csv.writer(buf)
    writer.writerow(['取餐日期','取餐號碼','取餐時間','訂單狀態','付款狀態','份數','應收總額','收款時間','退款時間','測試訂單'])
    with db.read() as c:
        for r in c.execute('SELECT * FROM orders WHERE day=? ORDER BY id',(str(day),)):
            writer.writerow([r[k] for k in ('day','number','slot','status','payment','portions','total','payment_at','refund_at','demo')])
    with db.transaction() as c: svc.event(c,None,user['id'],'export',str(day))
    return Response('\ufeff'+buf.getvalue(),media_type='text/csv; charset=utf-8',headers={'Content-Disposition':f'attachment; filename="gugu-orders-{day}.csv"'})

@app.get('/api/staff/users')
def users(request:Request):
    sec.session(request,('owner',))
    with db.read() as c: rows=c.execute('SELECT id,username,name,role,active FROM users ORDER BY id').fetchall()
    return {'users':[dict(r) for r in rows]}

@app.post('/api/staff/users')
def new_user(payload:UserInput,request:Request):
    user=sec.session(request,('owner',))
    try: sec.add_user(payload.username,payload.name,payload.role,payload.password)
    except sqlite3.IntegrityError: svc.fail(409,'此帳號已存在')
    with db.transaction() as c: svc.event(c,None,user['id'],'user_created',payload.username)
    return {'ok':True}

@app.post('/api/staff/users/{user_id}')
def update_user(user_id:int,payload:UserUpdate,request:Request):
    user=sec.session(request,('owner',))
    if user_id==user['id']: svc.fail(422,'請使用個人密碼設定；不能停用自己的帳號')
    hashed=sec.hash_password(payload.password) if payload.password else None
    with db.transaction() as c:
        target=c.execute('SELECT * FROM users WHERE id=?',(user_id,)).fetchone()
        if not target: svc.fail(404,'帳號不存在')
        if target['role']=='owner': svc.fail(403,'管理者帳號請由主機管理者處理')
        c.execute('UPDATE users SET active=? WHERE id=?',(int(payload.active),user_id))
        if hashed: c.execute('UPDATE users SET password_hash=? WHERE id=?',(hashed,user_id))
        c.execute('DELETE FROM sessions WHERE user_id=?',(user_id,))
        svc.event(c,None,user['id'],'user_updated',target['username'])
    return {'ok':True}

@app.get('/api/staff/audit')
def audit(request:Request,offset:int=Query(0,ge=0)):
    sec.session(request,('owner',))
    with db.read() as c:
        rows=c.execute('SELECT e.id,e.action,e.detail,e.created_at,u.name actor,o.number FROM events e LEFT JOIN users u ON u.id=e.user_id LEFT JOIN orders o ON o.id=e.order_id ORDER BY e.id DESC LIMIT 100 OFFSET ?',(offset,)).fetchall()
    return {'events':[dict(r) for r in rows]}

@app.get('/api/staff/ordering-qr')
def public_qr(request:Request):
    sec.session(request,('owner','cashier'))
    return qr_response(config.PUBLIC_ORIGIN+'/')

@app.get('/api/staff/receipt/{public_id}',response_class=HTMLResponse)
def receipt(public_id:str,request:Request):
    user=sec.session(request)
    with db.read() as c:
        row=c.execute('SELECT * FROM orders WHERE public_id=?',(public_id,)).fetchone()
        if not row: svc.fail(404,'找不到訂單')
        r=svc.serialize(c,row,staff=True,role=user['role']); s=db.settings(c)
    e=html.escape
    items=''.join(f'<li><b>{e(i["name"])} × {i["quantity"]}</b><br>{e(" / ".join(i["labels"]))}<br>{e(i["note"])}<span>NT$ {i["line_total"]}</span></li>' for i in r['items'])
    return f'''<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>取餐單 {r['number']}</title><link rel="stylesheet" href="/static/receipt.css"><body><header>{e(s['name'])}<br>{e(s['branch'])}</header><h1>{r['number']}</h1><p>{r['day']} {r['slot']} 取餐</p><p>{e(r['name'])}</p><ul>{items}</ul><p>{e(r['note'])}</p><h2>NT$ {r['total']}</h2><p>{'已收現金' if r['payment']=='paid' else '已退款' if r['payment']=='refunded' else '尚未收款'}</p><p>{'測試訂單・不是正式收據' if r['demo'] else '取餐憑單・非統一發票'}</p><p class="hint">請使用瀏覽器的列印功能。建議紙寬 80 mm。</p></body></html>'''

@app.get('/api/staff/schema')
def api_schema(request:Request):
    sec.session(request,('owner',))
    return app.openapi()

@app.get('/robots.txt')
def robots(): return Response('User-agent: *\nDisallow: /\n',media_type='text/plain')

@app.get('/')
@app.get('/staff/')
@app.get('/display/')
def shell():
    return FileResponse(ROOT/'static'/'index.html',headers={'Cache-Control':'no-cache'})

app.mount('/static',StaticFiles(directory=ROOT/'static'),name='static')
