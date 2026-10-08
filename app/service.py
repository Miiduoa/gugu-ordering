"""Business rules live here, never in the browser.

All inventory, capacity, payment and state writes use one BEGIN IMMEDIATE
transaction. Availability is checked again after the writer lock is acquired.
"""
from collections import Counter
from datetime import datetime, date, timedelta
from zoneinfo import ZoneInfo
import json
import secrets
from fastapi import HTTPException
from . import config, db
from .security import digest, tracking_token

TZ=ZoneInfo('Asia/Taipei')
ACTIVE=('pending','accepted','preparing','ready')
TERMINAL=('completed','cancelled','rejected','no_show')

def now(): return datetime.now(TZ)
def stamp(): return now().isoformat()
def fail(status,message): raise HTTPException(status,message)
def event(c,order_id,user_id,action,detail=''):
    c.execute('INSERT INTO events(order_id,user_id,action,detail,created_at) VALUES(?,?,?,?,?)',(order_id,user_id,action,detail,stamp()))

def accepting_now(s):
    """Only take live orders while a staffed service window is open."""
    if s['paused'] or (config.MODE=='live' and not s['verified']): return False
    if config.MODE=='demo': return True
    current=now()
    if str(current.date()) in s['closed_dates']: return False
    minute=current.strftime('%H:%M')
    return any(a<=minute<b for a,b in s['hours'][str(current.weekday())])

def inventory(c,day,p):
    c.execute('INSERT OR IGNORE INTO inventory(day,product_id,remaining) VALUES(?,?,?)',(day,p['id'],p['daily_stock']))
    return c.execute('SELECT remaining FROM inventory WHERE day=? AND product_id=?',(day,p['id'])).fetchone()['remaining']

def slot_list(c,day,s,*,ignore_capacity=False):
    d=date.fromisoformat(str(day)); current=now()
    if not current.date()<=d<=current.date()+timedelta(days=s['advance_days']): return []
    if str(d) in s['closed_dates']: return []
    periods=s['hours'][str(d.weekday())]
    # Test mode has its own all-day schedule; never represent this as real hours.
    if config.MODE=='demo': periods=[['00:00','23:59']]
    occupied={r['slot']:r['n'] for r in c.execute("SELECT slot,SUM(portions) n FROM orders WHERE day=? AND (status NOT IN ('cancelled','rejected') OR stock_released=0) GROUP BY slot",(str(d),))}
    result=[]
    for start,end in periods:
        t=datetime.fromisoformat(f'{d}T{start}').replace(tzinfo=TZ)
        stop=datetime.fromisoformat(f'{d}T{end}').replace(tzinfo=TZ)
        while t<stop:
            if t>=current+timedelta(minutes=s['prep_minutes']):
                label=t.strftime('%H:%M'); left=max(0,s['slot_capacity']-occupied.get(label,0))
                result.append({'time':label,'remaining':left})
            t+=timedelta(minutes=s['slot_minutes'])
    return result

def release(c,row):
    if row['stock_released']: return
    for product_id,qty in json.loads(row['resources']).items():
        c.execute('UPDATE inventory SET remaining=remaining+? WHERE day=? AND product_id=?',(qty,row['day'],product_id))
    c.execute('UPDATE orders SET stock_released=1 WHERE id=?',(row['id'],))

def expire_pending(c):
    rows=c.execute("SELECT * FROM orders WHERE status='pending' AND expires_at<?",(stamp(),)).fetchall()
    for row in rows:
        release(c,row)
        c.execute("UPDATE orders SET status='cancelled',version=version+1,updated_at=? WHERE id=?",(stamp(),row['id']))
        event(c,row['id'],None,'expired','店家未於接單期限內確認，系統已取消；沒有收款。')
    return len(rows)

def serialize(c,row,*,staff=False,role=None):
    r=dict(row)
    public={k:r[k] for k in ('public_id','number','day','slot','name','note','total','status','payment','version','created_at','updated_at','expires_at','portions','demo','source')}
    public['items']=json.loads(r['items'])
    public['phone']=r['phone'] if staff and role in ('owner','cashier') else ('••••'+r['phone'][-4:] if r['phone'] else '')
    if role=='kitchen': public.pop('phone',None)
    public['events']=[{'action':e['action'],'detail':e['detail'],'at':e['created_at']} for e in c.execute('SELECT action,detail,created_at FROM events WHERE order_id=? ORDER BY id',(r['id'],))]
    return public

