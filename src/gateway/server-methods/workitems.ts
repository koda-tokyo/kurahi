// Work queue gateway methods (Kurahi Business edition). Reads are observe; create / update /
// assignAgent are attach; decide is attach + operator.approvals and is an approval method, so
// the voice guard refuses any voice-origin marker before it gets here. On top of that, decide
// refuses every non-person origin: agent tool connections (backend mode / gateway-client),
// non-operator roles and calls without a connection. Every change emits `workitems.changed`.
import path from "node:path";
import type { WorkItem } from "../../workitems/types.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import { agentCommand } from "../../commands/agent.js";
import { EVENTS_FILE, readEventsFile } from "../../evidence/store.js";
import { verifyEvidenceBundle } from "../../evidence/verify.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import {
  accessConfigured,
  assertCanRead,
  assertCanUpdate,
  isPrivileged,
  rolesOf,
  viewerFilter,
} from "../../workitems/access.js";
import { DecisionRefused, decideWorkItem } from "../../workitems/decide.js";
import { assignAgent, type DraftRunner } from "../../workitems/drafting.js";
import { escalateIfDue } from "../../workitems/escalation.js";
import { evidenceBundleDir, listEvidenceBundles } from "../../workitems/evidence.js";
import { createWorkItem, type CreateInput, updateWorkItem } from "../../workitems/lifecycle.js";
import { departmentQueueMatcher, loadWorkQueuePolicy } from "../../workitems/policy.js";
import { listWorkItems, readWorkItem } from "../../workitems/store.js";
import { DEPARTMENT_IDS, type DepartmentFilter } from "../../workitems/types.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";
import { actorOf } from "./projects.js";
import { workitemsIntakeHandlers } from "./workitems-intake.js";
import { workitemsReviewHandlers } from "./workitems-review.js";
import {
  actorFor,
  emit,
  fail,
  nonPersonOrigin,
  projectOf,
  valid,
  WORKITEMS_EVENT,
} from "./workitems-shared.js";

export { nonPersonOrigin, WORKITEMS_EVENT };

export const WORKITEMS_READ_METHODS = [
  "workitems.list",
  "workitems.get",
  "workitems.config",
  "workitems.evidence",
  "workitems.document",
  "workitems.draftDiff",
  "workitems.stats",
] as const;
export const WORKITEMS_WRITE_METHODS = [
  "workitems.create",
  "workitems.update",
  "workitems.assignAgent",
  "workitems.decide",
  "workitems.delegate",
  "workitems.intakeEmail",
  "workitems.clearFlag",
] as const;

let runnerOverride: DraftRunner | null = null;
/** Tests replace the agent run; null restores agentCommand. */
export function setDraftRunnerForTests(runner: DraftRunner | null): void {
  runnerOverride = runner;
}

const quietRuntime: RuntimeEnv = {
  // Drafts can hold personal data (HR, expenses): never print them to the gateway log.
  log: () => {},
  error: defaultRuntime.error,
  exit: defaultRuntime.exit,
};

function draftRunner(context: GatewayRequestContext | undefined): DraftRunner {
  if (runnerOverride) {
    return runnerOverride;
  }
  return async (req) => {
    const result = (await agentCommand(
      {
        message: req.message,
        sessionKey: req.sessionKey,
        runId: req.runId,
        deliver: false,
        extraSystemPrompt: req.extraSystemPrompt,
      },
      quietRuntime,
      context?.deps,
    )) as { payloads?: Array<{ text?: string }> } | undefined;
    const text = (result?.payloads ?? [])
      .map((p) => p.text ?? "")
      .filter(Boolean)
      .join("\n\n");
    return { text };
  };
}

