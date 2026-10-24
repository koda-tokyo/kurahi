import { describe, expect, it } from "vitest";
import type { Statement } from "./types.js";
import { buildIndex } from "./indexer.js";
import { runQuery } from "./query.js";
import { A, B, program, tmpTree } from "./test-fixtures/helpers.js";

const MAIN = program("MAINPGM", {
  env: [
    A("INPUT-OUTPUT SECTION."),
    A("FILE-CONTROL."),
    B("SELECT IN-FILE ASSIGN TO UT-S-INFILE"),
    B("    ORGANIZATION IS SEQUENTIAL FILE STATUS IS WS-FS."),
    B("SELECT OUT-FILE ASSIGN TO 'OUTFILE'."),
  ],
  data: [
    A("FILE SECTION."),
    A("FD  IN-FILE."),
    A("01  IN-REC."),
    B("05 IN-AMT PIC 9(5)."),
    B("05 IN-KIND PIC X."),
    B("   88 KIND-GOLD VALUE 'G'."),
    A("FD  OUT-FILE."),
    A("01  OUT-REC PIC X(20)."),
    A("WORKING-STORAGE SECTION."),
    A("01  WS-FS PIC XX."),
    A("01  WS-EOF PIC X VALUE 'N'."),
    B("88 EOF VALUE 'Y'."),
    A("01  WS-LIMIT PIC 9(5) VALUE 1000."),
    A("01  WS-TOTAL PIC 9(7) VALUE ZERO."),
    A("01  WS-FEE PIC 9(5)V99."),
    A("01  WS-PGM PIC X(8) VALUE 'SUBDYN'."),
    A("01  WS-CNT PIC 9(3)."),
  ],
  proc: [
    A("0000-MAIN."),
    B("OPEN INPUT IN-FILE OUTPUT OUT-FILE"),
    B("PERFORM 1000-READ"),
    B("PERFORM 2000-CALC THRU 2999-EXIT UNTIL EOF"),
    B("CALL 'SUBPGM' USING WS-TOTAL WS-FEE"),
    B("CALL WS-PGM USING WS-TOTAL"),
    B("CLOSE IN-FILE OUT-FILE"),
    B("STOP RUN."),
    A("1000-READ."),
    B("READ IN-FILE"),
    B("    AT END SET EOF TO TRUE"),
    B("    NOT AT END ADD 1 TO WS-CNT"),
    B("END-READ."),
    A("2000-CALC."),
    B("IF IN-AMT > WS-LIMIT"),
    B("    IF KIND-GOLD"),
    B("        COMPUTE WS-FEE ROUNDED = IN-AMT * 0.015"),
    B("    ELSE"),
    B("        COMPUTE WS-FEE = IN-AMT * 0.02"),
    B("    END-IF"),
    B("ELSE"),
    B("    MOVE ZERO TO WS-FEE"),
    B("END-IF"),
    B("EVALUATE TRUE"),
    B("    WHEN IN-AMT < 100"),
    B("        MOVE 'S' TO OUT-REC"),
    B("    WHEN IN-AMT >= 100 AND IN-AMT < 500"),
    B("        MOVE 'M' TO OUT-REC"),
    B("    WHEN OTHER"),
    B("        MOVE 'L' TO OUT-REC"),
    B("END-EVALUATE"),
    B("ADD WS-FEE TO WS-TOTAL"),
    B("WRITE OUT-REC"),
    B("PERFORM 1000-READ."),
    A("2500-UNUSED."),
    B("EXEC SQL SELECT NAME, CITY INTO :WS-PGM, :WS-FS"),
    B("     FROM CUSTOMER C, ADDRESS A WHERE C.ID = :WS-CNT"),
    B("END-EXEC."),
    A("2999-EXIT."),
    B("EXIT."),
  ],
});

const SUB = program("SUBPGM", {
  data: [A("LINKAGE SECTION."), A("01  LK-TOTAL PIC 9(7)."), A("01  LK-FEE PIC 9(5)V99.")],
  using: "LK-TOTAL LK-FEE",
  proc: [A("0000-MAIN."), B("ADD LK-FEE TO LK-TOTAL"), B("GOBACK.")],
});

