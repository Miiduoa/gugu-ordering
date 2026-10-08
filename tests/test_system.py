from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import json
import sqlite3
import subprocess
import sys
import uuid
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from app import db,config,service,security
from app.main import app
from app.schemas import OrderInput,ActionInput
from conftest import login,settings,PASSWORD,ROOT

DAY='2026-10-08'
def payload(**overrides):
    b={'idempotency_key':str(uuid.uuid4()),'name':'測試顧客','phone':'0900000000','day':DAY,'slot':'11:00','items':[{'product_id':'pork','quantity':1,'version':1,'choices':{'rice':'normal'},'note':''}],'note':'','consent':True};b.update(overrides);return b

def create(c,**kw):
    r=c.post('/api/orders',json=payload(**kw));assert r.status_code==201,r.text;return r.json()

def stock(pid='pork'):
    with db.read() as c:
        r=c.execute('SELECT remaining FROM inventory WHERE day=? AND product_id=?',(DAY,pid)).fetchone()
        return r[0] if r else c.execute('SELECT daily_stock FROM products WHERE id=?',(pid,)).fetchone()[0]

def act(c,o,a,**kw):
    return c.post('/api/staff/orders/'+o['public_id']+'/action',json={'action':a,'version':o['version'],**kw})

def ready(c,o):
    for a in ['accept','prepare','ready']:
        r=act(c,o,a);assert r.status_code==200,r.text;o=r.json()
    return o

def test_health_menu_store(client):
    assert client.get('/api/health').json()['ok']
    assert len(client.get('/api/menu').json()['products'])==8
    s=client.get('/api/store').json();assert s['mode']=='demo' and not s['verified']
    with db.read() as c:assert c.execute('PRAGMA journal_mode').fetchone()[0]=='delete'

def test_real_creation_prices_options(client):
    p=payload();p['items'][0].update(quantity=2,choices={'rice':'veg'})
    r=client.post('/api/orders',json=p);assert r.status_code==201
    o=r.json();assert o['total']==290 and o['portions']==2 and o['payment']=='unpaid'
    assert o['phone']=='••••0000' and stock()==38

@pytest.mark.parametrize('change',[{'quantity':-1},{'quantity':True},{'quantity':21},{'quantity':'2'},{'price':1},{'unit_price':1},{'version':0}])
def test_reject_untrusted_cart(client,change):
    b=payload();b['items'][0].update(change)
    assert client.post('/api/orders',json=b).status_code==422
    assert stock()==40

@pytest.mark.parametrize('choices',[{}, {'rice':'free'}, {'rice':'normal','cheat':'yes'}])
def test_invalid_options(client,choices):
    b=payload();b['items'][0]['choices']=choices
    assert client.post('/api/orders',json=b).status_code==422
    assert stock()==40

def test_bad_phone_consent_total(client):
    for b in [payload(phone='hello'),payload(consent=False),payload(total=1)]:assert client.post('/api/orders',json=b).status_code==422

def test_idempotency(client):
    p=payload();a=client.post('/api/orders',json=p).json();b=client.post('/api/orders',json=p).json()
    assert a['token']==b['token'] and a['public_id']==b['public_id'] and b['replayed']
    assert stock()==39
    p['name']='different';assert client.post('/api/orders',json=p).status_code==409
    with db.read() as c:assert c.execute('SELECT count(*) FROM orders').fetchone()[0]==1

def test_aggregate_same_product_and_rollback(client):
    with db.transaction() as c:c.execute("UPDATE products SET daily_stock=2 WHERE id='pork'")
    b=payload();b['items']=[{**b['items'][0],'quantity':2},{**b['items'][0],'choices':{'rice':'half'},'quantity':1}]
    assert client.post('/api/orders',json=b).status_code==409
    assert stock()==2

def test_partial_stock_transaction_rollback(client):
    with db.transaction() as c:c.execute("UPDATE products SET daily_stock=0 WHERE id='salmon'")
    b=payload();b['items'].append({**b['items'][0],'product_id':'salmon'})
    assert client.post('/api/orders',json=b).status_code==409
    assert stock()==40

