// Workflow Evaluator: acceptance specs (design/workflow-evaluator.md §3).
//
// A spec is YAML at <dir>/spec.yaml, signed like the policy (detached <dir>/spec.yaml.sig by a
// pinned policy owner). Fixture files are content-addressed in the spec, so changing a golden
// dataset changes the spec bytes and invalidates its signature.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import {
  addOwner,
  type AttestationResult,
  loadOrCreateOwnerKey,
  sha256Hex,
  signPolicyFile,
  verifyPolicyAttestation,
} from "../policy/attestation.js";
import { resolvePolicyLocations } from "../policy/paths.js";

export const SPEC_API_VERSION = "kurahi.eval/v1";
export const SPEC_FILE = "spec.yaml";
export const SPEC_SIG_FILE = "spec.yaml.sig";

const Severity = z.enum(["gate", "critical", "major", "minor", "info"]);
export type Severity = z.infer<typeof Severity>;

export const CHECK_TYPES = [
  "noDeniedOrUnlisted",
  "approvalBeforeAction",
  "noDuplicateActions",
  "deadline",
  "valueMatch",
  "setMatch",
  "coverage",
  "citationsPresent",
  "schemaValid",
  "recovery",
  "rubric",
] as const;
export type CheckType = (typeof CHECK_TYPES)[number];

const CheckSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(CHECK_TYPES),
    severity: Severity,
    judge: z.enum(["deterministic", "model"]).default("deterministic"),
    weight: z.number().positive().optional(),
    output: z.string().optional(),
    field: z.string().optional(),
    expectedFrom: z.string().optional(),
    metric: z.enum(["precision", "recall", "f1", "exact"]).optional(),
    threshold: z.number().min(0).max(1).optional(),
    tolerance: z.number().min(0).optional(),
    relative: z.boolean().optional(),
    actions: z.array(z.string()).optional(),
    approvers: z.array(z.string()).optional(),
    allowedTools: z.array(z.string()).optional(),
    pattern: z.string().optional(),
    schema: z.string().optional(),
    event: z.string().optional(),
    before: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional(),
    timezone: z.string().optional(),
    model: z.string().optional(),
    rubric: z.string().optional(),
  })
  .strict();
export type CheckSpec = z.infer<typeof CheckSchema>;

