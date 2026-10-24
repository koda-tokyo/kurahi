import { describe, expect, it } from "vitest";
import { buildDataItems, picInfo, splitSentences, storageLength } from "./data.js";
import { readCodeStream } from "./source.js";
import { B } from "./test-fixtures/helpers.js";
import { tokenize } from "./tokenizer.js";

function items(lines: string[]) {
  const toks = tokenize(readCodeStream("t.cpy", lines.join("\n")));
  return buildDataItems(
    splitSentences(toks).map((t) => ({ tokens: t, section: "WORKING-STORAGE" })),
  );
}

describe("PICTURE and USAGE", () => {
  it("computes display, binary and packed lengths", () => {
    expect(storageLength("X(10)", undefined)).toBe(10);
    expect(storageLength("S9(7)V99", undefined)).toBe(9);
    expect(storageLength("S9(7)V99", "COMP-3")).toBe(5);
    expect(storageLength("S9(4)", "COMP")).toBe(2);
    expect(storageLength("9(9)", "BINARY")).toBe(4);
    expect(storageLength("9(10)", "COMP-5")).toBe(8);
    expect(storageLength("ZZ,ZZ9.99CR", undefined)).toBe(11);
    expect(storageLength(undefined, "COMP-2")).toBe(8);
    expect(picInfo("S9(3)V9(2)").numeric).toEqual({ digits: 5, scale: 2, signed: true });
  });
});

describe("data items", () => {
  it("builds the hierarchy with level, PIC, USAGE, VALUE, offsets and 88-levels", () => {
    const d = items([
      B("01 REC."),
      B("   05 KIND PIC X VALUE 'A'."),
      B("      88 KIND-OK VALUE 'A' 'B'."),
      B("      88 KIND-RANGE VALUE 'C' THRU 'F'."),
      B("   05 AMOUNT PIC S9(5)V99 COMP-3 VALUE +1.5."),
      B("   05 CODES OCCURS 3 TIMES."),
      B("      10 CODE-A PIC X(2)."),
      B("      10 CODE-B PIC 9(4) COMP."),
      B("   05 TAIL PIC X(4)."),
    ]);
    const by = (n: string) => d.find((x) => x.name === n);
    expect(by("REC")).toMatchObject({ level: 1, length: 1 + 4 + 12 + 4, offset: 0 });
    expect(by("KIND")).toMatchObject({
      parent: "REC",
      pic: "X",
      value: ["'A'"],
      offset: 0,
      length: 1,
    });
    expect(by("KIND-OK")).toMatchObject({
      level: 88,
      parent: "KIND",
      conditionValues: ["'A'", "'B'"],
    });
    expect(by("KIND-RANGE")?.conditionValues).toEqual(["'C' THRU 'F'"]);
    expect(by("AMOUNT")).toMatchObject({ usage: "COMP-3", length: 4, offset: 1, value: ["+1.5"] });
    expect(by("CODES")).toMatchObject({ occurs: { min: 3, max: 3 }, length: 4, offset: 5 });
    expect(by("CODE-B")).toMatchObject({ offset: 7, length: 2, path: ["REC", "CODES", "CODE-B"] });
    expect(by("TAIL")).toMatchObject({ offset: 17 });
  });

  it("places a REDEFINES item at the redefined item's offset without growing the group", () => {
    const d = items([
      B("01 R."),
      B("   05 A PIC X(2)."),
      B("   05 DATE-X PIC X(8)."),
      B("   05 DATE-N REDEFINES DATE-X."),
      B("      10 YYYY PIC 9(4)."),
      B("      10 MMDD PIC 9(4)."),
      B("   05 Z PIC X."),
    ]);
    const by = (n: string) => d.find((x) => x.name === n);
    expect(by("DATE-N")).toMatchObject({ redefines: "DATE-X", offset: 2, length: 8 });
    expect(by("MMDD")?.offset).toBe(6);
    expect(by("Z")?.offset).toBe(10);
    expect(by("R")?.length).toBe(11);
  });

  it("handles OCCURS DEPENDING ON and FILLER", () => {
    const d = items([
      B("01 T."),
      B("   05 N PIC 9(2)."),
      B("   05 FILLER PIC X(3) VALUE SPACES."),
      B("   05 E OCCURS 1 TO 10 DEPENDING ON N PIC X(5)."),
    ]);
    expect(d.find((x) => x.name === "E")?.occurs).toEqual({ min: 1, max: 10, dependingOn: "N" });
    expect(d.find((x) => x.name === "FILLER")?.value).toEqual(["SPACES"]);
    expect(d.find((x) => x.name === "T")?.length).toBe(55);
  });
});