def create_order(payload):
    data=payload.model_dump(mode='json')
    key=str(data.pop('idempotency_key')); token=tracking_token(key)
    req_hash=digest(json.dumps(data,sort_keys=True,ensure_ascii=False))
    key_hash=digest(key)
    with db.transaction() as c:
        old=c.execute('SELECT * FROM orders WHERE key_hash=?',(key_hash,)).fetchone()
        if old:
            if old['request_hash']!=req_hash: fail(409,'同一送單識別碼的內容不同，請重新確認購物車')
            return {**serialize(c,old),'token':token,'replayed':True}
        expire_pending(c)
        s=db.settings(c)
        if s['paused']: fail(409,'店家目前暫停接單，請稍後再試')
        if config.MODE=='live' and not s['verified']: fail(503,'店家尚未完成菜單與營業設定確認，尚未開放正式訂購')
        if not accepting_now(s): fail(409,'目前非營業接單時間，請於營業時間下單；已成立的訂單仍可查詢')
        day=str(data['day']); portions=sum(i['quantity'] for i in data['items'])
        slot=next((x for x in slot_list(c,day,s) if x['time']==data['slot']),None)
        if not slot: fail(409,'這個取餐時段已停止接單，請重新選擇時間')
        if slot['remaining']<portions: fail(409,f'這個時段只剩 {slot["remaining"]} 份容量，請改選其他時間')
        if config.MODE=='live':
            active=c.execute("SELECT COUNT(*) n FROM orders WHERE phone=? AND status IN ('pending','accepted','preparing','ready')",(data['phone'],)).fetchone()['n']
            if active>=3: fail(409,'這支電話已有 3 筆未完成訂單；大量訂餐請聯繫店家')
        items=[]; resources=Counter(); total=0
        for requested in data['items']:
            p=c.execute('SELECT * FROM products WHERE id=?',(requested['product_id'],)).fetchone()
            if not p or not p['active'] or p['sold_out']: fail(409,'購物車中的餐點已下架或售完，請重新確認')
            if requested['version']!=p['version']: fail(409,f'{p["name"]} 的售價或規格已更新，請移除後重新加入')
            options=json.loads(p['options']); given=requested['choices']; labels=[]; price=p['price']
            if set(given)-{g['id'] for g in options}: fail(422,'餐點包含不支援的規格')
            for group in options:
                selected=given.get(group['id'])
                if selected is None:
                    if group['required']: fail(422,f'請選擇 {group["name"]}')
                    continue
                choice=next((v for v in group['choices'] if v['id']==selected),None)
                if not choice: fail(422,'餐點規格不存在，請重新選擇')
                price+=choice['price']; labels.append(choice['name'])
            qty=requested['quantity']; resources[p['id']]+=qty
            subtotal=price*qty; total+=subtotal
            items.append({'product_id':p['id'],'name':p['name'],'quantity':qty,'unit_price':price,'line_total':subtotal,
                          'choices':given,'labels':labels,'note':requested['note'],'version':p['version']})
        for pid,qty in sorted(resources.items()):
            p=c.execute('SELECT * FROM products WHERE id=?',(pid,)).fetchone()
            left=inventory(c,day,p)
            if left<qty: fail(409,f'{p["name"]} 目前只剩 {left} 份，請調整數量')
            c.execute('UPDATE inventory SET remaining=remaining-? WHERE day=? AND product_id=?',(qty,day,pid))
        c.execute('INSERT INTO counters(day,value) VALUES(?,1) ON CONFLICT(day) DO UPDATE SET value=value+1',(day,))
        seq=c.execute('SELECT value FROM counters WHERE day=?',(day,)).fetchone()['value']
        number=f'A{seq:03d}'
        created=stamp(); expiration=(now()+timedelta(minutes=s['accept_timeout'])).isoformat()
        public_id=secrets.token_hex(16)
        cur=c.execute('''INSERT INTO orders(public_id,number,day,slot,name,phone,note,items,resources,portions,total,status,
          token_hash,key_hash,request_hash,created_at,updated_at,expires_at,demo)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?,?,?,?,?)''',
          (public_id,number,day,data['slot'],data['name'],data['phone'],data['note'],json.dumps(items,ensure_ascii=False),
           json.dumps(resources),portions,total,digest(token),key_hash,req_hash,created,created,expiration,int(config.MODE=='demo')))
        event(c,cur.lastrowid,None,'created','訂單已送出，等待店家確認。')
        row=c.execute('SELECT * FROM orders WHERE id=?',(cur.lastrowid,)).fetchone()
        return {**serialize(c,row),'token':token,'replayed':False}

def get_by_token(c,token):
    row=c.execute('SELECT * FROM orders WHERE token_hash=?',(digest(token),)).fetchone()
    if not row: fail(404,'找不到訂單，請確認你保存的訂單連結')
    return row

def customer_cancel(token,version):
    with db.transaction() as c:
        expire_pending(c)
        row=get_by_token(c,token)
        if row['version']!=version: fail(409,'訂單狀態已更新，請重新整理')
        if row['status']!='pending' or row['payment']!='unpaid': fail(409,'店家已接單或訂單已結束，請聯繫店家處理')
        release(c,row)
        c.execute("UPDATE orders SET status='cancelled',updated_at=?,version=version+1 WHERE id=?",(stamp(),row['id']))
        event(c,row['id'],None,'cancelled','顧客於店家接單前取消。')
        return serialize(c,c.execute('SELECT * FROM orders WHERE id=?',(row['id'],)).fetchone())

