// Work queue gateway methods (Kurahi Business edition). Reads are observe; create / update /
// assignAgent are attach; decide is attach + operator.approvals and is an approval method, so
// the voice guard refuses any voice-origin marker before it gets here. On top of that, decide
// refuses every non-person origin: agent tool connections (backend mode / gateway-client),
// non-operator roles and calls without a connection. Every change emits `workitems.changed`.
import path from "node:path";
import type { Actor, WorkItem } from "../../workitems/types.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import { agentCommand } from "../../commands/agent.js";
import { EVENTS_FILE, readEventsFile } from "../../evidence/store.js";
import { verifyEvidenceBundle } from "../../evidence/verify.js";
import { getProject } from "../../projects/store.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { DecisionRefused, decideWorkItem } from "../../workitems/decide.js";
import { assignAgent, type DraftRunner } from "../../workitems/drafting.js";
import { evidenceBundleDir, listEvidenceBundles } from "../../workitems/evidence.js";
import { createWorkItem, type CreateInput, updateWorkItem } from "../../workitems/lifecycle.js";
import { loadWorkQueuePolicy } from "../../workitems/policy.js";
import { listWorkItems, readWorkItem } from "../../workitems/store.js";
import { ErrorCodes, errorShape, formatValidationErrors } from "../protocol/index.js";
import { workitemsValidators, type WorkitemsMethod } from "../protocol/workitems-validators.js";
import { actorOf } from "./projects.js";

export const WORKITEMS_READ_METHODS = [
  "workitems.list",
  "workitems.get",
  "workitems.config",
  "workitems.evidence",
] as const;
export const WORKITEMS_WRITE_METHODS = [
  "workitems.create",
  "workitems.update",
  "workitems.assignAgent",
  "workitems.decide",
] as const;
export const WORKITEMS_EVENT = "workitems.changed";

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

/** Why a connection is not a person for decisions, or null when it is. */
export function nonPersonOrigin(client: GatewayClient | null | undefined): string | null {
  if (!client?.connect) {
    return "no client connection";
  }
  const role = client.connect.role ?? "operator";
  if (role !== "operator") {
    return `role ${role}`;
  }
  const info = client.connect.client as { id?: string; mode?: string; displayName?: string };
  if (info?.mode === "backend" || info?.id === "gateway-client") {
    return "agent tool connection";
  }
  if (typeof info?.displayName === "string" && /^agent$/i.test(info.displayName.trim())) {
    return "agent connection";
  }
  return null;
}

function actorFor(client: GatewayClient | null | undefined): Actor {
  return { id: actorOf(client), kind: nonPersonOrigin(client) ? "agent" : "person" };
}

function fail(respond: RespondFn, err: unknown) {
  if (err instanceof DecisionRefused) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, err.message, {
        details: { code: err.code, ...err.details },
      }),
    );
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
  );
}

function valid(method: WorkitemsMethod, params: unknown, respond: RespondFn): boolean {
  const validate = workitemsValidators[method];
  if (validate(params)) {
    return true;
  }
  respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `invalid ${method} params: ${formatValidationErrors(validate.errors)}`,
    ),
  );
  return false;
}

function projectOf(id: unknown) {
  const project = typeof id === "string" ? getProject(id) : null;
  if (!project) {
    throw new Error("project not found");
  }
  return project;
}

function emit(context: GatewayRequestContext | undefined, item: WorkItem) {
  const last = item.history.at(-1);
  context?.broadcast?.(
    WORKITEMS_EVENT,
    {
      projectId: item.projectId,
      id: item.id,
      queue: item.queue,
      action: last?.action ?? "update",
      status: item.status,
      revision: item.revision,
      updatedAt: item.updatedAt,
    },
    { dropIfSlow: true },
  );
}

const arr = <T>(v: T | T[] | undefined): T[] | undefined =>
  v === undefined ? undefined : Array.isArray(v) ? v : [v];

type P = Record<string, unknown> & { projectId: string; id: string; expectedRevision?: number };

export const workitemsHandlers: GatewayRequestHandlers = {
  "workitems.list": ({ params, respond }) => {
    if (!valid("workitems.list", params, respond)) {
      return;
    }
    try {
      const p = params as P & Record<string, never>;
      const project = projectOf(p.projectId);
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
          },
          { cursor: p.cursor, limit: p.limit },
        ),
      );
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.get": ({ params, respond }) => {
    if (!valid("workitems.get", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      const item = readWorkItem(project.id, p.id);
      if (!item) {
        throw new Error("work item not found");
      }
      respond(true, { item });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.config": ({ params, respond }) => {
    if (!valid("workitems.config", params, respond)) {
      return;
    }
    try {
      const policy = loadWorkQueuePolicy(projectOf(params.projectId));
      respond(true, {
        queues: policy.queues,
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
        source: policy.source,
        digest: policy.digest,
        error: policy.error,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "workitems.evidence": async ({ params, respond }) => {
    if (!valid("workitems.evidence", params, respond)) {
      return;
    }
    const p = params as P;
    try {
      const project = projectOf(p.projectId);
      const item = readWorkItem(project.id, p.id);
      if (!item) {
        throw new Error("work item not found");
      }
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
    const origin = nonPersonOrigin(client);
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
