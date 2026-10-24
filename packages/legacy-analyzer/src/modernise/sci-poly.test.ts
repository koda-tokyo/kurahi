import { describe, expect, it } from "vitest";
import { crudMatrix, viewOf } from "../crud.js";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree, uncitedFactLines } from "../test-fixtures/doc-check.js";
import { SCI_FILES } from "../test-fixtures/sci-batch.js";
import { crossCrud, inventory, modernisePlanFor } from "./api.js";
import { buildPolyglotGraph } from "./poly-graph.js";
import { crossImpact } from "./poly-impact.js";
import { analyseProject } from "./project.js";

const root = namedTree("sci-batch", SCI_FILES);
const index = buildIndex(root);
const poly = analyseProject(index);
const graph = buildPolyglotGraph(poly);
const view = viewOf(graph);

describe("FORTRAN and PL/I in the polyglot graph", () => {
  it("makes units and procedures program nodes that JCL steps and other languages reach", () => {
    expect(view.node.get("program:HEATSV")).toMatchObject({
      kind: "program",
      loc: { file: "fortran/HEATSV.f", line: 3 },
      attrs: { language: "FORTRAN", unit: "program" },
    });
    expect(view.node.get("program:RATEPOST")?.attrs).toMatchObject({
      language: "PL/I",
      main: "true",
    });
    expect(view.node.get("paragraph:RATEPOST.POST_ONE")?.attrs).toMatchObject({
      procedure: "true",
    });
    const into = (id: string) =>
      (view.in.get(id) ?? []).map((e) => `${e.kind} ${e.from} ${e.loc.file}:${e.loc.line}`);
    expect(into("program:HEATSV")).toEqual(["EXEC step:HEATRUN.S10 jcl/HEATRUN.jcl:2"]);
    // PL/I CALL LOGERR (declared ENTRY) meets the COBOL program LOGERR.
    expect(into("program:LOGERR")).toEqual([
      "CALL program:RATEPOST pli/RATEPOST.pli:21",
      "CALL program:RATEPOST pli/RATEPOST.pli:48",
    ]);
    expect(view.node.get("program:LOGERR")?.loc).toEqual({ file: "cobol/LOGERR.cbl", line: 1 });
    expect(graph.edges.every((e) => e.loc.file && e.loc.line > 0)).toBe(true);
    expect(graph.nodes.some((n) => n.kind === "external-program")).toBe(false);
  });

  it("models COMMON blocks as shared data with members, and USE / INCLUDE edges", () => {
    expect(view.node.get("common:GRID")).toMatchObject({
      kind: "common-block",
      name: "/GRID/",
      attrs: { layout: "names differ", users: "4" },
    });
    expect((view.in.get("common:GRID") ?? []).map((e) => e.from)).toEqual([
      "program:HEATSV",
      "program:INITT",
      "program:STEP",
      "program:TMAX",
    ]);
    expect(view.node.get("data:/GRID/.T")?.attrs).toMatchObject({ position: "3", type: "REAL*8" });
    expect(
      (view.out.get("program:CALIB") ?? []).filter((e) => e.kind === "USE").map((e) => e.to),
    ).toEqual(["module:PHYSICS"]);
    expect((view.in.get("copybook:GRID.CMN") ?? []).map((e) => `${e.from} ${e.detail}`)).toEqual([
      "program:HEATSV INCLUDE",
      "program:INITT INCLUDE",
      "program:TMAX INCLUDE",
    ]);
  });

  it("gives one CRUD matrix for tables and files across COBOL, PL/I and FORTRAN", () => {
    const m = crudMatrix(view);
    const cell = (p: string, t: string) => m.cells.get(p)?.get(t)?.join("");
    expect(cell("program:RATEPOST", "table:ACCOUNT")).toBe("RU");
    expect(cell("program:RATEPOST", "table:RATE_HIST")).toBe("C");
    expect(cell("program:ACCTRPT", "table:ACCOUNT")).toBe("R");
    // PL/I file RATEIN through DD RATEIN of the step that runs RATEPOST.
    expect(cell("program:RATEPOST", "dataset:BANK.RATES.MONTHLY")).toBe("R");
    // FORTRAN unit 12 without OPEN: FT12F001 of the step running HEATSV, which reaches LOGSTP.
    expect(cell("program:LOGSTP", "dataset:SCI.HEAT.STEPLOG")).toBe("C");
    expect(cell("program:HEATSV", "dataset:grid.dat")).toBe("R");
    const crud = crossCrud(poly, graph, { table: "account" });
    expect(crud.rows.map((r) => `${r.language} ${r.name} ${r.ops.join("")}`)).toEqual([
      "COBOL ACCTRPT R",
      "PL/I RATEPOST RU",
    ]);
    expect(crud.rows[1].evidence.map((e) => `${e.op} ${e.where} ${e.file}:${e.line}`)).toEqual([
      "R POST_ONE pli/RATEPOST.pli:38",
      "U POST_ONE pli/RATEPOST.pli:42",
    ]);
    const files = crossCrud(poly, graph).files.map(
      (r) => `${r.language} ${r.name} ${r.table} ${r.ops.join("")}`,
    );
    expect(files).toEqual([
      "FORTRAN CALIB alpha.out C",
      "FORTRAN HEATSV grid.dat R",
      "FORTRAN HEATSV profile.out C",
      "FORTRAN LOGSTP SCI.HEAT.STEPLOG C",
      "PL/I RATEPOST BANK.RATES.MONTHLY R",
      "PL/I RATEPOST RPTOUT C",
    ]);
  });

  it("follows the impact of a table, a COMMON block and a data set across languages", () => {
    const acct = crossImpact(poly, graph, "ACCOUNT");
    expect(acct.languages).toEqual(["COBOL", "JCL", "PL/I", "SQL"]);
    expect(acct.accessors.map((a) => `${a.name} ${a.ops.join("")} ${a.where}`)).toEqual([
      "ACCTRPT R 0000-MAIN",
      "RATEPOST R POST_ONE",
      "RATEPOST U POST_ONE",
    ]);
    expect(acct.schema.map((s) => `${s.name} ${s.relation}`)).toEqual([
      "RATE_HIST foreign key references it",
    ]);
    expect(acct.callers.map((c) => `${c.kind} ${c.name}`)).toEqual(["step S20", "job HEATRUN"]);
    const grid = crossImpact(poly, graph, "/GRID/");
    expect(grid.target).toMatchObject({ kind: "common-block", file: "fortran/GRID.CMN", line: 6 });
    expect(grid.schema.map((s) => `${s.name} ${s.file}:${s.line}`)).toEqual([
      "HEATSV fortran/GRID.CMN:6",
      "INITT fortran/GRID.CMN:6",
      "STEP fortran/STEP.f:4",
      "TMAX fortran/GRID.CMN:6",
    ]);
    expect(grid.callers.map((c) => `${c.kind} ${c.name}`)).toEqual(["step S10", "job HEATRUN"]);
    const log = crossImpact(poly, graph, "SCI.HEAT.STEPLOG");
    expect(log.accessors.map((a) => `${a.name} ${a.ops.join("")} ${a.file}:${a.line}`)).toEqual([
      "LOGSTP C fortran/STEP.f:38",
    ]);
    expect(log.callers.map((c) => `${c.name} ${c.edge}`)).toEqual([
      "STEP CALL",
      "HEATSV CALL",
      "S10 EXEC",
      "HEATRUN STEP",
    ]);
    expect(
      crossImpact(poly, graph, "PHYSICS").schema.map((s) => `${s.name} ${s.relation}`),
    ).toEqual(["CALIB uses the module"]);
  });
});

