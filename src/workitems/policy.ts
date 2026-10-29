// Work queue policy: a small declarative rules engine per Project. The policy file
// (`workqueue.yaml` or `.json`) names the queues and the rules; each rule yields pass / fail /
// warn with the evidence it looked at. Rules are deterministic: the same item, draft and policy
// always give the same result. An unreadable or invalid policy fails closed (one blocking check).
//
// Lookup order (first found wins):
//   1. <project folder>/context/workqueue.(yaml|yml|json)     the client's own policy
//   2. <KOLO_HOME>/projects/<id>/workqueue.(yaml|yml|json)     set by an administrator
//   3. templates/projects/packs/<templateId>/workqueue.yaml    the template's example policy

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Project } from "../projects/types.js";
import type { SettlementSod } from "./handoff.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { projectDataDir } from "../projects/store.js";
import { resolveTemplatesDir } from "../projects/templates.js";
import { parseAccess, type AccessDef } from "./access.js";
import { FIELD_RE, ID_RE, num, strList, text, types, type Text } from "./parse-util.js";
import { parseRoutes, type RouteDef } from "./routes.js";
import {
  DEPARTMENT_IDS,
  isDepartmentId,
  type DepartmentFilter,
  type DepartmentId,
  type WorkItemType,
} from "./types.js";

export type QueueDef = {
  id: string;
  name: Text;
  types: WorkItemType[];
  slaHours: number | null;
  defaultAgent: string | null;
  /** Department workspace the queue shows in (a view, not a permission); absent = unmapped. */
  department?: DepartmentId;
};

type RuleBase = {
  id: string;
  label: Text;
  /** Result when the rule is violated: fail (default) or warn. */
  severity: "fail" | "warn";
  /** A failing blocking rule stops approval (default: true for fail). */
  blocking: boolean;
  /**
   * What a person's override of this failing rule approves. "provisional": the item may be
   * approved only as a provisional release (e.g. a 暫定見積 with its open items visible), never
   * as a final approval; the item records that outcome. Absent: an ordinary override.
   */
  overrideOutcome?: "provisional";
  types: WorkItemType[];
  queues: string[];
};

export type PolicyRule = RuleBase &
  (
    | { kind: "required"; fields: string[] }
    | {
        kind: "threshold";
        field: string;
        max: number | null;
        warnAbove: number | null;
        secondApproverAbove: number | null;
      }
    | {
        kind: "date";
        field: string;
        notInPast: boolean;
        minLeadDays: number | null;
        maxLeadDays: number | null;
        before: string | null;
      }
    | { kind: "forbiddenPhrases"; phrases: string[]; target: "draft" | "fields" | "both" }
    | { kind: "attachment"; min: number }
  );

export type WorkQueuePolicy = {
  version: 1;
  timezone: string;
  /** When true, the person who created an item may not approve it (known identities only). */
  separationOfDuties: boolean;
  /** Settlement attestation by someone who handled the case: refused (strict, default) or recorded (warn). */
  settlementSod: SettlementSod;
  queues: QueueDef[];
  rules: PolicyRule[];
  /** 稟議 staged approval routes (first matching route wins; none = single-stage review). */
  routes: RouteDef[];
  /** Principal → role / department mapping for routes and read access. */
  access: AccessDef;
  /** Where the policy came from and its SHA-256 (recorded with every check). */
  source: { kind: "project" | "admin" | "template" | "none"; path: string | null };
  digest: string;
  /** Set when the file could not be parsed; checks then fail closed. */
  error: string | null;
};

const MAX_POLICY_BYTES = 256 * 1024;
const NAMES = ["workqueue.yaml", "workqueue.yml", "workqueue.json"];

function field(raw: unknown, ruleId: string): string {
  if (typeof raw !== "string" || !FIELD_RE.test(raw)) {
    throw new Error(`rule ${ruleId}: field is required`);
  }
  return raw;
}

