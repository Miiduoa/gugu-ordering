import { schema } from "./schema.mjs";
import { products as seedProducts, defaults } from "./menu.mjs";

function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
function validWebP(bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    d = new TextDecoder();
  if (v.getUint32(4, true) + 8 !== bytes.length) return false;
  let found = false;
  for (let i = 12; i + 8 <= bytes.length; ) {
    let type = d.decode(bytes.subarray(i, i + 4)),
      len = v.getUint32(i + 4, true),
      j = i + 8;
    if (j + len > bytes.length) return false;
    if (type === "ANIM" || type === "ANMF") return false;
    if (type === "VP8 ") {
      if (
        len < 10 ||
        bytes[j + 3] !== 157 ||
        bytes[j + 4] !== 1 ||
        bytes[j + 5] !== 42
      )
        return false;
      let w = v.getUint16(j + 6, true) & 16383,
        h = v.getUint16(j + 8, true) & 16383;
      if (!w || !h || w > 1024 || h > 1024) return false;
      found = true;
    }
    if (type === "VP8L") {
      if (len < 5 || bytes[j] !== 47) return false;
      let n = v.getUint32(j + 1, true),
        w = (n & 16383) + 1,
        h = ((n >>> 14) & 16383) + 1;
      if (w > 1024 || h > 1024) return false;
      found = true;
    }
    if (type === "VP8X") {
      if (len < 10 || bytes[j] & 2) return false;
      let w = 1 + bytes[j + 4] + (bytes[j + 5] << 8) + (bytes[j + 6] << 16),
        h = 1 + bytes[j + 7] + (bytes[j + 8] << 8) + (bytes[j + 9] << 16);
      if (w > 1024 || h > 1024) return false;
    }
    i = j + len + (len % 2);
  }
  return found;
}
const encoder = new TextEncoder(),
  booted = new WeakSet(),
  cleaned = new WeakMap();
const now = () => Math.floor(Date.now() / 1000);
export const dayAt = (t) =>
  new Date(t * 1000 + 28800000).toISOString().slice(0, 10);
