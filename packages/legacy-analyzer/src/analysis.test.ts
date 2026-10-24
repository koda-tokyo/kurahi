import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { legacyDictionary, legacyImpact, legacyIndex, legacyQuery, legacyRules } from "./api.js";
import { resolveCacheDir, writeInCache } from "./cache.js";
import { buildIndex } from "./indexer.js";
import { runQuery } from "./query.js";
import { A, B, C, program, tmpTree } from "./test-fixtures/helpers.js";

const COPY = [
  C(" ORDREC - ORDER RECORD"),
  C(" ORD-QTY   QUANTITY ORDERED"),
  A("01  ORD-REC."),
  B("05 ORD-ID PIC X(6)."),
  B("05 ORD-QTY PIC 9(4)."),
  B("05 ORD-PRICE PIC 9(5)V99 COMP-3."),
  B("05 ORD-DATE PIC X(8)."),
  B("05 ORD-DATE-N REDEFINES ORD-DATE PIC 9(8)."),
  B("05 ORD-ITEMS OCCURS 5 TIMES."),
  B("   10 ORD-SKU PIC X(4)."),
].join("\n");

const WRITER = program("ORDCALC", {
  env: [A("INPUT-OUTPUT SECTION."), A("FILE-CONTROL."), B("SELECT ORD-OUT ASSIGN TO ORDOUT.")],
  data: [
    A("FILE SECTION."),
    A("FD  ORD-OUT."),
    B("COPY ORDREC."),
    A("WORKING-STORAGE SECTION."),
    A("01  WS-DISC-QTY PIC 9(4) VALUE 0100."),
    A("01  WS-AMOUNT PIC 9(9)V99."),
    A("01  WS-NET PIC 9(9)V99."),
  ],
  proc: [
    A("0000-MAIN."),
    B("OPEN OUTPUT ORD-OUT"),
    B("MOVE 12 TO ORD-QTY"),
    B("PERFORM 1000-PRICE"),
    B("WRITE ORD-REC"),
    B("CLOSE ORD-OUT"),
    B("STOP RUN."),
    A("1000-PRICE."),
    B("IF ORD-QTY > WS-DISC-QTY"),
    B("    COMPUTE WS-AMOUNT ROUNDED = ORD-QTY * ORD-PRICE * 0.95"),
    B("END-IF"),
    B("MOVE WS-AMOUNT TO WS-NET"),
    B("CALL 'ORDTAX' USING WS-NET."),
  ],
});

const TAX = program("ORDTAX", {
  data: [A("LINKAGE SECTION."), A("01  LK-NET PIC 9(9)V99.")],
  using: "LK-NET",
  proc: [A("0000-MAIN."), B("COMPUTE LK-NET = LK-NET * 1.10"), B("GOBACK.")],
});

const READER = program("ORDRPT", {
  env: [A("INPUT-OUTPUT SECTION."), A("FILE-CONTROL."), B("SELECT ORD-IN ASSIGN TO ORDIN.")],
  data: [
    A("FILE SECTION."),
    A("FD  ORD-IN."),
    B("COPY ORDREC."),
    A("WORKING-STORAGE SECTION."),
    A("01  WS-Q PIC 9(4)."),
  ],
  proc: [
    A("0000-MAIN."),
    B("OPEN INPUT ORD-IN"),
    B("READ ORD-IN"),
    B("MOVE ORD-QTY TO WS-Q"),
    B("CLOSE ORD-IN"),
    B("STOP RUN."),
  ],
});

const JOB = [
  "//ORDJOB   JOB (A),'ORDERS'",
  "//S1       EXEC PGM=ORDCALC",
  "//ORDOUT   DD DSN=PROD.ORDERS,DISP=(NEW,CATLG)",
  "//S2       EXEC PGM=ORDRPT",
  "//ORDIN    DD DSN=PROD.ORDERS,DISP=SHR",
].join("\n");

function project() {
  return tmpTree({
    "source/cobol/ORDCALC.cbl": WRITER,
    "source/cobol/ORDTAX.cbl": TAX,
    "source/cobol/ORDRPT.cbl": READER,
    "source/copybook/ORDREC.cpy": COPY,
    "source/jcl/ORDJOB.jcl": JOB,
    "output/.keep": "",
    "_answer-keys/SECRET.cbl": program("SECRET", { proc: [A("0000-MAIN."), B("STOP RUN.")] }),
  });
}

