"""One online backup + retention rotation. Schedule externally; no cloud upload."""
from datetime import datetime,timezone,timedelta
from pathlib import Path
import os
import sqlite3
import sys
ROOT=Path(__file__).resolve().parents[1];sys.path.insert(0,str(ROOT))
from app import config,db,service
keep=int(os.getenv('BACKUP_KEEP_DAYS','7'))
if not 1<=keep<=30:raise SystemExit('BACKUP_KEEP_DAYS must be 1..30')
db.initialize();service.maintenance()
folder=config.DATA_DIR/'backups';folder.mkdir(parents=True,exist_ok=True,mode=0o700)
target=folder/f'gugu-{service.now():%Y%m%d-%H%M%S-%f}.sqlite3'
try:
    with db.read() as source:
        dest=sqlite3.connect(target)
        try:source.backup(dest)
        finally:dest.close()
    os.chmod(target,0o600)
    with sqlite3.connect(target) as c:
        if c.execute('PRAGMA integrity_check').fetchone()[0]!='ok':raise RuntimeError('Backup integrity check failed')
except BaseException:
    target.unlink(missing_ok=True)
    raise
cutoff=datetime.now(timezone.utc)-timedelta(days=keep)
for file in folder.glob('gugu-*.sqlite3'):
    if file!=target and datetime.fromtimestamp(file.stat().st_mtime,timezone.utc)<cutoff:file.unlink()
print(f'備份完成：{target}；本機保留 {keep} 天。尚未加密或上傳異地。')
