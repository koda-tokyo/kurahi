import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyBaselineAdvance, legacyChanges } from "./api.js";
import { resolveCacheDir } from "./cache.js";
import { snapshotFile } from "./changes.js";
import { A, B, program, tmpTree } from "./test-fixtures/helpers.js";

const CALC = (extra: string[] = []) =>
  program("ORDCALC", {
    data: [A("WORKING-STORAGE SECTION."), A("01  WS-NET PIC 9(9)V99.")],
    proc: [
      A("0000-MAIN."),
      B("PERFORM 1000-PRICE"),
      B("STOP RUN."),
      A("1000-PRICE."),
      B("COMPUTE WS-NET = WS-NET * 1.10"),
      B("EXEC SQL SELECT QTY INTO :WS-NET FROM ORDERS END-EXEC."),
      ...extra,
    ],
  });
const TAX = program("ORDTAX", {
  proc: [A("0000-MAIN."), B("GOBACK.")],
});
const JOB = ["//ORDJOB   JOB (A),'ORDERS'", "//S1       EXEC PGM=ORDCALC"].join("\n");
const DDL = (qtyType = "INTEGER", extra = "") =>
  [
    "CREATE TABLE ORDERS (",
    "  ORD_ID CHAR(6) NOT NULL PRIMARY KEY,",
    `  QTY ${qtyType}${extra}`,
    ");",
  ].join("\n");

function project(files: Record<string, string> = {}) {
  return tmpTree({
    "source/cobol/ORDCALC.cbl": CALC(),
    "source/jcl/ORDJOB.jcl": JOB,
    "source/ddl/orders.sql": DDL(),
    "output/.keep": "",
    ...files,
  });
}

const fixed = (iso: string) => () => new Date(iso);

function write(root: string, rel: string, content: string) {
  const abs = path.join(root, "source", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, `${content}\n`);
}

function run(root: string, limit?: number) {
  return legacyChanges(
    path.join(root, "source"),
    { limit },
    { stateDir: path.join(root, "state"), now: fixed("2026-10-25T01:30:00Z") },
  );
}

function advance(root: string, opts: { snapshot?: string; rebuild?: boolean } = {}) {
  return legacyBaselineAdvance(path.join(root, "source"), opts, {
    stateDir: path.join(root, "state"),
    now: fixed("2026-10-25T01:31:00Z"),
  });
}

