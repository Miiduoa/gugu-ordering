"""SQLite storage. Keep this database on a persistent, local filesystem."""
from contextlib import contextmanager
import json
import os
import sqlite3
from pathlib import Path
from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS installation (id INTEGER PRIMARY KEY CHECK(id=1), mode TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY, applied_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY, username TEXT NOT NULL UNIQUE, name TEXT NOT NULL,
 role TEXT NOT NULL CHECK(role IN ('owner','cashier','kitchen')),
 password_hash TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
 csrf TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);
CREATE TABLE IF NOT EXISTS rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS products (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 category TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0),
 daily_stock INTEGER NOT NULL DEFAULT 30 CHECK(daily_stock>=0),
 active INTEGER NOT NULL DEFAULT 1, sold_out INTEGER NOT NULL DEFAULT 0,
 options TEXT NOT NULL DEFAULT '[]', version INTEGER NOT NULL DEFAULT 1,
 sort INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'meal' CHECK(kind IN ('meal','addon')));
CREATE TABLE IF NOT EXISTS inventory (
 day TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id),
 remaining INTEGER NOT NULL CHECK(remaining>=0), PRIMARY KEY(day,product_id));
CREATE TABLE IF NOT EXISTS counters (day TEXT PRIMARY KEY, value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
 id INTEGER PRIMARY KEY, public_id TEXT NOT NULL UNIQUE, number TEXT NOT NULL,
 day TEXT NOT NULL, slot TEXT NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL,
 note TEXT NOT NULL DEFAULT '', items TEXT NOT NULL, resources TEXT NOT NULL,
 portions INTEGER NOT NULL CHECK(portions>0), total INTEGER NOT NULL CHECK(total>=0),
 status TEXT NOT NULL CHECK(status IN ('pending','accepted','preparing','ready','completed','cancelled','rejected','no_show')),
 payment TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment IN ('unpaid','paid','refunded')),
 token_hash TEXT NOT NULL UNIQUE, key_hash TEXT NOT NULL UNIQUE, request_hash TEXT NOT NULL,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT NOT NULL,
 payment_at TEXT, refund_at TEXT, version INTEGER NOT NULL DEFAULT 1,
 demo INTEGER NOT NULL DEFAULT 1, consent_version TEXT NOT NULL DEFAULT '2026-10-08',
 stock_released INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'web',
 UNIQUE(day,number));
CREATE INDEX IF NOT EXISTS orders_queue ON orders(day,status,slot);
CREATE INDEX IF NOT EXISTS orders_expiry ON orders(status,expires_at);
CREATE TABLE IF NOT EXISTS events (
 id INTEGER PRIMARY KEY, order_id INTEGER REFERENCES orders(id),
 user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
 detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_order ON events(order_id,id);
CREATE TABLE IF NOT EXISTS payments (
 id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id),
 user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL CHECK(kind IN ('cash','refund')),
 amount INTEGER NOT NULL, created_at TEXT NOT NULL, UNIQUE(order_id,kind));
