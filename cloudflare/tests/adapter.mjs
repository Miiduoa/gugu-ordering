import { DatabaseSync } from "node:sqlite";
export class LocalD1 {
  constructor(path = ":memory:") {
    this.sql = new DatabaseSync(path);
    this.sql.exec("PRAGMA foreign_keys=ON");
    this.queries = 0;
  }
  prepare(sql) {
    const db = this;
    let args = [];
    const convert = (x) => (x instanceof ArrayBuffer ? new Uint8Array(x) : x);
    const statement = {
      bind(...a) {
        args = a.map(convert);
        return statement;
      },
      async first(column) {
        db.queries++;
        const r = db.sql.prepare(sql).get(...args);
        return r ? (column ? r[column] : r) : null;
      },
      async all() {
        return statement.execute();
      },
      async run() {
        return statement.execute();
      },
      execute() {
        db.queries++;
        try {
          return {
            success: true,
            results: db.sql.prepare(sql).all(...args),
            meta: {},
          };
        } catch (e) {
          throw new Error("D1_ERROR: " + e.message, { cause: e });
        }
      },
    };
    return statement;
  }
  async batch(statements) {
    this.sql.exec("BEGIN IMMEDIATE");
    try {
      const rows = statements.map((s) => s.execute());
      this.sql.exec("COMMIT");
      return rows;
    } catch (e) {
      this.sql.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.sql.close();
  }
}