TRANSITIONS={'accept':({'pending'},'accepted'), 'prepare':({'accepted'},'preparing'),
 'ready':({'preparing'},'ready'), 'complete':({'ready'},'completed'),
 'reject':({'pending'},'rejected'), 'cancel':({'pending','accepted','preparing','ready'},'cancelled'),
 'no_show':({'ready'},'no_show')}
LABELS={'accept':'店家已接單。','prepare':'餐點開始製作。','ready':'餐點已完成，可以來取餐。','complete':'已完成取餐。',
        'reject':'店家無法接受此訂單。','cancel':'店家已取消訂單。','no_show':'逾時未取餐。'}

def act(public_id,payload,user):
    a=payload.action
    if user['role']=='kitchen' and a not in ('accept','prepare','ready'): fail(403,'廚房帳號只能接單、製作和通知取餐')
    if a=='refund' and user['role']!='owner': fail(403,'退現金需由管理者確認')
    with db.transaction() as c:
        expire_pending(c)
        row=c.execute('SELECT * FROM orders WHERE public_id=?',(public_id,)).fetchone()
        if not row: fail(404,'找不到訂單')
        if row['version']!=payload.version: fail(409,'其他同事已更新這筆訂單，請重新整理')
        if a=='pay':
            if row['status']!='ready' or row['payment']!='unpaid': fail(409,'僅可對待取餐且尚未付款的訂單收款')
            if not payload.confirm_cash: fail(422,'請確認已實際收到現金')
            c.execute("UPDATE orders SET payment='paid',payment_at=?,updated_at=?,version=version+1 WHERE id=?",(stamp(),stamp(),row['id']))
            c.execute("INSERT INTO payments(order_id,user_id,kind,amount,created_at) VALUES(?,?,'cash',?,?)",(row['id'],user['id'],row['total'],stamp()))
            event(c,row['id'],user['id'],'paid',f'店員確認收到現金 NT$ {row["total"]}。')
        elif a=='refund':
            if row['payment']!='paid': fail(409,'這筆訂單沒有可退還的已收款')
            if not payload.confirm_cash or not payload.reason: fail(422,'請確認現金已退還，並填寫原因')
            c.execute("UPDATE orders SET payment='refunded',status='cancelled',refund_at=?,updated_at=?,version=version+1 WHERE id=?",(stamp(),stamp(),row['id']))
            c.execute("INSERT INTO payments(order_id,user_id,kind,amount,created_at) VALUES(?,?,'refund',?,?)",(row['id'],user['id'],-row['total'],stamp()))
            # Already made food is never returned to available stock.
            event(c,row['id'],user['id'],'refunded',f'現金已退還。原因：{payload.reason}')
        else:
            allowed,target=TRANSITIONS[a]
            if row['status'] not in allowed: fail(409,'訂單目前狀態不允許這個操作')
            if a=='complete' and row['payment']!='paid': fail(409,'請先確認收款，再完成取餐')
            if a in ('cancel','reject','no_show'):
                if not payload.reason: fail(422,'請填寫處理原因')
                if row['payment']!='unpaid': fail(409,'已收款訂單請由管理者使用退現金功能')
                if a=='no_show':
                    due=datetime.fromisoformat(f'{row["day"]}T{row["slot"]}').replace(tzinfo=TZ)
                    if now()<due+timedelta(minutes=30): fail(409,'取餐時間超過 30 分鐘後才能標記未取餐')
                if row['status'] in ('pending','accepted'): release(c,row)
            c.execute('UPDATE orders SET status=?,updated_at=?,version=version+1 WHERE id=?',(target,stamp(),row['id']))
            event(c,row['id'],user['id'],a,LABELS[a]+(' 原因：'+payload.reason if payload.reason else ''))
        return serialize(c,c.execute('SELECT * FROM orders WHERE id=?',(row['id'],)).fetchone(),staff=True,role=user['role'])

def maintenance():
    import time
    with db.transaction() as c:
        expire_pending(c)
        s=db.settings(c)
        cutoff=(now()-timedelta(days=s['privacy_days'])).isoformat()
        # Do not retain personal text in immutable order snapshots after retention.
        old=c.execute("SELECT id,items FROM orders WHERE updated_at<? AND status IN ('completed','cancelled','rejected','no_show') AND (phone!='' OR note!='')",(cutoff,)).fetchall()
        for row in old:
            items=json.loads(row['items'])
            for item in items: item['note']=''
            c.execute("UPDATE orders SET name='已匿名化',phone='',note='',items=? WHERE id=?",(json.dumps(items,ensure_ascii=False),row['id']))
            c.execute("UPDATE events SET detail='' WHERE order_id=?",(row['id'],))
            event(c,row['id'],None,'anonymized','已依設定保留天數移除聯絡與文字資料。')
        c.execute('DELETE FROM sessions WHERE expires<?',(int(time.time()),))
        c.execute('DELETE FROM rate_limits WHERE expires<?',(int(time.time()),))
    return len(old)
