import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, pbkdf2Sync } from "node:crypto";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import worker, { hash, dayAt } from "../src/worker.mjs";
import { LocalD1 } from "./adapter.mjs";
const NOW = Date.parse("2026-10-09T12:00:00+08:00"),
  OriginalDate = Date;
class Clock extends OriginalDate {
  constructor(...a) {
    super(...(a.length ? a : [NOW]));
  }
  static now() {
    return NOW;
  }
}
globalThis.Date = Clock;
const rand = () => randomBytes(32).toString("hex"),
  setup = "test-only-activation-code-not-a-deployment-secret",
  owner = {
    username: "owner",
    name: "店長",
    salt: "a".repeat(64),
    proof: "b".repeat(64),
  },
  origin = "https://gugu.test",
  day = dayAt(NOW / 1000);
async function fixture(path) {
  const DB = new LocalD1(path),
    env = {
      DB,
      SETUP_KEY_HASH: await hash(setup),
      ASSETS: { fetch: () => new Response("static") },
    };
  let auth = {};
  const request = async (path, body, options = {}) => {
    let headers = { ...auth, ...options.headers };
    if (body !== undefined)
      Object.assign(headers, {
        "content-type": "application/json",
        origin: origin,
        "x-requested-with": "Gugu",
        ...options.headers,
      });
    let req = new Request(origin + path, {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
      r = await worker.fetch(req, env, {});
    let data = await r
      .clone()
      .json()
      .catch(() => null);
    return { status: r.status, data, headers: r.headers, response: r };
  };
  let f = {
    DB,
    env,
    request,
    auth,
    async login(credentials = owner) {
      let r = await request("/api/login", credentials);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      auth.cookie = r.headers.get("set-cookie").split(";")[0];
      auth["x-csrf-token"] = r.data.csrf;
      f.user = r.data.user;
      return r;
    },
    async product(id = "chicken") {
      return (
        await request("/api/admin/products?day=" + day)
      ).data.products.find((p) => p.id === id);
    },
    async stock(n, id = "chicken", d = day) {
      let p = await f.product(id),
        r = await request("/api/admin/products/" + id, {
          version: p.version,
          remaining: n,
          expected_remaining: p.remaining,
          day: d,
          active: true,
        });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      return f.product(id);
    },
    async open() {
      let r = await request("/api/admin/open", { open: true, confirmed: true });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    },
    async order(overrides = {}) {
      let p = await f.product(),
        b = {
          client_key: rand(),
          day,
          slot: "12:30",
          name: "測試顧客",
          phone:
            "09" + String(Math.floor(Math.random() * 1e8)).padStart(8, "0"),
          items: [
            {
              id: "chicken",
              version: p.version,
              qty: 1,
              variant: "meal",
              rice: "normal",
            },
          ],
          own_boxes: 0,
          consent: true,
          ...overrides,
        };
      return { body: b, ...(await request("/api/orders", b)) };
    },
    close() {
      DB.close();
    },
  };
  assert.equal((await request("/api/health")).status, 200);
  return f;
}
async function ready(n = 20, path) {
  let f = await fixture(path);
  assert.equal(
    (await f.request("/api/setup", { setup_key: setup, ...owner })).status,
    201,
  );
  await f.login();
  await f.stock(n);
  await f.open();
  return f;
}
test("real menu prices, shared variants and closed-first installation", async () => {
  let f = await fixture();
  let menu = (await f.request("/api/menu")).data.products;
  assert.equal(menu.find((p) => p.id === "chicken").price, 115);
  assert.equal(menu.find((p) => p.id === "salmon").price, 175);
  assert.equal(menu.find((p) => p.id === "vegetarian").price, 105);
  assert.equal(menu.find((p) => p.id === "broccoli").price, 35);
  assert.ok(menu.every((p) => p.remaining === 0));
  assert.ok(!menu.some((p) => p.kind === "soup"));
  let s = (await f.request("/api/store")).data;
  assert.equal(s.mode, "live");
  assert.equal(s.accepting, false);
  assert.equal(s.needs_setup, true);
  f.close();
});
test("cold start existing database does not reseed data", async () => {
  let dir = mkdtempSync(tmpdir() + "/gugu-");
  try {
    let f = await ready(7, dir + "/db");
    f.DB.sql.exec("DELETE FROM products WHERE id='salmon'");
    f.close();
    f = await fixture(dir + "/db");
    assert.ok(f.DB.queries < 5);
    assert.equal(
      (await f.request("/api/menu")).data.products.find(
        (x) => x.id === "chicken",
      ).remaining,
      7,
    );
    assert.equal(
      (await f.request("/api/menu")).data.products.find(
        (x) => x.id === "salmon",
      ),
      undefined,
    );
    f.close();
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test("activation code required and owner setup cannot be repeated", async () => {
  let f = await fixture();
  assert.equal(
    (await f.request("/api/setup", { setup_key: "wrong", ...owner })).status,
    403,
  );
  assert.equal(
    (await f.request("/api/setup", { setup_key: setup, ...owner })).status,
    201,
  );
  assert.equal(
    (
      await f.request("/api/setup", {
        setup_key: setup,
        ...owner,
        username: "intruder",
      })
    ).status,
    409,
  );
  assert.equal(f.DB.sql.prepare("SELECT COUNT(*) n FROM users").get().n, 1);
  f.close();
});
test("CSRF origin and header checks reject cross-site changes", async () => {
  let f = await ready();
  assert.equal(
    (
      await f.request(
        "/api/admin/open",
        { open: false },
        { headers: { origin: "https://evil.test" } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/api/admin/open",
        { open: false },
        { headers: { "x-requested-with": "" } },
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(
        "/api/admin/open",
        { open: false },
        { headers: { "x-csrf-token": "fake" } },
      )
    ).status,
    403,
  );
  f.close();
});
test("session cookies are Secure, HttpOnly, SameSite Strict", async () => {
  let f = await ready();
  let r = await f.login(),
    c = r.headers.get("set-cookie");
  for (const x of ["Secure", "HttpOnly", "SameSite=Strict"])
    assert.ok(c.includes(x));
  assert.equal((await f.request("/api/me")).data.user.username, "owner");
  f.close();
});
test("unauthenticated admin and credential failures are rejected", async () => {
  let f = await fixture();
  assert.equal((await f.request("/api/admin/orders")).status, 401);
  await f.request("/api/setup", { setup_key: setup, ...owner });
  assert.equal(
    (await f.request("/api/login", { ...owner, proof: "c".repeat(64) })).status,
    401,
  );
  f.close();
});
test("unknown salt is installation keyed and stable", async () => {
  let f = await fixture(),
    g = await fixture();
  let a = (await f.request("/api/auth/salt?username=missing")).data.salt,
    b = (await f.request("/api/auth/salt?username=missing")).data.salt,
    c = (await g.request("/api/auth/salt?username=missing")).data.salt;
  assert.equal(a, b);
  assert.notEqual(a, c);
  f.close();
  g.close();
});
test("rate limits apply to repeated bad logins", async () => {
  let f = await fixture();
  for (let i = 0; i < 10; i++)
    assert.equal((await f.request("/api/login", owner)).status, 401);
  assert.equal((await f.request("/api/login", owner)).status, 429);
  f.close();
});
test("one meal with own box uses authoritative price and discount", async () => {
  let f = await ready();
  let o = await f.order({ own_boxes: 1, total: 1 });
  assert.equal(o.status, 201, JSON.stringify(o.data));
  assert.equal(o.data.total, 113);
  assert.equal(o.data.discount, 2);
  assert.equal((await f.product()).remaining, 19);
  f.close();
});
test("single main shares stock but cannot use meal box discount", async () => {
  let f = await ready();
  let p = await f.product(),
    item = { id: p.id, version: p.version, qty: 1, variant: "single" };
  let bad = await f.order({ items: [item], own_boxes: 1 });
  assert.equal(bad.status, 422);
  let good = await f.order({ items: [item] });
  assert.equal(good.status, 201, JSON.stringify(good.data));
  assert.equal(good.data.total, 55);
  assert.equal((await f.product()).remaining, 19);
  f.close();
});
test("price version changes prevent obsolete checkout", async () => {
  let f = await ready(),
    p = await f.product();
  await f.stock(10);
  let o = await f.order({
    items: [{ id: p.id, version: p.version, qty: 1, variant: "meal" }],
  });
  assert.equal(o.status, 409);
  assert.equal((await f.product()).remaining, 10);
  f.close();
});
test("duplicate retry creates only one order and decrements once", async () => {
  let f = await ready(),
    p = await f.product(),
    body = {
      client_key: rand(),
      day,
      slot: "12:30",
      name: "測試",
      phone: "0900000000",
      consent: true,
      items: [{ id: "chicken", version: p.version, qty: 1, variant: "meal" }],
    };
  let results = await Promise.all(
    Array.from({ length: 12 }, () => f.request("/api/orders", body)),
  );
  assert.ok(
    results.every((r) => [200, 201].includes(r.status)),
    JSON.stringify(results.map((r) => r.data)),
  );
  assert.equal(new Set(results.map((r) => r.data.id)).size, 1);
  assert.equal(f.DB.sql.prepare("SELECT COUNT(*) n FROM orders").get().n, 1);
  assert.equal((await f.product()).remaining, 19);
  f.close();
});
test("retry returns existing order even after shop pauses", async () => {
  let f = await ready(),
    o = await f.order();
  await f.request("/api/admin/open", { open: false });
  let retry = await f.request("/api/orders", o.body);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.id, o.data.id);
  assert.equal((await f.order()).status, 409);
  f.close();
});
test("same key and changed content is rejected", async () => {
  let f = await ready(),
    o = await f.order();
  assert.equal(
    (await f.request("/api/orders", { ...o.body, name: "different" })).status,
    409,
  );
  f.close();
});
test("20 simultaneous requests for last five units create five orders only", async () => {
  let f = await ready(5);
  let results = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      f.order({ phone: "09000000" + String(i).padStart(2, "0") }),
    ),
  );
  assert.equal(
    results.filter((r) => r.status === 201).length,
    5,
    JSON.stringify(results.map((x) => [x.status, x.data])),
  );
  assert.equal((await f.product()).remaining, 0);
  assert.equal(f.DB.sql.prepare("SELECT COUNT(*) n FROM orders").get().n, 5);
  f.close();
});
test("slot capacity protects concurrent orders independently of stock", async () => {
  let f = await ready(100);
  let s = (await f.request("/api/admin/settings")).data;
  await f.request("/api/admin/settings", {
    version: s.version,
    slot_capacity: 3,
  });
  await f.open();
  let results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      f.order({ phone: "09111111" + String(i).padStart(2, "0") }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 3);
  assert.equal((await f.product()).remaining, 97);
  f.close();
});
test("stock editing rejects a stale quantity after a new order", async () => {
  let f = await ready(),
    p = await f.product();
  await f.order();
  let r = await f.request("/api/admin/products/" + p.id, {
    version: p.version,
    remaining: 20,
    expected_remaining: p.remaining,
    day,
  });
  assert.equal(r.status, 409);
  assert.equal((await f.product()).remaining, 19);
  f.close();
});
test("private order token cannot be replaced with a public identifier", async () => {
  let f = await ready(),
    o = await f.order();
  assert.equal((await f.request("/api/orders/" + o.data.id)).status, 404);
  assert.equal(
    (
      await f.request("/api/orders/" + o.data.id, undefined, {
        headers: { "x-order-token": rand() },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("/api/orders/" + o.data.id, undefined, {
        headers: { "x-order-token": o.body.client_key },
      })
    ).status,
    200,
  );
  f.close();
});
test("customer cancellation is once only and restores pre-production stock", async () => {
  let f = await ready(),
    o = await f.order(),
    opts = { headers: { "x-order-token": o.body.client_key } };
  assert.equal(
    (await f.request("/api/orders/" + o.data.id + "/cancel", {}, opts)).status,
    200,
  );
  assert.equal((await f.product()).remaining, 20);
  assert.equal(
    (await f.request("/api/orders/" + o.data.id + "/cancel", {}, opts)).status,
    409,
  );
  assert.equal((await f.product()).remaining, 20);
  f.close();
});
async function action(f, o, a) {
  let current = f.DB.sql.prepare("SELECT * FROM orders WHERE id=?").get(o.id);
  return f.request("/api/admin/orders/" + o.id + "/action", {
    action: a,
    version: current.version,
    confirmed: true,
  });
}
test("complete lifecycle needs payment, no duplicate cash entries", async () => {
  let f = await ready(),
    o = (await f.order()).data;
  for (let a of ["accept", "prepare", "ready"])
    assert.equal((await action(f, o, a)).status, 200);
  assert.equal((await action(f, o, "complete")).status, 409);
  assert.equal((await action(f, o, "paid")).status, 200);
  assert.equal((await action(f, o, "paid")).status, 409);
  assert.equal((await action(f, o, "complete")).status, 200);
  assert.equal(
    f.DB.sql.prepare("SELECT SUM(amount) n FROM payments").get().n,
    115,
  );
  assert.equal((await action(f, o, "refund")).status, 200);
  assert.equal((await action(f, o, "refund")).status, 409);
  assert.equal(
    f.DB.sql.prepare("SELECT SUM(amount) n FROM payments").get().n,
    0,
  );
  f.close();
});
test("prepared meal cancellation does not restore consumed stock", async () => {
  let f = await ready(),
    o = (await f.order()).data;
  await action(f, o, "accept");
  await action(f, o, "prepare");
  assert.equal((await action(f, o, "cancel")).status, 200);
  assert.equal((await f.product()).remaining, 19);
  f.close();
});
test("lost staff heartbeat fails closed rather than pretending to receive orders", async () => {
  let f = await ready();
  f.DB.sql.exec("UPDATE presence SET seen=0");
  assert.equal((await f.request("/api/store")).data.accepting, false);
  assert.equal((await f.order()).status, 409);
  f.close();
});
test("pending expiry restores stock without consuming a new slot", async () => {
  let f = await ready(),
    o = await f.order();
  f.DB.sql.exec("UPDATE orders SET expires_at=0");
  await f.order({ phone: "0911111111" });
  assert.equal(
    f.DB.sql.prepare("SELECT status FROM orders WHERE id=?").get(o.data.id)
      .status,
    "cancelled",
  );
  assert.equal((await f.product()).remaining, 19);
  f.close();
});
test("kitchen cannot see phone, receive cash or edit menu", async () => {
  let f = await ready(),
    o = (await f.order()).data;
  await action(f, o, "accept");
  let k = {
    username: "kitchen",
    name: "廚房",
    role: "kitchen",
    salt: "c".repeat(64),
    proof: "d".repeat(64),
  };
  assert.equal((await f.request("/api/admin/users", k)).status, 201);
  await f.login(k);
  let rows = (await f.request("/api/admin/orders")).data.orders;
  assert.equal(rows[0].phone, undefined);
  assert.equal(rows[0].name, undefined);
  assert.equal((await f.request("/api/admin/products")).status, 403);
  assert.equal((await action(f, o, "paid")).status, 403);
  assert.equal((await action(f, o, "prepare")).status, 200);
  f.close();
});
test("account and password change invalidates all old sessions", async () => {
  let f = await ready(),
    second = await f.login(),
    oldCookie = f.auth.cookie;
  let r = await f.request("/api/account", {
    username: "manager",
    name: "老闆",
    current_proof: owner.proof,
    new_salt: "c".repeat(64),
    new_proof: "d".repeat(64),
  });
  assert.equal(r.status, 200);
  assert.equal((await f.request("/api/me")).status, 401);
  assert.equal((await f.request("/api/login", owner)).status, 401);
  await f.login({ username: "manager", proof: "d".repeat(64) });
  assert.equal(
    (await f.request("/api/me", undefined, { headers: { cookie: oldCookie } }))
      .status,
    401,
  );
  f.close();
});
test("upload real food image persists binary and reject non-WebP", async () => {
  let f = await ready(),
    p = await f.product(),
    bytes = readFileSync(
      new URL("../public/images/chicken.webp", import.meta.url),
    );
  assert.equal(
    (
      await f.request("/api/admin/products/chicken/photo", {
        version: p.version,
        data: Buffer.from("<script>").toString("base64"),
      })
    ).status,
    422,
  );
  assert.equal(
    (
      await f.request("/api/admin/products/chicken/photo", {
        version: p.version,
        data: bytes.toString("base64"),
      })
    ).status,
    200,
  );
  p = await f.product();
  let r = await f.request(p.photo);
  assert.equal(r.status, 200);
  assert.deepEqual(Buffer.from(await r.response.arrayBuffer()), bytes);
  f.close();
});
test("full backup is consistent, includes images, excludes sessions", async () => {
  let f = await ready();
  await f.order();
  let r = await f.request("/api/admin/backup", { current_proof: owner.proof });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.format, "gugu-d1-v2");
  assert.equal(r.data.tables.orders.length, 1);
  assert.equal(r.data.tables.inventory[0].remaining, 19);
  assert.equal(r.data.tables.sessions, undefined);
  assert.equal(
    (await f.request("/api/admin/backup", { current_proof: "c".repeat(64) }))
      .status,
    403,
  );
  f.close();
});
test("new products start unpublished with zero stock", async () => {
  let f = await ready(),
    r = await f.request("/api/admin/products", {
      name: "新餐點",
      kind: "meal",
      price: 150,
      single_price: 80,
    });
  assert.equal(r.status, 201);
  let p = (await f.request("/api/admin/products")).data.products.find(
    (p) => p.id === r.data.id,
  );
  assert.equal(p.active, 0);
  assert.equal(p.remaining, 0);
  f.close();
});
test("oversized and invalid bodies rejected before mutation", async () => {
  let f = await fixture();
  assert.equal((await f.request("/api/setup", "{")).status, 400);
  assert.equal(
    (await f.request("/api/setup", JSON.stringify({ x: "x".repeat(150000) })))
      .status,
    413,
  );
  f.close();
});
test("scheduled retention removes personal details but keeps cash totals", async () => {
  let f = await ready(),
    o = (await f.order()).data;
  await action(f, o, "cancel");
  f.DB.sql.exec("UPDATE orders SET updated_at=0");
  await worker.scheduled({}, f.env, {});
  let row = f.DB.sql.prepare("SELECT * FROM orders").get();
  assert.equal(row.phone, "");
  assert.equal(row.name, "");
  assert.equal(row.total, 115);
  f.close();
});

test("staff heartbeat performs retention without cron triggers", async () => {
  const f = await ready(),
    o = (await f.order()).data;
  await action(f, o, "cancel");
  f.DB.sql.exec(
    "UPDATE orders SET updated_at=0; DELETE FROM rates WHERE bucket='maintenance:privacy';",
  );
  const r = await f.request("/api/admin/heartbeat", {});
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const row = f.DB.sql.prepare("SELECT * FROM orders").get();
  assert.equal(row.phone, "");
  assert.equal(row.name, "");
  assert.equal(row.total, 115);
  const lease = f.DB.sql
    .prepare("SELECT expires FROM rates WHERE bucket='maintenance:privacy'")
    .get();
  assert.ok(lease.expires > NOW / 1000);
  assert.equal((await f.request("/api/admin/heartbeat", {})).status, 200);
  assert.equal(
    f.DB.sql
      .prepare("SELECT expires FROM rates WHERE bucket='maintenance:privacy'")
      .get().expires,
    lease.expires,
  );
  f.close();
});
