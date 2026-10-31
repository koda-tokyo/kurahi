// Comparators (KIMS-014, AC-021/023): deterministic, no model judgement. exact (default) compares
// bytes; text compares decoded records (lines; CRLF and LF are the same record boundary); fields
// compares fixed-position fields per record — text, display decimal (sign leading or trailing,
// optional point, implied scale) and COMP-3 packed decimal — with an explicit approved tolerance
// (default 0). Signed zero is a difference unless the field says otherwise. Bytes outside the
// declared fields are compared exactly. Every difference is then classed INTENDED_CHANGE when an
// intended entry of the change spec covers it, else REGRESSION.
import type { ComparatorSpec, FieldSpec, IntendedSpec } from "./change-spec.js";
import type { DiffFinding, OutputClass } from "./types.js";

const MAX_FINDINGS_PER_OUTPUT = 50;

export type Decimal = { neg: boolean; units: bigint; scale: number };

/** Display decimal: "  -1,234.50", "+000123456" (implied scale), "12.30-", "5.00CR". */
export function parseDisplayDecimal(text: string, impliedScale = 0): Decimal | null {
  let s = text.trim().replace(/,/g, "");
  let neg = false;
  if (/(CR|DB)$/i.test(s)) {
    neg = true;
    s = s.slice(0, -2).trim();
  }
  if (/^[+-]/.test(s)) {
    neg = neg || s[0] === "-";
    s = s.slice(1).trim();
  } else if (/[+-]$/.test(s)) {
    neg = neg || s.endsWith("-");
    s = s.slice(0, -1).trim();
  }
  if (!/^\d*\.?\d*$/.test(s) || !/\d/.test(s)) {
    return null;
  }
  const dot = s.indexOf(".");
  if (dot >= 0) {
    const frac = s.slice(dot + 1);
    return { neg, units: BigInt((s.slice(0, dot) || "0") + frac || "0"), scale: frac.length };
  }
  return { neg, units: BigInt(s), scale: impliedScale };
}

/** COMP-3: two digits per byte, the low nibble of the last byte is the sign (D/B negative). */
export function parsePacked(buf: Buffer, scale = 0): Decimal | null {
  if (buf.length === 0) {
    return null;
  }
  let digits = "";
  for (let i = 0; i < buf.length; i++) {
    const hi = buf[i] >> 4;
    const lo = buf[i] & 0x0f;
    if (hi > 9) {
      return null;
    }
    digits += String(hi);
    if (i < buf.length - 1) {
      if (lo > 9) {
        return null;
      }
      digits += String(lo);
    } else if (lo < 0x0a) {
      return null;
    } else {
      return { neg: lo === 0x0b || lo === 0x0d, units: BigInt(digits), scale };
    }
  }
  return null;
}

function rescale(d: Decimal, scale: number): bigint {
  return d.units * 10n ** BigInt(scale - d.scale);
}

export function formatDecimal(d: Decimal): string {
  const s = d.units.toString().padStart(d.scale + 1, "0");
  const body = d.scale > 0 ? `${s.slice(0, -d.scale)}.${s.slice(-d.scale)}` : s;
  return `${d.neg ? "-" : ""}${body}`;
}

/** null when equal under the field rules; otherwise why they differ. */
export function compareDecimals(
  a: Decimal,
  b: Decimal,
  field: Pick<FieldSpec, "tolerance" | "signedZero">,
): { equal: boolean; withinTolerance: boolean; detail: string } {
  const tol = parseDisplayDecimal(field.tolerance ?? "0") ?? { neg: false, units: 0n, scale: 0 };
  const scale = Math.max(a.scale, b.scale, tol.scale);
  const av = (a.neg ? -1n : 1n) * rescale(a, scale);
  const bv = (b.neg ? -1n : 1n) * rescale(b, scale);
  const zeroA = a.units === 0n;
  const zeroB = b.units === 0n;
  if (zeroA && zeroB) {
    if (a.neg !== b.neg && field.signedZero !== "equal") {
      return { equal: false, withinTolerance: false, detail: "sign of zero differs" };
    }
    return { equal: true, withinTolerance: false, detail: "" };
  }
  const diff = av > bv ? av - bv : bv - av;
  if (diff === 0n) {
    return { equal: true, withinTolerance: false, detail: "" };
  }
  const tv = rescale(tol, scale);
  const diffText = formatDecimal({ neg: false, units: diff, scale });
  if (diff <= tv) {
    return {
      equal: true,
      withinTolerance: true,
      detail: `differs by ${diffText}, within ${field.tolerance}`,
    };
  }
  return { equal: false, withinTolerance: false, detail: `differs by ${diffText}` };
}

function splitRecords(buf: Buffer, recordLength?: number): Buffer[] {
  if (recordLength) {
    const out: Buffer[] = [];
    for (let i = 0; i < buf.length; i += recordLength) {
      out.push(buf.subarray(i, i + recordLength));
    }
    return out;
  }
  const text = buf.toString("latin1").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.map((l) => Buffer.from(l, "latin1"));
}

type Where = { field?: string; key?: string; record?: number };

export function intendedCovers(
  intended: IntendedSpec[],
  fixture: string,
  output: string,
  where: Where,
): number {
  return intended.findIndex(
    (it) =>
      it.output === output &&
      (!it.fixtures || it.fixtures.includes(fixture)) &&
      (!it.fields || (where.field !== undefined && it.fields.includes(where.field))) &&
      (!it.keys || (where.key !== undefined && it.keys.includes(where.key))) &&
      (!it.records || (where.record !== undefined && it.records.includes(where.record))),
  );
}

