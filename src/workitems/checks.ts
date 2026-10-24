// Work queue policy evaluation: runs the rules of a WorkQueuePolicy (see policy.ts) against an
// item's fields, source documents and pinned draft text. Deterministic for the same inputs.

import type { PolicyRule, WorkQueuePolicy } from "./policy.js";
import type { CheckResult, WorkItem, WorkItemCheck } from "./types.js";

/** Local calendar day number (days since epoch) of an instant in a timezone. */
function localDay(at: Date, tz: string): number {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
  return Math.floor(Date.parse(`${ymd}T00:00:00Z`) / 86_400_000);
}

function dayOf(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(value)) {
    return null;
  }
  const ms = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 86_400_000);
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function excerpt(haystack: string, idx: number, len: number): string {
  return haystack.slice(Math.max(0, idx - 30), Math.min(haystack.length, idx + len + 30));
}

type Outcome = { result: CheckResult; evidence: Record<string, unknown>; approvers?: number };

function evaluateRule(
  rule: PolicyRule,
  item: Pick<WorkItem, "source">,
  draft: string | null,
  now: Date,
  tz: string,
): Outcome {
  const fields = item.source.fields;
  const violated = rule.severity;
  switch (rule.kind) {
    case "required": {
      const missing = rule.fields.filter((f) => isEmpty(fields[f]));
      return {
        result: missing.length ? violated : "pass",
        evidence: { fields: rule.fields, missing },
      };
    }
    case "threshold": {
      const raw = fields[rule.field];
      const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
      if (isEmpty(raw)) {
        return { result: "pass", evidence: { field: rule.field, present: false } };
      }
      if (!Number.isFinite(value)) {
        return {
          result: violated,
          evidence: { field: rule.field, value: raw, error: "not a number" },
        };
      }
      const ev = {
        field: rule.field,
        value,
        max: rule.max,
        warnAbove: rule.warnAbove,
        secondApproverAbove: rule.secondApproverAbove,
      };
      const approvers =
        rule.secondApproverAbove !== null && value > rule.secondApproverAbove ? 2 : 1;
      if (rule.max !== null && value > rule.max) {
        return { result: violated, evidence: { ...ev, exceeded: "max" }, approvers };
      }
      if (approvers > 1) {
        return { result: "warn", evidence: { ...ev, exceeded: "secondApproverAbove" }, approvers };
      }
      if (rule.warnAbove !== null && value > rule.warnAbove) {
        return { result: "warn", evidence: { ...ev, exceeded: "warnAbove" } };
      }
      return { result: "pass", evidence: ev };
    }
    case "date": {
      const raw = fields[rule.field];
      if (isEmpty(raw)) {
        return { result: "pass", evidence: { field: rule.field, present: false } };
      }
      const day = dayOf(raw);
      if (day === null) {
        return {
          result: violated,
          evidence: { field: rule.field, value: raw, error: "not a date (YYYY-MM-DD)" },
        };
      }
      const today = localDay(now, tz);
      const lead = day - today;
      const problems: string[] = [];
      if (rule.notInPast && lead < 0) {
        problems.push("in the past");
      }
      if (rule.minLeadDays !== null && lead < rule.minLeadDays) {
        problems.push(`less than ${rule.minLeadDays} days ahead`);
      }
      if (rule.maxLeadDays !== null && lead > rule.maxLeadDays) {
        problems.push(`more than ${rule.maxLeadDays} days ahead`);
      }
      if (rule.before) {
        const other = dayOf(fields[rule.before]);
        if (other !== null && day > other) {
          problems.push(`after ${rule.before}`);
        }
      }
      return {
        result: problems.length ? violated : "pass",
        evidence: { field: rule.field, value: raw, leadDays: lead, timezone: tz, problems },
      };
    }
    case "forbiddenPhrases": {
      const haystacks: Array<{ where: string; text: string }> = [];
      if (rule.target !== "fields" && draft) {
        haystacks.push({ where: "draft", text: draft });
      }
      if (rule.target !== "draft") {
        for (const [k, v] of Object.entries(fields)) {
          if (typeof v === "string") {
            haystacks.push({ where: `field:${k}`, text: v });
          }
        }
      }
      const hits: Array<{ phrase: string; where: string; excerpt: string }> = [];
      for (const phrase of rule.phrases) {
        for (const h of haystacks) {
          const idx = h.text.toLowerCase().indexOf(phrase.toLowerCase());
          if (idx >= 0) {
            hits.push({ phrase, where: h.where, excerpt: excerpt(h.text, idx, phrase.length) });
          }
        }
      }
      return {
        result: hits.length ? violated : "pass",
        evidence: { target: rule.target, checkedDraft: draft !== null, hits: hits.slice(0, 20) },
      };
    }
    case "attachment": {
      const count = item.source.documents.length;
      return { result: count < rule.min ? violated : "pass", evidence: { min: rule.min, count } };
    }
  }
}

export function ruleApplies(rule: PolicyRule, item: Pick<WorkItem, "type" | "queue">): boolean {
  return (
    (rule.types.length === 0 || rule.types.includes(item.type)) &&
    (rule.queues.length === 0 || rule.queues.includes(item.queue))
  );
}

/** Run every applicable rule. Returns the checks and the distinct approvals the item needs. */
export function evaluatePolicy(
  policy: WorkQueuePolicy,
  item: Pick<WorkItem, "type" | "queue" | "source">,
  draft: { text: string; version: number } | null,
  now: Date = new Date(),
): { checks: WorkItemCheck[]; requiredApprovals: number } {
  const checkedAt = now.toISOString();
  if (policy.error) {
    return {
      checks: [
        {
          policyId: "policy.invalid",
          label: { ja: "ポリシーを読み込めません", en: "Policy could not be loaded" },
          result: "fail",
          blocking: true,
          evidence: { error: policy.error, path: policy.source.path },
          checkedAt,
          draftVersion: draft?.version ?? null,
          policyDigest: policy.digest,
        },
      ],
      requiredApprovals: 1,
    };
  }
  let requiredApprovals = 1;
  const checks: WorkItemCheck[] = [];
  for (const rule of policy.rules) {
    if (!ruleApplies(rule, item)) {
      continue;
    }
    const out = evaluateRule(rule, item, draft?.text ?? null, now, policy.timezone);
    requiredApprovals = Math.max(requiredApprovals, out.approvers ?? 1);
    checks.push({
      policyId: rule.id,
      label: rule.label,
      result: out.result,
      blocking: rule.blocking,
      evidence: { kind: rule.kind, ...out.evidence },
      checkedAt,
      draftVersion: draft?.version ?? null,
      policyDigest: policy.digest,
    });
  }
  return { checks, requiredApprovals };
}

/** Checks that stop approval: failed and blocking. */
export function blockingFailures(checks: WorkItemCheck[]): WorkItemCheck[] {
  return checks.filter((c) => c.result === "fail" && c.blocking);
}
