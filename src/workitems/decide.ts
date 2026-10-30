// Decisions on work items: approve, send back, cancel. ONLY a person decides. The gateway
// refuses agent and voice origins before this runs (see the workitems.decide handler); this
// module refuses any non-person actor again, so no other caller can bypass it.
//
// Approve needs: status awaiting_review; the pinned draft is still the artifact's latest version;
// every blocking check passing (checks are re-run now, against the pinned draft), or an explicit
// override with a reason, which is recorded on the item, in the evidence and in the audit log;
// and as many distinct approvers as the policy requires (e.g. a second approver above an amount).
//
// Decisions act on the CURRENT stage of the item's route (routes.ts): the person must be one of
// the stage's approvers, an unexpired delegate of one, or an escalation target once the stage
// has escalated. Approving the last stage approves the item; send back follows the stage's
// onReturn (the requester, or the previous stage).

import type { Project } from "../projects/types.js";
import type { Actor, WorkItem, WorkItemStatus } from "./types.js";
import { auditSafe } from "../audit/audit-log.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { getArtifact, isKnownIdentity, setArtifactStatus } from "../projects/artifacts.js";
import { actedInStage, currentStage, deciderVia, isPrivileged } from "./access.js";
import { changedDocuments } from "./documents.js";
import { WorkItemRefused } from "./errors.js";
import { assertNoFraudFlag } from "./flags.js";
import { applyTransition, checkSummary, recheck, type LifecycleOpts } from "./lifecycle.js";
import { blockingFailures, loadWorkQueuePolicy, type WorkQueuePolicy } from "./policy.js";
import { activateStage, resetStage, routeApprovals, startRoute } from "./routes.js";
import { TERMINAL_STATUSES } from "./types.js";

export type Decision = "approve" | "send_back" | "cancel";
export const DECISIONS: readonly Decision[] = ["approve", "send_back", "cancel"];
export const MIN_OVERRIDE_REASON = 10;

export type DecideInput = {
  decision?: unknown;
  comment?: unknown;
  override?: { reason?: unknown } | null;
};

/** Kept under its earlier name: every decision refusal is a WorkItemRefused with a code. */
export const DecisionRefused = WorkItemRefused;
export type DecisionRefused = WorkItemRefused;

/**
 * Step-up for an approve (gateway.identity.stepUp): called with the item as it is now, inside the
 * transition. A refusal stops the approval; otherwise its evidence block (how the person
 * authenticated; never tokens) is recorded in the evidence, history and audit as `authn`.
 */
export type ApproveAuthn = (
  item: WorkItem,
) =>
  | { ok: true; evidence: Record<string, unknown> | null }
  | { ok: false; message: string; details: Record<string, unknown> };

function cleanComment(raw: unknown): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, 2000) : null;
}

