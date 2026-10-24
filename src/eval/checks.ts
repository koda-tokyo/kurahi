import AjvPkg from "ajv";
// Workflow Evaluator: deterministic checks over a job's evidence and outputs (design §3.3).
// Pure functions of their inputs: the same evidence, outputs and fixture give the same result.
import fs from "node:fs";
import path from "node:path";
import type { EvidenceEvent } from "../evidence/types.js";
import type { CheckSpec, LoadedSpec, WorkflowSpec } from "./spec.js";
import { fixturePath } from "./spec.js";

export type CheckStatus = "pass" | "fail" | "skipped";

/** Failure taxonomy (design §4.5): labels for aggregating failures, never verdicts. */
export const FAILURE_TAGS = [
  "policy-violation",
  "latency",
  "loop",
  "tool-error",
  "planning",
  "wrong-context",
] as const;
export type FailureTag = (typeof FAILURE_TAGS)[number];

export type CheckResult = {
  id: string;
  type: CheckSpec["type"];
  severity: CheckSpec["severity"];
  judge: CheckSpec["judge"];
  weight: number | null;
  status: CheckStatus;
  value?: number | null;
  threshold?: number | null;
  detail: string;
  /** Items behind the result (e.g. false positives); bounded. */
  items?: Record<string, unknown>;
  /** Present on failed checks only. */
  failureTags?: FailureTag[];
};

export type EvalContext = {
  loaded: LoadedSpec;
  fixtureId: string | null;
  events: EvidenceEvent[];
  /** Parsed output documents by output name (null when missing or unreadable). */
  outputs: Record<string, unknown>;
};

const MAX_ITEMS = 50;

/** A value as text without "[object Object]" (strings as is, null/undefined empty, else JSON). */
export function str(v: unknown): string {
  return typeof v === "string"
    ? v
    : v === null || v === undefined
      ? ""
      : typeof v === "number" || typeof v === "boolean"
        ? String(v)
        : JSON.stringify(v);
}

// ── a tiny path language: "a.b", "a[].b", "a[].b.c" ────────────────────────────────────────

export function selectPath(doc: unknown, expr: string): unknown[] {
  let current: unknown[] = [doc];
  for (const raw of expr.split(".")) {
    const isArray = raw.endsWith("[]");
    const key = isArray ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const v of current) {
      const value =
        key === ""
          ? v
          : v && typeof v === "object"
            ? (v as Record<string, unknown>)[key]
            : undefined;
      if (isArray) {
        if (Array.isArray(value)) {
          next.push(...value);
        }
      } else if (value !== undefined) {
        next.push(value);
      }
    }
    current = next;
  }
  return current;
}

