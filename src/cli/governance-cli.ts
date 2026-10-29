// `kurahi governance` (docs/security/data-governance.md):
//   kurahi governance sweep [--dry-run] [--json]     run the retention sweeper now (host operator)
//   kurahi governance holds [--all] [--json]         list legal holds
//   kurahi governance verify-export <zip> [--json]   verify an eDiscovery export offline
//
// Holds, exports and data subject requests are person-only gateway methods; the CLI does not
// create or release them.
import type { Command } from "commander";
import fs from "node:fs";
import { loadConfig } from "../config/config.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { verifyGovernanceExport } from "../governance/export.js";
import { listHolds } from "../governance/holds.js";
import { runRetentionSweep } from "../governance/sweeper.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";

export const GOVERNANCE_EXIT = { ok: 0, failed: 1, usage: 2 } as const;

export type GovernanceCliDeps = { runtime?: RuntimeEnv; home?: string };

export async function runGovernanceSweep(
  opts: { dryRun?: boolean; json?: boolean },
  deps: GovernanceCliDeps = {},
): Promise<number> {
  const runtime = deps.runtime ?? defaultRuntime;
  const result = await runRetentionSweep({
    home: deps.home ?? resolveKoloHome(),
    config: loadConfig(),
    dryRun: opts.dryRun,
    by: "cli",
  });
  if (opts.json) {
    runtime.log(JSON.stringify(result, null, 2));
    return GOVERNANCE_EXIT.ok;
  }
  runtime.log(
    `${opts.dryRun ? "dry run" : "sweep"} at ${result.at}; ${result.holds} active hold(s)${result.manifestId ? `; deletion manifest ${result.manifestId}` : ""}`,
  );
  for (const [cls, t] of Object.entries(result.classes)) {
    if (t.deleted + t.anonymized + t.held + t.failed > 0) {
      runtime.log(
        `  ${cls}: ${t.deleted} deleted, ${t.anonymized} anonymized, ${t.held} held, ${t.failed} failed`,
      );
    }
  }
  return GOVERNANCE_EXIT.ok;
}

export async function runGovernanceVerifyExport(
  file: string,
  opts: { json?: boolean },
  deps: GovernanceCliDeps = {},
): Promise<number> {
  const runtime = deps.runtime ?? defaultRuntime;
  let buf: Buffer;
  try {
    buf = fs.readFileSync(file);
  } catch (err) {
    runtime.error(`kurahi governance verify-export: cannot read ${file}: ${String(err)}`);
    return GOVERNANCE_EXIT.usage;
  }
  const v = await verifyGovernanceExport(buf);
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        { ...v, manifest: undefined, exportId: v.manifest?.exportId ?? null },
        null,
        2,
      ),
    );
  } else {
    runtime.log(
      `${v.ok ? theme.success("verified") : theme.error("FAILED")} ${typeof v.manifest?.exportId === "string" ? v.manifest.exportId : file}: signature ${v.signatureOk ? "ok" : "bad"}, files ${v.filesOk ? "ok" : "bad"}`,
    );
    for (const p of v.problems.slice(0, 50)) {
      runtime.log(`  ${p}`);
    }
  }
  return v.ok ? GOVERNANCE_EXIT.ok : GOVERNANCE_EXIT.failed;
}

export function registerGovernanceCli(program: Command, deps: GovernanceCliDeps = {}) {
  const runtime = deps.runtime ?? defaultRuntime;
  const exit = (code: number) => {
    if (code !== GOVERNANCE_EXIT.ok) {
      runtime.exit(code);
    }
  };
  const cmd = program
    .command("governance")
    .description("Data governance: retention sweep, legal holds, eDiscovery export verification")
    .addHelpText("after", () =>
      [
        "",
        theme.muted("Examples:"),
        `  ${formatCliCommand("kurahi governance sweep --dry-run")}`,
        `  ${formatCliCommand("kurahi governance verify-export export.zip")}`,
      ].join("\n"),
    );
  cmd
    .command("sweep")
    .description("Apply the retention policy now (skips everything under a legal hold)")
    .option("--dry-run", "report what would change and change nothing", false)
    .option("--json", "JSON output", false)
    .action(async (opts: { dryRun?: boolean; json?: boolean }) =>
      exit(await runGovernanceSweep(opts, deps)),
    );
  cmd
    .command("holds")
    .description("List legal holds (active by default)")
    .option("--all", "include released holds", false)
    .option("--json", "JSON output", false)
    .action((opts: { all?: boolean; json?: boolean }) => {
      const holds = listHolds(deps.home ?? resolveKoloHome()).filter(
        (h) => opts.all || h.status === "active",
      );
      if (opts.json) {
        runtime.log(JSON.stringify(holds, null, 2));
        return;
      }
      for (const h of holds) {
        runtime.log(
          `${h.id}  ${h.status}  matter ${h.matterId}  by ${h.createdBy}  ${h.createdAt}`,
        );
      }
      if (holds.length === 0) {
        runtime.log("no legal holds");
      }
    });
  cmd
    .command("verify-export <zip>")
    .description("Verify an eDiscovery export offline: signature and every file's SHA-256")
    .option("--json", "JSON output", false)
    .action(async (zip: string, opts: { json?: boolean }) =>
      exit(await runGovernanceVerifyExport(zip, opts, deps)),
    );
}