def test_concurrent_last_five_portions(env):
    with db.transaction() as c:c.execute("UPDATE products SET daily_stock=5 WHERE id='pork'")
    def run(_):
        try:return service.create_order(OrderInput(**payload()))
        except HTTPException as e:return e.status_code
    with ThreadPoolExecutor(max_workers=12) as pool:results=list(pool.map(run,range(20)))
    ok=[r for r in results if isinstance(r,dict)]
    assert len(ok)==5 and results.count(409)==15 and stock()==0
    assert len({r['number'] for r in ok})==5

def test_concurrent_slot_capacity(env):
    settings(slot_capacity=6)
    def run(_):
        try:return service.create_order(OrderInput(**payload()))
        except HTTPException as e:return e.status_code
    with ThreadPoolExecutor(max_workers=10) as pool:results=list(pool.map(run,range(20)))
    assert sum(isinstance(r,dict) for r in results)==6
    assert stock()==34

def test_concurrent_same_idempotency(env):
    p=OrderInput(**payload())
    with ThreadPoolExecutor(max_workers=10) as pool:results=list(pool.map(lambda _:service.create_order(p),range(12)))
    assert len({r['public_id'] for r in results})==1 and stock()==39

def test_stale_menu_and_snapshot(client):
    login(client);o=create(client)
    p=next(p for p in client.get('/api/staff/products').json()['products'] if p['id']=='pork')
    for k in ('remaining','sort'):p.pop(k,None)
    p['price']=180
    assert client.post('/api/staff/products',json=p).status_code==200
    assert client.post('/api/orders',json=payload()).status_code==409
    assert client.post('/api/order/track',json={'token':o['token']}).json()['total']==135
    assert client.post('/api/staff/products',json=p).status_code==409

@pytest.mark.parametrize('values',[{'day':'2026-10-07'},{'day':'2026-10-20'},{'slot':'10:00'},{'slot':'25:00'}])
def test_past_or_invalid_slot(client,values):
    assert client.post('/api/orders',json=payload(**values)).status_code==409

def test_closed_day_pause_and_live_gate(client,env):
    settings(closed_dates=[DAY]);assert client.post('/api/orders',json=payload()).status_code==409
    settings(closed_dates=[],paused=True);assert client.post('/api/orders',json=payload()).status_code==409
    settings(paused=False);env['monkeypatch'].setattr(config,'MODE','live')
    assert client.post('/api/orders',json=payload()).status_code==503
    settings(verified=True)
    env['clock'][0]+=timedelta(hours=1)
    assert client.post('/api/orders',json=payload(slot='15:00')).status_code==409
    assert client.post('/api/orders',json=payload(slot='12:00')).status_code==201

def test_live_initial_database_has_no_sample_menu(env):
    config.DB_PATH=env['path']/'live-empty.sqlite3';config.MODE='live';db.initialize()
    with db.read() as c:assert c.execute('SELECT count(*) FROM products').fetchone()[0]==0

def test_cancel_releases_exactly_once(client):
    o=create(client);b={'token':o['token'],'version':o['version']}
    assert client.post('/api/order/cancel',json=b).status_code==200
    assert stock()==40
    assert client.post('/api/order/cancel',json=b).status_code==409
    assert stock()==40

def test_accepted_customer_cancel_forbidden(client):
    login(client);o=create(client);token=o['token'];o=act(client,o,'accept').json()
    assert client.post('/api/order/cancel',json={'token':token,'version':o['version']}).status_code==409
    assert stock()==39

def test_preparing_cancel_no_restock(client):
    login(client);o=create(client)
    for a in ['accept','prepare']:o=act(client,o,a).json()
    assert act(client,o,'cancel',reason='測試取消').status_code==200
    assert stock()==39

def test_accepted_staff_cancel_restock(client):
    login(client);o=create(client);o=act(client,o,'accept').json()
    assert act(client,o,'cancel',reason='測試取消').status_code==200
    assert stock()==40

def test_pending_expiry(client,env):
    o=create(client);env['clock'][0]+=timedelta(minutes=11)
    r=client.post('/api/order/track',json={'token':o['token']})
    assert r.json()['status']=='cancelled' and stock()==40