const stamp = (d, t) => Math.floor(Date.parse(`${d}T${t}:00+08:00`) / 1000);
const activeStatuses = ["pending", "accepted", "preparing", "ready"];
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
export const hash = async (text) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const equal = (a, b) => {
  let x = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    x |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return x === 0;
};
class Fault extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (s, m) => {
  throw new Fault(s, m);
};
const json = (v, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
const stmt = (env, sql, ...params) => env.DB.prepare(sql).bind(...params);
const first = (env, sql, ...p) => stmt(env, sql, ...p).first();
const all = async (env, sql, ...p) =>
  (await stmt(env, sql, ...p).all()).results;
const run = (env, sql, ...p) => stmt(env, sql, ...p).run();
const guard = (env, sql, ...p) =>
  stmt(
    env,
    `INSERT INTO tx_guards(pass) SELECT CASE WHEN (${sql}) THEN 1 ELSE 0 END`,
    ...p,
  );
async function batch(env, statements) {
  return env.DB.batch([...statements, stmt(env, "DELETE FROM tx_guards")]);
}
const text = (x, max = 100) => {
  if (
    typeof x !== "string" ||
    x.trim().length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(x)
  )
    fail(422, "文字欄位格式不正確");
  return x.trim();
};
const integer = (x, min, max) => {
  if (!Number.isInteger(x) || x < min || x > max)
    fail(422, `數字需介於 ${min}–${max}`);
  return x;
};
const username = (x) => {
  x = text(x, 32).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(x))
    fail(422, "帳號需為 3–32 個英數字、點、底線或連字號");
  return x;
};
const proof = (x) => {
  if (typeof x !== "string" || !/^\w{64}$/.test(x) || !/^[a-f0-9]+$/.test(x))
    fail(422, "密碼驗證資料不正確");
  return x;
};
const publicUser = (u) => ({
  id: u.id,
  username: u.username,
  name: u.name,
  role: u.role,
  active: !!u.active,
  version: u.version,
  salt: u.salt,
});
const parseOrder = (o, privateInfo = false) => {
  let r = {
    id: o.id,
    number: String(o.seq).padStart(4, "0"),
    day: o.day,
    slot: o.slot,
    items: JSON.parse(o.items),
    units: o.units,
    total: o.total,
    discount: o.discount,
    own_boxes: o.own_boxes,
    soup: !!o.soup,
    status: o.status,
    payment: o.payment,
    created_at: o.created_at,
    expires_at: o.expires_at,
    version: o.version,
    note: o.note,
  };
  if (privateInfo) Object.assign(r, { name: o.name, phone: o.phone });
  return r;
};
async function init(env) {
  if (!env.DB) fail(503, "資料庫尚未連接，暫不接單");
  if (booted.has(env.DB)) return;
  // Existing installations use one lookup; cold starts must not replay all schema queries.
  try {
    if (await first(env, "SELECT seeded FROM installation WHERE id=1")) {
      booted.add(env.DB);
      return;
    }
  } catch (e) {
    if (!/no such table/i.test(String(e))) throw e;
  }
  await env.DB.batch([
    ...schema.map((s) => stmt(env, s)),
    stmt(
      env,
      "INSERT OR IGNORE INTO settings(id,data) VALUES(1,?)",
      JSON.stringify(defaults),
    ),
    ...seedProducts.map((p) =>
      stmt(
        env,
        `INSERT OR IGNORE INTO products(id,name,price,single_price,description,kind,category,photo,photo_note,active,version,sort) SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM installation WHERE id=1)`,
        p.id,
        p.name,
        p.price,
        p.single_price,
        p.description,
        p.kind,
        p.category,
        p.photo,
        p.photo_note,
        p.active,
        p.version,
        p.sort,
      ),
    ),
    stmt(
      env,
      "INSERT OR IGNORE INTO installation(id,seeded,salt_key) VALUES(1,1,?)",
      random(),
    ),
  ]);
  booted.add(env.DB);
}
async function settings(env) {
  const row = await first(env, "SELECT * FROM settings WHERE id=1");
  return { ...JSON.parse(row.data), version: row.version };
}
function hours(s, day) {
  if (s.closed_dates.includes(day)) return [];
  return s.hours[new Date(`${day}T12:00:00+08:00`).getUTCDay()] || [];
}
function inHours(s, t) {
  return hours(s, dayAt(t)).some(
    ([a, b]) => t >= stamp(dayAt(t), a) && t < stamp(dayAt(t), b),
  );
}
async function present(env) {
  return !!(await first(
    env,
    `SELECT 1 FROM presence p JOIN users u ON u.id=p.user_id WHERE u.active=1 AND u.role IN ('owner','cashier') AND p.seen>? LIMIT 1`,
    now() - 90,
  ));
}
async function accepting(env, s) {
  return (
    !s.paused &&
    s.verified &&
    s.open_until > now() &&
    inHours(s, now()) &&
    (await present(env))
  );
}
function validDay(day, max = 7) {
  if (
    typeof day !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !Number.isFinite(stamp(day, "12:00")) ||
    dayAt(stamp(day, "12:00")) !== day ||
    day < dayAt(now()) ||
    day > dayAt(now() + max * 86400)
  )
    fail(422, "取餐日期不正確");
  return day;
}
async function maintenance(env, force = false) {
  let t = now();
  if (!force && (cleaned.get(env.DB) || 0) > t - 30) return;
  await run(
    env,
    "UPDATE orders SET status='cancelled',version=version+1,updated_at=? WHERE status='pending' AND expires_at<=?",
    t,
    t,
  );
  cleaned.set(env.DB, t);
}
async function rate(env, key, max = 20, seconds = 300) {
  let t = now();
  let row = await first(
    env,
    `INSERT INTO rates(bucket,count,expires) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET count=CASE WHEN rates.expires<=? THEN 1 ELSE rates.count+1 END,expires=CASE WHEN rates.expires<=? THEN ? ELSE rates.expires END RETURNING count`,
    key,
    t + seconds,
    t,
    t,
    t + seconds,
  );
  if (row.count > max) fail(429, "操作太頻繁，請稍候再試");
}
async function readBody(req) {
  const limit = 145000,
    reader = req.body?.getReader();
  let n = 0,
    parts = [];
  if (!reader) fail(400, "缺少資料");
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) {
      await reader.cancel();
      fail(413, "檔案或資料太大");
    }
    parts.push(value);
  }
  let raw = new Uint8Array(n),
    off = 0;
  for (let p of parts) {
    raw.set(p, off);
    off += p.length;
  }
  try {
    let v = JSON.parse(new TextDecoder().decode(raw));
    if (!v || typeof v !== "object" || Array.isArray(v)) throw Error();
    return v;
  } catch {
    fail(400, "資料格式不正確");
  }
}
async function auth(req, env, roles = null) {
  const token = (req.headers.get("cookie") || "")
    .split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith("gugu_session="))
    ?.split("=")[1];
  if (!token) fail(401, "請先登入");
  let h = await hash(token),
    u = await first(
      env,
      `SELECT u.*,s.csrf,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires>? AND u.active=1`,
      h,
      now(),
    );
  if (!u) fail(401, "登入已失效，請重新登入");
  if (roles && !roles.includes(u.role)) fail(403, "此帳號無此操作權限");
  if (
    !["GET", "HEAD"].includes(req.method) &&
    !equal(req.headers.get("x-csrf-token") || "", u.csrf)
  )
    fail(403, "操作驗證失敗，請重新登入");
  return u;
}
const authGuard = (env, u) =>
  guard(
    env,
    `EXISTS(SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=? AND u.version=? AND u.active=1 AND s.token_hash=? AND s.expires>?)`,
    u.id,
    u.version,
    u.token_hash,
    now(),
  );
const event = (env, u, action, oid = "", detail = "") =>
  stmt(
    env,
    "INSERT INTO events(order_id,user_id,action,detail,created_at) VALUES(?,?,?,?,?)",
    oid,
    u?.id || "",
    action,
    detail,
    now(),
  );
