#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
PY=""
for candidate in python3.13 python3.12 python3.11 python3.14 python3; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys;sys.exit(sys.version_info<(3,11))' 2>/dev/null; then PY="$candidate"; break; fi
done
if [ -z "$PY" ]; then
  echo "請先安裝 Python 3.11 以上，再重新執行。Mac 的系統 Python 可能太舊。"
  echo "程式不會更動 macOS 系統 Python。"
  exit 1
fi
if [ ! -x .venv/bin/python ]; then "$PY" -m venv .venv; fi
PY=.venv/bin/python
HASH=$("$PY" -c 'import hashlib;print(hashlib.sha256(open("requirements.txt","rb").read()).hexdigest())')
if [ ! -f .venv/.requirements-hash ] || [ "$(cat .venv/.requirements-hash)" != "$HASH" ]; then
  echo "第一次啟動將安裝套件，需要網路；不會安裝到系統 Python。"
  "$PY" -m pip install -r requirements.txt
  printf '%s' "$HASH" > .venv/.requirements-hash
fi
MODE=$("$PY" -c 'from app.config import MODE;print(MODE)')
if [ "$MODE" != "demo" ]; then echo "start.command 僅供本機測試；正式部署請閱讀 docs/部署與備份.md。"; exit 1; fi
"$PY" manage.py setup
printf '\n顧客點餐：http://127.0.0.1:8000\n店家工作台：http://127.0.0.1:8000/staff/\n取餐看板：http://127.0.0.1:8000/display/\n\n此網址只供這台電腦使用。按 Control+C 停止。\n\n'
if command -v open >/dev/null 2>&1; then
  (sleep 2; open 'http://127.0.0.1:8000') &
fi
exec "$PY" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --workers 1 --no-proxy-headers
