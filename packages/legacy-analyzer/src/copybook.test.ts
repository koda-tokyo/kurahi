import { describe, expect, it } from "vitest";
import { expandCopies } from "./copybook.js";
import { readCodeStream } from "./source.js";
import { B } from "./test-fixtures/helpers.js";
import { tokenize } from "./tokenizer.js";

const books: Record<string, string> = {
  CUST: [B("05 :P:-ID PIC 9(6)."), B("05 :P:-NAME PIC X(20).")].join("\n"),
  AMT: [B("05 AMT-VALUE PIC 9(5)."), B("COPY INNER.")].join("\n"),
  INNER: B("05 AMT-FLAG PIC X."),
  LOOP: B("COPY LOOP."),
};
const resolve = (name: string) =>
  books[name] ? { file: `copy/${name}.cpy`, content: books[name] } : null;
const expand = (src: string) => expandCopies(tokenize(readCodeStream("main.cbl", src)), resolve);

describe("COPY", () => {
  it("inlines the copybook with its own file and line numbers", () => {
    const r = expand([B("01 R."), B("COPY AMT.")].join("\n"));
    const names = r.tokens
      .filter((t) => t.kind === "word")
      .map((t) => `${t.value}@${t.file}:${t.line}`);
    expect(names).toContain("AMT-VALUE@copy/AMT.cpy:1");
    expect(names).toContain("AMT-FLAG@copy/INNER.cpy:1");
    expect(r.copies.map((c) => [c.name, c.resolved, c.file, c.line])).toEqual([
      ["AMT", "copy/AMT.cpy", "main.cbl", 2],
      ["INNER", "copy/INNER.cpy", "copy/AMT.cpy", 2],
    ]);
  });

  it("applies REPLACING with pseudo-text tags, words and LEADING", () => {
    const r = expand(
      [B("COPY CUST REPLACING ==:P:== BY ==WS=="), B("    LEADING ==WS== BY ==CU==.")].join("\n"),
    );
    // Text produced by one operand is not replaced again by the next.
    expect(
      r.tokens.filter((t) => t.kind === "word" && t.value.includes("-")).map((t) => t.value),
    ).toEqual(["WS-ID", "WS-NAME"]);
    expect(r.copies[0].replacing).toEqual([
      { from: ":P:", to: "WS" },
      { from: "LEADING WS", to: "CU" },
    ]);
    const lead = expand(B("COPY AMT REPLACING LEADING ==AMT== BY ==TOT==."));
    expect(lead.tokens.filter((t) => t.value.startsWith("TOT-")).map((t) => t.value)).toEqual([
      "TOT-VALUE",
      "TOT-FLAG",
    ]);
    const r2 = expand(B("COPY INNER REPLACING AMT-FLAG BY NEW-FLAG."));
    expect(r2.tokens.some((t) => t.value === "NEW-FLAG")).toBe(true);
  });

  it("reports missing and recursive copybooks", () => {
    expect(expand(B("COPY NOPE.")).diagnostics[0].message).toContain("not found");
    expect(expand(B("COPY LOOP.")).diagnostics.some((d) => d.message.includes("recursive"))).toBe(
      true,
    );
  });
});