export function decideWorkItem(
  project: Project,
  id: string,
  input: DecideInput,
  actor: Actor,
  expectedRevision: number | undefined,
  opts: LifecycleOpts & { authn?: ApproveAuthn } = {},
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
    override: { reason: string; policyIds: string[]; outcome?: "provisional" } | null;
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
      const policy = loadWorkQueuePolicy(project, home);
      if (cur.status === "awaiting_review" && (!cur.route || cur.route.current === null)) {
        // An item submitted before routes existed: give it its single-stage route now.
        startRoute(cur, policy, now, true);
      }
      if (decision === "cancel") {
        return cancel(cur, actor, policy, comment, now);
      }
      if (cur.status !== "awaiting_review") {
        throw new DecisionRefused(
          "not_awaiting_review",
          `only an item awaiting review can be ${decision === "approve" ? "approved" : "sent back"} (it is ${cur.status})`,
        );
      }
      const stage = currentStage(cur)!;
      const index = cur.route!.current!;
      const via = deciderVia(cur, actor.id, policy, now);
      if (decision === "send_back") {
        if (!comment) {
          throw new DecisionRefused(
            "comment_required",
            "send back needs a comment for the drafter",
          );
        }
        if (!via) {
          throw notApprover(stage.id);
        }
        cur.override = null;
        const toPrevious = stage.onReturn === "previous" && index > 0;
        if (toPrevious) {
          resetStage(stage);
          activateStage(cur.route!, index - 1, now);
          cur.approvals = routeApprovals(cur.route!);
        } else {
          startRoute(cur, policy, now, false);
          out.artifact = cur.draft ? "draft" : null;
        }
        return {
          next: cur,
          spec: {
            action: "decide.send_back",
            actor,
            to: toPrevious ? "awaiting_review" : "sent_back",
            comment,
            detail: {
              stage: stage.id,
              returnTo: toPrevious ? "previous" : "requester",
              ...(toPrevious ? { toStage: cur.route!.stages[index - 1].id } : {}),
              ...(via.onBehalfOf ? { onBehalfOf: via.onBehalfOf } : {}),
            },
          },
        };
      }
      // approve: never while suspected_fraud is set (only a person clears it, see clear-flag.ts).
      assertNoFraudFlag(cur, "approved");
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
      if (actedInStage(stage, actor.id)) {
        throw new DecisionRefused("already_approved", "you have already approved this item");
      }
      const staged = cur.route!.kind === "staged";
      if (staged && cur.route!.stages.some((s) => s !== stage && actedInStage(s, actor.id))) {
        throw new DecisionRefused(
          "already_approved",
          "you approved an earlier stage of this item; each stage needs a different person",
        );
      }
      const known = isKnownIdentity(actor.id) && isKnownIdentity(cur.requestedBy);
      if ((policy.separationOfDuties || staged) && known && actor.id === cur.requestedBy) {
        throw new DecisionRefused(
          "separation_of_duties",
          "the person who created this item cannot approve it",
        );
      }
      if (!via) {
        throw notApprover(stage.id);
      }
      if (
        via.onBehalfOf &&
        staged &&
        cur.route!.stages.some((s) => s !== stage && actedInStage(s, via.onBehalfOf!))
      ) {
        throw new DecisionRefused(
          "already_approved",
          "the person you are delegated by approved an earlier stage of this item",
        );
      }
      // A document changed since it was attached is not the one reviewed: no override approves it.
      const changed = changedDocuments(project, cur, home);
      if (changed.length > 0) {
        throw new DecisionRefused(
          "document_changed",
          `a document changed after it was attached (${changed.join(", ")}); prepare it again for review`,
          { documents: changed },
        );
      }
      // Step-up: an approval this policy covers needs a fresh authentication of the person.
      const authn = opts.authn?.(cur) ?? { ok: true as const, evidence: null };
      if (!authn.ok) {
        throw new DecisionRefused("step_up_required", authn.message, authn.details);
      }
      recheck(project, cur, now, home);
      const failingChecks = blockingFailures(cur.checks);
      const failing = failingChecks.map((c) => c.policyId);
      // Overriding a check marked overrideOutcome "provisional" approves a provisional release
      // only: the reason is the authorisation to release it as such, never a final approval.
      const provisional = failingChecks.some((c) => c.overrideOutcome === "provisional");
      const at = now.toISOString();
      if (failing.length > 0) {
        if (!overrideReason || overrideReason.length < MIN_OVERRIDE_REASON) {
          throw new DecisionRefused(
            "checks_failed",
            `blocking checks failed (${failing.join(", ")}); approve with override.reason (at least ${MIN_OVERRIDE_REASON} characters) to proceed`,
            { failing },
          );
        }
        out.override = {
          reason: overrideReason,
          policyIds: failing,
          ...(provisional ? { outcome: "provisional" as const } : {}),
        };
        cur.override = {
          by: actor.id,
          at,
          reason: overrideReason,
          policyIds: failing,
          ...(provisional ? { outcome: "provisional" as const } : {}),
        };
      }
      stage.approvals.push({
        by: actor.id,
        at,
        comment,
        stageId: stage.id,
        via: via.via,
        ...(via.onBehalfOf ? { onBehalfOf: via.onBehalfOf } : {}),
      });
      const stageDone = stage.approvals.length >= stage.minApprovals;
      const last = index === cur.route!.stages.length - 1;
      if (stageDone) {
        stage.status = "approved";
        stage.completedAt = at;
        if (last) {
          cur.route!.current = null;
        } else {
          activateStage(cur.route!, index + 1, now);
        }
      }
      cur.approvals = routeApprovals(cur.route!);
      const complete = stageDone && last;
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
            stage: stage.id,
            stageComplete: stageDone,
            nextStage: stageDone && !last ? cur.route!.stages[index + 1].id : null,
            via: via.via,
            ...(via.onBehalfOf ? { onBehalfOf: via.onBehalfOf } : {}),
            checks: checkSummary(cur),
            draft: cur.draft
              ? {
                  artifactId: cur.draft.artifactId,
                  version: cur.draft.version,
                  sha256: cur.draft.sha256,
                }
              : null,
            ...(out.override ? { override: out.override } : {}),
            ...(authn.evidence ? { authn: authn.evidence } : {}),
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
      detail: {
        id,
        policyIds: o.policyIds,
        reason: o.reason,
        ...(o.outcome ? { outcome: o.outcome } : {}),
      },
    });
  }
  if (out.artifact && item.draft) {
    syncArtifact(project, item, out.artifact, actor, home);
  }
  return item;
}

function notApprover(stageId: string): WorkItemRefused {
  return new DecisionRefused(
    "not_an_approver",
    `you are not an approver of the current stage (${stageId})`,
    { stage: stageId },
  );
}

/** Cancel: the requester, a privileged operator, or a person who may decide the current stage. */
function cancel(
  cur: WorkItem,
  actor: Actor,
  policy: WorkQueuePolicy,
  comment: string | null,
  now: Date,
) {
  if (!comment) {
    throw new DecisionRefused("comment_required", "cancel needs a comment");
  }
  const allowed =
    cur.requestedBy === actor.id ||
    isPrivileged(actor, policy, cur.projectId) ||
    deciderVia(cur, actor.id, policy, now) !== null;
  if (!allowed) {
    throw new DecisionRefused(
      "not_authorised",
      "only the requester, an operator or a current approver may cancel this item",
    );
  }
  if (cur.route) {
    cur.route.current = null;
  }
  return {
    next: cur,
    spec: { action: "decide.cancel", actor, to: "cancelled" as const, comment },
  };
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
