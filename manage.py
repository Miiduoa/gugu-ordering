#!/usr/bin/env python3
"""Local administration. Run `python manage.py --help` for commands."""
import argparse
import getpass
import os
from pathlib import Path
import secrets
import sqlite3
import sys
from app import config,db,security,service

p=argparse.ArgumentParser(description='穀穀點餐系統管理')
p.add_argument('command',choices=['setup','reset-password','backup','restore','maintenance','check'])
p.add_argument('--username',default='owner')
p.add_argument('--file',type=Path)
p.add_argument('--confirm',action='store_true')
a=p.parse_args()
db.initialize()
if a.command=='setup':
    with db.read() as c: exists=c.execute('SELECT 1 FROM users WHERE username=?',(a.username,)).fetchone()
    if exists:
        print('帳號已存在，未覆蓋密碼。'); sys.exit(0)
    password=secrets.token_urlsafe(16)
    security.add_user(a.username,'店家管理者','owner',password)
    credential=config.DATA_DIR/'local-access.txt'
    credential.write_text(f'僅限本機保存，請勿上傳 GitHub。\n帳號：{a.username}\n密碼：{password}\n登入後請立即更改密碼。\n')
    os.chmod(credential,0o600)
    print(f'已建立店家帳號。\n帳號：{a.username}\n密碼：{password}\n密碼已保存於 {credential}\n登入後請立即更改密碼。')
elif a.command=='reset-password':
    password=getpass.getpass('新密碼（至少 12 字元）：')
    if len(password)<12: sys.exit('密碼長度不足')
    if password!=getpass.getpass('再次輸入：'): sys.exit('兩次輸入不相符')
    with db.transaction() as c:
        if not c.execute('SELECT 1 FROM users WHERE username=?',(a.username,)).fetchone(): sys.exit('帳號不存在')
        c.execute('UPDATE users SET password_hash=?,active=1 WHERE username=?',(security.hash_password(password),a.username))
        c.execute('DELETE FROM sessions WHERE user_id=(SELECT id FROM users WHERE username=?)',(a.username,))
    print('已重設密碼，舊裝置全部登出。')
elif a.command=='backup':
    target=a.file or config.DATA_DIR/'backups'/f'gugu-{service.now():%Y%m%d-%H%M%S}.sqlite3'
    if target.resolve()==config.DB_PATH.resolve() or target.exists(): sys.exit('不能覆蓋現有檔案')
    target.parent.mkdir(parents=True,exist_ok=True)
    # Online Backup API handles WAL safely. Do not simply copy the live .sqlite3 file.
    with db.read() as source:
        dest=sqlite3.connect(target); source.backup(dest); dest.close()
    os.chmod(target,0o600)
    print(f'完整備份：{target}；請另將 data/.secret 加密保管。')
elif a.command=='restore':
    if not a.file or not a.file.exists() or not a.confirm: sys.exit('請先停止伺服器，並指定 --file 備份檔 --confirm')
    if a.file.resolve()==config.DB_PATH.resolve(): sys.exit('來源不能是目前資料庫')
    source=sqlite3.connect(f'file:{a.file.resolve()}?mode=ro',uri=True)
    if source.execute('PRAGMA integrity_check').fetchone()[0]!='ok': sys.exit('備份完整性檢查失敗')
    if not source.execute('SELECT 1 FROM migrations WHERE version=1').fetchone(): sys.exit('備份版本不符')
    if source.execute('SELECT mode FROM installation WHERE id=1').fetchone()[0]!=config.MODE: sys.exit('備份屬於不同的 demo/live 環境，已拒絕還原')
    # The operator must stop the app first; --confirm is an acknowledgement.
    dest=sqlite3.connect(config.DB_PATH); source.backup(dest); dest.close(); source.close()
    with db.transaction() as c: c.execute('DELETE FROM sessions')
    print('已還原並撤銷所有登入。請啟動伺服器、檢查菜單、訂單與帳款。')
elif a.command=='maintenance':
    print(f'維護完成，匿名化 {service.maintenance()} 筆歷史訂單。')
elif a.command=='check':
    with db.read() as c:
        print('資料庫：'+c.execute('PRAGMA integrity_check').fetchone()[0])
        s=db.settings(c); owner=c.execute("SELECT COUNT(*) n FROM users WHERE role='owner' AND active=1").fetchone()['n']
    print('模式：'+config.MODE)
    print('HTTPS：'+str(config.SECURE))
    print('正式資料已確認：'+str(s['verified']))
    print('可用管理者：'+str(owner))
    print('公開網址：'+config.PUBLIC_ORIGIN)
    if config.MODE=='live' and (not s['verified'] or not owner): sys.exit(1)
