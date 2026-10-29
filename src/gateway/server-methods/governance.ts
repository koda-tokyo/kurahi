// Data governance gateway methods (docs/security/data-governance.md).
//
// governance.policy.get is a read (observe). Every other method is person-only: an approval
// method (operator.approvals; the voice guard refuses voice-origin markers before validation),
// refused for agent tool connections, cron/backend clients and calls without a connection, and,
// with enterprise identity configured, for anything but an SSO person session on the methods in
// SSO_PERSON_DECISIONS (holds, exports, data subject requests, policy changes, retention runs).
// Every call that changes or reveals data is audited; holds are also sealed as evidence.
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import { loadConfig } from "../../config/config.js";
import { resolveKoloHome } from "../../config/kolo-home.js";
import { writeSealedBundle } from "../../evidence/sealed-bundle.js";
import { executeSubjectRequest, findSubjectData, type DsrReport } from "../../governance/dsr.js";
import {
  listExports,
  readExport,
  startExport,
  type ExportStatus,
} from "../../governance/export.js";
import { createHold, listHolds, releaseHold, type LegalHold } from "../../governance/holds.js";
import {
  DEFAULT_SWEEP_HOUR_UTC,
  effectivePersonalData,
  effectiveRetention,
  governanceConfigOf,
  GovernanceRefused,
  minimumDays,
  orgRetention,
  projectOverride,
  setProjectOverride,
} from "../../governance/policy.js";
import { auditDirOf, evidenceRootOf } from "../../governance/store.js";
import { runRetentionSweep } from "../../governance/sweeper.js";
import { SSO_PERSON_DECISIONS } from "../../identity/connect.js";
import { getProject } from "../../projects/store.js";
import { governanceValidators, type GovernanceMethod } from "../protocol/governance-validators.js";
import { ErrorCodes, errorShape, formatValidationErrors } from "../protocol/index.js";
import { actorOf } from "./projects.js";
import { nonPersonOrigin } from "./workitems-shared.js";

export const GOVERNANCE_EVENT = "governance.changed";

export const GOVERNANCE_READ_METHODS = ["governance.policy.get"] as const;
/** operator.approvals; person-only. */
export const GOVERNANCE_APPROVAL_METHODS = [
  "governance.policy.set",
  "governance.retention.run",
  "governance.holds.create",
  "governance.holds.list",
  "governance.holds.release",
  "governance.export.create",
  "governance.export.get",
  "governance.export.list",
  "governance.dsr.find",
  "governance.dsr.execute",
] as const;

export function exportDownloadPath(id: string): string {
  return `/api/governance/exports/${id}/download`;
}

function home(): string {
  return resolveKoloHome();
}

function refuse(
  respond: RespondFn,
  code: string,
  message: string,
  details: Record<string, unknown> = {},
) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, message, { details: { code, ...details } }),
  );
}

function fail(respond: RespondFn, err: unknown) {
  if (err instanceof GovernanceRefused) {
    refuse(respond, err.code, err.message, err.details);
    return;
  }
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
  );
}

