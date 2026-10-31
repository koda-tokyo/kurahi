// Signed evidence for verification runs and change-case decisions (KIMS-015, AC-024/025). Every
// terminal outcome — PASS, FAIL, INCONCLUSIVE, NOT_RUN_*, TIMEOUT, CANCELLED, and case
// approvals, rejections, invalidations and handoffs — is written as a sealed bundle in Kurahi's
// standard evidence format (src/evidence/sealed-bundle.ts): a hash-chained events.jsonl and an
// Ed25519-signed manifest.json listing every file with its SHA-256. `kurahi evidence verify
// <dir> [--trust-key <keyId>]` checks it offline; altering the report, an output or the
// manifest, or re-signing with another key, fails.
import type { SealedEventBody } from "../evidence/sealed-bundle.js";
import type { CapturedOutput } from "./runner.js";
import type { VerificationReport } from "./types.js";
import { writeSealedBundle } from "../evidence/sealed-bundle.js";

export const REPORT_JSON = "report.json";
export const REPORT_MD = "REPORT.md";
const MAX_CAPTURED_FILE = 1024 * 1024;
const MAX_CAPTURED_TOTAL = 16 * 1024 * 1024;

export const EVIDENCE_LIMITATIONS = [
  "Signed evidence proves which source snapshots, toolchain, fixtures, comparators and limits were used and what was observed; it does not prove the candidate is semantically correct beyond the behaviour these fixtures exercise.",
  "Comparators are deterministic; no language model takes part in the verdict.",
  "PASS means every observed difference is covered by the approved change spec; untested inputs, paths and environments remain unverified.",
];

function safeSegment(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^[._-]+/, "") || "x";
}

export function reportMarkdown(r: VerificationReport): string {
  const lines = [
    `# Verification ${r.runId}`,
    "",
    `- Verdict: **${r.verdict}** — ${r.reason}`,
    `- Language: ${r.language}; toolchain: ${r.candidate.toolchain.version ?? "none"}`,
    `- Baseline snapshot: \`${r.baseline.snapshot}\``,
    `- Candidate snapshot: \`${r.candidate.snapshot}\``,
    `- Fixtures: ${r.fixtures.cases.length} case(s), digest \`${r.fixtures.digest}\``,
    `- Change spec: ${r.changeSpec ? `${r.changeSpec.id} \`${r.changeSpec.sha256}\`` : "none (every difference is a regression)"}`,
    `- Policy: \`${r.policySha256}\``,
    `- Isolation: ${r.isolation.level}`,
    `- Started ${r.startedAt}, ended ${r.endedAt}`,
    "",
    "## Outputs",
    "",
    "| Fixture | Output | Class |",
    "| --- | --- | --- |",
    ...r.outputs.map((o) => `| ${o.fixture} | ${o.output} | ${o.class} |`),
    "",
    "## Findings",
    "",
    ...(r.findings.length === 0
      ? ["None."]
      : r.findings
          .slice(0, 100)
          .map(
            (f) =>
              `- ${f.class} ${f.fixture}/${f.output}${f.record ? ` record ${f.record}` : ""}${f.field ? ` ${f.field}` : ""}: ${f.detail}${f.baseline !== undefined ? ` (baseline ${f.baseline}, candidate ${f.candidate})` : ""}`,
          )),
    "",
    "## What this proves and what it does not",
    "",
    ...r.limitations.map((l) => `- ${l}`),
    "",
  ];
  return lines.join("\n");
}

