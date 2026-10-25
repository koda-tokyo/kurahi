import { describe, expect, it } from "vitest";
import { assertReadOnlySql } from "./sql-guard.js";

const allow = [
  { name: "iceberg_data", schemas: ["sales", "ops"] },
  { name: "hive_data", schemas: ["raw"] },
];
const session = { catalog: "iceberg_data", schema: "sales" };
const ok = (sql: string) => expect(() => assertReadOnlySql(sql, allow, session)).not.toThrow();
const no = (sql: string, re: RegExp) =>
  expect(() => assertReadOnlySql(sql, allow, session)).toThrow(re);

describe("read-only SQL guard", () => {
  it("allows reads inside the allowlist", () => {
    ok("SELECT id, total FROM orders WHERE region = 'JP' LIMIT 10");
    ok("select * from ops.events e join iceberg_data.sales.orders o on e.id = o.id");
    ok("SELECT * FROM hive_data.raw.logs, orders");
    ok("WITH recent AS (SELECT * FROM orders) SELECT count(*) FROM recent");
    ok("SELECT * FROM orders WHERE id IN (SELECT id FROM ops.flags)");
    ok("SELECT 'DROP TABLE x; DELETE' AS s FROM orders -- insert\n");
    ok('SELECT "comment" FROM orders');
    ok("SHOW TABLES FROM ops");
    ok("SHOW SCHEMAS FROM hive_data");
    ok("DESCRIBE ops.events");
    ok("SELECT * FROM orders;");
    ok("SELECT x FROM orders CROSS JOIN UNNEST(tags) AS t(x)");
  });

  it("refuses writes, session changes, several statements and passthrough", () => {
    no("INSERT INTO orders VALUES (1)", /only SELECT/);
    no("DELETE FROM orders", /only SELECT/);
    no("SELECT 1; DROP TABLE orders", /one statement/);
    no("WITH x AS (SELECT 1) INSERT INTO orders SELECT * FROM x", /INSERT/);
    no("EXPLAIN ANALYZE SELECT 1", /only SELECT/);
    no("SELECT * FROM orders /* hi */ CALL system.sync()", /CALL/);
    no("SET SESSION query_max_run_time = '1h'", /only SELECT/);
    no("SELECT * FROM TABLE(system.query(query => 'DROP TABLE t'))", /table functions/);
    no("SELECT 'unterminated FROM orders", /unterminated/);
    no("", /empty/);
  });

  it("refuses tables outside the allowed catalogs and schemas", () => {
    no("SELECT * FROM system.runtime.queries", /outside/);
    no("SELECT * FROM hr.salaries", /outside/);
    no("SELECT * FROM orders JOIN hive_data.secret.t ON true", /outside/);
    no("SELECT * FROM orders, iceberg_data.hr.people", /outside/);
    no("SELECT * FROM orders WHERE id IN (SELECT id FROM other.private.t)", /outside/);
    no("SHOW CATALOGS", /SHOW CATALOGS/);
    no("SHOW SCHEMAS FROM system", /not allowed/);
    no("SHOW TABLES FROM hr", /not allowed/);
    no("DESCRIBE hr.salaries", /outside/);
  });
});
