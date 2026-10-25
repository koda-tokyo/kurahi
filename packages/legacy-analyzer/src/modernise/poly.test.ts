import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { crudMatrix, viewOf } from "../crud.js";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree, uncitedFactLines } from "../test-fixtures/doc-check.js";
import { MIXED_FILES } from "../test-fixtures/mixed.js";
import { POLY_FILES } from "../test-fixtures/payroll-poly.js";
import { crossCrud, legacyModernisePlan, modernisePlanFor } from "./api.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { crossImpact } from "./poly-impact.js";
import { analyseProject } from "./project.js";

const root = namedTree("payroll-poly", POLY_FILES);
const index = buildIndex(root);
const poly = analyseProject(index);
const graph = buildPolyglotGraph(poly);
const view = viewOf(graph);

describe("polyglot knowledge graph", () => {
  it("joins the COBOL EXEC SQL table, the JPA @Table and the DDL table in one node", () => {
    const emp = graph.nodes.filter((n) => n.kind === "table" && n.name === "EMPLOYEE");
    expect(emp).toHaveLength(1);
    expect(emp[0]).toMatchObject({
      id: "table:EMPLOYEE",
      loc: { file: "db/db2/payroll.sql", line: 2 },
    });
    expect(emp[0].attrs).toMatchObject({ schema: "PAYROLL", type: "table", columns: "6" });
    const into = (view.in.get("table:EMPLOYEE") ?? []).map(
      (e) => `${e.kind} ${e.from} ${e.loc.file}:${e.loc.line}`,
    );
    expect(into).toContain("SQL program:PAYPOST cobol/PAYPOST.cbl:17");
    expect(into).toContain(
      "MAPS type:jp.kazanami.payroll.domain.Employee src/main/java/jp/kazanami/payroll/domain/Employee.java:8",
    );
    expect(into).toContain("FK table:PAY_RESULT db/db2/payroll.sql:20");
    expect(into).toContain("FK table:PAY_AUDIT db/oracle/audit.ddl:9");
    expect(into).toContain("VIEW table:V_DEPT_PAY db/db2/payroll.sql:33");
    expect(graph.nodes.find((n) => n.id === "column:EMPLOYEE.BASE_PAY")?.attrs).toMatchObject({
      type: "DECIMAL(7, 0)",
      nullable: "false",
    });
    expect(view.in.get("column:EMPLOYEE.BASE_PAY")?.map((e) => `${e.kind} ${e.detail}`)).toEqual([
      "CONTAINS undefined",
      "MAPS basePay (implicit name)",
    ]);
  });

  it("carries Java structure and resolved calls with path:line on every edge", () => {
    expect(graph.edges.every((e) => e.loc.file && e.loc.line > 0)).toBe(true);
    const inv = graph.edges
      .filter((e) => e.kind === "INVOKES")
      .map((e) => `${e.from.split(".").pop()} -> ${e.to.split(".").pop()}`);
    expect(inv).toContain("PayrollController#run(String) -> PayrollService#calculate(String)");
    expect(
      graph.edges.some(
        (e) =>
          e.kind === "IMPLEMENTS" &&
          e.from === "type:jp.kazanami.payroll.repo.EmployeeRepository" &&
          e.to === "type:JpaRepository",
      ),
    ).toBe(true);
    expect(graph.nodes.find((n) => n.id === "type:JpaRepository")?.attrs).toEqual({
      external: "true",
    });
  });

  it("gives one CRUD matrix across COBOL and Java", () => {
    const m = crudMatrix(view);
    const cell = (p: string, t: string) => m.cells.get(p)?.get(`table:${t}`)?.join("");
    expect(cell("program:PAYPOST", "EMPLOYEE")).toBe("RU");
    expect(cell("program:PAYPOST", "PAY_RESULT")).toBe("C");
    expect(cell("type:jp.kazanami.payroll.jdbc.PayResultJdbcDao", "PAY_RESULT")).toBe("CR");
    expect(cell("type:jp.kazanami.payroll.service.PayrollService", "EMPLOYEE")).toBe("CRU");
    expect(cell("type:jp.kazanami.payroll.service.PayrollService", "PAY_RESULT")).toBe("D");
    const rows = crossCrud(poly, graph, { table: "pay_result" }).rows;
    expect(rows.map((r) => `${r.language} ${r.name} ${r.ops.join("")}`)).toEqual([
      "COBOL PAYPOST C",
      "Java jp.kazanami.payroll.jdbc.PayResultJdbcDao CR",
      "Java jp.kazanami.payroll.repo.EmployeeRepository D",
      "Java jp.kazanami.payroll.service.PayrollService D",
    ]);
    expect(rows[0].evidence).toEqual([
      { op: "C", via: "SQL INSERT", where: "2000-POST", file: "cobol/PAYPOST.cbl", line: 21 },
    ]);
  });

  it("follows impact from a table to COBOL, Java, JCL and schema objects", () => {
    const r = crossImpact(poly, graph, "employee");
    expect(r.found).toBe(true);
    expect(r.languages).toEqual(["COBOL", "JCL", "Java", "SQL"]);
    expect(r.accessors.map((a) => `${a.name} ${a.ops.join("")} ${a.file}:${a.line}`)).toContain(
      "PAYPOST U cobol/PAYPOST.cbl:23",
    );
    expect(r.schema.map((s) => `${s.relation} ${s.name}`)).toEqual(
      expect.arrayContaining([
        "view reads it V_DEPT_PAY",
        "foreign key references it PAY_RESULT",
        "mapped by Employee",
        "references (foreign key) DEPARTMENT",
      ]),
    );
    expect(r.callers.map((c) => `${c.name} d${c.depth} ${c.file}:${c.line}`)).toEqual([
      "S10 d1 jcl/PY02POST.jcl:2",
      "PayrollController d1 src/main/java/jp/kazanami/payroll/web/PayrollController.java:16",
      "PY02POST d2 jcl/PY02POST.jcl:2",
    ]);
    const col = crossImpact(poly, graph, "PAY_RESULT.GROSS");
    expect(col.mentions.map((x) => `${x.owner.split(".").pop()} ${x.file}:${x.line}`)).toEqual([
      "PayResultJdbcDao src/main/java/jp/kazanami/payroll/jdbc/PayResultJdbcDao.java:21",
      "PayResultJdbcDao src/main/java/jp/kazanami/payroll/jdbc/PayResultJdbcDao.java:25",
      "PAYPOST cobol/PAYPOST.cbl:21",
    ]);
    expect(crossImpact(poly, graph, "NO_SUCH_TABLE")).toMatchObject({
      found: false,
      accessors: [],
    });
  });
});