/** Read one item the caller may see (records any due stage escalation first). */
export function readVisibleItem(
  project: ReturnType<typeof projectOf>,
  id: string,
  client: Parameters<typeof actorFor>[0],
  context: GatewayRequestContext | undefined,
): WorkItem {
  const found = readWorkItem(project.id, id);
  if (!found) {
    throw new Error("work item not found");
  }
  const item = escalateIfDue(project, found, { onChange: (next) => emit(context, next) });
  assertCanRead(item, actorFor(client), loadWorkQueuePolicy(project), new Date());
  return item;
}

function assertOwnerOrOperator(
  project: ReturnType<typeof projectOf>,
  id: string,
  client: Parameters<typeof actorFor>[0],
): void {
  const item = readWorkItem(project.id, id);
  if (!item) {
    throw new Error("work item not found");
  }
  assertCanUpdate(item, actorFor(client), loadWorkQueuePolicy(project));
}

const arr = <T>(v: T | T[] | undefined): T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

type P = Record<string, unknown> & { projectId: string; id: string; expectedRevision?: number };

export const workitemsHandlers: GatewayRequestHandlers = {
  "workitems.list": ({ params, respond, client, context }) => {
    if (!valid("workitems.list", params, respond)) {
      return;
    }
    try {
      const p = params as P & Record<string, never>;
      const project = projectOf(p.projectId);
      const policy = loadWorkQueuePolicy(project);
      const now = new Date();
      const where = viewerFilter(actorFor(client), policy, project.id, {
        mine: p.mine === true,
        awaitingMe: p.awaitingMe === true,
        now,
      });
      respond(
        true,
        listWorkItems(
          project.id,
          {
            queue: p.queue as string | undefined,
            status: arr(p.status),
            type: arr(p.type),
            priority: arr(p.priority),
            assigneeKind: p.assigneeKind,
            assigneeId: p.assigneeId,
            overdue: p.overdue,
            q: p.q,
            stage: p.stage,
            flagged: p.flagged,
            where,
            // View filter only: narrows what the viewer may already read, never widens it.
            inDepartment: p.department
              ? departmentQueueMatcher(policy, p.department as DepartmentFilter)
              : undefined,
          },
          { cursor: p.cursor, limit: p.limit },
          {
            now,
            prepare: (item) =>
              escalateIfDue(project, item, { now, onChange: (next) => emit(context, next) }),
          },
        ),
      );
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.get": ({ params, respond, client, context }) => {
    if (!valid("workitems.get", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      respond(true, { item: readVisibleItem(project, p.id, client, context) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.config": ({ params, respond, client }) => {
    if (!valid("workitems.config", params, respond)) {
      return;
    }
    try {
      const project = projectOf(params.projectId);
      const policy = loadWorkQueuePolicy(project);
      const actor = actorFor(client);
      const me = rolesOf(policy, actor.id, project.id);
      const privileged = isPrivileged(actor, policy, project.id);
      const roles = new Set<string>();
      for (const m of policy.access.members) {
        m.roles.forEach((r) => roles.add(r));
      }
      for (const g of Object.values(policy.access.groups)) {
        g.roles.forEach((r) => roles.add(r));
      }
      respond(true, {
        queues: policy.queues,
        departments: [...DEPARTMENT_IDS],
        rules: policy.rules.map((r) => ({
          id: r.id,
          kind: r.kind,
          label: r.label,
          severity: r.severity,
          blocking: r.blocking,
          types: r.types,
          queues: r.queues,
        })),
        timezone: policy.timezone,
        separationOfDuties: policy.separationOfDuties,
        routes: policy.routes,
        access: {
          fallback: policy.access.fallback,
          configured: accessConfigured(policy),
          roles: [...roles].toSorted(),
          members: privileged ? policy.access.members : null,
        },
        viewer: {
          principal: actor.id,
          privileged,
          roles: [...me.roles].toSorted(),
          departments: [...me.departments].toSorted(),
          listed: me.listed,
        },
        source: policy.source,
        digest: policy.digest,
        error: policy.error,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.evidence": async ({ params, respond, client, context }) => {
    if (!valid("workitems.evidence", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      const item = readVisibleItem(project, p.id, client, context);
      const bundles = [];
      let prevRoot: string | null = null;
      let chainOk = true;
      for (const bundle of listEvidenceBundles(item)) {
        const v = await verifyEvidenceBundle(evidenceBundleDir(item, bundle));
        const linked = linkOk(item, bundle, prevRoot);
        chainOk = chainOk && v.ok && linked;
        prevRoot = v.manifest?.events.root ?? null;
        bundles.push({
          bundle,
          ok: v.ok && linked,
          status: v.manifest?.status ?? null,
          root: v.manifest?.events.root ?? null,
          signer: v.manifest?.signer?.keyId ?? null,
          problems: linked ? v.problems : [...v.problems, "does not link to the previous bundle"],
        });
      }
      respond(true, { bundles, chainOk });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.create": ({ params, respond, client, context }) => {
    if (!valid("workitems.create", params, respond)) {
      return;
    }
    try {
      const { projectId, ...input } = params as P;
      const item = createWorkItem(projectOf(projectId), input as CreateInput, actorFor(client));
      emit(context, item);
      respond(true, { item });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.update": ({ params, respond, client, context }) => {
    if (!valid("workitems.update", params, respond)) {
      return;
    }
    const p = params as P & { patch: Record<string, unknown> };
    try {
      const project = projectOf(p.projectId);
      assertOwnerOrOperator(project, p.id, client);
      const item = updateWorkItem(project, p.id, p.patch, actorFor(client), p.expectedRevision);
      emit(context, item);
      respond(true, { item });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.assignAgent": ({ params, respond, client, context }) => {
    if (!valid("workitems.assignAgent", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      assertOwnerOrOperator(project, p.id, client);
      const { item, runId } = assignAgent(
        project,
        p.id,
        { agentId: p.agentId, instructions: p.instructions },
        actorFor(client),
        p.expectedRevision,
        draftRunner(context),
        { onChange: (next) => emit(context, next) },
      );
      emit(context, item);
      respond(true, { item, runId });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Person-only. Approve / send back / cancel; approve may carry override.reason (audited). */
  "workitems.decide": ({ params, respond, client, context }) => {
    const origin = nonPersonOrigin(client, { decision: true });
    if (origin) {
      void auditSafe({
        identity: actorOf(client),
        scope: typeof params?.projectId === "string" ? params.projectId : null,
        action: "workitem.decide",
        outcome: "denied",
        source: "gateway.workitems",
        detail: { id: params?.id, decision: params?.decision, reason: origin },
      });
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `only a person may decide on a work item (${origin})`,
          {
            details: { code: "not_a_person" },
          },
        ),
      );
      return;
    }
    if (!valid("workitems.decide", params, respond)) {
      return;
    }
    const p = params as P & { override?: { reason: string } };
    try {
      const project = projectOf(p.projectId);
      const item = decideWorkItem(
        project,
        p.id,
        { decision: p.decision, comment: p.comment, override: p.override ?? null },
        actorFor(client),
        p.expectedRevision,
      );
      emit(context, item);
      respond(true, { item });
    } catch (err) {
      void auditSafe({
        identity: actorOf(client),
        scope: p.projectId,
        action: "workitem.decide",
        outcome: "denied",
        source: "gateway.workitems",
        detail: {
          id: p.id,
          decision: p.decision,
          code: err instanceof DecisionRefused ? err.code : "error",
          error: String(err),
        },
      });
      fail(respond, err);
    }
  },

  ...workitemsReviewHandlers,
  ...workitemsIntakeHandlers,
};

/** Each bundle's job.start must name the previous bundle's root (the item's bundle chain). */
function linkOk(item: WorkItem, bundle: string, prevRoot: string | null): boolean {
  try {
    const events = readEventsFile(path.join(evidenceBundleDir(item, bundle), EVENTS_FILE));
    return (events[0]?.data?.prevRoot ?? null) === prevRoot;
  } catch {
    return false;
  }
}