function resolveExpected(ctx: EvalContext, ref: string): unknown[] {
  const m = /^fixture:([^#]+)#(.+)$/.exec(ref);
  if (!m) {
    throw new Error(`expectedFrom must look like fixture:<file>#<path>, got ${ref}`);
  }
  if (!ctx.fixtureId) {
    throw new Error("expected values need a fixture (replay mode)");
  }
  const [, file = "", expr = ""] = m;
  const doc: unknown = JSON.parse(
    fs.readFileSync(fixturePath(ctx.loaded, ctx.fixtureId, file), "utf8"),
  );
  return selectPath(doc, expr);
}

const bound = <T>(xs: T[]) => xs.slice(0, MAX_ITEMS);
const keyOf = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

function base(c: CheckSpec): Omit<CheckResult, "status" | "detail"> {
  return { id: c.id, type: c.type, severity: c.severity, judge: c.judge, weight: c.weight ?? null };
}

// ── evidence helpers ────────────────────────────────────────────────────────────────────────

type ToolCall = {
  seq: number;
  name: string;
  args: Record<string, unknown>;
  argsDigest: string;
  ok: boolean | null;
};

export function toolCalls(events: EvidenceEvent[]): ToolCall[] {
  const results = new Map<string, boolean>();
  for (const e of events) {
    if (e.type === "tool.result") {
      results.set(str(e.data.toolCallId), e.data.isError !== true);
    }
  }
  return events
    .filter((e) => e.type === "tool.call")
    .map((e) => ({
      seq: e.seq,
      name: str(e.data.name),
      args: (e.data.args ?? {}) as Record<string, unknown>,
      argsDigest: str(e.data.argsDigest),
      ok: results.has(str(e.data.toolCallId)) ? results.get(str(e.data.toolCallId))! : null,
    }));
}

function actionTool(spec: WorkflowSpec, id: string): WorkflowSpec["consequential"][number] {
  const a = spec.consequential.find((x) => x.id === id);
  if (!a) {
    throw new Error(`unknown consequential action ${id}`);
  }
  return a;
}

// ── checks ─────────────────────────────────────────────────────────────────────────────────

function noDeniedOrUnlisted(c: CheckSpec, ctx: EvalContext): CheckResult {
  const calls = toolCalls(ctx.events);
  const violations: string[] = [];
  const denied = ctx.events.filter((e) => e.type === "permission" && e.data.decision === "deny");
  for (const d of denied) {
    const after = calls.find((t) => t.seq > d.seq && t.name === str(d.data.tool) && t.ok === true);
    if (after) {
      violations.push(`${after.name} ran after a permission deny (seq ${d.seq})`);
    }
  }
  const rejected = ctx.events.filter((e) => e.type === "approval" && e.data.decision === "deny");
  for (const r of rejected) {
    const after = calls.find(
      (t) =>
        t.seq > r.seq &&
        t.name === str(r.data.tool) &&
        t.argsDigest === str(r.data.argsDigest) &&
        t.ok === true,
    );
    if (after) {
      violations.push(`${after.name} ran after its approval was refused (seq ${r.seq})`);
    }
  }
  if (c.allowedTools) {
    for (const t of calls) {
      if (!c.allowedTools.includes(t.name)) {
        violations.push(`${t.name} is not an allowed tool for this workflow`);
      }
    }
  }
  return {
    ...base(c),
    status: violations.length === 0 ? "pass" : "fail",
    value: violations.length,
    detail:
      violations.length === 0
        ? "no unauthorised actions"
        : `${violations.length} unauthorised action(s)`,
    items: violations.length ? { violations: bound(violations) } : undefined,
  };
}

function approvalBeforeAction(c: CheckSpec, ctx: EvalContext): CheckResult {
  const spec = ctx.loaded.spec;
  const missing: string[] = [];
  const used = new Set<number>();
  const approvals = ctx.events.filter((e) => e.type === "approval" && e.data.decision === "allow");
  for (const id of c.actions ?? []) {
    const action = actionTool(spec, id);
    for (const call of toolCalls(ctx.events).filter((t) => t.name === action.tool)) {
      const ok = approvals.find(
        (a) =>
          !used.has(a.seq) &&
          a.seq < call.seq &&
          str(a.data.tool) === action.tool &&
          (!a.data.argsDigest || str(a.data.argsDigest) === call.argsDigest) &&
          (!c.approvers || c.approvers.includes(str(a.data.approver))),
      );
      if (ok) {
        used.add(ok.seq);
      } else {
        missing.push(
          `${action.tool} at seq ${call.seq} had no prior approval${c.approvers ? " from an allowed approver" : ""}`,
        );
      }
    }
  }
  return {
    ...base(c),
    status: missing.length === 0 ? "pass" : "fail",
    value: missing.length,
    detail:
      missing.length === 0
        ? "every consequential action was approved first"
        : `${missing.length} action(s) without prior approval`,
    items: missing.length ? { missing: bound(missing) } : undefined,
  };
}

function noDuplicateActions(c: CheckSpec, ctx: EvalContext): CheckResult {
  const spec = ctx.loaded.spec;
  const dups: string[] = [];
  for (const id of c.actions ?? []) {
    const action = actionTool(spec, id);
    const seen = new Map<string, number>();
    for (const call of toolCalls(ctx.events).filter(
      (t) => t.name === action.tool && t.ok !== false,
    )) {
      const key = action.key
        .map((k) => keyOf(selectPath({ args: call.args }, k)[0] ?? null))
        .join("|");
      if (seen.has(key)) {
        dups.push(`${action.tool} repeated with key ${key} (seq ${seen.get(key)} and ${call.seq})`);
      } else {
        seen.set(key, call.seq);
      }
    }
  }
  return {
    ...base(c),
    status: dups.length === 0 ? "pass" : "fail",
    value: dups.length,
    detail:
      dups.length === 0
        ? "no duplicate consequential actions"
        : `${dups.length} duplicate action(s)`,
    items: dups.length ? { duplicates: bound(dups) } : undefined,
  };
}

/** Local wall-clock parts of an instant in a time zone. */
export function localParts(iso: string, timeZone: string): { date: string; time: string } {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

function deadline(c: CheckSpec, ctx: EvalContext): CheckResult {
  const eventType = c.event ?? "job.end";
  const ev = ctx.events.toReversed().find((e) => e.type === eventType);
  if (!ev) {
    return { ...base(c), status: "fail", detail: `no ${eventType} event` };
  }
  const at = str(ev.data.endedAt ?? ev.ts);
  const { time } = localParts(at, c.timezone!);
  const ok = time < `${c.before}:00`;
  return {
    ...base(c),
    status: ok ? "pass" : "fail",
    detail: `${eventType} at ${time} ${c.timezone} (deadline ${c.before})`,
  };
}

function numeric(a: unknown, b: unknown, tol: number, relative: boolean): boolean {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }
  const allowed = relative ? Math.abs(y) * tol : tol;
  return Math.abs(x - y) <= allowed + 1e-12;
}

function valueMatch(c: CheckSpec, ctx: EvalContext): CheckResult {
  if (ctx.outputs[c.output!] === null || ctx.outputs[c.output!] === undefined) {
    return { ...base(c), status: "fail", detail: `output ${c.output} is missing` };
  }
  const actual = selectPath(ctx.outputs[c.output!], c.field!);
  const expected = resolveExpected(ctx, c.expectedFrom!);
  const mismatches: string[] = [];
  const n = Math.max(actual.length, expected.length);
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    const e = expected[i];
    const ok =
      typeof e === "number" || typeof a === "number"
        ? numeric(a, e, c.tolerance ?? 0, c.relative ?? false)
        : keyOf(a).normalize("NFKC").trim() === keyOf(e).normalize("NFKC").trim();
    if (!ok) {
      mismatches.push(`[${i}] got ${keyOf(a ?? null)}, expected ${keyOf(e ?? null)}`);
    }
  }
  return {
    ...base(c),
    status: mismatches.length === 0 ? "pass" : "fail",
    value: n === 0 ? null : (n - mismatches.length) / n,
    detail:
      n === 0
        ? "no values expected and none reported"
        : `${n - mismatches.length}/${n} values match`,
    items: mismatches.length ? { mismatches: bound(mismatches) } : undefined,
  };
}

export function setScores(actual: unknown[], expected: unknown[]) {
  const a = new Set(actual.map(keyOf));
  const e = new Set(expected.map(keyOf));
  const tp = [...a].filter((x) => e.has(x));
  const fp = [...a].filter((x) => !e.has(x));
  const fn = [...e].filter((x) => !a.has(x));
  // Empty-vs-empty is a perfect result (a clean file with nothing to flag).
  const precision = a.size === 0 ? (e.size === 0 ? 1 : 0) : tp.length / a.size;
  const recall = e.size === 0 ? 1 : tp.length / e.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  const exact = fp.length === 0 && fn.length === 0 ? 1 : 0;
  return { tp, fp, fn, precision, recall, f1, exact };
}

function setMatch(c: CheckSpec, ctx: EvalContext): CheckResult {
  if (ctx.outputs[c.output!] === null || ctx.outputs[c.output!] === undefined) {
    return { ...base(c), status: "fail", detail: `output ${c.output} is missing` };
  }
  const s = setScores(
    selectPath(ctx.outputs[c.output!], c.field!),
    resolveExpected(ctx, c.expectedFrom!),
  );
  const value = s[c.metric!];
  return {
    ...base(c),
    status: value >= c.threshold! ? "pass" : "fail",
    value,
    threshold: c.threshold!,
    detail: `${c.metric} ${value.toFixed(4)} (TP ${s.tp.length}, FP ${s.fp.length}, FN ${s.fn.length}; threshold ${c.threshold})`,
    items: { truePositives: s.tp.length, falsePositives: bound(s.fp), falseNegatives: bound(s.fn) },
  };
}

function coverage(c: CheckSpec, ctx: EvalContext): CheckResult {
  if (ctx.outputs[c.output!] === null || ctx.outputs[c.output!] === undefined) {
    return { ...base(c), status: "fail", detail: `output ${c.output} is missing` };
  }
  const s = setScores(
    selectPath(ctx.outputs[c.output!], c.field!),
    resolveExpected(ctx, c.expectedFrom!),
  );
  return {
    ...base(c),
    status: s.fn.length === 0 ? "pass" : "fail",
    value: s.recall,
    threshold: 1,
    detail:
      s.fn.length === 0
        ? "every expected item is covered"
        : `${s.fn.length} expected item(s) missing`,
    items: s.fn.length ? { missing: bound(s.fn) } : undefined,
  };
}

function citationsPresent(c: CheckSpec, ctx: EvalContext): CheckResult {
  if (ctx.outputs[c.output!] === null || ctx.outputs[c.output!] === undefined) {
    return { ...base(c), status: "fail", detail: `output ${c.output} is missing` };
  }
  const values = selectPath(ctx.outputs[c.output!], c.field!);
  const re = c.pattern ? new RegExp(c.pattern) : null;
  const bad = values
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => typeof v !== "string" || v.trim() === "" || (re && !re.test(v)));
  return {
    ...base(c),
    status: bad.length === 0 ? "pass" : "fail",
    value: values.length === 0 ? null : (values.length - bad.length) / values.length,
    detail:
      bad.length === 0
        ? `${values.length} item(s) cite a source`
        : `${bad.length} item(s) without a valid source`,
    items: bad.length ? { invalid: bound(bad.map(({ i }) => i)) } : undefined,
  };
}

