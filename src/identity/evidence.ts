// Signed evidence for identity administration (org units, role assignments, group mappings,
// session revocations, break-glass logins): one sealed bundle per change in the standard
// evidence format, so `kurahi evidence verify <dir>` checks it like any job bundle. Every change
// is also an audit-chain entry. Bundles hold ids, roles and counts, never tokens or claims.
import { randomUUID } from "node:crypto";
import path from "node:path";
import { auditSafe } from "../audit/audit-log.js";
import { writeSealedBundle } from "../evidence/sealed-bundle.js";
import { identityDir } from "./store.js";

export function identityEvidenceDir(
  changeId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const month = new Date().toISOString().slice(0, 7);
  return path.join(identityDir(env), "evidence", month, changeId);
}

export type IdentityChange = {
  action: string;
  actor: string;
  /** "org-admin", "security-admin", "bootstrap-owner", "break-glass", … */
  authority: string;
  outcome: "ok" | "denied";
  detail: Record<string, unknown>;
  /** How the deciding person authenticated (step-up evidence; never tokens). */
  authn?: Record<string, unknown> | null;
};

/** Audit + sealed evidence for one administrative change. Evidence failures never throw. */
export function recordIdentityChange(
  change: IdentityChange,
  opts: { env?: NodeJS.ProcessEnv } = {},
): { bundle: string; root: string } | null {
  void auditSafe({
    identity: change.actor,
    scope: change.authority,
    action: change.action,
    outcome: change.outcome,
    source: "gateway.identity",
    detail: change.authn ? { ...change.detail, authn: change.authn } : change.detail,
  });
  if (change.outcome !== "ok") {
    return null;
  }
  const id = randomUUID();
  const ts = new Date().toISOString();
  try {
    const dir = identityEvidenceDir(id, opts.env);
    const { root } = writeSealedBundle(
      dir,
      {
        jobId: `idn-${id}`,
        agent: change.actor,
        sessionKey: `identity:${change.action}`,
        kind: "identity.admin",
        status: "ok",
        startedAt: ts,
        endedAt: ts,
      },
      [
        { type: "job.start", ts, data: { kind: change.action, authority: change.authority } },
        {
          type: "audit",
          ts,
          data: {
            action: change.action,
            actor: change.actor,
            ...change.detail,
            ...(change.authn ? { authn: change.authn } : {}),
          },
        },
        { type: "job.end", ts, data: { status: "ok" } },
      ],
      { env: opts.env },
    );
    return { bundle: path.relative(identityDir(opts.env), dir), root };
  } catch {
    return null;
  }
}
