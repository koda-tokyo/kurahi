import { describe, expect, it } from "vitest";
import type { ComparatorSpec, IntendedSpec } from "./change-spec.js";
import { validateChangeSpec } from "./change-spec.js";
import {
  compareDecimals,
  compareOutput,
  formatDecimal,
  parseDisplayDecimal,
  parsePacked,
} from "./compare.js";

const d = (s: string, scale = 0) => parseDisplayDecimal(s, scale)!;

describe("decimal parsing (AC-023)", () => {
  it("reads display decimals with leading/trailing signs, points, CR/DB and implied scale", () => {
    expect(formatDecimal(d("   -1,234.50"))).toBe("-1234.50");
    expect(formatDecimal(d("+000123456", 2))).toBe("1234.56");
    expect(formatDecimal(d("-000005000", 2))).toBe("-50.00");
    expect(formatDecimal(d("12.30-"))).toBe("-12.30");
    expect(formatDecimal(d("5.00CR"))).toBe("-5.00");
    expect(parseDisplayDecimal("   ")).toBeNull();
    expect(parseDisplayDecimal("12A")).toBeNull();
  });

  it("decodes COMP-3 packed decimal with C/F positive and D/B negative signs", () => {
    expect(formatDecimal(parsePacked(Buffer.from([0x00, 0x01, 0x42, 0x50, 0x0c]), 2)!)).toBe(
      "1425.00",
    );
    expect(formatDecimal(parsePacked(Buffer.from([0x00, 0x00, 0x05, 0x00, 0x0d]), 2)!)).toBe(
      "-50.00",
    );
    expect(formatDecimal(parsePacked(Buffer.from([0x12, 0x3f]))!)).toBe("123");
    expect(parsePacked(Buffer.from([0x00, 0x0d]))!.neg).toBe(true);
    expect(parsePacked(Buffer.from([0x1a, 0x0c]))).toBeNull();
    expect(parsePacked(Buffer.from([0x12, 0x34]))).toBeNull();
  });

  it("treats signed zero as a difference unless the field allows it", () => {
    const neg = parsePacked(Buffer.from([0x00, 0x0d]))!;
    const pos = parsePacked(Buffer.from([0x00, 0x0c]))!;
    expect(compareDecimals(pos, neg, {}).equal).toBe(false);
    expect(compareDecimals(pos, neg, {}).detail).toBe("sign of zero differs");
    expect(compareDecimals(pos, neg, { signedZero: "equal" }).equal).toBe(true);
    expect(compareDecimals(d("-0.00"), d("0.00"), {}).equal).toBe(false);
  });

  it("applies only an explicit tolerance (default 0), across scales", () => {
    expect(compareDecimals(d("179.56"), d("179.55"), {}).equal).toBe(false);
    expect(compareDecimals(d("179.56"), d("179.55"), { tolerance: "0.01" })).toMatchObject({
      equal: true,
      withinTolerance: true,
    });
    expect(compareDecimals(d("179.56"), d("179.54"), { tolerance: "0.01" }).equal).toBe(false);
    expect(compareDecimals(d("1.5"), d("1.50"), {}).equal).toBe(true);
  });
});

const FIELDS: ComparatorSpec = {
  mode: "fields",
  keyField: "ID",
  fields: [
    { name: "ID", start: 1, length: 3, type: "text" },
    { name: "AMT", start: 5, length: 7, type: "decimal" },
  ],
};

const rec = (rows: string[]) => Buffer.from(rows.map((r) => `${r}\n`).join(""));