const FixtureSchema = z
  .object({
    id: z.string().min(1),
    files: z.record(z.string(), z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict()),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export const SpecSchema = z
  .object({
    apiVersion: z.literal(SPEC_API_VERSION),
    workflow: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/),
    version: z.number().int().positive(),
    title: z.string(),
    owner: z.string().optional(),
    agent: z.string(),
    jobKind: z.string(),
    driver: z.string().optional(),
    inputs: z
      .object({
        fixtures: z.array(FixtureSchema).min(1),
        live: z
          .object({
            match: z.record(z.string(), z.string()).optional(),
            sample: z
              .object({ reviewRate: z.number().min(0).max(1), minPerDay: z.number().int().min(0) })
              .optional(),
          })
          .optional(),
      })
      .strict(),
    outputs: z
      .array(
        z
          .object({
            name: z.string(),
            from: z.enum(["file", "finalText", "toolResult"]),
            path: z.string().optional(),
            schema: z.string().optional(),
          })
          .strict(),
      )
      .min(1),
    consequential: z
      .array(
        z
          .object({
            id: z.string(),
            tool: z.string(),
            key: z.array(z.string()).min(1),
            requiresApproval: z.boolean().default(false),
          })
          .strict(),
      )
      .default([]),
    checks: z.array(CheckSchema).min(1),
    reliability: z
      .object({
        repeat: z.number().int().min(1).max(100).default(1),
        minPassAll: z.number().min(0).max(1).default(1),
      })
      .strict()
      .optional(),
    // Correction effort (optional): targets the human reviews of a run are compared against. Additive
    // to kurahi.eval/v1; specs without it are unchanged.
    humanReview: z
      .object({
        targets: z
          .object({
            medianMinutes: z.number().min(0).optional(),
            p90Minutes: z.number().min(0).optional(),
            minAcceptedUnchanged: z.number().min(0).max(1).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    scoring: z
      .object({
        passThreshold: z.number().min(0).max(100).default(85),
        maxRegression: z.number().min(0).default(2),
      })
      .default({ passThreshold: 85, maxRegression: 2 }),
  })
  .strict();
export type WorkflowSpec = z.infer<typeof SpecSchema>;

export type LoadedSpec = {
  dir: string;
  spec: WorkflowSpec;
  bytes: Buffer;
  sha256: string;
};

export class SpecError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "SpecError";
  }
}

export function loadSpec(dir: string): LoadedSpec {
  const file = path.join(dir, SPEC_FILE);
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    throw new SpecError(`no ${SPEC_FILE} in ${dir}`);
  }
  let raw: unknown;
  try {
    raw = YAML.parse(bytes.toString("utf8"));
  } catch (err) {
    throw new SpecError(`${file}: not valid YAML: ${String(err)}`);
  }
  const parsed = SpecSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new SpecError(`${file}: invalid spec`, issues);
  }
  return { dir, spec: parsed.data, bytes, sha256: sha256Hex(bytes) };
}

export type LintFinding = { level: "error" | "warning"; check?: string; message: string };

/**
 * Rules beyond the schema. The non-negotiable one: a model judge is never a gate, never above
 * `info`, and never the only check on an output.
 */
export function lintSpec(loaded: LoadedSpec): LintFinding[] {
  const { spec } = loaded;
  const out: LintFinding[] = [];
  const ids = new Set<string>();
  const outputs = new Set(spec.outputs.map((o) => o.name));
  const actions = new Set(spec.consequential.map((c) => c.id));
  for (const c of spec.checks) {
    if (ids.has(c.id)) {
      out.push({ level: "error", check: c.id, message: "duplicate check id" });
    }
    ids.add(c.id);
    if (c.judge === "model" || c.type === "rubric") {
      if (c.type !== "rubric") {
        out.push({
          level: "error",
          check: c.id,
          message: `judge: model is only allowed on rubric checks, not ${c.type}`,
        });
      }
      if (c.judge !== "model") {
        out.push({
          level: "error",
          check: c.id,
          message: "rubric checks must declare judge: model",
        });
      }
      if (c.severity === "gate") {
        out.push({
          level: "error",
          check: c.id,
          message: "a judge: model check can never be a gate",
        });
      } else if (c.severity !== "info") {
        out.push({
          level: "error",
          check: c.id,
          message: `a judge: model check must have severity info, not ${c.severity}`,
        });
      }
    }
    if (c.severity === "gate" && c.weight !== undefined) {
      out.push({ level: "error", check: c.id, message: "gates are pass/fail and never weighted" });
    }
    if (c.severity !== "gate" && c.severity !== "info" && c.weight === undefined) {
      out.push({ level: "error", check: c.id, message: "quality checks need a weight" });
    }
    if (c.output && !outputs.has(c.output)) {
      out.push({ level: "error", check: c.id, message: `unknown output ${c.output}` });
    }
    for (const a of c.actions ?? []) {
      if (!actions.has(a)) {
        out.push({ level: "error", check: c.id, message: `unknown consequential action ${a}` });
      }
    }
    const needs: Partial<Record<CheckType, Array<keyof CheckSpec>>> = {
      approvalBeforeAction: ["actions"],
      noDuplicateActions: ["actions"],
      deadline: ["before", "timezone"],
      valueMatch: ["output", "field", "expectedFrom"],
      setMatch: ["output", "field", "expectedFrom", "metric", "threshold"],
      coverage: ["output", "field", "expectedFrom"],
      citationsPresent: ["output", "field"],
      schemaValid: ["output"],
      rubric: ["output", "model", "rubric"],
    };
    for (const k of needs[c.type] ?? []) {
      if (c[k] === undefined) {
        out.push({ level: "error", check: c.id, message: `${c.type} needs ${String(k)}` });
      }
    }
  }
  // A model judge must never be the only check on an output.
  for (const o of outputs) {
    const on = spec.checks.filter((c) => c.output === o);
    if (on.length > 0 && on.every((c) => c.judge === "model")) {
      out.push({ level: "error", message: `output ${o} is checked only by a model judge` });
    }
  }
  if (!spec.checks.some((c) => c.severity === "gate")) {
    out.push({ level: "warning", message: "no mandatory security gate is defined" });
  }
  return out;
}

export type FixtureDigestIssue = {
  fixture: string;
  file: string;
  expected: string;
  actual: string | null;
};

/** Recompute every fixture file's SHA-256 and compare with the spec. */
export function verifyFixtureDigests(loaded: LoadedSpec): FixtureDigestIssue[] {
  const issues: FixtureDigestIssue[] = [];
  for (const f of loaded.spec.inputs.fixtures) {
    for (const [name, { sha256 }] of Object.entries(f.files)) {
      let actual: string | null = null;
      try {
        actual = sha256Hex(fs.readFileSync(fixturePath(loaded, f.id, name)));
      } catch {
        actual = null;
      }
      if (actual !== sha256) {
        issues.push({ fixture: f.id, file: name, expected: sha256, actual });
      }
    }
  }
  return issues;
}

export function fixturePath(loaded: LoadedSpec, fixtureId: string, file: string): string {
  return path.join(loaded.dir, "fixtures", fixtureId, file);
}

/** Rewrite the sha256 values in spec.yaml from the files on disk (authoring helper). */
export function updateFixtureDigests(dir: string): number {
  const file = path.join(dir, SPEC_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  const fixtures = doc.getIn(["inputs", "fixtures"]) as YAML.YAMLSeq | undefined;
  let changed = 0;
  for (const item of fixtures?.items ?? []) {
    const fx = item as YAML.YAMLMap;
    const id = String(fx.get("id"));
    const files = fx.get("files") as YAML.YAMLMap | undefined;
    for (const pair of files?.items ?? []) {
      const name = String((pair.key as YAML.Scalar).value ?? pair.key);
      const actual = sha256Hex(fs.readFileSync(path.join(dir, "fixtures", id, name)));
      const entry = pair.value as YAML.YAMLMap;
      if (entry.get("sha256") !== actual) {
        entry.set("sha256", actual);
        changed += 1;
      }
    }
  }
  if (changed > 0) {
    fs.writeFileSync(file, doc.toString());
  }
  return changed;
}

export function signSpec(dir: string, env: NodeJS.ProcessEnv = process.env, now?: Date) {
  const loc = resolvePolicyLocations(env);
  const key = loadOrCreateOwnerKey(loc.ownerKeyPath);
  // Same trust model as `kurahi policy sign`: the local owner key is pinned as a policy owner.
  addOwner(loc.ownersPath, { publicKey: key.publicKey, label: "eval spec signer" }, now);
  return signPolicyFile({
    policyPath: path.join(dir, SPEC_FILE),
    signaturePath: path.join(dir, SPEC_SIG_FILE),
    key,
    now,
  });
}

export function verifySpecSignature(
  loaded: LoadedSpec,
  env: NodeJS.ProcessEnv = process.env,
): AttestationResult {
  const loc = resolvePolicyLocations(env);
  return verifyPolicyAttestation({
    policyBytes: loaded.bytes,
    signaturePath: path.join(loaded.dir, SPEC_SIG_FILE),
    ownersPath: loc.ownersPath,
  });
}
