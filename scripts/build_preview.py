"""Build a self-contained, network-free browser walkthrough from the actual UI."""
import json
from pathlib import Path
import sys
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT))
from app.db import DEFAULTS,SAMPLE_PRODUCTS
products=[]
for i,p in enumerate(SAMPLE_PRODUCTS):
    products.append(dict(zip(['id','name','description','category','price','daily_stock','options','kind'],p),version=1,sort=i,active=True,sold_out=False))
seed=json.dumps({'store':DEFAULTS,'products':products},ensure_ascii=False)
css=(ROOT/'static/app.css').read_text()
js='window.GUGU_PREVIEW=true;window.DEMO_SEED='+seed+';\n'+(ROOT/'preview/demo.js').read_text()+'\n'+(ROOT/'static/app.js').read_text()
js=js.replace('</script','<\\/script')
html=f'''<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#244638"><meta name="robots" content="noindex,nofollow"><title>穀穀・互動體驗</title><style>{css}</style></head><body><a class="skip" href="#main">跳到主要內容</a><div id="app"><div class="loading">載入本機體驗…</div></div><div id="toast" role="status" aria-live="polite"></div><dialog id="modal"></dialog><noscript>此互動體驗需要 JavaScript，請使用瀏覽器開啟，而非檔案快速預覽。</noscript><script>{js}</script></body></html>'''
(ROOT/'preview/index.html').write_text(html)
print('Built',ROOT/'preview/index.html')
