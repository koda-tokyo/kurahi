import { describe, expect, it } from "vitest";
import { DB2_DDL, ORACLE_DDL } from "../test-fixtures/payroll-poly.js";
import { analyseSql, splitStatements } from "./sql-ddl.js";
import { canonical, sqlTables } from "./sql-text.js";

describe("SQL DDL engine", () => {
  const m = analyseSql([
    { path: "db2.sql", text: DB2_DDL },
    { path: "audit.ddl", text: ORACLE_DDL },
  ]);
  const t = (n: string) => m.tables.find((x) => x.name === n);

  it("reads tables, columns, types, nullability, defaults and keys with path:line", () => {
    expect(
      m.tables.map(
        (x) => `${x.kind} ${x.schema ?? "-"}.${x.name} ${x.file}:${x.line}-${x.endLine}`,
      ),
    ).toEqual([
      "table PAYROLL.DEPARTMENT db2.sql:13-16",
      "table PAYROLL.EMPLOYEE db2.sql:2-11",
      "table -.PAY_AUDIT audit.ddl:1-7",
      "table PAYROLL.PAY_RESULT db2.sql:19-25",
      "view PAYROLL.V_DEPT_PAY db2.sql:33-36",
    ]);
    const emp = t("EMPLOYEE");
    expect(emp?.columns.map((c) => [c.name, c.type, c.nullable, c.default, c.line])).toEqual([
      ["EMP_ID", "CHAR(6)", false, undefined, 3],
      ["EMP_DEPT", "CHAR(3)", false, undefined, 4],
      ["EMP_NAME", "VARCHAR(20)", undefined, undefined, 5],
      ["EMP_TYPE", "CHAR(1)", false, "'R'", 6],
      ["BASE_PAY", "DECIMAL(7, 0)", false, "0", 7],
      ["LAST_PERIOD", "CHAR(6) FOR SBCS DATA", undefined, undefined, 8],
    ]);
    expect(emp?.columns[0]).toMatchObject({
      primaryKey: true,
      comment: "staff number",
      commentAt: { file: "db2.sql", line: 3 },
    });
    expect(emp?.constraints).toEqual([
      { file: "db2.sql", line: 9, kind: "PRIMARY KEY", name: "PK_EMPLOYEE", columns: ["EMP_ID"] },
      {
        file: "db2.sql",
        line: 10,
        kind: "FOREIGN KEY",
        name: "FK_EMP_DEPT",
        columns: ["EMP_DEPT"],
        references: { table: "DEPARTMENT", columns: ["DEPT_CODE"] },
      },
    ]);
    expect(
      t("DEPARTMENT")?.columns.map((c) => [c.name, c.primaryKey ?? false, c.unique ?? false]),
    ).toEqual([
      ["DEPT_CODE", true, false],
      ["DEPT_NAME", false, true],
    ]);
    const pr = t("PAY_RESULT");
    expect(pr?.columns[0].references).toEqual({ table: "EMPLOYEE", column: "EMP_ID" });
    expect(pr?.columns.find((c) => c.name === "PAID_AT")?.type).toBe("TIMESTAMP WITH TIME ZONE");
    expect(pr?.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual([
      "EMP_ID",
      "PERIOD",
    ]);
  });

  it("applies COMMENT ON, LABEL ON, inline COMMENT and ALTER TABLE ADD CONSTRAINT", () => {
    expect(t("EMPLOYEE")).toMatchObject({
      comment: "Employee master (one row per staff number)",
      commentAt: { line: 29 },
    });
    expect(t("PAY_RESULT")?.columns.find((c) => c.name === "GROSS")?.comment).toBe(
      "Gross pay in yen",
    );
    expect(t("EMPLOYEE")?.columns.find((c) => c.name === "BASE_PAY")?.comment).toBe(
      "Monthly base pay",
    );
    const audit = t("PAY_AUDIT");
    expect(audit?.columns.map((c) => `${c.name} ${c.type}`)).toEqual([
      "AUDIT_ID NUMBER(10)",
      "EMP_ID VARCHAR2(6 CHAR)",
      "ACTION VARCHAR2(10)",
      "NOTED VARCHAR2(200)",
    ]);
    expect(audit?.columns[3].comment).toBe("free text");
    expect(audit?.constraints.map((c) => `${c.kind} ${c.name} ${c.file}:${c.line}`)).toEqual([
      "PRIMARY KEY PK_PAY_AUDIT audit.ddl:6",
      "FOREIGN KEY FK_AUDIT_EMP audit.ddl:9",
    ]);
  });

  it("reads views and indexes, and reports what it does not model", () => {
    expect(t("V_DEPT_PAY")?.sources).toEqual(["EMPLOYEE", "PAY_RESULT"]);
    expect(t("V_DEPT_PAY")?.columns.map((c) => c.name)).toEqual(["DEPT_CODE", "TOTAL_GROSS"]);
    expect(m.indexes).toEqual([
      {
        file: "db2.sql",
        line: 27,
        name: "IX_PAY_PERIOD",
        table: "PAY_RESULT",
        columns: ["PERIOD", "EMP_ID"],
        unique: true,
      },
    ]);
    expect(m.files.flatMap((f) => f.gaps).map((g) => `${g.file}:${g.line} ${g.detail}`)).toEqual([
      "db2.sql:38 GRANT statement is not modelled (no schema fact taken from it).",
      "audit.ddl:11 CREATE SEQUENCE is not modelled.",
    ]);
  });

  it("splits at ; and Oracle / lines, outside strings and comments", () => {
    const { stmts } = splitStatements(
      "SELECT ';' FROM T; -- a; b\n/* x; */ CREATE TABLE A (B INT)\n/\nGO\n",
    );
    expect(stmts.map((s) => [s.line, s.text.trim()])).toEqual([
      [1, "SELECT ';' FROM T"],
      [2, "CREATE TABLE A (B INT)"],
    ]);
  });

  it("finds query tables across dialects and folds names to one canonical form", () => {
    expect(sqlTables('select * from payroll.employee e, "DEPARTMENT" d where 1=1')).toEqual({
      op: "SELECT",
      tables: ["DEPARTMENT", "EMPLOYEE"],
    });
    expect(
      sqlTables("WITH x AS (SELECT * FROM A) SELECT * FROM x JOIN B USING (k)").tables,
    ).toEqual(["A", "B"]);
    expect(
      sqlTables("MERGE INTO T USING S ON (T.K = S.K) WHEN MATCHED THEN UPDATE SET V = 1").tables,
    ).toEqual(["S", "T"]);
    expect(sqlTables("SELECT A FROM T WHERE K IN (SELECT K FROM U) FOR UPDATE").tables).toEqual([
      "T",
      "U",
    ]);
    expect(canonical('"payroll"."employee"')).toBe("EMPLOYEE");
  });

  it("reads PostgreSQL basics: IF NOT EXISTS, quoted names, serial, CHECK, ON DELETE", () => {
    const pg = analyseSql([
      {
        path: "pg.sql",
        text: [
          'CREATE TABLE IF NOT EXISTS public."Orders" (',
          "  id serial PRIMARY KEY,",
          "  total numeric(10,2) DEFAULT 0.00 NOT NULL,",
          "  created timestamptz DEFAULT now(),",
          "  customer_id integer REFERENCES customers(id) ON DELETE CASCADE,",
          "  CHECK (total >= 0)",
          ");",
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_orders_cust ON public."Orders" (customer_id);',
        ].join("\n"),
      },
    ]);
    const t = pg.tables[0];
    expect(t).toMatchObject({ name: "ORDERS", schema: "PUBLIC", rawName: 'public."Orders"' });
    expect(t.columns.map((c) => [c.name, c.type, c.nullable, c.default ?? null])).toEqual([
      ["ID", "SERIAL", false, null],
      ["TOTAL", "NUMERIC(10, 2)", false, "0.00"],
      ["CREATED", "TIMESTAMPTZ", undefined, "NOW()"],
      ["CUSTOMER_ID", "INTEGER", undefined, null],
    ]);
    expect(t.columns[3].references).toEqual({ table: "CUSTOMERS", column: "ID" });
    expect(t.constraints.map((c) => `${c.kind} ${c.text}`)).toEqual(["CHECK (TOTAL >= 0)"]);
    expect(pg.indexes.map((i) => `${i.name} ${i.table} ${i.columns.join(",")}`)).toEqual([
      "IX_ORDERS_CUST ORDERS CUSTOMER_ID",
    ]);
  });

  it("keeps a routine body one statement and takes no schema fact from inside it", () => {
    const src = [
      "CREATE OR REPLACE FUNCTION f_tmp() RETURNS void AS $body$",
      "BEGIN",
      "  CREATE TEMP TABLE scratch (id int);",
      "  INSERT INTO payroll_log VALUES (1);",
      "END;",
      "$body$ LANGUAGE plpgsql;",
      "CREATE PROCEDURE p_close IS",
      "  v NUMBER;",
      "BEGIN",
      "  IF v > 0 THEN UPDATE pay_result SET x = 1; END IF;",
      "  ALTER TABLE ghost ADD COLUMN c INT;",
      "END p_close;",
      "CREATE TRIGGER t_aud AFTER INSERT ON employee FOR EACH ROW",
      "  INSERT INTO emp_audit VALUES (1);",
      "CREATE TRIGGER t_upd AFTER UPDATE ON employee FOR EACH ROW",
      "BEGIN ATOMIC",
      "  CASE WHEN 1 = 1 THEN UPDATE emp_audit SET y = 2; END CASE;",
      "END;",
      "CREATE TABLE after_routines (id INT);",
    ].join("\n");
    expect(splitStatements(src).stmts.map((s) => s.line)).toEqual([1, 7, 13, 15, 19]);
    const r = analyseSql([{ path: "r.sql", text: src }]);
    expect(r.tables.map((x) => x.name)).toEqual(["AFTER_ROUTINES"]);
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail}`)).toEqual([
      "1 FUNCTION F_TMP (lines 1-6): routine body not analysed; it names tables PAYROLL_LOG, SCRATCH (textual, unverified).",
      "7 PROCEDURE P_CLOSE (lines 7-12): routine body not analysed; it names tables GHOST, PAY_RESULT (textual, unverified).",
      "13 TRIGGER T_AUD on EMPLOYEE (lines 13-14): routine body not analysed; it names tables EMP_AUDIT (textual, unverified).",
      "15 TRIGGER T_UPD on EMPLOYEE (lines 15-18): routine body not analysed; it names tables EMP_AUDIT (textual, unverified).",
    ]);
  });

  it("reads the word after END past comments, so a commented END IF does not close the body", () => {
    const src = [
      "CREATE PROCEDURE p() BEGIN IF 1=1 THEN SELECT 1; END /* allowed comment */ IF;",
      "  WHILE 1=0 DO SELECT 2; END -- a remark",
      "  WHILE; LOOP SELECT 3; END /* a */ -- b",
      "  LOOP; CREATE TABLE internal_t (id INT); END;",
      "CREATE TABLE external_t (id INT);",
    ].join("\n");
    expect(splitStatements(src).stmts.map((s) => s.line)).toEqual([1, 5]);
    const r = analyseSql([{ path: "c.sql", text: src }]);
    expect(r.tables.map((x) => x.name)).toEqual(["EXTERNAL_T"]);
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail}`)).toEqual([
      "1 PROCEDURE P (lines 1-4): routine body not analysed; it names tables INTERNAL_T (textual, unverified).",
    ]);
  });

  it("indexes keep bare-column keys only; expression, COLLATE, opclass and partial indexes are gaps", () => {
    const r = analyseSql([
      {
        path: "i.sql",
        text: [
          "CREATE TABLE T (A INT, B INT, C VARCHAR(10));",
          "CREATE INDEX IX1 ON T USING btree (A, B);",
          "CREATE UNIQUE INDEX IX2 ON T (lower(C));",
          "CREATE UNIQUE INDEX IX3 ON T (A DESC, B ASC NULLS LAST);",
          "CREATE UNIQUE INDEX IX4 ON T (B) WHERE A > 0;",
          'CREATE INDEX IX5 ON T (C COLLATE "C");',
          "CREATE INDEX IX6 ON T (C text_pattern_ops);",
        ].join("\n"),
      },
    ]);
    expect(r.indexes.map((x) => `${x.name} ${x.unique} ${x.columns.join(",")}`)).toEqual([
      "IX1 false A,B",
      "IX3 true A,B",
    ]);
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail}`)).toEqual([
      "3 CREATE INDEX IX2 has a key that is not a bare column (expression, COLLATE or operator class); its columns are not modelled.",
      "5 CREATE INDEX IX4 is partial (WHERE); its rows are not modelled.",
      "6 CREATE INDEX IX5 has a key that is not a bare column (expression, COLLATE or operator class); its columns are not modelled.",
      "7 CREATE INDEX IX6 has a key that is not a bare column (expression, COLLATE or operator class); its columns are not modelled.",
    ]);
  });

  it("reads every comma-separated action of one ALTER TABLE", () => {
    const r = analyseSql([
      {
        path: "a.sql",
        text: [
          "CREATE TABLE T (A INT, B INT);",
          "ALTER TABLE T ADD D INT, ADD COLUMN E CHAR(2) NOT NULL;",
          "ALTER TABLE T ADD CONSTRAINT PK_T PRIMARY KEY (A), DROP COLUMN B;",
        ].join("\n"),
      },
    ]);
    const t = r.tables.find((x) => x.name === "T");
    expect(t?.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["A", "INT", undefined],
      ["B", "INT", undefined],
      ["D", "INT", undefined],
      ["E", "CHAR(2)", false],
    ]);
    expect(t?.constraints.map((c) => `${c.kind} ${c.name} ${c.columns.join(",")}`)).toEqual([
      "PRIMARY KEY PK_T A",
    ]);
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail}`)).toEqual([
      "3 ALTER TABLE T DROP is not modelled.",
    ]);
  });

  it("reads ALTER TABLE IF EXISTS and ADD COLUMN IF NOT EXISTS as guards, not names", () => {
    const r = analyseSql([
      {
        path: "a.sql",
        text: [
          "CREATE TABLE T (A INT);",
          "ALTER TABLE IF EXISTS ONLY T ADD COLUMN IF NOT EXISTS D INT NOT NULL;",
          "ALTER TABLE T ADD IF NOT EXISTS E CHAR(2), ADD COLUMN IF NOT EXISTS F INT;",
          "ALTER TABLE IF EXISTS T DROP COLUMN IF EXISTS A;",
        ].join("\n"),
      },
    ]);
    const t = r.tables.find((x) => x.name === "T");
    expect(t?.columns.map((c) => [c.name, c.type, c.nullable])).toEqual([
      ["A", "INT", undefined],
      ["D", "INT", false],
      ["E", "CHAR(2)", undefined],
      ["F", "INT", undefined],
    ]);
    expect(r.tables.map((x) => x.name)).toEqual(["T"]);
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail}`)).toEqual([
      "4 ALTER TABLE T DROP is not modelled.",
    ]);
  });

  it("never adds an existing column twice: IF NOT EXISTS is a no-op, a bare ADD is a gap", () => {
    const r = analyseSql([
      {
        path: "a.sql",
        text: [
          "CREATE TABLE T (A INT, B CHAR(4));",
          "ALTER TABLE T ADD COLUMN IF NOT EXISTS a VARCHAR(9);",
          "ALTER TABLE T ADD B DATE, ADD C INT, ADD COLUMN IF NOT EXISTS C DATE;",
          "ALTER TABLE T ADD D INT, ADD COLUMN IF NOT EXISTS D DATE;",
        ].join("\n"),
      },
    ]);
    const t = r.tables.find((x) => x.name === "T");
    expect(t?.columns.map((c) => `${c.name} ${c.type}`)).toEqual(["A INT", "B CHAR(4)", "D INT"]);
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail}`)).toEqual([
      "3 ALTER TABLE T ADD B: the column already exists, so the database rejects this " +
        "statement; none of its actions is applied.",
    ]);
  });

  it("never calls a duplicate a rejection once an unmodelled action has touched the table", () => {
    const r = analyseSql([
      {
        path: "a.sql",
        text: [
          "CREATE TABLE T (A INT, B INT);",
          "ALTER TABLE T DROP COLUMN A, ADD A BIGINT, ADD C INT;",
          "ALTER TABLE T RENAME COLUMN B TO X;",
          "ALTER TABLE T ADD B DATE;",
          "CREATE TABLE U (A INT);",
          "ALTER TABLE U ADD D INT, ADD A INT;",
        ].join("\n"),
      },
    ]);
    const cols = (n: string) => r.tables.find((x) => x.name === n)?.columns.map((c) => c.name);
    expect(cols("T")).toEqual(["A", "B", "C"]);
    expect(cols("U")).toEqual(["A"]);
    const unconfirmed = (c: string) =>
      `ALTER TABLE T ADD ${c}: the column is in the model, but an unmodelled action on this ` +
      "table may have dropped or renamed it; whether the database accepts this statement is " +
      "not confirmed, and the column is not added twice.";
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail}`)).toEqual([
      "2 ALTER TABLE T DROP is not modelled.",
      "3 ALTER TABLE T RENAME is not modelled.",
      `2 ${unconfirmed("A")}`,
      `4 ${unconfirmed("B")}`,
      "6 ALTER TABLE U ADD A: the column already exists, so the database rejects this " +
        "statement; none of its actions is applied.",
    ]);
  });

  it("applies a rejected ALTER TABLE whole or not at all: no partial effect survives", () => {
    const r = analyseSql([
      {
        path: "a.sql",
        text: [
          "CREATE TABLE T (A INT);",
          "ALTER TABLE T ADD B INT, ADD A INT;",
          "ALTER TABLE T ADD A INT, ADD C INT;",
          "ALTER TABLE T ADD E INT, ADD CONSTRAINT U UNIQUE (A), ADD E DATE;",
          "ALTER TABLE T ADD F INT, ADD CONSTRAINT PK PRIMARY KEY (A);",
        ].join("\n"),
      },
    ]);
    const t = r.tables.find((x) => x.name === "T");
    expect(t?.columns.map((c) => c.name)).toEqual(["A", "F"]);
    expect(t?.constraints.map((c) => c.kind)).toEqual(["PRIMARY KEY"]);
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail.split(":")[0]}`)).toEqual([
      "2 ALTER TABLE T ADD A",
      "3 ALTER TABLE T ADD A",
      "4 ALTER TABLE T ADD E",
    ]);
  });

  it("reads clauses after a CREATE TABLE column list as gaps, never as silent facts", () => {
    const r = analyseSql([
      {
        path: "a.sql",
        text: [
          "CREATE TABLE P (ID INT);",
          "CREATE TABLE C (X INT) INHERITS (P);",
          "CREATE TABLE S (A, B) AS SELECT ID, ID FROM P;",
          "CREATE TABLE M (A INT) SELECT ID AS A FROM P;",
          "CREATE TABLE PT (D DATE, V INT) PARTITION BY RANGE (D);",
          "CREATE TABLE L (ID INT, DOC CLOB) LOB (DOC) STORE AS SECUREFILE;",
          "CREATE TABLE W (A INT) WITH (fillfactor = 70) TABLESPACE TS1;",
        ].join("\n"),
      },
    ]);
    expect(r.tables.map((x) => `${x.name} ${x.columns.map((c) => c.name).join(",")}`)).toEqual([
      "C X",
      "L ID,DOC",
      "P ID",
      "PT D,V",
      "W A",
    ]);
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail}`)).toEqual([
      "2 CREATE TABLE C inherits from P; its inherited columns are not modelled.",
      "3 CREATE TABLE S is filled from a query (AS SELECT); its column types and rows are not modelled.",
      "4 CREATE TABLE M is filled from a query (SELECT); its column types and rows are not modelled.",
      "5 CREATE TABLE PT is partitioned (PARTITION BY); its partitions are not modelled.",
    ]);
  });

  it("never throws on truncated or split scripts", () => {
    for (const src of [DB2_DDL, ORACLE_DDL]) {
      for (let i = 0; i < src.length; i += 3) {
        expect(() =>
          analyseSql([
            { path: "a.sql", text: src.slice(0, i) },
            { path: "b.sql", text: src.slice(i) },
          ]),
        ).not.toThrow();
      }
    }
  });
});
