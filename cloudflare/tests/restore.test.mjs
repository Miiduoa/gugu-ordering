import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { restoreSQL } from "../scripts/restore.mjs";
import { schema } from "../src/schema.mjs";
import { defaults, products } from "../src/menu.mjs";
function backup() {
  let d = { format: "gugu-d1-v2", tables: {} };
  for (let n of [
    "installation",
    "settings",
    "users",
    "products",
    "inventory",
    "orders",
    "payments",
    "events",
    "media",
  ])
    d.tables[n] = [];
  d.tables.installation = [{ id: 1, seeded: 1, salt_key: "a".repeat(64) }];
  d.tables.settings = [
    {
      id: 1,
      data: JSON.stringify({
        ...defaults,
        paused: false,
        open_until: 99999999999,
      }),
      version: 1,
    },
  ];
  d.tables.products = [products[0]];
  d.tables.inventory = [
    { day: "2026-10-09", product_id: products[0].id, remaining: 17 },
  ];
  d.tables.media = [
    {
      id: "image",
      mime: "image/webp",
      body: Buffer.from([1, 2, 3]).toString("base64"),
      size: 3,
      created_at: 100,
    },
  ];
  return d;
}
test("restore reproduces stock and binary images into an empty database, leaves shop paused", () => {
  let db = new DatabaseSync(":memory:");
  db.exec(restoreSQL(backup()));
  assert.equal(
    db.prepare("SELECT remaining FROM inventory").get().remaining,
    17,
  );
  assert.deepEqual(
    Array.from(db.prepare("SELECT body FROM media").get().body),
    [1, 2, 3],
  );
  let s = JSON.parse(db.prepare("SELECT data FROM settings").get().data);
  assert.equal(s.paused, true);
  assert.equal(s.open_until, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sessions").get().n, 0);
  db.close();
});
test("restore refuses an existing installation rather than replacing it", () => {
  let db = new DatabaseSync(":memory:");
  db.exec(restoreSQL(backup()));
  assert.throws(() => db.exec(restoreSQL(backup())), /CHECK constraint/);
  assert.equal(
    db.prepare("SELECT remaining FROM inventory").get().remaining,
    17,
  );
  db.close();
});
test("SQL restore handles quotes and rejects column injection", () => {
  let d = backup();
  d.tables.products[0] = { ...d.tables.products[0], name: "Chef's lunch" };
  let db = new DatabaseSync(":memory:");
  db.exec(restoreSQL(d));
  assert.equal(
    db.prepare("SELECT name FROM products").get().name,
    "Chef's lunch",
  );
  d.tables.products[0]["evil); DROP TABLE orders;--"] = "x";
  assert.throws(() => restoreSQL(d), /Unknown column/);
  db.close();
});
test("unsupported formats fail rather than importing arbitrary tables", () => {
  assert.throws(() => restoreSQL({ format: "anything", tables: {} }));
});
