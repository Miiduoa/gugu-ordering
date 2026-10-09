/** Create an SQL restore file for an EMPTY, isolated D1 database; never overwrite a live shop. */
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { schema } from "../src/schema.mjs";
const tables = [
  "installation",
  "settings",
  "users",
  "products",
  "inventory",
  "orders",
  "payments",
  "events",
  "media",
];
const quote = (x) => {
  if (x === null) return "NULL";
  if (typeof x === "number" && Number.isSafeInteger(x)) return String(x);
  if (typeof x === "string" && !x.includes("\0"))
    return "'" + x.replaceAll("'", "''") + "'";
  throw new Error("Unsupported backup value");
};
export function restoreSQL(data) {
  if (data?.format !== "gugu-d1-v2" || !data.tables)
    throw new Error("Not a supported gugu backup");
  const sql = [
    ...schema.filter((s) => !s.startsWith("CREATE TRIGGER")),
    "INSERT INTO tx_guards(pass) SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM installation) AND NOT EXISTS(SELECT 1 FROM orders) AND NOT EXISTS(SELECT 1 FROM users) THEN 1 ELSE 0 END;",
  ];
  // Each row is inserted only into the schema's actual columns; table/column names are never interpolated from unchecked input.
  for (const table of tables) {
    if (!Array.isArray(data.tables[table]) || data.tables[table].length > 10000)
      throw new Error("Missing or oversized " + table);
    let ddl = schema.find((s) =>
      s.startsWith("CREATE TABLE IF NOT EXISTS " + table + "("),
    );
    let columns = ddl
      .slice(ddl.indexOf("(") + 1)
      .split(",")
      .map((x) => x.trim().split(" ")[0])
      .filter((x) => /^[a-z_]+$/.test(x));
    for (const original of data.tables[table]) {
      let row = { ...original };
      if (table === "settings") {
        let s = JSON.parse(row.data);
        s.paused = true;
        s.open_until = 0;
        row.data = JSON.stringify(s);
      }
      let names = Object.keys(row);
      if (!names.length || names.some((k) => !columns.includes(k)))
        throw new Error("Unknown column in " + table);
      const vals = names.map((k) =>
        table === "media" && k === "body"
          ? "X'" + Buffer.from(row[k], "base64").toString("hex") + "'"
          : quote(row[k]),
      );
      sql.push(
        `INSERT INTO ${table}(${names.join(",")}) VALUES(${vals.join(",")});`,
      );
    }
  }
  // Restore triggers after the original stock snapshot, so order history does not subtract stock twice.
  sql.push(
    "DELETE FROM tx_guards;",
    ...schema.filter((s) => s.startsWith("CREATE TRIGGER")).map((s) => s + ";"),
  );
  return sql.map((s) => (s.endsWith(";") ? s : s + ";")).join("\n");
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    if (!process.argv[2] || !process.argv[3])
      throw new Error(
        "Usage: node scripts/restore.mjs backup.json restored.sql",
      );
    let sql = restoreSQL(JSON.parse(readFileSync(process.argv[2], "utf8")));
    writeFileSync(process.argv[3], sql, { mode: 0o600, flag: "wx" });
    console.log(
      "SQL created for a NEW EMPTY database only. Keep paused until reconciliation. Do not overwrite your existing DB.",
    );
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}
