// Decisions on work items: approve, send back, cancel. ONLY a person decides. The gateway
// refuses agent and voice origins before this runs (see the workitems.decide handler); this
// module refuses any non-person actor again, so no other caller can bypass it.
//
// Approve needs: status awaiting_review; the pinned draft is still the artifact's latest version;
// every blocking check passing (checks are re-run now, against the pinned draft), or an explicit
// override with a reason, which is recorded on the item, in the evidence and in the audit log;
// and as many distinct approvers as the policy requires (e.g. a second approver above an amount).

import type { Project } from "../projects/types.js";
import type { Actor, WorkItem, WorkItemStatus } from "./types.js";
import { auditSafe } from "../audit/audit-log.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { getArtifact, isKnownIdentity, setArtifactStatus } from "../projects/artifacts.js";
import { applyTransition, checkSummary, recheck, type LifecycleOpts } from "./lifecycle.js";
import { blockingFailures, loadWorkQueuePolicy } from "./policy.js";
import { TERMINAL_STATUSES } from "./types.js";

export type Decision = "approve" | "send_back" | "cancel";
export const DECISIONS: readonly Decision[] = ["approve", "send_back", "cancel"];
export const MIN_OVERRIDE_REASON = 10;

export type DecideInput = {
  decision?: unknown;
  comment?: unknown;
  override?: { reason?: unknown } | null;
};

export class DecisionRefused extends Error {
  readonly code: string;
  readonly details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

function cleanComment(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 2000) : null;
}

export function decideWorkItem(
  project: Project,
  id: string,
  input: DecideInput,
  actor: Actor,
  expectedRevision: number | undefined,
  opts: LifecycleOpts = {},
): WorkItem {
  if (actor.kind !== "person") {
    throw new DecisionRefused("not_a_person", "only a person may decide on a work item");
  }
  if (project.archived) {
    throw new Error("project is archived");
  }
  const decision = input.decision as Decision;
  if (!DECISIONS.includes(decision)) {
    throw new Error("decision must be approve, send_back or cancel");
  }
  const home = opts.home ?? resolveKoloHome();
  const comment = cleanComment(input.comment);
  const overrideReason =
    input.override && typeof input.override.reason === "string"
      ? input.override.reason.trim().slice(0, 2000)
      : null;
  // Filled inside the transition; read after it commits.
  const out: {
    override: { reason: string; policyIds: string[] } | null;
    artifact: "approved" | "draft" | null;
  } = { override: null, artifact: null };

  const item = applyTransition(
    project,
    id,
    expectedRevision,
    (cur, now) => {
      if (TERMINAL_STATUSES.has(cur.status)) {
        throw new DecisionRefused("terminal", `work item is already ${cur.status}`);
      }
      const at = now.toISOString();
      if (decision === "cancel") {
        if (!comment) {
          throw new DecisionRefused("comment_required", "cancel needs a comment");
        }
        return { next: cur, spec: { action: "decide.cancel", actor, to: "cancelled", comment } };
      }
      if (cur.status !== "awaiting_review") {
        throw new DecisionRefused(
          "not_awaiting_review",
          `only an item awaiting review can be ${decision === "approve" ? "approved" : "sent back"} (it is ${cur.status})`,
        );
      }
      if (decision === "send_back") {
        if (!comment) {
          throw new DecisionRefused(
            "comment_required",
            "send back needs a comment for the drafter",
          );
        }
        cur.approvals = [];
        cur.override = null;
        out.artifact = cur.draft ? "draft" : null;
        return { next: cur, spec: { action: "decide.send_back", actor, to: "sent_back", comment } };
      }
      // approve
      if (cur.draft) {
        const latest = getArtifact(cur.draft.artifactId, null, { home }).version;
        if (latest !== cur.draft.version) {
          throw new DecisionRefused(
            "draft_changed",
            `the draft has a newer version (${latest}); attach it with workitems.update first`,
            { pinned: cur.draft.version, latest },
          );
        }
      }
      if (cur.approvals.some((a) => a.by === actor.id)) {
        throw new DecisionRefused("already_approved", "you have already approved this item");
      }
      const policy = loadWorkQueuePolicy(project, home);
      if (
        policy.separationOfDuties &&
        isKnownIdentity(actor.id) &&
        isKnownIdentity(cur.createdBy) &&
        actor.id === cur.createdBy
      ) {
        throw new DecisionRefused(
          "separation_of_duties",
          "the person who created this item cannot approve it",
        );
      }
      recheck(project, cur, now, home);
      const failing = blockingFailures(cur.checks).map((c) => c.policyId);
      if (failing.length > 0) {
        if (!overrideReason || overrideReason.length < MIN_OVERRIDE_REASON) {
          throw new DecisionRefused(
            "checks_failed",
            `blocking checks failed (${failing.join(", ")}); approve with override.reason (at least ${MIN_OVERRIDE_REASON} characters) to proceed`,
            { failing },
          );
        }
        out.override = { reason: overrideReason, policyIds: failing };
        cur.override = { by: actor.id, at, reason: overrideReason, policyIds: failing };
      }
      cur.approvals.push({ by: actor.id, at, comment });
      const complete = cur.approvals.length >= cur.requiredApprovals;
      const to: WorkItemStatus = complete ? "approved" : "awaiting_review";
      out.artifact = complete && cur.draft ? "approved" : null;
      return {
        next: cur,
        spec: {
          action: "decide.approve",
          actor,
          to,
          comment,
          detail: {
            approvals: cur.approvals.length,
            requiredApprovals: cur.requiredApprovals,
            checks: checkSummary(cur),
            draft: cur.draft
              ? {
                  artifactId: cur.draft.artifactId,
                  version: cur.draft.version,
                  sha256: cur.draft.sha256,
                }
              : null,
            ...(out.override ? { override: out.override } : {}),
          },
        },
      };
    },
    opts,
  );

  if (out.override) {
    const o = out.override;
    void auditSafe({
      identity: actor.id,
      scope: project.id,
      action: "workitem.override",
      outcome: "ok",
      source: "gateway.workitems",
      detail: { id, policyIds: o.policyIds, reason: o.reason },
    });
  }
  if (out.artifact && item.draft) {
    syncArtifact(project, item, out.artifact, actor, home);
  }
  return item;
}

/** Keep the draft artifact's review status in step with the decision (best effort, audited). */
function syncArtifact(
  project: Project,
  item: WorkItem,
  to: "approved" | "draft",
  actor: Actor,
  home: string,
): void {
  const artifactId = item.draft!.artifactId;
  try {
    const cur = getArtifact(artifactId, null, { home }).artifact.status;
    if (to === "approved") {
      if (cur === "draft") {
        setArtifactStatus({ id: artifactId, status: "review" }, actor.id, { home });
      }
      if (cur !== "approved") {
        setArtifactStatus(
          { id: artifactId, status: "approved", note: `work item ${item.id}` },
          actor.id,
          { home },
        );
      }
    } else if (cur === "review") {
      setArtifactStatus(
        { id: artifactId, status: "draft", note: `sent back: ${item.id}` },
        actor.id,
        {
          home,
        },
      );
    }
  } catch (err) {
    void auditSafe({
      identity: actor.id,
      scope: project.id,
      action: "workitem.artifact_sync",
      outcome: "failed",
      source: "gateway.workitems",
      detail: { id: item.id, artifactId, to, error: String(err) },
    });
  }
}
