// The modernisation-assistant tools of the kurahi-legacy server on the polyglot payroll fixture
// (COBOL/DB2, Spring/JPA + JDBC Java, DB2 and Oracle DDL) and on the FORTRAN / PL/I batch fixture.
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { tmpTree } from "../../../packages/legacy-analyzer/src/test-fixtures/helpers.js";
import { POLY_FILES } from "../../../packages/legacy-analyzer/src/test-fixtures/payroll-poly.js";
import { SCI_FILES } from "../../../packages/legacy-analyzer/src/test-fixtures/sci-batch.js";
import { connect, type Connected } from "./test-project.js";

const AT = /^[\w./-]+\.(cbl|jcl|java|sql|ddl):\d+$/;

function files(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory() && e.name !== ".kurahi") {
        visit(full);
      } else if (e.isFile()) {
        out.push(`${path.relative(root, full)}:${fs.lstatSync(full).mtimeMs}`);
      }
    }
  };
  visit(root);
  return out.toSorted();
}

describe("kurahi-legacy modernisation tools", () => {
  let root: string;
  let before: string[];
  let s: Connected;
  beforeAll(async () => {
    root = tmpTree(POLY_FILES);
    before = files(root);
    s = await connect({ root });
  });
  afterAll(async () => {
    await s.close();
  });

  it("modernise_plan detects the languages and lists planned assistants without facts", async () => {
    const r = await s.call("modernise_plan");
    expect(r.isError).toBe(false);
    const plan = r.structured.result;
    expect(plan.languages.map((l: { id: string }) => l.id)).toEqual([
      "cobol",
      "java",
      "sql-ddl",
      "fortran",
      "pli",
      "plc-iec61131",
    ]);
    expect(plan.planned.map((p: { id: string }) => p.id)).toContain("cybersecurity");
    expect(plan.crossLanguage.shared).toEqual(["EMPLOYEE", "PAY_RESULT"]);
    expect(r.text).toMatch(
      /java \(active, 7 files\).*fortran \(active, 1 files\).*plc-iec61131 \(active, 1 files\)/,
    );
    const gaps = plan.coverage.java.gaps as Array<{ at: string }>;
    expect(gaps.every((g) => AT.test(g.at))).toBe(true);
  });

  it("modernise_crud and modernise_impact cite every fact at path:line", async () => {
    const crud = await s.call("modernise_crud", { table: "EMPLOYEE" });
    const rows = crud.structured.result.rows as Array<{
      name: string;
      evidence: Array<{ at: string }>;
    }>;
    expect(rows.map((x) => x.name)).toContain("PAYPOST");
    expect(rows.flatMap((x) => x.evidence).every((e) => AT.test(e.at))).toBe(true);
    const imp = await s.call("modernise_impact", { target: "EMPLOYEE.BASE_PAY" });
    expect(imp.structured.result.found).toBe(true);
    expect(imp.text).toMatch(/^Impact of EMPLOYEE.BASE_PAY/);
    const none = await s.call("modernise_impact", { target: "NOTHING_HERE" });
    expect(none.text).toMatch(
      /no table, column, data set, COMMON block, module, Java type or program/,
    );
  });

  it("modernise_inventory lists and details Java types and tables", async () => {
    const list = await s.call("modernise_inventory", { kind: "java" });
    expect(list.structured.result.types).toHaveLength(9);
    const one = await s.call("modernise_inventory", { kind: "sql", name: "pay_result" });
    expect(one.structured.result.table.columns.map((c: { name: string }) => c.name)).toEqual([
      "EMP_ID",
      "PERIOD",
      "GROSS",
      "PAID_AT",
    ]);
    const bad = await s.call("modernise_inventory", { kind: "java", name: "Nope" });
    expect(bad.isError).toBe(true);
  });

  it("serves the Java and table sections of the design document and writes nothing in the project", async () => {
    const doc = await s.call("legacy_design_doc", { lang: "ja" });
    const sections = (doc.structured.result.parts as Array<{ section: string }>).map(
      (p) => p.section,
    );
    expect(sections).toEqual([
      "overview",
      "jobs",
      "programs",
      "java",
      "fortran",
      "plc",
      "dictionary",
      "tables",
      "crud",
      "coverage",
    ]);
    const tables = await s.call("legacy_design_doc", { lang: "en", section: "tables" });
    expect(tables.structured.result.parts[0].markdown).toContain("## 1. Table definitions");
    expect(files(root)).toEqual(before);
  });
});

describe("kurahi-legacy modernisation tools on FORTRAN and PL/I", () => {
  let root: string;
  let before: string[];
  let s: Connected;
  const SCI_AT = /^[\w./-]+\.(f|f90|CMN|pli|plinc|cbl|jcl|sql):\d+$/;
  beforeAll(async () => {
    root = tmpTree(SCI_FILES);
    before = files(root);
    s = await connect({ root });
  });
  afterAll(async () => {
    await s.close();
  });

  it("modernise_plan reports FORTRAN and PL/I as active engines with coverage", async () => {
    const r = await s.call("modernise_plan");
    expect(r.isError).toBe(false);
    expect(r.text).toMatch(/fortran \(active, 4 files\), pli \(active, 2 files\)/);
    const plan = r.structured.result;
    expect(plan.planned.map((p: { id: string }) => p.id)).not.toContain("fortran");
    expect(plan.coverage.fortran.gaps.every((g: { at: string }) => SCI_AT.test(g.at))).toBe(true);
  });

  it("modernise_inventory, modernise_crud and modernise_impact answer with path:line", async () => {
    const unit = await s.call("modernise_inventory", { kind: "fortran", name: "STEP" });
    expect(unit.text).toMatch(/^FORTRAN unit STEP\./);
    const block = await s.call("modernise_inventory", { kind: "fortran", name: "/GRID/" });
    expect(block.text).toMatch(/^COMMON block \/GRID\/\./);
    const proc = await s.call("modernise_inventory", { kind: "pli" });
    expect(proc.text).toMatch(/^2 PL\/I procedures\./);
    const crud = await s.call("modernise_crud", { table: "ACCOUNT" });
    const rows = crud.structured.result.rows as Array<{
      language: string;
      evidence: Array<{ at: string }>;
    }>;
    expect(rows.map((x) => x.language)).toEqual(["COBOL", "PL/I"]);
    expect(rows.flatMap((x) => x.evidence).every((e) => SCI_AT.test(e.at))).toBe(true);
    const imp = await s.call("modernise_impact", { target: "/GRID/" });
    expect(imp.text).toMatch(
      /^Impact of \/GRID\/: 0 accesses, 4 schema links, 2 upstream callers \(FORTRAN, JCL\)/,
    );
    expect(files(root)).toEqual(before);
  });
});