/** Seal a verification run into `dir`; returns the chain root and the key id that signed it. */
export function writeVerificationEvidence(
  dir: string,
  report: VerificationReport,
  extras: {
    captured: CapturedOutput[];
    baselineManifest: unknown;
    candidateManifest: unknown;
    changeSpecRaw: Buffer | null;
  },
  opts: { env?: NodeJS.ProcessEnv } = {},
): { root: string } {
  const files: Record<string, Buffer> = {
    [REPORT_JSON]: Buffer.from(`${JSON.stringify(report, null, 1)}\n`),
    [REPORT_MD]: Buffer.from(reportMarkdown(report)),
    "source/baseline-snapshot.json": Buffer.from(
      `${JSON.stringify(extras.baselineManifest, null, 1)}\n`,
    ),
    "source/candidate-snapshot.json": Buffer.from(
      `${JSON.stringify(extras.candidateManifest, null, 1)}\n`,
    ),
  };
  if (extras.changeSpecRaw) {
    files["change-spec.json"] = extras.changeSpecRaw;
  }
  let total = 0;
  const omitted: string[] = [];
  for (const c of extras.captured) {
    const name = `outputs/${c.side}/${safeSegment(c.fixture)}/${safeSegment(c.name)}`;
    if (c.data.length > MAX_CAPTURED_FILE || total + c.data.length > MAX_CAPTURED_TOTAL) {
      omitted.push(name);
      continue;
    }
    total += c.data.length;
    files[name] = c.data;
  }
  const bodies: SealedEventBody[] = [
    {
      type: "job.start",
      ts: report.startedAt,
      data: {
        kind: "modernise.verify",
        runId: report.runId,
        language: report.language,
        baseline: report.baseline.snapshot,
        candidate: report.candidate.snapshot,
        toolchain: report.candidate.toolchain.version,
        fixturesDigest: report.fixtures.digest,
        changeSpec: report.changeSpec,
        policySha256: report.policySha256,
        isolation: report.isolation.level,
      },
    },
    ...report.builds.map((b) => ({
      type: "tool.call" as const,
      ts: report.endedAt,
      data: {
        step: `build.${b.side}`,
        status: b.status,
        ms: b.ms,
        executableSha256: b.executableSha256,
      },
    })),
    ...report.executions.map((e) => ({
      type: "tool.call" as const,
      ts: report.endedAt,
      data: {
        step: `execute.${e.side}`,
        fixture: e.fixture,
        attempt: e.attempt,
        status: e.status,
        exitCode: e.exitCode,
        ms: e.ms,
        stdoutSha256: e.stdoutSha256,
      },
    })),
    {
      type: "audit",
      ts: report.endedAt,
      data: { counts: report.counts, findings: report.findings.length, omittedOutputs: omitted },
    },
    {
      type: "job.end",
      ts: report.endedAt,
      data: { status: report.verdict, reason: report.reason },
    },
  ];
  return writeSealedBundle(
    dir,
    {
      jobId: report.runId,
      agent: "kurahi:modernise_verify",
      sessionKey: `modernise:${report.runId}`,
      kind: "modernise.verify",
      status: report.verdict,
      startedAt: report.startedAt,
      endedAt: report.endedAt,
    },
    bodies,
    { env: opts.env, files },
  );
}

/** Seal one change-case decision (approval, rejection, invalidation, cancellation, handoff). */
export function writeCaseEvidence(
  dir: string,
  meta: { jobId: string; caseId: string; status: string; at: string },
  record: Record<string, unknown>,
  opts: { env?: NodeJS.ProcessEnv } = {},
): { root: string } {
  return writeSealedBundle(
    dir,
    {
      jobId: meta.jobId,
      agent: "kurahi:change-case",
      sessionKey: `modernise:case:${meta.caseId}`,
      kind: "modernise.case",
      status: meta.status,
      startedAt: meta.at,
      endedAt: meta.at,
    },
    [
      { type: "job.start", ts: meta.at, data: { kind: "modernise.case", caseId: meta.caseId } },
      { type: "approval", ts: meta.at, data: { caseId: meta.caseId, status: meta.status } },
      { type: "job.end", ts: meta.at, data: { status: meta.status } },
    ],
    {
      env: opts.env,
      files: { "case-record.json": Buffer.from(`${JSON.stringify(record, null, 1)}\n`) },
    },
  );
}
