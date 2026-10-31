// Change specs (KIMS-014): how outputs are compared and which differences an approved change
// intends. Without a change spec every output is compared byte for byte and every difference is
// a regression. A spec may (1) pick a comparator per output — exact, record-wise text, or
// fixed-position fields with decimal / packed-decimal values and an explicit tolerance (default
// 0) — and (2) declare intended differences, narrowed by output, fixture, field, record key or
// record number, optionally with the exact output the candidate must now produce.
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Hex } from "../continuity-suite/manifest.js";

export type FieldSpec = {
  name: string;
  /** 1-based byte position in the record. */
  start: number;
  length: number;
  type: "text" | "decimal" | "packed";
  /** decimal without a point: digits after the implied decimal point. packed: the scale. */
  scale?: number;
  /** Approved absolute tolerance, as a decimal string ("0.01"); default "0". */
  tolerance?: string;
  /** "distinct" (default): -0 and +0 differ. "equal": only the magnitude is compared. */
  signedZero?: "distinct" | "equal";
};

export type ComparatorSpec =
  | { mode: "exact" }
  | { mode: "text"; trimTrailing?: boolean }
  | { mode: "fields"; recordLength?: number; keyField?: string; fields: FieldSpec[] };

export type IntendedSpec = {
  output: string;
  fixtures?: string[];
  fields?: string[];
  keys?: string[];
  records?: number[];
  /** fixture → file (relative to the spec) the candidate output must equal exactly. */
  expected?: Record<string, string>;
};

export type ChangeSpec = {
  id: string;
  title: string;
  rationale?: string;
  comparators?: Record<string, ComparatorSpec>;
  intended?: IntendedSpec[];
};

export type LoadedChangeSpec = {
  spec: ChangeSpec;
  sha256: string;
  /** `${intendedIndex}|${fixture}` → expected bytes. */
  expected: Map<string, Buffer>;
  raw: Buffer;
};

const MAX_EXPECTED = 16 * 1024 * 1024;

function fail(msg: string): never {
  throw new Error(`change spec: ${msg}`);
}

function checkField(f: FieldSpec, i: number): void {
  if (!f || typeof f.name !== "string" || !f.name) {
    fail(`field ${i} needs a name`);
  }
  if (!Number.isInteger(f.start) || f.start < 1 || !Number.isInteger(f.length) || f.length < 1) {
    fail(`field ${f.name}: start and length must be positive integers`);
  }
  if (!["text", "decimal", "packed"].includes(f.type)) {
    fail(`field ${f.name}: type must be text, decimal or packed`);
  }
  if (f.tolerance !== undefined && !/^\d+(\.\d+)?$/.test(f.tolerance)) {
    fail(`field ${f.name}: tolerance must be a non-negative decimal string`);
  }
  if (f.scale !== undefined && (!Number.isInteger(f.scale) || f.scale < 0 || f.scale > 18)) {
    fail(`field ${f.name}: scale must be an integer 0-18`);
  }
}

export function validateChangeSpec(raw: unknown): ChangeSpec {
  const s = raw as ChangeSpec;
  if (!s || typeof s !== "object" || typeof s.id !== "string" || !s.id.trim()) {
    fail("id is required");
  }
  if (typeof s.title !== "string" || !s.title.trim()) {
    fail("title is required");
  }
  for (const [name, c] of Object.entries(s.comparators ?? {})) {
    if (!c || !["exact", "text", "fields"].includes(c.mode)) {
      fail(`comparator for ${name}: mode must be exact, text or fields`);
    }
    if (c.mode === "fields") {
      if (!Array.isArray(c.fields) || c.fields.length === 0) {
        fail(`comparator for ${name}: fields mode needs fields`);
      }
      c.fields.forEach(checkField);
      if (c.keyField && !c.fields.some((f) => f.name === c.keyField)) {
        fail(`comparator for ${name}: keyField ${c.keyField} is not a field`);
      }
      if (
        c.recordLength !== undefined &&
        (!Number.isInteger(c.recordLength) || c.recordLength < 1)
      ) {
        fail(`comparator for ${name}: recordLength must be a positive integer`);
      }
    }
  }
  for (const [i, it] of (s.intended ?? []).entries()) {
    if (!it || typeof it.output !== "string" || !it.output) {
      fail(`intended ${i}: output is required`);
    }
  }
  return s;
}

/** Load a change spec file; expected outputs are read now and hashed into the spec digest. */
export function loadChangeSpec(file: string): LoadedChangeSpec {
  const abs = path.resolve(file);
  const raw = fs.readFileSync(abs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    fail(`${file} is not valid JSON`);
  }
  const spec = validateChangeSpec(parsed);
  const base = path.dirname(abs);
  const expected = new Map<string, Buffer>();
  const expectedDigests: Record<string, string> = {};
  for (const [i, it] of (spec.intended ?? []).entries()) {
    for (const [fixture, rel] of Object.entries(it.expected ?? {})) {
      const target = path.resolve(base, rel);
      if (!target.startsWith(base + path.sep)) {
        fail(`expected file ${rel} is outside the spec's folder`);
      }
      const st = fs.statSync(target);
      if (!st.isFile() || st.size > MAX_EXPECTED) {
        fail(`expected file ${rel} is not a regular file under ${MAX_EXPECTED} bytes`);
      }
      const buf = fs.readFileSync(target);
      expected.set(`${i}|${fixture}`, buf);
      expectedDigests[`${i}|${fixture}`] = sha256Hex(buf);
    }
  }
  const sha256 = sha256Hex(canonicalJson({ spec, expected: expectedDigests }));
  return { spec, sha256, expected, raw };
}