def test_full_cash_lifecycle(client):
    login(client);o=create(client);token=o['token'];o=ready(client,o)
    assert act(client,o,'complete').status_code==409
    assert act(client,o,'pay').status_code==422
    paid=act(client,o,'pay',confirm_cash=True).json()
    assert paid['payment']=='paid'
    assert act(client,o,'pay',confirm_cash=True).status_code==409
    r=act(client,paid,'complete');assert r.status_code==200 and r.json()['status']=='completed'
    assert client.post('/api/order/track',json={'token':token}).json()['status']=='completed'
    reports=client.get('/api/staff/reports?day='+DAY).json()
    assert reports['net_cash']==135 and reports['completed_total']==135

def test_reports_exclude_pending_and_refund_ledger(client):
    login(client);o=create(client);assert client.get('/api/staff/reports?day='+DAY).json()['net_cash']==0
    o=ready(client,o);o=act(client,o,'pay',confirm_cash=True).json()
    r=act(client,o,'refund',confirm_cash=True,reason='測試退款');assert r.status_code==200
    stats=client.get('/api/staff/reports?day='+DAY).json()
    assert stats['cash_received']==135 and stats['cash_refunded']==135 and stats['net_cash']==0 and stock()==39

def test_no_show_timing(client,env):
    login(client);o=ready(client,create(client))
    assert act(client,o,'no_show',reason='未取').status_code==409
    env['clock'][0]+=timedelta(minutes=91)
    assert act(client,o,'no_show',reason='未取').status_code==200

def test_stock_optimistic_lock(client):
    login(client);b={'day':DAY,'product_id':'pork','remaining':20,'expected_remaining':40,'reason':'盤點'}
    assert client.post('/api/staff/stock',json=b).status_code==200
    assert client.post('/api/staff/stock',json=b).status_code==409
    assert stock()==20

@pytest.mark.parametrize('role,forbidden',[('kitchen',['/api/staff/products','/api/staff/reports','/api/staff/settings','/api/staff/users']),('cashier',['/api/staff/reports','/api/staff/users'])])
def test_role_boundaries(client,role,forbidden):
    login(client,role)
    for path in forbidden:
        if path.endswith('/settings'):continue
        assert client.get(path).status_code==403
    o=create(client);assert act(client,o,'refund',confirm_cash=True,reason='test').status_code==403
    if role=='kitchen':assert act(client,o,'cancel',reason='test').status_code==403

def test_auth_csrf_origin_headers(client):
    assert client.get('/api/staff/orders').status_code==401
    login(client)
    assert client.post('/api/staff/pause',json={'paused':True,'version':1},headers={'X-CSRF-Token':'wrong'}).status_code==403
    assert client.post('/api/staff/pause',json={'paused':True,'version':1},headers={'Origin':'https://evil.invalid'}).status_code==403
    assert client.post('/api/orders',json=payload(),headers={'X-Requested-With':''}).status_code==403
    assert client.get('/api/staff/orders').headers['cache-control']=='no-store'

def test_privacy_board_kitchen_token(client):
    o=create(client);token=o['token'];login(client,'kitchen');o=ready(client,o)
    kitchen=client.get('/api/staff/orders').json()['orders'][0]
    assert 'phone' not in kitchen and 'token' not in kitchen
    board=client.get('/api/board').json()['orders'][0]
    assert set(board)=={'number','slot','status'}
    assert client.post('/api/order/track',json={'token':'a'*64}).status_code==404
    assert client.post('/api/order/track',json={'token':token}).json()['phone']=='••••0000'

def test_qr_receipt_and_escaped_html(client):
    login(client);o=create(client,name='<img src=x>',note='<script>alert(1)</script>')
    qr=client.post('/api/order/qr',json={'token':o['token']});assert qr.content.startswith(b'\x89PNG')
    assert client.get('/api/staff/ordering-qr').content.startswith(b'\x89PNG')
    receipt=client.get('/api/staff/receipt/'+o['public_id'])
    assert '&lt;script&gt;' in receipt.text and '<script>' not in receipt.text
    assert '不是正式收據' in receipt.text

def test_account_reset_and_disable_revokes_sessions(client):
    login(client,'cashier');old_cookie=client.cookies.get('gugu_session')
    client.cookies.clear();login(client)
    assert client.post('/api/staff/users/2',json={'active':False,'password':None}).status_code==200
    with TestClient(app,headers={'X-Requested-With':'Gugu'}) as other:
        other.cookies.set('gugu_session',old_cookie)
        assert other.get('/api/auth/me').status_code==401