describe("legacy changes against a baseline", () => {
  it("creates the baseline on the first run and reports no change", () => {
    const root = project();
    const first = run(root);
    expect(first.status).toBe("baseline_created");
    expect(first.totals).toMatchObject({ program: 1, job: 1, table: 1, column: 2, edges: 3 });
    expect(first).not.toHaveProperty("changes");
    // In the project's analyser cache, never in the sources.
    const cache = resolveCacheDir(path.join(root, "source"), path.join(root, "state"));
    expect(cache).toBe(path.join(root, "output", ".legacy-index"));
    expect(fs.existsSync(snapshotFile(cache, path.join(root, "source"), "baseline"))).toBe(true);
    expect(fs.readdirSync(path.join(root, "source")).toSorted()).toEqual(["cobol", "ddl", "jcl"]);
    const again = run(root);
    expect(again.status).toBe("unchanged");
    expect(again).toMatchObject({ total: 0, changes: [], edges: [] });
  });

  it("reports added, removed and changed programs and edges with path:line evidence", () => {
    const root = project({ "source/cobol/ORDTAX.cbl": TAX });
    run(root);
    // ORDCALC gains a paragraph and a CALL to the new ORDNEW; ORDTAX is removed.
    write(root, "cobol/ORDCALC.cbl", CALC([A("2000-NEW."), B("CALL 'ORDNEW'.")]));
    write(root, "cobol/ORDNEW.cbl", program("ORDNEW", { proc: [A("0000-MAIN."), B("GOBACK.")] }));
    fs.rmSync(path.join(root, "source", "cobol", "ORDTAX.cbl"));
    const out = run(root);
    if (out.status !== "changed") {
      throw new Error(`expected changes, got ${out.status}`);
    }
    expect(out.added).toEqual({ program: 1 });
    expect(out.removed).toEqual({ program: 1 });
    expect(out.changed).toEqual({ program: 1 });
    expect(out.edgesAdded).toEqual({ CALL: 1 });
    const programs = out.changes.filter((c) => c.kind === "program");
    // Fixed order: added, removed, changed.
    expect(programs.map((c) => [c.change, c.name])).toEqual([
      ["added", "ORDNEW"],
      ["removed", "ORDTAX"],
      ["changed", "ORDCALC"],
    ]);
    expect(programs[0].evidence).toBe("cobol/ORDNEW.cbl:1");
    expect(programs[0].impact?.callers).toEqual(["ORDCALC"]);
    expect(programs[1].evidence).toBe("cobol/ORDTAX.cbl:1 (baseline)");
    expect(programs[2].detail).toContain("+paragraphs 2000-NEW");
    expect(programs[2].impact).toEqual({
      callers: [],
      steps: ["ORDJOB.S1"],
      tables: ["ORDERS (SELECT)"],
    });
    const call = out.edges.find((e) => e.kind === "CALL");
    expect(call).toMatchObject({ change: "added", from: "ORDCALC", to: "ORDNEW" });
    expect(call?.evidence).toMatch(/^cobol\/ORDCALC\.cbl:\d+$/);
    const line = Number(call?.evidence.split(":")[1]);
    const src = fs.readFileSync(path.join(root, "source", "cobol", "ORDCALC.cbl"), "utf8");
    expect(src.split("\n")[line - 1]).toContain("CALL 'ORDNEW'");
  });

  it("reports table and column changes", () => {
    const root = project();
    run(root);
    write(root, "ddl/orders.sql", DDL("DECIMAL(9,2)", ",\n  NOTE VARCHAR(40)"));
    const out = run(root);
    if (out.status !== "changed") {
      throw new Error(`expected changes, got ${out.status}`);
    }
    expect(out.changed).toEqual({ table: 1, column: 1 });
    expect(out.added).toEqual({ column: 1 });
    const rows = out.changes.map((c) => [c.change, c.kind, c.name, c.evidence]);
    expect(rows).toEqual([
      ["changed", "table", "ORDERS", "ddl/orders.sql:1"],
      ["added", "column", "ORDERS.NOTE", "ddl/orders.sql:4"],
      ["changed", "column", "ORDERS.QTY", "ddl/orders.sql:3"],
    ]);
    expect(out.changes[0].detail).toContain("+columns NOTE");
  });

  it("reports a stored routine whose body changed", () => {
    const proc = (factor: string) =>
      [
        "CREATE PROCEDURE RAISE_QTY (IN P_ID CHAR(6))",
        "LANGUAGE SQL",
        "BEGIN",
        `  UPDATE ORDERS SET QTY = QTY * ${factor} WHERE ORD_ID = P_ID;`,
        "END;",
      ].join("\n");
    const root = project({ "source/ddl/proc.sql": proc("2") });
    expect(run(root).totals.routine).toBe(1);
    write(root, "ddl/proc.sql", proc("3"));
    const out = run(root);
    expect(out.status === "changed" && out.changes).toEqual([
      {
        change: "changed",
        kind: "routine",
        name: "RAISE_QTY",
        evidence: "ddl/proc.sql:1",
        detail: "content changed",
      },
    ]);
  });

  it("ignores pure line shifts and comments", () => {
    const root = project();
    run(root);
    write(root, "ddl/orders.sql", `-- orders table\n\n${DDL()}`);
    expect(run(root).status).toBe("unchanged");
  });

  it("bounds the lists, keeps complete counts, and is deterministic", () => {
    const root = project();
    run(root);
    for (const n of [1, 2, 3, 4, 5]) {
      write(
        root,
        `cobol/NEW${n}.cbl`,
        program(`NEW${n}`, { proc: [A("0000-MAIN."), B("GOBACK.")] }),
      );
    }
    const a = run(root, 2);
    const b = run(root, 2);
    if (a.status !== "changed") {
      throw new Error("expected changes");
    }
    expect(a.added).toEqual({ program: 5 });
    expect(a.changes.map((c) => c.name)).toEqual(["NEW1", "NEW2"]);
    expect(a.omitted).toEqual({ changes: 3, edges: 0 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });
});

describe("legacy baseline advance", () => {
  it("promotes the compared snapshot, so the next run compares against it", () => {
    const root = project();
    run(root);
    write(root, "cobol/ORDTAX.cbl", TAX);
    const changed = run(root);
    expect(changed.status).toBe("changed");
    const adv = advance(root, { snapshot: changed.current.digest });
    expect(adv.status).toBe("advanced");
    expect(adv.baseline.digest).toBe(changed.current.digest);
    expect(run(root).status).toBe("unchanged");
  });

  it("advances to what was compared, not to sources that changed since", () => {
    const root = project();
    run(root);
    write(root, "cobol/ORDTAX.cbl", TAX);
    run(root);
    // A change lands between the comparison and the advance: still reported next time.
    write(root, "cobol/LATE.cbl", program("LATE", { proc: [A("0000-MAIN."), B("GOBACK.")] }));
    advance(root);
    const next = run(root);
    expect(next.status).toBe("changed");
    expect(next.status === "changed" && next.changes.map((c) => c.name)).toEqual(["LATE"]);
  });

  it("refuses a stale snapshot digest and a missing comparison; rebuild resets", () => {
    const root = project();
    expect(() => advance(root)).toThrow(/run legacy_changes first/);
    run(root);
    expect(() => advance(root, { snapshot: "0000000000000000" })).toThrow(
      /legacy_changes ran again/,
    );
    write(root, "cobol/ORDTAX.cbl", TAX);
    const reset = advance(root, { rebuild: true });
    expect(reset.status).toBe("advanced");
    expect(reset.totals.program).toBe(2);
    expect(run(root).status).toBe("unchanged");
  });
});
