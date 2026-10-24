import { describe, expect, it } from "vitest";
import { readCodeStream } from "./source.js";
import { A, B, C, K } from "./test-fixtures/helpers.js";
import { tokenize } from "./tokenizer.js";

const words = (src: string) => tokenize(readCodeStream("t.cbl", src)).map((t) => t.raw);

describe("fixed-format source", () => {
  it("reads columns 8-72 only and ignores sequence and identification areas", () => {
    const line = `${"000100".padEnd(6)} MOVE A TO B.`.padEnd(72) + "PROG0001";
    const toks = tokenize(readCodeStream("t.cbl", line));
    expect(toks.map((t) => t.raw)).toEqual(["MOVE", "A", "TO", "B", "."]);
    expect(toks[0]).toMatchObject({ line: 1, col: 8 });
  });

  it("drops comment, page-eject and debugging lines and records the comment text", () => {
    const s = readCodeStream(
      "t.cbl",
      [C(" A NOTE"), "      /PAGE", "      DDISPLAY 'X'", B("STOP RUN.")].join("\n"),
    );
    expect(tokenize(s).map((t) => t.raw)).toEqual(["STOP", "RUN", "."]);
    expect(s.comments.map((c) => c.line)).toEqual([1, 2, 3]);
    expect(s.comments[0].text).toBe("A NOTE");
  });

  it("joins a continued alphanumeric literal, keeping the spaces up to column 72", () => {
    const first = B("MOVE 'ABC").padEnd(72);
    const toks = tokenize(readCodeStream("t.cbl", [first, K("'DEF' TO X.")].join("\n")));
    const lit = toks.find((t) => t.kind === "str");
    expect(lit?.value).toBe(`ABC${" ".repeat(72 - 11 - 9)}DEF`);
    expect(lit?.line).toBe(1);
    expect(toks.map((t) => t.raw).slice(-3)).toEqual(["TO", "X", "."]);
  });

  it("joins a continued word", () => {
    expect(words([B("MOVE WS-TO"), K("TAL TO X.")].join("\n"))).toEqual([
      "MOVE",
      "WS-TOTAL",
      "TO",
      "X",
      ".",
    ]);
  });

  it("strips inline *> comments outside literals", () => {
    expect(words(B("MOVE '*>' TO X *> trailing note"))).toEqual(["MOVE", "'*>'", "TO", "X"]);
  });

  it("reads free format when the source says so", () => {
    const s = readCodeStream(
      "t.cbl",
      [">>SOURCE FORMAT FREE", "*> comment", "MOVE A TO B. *> note"].join("\n"),
    );
    expect(s.format).toBe("free");
    expect(tokenize(s).map((t) => t.raw)).toEqual(["MOVE", "A", "TO", "B", "."]);
  });
});

describe("tokenizer", () => {
  it("keeps PICTURE strings whole and separates the closing period", () => {
    expect(words(B("05 X PIC ZZ,ZZ9.99."))).toEqual(["05", "X", "PIC", "ZZ,ZZ9.99", "."]);
    expect(words(B("05 X PIC IS S9(5)V99 COMP-3."))).toEqual([
      "05",
      "X",
      "PIC",
      "IS",
      "S9(5)V99",
      "COMP-3",
      ".",
    ]);
  });

  it("distinguishes numeric literals, paragraph names, subscripts and operators", () => {
    const toks = tokenize(
      readCodeStream("t.cbl", B("COMPUTE T(I) = 1.25 * -2 + X(1:4). 0000-MAIN.")),
    );
    expect(toks.map((t) => `${t.kind}:${t.raw}`)).toEqual([
      "word:COMPUTE",
      "word:T",
      "op:(",
      "word:I",
      "op:)",
      "op:=",
      "num:1.25",
      "op:*",
      "num:-2",
      "op:+",
      "word:X",
      "op:(",
      "num:1",
      "op::",
      "num:4",
      "op:)",
      "period:.",
      "word:0000-MAIN",
      "period:.",
    ]);
  });

  it("reads hex literals and doubled quotes", () => {
    const toks = tokenize(readCodeStream("t.cbl", B("MOVE X'00' TO A. MOVE 'IT''S' TO B.")));
    expect(toks.filter((t) => t.kind === "str").map((t) => t.value)).toEqual(["00", "IT'S"]);
  });

  it("keeps a period inside a literal and a decimal point inside a number", () => {
    expect(words(A("DISPLAY 'A. B' 3.5."))).toEqual(["DISPLAY", "'A. B'", "3.5", "."]);
  });
});