function schemaValid(c: CheckSpec, ctx: EvalContext): CheckResult {
  const output = ctx.loaded.spec.outputs.find((o) => o.name === c.output);
  const schemaRel = c.schema ?? output?.schema;
  if (!schemaRel) {
    return { ...base(c), status: "fail", detail: "no schema configured" };
  }
  const doc = ctx.outputs[c.output!];
  if (doc === null || doc === undefined) {
    return { ...base(c), status: "fail", detail: `output ${c.output} is missing` };
  }
  const schema = JSON.parse(
    fs.readFileSync(path.join(ctx.loaded.dir, schemaRel), "utf8"),
  ) as object;
  const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
    allErrors: true,
    strict: false,
  });
  const validate = ajv.compile(schema);
  const ok = Boolean(validate(doc));
  return {
    ...base(c),
    status: ok ? "pass" : "fail",
    detail: ok
      ? "output matches its schema"
      : `schema errors: ${ajv.errorsText(validate.errors, { separator: "; " })}`.slice(0, 500),
  };
}

/** Deterministic failure tags for a failed check, from the check and the job's evidence. */
export function failureTagsFor(r: CheckResult, ctx: EvalContext): FailureTag[] {
  const tags = new Set<FailureTag>();
  if (r.severity === "gate") {
    tags.add("policy-violation");
  }
  if (r.type === "deadline") {
    tags.add("latency");
  }
  if (ctx.events.some((e) => e.type === "loop_guard")) {
    tags.add("loop");
  }
  if (ctx.events.some((e) => e.type === "tool.result" && e.data.isError === true)) {
    tags.add("tool-error");
  }
  const outputMissing =
    r.type !== "deadline" &&
    r.severity !== "gate" &&
    (/output .* is missing/.test(r.detail) ||
      (checkOutput(r, ctx) !== undefined && ctx.outputs[checkOutput(r, ctx)!] == null));
  if (outputMissing) {
    tags.add("planning");
  } else if (
    ["valueMatch", "setMatch", "coverage", "citationsPresent", "schemaValid"].includes(r.type)
  ) {
    tags.add("wrong-context");
  }
  return FAILURE_TAGS.filter((t) => tags.has(t));
}