describe("output comparison (AC-021)", () => {
  it("is exact by default and every difference is a regression", () => {
    const r = compareOutput({
      fixture: "f",
      output: "stdout",
      baseline: Buffer.from("A\n"),
      candidate: Buffer.from("B\n"),
      comparator: { mode: "exact" },
      intended: [],
    });
    expect(r.class).toBe("REGRESSION");
    expect(r.findings[0].detail).toMatch(/offset 0/);
  });

  it("separates intended changes (by key and field) from regressions", () => {
    const intended: IntendedSpec[] = [{ output: "OUT", keys: ["002"], fields: ["AMT"] }];
    const base = rec(["001   10.00", "002   20.00", "003   30.00"]);
    const ok = compareOutput({
      fixture: "f",
      output: "OUT",
      baseline: base,
      candidate: rec(["001   10.00", "002   25.00", "003   30.00"]),
      comparator: FIELDS,
      intended,
    });
    expect(ok.class).toBe("INTENDED_CHANGE");
    expect(ok.usedIntended.has(0)).toBe(true);
    const bad = compareOutput({
      fixture: "f",
      output: "OUT",
      baseline: base,
      candidate: rec(["001   10.01", "002   25.00", "003   30.00"]),
      comparator: FIELDS,
      intended,
    });
    expect(bad.class).toBe("REGRESSION");
    expect(bad.findings.find((f) => f.class === "REGRESSION")).toMatchObject({
      record: 1,
      field: "AMT",
      baseline: "10.00",
      candidate: "10.01",
    });
  });

  it("compares bytes outside the declared fields exactly", () => {
    const r = compareOutput({
      fixture: "f",
      output: "OUT",
      baseline: rec(["001 X 10.00"]),
      candidate: rec(["001 Y 10.00"]),
      comparator: {
        mode: "fields",
        fields: [{ name: "AMT", start: 7, length: 5, type: "decimal" }],
      },
      intended: [{ output: "OUT", fields: ["AMT"] }],
    });
    expect(r.class).toBe("REGRESSION");
    expect(r.findings[0].field).toBe("(unmapped)");
  });

  it("reports missing and extra records", () => {
    const r = compareOutput({
      fixture: "f",
      output: "OUT",
      baseline: rec(["001   10.00", "002   20.00"]),
      candidate: rec(["001   10.00"]),
      comparator: FIELDS,
      intended: [],
    });
    expect(r.findings[0].detail).toBe("record missing in the candidate");
  });

  it("text mode treats CRLF and LF as the same record boundary", () => {
    const r = compareOutput({
      fixture: "f",
      output: "stdout",
      baseline: Buffer.from("A\r\nB\r\n"),
      candidate: Buffer.from("A\nB\n"),
      comparator: { mode: "text" },
      intended: [],
    });
    expect(r.class).toBe("EQUIVALENT");
  });

  it("never hides a regression behind the findings cap", () => {
    const rows = Array.from({ length: 80 }, (_, i) => `${String(i).padStart(3, "0")}   10.00`);
    const changed = rows.map((r) => r.replace("10.00", "11.00"));
    changed[79] = "079   99.00";
    const r = compareOutput({
      fixture: "f",
      output: "OUT",
      baseline: rec(rows),
      candidate: rec(changed),
      comparator: FIELDS,
      intended: [
        { output: "OUT", keys: rows.slice(0, 79).map((x) => x.slice(0, 3)), fields: ["AMT"] },
      ],
    });
    expect(r.findings.length).toBe(50);
    expect(r.class).toBe("REGRESSION");
  });

  it("reads COMP-3 fields in fixed-length binary records", () => {
    const recA = Buffer.concat([Buffer.from("E1"), Buffer.from([0x00, 0x12, 0x5c])]);
    const recB = Buffer.concat([Buffer.from("E1"), Buffer.from([0x00, 0x12, 0x5d])]);
    const r = compareOutput({
      fixture: "f",
      output: "PK",
      baseline: recA,
      candidate: recB,
      comparator: {
        mode: "fields",
        recordLength: 5,
        fields: [{ name: "AMT", start: 3, length: 3, type: "packed", scale: 2 }],
      },
      intended: [],
    });
    expect(r.findings[0]).toMatchObject({ field: "AMT", baseline: "1.25", candidate: "-1.25" });
  });
});

describe("change spec validation", () => {
  it("rejects malformed specs", () => {
    expect(() => validateChangeSpec({ title: "x" })).toThrow(/id/);
    expect(() =>
      validateChangeSpec({ id: "C", title: "t", comparators: { a: { mode: "fuzzy" } } }),
    ).toThrow(/mode/);
    expect(() =>
      validateChangeSpec({
        id: "C",
        title: "t",
        comparators: {
          a: {
            mode: "fields",
            fields: [{ name: "X", start: 1, length: 1, type: "decimal", tolerance: "-1" }],
          },
        },
      }),
    ).toThrow(/tolerance/);
  });
});
