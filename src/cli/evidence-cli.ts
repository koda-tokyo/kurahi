// `kurahi evidence …` — evidence bundles and replay (KoLo 2.0, M12).
//
//   kurahi evidence list [--json]                       jobs with evidence under KOLO_HOME
//   kurahi evidence show <jobId> [--json]               summary of one job's evidence
//   kurahi evidence export <jobId> --out <dir|zip>      signed bundle: manifest, events, snapshots,
//                                                     audit slice, REPORT.md
//   kurahi evidence verify <bundle> [--json]            recompute every hash and signature offline
//        [--trust-key <keyId...>]                       and require one of these signer keys
//   kurahi evidence replay <bundle|jobId> [--step N]    walk the events with a stepper
//   kurahi evidence prune [--days N] [--dry-run]        apply retention
//
// Nothing here talks to a gateway: the store and the signing key live under KOLO_HOME, and a
// bundle verifies from its own files. Exit codes: 0 ok, 1 a check failed, 2 usage.
import type { Command } from "commander";
import path from "node:path";
import type { EvidenceSummary } from "../evidence/types.js";
import { loadConfig } from "../config/config.js";
import { exportEvidenceBundle } from "../evidence/bundle.js";
import { pruneEvidence } from "../evidence/prune.js";
import { runReplayCli } from "../evidence/replay-cli.js";
import {
  isSafeJobId,
  listEvidenceJobs,
  readJobEvents,
  readJobManifest,
  resolveEvidenceLimits,
  resolveJobEvidenceDir,
} from "../evidence/store.js";
import { summarizeEvents } from "../evidence/summary.js";
import { type BundleVerification, verifyEvidenceBundle } from "../evidence/verify.js";
import { governanceConfigOf, minimumDays as governanceMinimumDays } from "../governance/policy.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { renderTable } from "../terminal/table.js";
import { theme } from "../terminal/theme.js";
import { formatCliCommand } from "./command-format.js";

export const EVIDENCE_EXIT = { ok: 0, failed: 1, usage: 2 } as const;

export type EvidenceCliDeps = { runtime?: RuntimeEnv; env?: NodeJS.ProcessEnv };

function fmtBytes(n: number): string {
  if (n < 1024) {
    return `${n} B`;
  }
  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KiB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}

export function summaryLines(s: EvidenceSummary, extra: Record<string, string> = {}): string[] {
  const lines = [
    `job          ${s.jobId}`,
    `agent        ${s.agent}`,
    `session      ${s.sessionKey}`,
    `kind         ${s.kind}`,
    `status       ${s.status}${s.error ? ` (${s.error})` : ""}`,
    `started      ${s.startedAt}`,
    `ended        ${s.endedAt ?? "running"}`,
    `events       ${s.events}${s.truncated ? " (truncated by the size cap)" : ""}`,
    `model turns  ${s.modelTurns} (input ${s.usage.input ?? 0}, output ${s.usage.output ?? 0} tokens)`,
    `tool calls   ${s.toolCalls} (${s.toolErrors} failed)${
      Object.keys(s.tools).length
        ? `: ${Object.entries(s.tools)
            .map(([k, v]) => `${k} x${v}`)
            .join(", ")}`
        : ""
    }`,
    `files        ${s.filesChanged.length ? s.filesChanged.join(", ") : "none"}`,
    `policy       ${s.permissions.allowed} allowed, ${s.permissions.denied} denied, ${s.loopStops} loop stop${s.loopStops === 1 ? "" : "s"}`,
    `audit links  ${s.auditSeqs.length ? s.auditSeqs.join(", ") : "none"}`,
    `prompt       sha256 ${s.promptDigest ?? "n/a"} (${s.promptChars ?? 0} chars)`,
    `signed       ${s.signed ? "yes" : "no"}`,
  ];
  for (const [k, v] of Object.entries(extra)) {
    lines.push(`${k.padEnd(12)} ${v}`);
  }
  return lines;
}