def test_change_password_revokes_all_sessions(client):
    login(client)
    r=client.post('/api/auth/password',json={'current_password':PASSWORD,'new_password':'new-test-only-password-988'})
    assert r.status_code==200 and client.get('/api/auth/me').status_code==401

def test_login_ratelimit(client):
    statuses=[client.post('/api/auth/login',json={'username':'absent','password':'incorrect'}).status_code for _ in range(9)]
    assert statuses[-1]==429 and statuses[0]==401

def test_body_size_limit(client):
    r=client.post('/api/orders',content='"'+'a'*70000+'"',headers={'Content-Type':'application/json'})
    assert r.status_code==413

def test_retention_removes_private_text(client,env):
    login(client);o=ready(client,create(client,note='私人備註'));o=act(client,o,'pay',confirm_cash=True).json();o=act(client,o,'complete').json()
    env['clock'][0]+=timedelta(days=31);assert service.maintenance()==1
    with db.read() as c:
        row=c.execute('SELECT * FROM orders').fetchone()
        assert row['name']=='已匿名化' and row['phone']=='' and row['note']==''
        assert all(i['note']=='' for i in json.loads(row['items']))
    assert service.maintenance()==0

def test_backup_restore_integrity(env,client):
    o=create(client);target=env['path']/'backup.sqlite3'
    with db.read() as c:
        dest=sqlite3.connect(target);c.backup(dest);dest.close()
    with db.transaction() as c:c.execute("UPDATE orders SET name='changed'")
    c=sqlite3.connect(target);dst=db.connect();c.backup(dst);dst.close();c.close()
    with db.read() as c:
        assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
        assert c.execute('SELECT name FROM orders').fetchone()[0]==o['name']

def test_settings_cas_and_active_slot_length(client):
    login(client);create(client)
    with db.read() as c:s=db.settings(c)
    s['slot_minutes']=30
    assert client.post('/api/staff/settings',json=s).status_code==409
    s['slot_minutes']=15;s['announcement']='新的測試公告'
    assert client.post('/api/staff/settings',json=s).status_code==200
    assert client.post('/api/staff/settings',json=s).status_code==409

def test_export_no_pii(client):
    login(client);create(client,name='PRIVATECUSTOMER',phone='0912345678',note='PRIVATE NOTE')
    csv=client.get('/api/staff/export?day='+DAY)
    assert csv.status_code==200
    assert 'PRIVATECUSTOMER' not in csv.text and '0912345678' not in csv.text and 'PRIVATE NOTE' not in csv.text


def test_live_database_mode_cannot_reuse_demo(env):
    config.MODE='live'
    with pytest.raises(RuntimeError,match='DATA_DIR'):db.initialize()

def test_closed_live_store_does_not_collect_unattended_orders(client,env):
    env['monkeypatch'].setattr(config,'MODE','live');settings(verified=True)
    assert client.get('/api/store').json()['accepting'] is False
    assert client.post('/api/orders',json=payload(day='2026-10-09')).status_code==409

def test_future_pending_orders_are_visible(client):
    login(client);create(client,day='2026-10-09')
    assert client.get('/api/staff/orders').json()['total']==0
    queue=client.get('/api/staff/pending-dates').json()['dates']
    assert queue[0]['day']=='2026-10-09' and queue[0]['pending']==1


def test_actual_cli_setup_backup_restore(env):
    import os
    child={**os.environ,'APP_MODE':'demo','DATABASE_PATH':str(config.DB_PATH),'DATA_DIR':str(env['path'])}
    def run(*args):
        return subprocess.run([sys.executable,'manage.py',*args],cwd=ROOT,env=child,capture_output=True,text=True,check=True)
    # A new admin name avoids replacing the fixture's accounts.
    run('setup','--username','new-owner')
    credentials=(env['path']/'local-access.txt').read_text()
    assert 'new-owner' in credentials
    assert '未覆蓋' in run('setup','--username','new-owner').stdout
    backup=env['path']/'cli-backup.sqlite3'
    run('backup','--file',str(backup))
    with db.transaction() as c:c.execute("UPDATE users SET name='changed' WHERE username='new-owner'")
    run('restore','--file',str(backup),'--confirm')
    with db.read() as c:
        assert c.execute("SELECT name FROM users WHERE username='new-owner'").fetchone()[0]=='店家管理者'
        assert c.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    run('check')
