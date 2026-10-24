// The console terminal's line gate: one decision per submitted command line, made before
// anything reaches a shell. Order: project mode, hardline guard (unconditional, never queued for
// approval), refusals from the classifier, the path guard, the read-only folder guard (refused in
// every mode, never approvable), then the mode rule:
//
//   参照 read   the session cannot exist (open is refused); a mode change refuses every line
//   計画 plan   read-only lines run; everything else waits for an approval
//   実行 act    actApprovals "always": read-only lines run, everything else waits for an approval
//               actApprovals "policy": the exec-approvals file decides (security / ask /
//               allowlist); lines with a risk beyond running a program always ask

import type { ExecAsk, ExecSecurity } from "../../infra/exec-approvals.js";
import type { ProjectMode } from "../../projects/types.js";
import type { TerminalRisk } from "./codes.js";
import type { TerminalSettings } from "./settings.js";
import { requiresExecApproval } from "../../infra/exec-approvals.js";
import { checkExecCommand } from "../../security/exec-guard.js";
import { classifyLine, type Refusal } from "./classify.js";
import { checkLinePaths, pathHelpers } from "./path-guard.js";
import { checkReadOnlyWrites } from "./readonly-guard.js";

/** Exec-approvals view for one line (act mode, `policy`). */
export type ApprovalPolicy = {
  security: ExecSecurity;
  ask: ExecAsk;
  analysisOk: boolean;
  allowlistSatisfied: boolean;
};

export type GateInput = {
  line: string;
  mode: ProjectMode | null;
  root: string;
  cwd: string;
  previousCwd: string | null;
  /** The project's read-only folders (project-relative), re-read for every line. */
  readOnlyFolders?: readonly string[];
  settings: TerminalSettings;
  /** Exec-approvals evaluation; only called in act mode with actApprovals "policy". */
  policy: (line: string, cwd: string) => ApprovalPolicy;
  /** Context for the hardline guard's own audit entry. */
  guard: { sessionKey: string; sandboxed: boolean };
};

export type GateDecision =
  | { action: "refuse"; refusal: Refusal; risks: TerminalRisk[] }
  | {
      action: "run" | "approve";
      readOnly: boolean;
      printsEnv: boolean;
      risks: TerminalRisk[];
      /** Set when the line is only `cd <dir>`: the broker changes directory itself. */
      cwdAfter: string | null;
    };

/** Risks that ask even when the exec-approvals allowlist would let the program run. */
const ALWAYS_ASK = new Set<TerminalRisk["code"]>([
  "deletes-files",
  "rewrites-git-history",
  "overwrites-files",
  "changes-permissions",
  "installs-packages",
  "network",
  "process-control",
  "moves-files",
  "runs-nested-command",
  "background-job",
]);

export function decideLine(input: GateInput): GateDecision {
  const refuse = (refusal: Refusal, risks: TerminalRisk[] = []): GateDecision => ({
    action: "refuse",
    refusal,
    risks,
  });
  if (input.mode === null) {
    return refuse({ code: "mode-changed" });
  }
  if (input.mode === "read") {
    return refuse({ code: "read-mode" });
  }
  const hardline = checkExecCommand(input.line, {
    source: "console.terminal",
    sessionKey: input.guard.sessionKey,
    host: input.guard.sandboxed ? "sandbox" : "gateway",
    recordAllowed: false,
  });
  if (hardline) {
    return refuse({ code: "hardline-blocked" });
  }
  const helpers = pathHelpers(input.root, input.cwd);
  const cls = classifyLine(input.line, {
    allowInteractive: input.settings.allowInteractive,
    countTargets: helpers.countTargets,
    fileExists: helpers.fileExists,
  });
  if (cls.refusal) {
    return refuse(cls.refusal, cls.risks);
  }
  const paths = checkLinePaths(input.line, {
    root: input.root,
    cwd: input.cwd,
    previousCwd: input.previousCwd,
  });
  if (!paths.ok) {
    return refuse({ code: paths.code }, cls.risks);
  }
  const ro = checkReadOnlyWrites(input.line, {
    root: input.root,
    cwd: input.cwd,
    previousCwd: input.previousCwd,
    readOnly: input.readOnlyFolders ?? [],
  });
  if (!ro.ok) {
    // Not approvable in any mode: the folder is unlocked only by changing the project config.
    const params = { folder: ro.folder };
    return refuse({ code: "read-only-path", params }, [
      { code: "read-only-path", params },
      ...cls.risks,
    ]);
  }
  const base = {
    readOnly: cls.readOnly,
    printsEnv: cls.printsEnv,
    risks: cls.risks,
    cwdAfter: paths.cwdAfter,
  };
  if (cls.readOnly) {
    return { action: "run", ...base };
  }
  if (input.mode === "plan" || input.settings.actApprovals === "always") {
    return { action: "approve", ...base };
  }
  const policy = input.policy(input.line, input.cwd);
  if (policy.security === "deny") {
    return refuse({ code: "security-deny" }, cls.risks);
  }
  const allowlistMiss =
    policy.security === "allowlist" && !(policy.analysisOk && policy.allowlistSatisfied);
  const ask = requiresExecApproval(policy);
  if (allowlistMiss && policy.ask === "off") {
    return refuse({ code: "allowlist-miss" }, cls.risks);
  }
  const risks = allowlistMiss ? [...cls.risks, { code: "outside-allowlist" as const }] : cls.risks;
  if (ask || allowlistMiss || risks.some((r) => ALWAYS_ASK.has(r.code))) {
    return { action: "approve", ...base, risks };
  }
  return { action: "run", ...base, risks };
}
