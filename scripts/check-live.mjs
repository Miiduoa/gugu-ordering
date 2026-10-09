// Read-only public verification. Never logs in, submits orders, or changes stock.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const arg=process.argv[2];
if (!arg) { console.error('Usage: npm run check:live -- https://YOUR-WORKER.workers.dev'); process.exit(2); }
const base=new URL(arg);
if (base.protocol!=='https:' || base.username || base.password || base.hash || base.search) throw Error('Provide the public HTTPS site URL, without credentials or query parameters');
const results=[];
async function get(path) {
  const res=await fetch(new URL(path,base), {signal:AbortSignal.timeout(30000), redirect:'error'});
  return {status:res.status, type:res.headers.get('content-type')||'', body:await res.text()};
}
try {
  const home=await get('/');
  if(home.status!==200 || /互動體驗版|GUGU_PREVIEW|window\.DemoAPI/.test(home.body)) throw Error('Homepage is blocked or still contains offline demo code');
  const health=await get('/api/health');
  if(health.status!==200 || !health.type.includes('application/json')) throw Error('Real API is missing, blocked, or replaced by static HTML');
  const h=JSON.parse(health.body);
  if(h.ok!==true || h.mode!=='live' || h.storage!=='D1') throw Error('The endpoint is not the live D1 application');
  results.push('D1 health and live mode verified');
  const client=await get('/static/app.js');
  const digest=x=>createHash('sha256').update(x).digest('hex');
  const expected=readFileSync(new URL('../cloudflare/public/static/app.js',import.meta.url));
  if(client.status!==200 || digest(client.body)!==digest(expected)) throw Error('The public frontend differs from the verified production source');
  results.push('Public frontend exactly matches production source');
  const s=await get('/api/store');
  if(s.status!==200 || !s.type.includes('application/json')) throw Error('Store API not healthy');
  const store=JSON.parse(s.body);
  results.push({needs_setup:store.needs_setup,accepting:store.accepting});
  console.log(JSON.stringify({public_verified:true,origin:base.origin,checks:results},null,2));
} catch(e) { console.error(JSON.stringify({public_verified:false,origin:base.origin,error:e.message,checks:results},null,2)); process.exitCode=1; }