describe("modernisation plan", () => {
  const plan = modernisePlanFor(index);
  it("detects languages, runs the active engines and lists planned assistants honestly", () => {
    expect(
      plan.languages.map((l) => `${l.id}:${l.status}:${l.detectedFiles}/${l.analysedFiles}`),
    ).toEqual([
      "cobol:active:2/2",
      "java:active:7/7",
      "sql-ddl:active:2/2",
      "fortran:active:1/1",
      "pli:active:0/0",
      "plc-iec61131:active:1/1",
    ]);
    expect(plan.planned.map((p) => p.id)).toEqual([
      "batch-scheduler",
      "maintenance",
      "cybersecurity",
    ]);
    expect(plan.planned.every((p) => p.description.startsWith("Planned: no "))).toBe(true);
    expect(plan.inventory.java).toMatchObject({
      files: 7,
      entities: 2,
      services: 1,
      controllers: 1,
    });
    expect(plan.inventory.sql).toMatchObject({ tables: 4, views: 1, indexes: 1 });
    expect(plan.crossLanguage.shared).toEqual(["EMPLOYEE", "PAY_RESULT"]);
    expect(plan.crossLanguage.accessedButNotDefined).toEqual([]);
    expect(plan.crossLanguage.definedButNotAccessed).toEqual(["V_DEPT_PAY"]);
  });

  it("reports what was not modelled or resolved instead of hiding it", () => {
    expect(plan.coverage.java.gaps.map((g) => g.construct)).toEqual([
      "anonymous class",
      "initializer block",
    ]);
    expect(plan.coverage.java.unresolvedCalls).toBeGreaterThan(0);
    expect(plan.coverage.java.partialSql).toHaveLength(1);
    expect(plan.coverage.sql.gaps.map((g) => `${g.file}:${g.line}`)).toEqual([
      "db/db2/payroll.sql:38",
      "db/oracle/audit.ddl:11",
    ]);
    expect(plan.coverage.cobol.notAnalysedFiles).toBe(1); // README: not the Java, DDL, FORTRAN or PLC files
  });

  it("ignores Kurahi's own state folder: the MCP server's cache and call log change nothing", () => {
    const tree = namedTree("payroll-poly", POLY_FILES);
    const env = { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "legacy-state-")) };
    const before = JSON.stringify(legacyModernisePlan(tree, env));
    const docBefore = designDoc(buildIndex(tree), { lang: "en" }).markdown;
    // What `kurahi legacy mcp --root` writes after its first call (extensions/legacy-analyzer/mcp/state.ts).
    const state = path.join(tree, ".kurahi", "legacy-mcp");
    fs.mkdirSync(path.join(state, "cache"), { recursive: true });
    fs.writeFileSync(path.join(state, "audit.jsonl"), '{"tool":"modernise_plan"}\n');
    fs.writeFileSync(path.join(state, "cache", "index-0.json"), "{}");
    fs.writeFileSync(path.join(state, "cache", "STALE.cbl"), "       PROGRAM-ID. STALE.\n");
    expect(JSON.stringify(legacyModernisePlan(tree, env))).toBe(before);
    expect(designDoc(buildIndex(tree), { lang: "en" }).markdown).toBe(docBefore);
    expect(buildIndex(tree).files.map((f) => f.path)).not.toContain(
      ".kurahi/legacy-mcp/cache/STALE.cbl",
    );
  });

  it("is deterministic: byte-identical plan and documents for two copies of the project", () => {
    const again = namedTree("payroll-poly", POLY_FILES);
    const env = { stateDir: fs.mkdtempSync(path.join(os.tmpdir(), "legacy-state-")) };
    expect(JSON.stringify(legacyModernisePlan(again, env))).toBe(JSON.stringify(plan));
    const poly2 = analyseProject(buildIndex(again));
    for (const lang of ["ja", "en"] as const) {
      expect(designDoc(buildIndex(again), { lang, poly: poly2 }).markdown).toBe(
        designDoc(index, { lang, poly }).markdown,
      );
    }
  });
});

