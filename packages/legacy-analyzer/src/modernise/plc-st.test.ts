import { describe, expect, it } from "vitest";
import { analysePlc, parsePlcFile, plcTokens } from "./plc-st.js";

// Fictional plant: a bottling line with one conveyor and a filler.
const GLOBALS = `CONFIGURATION Plant
  RESOURCE Cpu ON PLC
    VAR_GLOBAL
      EStop AT %IX0.0 : BOOL;        (* emergency stop, NC *)
      LineRun AT %QX0.0 : BOOL := FALSE;
      Recipe : RecipeT;
    END_VAR
    TASK Main (INTERVAL := T#10ms, PRIORITY := 1);
    PROGRAM Line WITH Main : LineCtl;
  END_RESOURCE
END_CONFIGURATION

TYPE
  RecipeT : STRUCT
    FillMl : INT := 500;
    Speed  : REAL;
  END_STRUCT;
  FillState : (IDLE, FILLING, DONE);
  Ml : INT;
END_TYPE
`;

const CONVEYOR = `(* Conveyor drive with start delay *)
FUNCTION_BLOCK Conveyor
VAR_INPUT
  Start, Stop : BOOL;
END_VAR
VAR_OUTPUT
  Drive : BOOL;
END_VAR
VAR
  Delay : TON;
  Name : STRING(20) := 'it''s (* not *) a comment';
END_VAR
Delay(IN := Start AND NOT Stop, PT := T#2s);
IF Delay.Q THEN
  Drive := TRUE; // run
ELSIF (Stop) THEN
  Drive := FALSE;
END_IF;
END_FUNCTION_BLOCK

FUNCTION Scale : REAL
VAR_INPUT
  Raw : INT;
END_VAR
Scale := INT_TO_REAL(Raw) / 27648.0 * 100.0;
END_FUNCTION
`;

const LINE = `PROGRAM LineCtl
VAR_EXTERNAL
  EStop : BOOL;
  LineRun : BOOL;
END_VAR
VAR
  Belt : Conveyor;
  Level AT %IW64 : INT;
  Valve AT %QX0.1 : BOOL;
  Spare AT %QX0.1 : BOOL;
  Pct : REAL;
  Steps : ARRAY [1..10] OF FillState;
END_VAR
Belt(Start := LineRun, Stop := EStop);
Pct := Scale(Level);
Valve := Belt.Drive AND Pct < 95.0;
END_PROGRAM

FUNCTION_BLOCK Filler EXTENDS Conveyor IMPLEMENTS IFill, IClean
METHOD Prime : BOOL
  Prime := TRUE;
END_METHOD
END_FUNCTION_BLOCK
`;

const files = [
  parsePlcFile("plc/line/Line.st", LINE),
  parsePlcFile("plc/lib/Conveyor.st", CONVEYOR),
  parsePlcFile("plc/Plant.st", GLOBALS),
];
const a = analysePlc(files);
const pou = (name: string) => a.pous.find((p) => p.name === name);

describe("Structured Text tokens", () => {
  it("drops comments but not comment marks inside strings, and keeps lines", () => {
    const { toks, comments } = plcTokens(CONVEYOR);
    expect(comments.map((c) => [c.line, c.text])).toEqual([
      [1, "Conveyor drive with start delay"],
      [15, "run"],
    ]);
    expect(toks.find((t) => t.kind === "str")).toMatchObject({ line: 11 });
    expect(toks.find((t) => t.value === "T#2s")).toMatchObject({ kind: "num", line: 13 });
  });

  it("reports an unclosed comment as a gap", () => {
    const f = parsePlcFile("x.st", "PROGRAM P\n(* open\nX := 1;\n");
    expect(f.gaps.map((g) => `${g.line} ${g.construct}`)).toEqual(["2 comment", "1 PROGRAM"]);
  });
});