"""

DEFAULTS = {
 'name': '穀穀健康廚房', 'branch': '台中學府總店',
 'address': '台中市南區學府路 136 號', 'phone': '04-22220572',
 'announcement': '先點好，再出門。餐點完成後，憑取餐號碼到店取餐。',
 'paused': False, 'verified': False, 'prep_minutes': 20, 'slot_minutes': 15,
 'slot_capacity': 20, 'advance_days': 3, 'accept_timeout': 10,
 'hours': {str(i): [['11:00','14:00'],['17:00','20:00']] for i in range(7)},
 'closed_dates': [], 'privacy_days': 30,
}

RICE = {'id':'rice','name':'飯量','required':True,'choices':[
 {'id':'normal','name':'正常飯','price':0}, {'id':'half','name':'半飯','price':0},
 {'id':'veg','name':'飯換菜','price':10}]}
SPICY = {'id':'spicy','name':'辣度','required':True,'choices':[
 {'id':'mild','name':'小辣','price':0}, {'id':'medium','name':'中辣','price':0},
 {'id':'hot','name':'大辣','price':0}]}
# Names are based on publicly listed dishes. ALL prices / stock / options are samples.
SAMPLE_PRODUCTS = [
 ('pork','乾炒豬里肌餐盒','乾炒里肌，搭配當日蔬菜與穀飯。餐點說明與配菜仍待店家確認。','肉類餐盒',135,40,[RICE],'meal'),
 ('basil','泰式打拋豬餐盒','打拋豬搭配當日配菜；可選擇辣度。','肉類餐盒',145,35,[RICE,SPICY],'meal'),
 ('beef','醬燒牛五花餐盒','醬燒牛五花與當日配菜，飯量由你決定。','肉類餐盒',155,30,[RICE],'meal'),
 ('salmon','招牌義式鮭魚餐盒','義式風味鮭魚餐盒。實際食材及供應以店家確認為準。','魚類餐盒',195,20,[RICE],'meal'),
 ('tilapia','水煮鯛魚片餐盒','清爽水煮魚片，搭配當日蔬菜。','魚類餐盒',155,25,[RICE],'meal'),
 ('steak','板腱牛排餐盒','板腱牛排搭配穀飯與當日蔬菜。','肉類餐盒',195,18,[RICE],'meal'),
 ('vegetarian','蛋奶五辛素餐盒','無肉餐盒；非全素。實際成分與過敏原請洽店家。','蔬食餐盒',120,20,[RICE],'meal'),
 ('veggies','當日纖蔬','加一份當日蔬菜。','加點',40,40,[],'addon'),
]

def connect():
    c = sqlite3.connect(str(config.DB_PATH), timeout=10, isolation_level=None)
    c.row_factory = sqlite3.Row
    c.execute('PRAGMA foreign_keys=ON')
    c.execute('PRAGMA busy_timeout=10000')
    c.execute('PRAGMA synchronous=FULL')
    c.execute('PRAGMA secure_delete=ON')
    return c

@contextmanager
def read():
    c = connect()
    try:
        yield c
    finally:
        c.close()

@contextmanager
def transaction():
    c = connect()
    try:
        # Acquire the writer lock BEFORE reading availability / idempotency.
        c.execute('BEGIN IMMEDIATE')
        yield c
        c.commit()
    except BaseException:
        c.rollback()
        raise
    finally:
        c.close()

def initialize():
    Path(config.DB_PATH).parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with read() as c:
        # Rollback journal avoids dependence on bundled SQLite WAL patch levels.
        c.execute('PRAGMA journal_mode=DELETE')
        c.executescript(SCHEMA)
        c.execute('INSERT OR IGNORE INTO installation(id,mode) VALUES(1,?)',(config.MODE,))
        mode=c.execute('SELECT mode FROM installation WHERE id=1').fetchone()[0]
        if mode != config.MODE:
            raise RuntimeError('請為 demo / live 使用不同的 DATA_DIR；不能將測試資料庫直接切換成正式接單。')
        os.chmod(config.DB_PATH,0o600)
        c.execute('INSERT OR IGNORE INTO migrations(version) VALUES(1)')
        c.execute('INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)', (json.dumps(DEFAULTS,ensure_ascii=False),))
        # Initial live databases do not receive a fabricated menu.
        if config.MODE == 'demo' and not c.execute('SELECT 1 FROM products LIMIT 1').fetchone():
            for i,p in enumerate(SAMPLE_PRODUCTS):
                c.execute('INSERT INTO products(id,name,description,category,price,daily_stock,options,kind,sort) VALUES(?,?,?,?,?,?,?,?,?)',
                          (*p[:6],json.dumps(p[6],ensure_ascii=False),p[7],i))

def settings(c):
    row = c.execute('SELECT * FROM settings WHERE id=1').fetchone()
    return {**json.loads(row['data']), 'version':row['version']}