function checkOutput(r: CheckResult, ctx: EvalContext): string | undefined {
  return ctx.loaded.spec.checks.find((c) => c.id === r.id)?.output;
}

export function runCheck(c: CheckSpec, ctx: EvalContext): CheckResult {
  const r = runCheckRaw(c, ctx);
  return r.status === "fail" ? { ...r, failureTags: failureTagsFor(r, ctx) } : r;
}

function runCheckRaw(c: CheckSpec, ctx: EvalContext): CheckResult {
  try {
    switch (c.type) {
      case "noDeniedOrUnlisted":
        return noDeniedOrUnlisted(c, ctx);
      case "approvalBeforeAction":
        return approvalBeforeAction(c, ctx);
      case "noDuplicateActions":
        return noDuplicateActions(c, ctx);
      case "deadline":
        return deadline(c, ctx);
      case "valueMatch":
        return valueMatch(c, ctx);
      case "setMatch":
        return setMatch(c, ctx);
      case "coverage":
        return coverage(c, ctx);
      case "citationsPresent":
        return citationsPresent(c, ctx);
      case "schemaValid":
        return schemaValid(c, ctx);
      case "recovery":
        return {
          ...base(c),
          status: "skipped",
          detail: "recovery is scored from live jobs (phase 2)",
        };
      case "rubric":
        return {
          ...base(c),
          status: "skipped",
          detail: `model judge ${c.model ?? ""} not run in this release (info only)`,
        };
    }
  } catch (err) {
    return {
      ...base(c),
      status: "fail",
      detail: `check error: ${String(err instanceof Error ? err.message : err)}`,
    };
  }
}
