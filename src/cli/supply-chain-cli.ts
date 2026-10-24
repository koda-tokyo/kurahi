// `pin` and `verify` subcommands under `kurahi skills` and `kurahi plugins` (OWASP ASI04).
// Logic lives in supply-chain-actions.ts; this file parses options and formats the result.

import type { Command } from "commander";
import type { SupplyChainKind } from "../integrity/supply-chain-lock.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { auditSafe } from "../audit/audit-log.js";
import { loadConfig } from "../config/config.js";
import { describeCheck, resolveSupplyChainMode } from "../integrity/supply-chain-gate.js";
import { defaultRuntime } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import {
  collectPluginArtifacts,
  collectSkillArtifacts,
  pinArtifacts,
  verifyArtifacts,
  type PinResult,
  type VerifyResult,
} from "./supply-chain-actions.js";

type CommonOpts = { agent?: string; json?: boolean };

function context(opts: CommonOpts) {
  const config = loadConfig();
  const agentId = opts.agent?.trim() || resolveDefaultAgentId(config);
  const workspaceDir = resolveAgentWorkspaceDir(config, agentId);
  return { config, workspaceDir };
}

export function formatPinResult(result: PinResult): string {
  if (result.refused) {
    return theme.error(`refused: ${result.refused}`);
  }
  const lines: string[] = [];
  for (const o of result.outcomes) {
    const head = `${o.status.padEnd(9)} ${result.kind} ${o.name}`;
    if (o.status === "flagged" || (o.status === "pinned" && o.findings)) {
      lines.push(o.status === "flagged" ? theme.warn(head) : head);
      for (const f of o.findings ?? []) {
        lines.push(theme.muted(`  ${f.rule}: ${f.file}:${f.line}  ${f.excerpt}`));
      }
    } else if (o.status === "error") {
      lines.push(theme.error(`${head}: ${o.error}`));
    } else {
      lines.push(`${head}${o.sha256 ? theme.muted(`  ${o.sha256.slice(0, 16)}`) : ""}`);
    }
  }
  if (result.outcomes.some((o) => o.status === "flagged")) {
    lines.push(
      theme.warn(
        "Flagged content was not pinned. Read the lines above; if they are intended, pin again with --force. (A pattern scan, not a malware scanner: a clean scan proves nothing.)",
      ),
    );
  }
  if (result.rebuilt) {
    lines.push(theme.warn("The untrusted lock was discarded and rebuilt from what is on disk."));
  }
  if (result.written) {
    lines.push(
      theme.muted(
        `lock ${result.lockPath} ${result.written.signed ? `signed by ${result.written.keyId.slice(0, 16)}` : "written, signer is not a pinned owner"}`,
      ),
    );
  } else if (result.outcomes.length === 0) {
    lines.push(theme.muted(`nothing to pin`));
  }
  return lines.join("\n");
}

export function formatVerifyResult(result: VerifyResult, mode: string): string {
  const lines = [
    `${theme.heading("Supply-chain lock")} ${result.lockPath} (${result.trust}${result.trustReason ? `: ${result.trustReason}` : ""}; mode ${mode})`,
  ];
  for (const c of result.checks) {
    const head = `${c.status.padEnd(14)} ${c.kind} ${c.name}`;
    if (c.status === "pinned" || c.status === "exempt") {
      lines.push(theme.muted(head));
    } else {
      lines.push(theme.warn(head));
      lines.push(theme.muted(`  ${describeCheck(c)}`));
    }
  }
  lines.push(result.ok ? theme.success("ok") : theme.warn("not ok"));
  return lines.join("\n");
}

async function runPin(
  kind: SupplyChainKind,
  names: string[],
  opts: CommonOpts & { all?: boolean; force?: boolean },
) {
  if (!opts.all && names.length === 0) {
    defaultRuntime.error(`name a ${kind} to pin, or pass --all`);
    defaultRuntime.exit(1);
  }
  const { config, workspaceDir } = context(opts);
  const artifacts =
    kind === "skill"
      ? collectSkillArtifacts(config, workspaceDir)
      : collectPluginArtifacts(config, workspaceDir);
  const result = pinArtifacts({
    kind,
    artifacts,
    names,
    all: Boolean(opts.all),
    force: Boolean(opts.force),
  });
  const failed =
    Boolean(result.refused) ||
    result.outcomes.some((o) => o.status === "flagged" || o.status === "error");
  await auditSafe({
    action: "supply-chain.pin",
    outcome: result.refused ? "denied" : failed ? "failed" : "ok",
    source: "cli",
    detail: {
      kind,
      all: Boolean(opts.all),
      force: Boolean(opts.force),
      rebuilt: result.rebuilt,
      refused: result.refused ?? null,
      outcomes: result.outcomes.map((o) => ({
        name: o.name,
        status: o.status,
        sha256: o.sha256 ?? null,
        findings: o.findings?.map((f) => `${f.rule}@${f.file}:${f.line}`) ?? [],
      })),
    },
  });
  defaultRuntime.log(opts.json ? JSON.stringify(result, null, 2) : formatPinResult(result));
  if (failed) {
    defaultRuntime.exit(1);
  }
}

async function runVerify(opts: CommonOpts) {
  const { config, workspaceDir } = context(opts);
  const result = verifyArtifacts({
    artifacts: [
      ...collectSkillArtifacts(config, workspaceDir),
      ...collectPluginArtifacts(config, workspaceDir),
    ],
  });
  const mode = resolveSupplyChainMode(config);
  defaultRuntime.log(
    opts.json ? JSON.stringify({ ...result, mode }, null, 2) : formatVerifyResult(result, mode),
  );
  if (!result.ok) {
    defaultRuntime.exit(1);
  }
}

/** Add `pin` and `verify` to the `skills` or `plugins` command. */
export function registerSupplyChainCommands(parent: Command, kind: SupplyChainKind) {
  const noun = kind === "skill" ? "skill" : "plugin";
  parent
    .command("pin")
    .description(`Review-and-approve: pin ${noun}s in the supply-chain lock (scans first)`)
    .argument("[names...]", `${noun} name(s)`)
    .option(
      "--all",
      `Pin every non-bundled ${noun} (drops lock entries that no longer exist)`,
      false,
    )
    .option("--force", "Pin even when the static scan flags content", false)
    .option("--agent <id>", "Agent whose workspace to read (default agent otherwise)")
    .option("--json", "Output as JSON", false)
    .action(async (names: string[], opts) => {
      try {
        await runPin(kind, names ?? [], opts);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
  parent
    .command("verify")
    .description("Check skills and plugins against the supply-chain lock")
    .option("--agent <id>", "Agent whose workspace to read (default agent otherwise)")
    .option("--json", "Output as JSON", false)
    .action(async (opts) => {
      try {
        await runVerify(opts);
      } catch (err) {
        defaultRuntime.error(String(err));
        defaultRuntime.exit(1);
      }
    });
}