describe("modernisation plan, inventory and design document with FORTRAN and PL/I", () => {
  const plan = modernisePlanFor(index);
  it("reports both engines as active, with inventory and honest coverage", () => {
    expect(
      plan.languages.map((l) => `${l.id}:${l.status}:${l.detectedFiles}/${l.analysedFiles}`),
    ).toEqual([
      "cobol:active:3/3",
      "java:active:0/0",
      "sql-ddl:active:1/1",
      "fortran:active:4/4",
      "pli:active:2/2",
    ]);
    expect(plan.inventory.fortran).toMatchObject({
      files: 4,
      fixedForm: 2,
      freeForm: 2,
      includeFiles: 1,
      commonBlocks: 2,
      resolvedCalls: 6,
      implicitTyping: 5,
    });
    expect(plan.inventory.pli).toMatchObject({
      procedures: 2,
      main: 1,
      internal: 1,
      structures: 2,
      sqlStatements: 3,
    });
    expect(plan.crossLanguage.shared).toEqual(["ACCOUNT"]);
    expect(plan.coverage.cobol.notAnalysedFiles).toBe(0);
    expect(plan.coverage.fortran.gaps.map((g) => g.construct)).toEqual([
      "computed GO TO",
      "preprocessor",
      "preprocessor",
    ]);
    expect(plan.coverage.fortran.unresolvedIo).toHaveLength(2);
    expect(plan.coverage.fortran.commonLayoutsDiffer).toEqual([
      { block: "GRID", layout: "names differ", users: ["HEATSV", "INITT", "STEP", "TMAX"] },
    ]);
    expect(plan.coverage.pli.gaps.map((g) => g.construct)).toEqual(
      Array(4).fill("macro preprocessor"),
    );
  });

  it("answers inventory queries for units, COMMON blocks and procedures", () => {
    const units = inventory(poly, "fortran") as { units: Array<{ name: string }> };
    expect(units.units).toHaveLength(10);
    const block = inventory(poly, "fortran", "/stats/") as { common: { users: unknown[] } };
    expect(block.common.users).toHaveLength(2);
    const step = inventory(poly, "fortran", "STEP") as { callers: Array<{ from: string }> };
    expect(step.callers.map((c) => c.from)).toEqual(["HEATSV"]);
    const proc = inventory(poly, "pli", "POST_ONE") as { tableUses: Array<{ table: string }> };
    expect(proc.tableUses.map((t) => t.table)).toEqual(["ACCOUNT", "ACCOUNT", "RATE_HIST"]);
    expect(() => inventory(poly, "pli", "NOPE")).toThrow(/No PL\/I procedure/);
  });

  it("adds cited FORTRAN and PL/I sections in Japanese and English, deterministically", () => {
    for (const lang of ["ja", "en"] as const) {
      const doc = designDoc(index, { lang, poly });
      expect(doc.sections).toEqual([
        "overview",
        "jobs",
        "programs",
        "fortran",
        "pli",
        "dictionary",
        "tables",
        "crud",
        "coverage",
      ]);
      expect(uncitedFactLines(doc.markdown)).toEqual([]);
      expect(doc.markdown).not.toMatch(/\b(GPT|OpenAI|Claude|Anthropic|Gemini|LLM)\b/);
      const again = analyseProject(buildIndex(namedTree("sci-batch", SCI_FILES)));
      expect(designDoc(buildIndex(again.index.root), { lang, poly: again }).markdown).toBe(
        doc.markdown,
      );
    }
    const en = designDoc(index, { lang: "en", poly }).markdown;
    expect(en).toContain("## 4. FORTRAN program units");
    expect(en).toContain("### 4.2 COMMON block map");
    expect(en).toMatch(
      /\| `STEP` \| N INTEGER \(implicit\), H DOUBLE PRECISION \(implicit\), .*\| `fortran\/STEP.f:4` \|/,
    );
    expect(en).toContain("## 5. PL/I procedure specifications");
    expect(en).toMatch(
      /\| 2 \| ` {2}R_EFF` \| `PIC'99999999'` \|  \|  \| `pli\/RATEREC.plinc:5` \|/,
    );
    expect(en).toMatch(
      /\| `RATEPOST.RATEIN` \| `RECORD INPUT` \| `RATEIN` \| OPEN, READ, CLOSE \|/,
    );
    expect(en).toMatch(
      /\| `RATEPOST` \| PL\/I \| U \| SQL UPDATE \| `POST_ONE` \| `pli\/RATEPOST.pli:42` \|/,
    );
    const ja = designDoc(index, { lang: "ja", poly }).markdown;
    expect(ja).toContain("## 4. FORTRAN プログラム単位仕様");
    expect(ja).toContain("### 4.2 COMMON ブロック対応表");
    expect(ja).toContain("## 5. PL/I 手続き仕様");
    expect(ja).toContain("### 5.2 構造体定義");
    const only = designDoc(index, { lang: "en", poly, sections: ["pli"] }).markdown;
    expect(only).toContain("## 1. PL/I procedure specifications");
    expect(only).not.toContain("FORTRAN program units");
  });
});
