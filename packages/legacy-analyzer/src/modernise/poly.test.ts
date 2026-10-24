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
      "plc-iec61131:planned:1/0",
    ]);
    expect(plan.planned.map((p) => p.id)).toEqual([
      "plc-iec61131",
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
    expect(plan.coverage.cobol.notAnalysedFiles).toBe(2); // PLC, README: not the Java, DDL or FORTRAN files
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
    expect(en).toContain("## 7. Table definitions");
    expect(en).toContain("### 4.7 jp.kazanami.payroll.service.PayrollService");
    expect(en).toMatch(/\| `basePay` \| `BigDecimal` \|  \| `EMPLOYEE.BASE_PAY` \(implicit\) \|/);
    expect(en).toMatch(/\| 4 \| `EMP_TYPE` \| `CHAR\(1\)` \| NO \| `'R'` \|/);
    expect(en).toMatch(
      /\| `PAYPOST` \| COBOL \| U \| SQL UPDATE \| `2000-POST` \| `cobol\/PAYPOST.cbl:23` \|/,
    );
    const ja = designDoc(index, { lang: "ja", poly }).markdown;
    expect(ja).toContain("## 4. Java クラス仕様");
    expect(ja).toContain("## 5. FORTRAN プログラム単位仕様");
    expect(ja).toContain("## 7. テーブル定義");
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
