"""Environment configuration. No account or secret is shipped with the app."""
import os
import secrets
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env')
DATA_DIR = Path(os.getenv('DATA_DIR', ROOT / 'data')).resolve()
DB_PATH = Path(os.getenv('DATABASE_PATH', DATA_DIR / 'gugu.sqlite3'))
MODE = os.getenv('APP_MODE', 'demo')
PUBLIC_ORIGIN = os.getenv('PUBLIC_ORIGIN', 'http://127.0.0.1:8000').rstrip('/')
SECURE = os.getenv('COOKIE_SECURE', '0') == '1'
HOSTS = [h.strip() for h in os.getenv('ALLOWED_HOSTS', '127.0.0.1,localhost,testserver').split(',')]
if MODE not in ('demo', 'live'):
    raise RuntimeError('APP_MODE must be demo or live')
if MODE == 'live' and (not PUBLIC_ORIGIN.startswith('https://') or not SECURE or '*' in HOSTS):
    raise RuntimeError('Live mode requires HTTPS, COOKIE_SECURE=1 and explicit ALLOWED_HOSTS')

def secret_key() -> str:
    key = os.getenv('SECRET_KEY')
    if key:
        if len(key) < 40:
            raise RuntimeError('SECRET_KEY must contain at least 40 characters')
        return key
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    p = DATA_DIR / '.secret'
    try:
        fd = os.open(p, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as f:
            f.write(secrets.token_urlsafe(48))
    except FileExistsError:
        pass
    return p.read_text().strip()