function parseRule(raw: unknown, i: number): PolicyRule {
  const r = (raw ?? {}) as Record<string, unknown>;
  const id = typeof r.id === "string" && ID_RE.test(r.id) ? r.id : null;
  if (!id) {
    throw new Error(`rule ${i + 1}: id is required (lowercase letters, digits, . _ -)`);
  }
  const severity = r.severity === "warn" ? "warn" : "fail";
  const base: RuleBase = {
    id,
    label: text(r.label ?? id),
    severity,
    blocking: severity === "fail" && r.blocking !== false,
    ...(r.overrideOutcome === "provisional" ? { overrideOutcome: "provisional" as const } : {}),
    types: types(r.types),
    queues: strList(r.queues, ID_RE),
  };
  switch (r.kind) {
    case "required": {
      const fields = strList(r.fields, FIELD_RE);
      if (!fields.length) {
        throw new Error(`rule ${id}: fields is required`);
      }
      return { ...base, kind: "required", fields };
    }
    case "threshold":
    case "amount":
      return {
        ...base,
        kind: "threshold",
        field: field(r.field, id),
        max: num(r.max),
        warnAbove: num(r.warnAbove),
        secondApproverAbove: num(r.secondApproverAbove),
      };
    case "date":
      return {
        ...base,
        kind: "date",
        field: field(r.field, id),
        notInPast: r.notInPast === true,
        minLeadDays: num(r.minLeadDays),
        maxLeadDays: num(r.maxLeadDays),
        before: typeof r.before === "string" && FIELD_RE.test(r.before) ? r.before : null,
      };
    case "forbiddenPhrases": {
      const phrases = Array.isArray(r.phrases)
        ? r.phrases.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
        : [];
      if (!phrases.length) {
        throw new Error(`rule ${id}: phrases is required`);
      }
      const target = r.target === "fields" || r.target === "both" ? r.target : "draft";
      return { ...base, kind: "forbiddenPhrases", phrases: phrases.slice(0, 200), target };
    }
    case "attachment":
      return { ...base, kind: "attachment", min: Math.max(1, num(r.min) ?? 1) };
    default:
      throw new Error(`rule ${id}: unknown kind ${String(r.kind)}`);
  }
}

function parseQueue(raw: unknown, i: number): QueueDef {
  const q = (raw ?? {}) as Record<string, unknown>;
  if (typeof q.id !== "string" || !ID_RE.test(q.id)) {
    throw new Error(`queue ${i + 1}: id is required`);
  }
  const sla = num(q.slaHours);
  if (q.department !== undefined && q.department !== null && !isDepartmentId(q.department)) {
    throw new Error(
      `queue ${q.id}: unknown department ${JSON.stringify(q.department)} (expected one of ${DEPARTMENT_IDS.join(", ")})`,
    );
  }
  return {
    id: q.id,
    name: text(q.name ?? q.id),
    types: types(q.types),
    slaHours: sla !== null && sla > 0 ? sla : null,
    defaultAgent:
      typeof q.defaultAgent === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(q.defaultAgent)
        ? q.defaultAgent
        : null,
    ...(isDepartmentId(q.department) ? { department: q.department } : {}),
  };
}

/**
 * Queue predicate for a department view: queues mapped to `department`, or (for `unmapped`) queues
 * with no department, including queue ids the policy does not define. Apply after access filters.
 */
export function departmentQueueMatcher(
  policy: Pick<WorkQueuePolicy, "queues">,
  department: DepartmentFilter,
): (queueId: string) => boolean {
  const mapped = new Map(policy.queues.map((q) => [q.id, q.department]));
  return department === "unmapped"
    ? (queueId) => mapped.get(queueId) === undefined
    : (queueId) => mapped.get(queueId) === department;
}

