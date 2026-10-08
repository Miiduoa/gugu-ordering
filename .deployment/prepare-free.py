"""Keep single-store housekeeping working without a billed Cron subscription."""
from pathlib import Path
import json,re
root=Path('cloudflare')
p=root/'src/worker.mjs';s=p.read_text()
helper='''async function privacyMaintenance(env, force = false) {
  const t = now();
  if (!force) {
    const lease = await first(env,
      "INSERT INTO rates(bucket,count,expires) VALUES('maintenance:privacy',1,?) ON CONFLICT(bucket) DO UPDATE SET expires=excluded.expires WHERE rates.expires<=? RETURNING count",
      t + 3600, t);
    if (!lease) return;
  }
  const s = await settings(env);
  try {
    await env.DB.batch([
      stmt(env, "DELETE FROM sessions WHERE expires<?", t),
      stmt(env, "DELETE FROM rates WHERE expires<? AND bucket<>'maintenance:privacy'", t),
      stmt(env,
        "UPDATE orders SET name='',phone='',note='',items=(SELECT json_group_array(json_remove(value,'$.note')) FROM json_each(items)) WHERE updated_at<? AND status IN ('completed','cancelled','rejected','no_show') AND (name<>'' OR phone<>'')",
        t - s.privacy_days * 86400),
    ]);
  } catch (e) {
    await run(env, "DELETE FROM rates WHERE bucket='maintenance:privacy'");
    throw e;
  }
}
'''
if 'async function privacyMaintenance' not in s:
    assert 'async function rate(' in s
    s=s.replace('async function rate(', helper+'async function rate(',1)
    needle='if (u.role === "kitchen") fail(403, "只有櫃台或店長可開放接單");'
    assert needle in s
    s=s.replace(needle,needle+'\n    await privacyMaintenance(env);',1)
    start=s.index('  async scheduled(controller, env, ctx) {')
    s=s[:start]+'''  async scheduled(controller, env, ctx) {
    await init(env);
    await maintenance(env, true);
    await privacyMaintenance(env, true);
  },
};
'''
    p.write_text(s)
p=root/'src/schema.mjs';s=p.read_text()
if 'orders_retention' not in s:
    pos=s.rfind('];');assert pos>=0
    s=s[:pos]+'''  `CREATE INDEX IF NOT EXISTS orders_retention ON orders(updated_at)`,
  `CREATE INDEX IF NOT EXISTS rates_expiry ON rates(expires)`,
'''+s[pos:];p.write_text(s)
p=root/'wrangler.jsonc';cfg=json.loads(re.sub(r",(\s*[}\]])",r"\1",p.read_text()));cfg.pop('triggers',None);p.write_text(json.dumps(cfg,ensure_ascii=False,indent=2)+'\n')
p=root/'README.md';s=p.read_text().replace('每日排程移除超過保留期限的已結束訂單個資，預設 30 天。','店家開啟接單工作台時清理過期登入及已結束訂單個資，開台期間每小時最多執行一次，預設保留 30 天。不依賴 Cron 或付費排程；若店家長時間完全不上線，清理延後至下次開台。');p.write_text(s)
p=root/'tests/system.test.mjs';s=p.read_text()
if 'without cron triggers' not in s:
    s+='''\ntest("staff heartbeat performs retention without cron triggers", async () => {
  const f = await ready(), o = (await f.order()).data;
  await action(f, o, "cancel");
  f.DB.sql.exec("UPDATE orders SET updated_at=0; DELETE FROM rates WHERE bucket='maintenance:privacy';");
  const r = await f.request("/api/admin/heartbeat", {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = f.DB.sql.prepare("SELECT * FROM orders").get();
  assert.equal(row.phone, ""); assert.equal(row.name, ""); assert.equal(row.total, 115);
  const lease = f.DB.sql.prepare("SELECT expires FROM rates WHERE bucket='maintenance:privacy'").get();
  assert.ok(lease.expires > NOW/1000);
  assert.equal((await f.request("/api/admin/heartbeat", {})).status, 200);
  assert.equal(f.DB.sql.prepare("SELECT expires FROM rates WHERE bucket='maintenance:privacy'").get().expires, lease.expires);
  f.close();
});
''';p.write_text(s)
print('Cron-independent housekeeping and regression test prepared.')
