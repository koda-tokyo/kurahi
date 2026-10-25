import { describe, expect, it } from "vitest";
import { designDoc } from "../design-doc.js";
import { buildIndex } from "../indexer.js";
import { namedTree, uncitedFactLines } from "../test-fixtures/doc-check.js";
import { inventory, modernisePlanFor } from "./api.js";
import { analyseProject } from "./project.js";

const FILES = {
  "plc/line1/Conveyor.st": [
    "FUNCTION_BLOCK CONVEYOR",
    "VAR_INPUT start : BOOL; END_VAR",
    "VAR_OUTPUT run : BOOL; END_VAR",
    "run := start;",
    "END_FUNCTION_BLOCK",
  ].join("\n"),
  "plc/line1/Main.st": [
    "PROGRAM MAIN",
    "VAR",
    "  StartPb AT %IX0.0 : BOOL;",
    "  Motor AT %QX0.0 : BOOL;",
    "  Belt : Conveyor;",
    "END_VAR",
    "Belt(start := StartPb);",
    "Motor := Belt.run;",
    "END_PROGRAM",
  ].join("\n"),
  "plc/globals.txt": [
    "VAR_GLOBAL",
    "  Estop AT %IX0.0 : BOOL;",
    "END_VAR",
    "FUNCTION_BLOCK SPARE",
    "END_FUNCTION_BLOCK",
  ].join("\n"),
  "plc/export/Line1.xml":
    '<?xml version="1.0"?>\n<project xmlns="http://www.plcopen.org/xml/tc6_0201"></project>',
  "plc/export/Line1.L5X": "<RSLogix5000Content></RSLogix5000Content>",
};

const index = buildIndex(namedTree("plant-plc", FILES));
const poly = analyseProject(index);

describe("PLC engine in the project", () => {
  it("reads Structured Text and PLCopen XML, and counts vendor exports without reading them", () => {
    expect(poly.plc.files).toEqual([
      "plc/export/Line1.xml",
      "plc/globals.txt",
      "plc/line1/Conveyor.st",
      "plc/line1/Main.st",
    ]);
    expect(poly.plcExports).toEqual(["plc/export/Line1.L5X"]);
    expect(poly.plc.instances.map((i) => `${i.pou} ${i.instance}:${i.type}`)).toEqual([
      "MAIN BELT:Conveyor",
    ]);
    expect(poly.plc.sharedAddresses.map((s) => s.address)).toEqual(["%IX0.0"]);
  });

  it("reports PLC as active in the plan, with inventory and coverage", () => {
    const plan = modernisePlanFor(index);
    const plc = plan.languages.find((l) => l.id === "plc-iec61131");
    expect(plc).toMatchObject({ status: "active", detectedFiles: 5, analysedFiles: 4 });
    expect(plan.planned.map((p) => p.id)).not.toContain("plc-iec61131");
    expect(plan.inventory.plc).toMatchObject({
      files: 4,
      exportsNotRead: 1,
      pous: { FUNCTION_BLOCK: 2, PROGRAM: 1 },
      ioPoints: { input: 2, output: 1 },
      sharedAddresses: 1,
      instanceCalls: 1,
    });
    expect(plan.coverage.plc.exportsNotRead).toEqual(["plc/export/Line1.L5X"]);
    expect(plan.coverage.cobol.notAnalysedFiles).toBe(1);
  });

  it("gives the POU list, one POU in full, and the variables at one address", () => {
    const list = inventory(poly, "plc") as { pous: Array<{ name: string; kind: string }> };
    expect(list.pous.map((p) => `${p.kind} ${p.name}`)).toEqual([
      "FUNCTION_BLOCK SPARE",
      "FUNCTION_BLOCK CONVEYOR",
      "PROGRAM MAIN",
    ]);
    const conveyor = inventory(poly, "plc", "conveyor") as {
      pou: { name: string; file: string; line: number };
      instancesOf: Array<{ pou: string; file: string; line: number }>;
    };
    expect(conveyor.pou).toMatchObject({ file: "plc/line1/Conveyor.st", line: 1 });
    expect(conveyor.instancesOf.map((i) => `${i.pou} ${i.file}:${i.line}`)).toEqual([
      "MAIN plc/line1/Main.st:7",
    ]);
    const at = inventory(poly, "plc", "%ix0.0") as { io: Array<{ name: string; pou?: string }> };
    expect(at.io.map((x) => `${x.pou ?? "global"} ${x.name}`).toSorted()).toEqual([
      "MAIN STARTPB",
      "global ESTOP",
    ]);
    expect(() => inventory(poly, "plc", "Nope")).toThrow(/No PLC POU named Nope/);
  });

  it("adds a cited PLC section to the design document in Japanese and English, deterministically", () => {
    for (const lang of ["ja", "en"] as const) {
      const doc = designDoc(index, { lang, poly });
      expect(doc.sections).toContain("plc");
      expect(uncitedFactLines(doc.markdown)).toEqual([]);
      const again = analyseProject(buildIndex(namedTree("plant-plc", FILES)));
      expect(designDoc(again.index, { lang, poly: again }).markdown).toBe(doc.markdown);
    }
    const en = designDoc(index, { lang: "en", poly, sections: ["plc"] }).markdown;
    expect(en).toContain("## 1. PLC program specifications (IEC 61131-3)");
    expect(en).toContain("### 1.2 I/O allocation table");
    expect(en).toContain(
      "| `%IX0.0` | input | `STARTPB` | `MAIN` | `BOOL` | `plc/line1/Main.st:3` |",
    );
    expect(en).toContain(
      "| `%IX0.0` | input | `ESTOP` | (global) | `BOOL` | `plc/globals.txt:2` |",
    );
    expect(en).toMatch(
      /\| `BELT` \| instance \| `Conveyor` \| `plc\/line1\/Conveyor.st:1` \| `plc\/line1\/Main.st:7` \|/,
    );
    expect(en).toContain("- Purpose: needs confirmation `plc/line1/Main.st:1`");
    expect(en).toContain(
      "- Address declared by more than one variable: `%IX0.0` `plc/globals.txt:2` `plc/line1/Main.st:3`",
    );
    expect(en).toContain("- Export not read (vendor ladder): `plc/export/Line1.L5X:1`");
    const ja = designDoc(index, { lang: "ja", poly, sections: ["plc"] }).markdown;
    expect(ja).toContain("## 1. PLC プログラム仕様（IEC 61131-3）");
    expect(ja).toContain("### 1.2 入出力割付表");
    expect(ja).toContain("| `%QX0.0` | 出力 | `MOTOR` | `MAIN` | `BOOL` | `plc/line1/Main.st:4` |");
  });

  it("leaves the PLC section out of projects without PLC sources", () => {
    const none = analyseProject(
      buildIndex(
        namedTree("no-plc", {
          "src/A.cbl": "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. A.\n",
        }),
      ),
    );
    expect(designDoc(none.index, { lang: "en", poly: none }).sections).not.toContain("plc");
  });
});