const show = (b: Buffer | undefined) =>
  b === undefined ? "(missing)" : JSON.stringify(b.toString("latin1")).slice(0, 120);

function fieldValue(f: FieldSpec, raw: Buffer): Decimal | null {
  return f.type === "packed"
    ? parsePacked(raw, f.scale ?? 0)
    : parseDisplayDecimal(raw.toString("latin1"), f.scale ?? 0);
}

export type OutputComparison = {
  class: OutputClass;
  findings: DiffFinding[];
  /** Intended entries (by index) a difference here was attributed to. */
  usedIntended: Set<number>;
};

/** Compare one output of one fixture; differences are attributed to intended entries or not. */
export function compareOutput(params: {
  fixture: string;
  output: string;
  baseline: Buffer | undefined;
  candidate: Buffer | undefined;
  comparator: ComparatorSpec;
  intended: IntendedSpec[];
}): OutputComparison {
  const { fixture, output, comparator, intended } = params;
  const findings: DiffFinding[] = [];
  const usedIntended = new Set<number>();
  // Counted apart from the (capped) findings list, so a cap never hides a regression.
  let regressions = 0;
  let changes = 0;
  const add = (detail: string, where: Where, b?: string, c?: string, info = false) => {
    const idx = info ? -1 : intendedCovers(intended, fixture, output, where);
    if (idx >= 0) {
      usedIntended.add(idx);
      changes++;
    } else if (!info) {
      regressions++;
    }
    if (findings.length < MAX_FINDINGS_PER_OUTPUT) {
      findings.push({
        fixture,
        output,
        class: info ? "EQUIVALENT" : idx >= 0 ? "INTENDED_CHANGE" : "REGRESSION",
        detail,
        ...(where.record !== undefined ? { record: where.record } : {}),
        ...(where.field !== undefined ? { field: where.field } : {}),
        ...(b !== undefined ? { baseline: b } : {}),
        ...(c !== undefined ? { candidate: c } : {}),
      });
    }
  };
  const base = params.baseline;
  const cand = params.candidate;
  if (base === undefined || cand === undefined) {
    if (base !== cand) {
      add(
        base === undefined
          ? "output only produced by the candidate"
          : "output not produced by the candidate",
        {},
      );
    }
  } else if (comparator.mode === "exact") {
    if (!base.equals(cand)) {
      let at = 0;
      while (at < base.length && at < cand.length && base[at] === cand[at]) {
        at++;
      }
      add(`bytes differ from offset ${at} (sizes ${base.length} / ${cand.length})`, {});
    }
  } else {
    const recLen = comparator.mode === "fields" ? comparator.recordLength : undefined;
    const br = splitRecords(base, recLen);
    const cr = splitRecords(cand, recLen);
    const fields = comparator.mode === "fields" ? comparator.fields : [];
    const keyField =
      comparator.mode === "fields" ? fields.find((f) => f.name === comparator.keyField) : undefined;
    const keyOf = (r: Buffer | undefined) =>
      keyField && r
        ? r
            .subarray(keyField.start - 1, keyField.start - 1 + keyField.length)
            .toString("latin1")
            .trim()
        : undefined;
    for (let i = 0; i < Math.max(br.length, cr.length); i++) {
      const record = i + 1;
      const b = br[i];
      const c = cr[i];
      const key = keyOf(b) ?? keyOf(c);
      if (!b || !c) {
        add(
          b ? "record missing in the candidate" : "extra record in the candidate",
          { record, key },
          show(b),
          show(c),
        );
        continue;
      }
      if (comparator.mode === "text") {
        const norm = (x: Buffer) =>
          comparator.trimTrailing ? x.toString("latin1").trimEnd() : x.toString("latin1");
        if (norm(b) !== norm(c)) {
          add("record differs", { record, key }, show(b), show(c));
        }
        continue;
      }
      const covered = new Uint8Array(Math.max(b.length, c.length));
      for (const f of fields) {
        const s = f.start - 1;
        covered.fill(1, s, s + f.length);
        const fb = b.subarray(s, s + f.length);
        const fc = c.subarray(s, s + f.length);
        if (f.type === "text") {
          if (!fb.equals(fc)) {
            add("field differs", { record, key, field: f.name }, show(fb), show(fc));
          }
          continue;
        }
        const db = fieldValue(f, fb);
        const dc = fieldValue(f, fc);
        if (!db || !dc) {
          if (!fb.equals(fc)) {
            add(
              `field differs (not a valid ${f.type} value)`,
              { record, key, field: f.name },
              show(fb),
              show(fc),
            );
          }
          continue;
        }
        const r = compareDecimals(db, dc, f);
        if (!r.equal) {
          add(
            `value ${r.detail}`,
            { record, key, field: f.name },
            formatDecimal(db),
            formatDecimal(dc),
          );
        } else if (r.withinTolerance) {
          add(
            `value ${r.detail} (approved tolerance)`,
            { record, key, field: f.name },
            formatDecimal(db),
            formatDecimal(dc),
            true,
          );
        }
      }
      const rest = (x: Buffer) => Buffer.from([...x].filter((_, j) => !covered[j]));
      if (b.length !== c.length || !rest(b).equals(rest(c))) {
        add(
          "bytes outside the declared fields differ",
          { record, key, field: "(unmapped)" },
          show(b),
          show(c),
        );
      }
    }
  }
  const cls: OutputClass =
    regressions > 0 ? "REGRESSION" : changes > 0 ? "INTENDED_CHANGE" : "EQUIVALENT";
  return { class: cls, findings, usedIntended };
}