export function verificationLines(target: string, v: BundleVerification): string[] {
  const mark = (ok: boolean | null) => (ok === null ? "n/a" : ok ? "ok" : "FAIL");
  const lines = [
    `bundle       ${target}`,
    `job          ${v.manifest?.jobId ?? "unknown"}`,
    `status       ${v.manifest?.status ?? "unknown"} (as recorded)`,
    `events       ${v.events}`,
    `chain        ${mark(v.chainOk)}${v.firstBreak !== undefined ? ` (first break at event ${v.firstBreak})` : ""}`,
    `root         ${mark(v.rootOk)}`,
    `files        ${mark(v.filesOk)}`,
    `signature    ${mark(v.keyIdOk && v.signatureOk)}${v.manifest ? ` key ${v.manifest.signer.keyId.slice(0, 16)}` : ""}`,
    `job-end sig  ${mark(v.recordedOk)}`,
    `audit slice  ${mark(v.auditSliceOk)}`,
    `snapshots    ${mark(v.snapshotsOk)}`,
    `trusted key  ${v.trustedOk === null || v.trustedOk === undefined ? "not checked (no --trust-key)" : mark(v.trustedOk)}`,
    `verdict      ${v.ok ? "PASS" : "FAIL"}`,
  ];
  for (const p of v.problems) {
    lines.push(`  ${p}`);
  }
  return lines;
}

export function runEvidenceList(opts: { json?: boolean }, deps: EvidenceCliDeps = {}): number {
  const runtime = deps.runtime ?? defaultRuntime;
  const rows = listEvidenceJobs(deps.env);
  if (opts.json) {
    runtime.log(JSON.stringify({ jobs: rows }, null, 2));
    return EVIDENCE_EXIT.ok;
  }
  if (rows.length === 0) {
    runtime.log(
      "evidence: no jobs recorded yet (every agent run records one under KOLO_HOME/evidence)",
    );
    return EVIDENCE_EXIT.ok;
  }
  runtime.log(
    renderTable({
      columns: [
        { key: "job", header: "Job", flex: true },
        { key: "agent", header: "Agent" },
        { key: "status", header: "Status" },
        { key: "started", header: "Started" },
        { key: "events", header: "Events", align: "right" },
        { key: "size", header: "Size", align: "right" },
        { key: "signed", header: "Signed" },
      ],
      rows: rows.map((r) => ({
        job: r.jobId,
        agent: r.agent ?? "",
        status: r.status ?? "",
        started: r.startedAt ?? "",
        events: String(r.events),
        size: fmtBytes(r.bytes),
        signed: r.signed ? "yes" : "no",
      })),
    }),
  );
  return EVIDENCE_EXIT.ok;
}

export function runEvidenceShow(
  jobId: string | undefined,
  opts: { json?: boolean },
  deps: EvidenceCliDeps = {},
): number {
  const runtime = deps.runtime ?? defaultRuntime;
  const id = jobId?.trim() ?? "";
  if (!id || !isSafeJobId(id)) {
    runtime.error("kurahi evidence show: a job id is required");
    return EVIDENCE_EXIT.usage;
  }
  const events = readJobEvents(id, deps.env);
  if (events.length === 0) {
    runtime.error(
      `kurahi evidence show: no evidence for job ${id}. List jobs with: kurahi evidence list`,
    );
    return EVIDENCE_EXIT.failed;
  }
  const manifest = readJobManifest(id, deps.env);
  const summary = summarizeEvents(events, { signed: Boolean(manifest) });
  if (opts.json) {
    runtime.log(JSON.stringify({ summary, manifest }, null, 2));
  } else {
    runtime.log(
      summaryLines(summary, {
        dir: resolveJobEvidenceDir(id, deps.env),
        ...(manifest ? { root: manifest.events.root, key: manifest.signer.keyId } : {}),
      }).join("\n"),
    );
  }
  return EVIDENCE_EXIT.ok;
}

