// Personal data guard on outbound tool calls (docs/security/data-governance.md#personal-data).
//
// Before a connector tool that sends or writes outside Kurahi runs (mail send / draft, uploads,
// LINE WORKS send, Box upload, Office document creation, kintone writes), every string in its
// arguments goes through the detector. With the default policy a valid マイナンバー blocks the
// call; other identifiers are audited as a warning and the call proceeds. Configurable per
// Project (`governance.policy.set`) and organisation-wide (config `governance.personalData`).
//
// Audit rows never carry the value: kind, argument path, offsets and a keyed digest only.
//
// Under the demo profile (KURAHI_DEMO=1, src/packaging/release-profile.ts) every outbound tool is
// refused before the detector runs, whatever its arguments: nothing leaves the demo.
import type { KoLoConfig } from "../config/config.js";
import type { GovernancePersonalDataAction } from "../config/types.governance.js";
import { auditSafe } from "../audit/audit-log.js";
import { loadConfig } from "../config/config.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { isDemoProfile } from "../packaging/release-profile.js";
import { parseProjectSessionKey } from "../projects/scope.js";
import {
  detectPersonalData,
  findingDigest,
  PERSONAL_KINDS,
  walkStrings,
  type PersonalDataKind,
} from "./personal-data.js";
import { effectivePersonalData, governanceConfigOf, type PersonalDataPolicy } from "./policy.js";
import { auditDirOf, personalDataKey } from "./store.js";

/** Tools whose arguments leave Kurahi. Matched by exact name. */
export const OUTBOUND_TOOLS: ReadonlySet<string> = new Set([
  "m365_mail_send",
  "m365_mail_create_draft",
  "m365_mail_attach_to_draft",
  "m365_files_upload",
  "m365_calendar_create_event",
  "gmail_send",
  "lineworks_message_send",
  "box_file_upload",
  "office_pptx_create",
  "office_docx_create",
  "office_xlsx_create",
  "office_quote_create",
  "office_po_create",
  "kintone_record_create",
  "kintone_record_comment_add",
]);

export function isOutboundTool(name: string): boolean {
  return OUTBOUND_TOOLS.has(name);
}

export type OutboundFinding = {
  kind: PersonalDataKind;
  field: string;
  start: number;
  end: number;
  digest: string;
};

export type OutboundCheck =
  | { action: "allow"; findings: OutboundFinding[] }
  | { action: "warn"; findings: OutboundFinding[] }
  | { action: "block"; findings: OutboundFinding[]; reason: string };

function actionFor(
  kind: PersonalDataKind,
  policy: PersonalDataPolicy,
): GovernancePersonalDataAction {
  if (kind === "my_number") {
    return policy.myNumber;
  }
  return PERSONAL_KINDS.has(kind) ? policy.otherIdentifiers : "off";
}

/** Pure decision for one call (tests, and the wrapper below). */
export function checkOutboundArgs(
  args: unknown,
  policy: PersonalDataPolicy,
  key: Buffer | string,
): OutboundCheck {
  const findings: OutboundFinding[] = [];
  let block = false;
  let warn = false;
  walkStrings(args, (text, field) => {
    for (const f of detectPersonalData(text)) {
      const act = actionFor(f.kind, policy);
      if (act === "off") {
        continue;
      }
      block ||= act === "block";
      warn ||= act === "warn";
      findings.push({
        kind: f.kind,
        field,
        start: f.start,
        end: f.end,
        digest: findingDigest(key, f),
      });
    }
  });
  if (block) {
    const kinds = [
      ...new Set(findings.filter((f) => actionFor(f.kind, policy) === "block").map((f) => f.kind)),
    ];
    const fields = [...new Set(findings.map((f) => f.field))].slice(0, 5);
    return {
      action: "block",
      findings,
      reason:
        `Personal data guard: ${kinds.includes("my_number") ? "a マイナンバー (individual number)" : kinds.join(", ")} ` +
        `was found in ${fields.join(", ")}. Sending it is blocked by policy (rule personal-data:${kinds[0]}). ` +
        "Remove the identifier; an administrator can change governance.personalData.",
    };
  }
  return { action: warn ? "warn" : "allow", findings };
}

export class PersonalDataBlockedError extends Error {
  constructor(
    message: string,
    public readonly findings: OutboundFinding[],
  ) {
    super(message);
    this.name = "PersonalDataBlockedError";
  }
}

/**
 * Check and audit one outbound call. Returns the decision; the caller refuses on `block`.
 * Never throws for I/O problems (a broken policy file falls back to the organisation default).
 */
export function guardOutboundCall(params: {
  toolName: string;
  args: unknown;
  agentId?: string;
  sessionKey?: string;
  config?: KoLoConfig;
  home?: string;
  env?: Record<string, string | undefined>;
}): OutboundCheck {
  if (!isOutboundTool(params.toolName)) {
    return { action: "allow", findings: [] };
  }
  const home = params.home ?? resolveKoloHome();
  if (isDemoProfile(params.env)) {
    void auditSafe(
      {
        identity: params.agentId ?? null,
        scope: params.sessionKey ?? null,
        action: "governance.demo.outboundRefused",
        outcome: "denied",
        source: "governance.outbound",
        detail: { tool: params.toolName },
      },
      { dir: auditDirOf(home) },
    );
    return {
      action: "block",
      findings: [],
      reason: `${params.toolName} is refused in the demo: nothing leaves the demo workspace`,
    };
  }
  let cfg: KoLoConfig | undefined = params.config;
  if (!cfg) {
    try {
      cfg = loadConfig();
    } catch {
      cfg = undefined;
    }
  }
  const projectId = parseProjectSessionKey(params.sessionKey)?.projectId ?? null;
  let policy: PersonalDataPolicy;
  try {
    policy = effectivePersonalData(governanceConfigOf(cfg), home, projectId);
  } catch {
    policy = effectivePersonalData(governanceConfigOf(cfg), home, null);
  }
  const result = checkOutboundArgs(params.args, policy, personalDataKey(home));
  if (result.findings.length > 0) {
    void auditSafe(
      {
        identity: params.agentId ?? null,
        scope: params.sessionKey ?? null,
        action:
          result.action === "block"
            ? "governance.personalData.block"
            : "governance.personalData.flag",
        outcome: result.action === "block" ? "denied" : "ok",
        source: "governance.outbound",
        detail: {
          tool: params.toolName,
          projectId,
          findings: result.findings.slice(0, 50).map((f) => ({
            kind: f.kind,
            field: f.field,
            start: f.start,
            end: f.end,
            digest: f.digest,
          })),
        },
      },
      { dir: auditDirOf(home) },
    );
  }
  return result;
}

/** Wrap one agent tool: outbound tools are checked before they run; others are returned as is. */
export function wrapToolWithPersonalDataGuard<
  T extends { name: string; execute?: (...args: never[]) => unknown },
>(tool: T, ctx: { agentId?: string; sessionKey?: string; config?: KoLoConfig }): T {
  const execute = tool.execute as ((...args: unknown[]) => unknown) | undefined;
  if (typeof execute !== "function" || !isOutboundTool(tool.name)) {
    return tool;
  }
  return {
    ...tool,
    execute: async (...args: unknown[]) => {
      const check = guardOutboundCall({
        toolName: tool.name,
        args: args[1],
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        config: ctx.config,
      });
      if (check.action === "block") {
        throw new PersonalDataBlockedError(check.reason, check.findings);
      }
      return await execute(...args);
    },
  } as T;
}
