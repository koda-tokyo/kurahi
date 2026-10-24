import { describe, expect, it } from "vitest";
import { RATEPOST_PLI, RATEREC_PLI } from "../test-fixtures/sci-batch.js";
import { parsePliFile } from "./pli-parser.js";
import { analysePli } from "./pli-resolve.js";
import { pliStatements } from "./pli-source.js";

const member = parsePliFile("pli/RATEREC.plinc", RATEREC_PLI);
const include = (name: string) => (name === "RATEREC" ? member : null);
const analyse = (text = RATEPOST_PLI) =>
  analysePli([parsePliFile("pli/RATEPOST.pli", text), member], include);
const a = analyse();
const main = a.procs.find((p) => p.qualified === "RATEPOST");

describe("PL/I source", () => {
  it("splits statements at ';', drops comments and keeps the line of each part", () => {
    const { stmts, comments } = pliStatements(RATEPOST_PLI);
    expect(comments[0]).toMatchObject({ line: 1, text: expect.stringMatching(/^RATEPOST: POST/) });
    expect(stmts[0]).toMatchObject({ text: "RATEPOST: PROCEDURE OPTIONS(MAIN)", line: 2 });
    const sel = stmts.find((s) => s.text.startsWith("EXEC SQL SELECT"));
    expect(sel).toMatchObject({ line: 38, endLine: 39 });
    expect(sel?.text).toContain(":WS_BAL FROM ACCOUNT");
  });

  it("ignores sequence numbers in columns 73-80", () => {
    const seq = (s: string, n: number) => ` ${s}`.padEnd(72) + String(n).padStart(8, "0");
    const src = [seq("P: PROC OPTIONS(MAIN);", 10), seq("  CALL Q;", 20), seq("END P;", 30)].join(
      "\n",
    );
    const f = parsePliFile("p.pli", src);
    expect(f.margins).toBe(true);
    expect(f.procs[0]).toMatchObject({ name: "P", main: true, endLine: 3 });
    expect(f.procs[0].calls.map((c) => c.name)).toEqual(["Q"]);
  });
});

