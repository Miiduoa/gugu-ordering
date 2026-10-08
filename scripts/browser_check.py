"""Isolated real-browser test. Does not touch the user's database or credentials."""
import json,os,secrets,shutil,subprocess,sys,tempfile,time
import httpx
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright,expect
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/screenshots';OUT.mkdir(parents=True,exist_ok=True)
port=8765;base=f'http://127.0.0.1:{port}'
BRIDGE=os.getenv('BROWSER_HTTP_BRIDGE')=='1'
# Some managed runners forbid browser network navigation. In this explicit test
# mode, render about:blank and bridge fetch to the real local HTTP server. This
# does not disable browser policies and is NOT a deployed application feature.
def render_page(page,path='/',offline=False):
    if not BRIDGE:
        return page.goto((ROOT/'preview/index.html').as_uri()+path if offline else base+path)
    page.goto('about:blank')
    if offline:
        html=(ROOT/'preview/index.html').read_text()
        if path.startswith('#'):page.evaluate('(h)=>location.hash=h',path)
    else:
        html=(ROOT/'static/index.html').read_text()
        code=(ROOT/'static/app.js').read_text().replace('location.pathname','window.BROWSER_TEST_PATH')
        head=f'<script>window.BROWSER_TEST_PATH={json.dumps(path)};window.fetch=async(url,opts={{}})=>{{const r=await window.testTransport(String(url),opts.method||"GET",opts.headers||{{}},opts.body||null);return new Response(r.body,{{status:r.status,headers:r.headers}})}};</script>'
        html=html.replace('<link rel="stylesheet" href="/static/app.css">','<style>'+(ROOT/'static/app.css').read_text()+'</style>')
        html=html.replace('<script defer src="/static/app.js"></script>','')
        html=html.replace('</body>',head+'<script>'+code+'</script></body>')
    page.set_content(html,wait_until='load')

def bridge(page):
    if not BRIDGE:return
    client=httpx.Client(base_url=base,headers={'Origin':base},timeout=20)
    fault={'armed':False}
    page.expose_function('armResponseLoss',lambda:fault.update(armed=True))
    def transport(url,method,headers,body):
        r=client.request(method,url,headers=headers,content=body)
        if fault['armed'] and url=='/api/orders' and method=='POST':
            fault['armed']=False
            raise RuntimeError('Simulated loss AFTER the real server committed the order')
        return {'status':r.status_code,'body':r.text,'headers':dict(r.headers)}
    page.expose_function('testTransport',transport)