async function reauth(u, b) {
  if (!equal(await hash(proof(b.current_proof)), u.verifier))
    fail(403, "目前密碼不正確");
}
async function getOrder(req, env, id) {
  let key = req.headers.get("x-order-token") || "";
  if (!/^[a-f0-9]{64}$/.test(key)) fail(404, "找不到訂單");
  let o = await first(
    env,
    "SELECT * FROM orders WHERE id=? AND key_hash=?",
    id,
    await hash(key),
  );
  if (!o) fail(404, "找不到訂單");
  return o;
}
async function slots(env, s, day) {
  validDay(day, s.advance_days);
  let taken = await all(
      env,
      `SELECT slot,SUM(units) AS units FROM orders WHERE day=? AND status IN ('pending','accepted','preparing','ready','completed') AND NOT(status='pending' AND expires_at<=?) GROUP BY slot`,
      day,
      now(),
    ),
    used = Object.fromEntries(taken.map((x) => [x.slot, x.units]));
  let out = [];
  for (const [a, b] of hours(s, day))
    for (let t = stamp(day, a); t < stamp(day, b); t += s.slot_minutes * 60) {
      let slot = new Date(t * 1000 + 28800000).toISOString().slice(11, 16);
      if (t >= now() + s.prep_minutes * 60)
        out.push({
          time: slot,
          remaining: Math.max(0, s.slot_capacity - (used[slot] || 0)),
        });
    }
  return out;
}
async function createOrder(req, env, b, ip) {
  let key = proof(b.client_key),
    fingerprint = await hash(
      JSON.stringify({
        day: b.day,
        slot: b.slot,
        name: b.name,
        phone: b.phone,
        note: b.note,
        items: b.items,
        own_boxes: b.own_boxes || 0,
        soup: !!b.soup,
      }),
    ),
    keyHash = await hash(key);
  let old = await first(env, "SELECT * FROM orders WHERE key_hash=?", keyHash);
  if (old) {
    if (old.fingerprint !== fingerprint)
      fail(409, "這次送單的內容與先前不同，請重新確認購物車");
    return json(parseOrder(old, true));
  }
  await rate(env, `order:${ip}`, 12, 300);
  await maintenance(env, true);
  let s = await settings(env);
  if (!(await accepting(env, s)))
    fail(409, "店家目前沒有開放線上接單，請稍後或於營業時間致電");
  validDay(b.day, s.advance_days);
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 20)
    fail(422, "請選擇 1–20 筆餐點");
  let name = text(b.name, 30),
    phone = text(b.phone, 10),
    note = text(b.note || "", 300);
  if (!name || !/^09\d{8}$/.test(phone)) fail(422, "請填稱呼及台灣手機號碼");
  if (b.consent !== true) fail(422, "請同意聯絡及取餐所需的資料處理");
  let available = await slots(env, s, b.day);
  if (!available.some((x) => x.time === b.slot))
    fail(409, "此取餐時段已不可用");
  let ids = [...new Set(b.items.map((x) => text(x.id, 60)))],
    rows = await all(
      env,
      `SELECT * FROM products WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    ),
    lookup = Object.fromEntries(rows.map((p) => [p.id, p])),
    items = [],
    resources = {},
    total = 0,
    units = 0,
    meals = 0;
  for (const x of b.items) {
    let p = lookup[x.id];
    if (!p || !p.active || p.version !== x.version)
      fail(409, "菜單已更新，請重新選餐");
    let qty = integer(x.qty, 1, 20),
      single = x.variant === "single";
    if (x.variant !== "meal" && !single) fail(422, "規格錯誤");
    if (single && p.single_price === null) fail(422, "此品項不提供單點主菜");
    let isMeal = p.kind === "meal" && !single,
      rice = isMeal ? text(x.rice || "normal", 20) : "normal",
      spicy = p.id === "basil" ? text(x.spicy || "mild", 20) : "";
    if (
      !["normal", "half", "veggies", "sweet-potato"].includes(rice) ||
      (spicy && !["mild", "medium", "hot"].includes(spicy))
    )
      fail(422, "飯量或辣度不正確");
    let price = single ? p.single_price : p.price;
    items.push({
      id: p.id,
      name: p.name,
      variant: single ? "single" : "meal",
      kind: p.kind,
      qty,
      price,
      rice,
      spicy,
      version: p.version,
    });
    resources[p.id] = (resources[p.id] || 0) + qty;
    total += price * qty;
    units += qty;
    if (isMeal) meals += qty;
  }
  if (units > 30) fail(422, "每單最多 30 份，團體訂餐請致電");
  let own = integer(b.own_boxes || 0, 0, meals),
    discount = own * 2;
  total -= discount;
  let id = crypto.randomUUID(),
    t = now(),
    st = JSON.stringify(items),
    rs = JSON.stringify(resources);
  const q = [
    authoredGuard(env, s),
    guard(
      env,
      "(SELECT COUNT(*) FROM orders WHERE status IN ('pending','accepted','preparing','ready'))<900",
    ),
    guard(
      env,
      `NOT EXISTS(SELECT 1 FROM json_each(?) x LEFT JOIN products p ON p.id=json_extract(x.value,'$.id') WHERE p.id IS NULL OR p.active<>1 OR p.version<>json_extract(x.value,'$.version'))`,
      st,
    ),
    guard(
      env,
      `(SELECT COALESCE(SUM(units),0) FROM orders WHERE day=? AND slot=? AND status IN ('pending','accepted','preparing','ready','completed'))+?<=?`,
      b.day,
      b.slot,
      units,
      s.slot_capacity,
    ),
    guard(
      env,
      `(SELECT COUNT(*) FROM orders WHERE phone=? AND status IN ('pending','accepted','preparing','ready'))<3`,
      phone,
    ),
    guard(
      env,
      `NOT EXISTS(SELECT 1 FROM json_each(?) r LEFT JOIN inventory i ON i.day=? AND i.product_id=r.key WHERE i.product_id IS NULL OR i.remaining<CAST(r.value AS INTEGER))`,
      rs,
      b.day,
    ),
    stmt(
      env,
      `INSERT INTO orders(id,key_hash,fingerprint,day,slot,pickup_at,name,phone,note,items,resources,units,total,discount,own_boxes,soup,status,created_at,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`,
      id,
      keyHash,
      fingerprint,
      b.day,
      b.slot,
      stamp(b.day, b.slot),
      name,
      phone,
      note,
      st,
      rs,
      units,
      total,
      discount,
      own,
      b.soup ? 1 : 0,
      t,
      t + s.accept_timeout * 60,
      t,
    ),
    event(env, null, "created", id),
  ];
  try {
    await batch(env, q);
  } catch (e) {
    let o = await first(env, "SELECT * FROM orders WHERE key_hash=?", keyHash);
    if (o && o.fingerprint === fingerprint) return json(parseOrder(o, true));
    if (String(e).includes("constraint") || String(e).includes("CHECK"))
      fail(409, "庫存、時段或接單狀態剛有變動，請重新確認；沒有成立新訂單");
    throw e;
  }
  return json(
    parseOrder(await first(env, "SELECT * FROM orders WHERE id=?", id), true),
    201,
  );
}
function authoredGuard(env, s) {
  return guard(
    env,
    `EXISTS(SELECT 1 FROM settings WHERE id=1 AND version=? AND json_extract(data,'$.paused')=0 AND json_extract(data,'$.verified')=1 AND json_extract(data,'$.open_until')>?) AND EXISTS(SELECT 1 FROM presence p JOIN users u ON u.id=p.user_id WHERE u.active=1 AND u.role IN ('owner','cashier') AND p.seen>?)`,
    s.version,
    now(),
    now() - 90,
  );
}
async function route(req, env, ctx) {
  let url = new URL(req.url),
    path = url.pathname,
    method = req.method,
    t = now();
  if (!path.startsWith("/api/")) return env.ASSETS.fetch(req);
  await init(env);
  await maintenance(env);
  const ip = await hash(req.headers.get("cf-connecting-ip") || "local");
  let b = {};
  if (!["GET", "HEAD"].includes(method)) {
    if (
      req.headers.get("origin") !== url.origin ||
      req.headers.get("x-requested-with") !== "Gugu"
    )
      fail(403, "不允許跨網站操作");
    if (!(req.headers.get("content-type") || "").startsWith("application/json"))
      fail(415, "請使用 JSON 格式");
    b = await readBody(req);
  }
  if (path === "/api/health")
    return json({ ok: true, version: "2.0.0", mode: "live", storage: "D1" });
  if (path === "/api/store" && method === "GET") {
    let s = await settings(env),
      owner = !!(await first(
        env,
        "SELECT 1 FROM users WHERE role='owner' LIMIT 1",
      ));
    return json({
      ...s,
      today: dayAt(t),
      server_time: t,
      accepting: owner && (await accepting(env, s)),
      needs_setup: !owner,
      mode: "live",
    });
  }
  if (path === "/api/menu" && method === "GET") {
    let day = validDay(url.searchParams.get("day") || dayAt(t));
    return json({
      products: await all(
        env,
        "SELECT p.*,COALESCE(i.remaining,0) AS remaining FROM products p LEFT JOIN inventory i ON i.product_id=p.id AND i.day=? WHERE p.active=1 ORDER BY p.sort,p.id",
        day,
      ),
    });
  }
  if (path === "/api/slots" && method === "GET")
    return json({
      slots: await slots(env, await settings(env), url.searchParams.get("day")),
    });
  if (path === "/api/setup" && method === "POST") {
    await rate(env, `setup:${ip}`, 5, 900);
    if (
      !env.SETUP_KEY_HASH ||
      !equal(await hash(text(b.setup_key, 200)), env.SETUP_KEY_HASH)
    )
      fail(403, "啟用碼不正確");
    let un = username(b.username),
      salt = proof(b.salt),
      verifier = await hash(proof(b.proof)),
      name = text(b.name || "店長", 30);
    try {
      await batch(env, [
        guard(env, "NOT EXISTS(SELECT 1 FROM users)"),
        stmt(
          env,
          "INSERT INTO users(id,username,name,role,salt,verifier) VALUES(?,?,?,'owner',?,?)",
          crypto.randomUUID(),
          un,
          name,
          salt,
          verifier,
        ),
        event(env, null, "owner_initialized"),
      ]);
    } catch (e) {
      if (await first(env, "SELECT 1 FROM users LIMIT 1"))
        fail(409, "管理者已建立，請直接登入");
      throw e;
    }
    return json({ ok: true }, 201);
  }
  if (path === "/api/auth/salt" && method === "GET") {
    await rate(env, `salt:${ip}`, 60, 300);
    let name = (url.searchParams.get("username") || "").toLowerCase(),
      u = await first(
        env,
        "SELECT salt FROM users WHERE username=? AND active=1",
        name,
      );
    let secret = (
      await first(env, "SELECT salt_key FROM installation WHERE id=1")
    ).salt_key;
    return json({
      salt: u?.salt || (await hash(secret + ":" + name)),
      iterations: 600000,
    });
  }
  if (path === "/api/login" && method === "POST") {
    await rate(env, `login:${ip}`, 10, 900);
    let un = username(b.username),
      u = await first(
        env,
        "SELECT * FROM users WHERE username=? AND active=1",
        un,
      ),
      v = await hash(proof(b.proof));
    if (!u || !equal(v, u.verifier)) fail(401, "帳號或密碼不正確");
    let token = random(),
      csrf = random(),
      h = await hash(token);
    await batch(env, [
      guard(
        env,
        "EXISTS(SELECT 1 FROM users WHERE id=? AND version=? AND active=1)",
        u.id,
        u.version,
      ),
      stmt(
        env,
        "INSERT INTO sessions(token_hash,user_id,csrf,expires) VALUES(?,?,?,?)",
        h,
        u.id,
        csrf,
        t + 28800,
      ),
      event(env, u, "login"),
    ]);
    return json({ user: publicUser(u), csrf }, 200, {
      "Set-Cookie": `gugu_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=28800`,
    });
  }
  if (path === "/api/me" && method === "GET") {
    let u = await auth(req, env);
    return json({ user: publicUser(u), csrf: u.csrf });
  }
  if (path === "/api/logout" && method === "POST") {
    let u = await auth(req, env);
    await run(env, "DELETE FROM sessions WHERE token_hash=?", u.token_hash);
    await run(env, "DELETE FROM presence WHERE user_id=?", u.id);
    return json({ ok: true }, 200, {
      "Set-Cookie":
        "gugu_session=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0",
    });
  }
  if (path === "/api/account" && method === "POST") {
    let u = await auth(req, env);
    await rate(env, `account:${ip}`, 10, 900);
    await reauth(u, b);
    let un = username(b.username),
      name = text(b.name, 30),
      salt = b.new_proof ? proof(b.new_salt) : u.salt,
      verifier = b.new_proof ? await hash(proof(b.new_proof)) : u.verifier;
    if (
      await first(
        env,
        "SELECT 1 FROM users WHERE username=? AND id<>?",
        un,
        u.id,
      )
    )
      fail(409, "此帳號名稱已被使用");
    await batch(env, [
      authGuard(env, u),
      stmt(
        env,
        "UPDATE users SET username=?,name=?,salt=?,verifier=?,version=version+1 WHERE id=?",
        un,
        name,
        salt,
        verifier,
        u.id,
      ),
      stmt(env, "DELETE FROM sessions WHERE user_id=?", u.id),
      stmt(env, "DELETE FROM presence WHERE user_id=?", u.id),
      event(env, u, "account_changed"),
    ]);
    return json({ ok: true, relogin: true });
  }
  if (path === "/api/orders" && method === "POST")
    return createOrder(req, env, b, ip);
  let match = path.match(/^\/api\/orders\/([a-f0-9-]{36})(\/cancel)?$/);
  if (match) {
    let o = await getOrder(req, env, match[1]);
    if (method === "GET" && !match[2]) return json(parseOrder(o, true));
    if (method === "POST" && match[2]) {
      if (o.status !== "pending") fail(409, "店家已處理訂單，取消請致電店家");
      await batch(env, [
        guard(
          env,
          "EXISTS(SELECT 1 FROM orders WHERE id=? AND version=? AND status='pending')",
          o.id,
          o.version,
        ),
        stmt(
          env,
          "UPDATE orders SET status='cancelled',version=version+1,updated_at=? WHERE id=?",
          t,
          o.id,
        ),
        event(env, null, "customer_cancelled", o.id),
      ]);
      return json({ ok: true });
    }
  }
  if (path === "/api/display" && method === "GET")
    return json({
      orders: (
        await all(
          env,
          "SELECT seq,status FROM orders WHERE day=? AND status IN ('preparing','ready') ORDER BY pickup_at LIMIT 100",
          dayAt(t),
        )
      ).map((o) => ({
        number: String(o.seq).padStart(4, "0"),
        status: o.status,
      })),
    });
  if (path.startsWith("/api/media/") && method === "GET") {
    let id = path.slice(11);
    if (!/^[a-f0-9]{64}$/.test(id)) fail(404, "找不到圖片");
    let item = await first(env, "SELECT * FROM media WHERE id=?", id);
    if (!item) fail(404, "找不到圖片");
    return new Response(new Uint8Array(item.body), {
      headers: {
        "Content-Type": item.mime,
        "Cache-Control": "public, max-age=31536000, immutable",
        ETag: `"${id}"`,
      },
    });
  }
  if (!path.startsWith("/api/admin/")) fail(404, "找不到此功能");
  let u = await auth(req, env);
  if (path === "/api/admin/heartbeat" && method === "POST") {
    if (u.role === "kitchen") fail(403, "只有櫃台或店長可開放接單");
    await run(
      env,
      "INSERT INTO presence(user_id,seen) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seen=excluded.seen",
      u.id,
      t,
    );
    return json({ ok: true });
  }
  if (path === "/api/admin/orders" && method === "GET") {
    let day = url.searchParams.get("day") || dayAt(t);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(422, "日期不正確");
    let rows = await all(
      env,
      "SELECT * FROM orders WHERE day=? OR status='pending' ORDER BY CASE WHEN status IN ('pending','accepted','preparing','ready') THEN 0 ELSE 1 END,pickup_at,seq LIMIT 1001",
      day,
    );
    let truncated = rows.length > 1000;
    rows = rows.slice(0, 1000);
    return json({
      truncated,
      orders: rows.map((o) => {
        let p = parseOrder(o, u.role !== "kitchen");
        if (u.role === "kitchen") p.note = o.note;
        return p;
      }),
    });
  }
  match = path.match(/^\/api\/admin\/orders\/([a-f0-9-]{36})\/action$/);
  if (match && method === "POST") {
    await maintenance(env, true);
    let o = await first(env, "SELECT * FROM orders WHERE id=?", match[1]);
    if (!o) fail(404, "訂單不存在");
    if (o.version !== b.version) fail(409, "訂單剛有更新，請重新查看");
    let action = b.action,
      next = {
        accept: ["pending", "accepted"],
        prepare: ["accepted", "preparing"],
        ready: ["preparing", "ready"],
        complete: ["ready", "completed"],
      }[action],
      q = [
        authGuard(env, u),
        guard(
          env,
          "EXISTS(SELECT 1 FROM orders WHERE id=? AND version=?)",
          o.id,
          o.version,
        ),
      ];
    if (u.role === "kitchen" && !["prepare", "ready"].includes(action))
      fail(403, "廚房帳號只能更新製作狀態");
    if (next) {
      if (o.status !== next[0] || (action === "accept" && o.expires_at <= t))
        fail(409, "訂單目前無法執行此操作");
      if (action === "complete" && o.payment !== "paid")
        fail(409, "請先確認收款，再交付");
      q.push(
        stmt(
          env,
          "UPDATE orders SET status=?,version=version+1,updated_at=? WHERE id=?",
          next[1],
          t,
          o.id,
        ),
      );
    } else if (["cancel", "reject", "no_show"].includes(action)) {
      if (
        !activeStatuses.includes(o.status) ||
        (action === "reject" && o.status !== "pending")
      )
        fail(409, "訂單目前無法取消");
      q.push(
        stmt(
          env,
          "UPDATE orders SET status=?,version=version+1,updated_at=? WHERE id=?",
          action === "reject"
            ? "rejected"
            : action === "no_show"
              ? "no_show"
              : "cancelled",
          t,
          o.id,
        ),
      );
    } else if (action === "paid") {
      if (
        o.payment !== "unpaid" ||
        !["accepted", "preparing", "ready"].includes(o.status)
      )
        fail(409, "訂單目前無法收款");
      if (b.confirmed !== true) fail(422, "請確認實際收到現金與自備餐盒折扣");
      q.push(
        stmt(
          env,
          "INSERT INTO payments(order_id,user_id,kind,amount,created_at) VALUES(?,?,'cash',?,?)",
          o.id,
          u.id,
          o.total,
          t,
        ),
        stmt(
          env,
          "UPDATE orders SET payment='paid',version=version+1,updated_at=? WHERE id=?",
          t,
          o.id,
        ),
      );
    } else if (action === "refund") {
      if (u.role !== "owner") fail(403, "退款需要店長權限");
      if (
        o.payment !== "paid" ||
        b.confirmed !== true ||
        !["completed", "cancelled", "rejected", "no_show"].includes(o.status)
      )
        fail(409, "請先結束或取消訂單，再確認已實際退款");
      q.push(
        stmt(
          env,
          "INSERT INTO payments(order_id,user_id,kind,amount,created_at) VALUES(?,?,'refund',?,?)",
          o.id,
          u.id,
          -o.total,
          t,
        ),
        stmt(
          env,
          "UPDATE orders SET payment='refunded',version=version+1,updated_at=? WHERE id=?",
          t,
          o.id,
        ),
      );
    } else fail(422, "操作不正確");
    q.push(event(env, u, action, o.id));
    await batch(env, q);
    return json({ ok: true });
  }
  if (path === "/api/admin/settings" && method === "GET")
    return json(await settings(env));
  if (path === "/api/admin/open" && method === "POST") {
    if (!["owner", "cashier"].includes(u.role)) fail(403, "無權限");
    let s = await settings(env);
    if (b.open) {
      if (b.confirmed !== true) fail(422, "請確認菜單、庫存及營業設定");
      if (!s.verified && u.role !== "owner") fail(403, "首次啟用需由店長確認");
      if (
        !(await first(
          env,
          "SELECT 1 FROM inventory i JOIN products p ON p.id=i.product_id WHERE day=? AND remaining>0 AND p.active=1 LIMIT 1",
          dayAt(t),
        ))
      )
        fail(409, "請先設定今天的可售份數");
      s.verified = true;
      s.paused = false;
      s.open_until = Math.max(
        t,
        ...hours(s, dayAt(t)).map((x) => stamp(dayAt(t), x[1])),
      );
      if (s.open_until <= t) fail(409, "今天的營業時段已結束");
    } else {
      s.paused = true;
      s.open_until = 0;
    }
    let v = s.version;
    delete s.version;
    await batch(env, [
      authGuard(env, u),
      guard(env, "EXISTS(SELECT 1 FROM settings WHERE version=?)", v),
      stmt(
        env,
        "UPDATE settings SET data=?,version=version+1 WHERE id=1",
        JSON.stringify(s),
      ),
      stmt(
        env,
        "INSERT INTO presence(user_id,seen) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seen=excluded.seen",
        u.id,
        t,
      ),
      event(env, u, b.open ? "shop_opened" : "shop_paused"),
    ]);
    return json({ ok: true });
  }
  if (path === "/api/admin/settings" && method === "POST") {
    if (u.role !== "owner") fail(403, "需要店長權限");
    let s = await settings(env);
    if (s.version !== b.version) fail(409, "設定已被更新");
    for (const k of ["name", "branch", "address", "phone", "announcement"])
      if (k in b) s[k] = text(b[k], k === "announcement" ? 300 : 100);
    for (const [k, min, max] of [
      ["prep_minutes", 5, 120],
      ["slot_minutes", 5, 60],
      ["slot_capacity", 1, 100],
      ["advance_days", 0, 7],
      ["accept_timeout", 2, 30],
      ["privacy_days", 7, 90],
    ])
      if (k in b) s[k] = integer(b[k], min, max);
    if (b.hours) {
      for (let i = 0; i < 7; i++) {
        let h = b.hours[i];
        if (!Array.isArray(h) || h.length > 3) fail(422, "營業時段不正確");
        let prev = "00:00";
        for (const v of h) {
          if (
            !Array.isArray(v) ||
            v.length !== 2 ||
            v.some(
              (x) =>
                typeof x !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x),
            ) ||
            v[0] < prev ||
            v[0] >= v[1]
          )
            fail(422, "營業時段不正確");
          prev = v[1];
        }
      }
      s.hours = b.hours;
    }
    if (b.closed_dates) {
      if (
        !Array.isArray(b.closed_dates) ||
        b.closed_dates.length > 60 ||
        b.closed_dates.some((x) => !/^\d{4}-\d{2}-\d{2}$/.test(x))
      )
        fail(422, "公休日不正確");
      s.closed_dates = b.closed_dates;
    }
    delete s.version;
    s.paused = true;
    s.open_until = 0;
    await batch(env, [
      authGuard(env, u),
      guard(env, "EXISTS(SELECT 1 FROM settings WHERE version=?)", b.version),
      stmt(
        env,
        "UPDATE settings SET data=?,version=version+1 WHERE id=1",
        JSON.stringify(s),
      ),
      event(env, u, "settings_changed"),
    ]);
    return json({ ok: true });
  }
  if (path === "/api/admin/products" && method === "GET") {
    if (u.role === "kitchen") fail(403, "無權限");
    let day = validDay(url.searchParams.get("day") || dayAt(t));
    return json({
      products: await all(
        env,
        "SELECT p.*,COALESCE(i.remaining,0) AS remaining FROM products p LEFT JOIN inventory i ON i.product_id=p.id AND i.day=? ORDER BY sort,id",
        day,
      ),
    });
  }
  if (path === "/api/admin/products" && method === "POST") {
    if (u.role !== "owner") fail(403, "需要店長權限");
    let name = text(b.name, 60),
      description = text(b.description || "", 300),
      kind = b.kind,
      price = integer(b.price, 0, 10000),
      single =
        b.single_price === null || b.single_price === undefined
          ? null
          : integer(b.single_price, 0, 10000);
    if (
      !name ||
      !["meal", "addon", "soup"].includes(kind) ||
      (kind !== "meal" && single !== null)
    )
      fail(422, "請確認品名與餐點類型");
    let id = "dish-" + crypto.randomUUID(),
      category = { meal: "餐盒", addon: "單點", soup: "湯品" }[kind];
    await batch(env, [
      authGuard(env, u),
      guard(env, "(SELECT COUNT(*) FROM products)<300"),
      stmt(
        env,
        `INSERT INTO products(id,name,price,single_price,description,kind,category,photo,photo_note,active,sort) VALUES(?,?,?,?,?,?,?,'','尚未提供單品照片',0,999)`,
        id,
        name,
        price,
        single,
        description,
        kind,
        category,
      ),
      event(env, u, "product_created", id),
    ]);
    return json({ ok: true, id }, 201);
  }
  match = path.match(/^\/api\/admin\/products\/([a-z0-9-]{1,60})(\/photo)?$/);
  if (match && method === "POST") {
    if (u.role !== "owner") fail(403, "需要店長權限");
    let p = await first(env, "SELECT * FROM products WHERE id=?", match[1]);
    if (!p) fail(404, "餐點不存在");
    if (p.version !== b.version) fail(409, "餐點已被更新");
    let q = [
      authGuard(env, u),
      guard(
        env,
        "EXISTS(SELECT 1 FROM products WHERE id=? AND version=?)",
        p.id,
        p.version,
      ),
    ];
    if (match[2]) {
      let link = "",
        photoNote = "尚未提供單品照片";
      if (b.data) {
        if (typeof b.data !== "string" || b.data.length > 131072)
          fail(413, "圖片請壓縮至 96 KB 以內");
        let bytes;
        try {
          bytes = Uint8Array.from(atob(b.data), (x) => x.charCodeAt(0));
        } catch {
          fail(422, "圖片格式不正確");
        }
        if (
          bytes.length > 98304 ||
          bytes.length < 20 ||
          new TextDecoder().decode(bytes.slice(0, 4)) !== "RIFF" ||
          new TextDecoder().decode(bytes.slice(8, 12)) !== "WEBP"
        )
          fail(422, "只接受壓縮後的 WebP 圖片");
        if (!validWebP(bytes))
          fail(422, "圖片格式或尺寸不正確，請重新選取照片");
        let id = Array.from(
          new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
          (x) => x.toString(16).padStart(2, "0"),
        ).join("");
        if (!(await first(env, "SELECT 1 FROM media WHERE id=?", id))) {
          q.push(
            guard(
              env,
              "(SELECT COUNT(*) FROM media)<200 AND (SELECT COALESCE(SUM(size),0) FROM media)+?<=20971520",
              bytes.length,
            ),
            stmt(
              env,
              "INSERT OR IGNORE INTO media(id,mime,body,size,created_at) VALUES(?,'image/webp',?,?,?)",
              id,
              bytes.buffer,
              bytes.length,
              t,
            ),
          );
        }
        link = "/api/media/" + id;
        photoNote = "店家提供的餐點照片";
      }
      q.push(
        stmt(
          env,
          "UPDATE products SET photo=?,photo_note=?,version=version+1 WHERE id=?",
          link,
          photoNote,
          p.id,
        ),
      );
    } else {
      let name = text(b.name ?? p.name, 60),
        description = text(b.description ?? p.description, 300),
        price = integer(b.price ?? p.price, 0, 10000),
        single =
          b.single_price === null
            ? null
            : integer(b.single_price ?? p.single_price ?? 0, 0, 10000),
        active = b.active === undefined ? p.active : b.active ? 1 : 0;
      q.push(
        stmt(
          env,
          "UPDATE products SET name=?,description=?,price=?,single_price=?,active=?,version=version+1 WHERE id=?",
          name,
          description,
          price,
          p.single_price === null && b.single_price === undefined
            ? null
            : single,
          active,
          p.id,
        ),
      );
      if ("remaining" in b) {
        let day = validDay(b.day || dayAt(t)),
          remaining = integer(b.remaining, 0, 10000),
          expected = integer(b.expected_remaining, 0, 10000);
        q.push(
          guard(
            env,
            "COALESCE((SELECT remaining FROM inventory WHERE day=? AND product_id=?),0)=?",
            day,
            p.id,
            expected,
          ),
          stmt(
            env,
            "INSERT INTO inventory(day,product_id,remaining) VALUES(?,?,?) ON CONFLICT(day,product_id) DO UPDATE SET remaining=excluded.remaining",
            day,
            p.id,
            remaining,
          ),
        );
      }
    }
    q.push(event(env, u, match[2] ? "photo_changed" : "product_changed", p.id));
    await batch(env, q);
    return json({ ok: true });
  }
  if (path === "/api/admin/users" && method === "GET") {
    if (u.role !== "owner") fail(403, "需要店長權限");
    return json({
      users: (await all(env, "SELECT * FROM users ORDER BY username")).map(
        publicUser,
      ),
    });
  }
  if (path === "/api/admin/users" && method === "POST") {
    if (u.role !== "owner") fail(403, "需要店長權限");
    let un = username(b.username),
      name = text(b.name, 30),
      role = b.role;
    if (!["cashier", "kitchen"].includes(role)) fail(422, "請選櫃台或廚房");
    if (await first(env, "SELECT 1 FROM users WHERE username=?", un))
      fail(409, "帳號已存在");
    await batch(env, [
      authGuard(env, u),
      stmt(
        env,
        "INSERT INTO users(id,username,name,role,salt,verifier) VALUES(?,?,?,?,?,?)",
        crypto.randomUUID(),
        un,
        name,
        role,
        proof(b.salt),
        await hash(proof(b.proof)),
      ),
      event(env, u, "user_created", "", un),
    ]);
    return json({ ok: true }, 201);
  }
  match = path.match(/^\/api\/admin\/users\/([a-f0-9-]{36})$/);
  if (match && method === "POST") {
    if (u.role !== "owner") fail(403, "需要店長權限");
    let target = await first(env, "SELECT * FROM users WHERE id=?", match[1]);
    if (!target || target.role === "owner")
      fail(403, "管理者請使用自己的帳號設定");
    let q = [
      authGuard(env, u),
      guard(
        env,
        "EXISTS(SELECT 1 FROM users WHERE id=? AND version=?)",
        target.id,
        b.version,
      ),
    ];
    if (b.proof)
      q.push(
        stmt(
          env,
          "UPDATE users SET salt=?,verifier=?,version=version+1 WHERE id=?",
          proof(b.salt),
          await hash(proof(b.proof)),
          target.id,
        ),
      );
    else
      q.push(
        stmt(
          env,
          "UPDATE users SET active=?,version=version+1 WHERE id=?",
          b.active ? 1 : 0,
          target.id,
        ),
      );
    q.push(
      stmt(env, "DELETE FROM sessions WHERE user_id=?", target.id),
      stmt(env, "DELETE FROM presence WHERE user_id=?", target.id),
      event(env, u, "user_updated", "", target.username),
    );
    await batch(env, q);
    return json({ ok: true });
  }
  if (path === "/api/admin/report" && method === "GET") {
    if (u.role === "kitchen") fail(403, "無權限");
    let day = url.searchParams.get("day") || dayAt(t);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) fail(422, "日期不正確");
    let payments = await all(
        env,
        "SELECT kind,SUM(amount) AS amount FROM payments WHERE date(created_at,'unixepoch','+8 hours')=? GROUP BY kind",
        day,
      ),
      orders = await all(
        env,
        "SELECT status,COUNT(*) AS count,SUM(total) AS total FROM orders WHERE day=? GROUP BY status",
        day,
      );
    return json({ day, payments, orders });
  }
  if (path === "/api/admin/backup" && method === "POST") {
    if (u.role !== "owner") fail(403, "需要店長權限");
    await reauth(u, b);
    const tables = [
      "settings",
      "users",
      "products",
      "inventory",
      "orders",
      "payments",
      "events",
      "media",
      "installation",
    ];
    // Bounds and reads are a single transaction: no partly-paid or mismatched stock backups.
    let queries = [
      authGuard(env, u),
      ...tables.map((table) =>
        guard(env, `(SELECT COUNT(*) FROM ${table})<=10000`),
      ),
      ...tables.map((table) => stmt(env, `SELECT * FROM ${table}`)),
    ];
    let results = await batch(env, queries),
      data = { format: "gugu-d1-v2", created_at: t, tables: {} };
    for (let i = 0; i < tables.length; i++) {
      let rows = results[1 + tables.length + i].results;
      if (tables[i] === "media")
        rows = rows.map((r) => ({
          ...r,
          body: toBase64(new Uint8Array(r.body)),
        }));
      data.tables[tables[i]] = rows;
    }
    let content = JSON.stringify(data);
    if (content.length > 25000000)
      fail(413, "請使用 Cloudflare D1 完整 SQL 匯出");
    return new Response(content, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="gugu-backup-${dayAt(t)}.json"`,
      },
    });
  }
  fail(404, "找不到此功能");
}
function secure(res, path) {
  let h = new Headers(res.headers);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("X-Frame-Options", "DENY");
  h.set("Referrer-Policy", "same-origin");
  h.set("Strict-Transport-Security", "max-age=31536000");
  h.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
  );
  if (path.startsWith("/api/") && !path.startsWith("/api/media/"))
    h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, headers: h });
}
export default {
  async fetch(req, env, ctx) {
    let path = new URL(req.url).pathname;
    try {
      return secure(await route(req, env, ctx), path);
    } catch (e) {
      let conflict = /CHECK constraint|UNIQUE constraint/i.test(String(e));
      let code = e instanceof Fault ? e.status : conflict ? 409 : 503,
        msg =
          e instanceof Fault
            ? e.message
            : conflict
              ? "資料剛有更新，請重新整理再試；此次操作未套用"
              : "服務暫時無法處理，請保留此頁稍後重試；尚未收到成功通知前，請勿重複建立新單";
      if (!(e instanceof Fault)) console.error("gugu request failed", e.name);
      return secure(json({ detail: msg }, code), path);
    }
  },
  async scheduled(controller, env, ctx) {
    await init(env);
    await maintenance(env, true);
    let t = now(),
      s = await settings(env);
    await env.DB.batch([
      stmt(env, "DELETE FROM sessions WHERE expires<?", t),
      stmt(env, "DELETE FROM rates WHERE expires<?", t),
      stmt(
        env,
        "UPDATE orders SET name='',phone='',note='',items=(SELECT json_group_array(json_remove(value,'$.note')) FROM json_each(items)) WHERE updated_at<? AND status IN ('completed','cancelled','rejected','no_show') AND (name<>'' OR phone<>'')",
        t - s.privacy_days * 86400,
      ),
    ]);
  },
};
