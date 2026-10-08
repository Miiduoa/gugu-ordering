/* Offline walkthrough. NOT authentication, a server, or multi-device storage. */
(()=>{
 const clone=x=>JSON.parse(JSON.stringify(x));
 const now=()=>new Date(),iso=()=>now().toISOString(),today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Taipei',year:'numeric',month:'2-digit',day:'2-digit'}).format(now());
 const key='gugu:offline-demo:v1',seed=window.DEMO_SEED;
 let data;try{data=JSON.parse(localStorage.getItem(key))}catch{}
 if(!data||data.day!==today()) data={day:today(),store:{...clone(seed.store),version:1},products:clone(seed.products),inventory:{},orders:[],events:[],payments:[],users:[{id:1,username:'owner',name:'體驗管理者',role:'owner',active:true},{id:2,username:'cashier',name:'體驗櫃台',role:'cashier',active:true},{id:3,username:'kitchen',name:'體驗廚房',role:'kitchen',active:true}],counter:0};
 let current=null;try{current=JSON.parse(sessionStorage.getItem('gugu:demo-user'))}catch{}
 const save=()=>{try{localStorage.setItem(key,JSON.stringify(data))}catch{}};
 const fail=(status,message)=>{throw Object.assign(new Error(message),{status})};
 const event=(o,action,detail)=>{const e={id:data.events.length+1,action,detail,at:iso(),created_at:iso(),username:current?.username||'顧客',number:o?.number||null};data.events.unshift(e);if(o)o.events.push(e)};
 const remaining=(p,day)=>data.inventory[day+':'+p.id]??p.daily_stock;
 const restock=o=>{if(o.stock_released)return;for(const i of o.items){const p=data.products.find(p=>p.id===i.product_id);data.inventory[o.day+':'+p.id]=remaining(p,o.day)+i.quantity}o.stock_released=true};
 const clean=()=>{for(const o of data.orders)if(o.status==='pending'&&new Date(o.expires_at)<now()){restock(o);o.status='cancelled';o.version++;event(o,'expired','測試接單逾時，已自動取消。')}save()};
 const serialize=(o,staff=false)=>{const r=clone(o);delete r.request;delete r.key;delete r.token;delete r.stock_released;if(current?.role==='kitchen'&&staff)delete r.phone;else if(!staff)r.phone='••••'+r.phone.slice(-4);return r};
 const store=()=>({...data.store,mode:'demo',timezone:'Asia/Taipei',today:today(),server_time:iso(),accepting:!data.store.paused,payment_methods:['cash_on_pickup']});
 const slots=day=>{const out=[];if(data.store.paused||data.store.closed_dates.includes(day))return out;const cap=data.store.slot_capacity;for(let m=0;m<1440;m+=data.store.slot_minutes){const t=String(Math.floor(m/60)).padStart(2,'0')+':'+String(m%60).padStart(2,'0');if(new Date(day+'T'+t+':00+08:00')<new Date(Date.now()+data.store.prep_minutes*60000))continue;const used=data.orders.filter(o=>o.day===day&&o.slot===t&&!o.stock_released).reduce((n,o)=>n+o.portions,0);out.push({time:t,remaining:Math.max(0,cap-used)})}return out};
 const need=(roles=['owner','cashier','kitchen'])=>{if(!current)fail(401,'請先選擇體驗身分');if(!roles.includes(current.role))fail(403,'此體驗身分沒有操作權限')};
 const orderByToken=token=>{const o=data.orders.find(o=>o.token===token);if(!o)fail(404,'找不到這筆本機測試訂單');return o};
 function create(body){
  const old=data.orders.find(o=>o.key===body.idempotency_key);if(old){if(old.request!==JSON.stringify(body))fail(409,'同筆送單內容不一致');return{...serialize(old),token:old.token,replayed:true}}
  if(data.store.paused)fail(409,'目前暫停接單');const slot=slots(body.day).find(s=>s.time===body.slot);if(!slot)fail(409,'請重新選擇取餐時段');
  const portions=body.items.reduce((n,i)=>n+i.quantity,0);if(!portions||portions>40||portions>slot.remaining)fail(409,'取餐時段容量不足');
  let total=0;const resources={};const items=body.items.map(i=>{const p=data.products.find(p=>p.id===i.product_id);if(!p||!p.active||p.sold_out)fail(409,'餐點已售完');if(i.version!==p.version)fail(409,'餐點規格已更新，請重新加入');let price=p.price;const labels=[];for(const group of p.options){const c=group.choices.find(c=>c.id===i.choices[group.id]);if(!c&&group.required)fail(422,'請選擇餐點規格');if(c){price+=c.price;labels.push(c.name)}}resources[p.id]=(resources[p.id]||0)+i.quantity;total+=price*i.quantity;return{...clone(i),name:p.name,unit_price:price,line_total:price*i.quantity,labels}});
  for(const[id,n]of Object.entries(resources)){const p=data.products.find(p=>p.id===id);if(remaining(p,body.day)<n)fail(409,'餐點庫存不足')}
  for(const[id,n]of Object.entries(resources)){const p=data.products.find(p=>p.id===id);data.inventory[body.day+':'+id]=remaining(p,body.day)-n}
  data.counter++;const random=Array.from(crypto.getRandomValues(new Uint8Array(32)),n=>n.toString(16).padStart(2,'0')).join('');
  const o={public_id:random.slice(0,32),token:random,key:body.idempotency_key,request:JSON.stringify(body),number:'A'+String(data.counter).padStart(3,'0'),day:body.day,slot:body.slot,name:body.name,phone:body.phone,note:body.note||'',items,portions,total,status:'pending',payment:'unpaid',version:1,created_at:iso(),updated_at:iso(),expires_at:new Date(Date.now()+data.store.accept_timeout*60000).toISOString(),events:[],demo:1,source:'offline_preview',stock_released:false};data.orders.push(o);event(o,'created','測試訂單已送出，尚未通知真實店家。');save();return{...serialize(o),token:o.token,replayed:false};
 }
 function action(id,b){need();const o=data.orders.find(o=>o.public_id===id);if(!o)fail(404,'找不到訂單');if(o.version!==b.version)fail(409,'狀態已變更，請重新整理');if(current.role==='kitchen'&&!['accept','prepare','ready'].includes(b.action))fail(403,'廚房不能處理帳款');
  const transitions={accept:['pending','accepted'],prepare:['accepted','preparing'],ready:['preparing','ready'],complete:['ready','completed'],reject:['pending','rejected']};
  if(b.action==='pay'){if(o.status!=='ready'||o.payment!=='unpaid')fail(409,'目前無法收款');if(!b.confirm_cash)fail(422,'請確認測試收款');o.payment='paid';data.payments.push({day:today(),kind:'cash',amount:o.total})}
  else if(b.action==='refund'){need(['owner']);if(o.payment!=='paid'||!b.confirm_cash||!b.reason)fail(409,'請確認已收款與退款原因');o.payment='refunded';o.status='cancelled';data.payments.push({day:today(),kind:'refund',amount:o.total})}
  else if(['cancel','no_show'].includes(b.action)){if(!b.reason||o.payment!=='unpaid'||!['pending','accepted','preparing','ready'].includes(o.status))fail(409,'目前無法取消');if(b.action==='no_show'&&(o.status!=='ready'||now()<new Date(new Date(o.day+'T'+o.slot+':00+08:00').getTime()+1800000)))fail(409,'取餐時間超過 30 分鐘後才能標記');if(['pending','accepted'].includes(o.status))restock(o);o.status=b.action==='cancel'?'cancelled':'no_show'}
  else{const t=transitions[b.action];if(!t||o.status!==t[0])fail(409,'操作順序不符');if(b.action==='complete'&&o.payment!=='paid')fail(409,'請先收款');if(b.action==='reject'){if(!b.reason)fail(422,'請輸入原因');restock(o)}o.status=t[1]}
  o.version++;o.updated_at=iso();event(o,b.action,({accept:'店家已接單',prepare:'開始製作',ready:'餐點完成，可以取餐',pay:'測試現金已登記',complete:'取餐完成',refund:'測試退款已登記',cancel:'訂單已取消',reject:'店家無法接單',no_show:'未取餐'})[b.action]+(b.reason?'：'+b.reason:''));save();return serialize(o,true)
 }
 window.DemoAPI=async(path,method='GET',body={})=>{
  clean();const url=new URL(path,'https://offline.invalid'),p=url.pathname,day=url.searchParams.get('day')||today();let result;
  if(p==='/api/store')result=store();
  else if(p==='/api/menu')result={day,products:data.products.filter(p=>p.active).map(p=>({...p,remaining:remaining(p,day)}))};
  else if(p==='/api/slots')result={day,slots:slots(day),unit:'份'};
  else if(p==='/api/orders')result=create(body);
  else if(p==='/api/order/track')result=serialize(orderByToken(body.token));
  else if(p==='/api/order/cancel'){const o=orderByToken(body.token);if(o.status!=='pending'||o.version!==body.version)fail(409,'店家已接單或狀態已更新');restock(o);o.status='cancelled';o.version++;event(o,'cancelled','顧客取消測試訂單');result=serialize(o)}
  else if(p==='/api/board')result={orders:data.orders.filter(o=>o.day===today()&&['accepted','preparing','ready'].includes(o.status)).map(o=>({number:o.number,status:o.status,slot:o.slot})),time:iso(),mode:'demo'};
  else if(p==='/api/auth/login'){current=clone(data.users.find(u=>u.username===body.username));if(!current)fail(401,'體驗身分不存在');try{sessionStorage.setItem('gugu:demo-user',JSON.stringify(current))}catch{}result={user:current,csrf:'offline-not-a-real-session'}}
  else if(p==='/api/auth/me'){need();result={user:current,csrf:'offline-not-a-real-session'}}
  else if(p==='/api/auth/logout'){current=null;try{sessionStorage.removeItem('gugu:demo-user')}catch{}result={ok:true}}
  else if(p==='/api/auth/password')fail(422,'離線展示不使用真實密碼；正式系統可變更密碼');
  else if(p==='/api/staff/orders'){need();const offset=Number(url.searchParams.get('offset')||0),all=data.orders.filter(o=>o.day===day).sort((a,b)=>Number(!['pending','accepted','preparing','ready'].includes(a.status))-Number(!['pending','accepted','preparing','ready'].includes(b.status))||a.slot.localeCompare(b.slot));result={orders:all.slice(offset,offset+100).map(o=>serialize(o,true)),total:all.length,offset,limit:100,server_time:iso()}}
  else if(p==='/api/staff/pending-dates'){need();const dates={};for(const o of data.orders.filter(o=>o.status==='pending')){dates[o.day]??={day:o.day,pending:0,latest:0};dates[o.day].pending++;dates[o.day].latest=o.public_id}result={dates:Object.values(dates)}}
  else if(/^\/api\/staff\/orders\/.+\/action$/.test(p))result=action(p.split('/')[4],body);
  else if(p==='/api/staff/products'){need(['owner','cashier']);if(method==='GET')result={products:data.products.map(p=>({...p,remaining:remaining(p,day)}))};else{need(['owner']);const old=data.products.find(p=>p.id===body.id);if(old&&old.version!==body.version)fail(409,'菜單已更新');if(old)Object.assign(old,clone(body),{version:old.version+1});else data.products.push({...clone(body),version:1});event(null,'menu_updated',body.name);result={ok:true}}}
  else if(p==='/api/staff/stock'){need(['owner','cashier']);const prod=data.products.find(p=>p.id===body.product_id);if(remaining(prod,body.day)!==body.expected_remaining)fail(409,'庫存已變更');data.inventory[body.day+':'+prod.id]=body.remaining;event(null,'stock_updated',prod.name+' → '+body.remaining+'；'+body.reason);result={ok:true}}
  else if(p==='/api/staff/settings'||p==='/api/staff/pause'){need(p.endsWith('/pause')?['owner','cashier']:['owner']);if(body.version!==data.store.version)fail(409,'設定已更新');data.store={...data.store,...clone(body),version:data.store.version+1};result={ok:true}}
  else if(p==='/api/staff/reports'){need(['owner']);const orders=data.orders.filter(o=>o.day===day),products={},states={};for(const s of ['pending','accepted','preparing','ready','completed','cancelled','rejected','no_show'])states[s]=orders.filter(o=>o.status===s).length;for(const o of orders.filter(o=>o.status==='completed'&&o.payment==='paid'))for(const i of o.items){products[i.product_id]??={name:i.name,quantity:0,total:0};products[i.product_id].quantity+=i.quantity;products[i.product_id].total+=i.line_total}const cash=data.payments.filter(p=>p.day===day&&p.kind==='cash').reduce((n,p)=>n+p.amount,0),refund=data.payments.filter(p=>p.day===day&&p.kind==='refund').reduce((n,p)=>n+p.amount,0);result={day,orders:orders.length,states,cash_received:cash,cash_refunded:refund,net_cash:cash-refund,completed_total:orders.filter(o=>o.status==='completed'&&o.payment==='paid').reduce((n,o)=>n+o.total,0),products:Object.values(products).sort((a,b)=>b.quantity-a.quantity)}}
  else if(p==='/api/staff/export'){need(['owner']);result={csv:'\uFEFF取餐號碼,日期,時間,狀態,份數,金額\n'+data.orders.filter(o=>o.day===day).map(o=>[o.number,o.day,o.slot,o.status,o.portions,o.total].join(',')).join('\n')}}
  else if(p==='/api/staff/users'){need(['owner']);if(method==='GET')result={users:data.users};else{if(data.users.some(u=>u.username===body.username))fail(409,'帳號已存在');data.users.push({id:data.users.length+1,username:body.username,name:body.name,role:body.role,active:true});result={ok:true}}}
  else if(/^\/api\/staff\/users\/\d+$/.test(p)){need(['owner']);const u=data.users.find(u=>u.id===Number(p.split('/').at(-1)));if(!u||u.role==='owner')fail(403,'不能修改管理者');u.active=body.active;result={ok:true}}
  else if(p==='/api/staff/audit'){need(['owner']);const offset=Number(url.searchParams.get('offset')||0);result={events:data.events.slice(offset,offset+100)}}
  else fail(404,'此功能需要啟動完整後端；離線版不模擬外部服務');
  save();return clone(result);
 };
 save();
})();
