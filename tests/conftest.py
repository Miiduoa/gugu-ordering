import json
import os
from datetime import datetime
from pathlib import Path
import sys
import pytest
from fastapi.testclient import TestClient
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
os.environ.update(APP_MODE='demo',ALLOWED_HOSTS='127.0.0.1,localhost,testserver',COOKIE_SECURE='0',PUBLIC_ORIGIN='http://testserver')
from app import config,db,security,service
from app.main import app
PASSWORD='only-for-automated-tests-731'
HASH=security.hasher.hash(PASSWORD)

@pytest.fixture
def env(tmp_path,monkeypatch):
    monkeypatch.setenv('SECRET_KEY','isolated-test-secret-not-for-production-'+'x'*48)
    monkeypatch.setattr(config,'DB_PATH',tmp_path/'test.sqlite3')
    monkeypatch.setattr(config,'DATA_DIR',tmp_path)
    monkeypatch.setattr(config,'MODE','demo')
    monkeypatch.setattr(config,'PUBLIC_ORIGIN','http://testserver')
    monkeypatch.setattr(config,'SECURE',False)
    clock=[datetime(2026,10,8,10,0,tzinfo=service.TZ)]
    monkeypatch.setattr(service,'now',lambda:clock[0])
    db.initialize()
    with db.transaction() as c:
        for role in ['owner','cashier','kitchen']:
            c.execute('INSERT INTO users(username,name,role,password_hash,created_at) VALUES(?,?,?,?,?)',(role,role,role,HASH,service.stamp()))
    return {'clock':clock,'path':tmp_path,'monkeypatch':monkeypatch}

@pytest.fixture
def client(env):
    with TestClient(app,headers={'X-Requested-With':'Gugu','Origin':'http://testserver'}) as c:yield c

def login(client,role='owner'):
    r=client.post('/api/auth/login',json={'username':role,'password':PASSWORD})
    assert r.status_code==200,r.text
    client.headers['X-CSRF-Token']=r.json()['csrf']
    return r.json()['user']

def settings(**changes):
    with db.transaction() as c:
        data=db.settings(c);data.pop('version');data.update(changes)
        c.execute('UPDATE settings SET data=? WHERE id=1',(json.dumps(data),))