function valid(method: GovernanceMethod, params: unknown, respond: RespondFn): boolean {
  const validate = governanceValidators[method];
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

/** Person-only gate; refusals are audited (never the params' values). */
function personGate(
  method: string,
  client: GatewayClient | null | undefined,
  respond: RespondFn,
): boolean {
  const origin = nonPersonOrigin(client, { decision: SSO_PERSON_DECISIONS.has(method) });
  if (!origin) {
    return true;
  }
  void auditSafe(
    {
      identity: actorOf(client),
      action: method,
      outcome: "denied",
      source: "gateway.governance",
      detail: { reason: origin },
    },
    { dir: auditDirOf(home()) },
  );
  refuse(respond, "not_a_person", `only a person may call ${method} (${origin})`);
  return false;
}

function audit(
  client: GatewayClient | null | undefined,
  action: string,
  detail: Record<string, unknown>,
) {
  void auditSafe(
    { identity: actorOf(client), action, outcome: "ok", source: "gateway.governance", detail },
    { dir: auditDirOf(home()) },
  );
}

function emit(context: GatewayRequestContext | undefined, kind: string, id: string | null) {
  context?.broadcast?.(
    GOVERNANCE_EVENT,
    { kind, id, at: new Date().toISOString() },
    { dropIfSlow: true },
  );
}

/** Seal a hold change as a small evidence bundle (`gov-hold-<id>-<action>`). */
function sealHoldEvidence(hold: LegalHold, action: "create" | "release", by: string) {
  const h = home();
  const ts = new Date().toISOString();
  const jobId = `gov-${hold.id}-${action}`;
  writeSealedBundle(
    `${evidenceRootOf(h)}/${jobId}`,
    {
      jobId,
      agent: by,
      sessionKey: "governance:hold",
      kind: `governance.hold.${action}`,
      status: hold.status,
      startedAt: ts,
      endedAt: ts,
    },
    [
      { type: "job.start", ts, data: { kind: `governance.hold.${action}`, holdId: hold.id } },
      {
        type: "approval",
        ts,
        data: {
          action: `governance.holds.${action}`,
          by,
          holdId: hold.id,
          matterId: hold.matterId,
          reason: action === "create" ? hold.reason : (hold.releaseReason ?? ""),
          scope: hold.scope,
        },
      },
      { type: "job.end", ts, data: { status: hold.status } },
    ],
    { env: { ...process.env, KOLO_HOME: h, KOLO_STATE_DIR: h } },
  );
  return jobId;
}

function policyView(projectId: string | undefined) {
  const cfg = loadConfig();
  const g = governanceConfigOf(cfg);
  const h = home();
  const org = {
    retention: orgRetention(g),
    personalData: effectivePersonalData(g, h, null),
    minimumRetentionDays: minimumDays(g),
    sweep: {
      enabled: g.sweep?.enabled !== false,
      hourUtc: g.sweep?.hourUtc ?? DEFAULT_SWEEP_HOUR_UTC,
    },
  };
  if (!projectId) {
    return { org, project: null };
  }
  const o = projectOverride(h, projectId);
  return {
    org,
    project: {
      projectId,
      retention: effectiveRetention(g, h, projectId),
      personalData: effectivePersonalData(g, h, projectId),
      updatedAt: o.updatedAt ?? null,
      updatedBy: o.updatedBy ?? null,
    },
  };
}

function exportView(s: ExportStatus) {
  return { ...s, downloadPath: s.status === "done" ? exportDownloadPath(s.id) : null };
}

function dsrAuditDetail(r: DsrReport) {
  return { reportId: r.id, kind: r.kind, identifierDigest: r.identifierDigest, counts: r.counts };
}

type P = Record<string, unknown>;

export const governanceHandlers: GatewayRequestHandlers = {
  "governance.policy.get": ({ params, respond }) => {
    if (!valid("governance.policy.get", params, respond)) {
      return;
    }
    const projectId = (params as P).projectId as string | undefined;
    if (projectId && !getProject(projectId)) {
      refuse(respond, "project_not_found", "project not found");
      return;
    }
    respond(true, policyView(projectId));
  },

  "governance.policy.set": ({ params, respond, client, context }) => {
    if (
      !personGate("governance.policy.set", client, respond) ||
      !valid("governance.policy.set", params, respond)
    ) {
      return;
    }
    const p = params as P;
    try {
      const projectId = p.projectId as string;
      if (!getProject(projectId)) {
        throw new GovernanceRefused("project_not_found", "project not found");
      }
      const stored = setProjectOverride(
        governanceConfigOf(loadConfig()),
        home(),
        projectId,
        { retention: p.retention as never, personalData: p.personalData as never },
        actorOf(client),
      );
      audit(client, "governance.policy.set", {
        projectId,
        retention: stored.retention,
        personalData: stored.personalData,
        reason: p.reason,
      });
      emit(context, "policy", projectId);
      respond(true, policyView(projectId));
    } catch (err) {
      fail(respond, err);
    }
  },

  "governance.retention.run": async ({ params, respond, client, context }) => {
    if (
      !personGate("governance.retention.run", client, respond) ||
      !valid("governance.retention.run", params, respond)
    ) {
      return;
    }
    const p = params as P;
    try {
      const dryRun = p.dryRun !== false;
      const result = await runRetentionSweep({
        home: home(),
        config: loadConfig(),
        dryRun,
        by: actorOf(client),
        classes: p.classes as never,
      });
      if (dryRun) {
        audit(client, "governance.retention.preview", { reason: p.reason });
      } else {
        emit(context, "retention", result.manifestId);
      }
      respond(true, {
        ...result,
        classes: Object.fromEntries(
          Object.entries(result.classes).map(([c, t]) => [
            c,
            {
              deleted: t.deleted,
              anonymized: t.anonymized,
              held: t.held,
              failed: t.failed,
              oldest: t.oldest,
              newest: t.newest,
            },
          ]),
        ),
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  "governance.holds.create": ({ params, respond, client, context }) => {
    if (
      !personGate("governance.holds.create", client, respond) ||
      !valid("governance.holds.create", params, respond)
    ) {
      return;
    }
    const p = params as P;
    try {
      const by = actorOf(client);
      const hold = createHold(
        home(),
        { matterId: p.matterId, reason: p.reason, scope: p.scope },
        by,
      );
      const evidence = sealHoldEvidence(hold, "create", by);
      audit(client, "governance.holds.create", {
        holdId: hold.id,
        matterId: hold.matterId,
        scope: hold.scope,
        evidence,
      });
      emit(context, "hold", hold.id);
      respond(true, { hold });
    } catch (err) {
      fail(respond, err);
    }
  },

  "governance.holds.list": ({ params, respond, client }) => {
    if (
      !personGate("governance.holds.list", client, respond) ||
      !valid("governance.holds.list", params, respond)
    ) {
      return;
    }
    const status = ((params as P).status as string | undefined) ?? "active";
    const holds = listHolds(home()).filter((h) => status === "all" || h.status === status);
    respond(true, { holds });
  },

  "governance.holds.release": ({ params, respond, client, context }) => {
    if (
      !personGate("governance.holds.release", client, respond) ||
      !valid("governance.holds.release", params, respond)
    ) {
      return;
    }
    const p = params as P;
    try {
      const by = actorOf(client);
      const hold = releaseHold(home(), p.id, p.reason, by);
      const evidence = sealHoldEvidence(hold, "release", by);
      audit(client, "governance.holds.release", {
        holdId: hold.id,
        matterId: hold.matterId,
        evidence,
      });
      emit(context, "hold", hold.id);
      respond(true, { hold });
    } catch (err) {
      fail(respond, err);
    }
  },

  "governance.export.create": ({ params, respond, client, context }) => {
    if (
      !personGate("governance.export.create", client, respond) ||
      !valid("governance.export.create", params, respond)
    ) {
      return;
    }
    const p = params as P;
    try {
      const h = home();
      const cfg = loadConfig();
      const { status } = startExport(h, p, actorOf(client), {
        redactDefault: effectivePersonalData(governanceConfigOf(cfg), h, null).redactExports,
        onDone: (s) => {
          void auditSafe(
            {
              identity: s.createdBy,
              action: "governance.export.done",
              outcome: s.status === "done" ? "ok" : "failed",
              source: "governance",
              detail: {
                exportId: s.id,
                bytes: s.bytes,
                sha256: s.sha256,
                files: s.files,
                verificationOk: s.verificationOk,
              },
            },
            { dir: auditDirOf(h) },
          );
          emit(context, "export", s.id);
        },
      });
      audit(client, "governance.export.create", {
        exportId: status.id,
        matterId: status.matterId,
        scope: status.scope,
        classes: status.classes,
        attachmentFiles: status.attachmentFiles,
        redacted: status.redacted,
        reason: status.reason,
      });
      emit(context, "export", status.id);
      respond(true, { export: exportView(status) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "governance.export.get": ({ params, respond, client }) => {
    if (
      !personGate("governance.export.get", client, respond) ||
      !valid("governance.export.get", params, respond)
    ) {
      return;
    }
    const s = readExport(home(), (params as P).id);
    if (!s) {
      refuse(respond, "export_not_found", "export not found");
      return;
    }
    respond(true, { export: exportView(s) });
  },

  "governance.export.list": ({ params, respond, client }) => {
    if (
      !personGate("governance.export.list", client, respond) ||
      !valid("governance.export.list", params, respond)
    ) {
      return;
    }
    respond(true, { exports: listExports(home()).map(exportView) });
  },

  "governance.dsr.find": ({ params, respond, client, context }) => {
    if (
      !personGate("governance.dsr.find", client, respond) ||
      !valid("governance.dsr.find", params, respond)
    ) {
      return;
    }
    try {
      const report = findSubjectData(home(), params as P as never, actorOf(client));
      audit(client, "governance.dsr.find", { ...dsrAuditDetail(report), reason: report.reason });
      emit(context, "dsr", report.id);
      respond(true, { report });
    } catch (err) {
      fail(respond, err);
    }
  },

  "governance.dsr.execute": async ({ params, respond, client, context }) => {
    if (
      !personGate("governance.dsr.execute", client, respond) ||
      !valid("governance.dsr.execute", params, respond)
    ) {
      return;
    }
    try {
      const report = await executeSubjectRequest(home(), params as P as never, actorOf(client));
      audit(client, "governance.dsr.execute", {
        ...dsrAuditDetail(report),
        executed: report.executed,
        reason: (params as P).reason,
      });
      emit(context, "dsr", report.id);
      respond(true, { report });
    } catch (err) {
      fail(respond, err);
    }
  },
};