describe("design document with Java and SQL sections", () => {
  it("adds class specifications and table definitions, every fact line cited", () => {
    for (const lang of ["ja", "en"] as const) {
      const md = designDoc(index, { lang, poly }).markdown;
      expect(uncitedFactLines(md)).toEqual([]);
      expect(md).not.toMatch(/\b(GPT|OpenAI|Claude|Anthropic|Gemini|LLM)\b/);
    }
    const en = designDoc(index, { lang: "en", poly }).markdown;
    expect(en).toContain("## 4. Java class specifications");
    expect(en).toContain("## 5. FORTRAN program units");
    expect(en).toContain("## 8. Table definitions");
    expect(en).toContain("### 4.7 jp.kazanami.payroll.service.PayrollService");
    expect(en).toMatch(/\| `basePay` \| `BigDecimal` \|  \| `EMPLOYEE.BASE_PAY` \(implicit\) \|/);
    expect(en).toMatch(/\| 4 \| `EMP_TYPE` \| `CHAR\(1\)` \| NO \| `'R'` \|/);
    expect(en).toMatch(
      /\| `PAYPOST` \| COBOL \| U \| SQL UPDATE \| `2000-POST` \| `cobol\/PAYPOST.cbl:23` \|/,
    );
    const ja = designDoc(index, { lang: "ja", poly }).markdown;
    expect(ja).toContain("## 4. Java クラス仕様");
    expect(ja).toContain("## 5. FORTRAN プログラム単位仕様");
    expect(ja).toContain("## 8. テーブル定義");
    const only = designDoc(index, { lang: "en", poly, sections: ["tables"] }).markdown;
    expect(only).toContain("## 1. Table definitions");
    expect(only).not.toContain("Java class specifications");
  });

  it("leaves a COBOL-only document unchanged", () => {
    const cobol = namedTree("mixed", MIXED_FILES);
    const idx = buildIndex(cobol);
    const p = analyseProject(idx);
    expect(designDoc(idx, { lang: "en", poly: p }).markdown).toBe(
      designDoc(idx, { lang: "en" }).markdown,
    );
  });
});