/** Parse a policy document (YAML or JSON text). Throws with a readable message. */
export function parsePolicy(rawText: string): Omit<WorkQueuePolicy, "source" | "digest" | "error"> {
  const doc = YAML.parse(rawText) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") {
    throw new Error("policy must be a YAML or JSON object");
  }
  const queues = (Array.isArray(doc.queues) ? doc.queues : []).map(parseQueue);
  const rules = (Array.isArray(doc.rules) ? doc.rules : []).map(parseRule);
  const ids = new Set<string>();
  for (const r of rules) {
    if (ids.has(r.id)) {
      throw new Error(`rule ${r.id} is defined twice`);
    }
    ids.add(r.id);
  }
  const tz = typeof doc.timezone === "string" ? doc.timezone : "Asia/Tokyo";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
  } catch {
    throw new Error(`unknown timezone ${tz}`);
  }
  return {
    version: 1,
    timezone: tz,
    separationOfDuties: doc.separationOfDuties === true,
    // Only an explicit "warn" relaxes it; anything else stays strict.
    settlementSod: doc.settlementSod === "warn" ? "warn" : "strict",
    queues,
    rules,
    routes: parseRoutes(doc.routes),
    access: parseAccess(doc.access),
  };
}

function digestOf(t: string): string {
  return createHash("sha256").update(t, "utf8").digest("hex");
}

export function policyCandidates(
  project: Pick<Project, "id" | "folder" | "templateId">,
  home: string = resolveKoloHome(),
): Array<{ kind: "project" | "admin" | "template"; path: string }> {
  const out: Array<{ kind: "project" | "admin" | "template"; path: string }> = [];
  for (const n of NAMES) {
    out.push({ kind: "project", path: path.join(project.folder, "context", n) });
  }
  for (const n of NAMES) {
    out.push({ kind: "admin", path: path.join(projectDataDir(project.id, home), n) });
  }
  if (project.templateId && /^[a-z][a-z0-9-]{1,63}$/.test(project.templateId)) {
    for (const n of NAMES) {
      out.push({
        kind: "template",
        path: path.join(resolveTemplatesDir(), "packs", project.templateId, n),
      });
    }
  }
  return out;
}

export function loadWorkQueuePolicy(
  project: Pick<Project, "id" | "folder" | "templateId">,
  home?: string,
): WorkQueuePolicy {
  for (const c of policyCandidates(project, home)) {
    let raw: string;
    try {
      const st = fs.statSync(c.path);
      if (!st.isFile()) {
        continue;
      }
      if (st.size > MAX_POLICY_BYTES) {
        return failedPolicy(c, "", "policy file is larger than 256 KB");
      }
      raw = fs.readFileSync(c.path, "utf8");
    } catch (err) {
      // Only a missing file falls through to the next candidate. A policy that exists but cannot
      // be read (EACCES, EIO, ...) fails closed: skipping it would let a lower-priority policy,
      // such as an administrator's settlementSod "warn", take effect without anyone noticing.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        continue;
      }
      return failedPolicy(c, "", `policy file could not be read (${code ?? "unknown error"})`);
    }
    try {
      const parsed = parsePolicy(raw);
      // Relaxing settlement SoD is an administrator's decision. The project folder belongs to the
      // client (people, and agents with a writable scope, can edit it) and a template is only an
      // example, so "warn" from either is read as strict.
      if (c.kind !== "admin") {
        parsed.settlementSod = "strict";
      }
      return { ...parsed, source: c, digest: digestOf(raw), error: null };
    } catch (err) {
      return failedPolicy(c, raw, err instanceof Error ? err.message : String(err));
    }
  }
  return {
    version: 1,
    timezone: "Asia/Tokyo",
    separationOfDuties: false,
    settlementSod: "strict",
    queues: [],
    rules: [],
    routes: [],
    access: parseAccess(undefined),
    source: { kind: "none", path: null },
    digest: digestOf(""),
    error: null,
  };
}

function failedPolicy(
  c: { kind: "project" | "admin" | "template"; path: string },
  raw: string,
  error: string,
): WorkQueuePolicy {
  return {
    version: 1,
    timezone: "Asia/Tokyo",
    separationOfDuties: false,
    settlementSod: "strict",
    queues: [],
    rules: [],
    routes: [],
    access: parseAccess(undefined),
    source: c,
    digest: digestOf(raw),
    error,
  };
}

export { blockingFailures, evaluatePolicy, ruleApplies } from "./checks.js";