function index() {
  return buildIndex(tmpTree({ "src/MAINPGM.cbl": MAIN, "src/SUBPGM.cbl": SUB }));
}
const stmts = (p: { paragraphs: Array<{ name: string; statements: Statement[] }> }, para: string) =>
  p.paragraphs.find((x) => x.name === para)?.statements ?? [];

describe("procedure division", () => {
  const idx = index();
  const main = idx.programs.find((p) => p.name === "MAINPGM");
  if (!main) {
    throw new Error("MAINPGM not parsed");
  }

  it("finds programs, divisions, paragraphs and files", () => {
    expect(idx.programs.map((p) => p.name)).toEqual(["MAINPGM", "SUBPGM"]);
    expect(main.divisions.map((d) => d.name)).toEqual([
      "IDENTIFICATION",
      "ENVIRONMENT",
      "DATA",
      "PROCEDURE",
    ]);
    expect(main.paragraphs.map((p) => p.name)).toEqual([
      "0000-MAIN",
      "1000-READ",
      "2000-CALC",
      "2500-UNUSED",
      "2999-EXIT",
    ]);
    expect(main.files.map((f) => [f.name, f.assign, f.records])).toEqual([
      ["IN-FILE", "UT-S-INFILE", ["IN-REC"]],
      ["OUT-FILE", "OUTFILE", ["OUT-REC"]],
    ]);
    expect(idx.programs[1].usingParams).toEqual(["LK-TOTAL", "LK-FEE"]);
  });

  it("records PERFORM THRU/UNTIL and static and dynamic CALL USING", () => {
    const m = stmts(main, "0000-MAIN");
    expect(m.find((s) => s.performs?.thru)?.performs).toMatchObject({
      target: "2000-CALC",
      thru: "2999-EXIT",
      until: "EOF",
      inline: false,
    });
    const calls = m.filter((s) => s.call).map((s) => s.call);
    expect(calls).toEqual([
      { target: "SUBPGM", dynamic: false, using: ["WS-TOTAL", "WS-FEE"] },
      { target: "WS-PGM", dynamic: true, using: ["WS-TOTAL"] },
    ]);
    expect(
      m.filter((s) => s.io).map((s) => `${s.io?.op} ${s.io?.file} ${s.io?.mode ?? ""}`.trim()),
    ).toEqual(["OPEN IN-FILE INPUT", "OPEN OUT-FILE OUTPUT", "CLOSE IN-FILE", "CLOSE OUT-FILE"]);
  });

  it("guards statements with nested IF/ELSE, EVALUATE WHEN and AT END phrases", () => {
    const c = stmts(main, "2000-CALC");
    const fee = c.filter((s) => s.verb === "COMPUTE");
    const roundedLine = MAIN.split("\n").findIndex((l) => l.includes("ROUNDED")) + 1;
    expect(fee[0]).toMatchObject({
      rounded: true,
      line: roundedLine,
      guards: ["IF IN-AMT > WS-LIMIT", "IF KIND-GOLD"],
    });
    expect(fee[1].guards).toEqual(["IF IN-AMT > WS-LIMIT", "ELSE OF IF KIND-GOLD"]);
    expect(c.find((s) => s.code === "MOVE ZERO TO WS-FEE")?.guards).toEqual([
      "ELSE OF IF IN-AMT > WS-LIMIT",
    ]);
    const whens = c.filter((s) => s.verb === "WHEN");
    expect(whens.map((w) => w.condition)).toEqual([
      "EVALUATE TRUE WHEN IN-AMT < 100",
      "EVALUATE TRUE WHEN IN-AMT >= 100 AND IN-AMT < 500",
      "EVALUATE TRUE WHEN OTHER",
    ]);
    expect(whens[1].guards).toEqual(["EVALUATE TRUE"]);
    expect(c.find((s) => s.code === "MOVE 'M' TO OUT-REC")?.guards).toEqual([
      "EVALUATE TRUE WHEN IN-AMT >= 100 AND IN-AMT < 500",
    ]);
    // After END-EVALUATE nothing guards the ADD.
    expect(c.find((s) => s.verb === "ADD")?.guards).toEqual([]);
    const r = stmts(main, "1000-READ");
    expect(r.map((s) => [s.verb, s.guards.join(" > ")])).toEqual([
      ["READ", ""],
      ["SET", "AT END OF READ IN-FILE"],
      ["ADD", "NOT AT END OF READ IN-FILE"],
    ]);
  });

  it("records what each statement sets and uses", () => {
    const c = stmts(main, "2000-CALC");
    expect(c.find((s) => s.verb === "ADD")).toMatchObject({ sets: ["WS-TOTAL"], uses: ["WS-FEE"] });
    expect(c.find((s) => s.verb === "COMPUTE")).toMatchObject({
      sets: ["WS-FEE"],
      uses: ["IN-AMT"],
      literals: ["0.015"],
    });
    expect(c.find((s) => s.verb === "IF" && s.condition === "KIND-GOLD")?.uses).toEqual([
      "KIND-GOLD",
    ]);
    const read = stmts(main, "1000-READ");
    expect(read[0].sets).toEqual(["IN-REC"]);
    expect(read[1].sets).toEqual(["EOF", "WS-EOF"]);
    const w = c.find((s) => s.verb === "WRITE");
    expect(w?.io).toEqual({ op: "WRITE", file: "OUT-FILE", record: "OUT-REC" });
  });

  it("extracts EXEC SQL tables and host variables", () => {
    const sql = stmts(main, "2500-UNUSED")[0];
    expect(sql.sql).toEqual({
      tables: ["CUSTOMER", "ADDRESS"],
      ops: ["SELECT"],
      hostVars: ["WS-PGM", "WS-FS", "WS-CNT"],
    });
    expect(sql.sets).toEqual(["WS-PGM", "WS-FS"]);
    expect(sql.uses).toEqual(["WS-CNT"]);
  });

  it("quotes the exact source lines of a statement", () => {
    const sql = stmts(main, "2500-UNUSED")[0];
    expect(sql.text.split("\n")).toHaveLength(3);
    expect(sql.text).toContain("FROM CUSTOMER C, ADDRESS A");
  });
});