describe("polyglot graph across schemas", () => {
  it("marks a table node two schemas define as ambiguous, so a Java join to it is not certain", () => {
    const root = namedTree("two-schemas", {
      "db/hr.sql": "CREATE TABLE HR.EMPLOYEE (ID INT, NAME VARCHAR(40));",
      "db/payroll.sql":
        "CREATE TABLE PAYROLL.EMPLOYEE (ID INT, SALARY DECIMAL(9,2));\nCREATE TABLE PAYROLL.RUN (ID INT);",
      "src/main/java/jp/fic/Reader.java": [
        "package jp.fic;",
        "public class Reader {",
        "  int count(java.sql.Connection c) throws Exception {",
        '    return c.prepareStatement("SELECT COUNT(*) FROM EMPLOYEE").executeQuery().getInt(1);',
        "  }",
        "}",
      ].join("\n"),
    });
    const p = analyseProject(buildIndex(root));
    expect(p.sql.ambiguous).toEqual([{ name: "EMPLOYEE", schemas: ["HR", "PAYROLL"] }]);
    const g = buildPolyglotGraph(p);
    const emp = g.nodes.find((n) => n.id === "table:EMPLOYEE");
    expect(emp?.attrs).toMatchObject({ schema: "HR", ambiguousSchemas: "HR,PAYROLL" });
    expect(g.nodes.find((n) => n.id === "table:RUN")?.attrs?.ambiguousSchemas).toBeUndefined();
    expect(
      g.edges.filter((e) => e.to === "table:EMPLOYEE" && e.from === "type:jp.fic.Reader"),
    ).toHaveLength(1);
  });

  it("makes a read routine body a node: SQL edges, CALLs, triggers, CRUD and impact through it", () => {
    const root = namedTree("routines", {
      "db/schema.sql": [
        "CREATE TABLE employee (id INT PRIMARY KEY, salary DECIMAL(9,2));",
        "CREATE TABLE emp_audit (id INT, at TIMESTAMP);",
      ].join("\n"),
      "db/routines.sql": [
        "CREATE PROCEDURE raise_pay (IN p_id INT)",
        "LANGUAGE SQL",
        "BEGIN",
        "  UPDATE employee SET salary = salary * 1.02 WHERE id = p_id;",
        "  CALL notify_hr(p_id);",
        "END;",
        "CREATE TRIGGER emp_aud AFTER UPDATE ON employee FOR EACH ROW",
        "  INSERT INTO emp_audit VALUES (1, CURRENT TIMESTAMP);",
      ].join("\n"),
    });
    const p = analyseProject(buildIndex(root));
    const g = buildPolyglotGraph(p);
    const ids = (kind: string) => g.nodes.filter((n) => n.kind === kind).map((n) => n.id);
    expect(ids("routine")).toEqual(["routine:EMP_AUD", "routine:NOTIFY_HR", "routine:RAISE_PAY"]);
    expect(g.nodes.find((n) => n.id === "routine:NOTIFY_HR")?.attrs?.defined).toBe(
      "not in the analysed DDL",
    );
    const fromRoutines = g.edges
      .filter((e) => e.from.startsWith("routine:") || e.to.startsWith("routine:"))
      .map((e) => `${e.kind} ${e.from} -> ${e.to} ${e.detail} ${e.loc.file}:${e.loc.line}`);
    expect(fromRoutines).toEqual([
      "SQL routine:EMP_AUD -> table:EMP_AUDIT INSERT db/routines.sql:8",
      "CALL routine:RAISE_PAY -> routine:NOTIFY_HR SQL CALL db/routines.sql:5",
      "SQL routine:RAISE_PAY -> table:EMPLOYEE UPDATE db/routines.sql:4",
      "TRIGGER table:EMPLOYEE -> routine:EMP_AUD UPDATE db/routines.sql:7",
    ]);
    const m = crudMatrix(viewOf(g));
    expect(m.cells.get("routine:RAISE_PAY")?.get("table:EMPLOYEE")).toEqual(["U"]);
    const r = crossImpact(p, g, "employee");
    expect(r.accessors.map((a) => `${a.name} ${a.ops.join("")} ${a.file}:${a.line}`)).toContain(
      "RAISE_PAY U db/routines.sql:4",
    );
    expect(
      crossCrud(p, g, { table: "employee" }).rows.map((x) => `${x.language} ${x.name}`),
    ).toEqual(["SQL RAISE_PAY"]);
    const idx = buildIndex(root);
    for (const lang of ["ja", "en"] as const) {
      expect(uncitedFactLines(designDoc(idx, { lang, poly: p }).markdown)).toEqual([]);
    }
    const md = designDoc(idx, { lang: "en", poly: p, sections: ["tables"] }).markdown;
    expect(md).toContain("Stored routines");
    expect(md).toContain(
      "| `EMP_AUD` | TRIGGER | `EMPLOYEE` UPDATE | EMP_AUDIT INSERT |  | `db/routines.sql:7` `db/routines.sql:8` |",
    );
    expect(md).toContain(
      "| `RAISE_PAY` | PROCEDURE |  | EMPLOYEE UPDATE | NOTIFY_HR | `db/routines.sql:1` `db/routines.sql:4` `db/routines.sql:5` |",
    );
  });

  it("binds a Java reference naming one schema to that schema's own table node", () => {
    const root = namedTree("two-schemas-qualified", {
      "db/hr.sql": "CREATE TABLE HR.EMPLOYEE (ID INT, NAME VARCHAR(40));",
      "db/payroll.sql": "CREATE TABLE PAYROLL.EMPLOYEE (ID INT, SALARY DECIMAL(9,2));",
      "src/main/java/jp/fic/Pay.java": [
        "package jp.fic;",
        "import jakarta.persistence.*;",
        "@Entity",
        '@Table(name = "employee", schema = "payroll")',
        "public class Pay {",
        "  @Id String id;",
        "}",
      ].join("\n"),
      "src/main/java/jp/fic/PayRepo.java": [
        "package jp.fic;",
        "import org.springframework.data.jpa.repository.*;",
        "public interface PayRepo extends JpaRepository<Pay, String> {",
        '  @Query("select p from Pay p")',
        "  java.util.List<Pay> all();",
        "}",
      ].join("\n"),
      "src/main/java/jp/fic/Reader.java": [
        "package jp.fic;",
        "public class Reader {",
        "  int hr(java.sql.Connection c) throws Exception {",
        '    return c.prepareStatement("SELECT COUNT(*) FROM hr.employee").executeQuery().getInt(1);',
        "  }",
        "  int bare(java.sql.Connection c) throws Exception {",
        '    return c.prepareStatement("SELECT COUNT(*) FROM EMPLOYEE").executeQuery().getInt(1);',
        "  }",
        "}",
      ].join("\n"),
    });
    const p = analyseProject(buildIndex(root));
    const g = buildPolyglotGraph(p);
    const into = (from: string, kind: string) =>
      g.edges
        .filter((e) => e.from === from && e.kind === kind && e.to.startsWith("table:"))
        .map((e) => `${e.to} ${e.schema ?? "(bare)"}`)
        .toSorted();
    expect(into("type:jp.fic.Pay", "MAPS")).toEqual(["table:PAYROLL.EMPLOYEE PAYROLL"]);
    expect(into("type:jp.fic.PayRepo", "MAPS")).toEqual(["table:PAYROLL.EMPLOYEE PAYROLL"]);
    expect(into("type:jp.fic.PayRepo", "SQL")).toEqual(["table:PAYROLL.EMPLOYEE PAYROLL"]);
    expect(into("type:jp.fic.Reader", "SQL")).toEqual([
      "table:EMPLOYEE (bare)",
      "table:HR.EMPLOYEE HR",
    ]);
    // Impact on one schema's table reaches only its own callers; the bare name reaches all.
    const who = (q: string) =>
      [...new Set(crossImpact(p, g, q).accessors.map((a) => a.name))].toSorted();
    expect(who("payroll.employee")).toEqual(["PayRepo"]);
    expect(who("hr.employee")).toEqual(["Reader"]);
    expect(who("employee")).toEqual(["PayRepo", "Reader"]);
    const mapped = (q: string) =>
      crossImpact(p, g, q)
        .schema.filter((x) => x.relation === "mapped by")
        .map((x) => x.name)
        .toSorted();
    expect(mapped("payroll.employee")).toEqual(["Pay", "PayRepo"]);
    expect(mapped("hr.employee")).toEqual([]);
    expect(mapped("employee")).toEqual(["Pay", "PayRepo"]);
    expect(
      crossCrud(p, g, { table: "employee" })
        .rows.map((x) => `${x.name} ${x.table}`)
        .toSorted(),
    ).toEqual([
      "jp.fic.PayRepo PAYROLL.EMPLOYEE",
      "jp.fic.Reader EMPLOYEE",
      "jp.fic.Reader HR.EMPLOYEE",
    ]);
  });

  it("gives each schema's table of an ambiguous name its own node, columns and SCHEMA edge", () => {
    const root = namedTree("two-schemas-nodes", {
      "db/hr.sql": "CREATE TABLE HR.EMPLOYEE (ID INT, NAME VARCHAR(40));",
      "db/payroll.sql": [
        "CREATE TABLE PAYROLL.EMPLOYEE (ID INT, SALARY DECIMAL(9,2));",
        "CREATE TABLE PAYROLL.RUN (ID INT);",
        "CREATE PROCEDURE PAYROLL.BUMP (IN P INT)",
        "LANGUAGE SQL",
        "BEGIN",
        "  UPDATE PAYROLL.EMPLOYEE SET SALARY = SALARY + 1 WHERE ID = P;",
        "  UPDATE EMPLOYEE SET SALARY = 0 WHERE ID = P;",
        "END;",
      ].join("\n"),
    });
    const p = analyseProject(buildIndex(root));
    expect(p.sql.schemaTables.map((t) => `${t.schema}.${t.name} ${t.file}:${t.line}`)).toEqual([
      "HR.EMPLOYEE db/hr.sql:1",
      "PAYROLL.EMPLOYEE db/payroll.sql:1",
    ]);
    const g = buildPolyglotGraph(p);
    const tables = g.nodes.filter((n) => n.kind === "table").map((n) => n.id);
    expect(tables).toEqual([
      "table:EMPLOYEE",
      "table:HR.EMPLOYEE",
      "table:PAYROLL.EMPLOYEE",
      "table:RUN",
    ]);
    expect(g.nodes.find((n) => n.id === "table:PAYROLL.EMPLOYEE")?.attrs).toMatchObject({
      schema: "PAYROLL",
      umbrella: "EMPLOYEE",
      columns: "2",
    });
    expect(g.nodes.find((n) => n.id === "column:PAYROLL.EMPLOYEE.SALARY")?.attrs?.table).toBe(
      "PAYROLL.EMPLOYEE",
    );
    expect(
      g.edges.filter((e) => e.kind === "SCHEMA").map((e) => `${e.from} -> ${e.to} ${e.detail}`),
    ).toEqual([
      "table:EMPLOYEE -> table:HR.EMPLOYEE HR",
      "table:EMPLOYEE -> table:PAYROLL.EMPLOYEE PAYROLL",
    ]);
    expect(
      g.edges
        .filter((e) => e.from === "routine:BUMP" && e.kind === "SQL")
        .map((e) => `${e.to} ${e.loc.line}`),
    ).toEqual(["table:EMPLOYEE 7", "table:PAYROLL.EMPLOYEE 6"]);
    // An unambiguous table keeps its single node.
    expect(g.nodes.some((n) => n.id === "table:PAYROLL.RUN")).toBe(false);
  });

  it("binds foreign keys, view sources, indexes and ALTERs that name a schema to its own node", () => {
    const root = namedTree("two-schemas-ddl", {
      "db/hr.sql": [
        "CREATE TABLE HR.EMPLOYEE (ID INT PRIMARY KEY, NAME VARCHAR(40));",
        "CREATE TABLE HR.BADGE (ID INT, EMP INT REFERENCES HR.EMPLOYEE (ID));",
      ].join("\n"),
      "db/payroll.sql": [
        "CREATE TABLE PAYROLL.EMPLOYEE (ID INT, SALARY DECIMAL(9,2), PRIMARY KEY (ID));",
        "CREATE TABLE PAYROLL.SLIP (ID INT, EMP INT,",
        "  CONSTRAINT FK_SLIP FOREIGN KEY (EMP) REFERENCES PAYROLL.EMPLOYEE (ID));",
        "CREATE TABLE PAYROLL.NOTE (ID INT, EMP INT REFERENCES EMPLOYEE (ID));",
        "CREATE VIEW PAYROLL.V_PAY AS SELECT E.ID, E.SALARY FROM PAYROLL.EMPLOYEE E;",
        "CREATE INDEX IX_PAY ON PAYROLL.EMPLOYEE (SALARY);",
        "CREATE INDEX IX_EMP ON EMPLOYEE (ID);",
        "ALTER TABLE PAYROLL.EMPLOYEE ADD BONUS DECIMAL(9,2);",
        "ALTER TABLE PAYROLL.EMPLOYEE ADD CONSTRAINT FK_SELF FOREIGN KEY (ID) REFERENCES PAYROLL.SLIP (ID);",
      ].join("\n"),
    });
    const p = analyseProject(buildIndex(root));
    const g = buildPolyglotGraph(p);
    const kinds = new Set(["FK", "VIEW", "INDEX"]);
    expect(
      g.edges
        .filter((e) => kinds.has(e.kind))
        .map((e) => `${e.kind} ${e.from} -> ${e.to}`)
        .toSorted(),
    ).toEqual([
      "FK table:BADGE -> table:HR.EMPLOYEE",
      // The bare-name table is HR's definition, so the FK added to PAYROLL's is only on its node.
      "FK table:NOTE -> table:EMPLOYEE",
      "FK table:PAYROLL.EMPLOYEE -> table:SLIP",
      "FK table:SLIP -> table:PAYROLL.EMPLOYEE",
      "INDEX index:IX_EMP -> table:EMPLOYEE",
      "INDEX index:IX_PAY -> table:PAYROLL.EMPLOYEE",
      "VIEW table:V_PAY -> table:PAYROLL.EMPLOYEE",
    ]);
    // The ALTER and the table-level PRIMARY KEY land on PAYROLL's own node and columns.
    expect(g.nodes.find((n) => n.id === "table:PAYROLL.EMPLOYEE")?.attrs?.columns).toBe("3");
    expect(g.nodes.find((n) => n.id === "column:PAYROLL.EMPLOYEE.ID")?.attrs?.primaryKey).toBe(
      "true",
    );
    expect(g.nodes.some((n) => n.id === "column:EMPLOYEE.BONUS")).toBe(false);
    expect(p.sql.files.flatMap((f) => f.gaps).filter((x) => x.construct === "ALTER TABLE")).toEqual(
      [],
    );
  });
});