describe("queries", () => {
  const root = project();
  const idx = buildIndex(root);

  it("never reads the hidden answer-key folder", () => {
    expect(idx.programs.map((p) => p.name).toSorted()).toEqual(["ORDCALC", "ORDRPT", "ORDTAX"]);
    expect(idx.files.some((f) => f.path.includes("_answer-keys"))).toBe(false);
    expect(() => buildIndex(path.join(root, "_answer-keys"))).toThrow(/excluded/);
  });

  it("answers who calls X, what X calls and which steps run P", () => {
    const who = runQuery(idx, "callers", { name: "ORDTAX" }) as {
      calledBy: Array<{ program: string; line: number }>;
    };
    expect(who.calledBy.map((c) => c.program)).toEqual(["ORDCALC"]);
    const what = runQuery(idx, "callees", { name: "ORDCALC" }) as {
      calls: Array<{ target: string; resolved: boolean }>;
    };
    expect(what.calls).toMatchObject([{ target: "ORDTAX", resolved: true }]);
    const para = runQuery(idx, "callers", { name: "ORDCALC.1000-PRICE" }) as {
      performedBy: Array<{ paragraph: string }>;
    };
    expect(para.performedBy.map((p) => p.paragraph)).toEqual(["0000-MAIN"]);
    expect(runQuery(idx, "job-steps", { program: "ordrpt" })).toMatchObject([
      { job: "ORDJOB", step: "S2", line: 4 },
    ]);
  });

  it("finds the paragraphs that read or write a file, by FD, DD or data set name", () => {
    const byDsn = runQuery(idx, "file-access", { file: "PROD.ORDERS" }) as {
      readers: string[];
      writers: string[];
    };
    expect(byDsn.writers).toEqual(["ORDCALC.0000-MAIN"]);
    expect(byDsn.readers).toEqual(["ORDRPT.0000-MAIN"]);
    const byFd = runQuery(idx, "file-access", { file: "ORD-OUT", op: "WRITE" }) as {
      statements: Array<{ op: string; line: number }>;
    };
    expect(byFd.statements).toMatchObject([{ op: "WRITE" }]);
  });

  it("lists where a data item is set and used", () => {
    const r = runQuery(idx, "data-refs", { name: "ORD-QTY", program: "ORDCALC" }) as {
      sets: Array<{ paragraph: string; verb: string }>;
      uses: Array<{ paragraph: string; verb: string }>;
      definitions: Array<{ copybook?: string }>;
    };
    expect(r.definitions[0].copybook).toBe("ORDREC");
    expect(r.sets.map((s) => `${s.paragraph}:${s.verb}`)).toEqual(["0000-MAIN:MOVE"]);
    expect(r.uses.map((s) => `${s.paragraph}:${s.verb}`)).toEqual([
      "1000-PRICE:IF",
      "1000-PRICE:COMPUTE",
    ]);
  });

  it("follows the impact of a change through storage, data flow, CALL USING and data sets", () => {
    const root2 = project();
    const env = { stateDir: path.join(root2, "state") };
    const imp = legacyImpact(root2, "ORD-QTY", "ORDCALC", env);
    const items = imp.affectedItems.map((a) => `${a.program}.${a.item}:${a.reason}`);
    expect(items).toContain("ORDCALC.WS-AMOUNT:data flow");
    expect(items).toContain("ORDCALC.WS-NET:data flow");
    expect(items).toContain("ORDTAX.LK-NET:CALL USING");
    expect(items).toContain("ORDRPT.ORD-QTY:same copybook field");
    expect(items).toContain("ORDRPT.WS-Q:data flow");
    expect(items).toContain("ORDCALC.ORD-REC:shared storage");
    expect(items.filter((i) => i.startsWith("ORDCALC.ORD-PRICE"))).toEqual([]);
    expect(imp.programs.toSorted()).toEqual(["ORDCALC", "ORDRPT", "ORDTAX"]);
    expect(imp.jobSteps.map((s) => s.step).toSorted()).toEqual(["S1", "S2"]);
    const date = legacyImpact(root2, "ORD-DATE", "ORDCALC", env);
    expect(date.affectedItems.map((a) => a.item)).toContain("ORD-DATE-N");
  });
});