describe("PLC engine", () => {
  it("reads POUs with kind, lines, purpose, result type and inheritance", () => {
    expect(a.pous.map((p) => `${p.kind} ${p.name} ${p.file}:${p.line}-${p.endLine}`)).toEqual([
      "FUNCTION_BLOCK CONVEYOR plc/lib/Conveyor.st:2-19",
      "FUNCTION SCALE plc/lib/Conveyor.st:21-26",
      "PROGRAM LINECTL plc/line/Line.st:1-17",
      "FUNCTION_BLOCK FILLER plc/line/Line.st:19-23",
    ]);
    expect(pou("CONVEYOR")?.doc).toBe("Conveyor drive with start delay");
    expect(pou("SCALE")?.returns).toBe("REAL");
    expect(pou("FILLER")).toMatchObject({ extends: "CONVEYOR", implements: ["IFILL", "ICLEAN"] });
  });

  it("reads declarations per section with type, address and initial value", () => {
    const vars = pou("CONVEYOR")!.vars.map((v) => `${v.section} ${v.name}:${v.type} @${v.line}`);
    expect(vars).toEqual([
      "VAR_INPUT START:BOOL @4",
      "VAR_INPUT STOP:BOOL @4",
      "VAR_OUTPUT DRIVE:BOOL @7",
      "VAR DELAY:TON @10",
      "VAR NAME:STRING(20) @11",
    ]);
    const steps = pou("LINECTL")!.vars.find((v) => v.name === "STEPS");
    expect(steps?.type).toBe("ARRAY [1..10] OF FillState");
    expect(a.globals.find((v) => v.name === "LINERUN")).toMatchObject({
      section: "VAR_GLOBAL",
      address: "%QX0.0",
      area: "output",
      init: "FALSE",
      line: 5,
    });
  });

  it("reads TYPE blocks as struct, enum and alias", () => {
    expect(a.types.map((t) => `${t.name} ${t.kind} ${t.line}-${t.endLine}`)).toEqual([
      "RECIPET struct 14-17",
      "FILLSTATE enum 18-18",
      "ML alias 19-19",
    ]);
  });

  it("separates instance calls from function calls and records assignments", () => {
    const line = pou("LINECTL")!;
    expect(
      line.calls.map((c) => `${c.kind} ${c.name}${c.type ? `:${c.type}` : ""} @${c.line}`),
    ).toEqual(["instance BELT:Conveyor @14", "function SCALE @15"]);
    expect(line.writes.map((w) => `${w.target} @${w.line}`)).toEqual(["PCT @15", "VALVE @16"]);
    const conv = pou("CONVEYOR")!;
    // IF / ELSIF followed by '(' are not calls; IN := and PT := are parameters, not writes.
    expect(conv.calls.map((c) => c.name)).toEqual(["DELAY"]);
    expect(conv.writes.map((w) => `${w.target} @${w.line}`)).toEqual(["DRIVE @15", "DRIVE @17"]);
    expect(pou("SCALE")!.calls.map((c) => `${c.kind} ${c.name}`)).toEqual(["function INT_TO_REAL"]);
  });

  it("builds the I/O map ordered by address and flags a shared address", () => {
    expect(
      a.io.map((p) => `${p.address} ${p.area} ${p.pou ?? "global"}.${p.name} ${p.file}:${p.line}`),
    ).toEqual([
      "%IW64 input LINECTL.LEVEL plc/line/Line.st:8",
      "%IX0.0 input global.ESTOP plc/Plant.st:4",
      "%QX0.0 output global.LINERUN plc/Plant.st:5",
      "%QX0.1 output LINECTL.VALVE plc/line/Line.st:9",
      "%QX0.1 output LINECTL.SPARE plc/line/Line.st:10",
    ]);
    expect(a.sharedAddresses).toEqual([
      {
        address: "%QX0.1",
        by: [
          { file: "plc/line/Line.st", line: 9 },
          { file: "plc/line/Line.st", line: 10 },
        ],
      },
    ]);
  });

  it("resolves instances to function blocks defined in another file", () => {
    expect(a.instances).toEqual([
      {
        file: "plc/line/Line.st",
        line: 14,
        pou: "LINECTL",
        instance: "BELT",
        type: "Conveyor",
        definedAt: { file: "plc/lib/Conveyor.st", line: 2 },
      },
    ]);
  });

  it("reports methods as gaps instead of guessing", () => {
    expect(a.gaps.map((g) => `${g.file}:${g.line} ${g.construct}`)).toEqual([
      "plc/line/Line.st:20 METHOD",
    ]);
  });

  it("is deterministic regardless of file order", () => {
    expect(analysePlc(files.toReversed())).toEqual(a);
  });
});
