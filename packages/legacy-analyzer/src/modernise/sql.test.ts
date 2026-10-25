import { describe, expect, it } from "vitest";
import { DB2_DDL, ORACLE_DDL } from "../test-fixtures/payroll-poly.js";
import { analyseSql, splitStatements } from "./sql-ddl.js";
import { canonical, sqlTables, tableSchemas } from "./sql-text.js";

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
        references: { table: "DEPARTMENT", columns: ["DEPT_CODE"], schema: "PAYROLL" },
      },
    ]);
    expect(
      t("DEPARTMENT")?.columns.map((c) => [c.name, c.primaryKey ?? false, c.unique ?? false]),
    ).toEqual([
      ["DEPT_CODE", true, false],
      ["DEPT_NAME", false, true],
    ]);
    const pr = t("PAY_RESULT");
    expect(pr?.columns[0].references).toEqual({
      table: "EMPLOYEE",
      column: "EMP_ID",
      schema: "PAYROLL",
    });
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
        tableSchema: "PAYROLL",
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

  it("keeps the schema a query names a table with, only when every reference names the same one", () => {
    expect([
      ...tableSchemas('select * from payroll.employee e join "HR"."DEPT" d on 1=1, RUN r'),
    ]).toEqual([
      ["EMPLOYEE", "PAYROLL"],
      ["DEPT", "HR"],
    ]);
    // Bare and qualified, or two schemas: which schema is meant is not in the text.
    expect(tableSchemas("SELECT * FROM PAYROLL.EMPLOYEE JOIN EMPLOYEE ON 1=1").size).toBe(0);
    expect(tableSchemas("SELECT * FROM PAYROLL.EMPLOYEE JOIN HR.EMPLOYEE ON 1=1").size).toBe(0);
    expect([...tableSchemas("INSERT INTO hr.employee SELECT * FROM hr.employee")]).toEqual([
      ["EMPLOYEE", "HR"],
    ]);
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
      "11 PROCEDURE P_CLOSE: ALTER TABLE inside the routine body is not modelled (no schema fact taken from it).",
    ]);
    expect(
      r.routines.map(
        (x) =>
          `${x.kind} ${x.name}${x.on ? ` on ${x.on} ${x.events?.join(",")}` : ""} ${x.line}-${x.endLine}: ` +
          x.access.map((a) => `${a.op} ${a.table}@${a.line}`).join(" "),
      ),
    ).toEqual([
      "PROCEDURE P_CLOSE 7-12: UPDATE PAY_RESULT@10",
      "TRIGGER T_AUD on EMPLOYEE INSERT 13-14: INSERT EMP_AUDIT@14",
      "TRIGGER T_UPD on EMPLOYEE UPDATE 15-18: UPDATE EMP_AUDIT@17",
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
      "4 PROCEDURE P: CREATE TABLE inside the routine body is not modelled (no schema fact taken from it).",
    ]);
    expect(r.routines.map((x) => `${x.name} ${x.line}-${x.endLine}`)).toEqual(["P 1-4"]);
  });

  it("reads DB2 SQL PL and PL/SQL routine bodies: table access per statement, CALLs, triggers", () => {
    const src = [
      "CREATE PROCEDURE payroll.close_month (IN p_month INTEGER)",
      "  LANGUAGE SQL MODIFIES SQL DATA",
      "BEGIN",
      "  DECLARE v_total DECIMAL(15,2);",
      "  DECLARE c1 CURSOR FOR SELECT emp_id FROM payroll.employee WHERE active = 'Y';",
      "  SELECT SUM(amount) INTO v_total FROM pay_result WHERE month = p_month;",
      "  IF v_total > 0 THEN",
      "    UPDATE pay_summary SET total = v_total WHERE month = p_month;",
      "  END IF;",
      "  INSERT INTO pay_archive SELECT * FROM pay_result WHERE month = p_month;",
      "  DELETE FROM pay_result WHERE month = p_month;",
      "  CALL audit_log('CLOSE', p_month);",
      "END;",
      "CREATE OR REPLACE PROCEDURE recalc (p_id NUMBER) IS",
      "  CURSOR c IS SELECT id FROM bonus;",
      "BEGIN",
      "  FOR r IN c LOOP",
      "    MERGE INTO bonus_total t USING bonus b ON (t.id = b.id)",
      "      WHEN MATCHED THEN UPDATE SET t.v = b.v;",
      "  END LOOP;",
      "  EXECUTE IMMEDIATE v_sql;",
      "  CALL close_month(1);",
      "END recalc;",
      "/",
      "CREATE TRIGGER emp_upd AFTER UPDATE OF salary ON employee",
      "  REFERENCING NEW AS n FOR EACH ROW",
      "BEGIN ATOMIC",
      "  INSERT INTO emp_audit VALUES (n.emp_id, CURRENT TIMESTAMP);",
      "END;",
      "CREATE PROCEDURE broken () BEGIN UPDATE lost SET x = 1;",
    ].join("\n");
    const r = analyseSql([{ path: "r.sql", text: src }]);
    const show = (x: (typeof r.routines)[number]) =>
      `${x.kind} ${x.schema ? `${x.schema}.` : ""}${x.name}${x.on ? ` on ${x.on} ${x.events?.join(",")}` : ""} ` +
      `${x.line}-${x.endLine}: ${x.access.map((a) => `${a.op} ${a.schema ? `${a.schema}.` : ""}${a.table}@${a.line}`).join(" ")}` +
      (x.calls.length ? ` | CALL ${x.calls.map((c) => `${c.name}@${c.line}`).join(" ")}` : "");
    expect(r.routines.map(show)).toEqual([
      "PROCEDURE PAYROLL.CLOSE_MONTH 1-13: SELECT PAYROLL.EMPLOYEE@5 SELECT PAY_RESULT@6 UPDATE PAY_SUMMARY@8 INSERT PAY_ARCHIVE@10 SELECT PAY_RESULT@10 DELETE PAY_RESULT@11 | CALL AUDIT_LOG@12",
      "TRIGGER EMP_UPD on EMPLOYEE UPDATE 25-29: INSERT EMP_AUDIT@28",
      "PROCEDURE RECALC 14-23: SELECT BONUS@15 MERGE BONUS_TOTAL@18 SELECT BONUS@18 | CALL CLOSE_MONTH@22",
    ]);
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail}`)).toEqual([
      "21 PROCEDURE RECALC: dynamic SQL (EXECUTE IMMEDIATE); the statement text is built at run time, so its tables are not known.",
      "30 PROCEDURE BROKEN (lines 30-30): routine body not analysed; it names tables LOST (textual, unverified).",
    ]);
  });

  it("splits a PL/SQL package body into PACKAGE.MEMBER routines and resolves calls into them", () => {
    const src = [
      "CREATE OR REPLACE PACKAGE pay_pkg AS",
      "  PROCEDURE close_month(p_month NUMBER);",
      "END pay_pkg;",
      "/",
      "CREATE OR REPLACE PACKAGE BODY payroll.pay_pkg AS",
      "  CURSOR c_active IS SELECT emp_id FROM employee WHERE active = 'Y';",
      "  g_rate NUMBER := 1;",
      "  FUNCTION rate_for(p_grade VARCHAR2) RETURN NUMBER;",
      "  PROCEDURE close_month(p_month NUMBER) IS",
      "    v_total NUMBER;",
      "  BEGIN",
      "    SELECT SUM(amount) INTO v_total FROM pay_result WHERE month = p_month;",
      "    IF v_total > 0 THEN",
      "      UPDATE pay_summary SET total = v_total WHERE month = p_month;",
      "    END IF;",
      "    CALL archive(p_month);",
      "    CALL pay_pkg.rate_for('A');",
      "    CALL hr_pkg.notify(p_month);",
      "    CALL payroll.audit_log('CLOSE');",
      "  END close_month;",
      "  PROCEDURE archive(p_month NUMBER) IS",
      "  BEGIN",
      "    INSERT INTO pay_archive SELECT * FROM pay_result WHERE month = p_month;",
      "    CASE WHEN p_month = 12 THEN DELETE FROM pay_result; END CASE;",
      "  END;",
      "  FUNCTION rate_for(p_grade VARCHAR2) RETURN NUMBER IS",
      "    v NUMBER;",
      "  BEGIN",
      "    SELECT rate INTO v FROM grade_rate WHERE grade = p_grade;",
      "    RETURN v;",
      "  END rate_for;",
      '  FUNCTION ext_hash(s VARCHAR2) RETURN NUMBER AS LANGUAGE C NAME "hash" LIBRARY hashlib;',
      "BEGIN",
      "  SELECT rate INTO g_rate FROM default_rate;",
      "END pay_pkg;",
      "/",
      "CREATE PACKAGE BODY hr_pkg AS",
      "  PROCEDURE notify(p NUMBER) IS",
      "    PROCEDURE local_helper IS BEGIN NULL; END;",
      "  BEGIN",
      "    UPDATE hr_note SET n = p;",
      "  END notify;",
      "END hr_pkg;",
      "/",
    ].join("\n");
    const r = analyseSql([{ path: "pkg.sql", text: src }]);
    const show = (x: (typeof r.routines)[number]) =>
      `${x.kind} ${x.schema ? `${x.schema}.` : ""}${x.name} [${x.package}] ${x.line}-${x.endLine}: ` +
      x.access.map((a) => `${a.op} ${a.table}@${a.line}`).join(" ") +
      (x.calls.length ? ` | CALL ${x.calls.map((c) => `${c.name}@${c.line}`).join(" ")}` : "");
    expect(r.routines.map(show)).toEqual([
      "PROCEDURE PAYROLL.PAY_PKG.ARCHIVE [PAY_PKG] 21-25: INSERT PAY_ARCHIVE@23 SELECT PAY_RESULT@23 DELETE PAY_RESULT@24",
      "PROCEDURE PAYROLL.PAY_PKG.CLOSE_MONTH [PAY_PKG] 9-20: SELECT PAY_RESULT@12 UPDATE PAY_SUMMARY@14 | CALL PAY_PKG.ARCHIVE@16 PAY_PKG.RATE_FOR@17 HR_PKG.NOTIFY@18 AUDIT_LOG@19",
      "FUNCTION PAYROLL.PAY_PKG.RATE_FOR [PAY_PKG] 26-31: SELECT GRADE_RATE@29",
    ]);
    expect(r.routines[0].rawName).toBe("payroll.pay_pkg.archive");
    expect(r.files[0].gaps.map((g) => `${g.line} ${g.detail}`)).toEqual([
      "1 PACKAGE PAY_PKG (lines 1-3): routine body not analysed; it names no tables (textual, unverified).",
      "6 PACKAGE BODY PAY_PKG: a package-level declaration names tables EMPLOYEE; it is not attributed to a member.",
      "32 PACKAGE BODY PAY_PKG: FUNCTION EXT_HASH is an external routine (LANGUAGE / EXTERNAL); its body is not SQL and is not read.",
      "33 PACKAGE BODY PAY_PKG: the initialisation block is not analysed; it names tables DEFAULT_RATE (textual, unverified).",
      "37 PACKAGE HR_PKG (lines 37-43): routine body not analysed; it names tables HR_NOTE (textual, unverified).",
    ]);
  });

  it("reads Oracle calls written without CALL as calls, but not functions inside expressions", () => {
    const src = [
      "CREATE OR REPLACE PACKAGE BODY pay_pkg AS",
      "  PROCEDURE close_month(p_month NUMBER) IS",
      "    v_total NUMBER;",
      "  BEGIN",
      "    archive(p_month);",
      "    pay_pkg.flush;",
      "    IF p_month = 12 THEN hr_pkg.notify(p_month, rate_for('A')); ELSE flush; END IF;",
      "    <<again>> audit_log('CLOSE');",
      "    v_total := rate_for('B');",
      "    v_total := CASE WHEN p_month = 1 THEN rate_for('C') ELSE rate_for('D') END;",
      "    SELECT rate_for('E') INTO v_total FROM dual;",
      "    dbms_output.put_line('done');",
      "    raise_application_error(-20001, 'x');",
      "    COMMIT;",
      "    NULL;",
      "  EXCEPTION WHEN OTHERS THEN log_error(SQLERRM); ROLLBACK; RAISE;",
      "  END close_month;",
      "  PROCEDURE archive(p_month NUMBER) IS BEGIN DELETE FROM pay_result WHERE month = p_month; END;",
      "  PROCEDURE flush IS BEGIN NULL; END;",
      "  FUNCTION rate_for(p_grade VARCHAR2) RETURN NUMBER IS BEGIN RETURN 1; END;",
      "END pay_pkg;",
      "/",
    ].join("\n");
    const r = analyseSql([{ path: "bare.sql", text: src }]);
    const close = r.routines.find((x) => x.name === "PAY_PKG.CLOSE_MONTH");
    expect(close?.calls.map((c) => `${c.name}@${c.line}`)).toEqual([
      "PAY_PKG.ARCHIVE@5",
      "PAY_PKG.FLUSH@6",
      "HR_PKG.NOTIFY@7",
      "PAY_PKG.FLUSH@7",
      "AUDIT_LOG@8",
      "LOG_ERROR@16",
    ]);
  });

  it("indexes keep bare-column keys only;expression, COLLATE, opclass and partial indexes are gaps", () => {
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

  it("never merges two schemas' tables as a duplicate, nor alters one through the other", () => {
    const r = analyseSql([
      {
        path: "hr.sql",
        text: [
          "CREATE TABLE HR.EMPLOYEE (ID INT, NAME VARCHAR(40));",
          "CREATE TABLE DEPT (ID INT);",
          "ALTER TABLE HR.EMPLOYEE ADD HIRED DATE;",
        ].join("\n"),
      },
      {
        path: "payroll.sql",
        text: [
          "CREATE TABLE payroll.employee (ID INT, SALARY DECIMAL(9,2));",
          "ALTER TABLE PAYROLL.EMPLOYEE ADD BONUS DECIMAL(9,2);",
          "COMMENT ON COLUMN PAYROLL.EMPLOYEE.SALARY IS 'Monthly';",
          "ALTER TABLE EMPLOYEE ADD GRADE INT;",
          "COMMENT ON TABLE HR.EMPLOYEE IS 'People';",
          "CREATE TABLE HR.DEPT (ID INT);",
          "ALTER TABLE OPS.DEPT ADD CODE CHAR(3);",
        ].join("\n"),
      },
    ]);
    const emp = r.tables.filter((x) => x.name === "EMPLOYEE");
    expect(emp.map((t) => `${t.schema}.${t.name}`)).toEqual(["HR.EMPLOYEE"]);
    expect(emp[0].columns.map((c) => c.name)).toEqual(["ID", "NAME", "HIRED"]);
    expect(emp[0].comment).toBe("People");
    // An unqualified table and a qualified one of the same name stay one table, as before.
    expect(r.duplicates.map((d) => `${d.file}:${d.line} ${d.name}`)).toEqual([
      "payroll.sql:6 DEPT",
    ]);
    expect(r.files[0].gaps).toEqual([]);
    expect(r.files[1].gaps.map((g) => `${g.line} ${g.construct}: ${g.detail}`)).toEqual([
      "1 CREATE TABLE: PAYROLL.EMPLOYEE is a different table from HR.EMPLOYEE (hr.sql:1); " +
        "tables are joined by bare name, so EMPLOYEE is modelled from HR.EMPLOYEE, " +
        "PAYROLL.EMPLOYEE is its own node, and bare references to EMPLOYEE may mean either schema.",
      "4 ALTER TABLE: ALTER TABLE EMPLOYEE: not applied; no schema is named and more than one " +
        "schema defines EMPLOYEE.",
    ]);
    // ALTER and COMMENT naming the second schema apply to that schema's own definition.
    const pay = r.schemaTables.find((x) => x.schema === "PAYROLL");
    expect(pay?.columns.map((c) => `${c.name}${c.comment ? ` '${c.comment}'` : ""}`)).toEqual([
      "ID",
      "SALARY 'Monthly'",
      "BONUS",
    ]);
    expect(r.schemaTables.find((x) => x.schema === "HR")).toBe(emp[0]);
    // Only EMPLOYEE is defined by two explicit schemas; bare DEPT vs HR.DEPT is a duplicate.
    expect(r.ambiguous).toEqual([{ name: "EMPLOYEE", schemas: ["HR", "PAYROLL"] }]);
    // DEPT has no explicit schema in its first definition, so OPS.DEPT still binds to it.
    expect(r.tables.find((x) => x.name === "DEPT")?.columns.map((c) => c.name)).toEqual([
      "ID",
      "CODE",
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