export async function runEvidenceExport(
  jobId: string | undefined,
  opts: { out?: string; json?: boolean },
  deps: EvidenceCliDeps = {},
): Promise<number> {
  const runtime = deps.runtime ?? defaultRuntime;
  const id = jobId?.trim() ?? "";
  if (!id || !isSafeJobId(id)) {
    runtime.error("kurahi evidence export: a job id is required");
    return EVIDENCE_EXIT.usage;
  }
  const out = opts.out?.trim() || path.join("evidence-out", id);
  try {
    const result = await exportEvidenceBundle({ jobId: id, out, env: deps.env });
    if (opts.json) {
      runtime.log(
        JSON.stringify(
          {
            path: result.path,
            format: result.format,
            files: result.files,
            bytes: result.bytes,
            manifest: result.manifest,
            summary: result.summary,
          },
          null,
          2,
        ),
      );
    } else {
      runtime.log(
        [
          `bundle       ${result.path} (${result.format}, ${fmtBytes(result.bytes)}, ${result.files.length} files)`,
          `job          ${result.manifest.jobId}`,
          `status       ${result.manifest.status}`,
          `events       ${result.manifest.events.count}`,
          `root         ${result.manifest.events.root}`,
          `key          ${result.manifest.signer.keyId}`,
          `verify with  ${formatCliCommand(`kurahi evidence verify ${result.path}`)}`,
        ].join("\n"),
      );
    }
    return EVIDENCE_EXIT.ok;
  } catch (err) {
    runtime.error(`kurahi evidence export: ${err instanceof Error ? err.message : String(err)}`);
    return EVIDENCE_EXIT.failed;
  }
}

export async function runEvidenceVerify(
  target: string | undefined,
  opts: { json?: boolean; trustKey?: string[] },
  deps: EvidenceCliDeps = {},
): Promise<number> {
  const runtime = deps.runtime ?? defaultRuntime;
  const bundle = target?.trim() ?? "";
  if (!bundle) {
    runtime.error("kurahi evidence verify: a bundle directory or zip is required");
    return EVIDENCE_EXIT.usage;
  }
  let result: BundleVerification;
  try {
    result = await verifyEvidenceBundle(bundle, { trustedKeyIds: opts.trustKey });
  } catch (err) {
    runtime.error(
      `kurahi evidence verify: cannot read ${bundle} (${err instanceof Error ? err.message : String(err)})`,
    );
    return EVIDENCE_EXIT.failed;
  }
  if (opts.json) {
    runtime.log(JSON.stringify({ bundle, ...result }, null, 2));
  } else {
    runtime.log(verificationLines(bundle, result).join("\n"));
  }
  return result.ok ? EVIDENCE_EXIT.ok : EVIDENCE_EXIT.failed;
}

export function runEvidencePrune(
  opts: { days?: string; dryRun?: boolean; json?: boolean },
  deps: EvidenceCliDeps = {},
): number {
  const runtime = deps.runtime ?? defaultRuntime;
  let days: number;
  const cfg = loadConfig();
  // With data governance configured, its evidence minimum is a floor (audit integrity).
  const minimumDays = cfg.governance
    ? governanceMinimumDays(governanceConfigOf(cfg)).evidence
    : undefined;
  if (opts.days !== undefined) {
    days = Number.parseInt(opts.days, 10);
    if (!Number.isInteger(days) || days < 0) {
      runtime.error(
        `kurahi evidence prune: --days must be a non-negative integer; got "${opts.days}"`,
      );
      return EVIDENCE_EXIT.usage;
    }
  } else {
    days = resolveEvidenceLimits(cfg.evidence).retentionDays;
  }
  const result = pruneEvidence({ days, minimumDays, dryRun: opts.dryRun, env: deps.env });
  if (opts.json) {
    runtime.log(JSON.stringify({ days, dryRun: Boolean(opts.dryRun), ...result }, null, 2));
    return EVIDENCE_EXIT.ok;
  }
  const bytes = result.removed.reduce((n, r) => n + r.bytes, 0);
  runtime.log(
    `${opts.dryRun ? "would remove" : "removed"} ${result.removed.length} job${result.removed.length === 1 ? "" : "s"} older than ${days} day${days === 1 ? "" : "s"} (${fmtBytes(bytes)}); kept ${result.kept}${result.held ? ` (${result.held} under legal hold)` : ""}`,
  );
  for (const r of result.removed) {
    runtime.log(`  ${r.jobId}  ended ${r.endedAt}  ${fmtBytes(r.bytes)}`);
  }
  return EVIDENCE_EXIT.ok;
}