describe("rules, dictionary and the tool API", () => {
  it("emits rule candidates with exact text, literals and named constants, without meaning", () => {
    const root = project();
    const env = { stateDir: path.join(root, "state") };
    const r = legacyRules(root, "ORDCALC", env);
    const cond = r.candidates.find((c) => c.kind === "condition");
    expect(cond).toMatchObject({
      expression: "IF ORD-QTY > WS-DISC-QTY",
      namedConstants: [{ name: "WS-DISC-QTY", value: "0100" }],
    });
    expect(cond?.source).toBe("IF ORD-QTY > WS-DISC-QTY");
    const rounding = r.candidates.find((c) => c.kind === "rounding");
    expect(rounding).toMatchObject({
      literals: ["0.95"],
      guards: ["IF ORD-QTY > WS-DISC-QTY"],
      rounded: true,
    });
    expect(r.candidates.find((c) => c.kind === "literal-assignment")?.expression).toBe(
      "MOVE 12 TO ORD-QTY",
    );
    expect(r.candidates.find((c) => c.kind === "constant")?.expression).toBe(
      "WS-DISC-QTY VALUE 0100",
    );
    for (const c of r.candidates) {
      expect(c.file).toMatch(/\.(cbl|cpy)$/);
      expect(c.line).toBeGreaterThan(0);
    }
  });

  it("builds a data dictionary with lengths, offsets and comment descriptions", () => {
    const root = project();
    const [d] = legacyDictionary(root, "ORDREC", { stateDir: path.join(root, "state") });
    expect(d.records).toEqual([{ name: "ORD-REC", length: 6 + 4 + 4 + 8 + 20 }]);
    const qty = d.entries.find((e) => e.name === "ORD-QTY");
    expect(qty).toMatchObject({
      pic: "9(4)",
      usage: "DISPLAY",
      length: 4,
      offset: 6,
      start: 7,
      end: 10,
      description: "QUANTITY ORDERED",
      line: 5,
    });
    expect(d.entries.find((e) => e.name === "ORD-PRICE")).toMatchObject({
      usage: "COMP-3",
      length: 4,
    });
    expect(d.entries.find((e) => e.name === "ORD-SKU")).toMatchObject({ offset: 22, length: 4 });
    expect(d.entries.find((e) => e.name === "ORD-ITEMS")).toMatchObject({
      occurs: 5,
      length: 4,
      totalLength: 20,
    });
  });

  it("caches the index only under the project's output/.legacy-index", () => {
    const root = project();
    const env = { stateDir: path.join(root, "state") };
    const s = legacyIndex(path.join(root, "source"), env);
    expect(s.cacheFile.startsWith(path.join(root, "output", ".legacy-index") + path.sep)).toBe(
      true,
    );
    expect(fs.existsSync(path.join(root, "state"))).toBe(false);
    expect(s.counts).toMatchObject({ programs: 3, calls: 1, staticCalls: 1 });
    // A second query reuses the cache; a changed source file is picked up.
    expect((legacyQuery(path.join(root, "source"), "programs", {}, env) as unknown[]).length).toBe(
      3,
    );
    fs.appendFileSync(
      path.join(root, "source/cobol/ORDTAX.cbl"),
      `${program("ORDNEW", { proc: [A("0000-MAIN."), B("GOBACK.")] })}\n`,
    );
    expect((legacyQuery(path.join(root, "source"), "programs", {}, env) as unknown[]).length).toBe(
      4,
    );
  });

  it("falls back to the state directory and refuses writes outside the cache folder", () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-bare-"));
    const state = path.join(bare, "state");
    expect(resolveCacheDir(path.join(bare, "a", "b", "c"), state)).toBe(
      path.join(state, "legacy-index"),
    );
    expect(() => writeInCache(path.join(bare, "cache"), "../escape.json", "{}")).toThrow(/outside/);
    expect(fs.existsSync(path.join(bare, "escape.json"))).toBe(false);
  });

  it("rejects unknown query kinds with the list of known ones", () => {
    const root = project();
    expect(() => legacyQuery(root, "nope", {}, { stateDir: path.join(root, "state") })).toThrow(
      /Known kinds/,
    );
  });
});