with tempfile.TemporaryDirectory(prefix='gugu-e2e-') as folder:
    password=secrets.token_urlsafe(20)
    env={**os.environ,'APP_MODE':'demo','DATA_DIR':folder,'DATABASE_PATH':folder+'/test.sqlite3','PUBLIC_ORIGIN':base,'ALLOWED_HOSTS':'127.0.0.1,localhost','COOKIE_SECURE':'0','BROWSER_TEST_PASSWORD':password}
    setup="from app import db,security;import os;db.initialize();security.add_user('owner','體驗管理者','owner',os.environ['BROWSER_TEST_PASSWORD'])"
    subprocess.run([sys.executable,'-c',setup],cwd=ROOT,env=env,check=True)
    log=open(OUT/'server-test.log','w')
    server=subprocess.Popen([sys.executable,'-m','uvicorn','app.main:app','--host','127.0.0.1','--port',str(port),'--no-proxy-headers','--no-access-log'],cwd=ROOT,env=env,stdout=log,stderr=log)
    try:
        for _ in range(100):
            try:
                if urlopen(base+'/api/health',timeout=1).status==200:break
            except Exception:time.sleep(.1)
        else:raise RuntimeError('Test server did not start')
        errors=[];results=[]
        with sync_playwright() as p:
            exe=os.getenv('CHROMIUM_EXECUTABLE') or shutil.which('chromium')
            browser=p.chromium.launch(**({'executable_path':exe} if exe else {}),headless=True,args=['--no-sandbox'])
            desktop=browser.new_context(viewport={'width':1440,'height':1000},locale='zh-TW',timezone_id='Asia/Taipei')
            mobile=browser.new_context(viewport={'width':390,'height':844},is_mobile=True,has_touch=True,device_scale_factor=1,locale='zh-TW',timezone_id='Asia/Taipei')
            page=desktop.new_page();page.on('pageerror',lambda e:errors.append(str(e)))
            phone=mobile.new_page();phone.on('pageerror',lambda e:errors.append(str(e)))
            bridge(page);bridge(phone);render_page(page);expect(page.locator('.meal-card')).to_have_count(8)
            page.screenshot(path=str(OUT/'customer-desktop.png'),full_page=True)
            render_page(phone);expect(phone.locator('.meal-card')).to_have_count(8)
            assert phone.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'Mobile horizontal overflow'
            phone.screenshot(path=str(OUT/'customer-mobile.png'),full_page=False)
            # Use tomorrow to keep test reliable even when executed near midnight.
            phone.locator('#pickup-day').select_option(index=1)
            phone.locator('[data-action="product"][data-id="pork"]').click()
            phone.locator('input[name="choice-rice"][value="half"]').check()
            phone.locator('#product-form input[name="note"]').fill('不需要餐具')
            phone.locator('#product-form button[type="submit"]').click()
            phone.locator('[data-action="mobile-cart"]').click()
            phone.locator('#mobile-cart-dialog [data-action="checkout"]').click()
            phone.locator('#checkout-form input[name="consent"]').check()
            if BRIDGE:phone.evaluate('window.armResponseLoss()')
            phone.locator('#checkout-form button[type="submit"]').click()
            if BRIDGE:
                expect(phone.locator('#dialog-error')).to_contain_text('尚未確認')
                phone.locator('#checkout-form button[type="submit"]').click()
                results.append('模擬後端已存單但回應遺失：同一表單重試沿用原筆識別碼，沒有建立重複訂單')
            expect(phone.locator('.ticket-number')).to_have_text('A001')
            token=phone.url.split('#order=')[1]
            day=phone.evaluate('state.track.day')
            results.append('手機：選餐、客製、購物車、預約、送單、私人查詢成功')
            phone.screenshot(path=str(OUT/'tracking-mobile.png'),full_page=True)
            render_page(page,'/staff/')
            page.locator('input[name="username"]').fill('owner');page.locator('input[name="password"]').fill(password)
            page.locator('#login-form button[type="submit"]').click()
            expect(page.locator('#staff-day')).to_be_visible()
            page.locator('#staff-day').fill(day);page.locator('#staff-day').dispatch_event('change')
            expect(page.locator('.order-card')).to_have_count(1)
            results.append('獨立店家瀏覽器：讀到顧客由另一瀏覽器寫入資料庫的訂單')
            page.screenshot(path=str(OUT/'staff-desktop.png'),full_page=True)
            for command in ['accept','prepare','ready']:
                page.locator(f'[data-command="{command}"]').click()
                time.sleep(.15)
            expect(phone.locator('.ticket-top strong')).to_have_text('可以取餐',timeout=12000)
            results.append('接單→製作→完成：顧客頁自動更新為可以取餐')
            page.locator('[data-command="pay"]').click()
            page.locator('#action-form input[name="confirm_cash"]').check();page.locator('#action-form button[type="submit"]').click()
            page.locator('[data-command="complete"]').click()
            expect(phone.locator('.ticket-top strong')).to_have_text('已取餐',timeout=12000)
            results.append('確認收現金→交付餐點：顧客端同步為已取餐')
            for tab,selector in [('inventory','.stock-table'),('reports','.metrics'),('settings','#settings-form'),('users','.panel'),('audit','.audit-row')]:
                page.locator(f'[data-tab="{tab}"]').click()
                # Check rendering via non-empty section and no errors, not cosmetic CSS classes.
                expect(page.locator('#staff-content')).not_to_have_text('正在讀取…')
                time.sleep(.2)
                assert 'undefined' not in page.locator('#staff-content').inner_text()
            results.append('菜單庫存、營業報表、營業設定、人員權限、操作紀錄皆正常載入')
            # Refresh must keep the tracking token / data, independent of browser memory.
            render_page(phone,'/') if BRIDGE else phone.reload();phone.evaluate('(t)=>location.hash="order="+t',token) if BRIDGE else None;expect(phone.locator('.ticket-top strong')).to_have_text('已取餐')
            results.append('重新載入後，資料庫訂單仍可查詢')
            # Isolated, self-contained file preview, with all network requests prohibited.
            offline=browser.new_context(viewport={'width':1440,'height':1000})
            demo=offline.new_page();demo.on('pageerror',lambda e:errors.append(str(e)))
            render_page(demo,'',offline=True);expect(demo.locator('.meal-card')).to_have_count(8)
            demo.locator('#pickup-day').select_option(index=1)
            demo.locator('[data-action="product"][data-id="pork"]').click();demo.locator('#product-form button[type="submit"]').click()
            demo.locator('#cart-panel [data-action="checkout"]').click();demo.locator('#checkout-form input[name="consent"]').check();demo.locator('#checkout-form button[type="submit"]').click()
            expect(demo.locator('.ticket-number')).to_have_text('A001')
            demo.evaluate('location.hash="staff"');demo.locator('#login-form button[type="submit"]').click()
            demo.locator('#staff-day').fill(day);demo.locator('#staff-day').dispatch_event('change')
            expect(demo.locator('.order-card')).to_have_count(1)
            for command in ['accept','prepare','ready']:demo.locator(f'[data-command="{command}"]').click();time.sleep(.1)
            demo.locator('[data-command="pay"]').click();demo.locator('#action-form input[name="confirm_cash"]').check();demo.locator('#action-form button[type="submit"]').click();demo.locator('[data-command="complete"]').click()
            results.append('單檔 HTML：無後端離線展示完成同一套點餐與收款流程')

            assert not errors, errors
            results.append('Chromium：無未處理 JavaScript 執行錯誤')
            (OUT/'browser-results.json').write_text(json.dumps({'passed':len(results),'checks':results,'javascript_errors':errors,'transport':'Python HTTP bridge' if BRIDGE else 'native browser fetch','limitation':'Managed browser blocks network navigation. Rendered about:blank, real local HTTP via test bridge. Native browser cookies, CSP execution, reverse proxy and real-device Safari not verified here.' if BRIDGE else None},ensure_ascii=False,indent=2))
            print(json.dumps({'passed':len(results),'checks':results,'javascript_errors':errors,'transport':'Python HTTP bridge' if BRIDGE else 'native browser fetch','limitation':'Managed browser blocks network navigation. Rendered about:blank, real local HTTP via test bridge. Native browser cookies, CSP execution, reverse proxy and real-device Safari not verified here.' if BRIDGE else None},ensure_ascii=False,indent=2))
            browser.close()
    finally:
        server.terminate();server.wait(timeout=10);log.close()