export function registerEvidenceCli(program: Command, deps: EvidenceCliDeps = {}) {
  const runtime = deps.runtime ?? defaultRuntime;
  const exit = (code: number) => {
    if (code !== EVIDENCE_EXIT.ok) {
      runtime.exit(code);
    }
  };
  const cmd = program
    .command("evidence")
    .description("Evidence bundles: a signed, replayable record of every agent job")
    .addHelpText("after", () =>
      [
        "",
        theme.muted("Examples:"),
        `  ${formatCliCommand("kurahi evidence list")}`,
        `  ${formatCliCommand("kurahi evidence export 3f1c... --out ./evidence-out/3f1c.zip")}`,
        `  ${formatCliCommand("kurahi evidence verify ./evidence-out/3f1c.zip")}`,
        `  ${formatCliCommand("kurahi evidence replay ./evidence-out/3f1c.zip --step 4")}`,
        "",
        "Exit codes: 0 ok, 1 a check failed or the job has no evidence, 2 usage.",
        `Docs: ${formatDocsLink("/evidence")}`,
        "",
      ].join("\n"),
    );

  cmd
    .command("list")
    .alias("ls")
    .description("Jobs with evidence under the state dir, newest first")
    .option("--json", "JSON output", false)
    .action((opts: { json?: boolean }) => exit(runEvidenceList(opts, deps)));

  cmd
    .command("show <jobId>")
    .alias("info")
    .description("Summary of one job's evidence")
    .option("--json", "JSON output", false)
    .action((jobId: string, opts: { json?: boolean }) => exit(runEvidenceShow(jobId, opts, deps)));

  cmd
    .command("export <jobId>")
    .description("Write a signed bundle (directory, or a zip when --out ends in .zip)")
    .option("--out <path>", "target directory or .zip file (evidence-out/<jobId>)")
    .option("--json", "JSON output", false)
    .action(async (jobId: string, opts: { out?: string; json?: boolean }) =>
      exit(await runEvidenceExport(jobId, opts, deps)),
    );

  cmd
    .command("verify <bundle>")
    .alias("check")
    .description("Recompute every hash and signature of a bundle offline (exit 1 on any failure)")
    .option("--json", "JSON output", false)
    .option(
      "--trust-key <keyId...>",
      "accept only these signer key ids (sha256 of the public key; see manifest.json signer.keyId)",
    )
    .action(async (bundle: string, opts: { json?: boolean; trustKey?: string[] }) =>
      exit(await runEvidenceVerify(bundle, opts, deps)),
    );

  cmd
    .command("replay <target>")
    .description("Step through a bundle (or a job id under the state dir): next, prev, jump")
    .option("--step <n>", "print one step and exit (1-based)")
    .option("--json", "JSON output: the state at --step, or every step", false)
    .action(async (target: string, opts: { step?: string; json?: boolean }) =>
      exit(await runReplayCli(target, opts, deps)),
    );

  cmd
    .command("prune")
    .description("Remove evidence older than the retention period")
    .option("--days <n>", "retention in days (evidence.retentionDays, default 30)")
    .option("--dry-run", "list what would be removed and change nothing", false)
    .option("--json", "JSON output", false)
    .action((opts: { days?: string; dryRun?: boolean; json?: boolean }) =>
      exit(runEvidencePrune(opts, deps)),
    );
}