export { MAIN, SUB };

describe("scope without terminators", () => {
  it("pairs ELSE with the nearest IF and closes every scope at the period", () => {
    const src = program("NESTED", {
      data: [
        A("WORKING-STORAGE SECTION."),
        A("01  A PIC 9."),
        A("01  B PIC 9."),
        A("01  C PIC 9."),
      ],
      proc: [
        A("0000-MAIN."),
        B("IF A = 1"),
        B("    IF B = 2"),
        B("        MOVE 1 TO C"),
        B("    ELSE"),
        B("        MOVE 2 TO C."),
        B("MOVE 3 TO C"),
        B("PERFORM 1000-X THROUGH 3000-Z."),
        A("1000-X."),
        B("EXIT."),
        A("2000-Y."),
        B("EXIT."),
        A("3000-Z."),
        B("EXIT."),
      ],
    });
    const idx = buildIndex(tmpTree({ "NESTED.cbl": src }));
    const st = idx.programs[0].paragraphs[0].statements.filter((s) => s.verb === "MOVE");
    expect(st.map((s) => s.guards)).toEqual([
      ["IF A = 1", "IF B = 2"],
      ["IF A = 1", "ELSE OF IF B = 2"],
      [],
    ]);
    const edges = runQuery(idx, "perform-graph", { program: "NESTED" }) as Array<{
      to: string;
      kind: string;
    }>;
    expect(edges.map((e) => `${e.to}:${e.kind}`)).toEqual([
      "1000-X:PERFORM THRU",
      "2000-Y:PERFORM THRU",
      "3000-Z:PERFORM THRU",
    ]);
  });
});