describe("PL/I engine", () => {
  it("reads procedures, nesting, MAIN and the comment above as purpose", () => {
    expect(a.procs.map((p) => `${p.qualified} ${p.main} ${p.file}:${p.line}-${p.endLine}`)).toEqual(
      ["RATEPOST true pli/RATEPOST.pli:2-51", "RATEPOST.POST_ONE false pli/RATEPOST.pli:37-49"],
    );
    expect(main?.doc).toBe("RATEPOST: POST THE MONTHLY RATES OF THE RATE FILE TO ACCOUNT");
  });

  it("reads DECLARE structures with levels, attributes, storage and the member's own line", () => {
    const decl = (n: string) => main?.decls.find((d) => d.name === n);
    expect(decl("WS_BAL")).toMatchObject({ level: 1, type: "FIXED DEC(11,2)", line: 8 });
    expect(decl("NREAD")).toMatchObject({ type: "FIXED BIN(31)", init: "0", line: 7 });
    expect(decl("NPOST")).toMatchObject({ type: "FIXED BIN(31)", init: "0", line: 7 });
    expect(decl("HIST")).toMatchObject({ storage: ["BASED(P)"], line: 10 });
    expect(decl("H_AMT")).toMatchObject({ level: 2, path: ["HIST", "H_AMT"], line: 12 });
    expect(decl("R_KEY")).toMatchObject({ type: "CHAR(10)", storage: ["DEFINED(R_ACCT)"] });
    expect(decl("R_EFF")).toMatchObject({
      type: "PIC'99999999'",
      path: ["RATE_REC", "R_EFF"],
      file: "pli/RATEREC.plinc",
      line: 5,
      via: "pli/RATEREC.plinc",
    });
    expect(
      a.structures.map((s) => `${s.root.name}: ${s.members.map((m) => m.name).join(" ")}`),
    ).toEqual(["HIST: H_ACCT H_AMT", "RATE_REC: R_ACCT R_RATE R_EFF R_FILLER"]);
    expect(main?.files.map((f) => `${f.name} ${f.attrs.join(" ")} ${f.line}`)).toEqual([
      "RATEIN RECORD INPUT 4",
      "RPTOUT STREAM OUTPUT PRINT 5",
    ]);
    expect(main?.entries).toEqual([
      { file: "pli/RATEPOST.pli", line: 14, name: "LOGERR", external: true },
    ]);
    expect(a.includes).toEqual([
      {
        file: "pli/RATEPOST.pli",
        line: 3,
        proc: "RATEPOST",
        name: "RATEREC",
        resolved: "pli/RATEREC.plinc",
      },
    ]);
  });

  it("resolves CALL edges: internal procedures, declared entries, the rest unresolved", () => {
    expect(a.calls.map((c) => `${c.from} -> ${c.to} [${c.resolution}] ${c.line}`)).toEqual([
      "RATEPOST -> LOGERR [declared ENTRY] 21",
      "RATEPOST -> RATEPOST.POST_ONE [internal] 28",
      "RATEPOST.POST_ONE -> LOGERR [declared ENTRY] 48",
    ]);
    const two = analysePli([
      parsePliFile("a.pli", "A: PROC OPTIONS(MAIN); CALL B; CALL C; END A;"),
      parsePliFile("b.pli", "B: PROC; END B;"),
    ]);
    expect(two.calls.map((c) => `${c.to} ${c.resolution}`)).toEqual([
      "B external procedure",
      "C not in the PL/I sources",
    ]);
  });

  it("reads file I/O, EXEC SQL tables per procedure and ON-units", () => {
    expect(a.fileUses.map((u) => `${u.proc} ${u.verb} ${u.fileName} dd=${u.dd} ${u.line}`)).toEqual(
      [
        "RATEPOST OPEN RATEIN dd=RATEIN 24",
        "RATEPOST OPEN RPTOUT dd=RPTOUT 24",
        "RATEPOST READ RATEIN dd=RATEIN 25",
        "RATEPOST READ RATEIN dd=RATEIN 29",
        "RATEPOST PUT RPTOUT dd=RPTOUT 34",
        "RATEPOST CLOSE RATEIN dd=RATEIN 35",
        "RATEPOST CLOSE RPTOUT dd=RPTOUT 35",
      ],
    );
    expect(a.tableUses.map((t) => `${t.proc} ${t.op} ${t.table} ${t.line}`)).toEqual([
      "RATEPOST.POST_ONE SELECT ACCOUNT 38",
      "RATEPOST.POST_ONE UPDATE ACCOUNT 42",
      "RATEPOST.POST_ONE INSERT RATE_HIST 44",
    ]);
    expect(
      main?.onUnits.map((o) => `${o.condition}(${o.target ?? ""}) ${o.action} ${o.line}`),
    ).toEqual(["ENDFILE(RATEIN) EOF = '1'B 19", "ERROR() BEGIN block 20"]);
    const titled = analysePli([
      parsePliFile(
        "t.pli",
        "T: PROC OPTIONS(MAIN); DCL F FILE RECORD OUTPUT; OPEN FILE(F) TITLE('OUTDD') OUTPUT;\n WRITE FILE(F) FROM(R); EXEC SQL DECLARE C1 CURSOR FOR SELECT A FROM X.T1; END T;",
      ),
    ]);
    expect(titled.fileUses.map((u) => `${u.verb} ${u.dd}`)).toEqual(["OPEN OUTDD", "WRITE OUTDD"]);
    expect(titled.tableUses.map((t) => `${t.op} ${t.table}`)).toEqual(["DECLARE T1"]);
  });

  it("reports macros and other constructs it does not model", () => {
    expect(a.gaps.map((g) => `${g.line} ${g.construct}`)).toEqual([
      "15 macro preprocessor",
      "16 macro preprocessor",
      "31 macro preprocessor",
      "33 macro preprocessor",
    ]);
    const odd = parsePliFile(
      "o.pli",
      [
        "O: PROC OPTIONS(MAIN);",
        "  FETCH SUBX;",
        "  E2: ENTRY(X);",
        "  EXEC SQL INCLUDE MYDCL;",
        "  EXEC SQL PREPARE S1 FROM :TXT;",
        "  EXEC CICS RETURN;",
        "  DO I = 1 TO 3;",
      ].join("\n"),
    );
    expect(odd.gaps.map((g) => g.construct)).toEqual([
      "unterminated procedure",
      "dynamic load",
      "ENTRY",
      "EXEC SQL INCLUDE",
      "dynamic SQL",
      "EXEC CICS",
    ]);
  });

  it("is deterministic and never throws on truncated sources", () => {
    expect(JSON.stringify(analyse())).toBe(JSON.stringify(a));
    for (let i = 0; i < RATEPOST_PLI.length; i += 5) {
      expect(() =>
        analysePli(
          [
            parsePliFile("a.pli", RATEPOST_PLI.slice(0, i)),
            parsePliFile("b.pli", RATEPOST_PLI.slice(i)),
          ],
          include,
        ),
      ).not.toThrow();
    }
  });
});
