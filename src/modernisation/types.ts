// Kurahi Industrial — modernisation verification (KIMS-010/013/014/015): shared types. Nothing
// here runs at import time.

export type SourceLanguage = "cobol" | "fortran" | "pli";

/** What a frozen file looks like, as observed (never guessed beyond these labels). */
export type FileEncoding = "ascii" | "utf-8" | "unknown-8bit" | "binary";
export type LineEnding = "lf" | "crlf" | "cr" | "mixed" | "none";

export type SnapshotFile = {
  path: string;
  sha256: string;
  size: number;
  encoding: FileEncoding;
  lineEnding: LineEnding;
  lines: number;
};

/** The compiler a snapshot is meant to be built with; part of the snapshot identity. */
export type ToolchainIdentity = {
  language: SourceLanguage | "unknown";
  compiler: string | null;
  version: string | null;
  binarySha256: string | null;
  /** Dialect and flags, recorded exactly as passed. */
  dialect: string | null;
  flags: string[];
};

export type SnapshotManifest = {
  schema: "kurahi.source-snapshot/1";
  /** Absolute folder the snapshot was frozen from (provenance only; content is in the store). */
  origin: string;
  parent: string | null;
  files: SnapshotFile[];
  skipped: Array<{ path: string; reason: string }>;
  toolchain: ToolchainIdentity;
};

/** A stored snapshot: id = sha256 of the canonical manifest. */
export type SourceSnapshot = SnapshotManifest & { id: string; createdAt: string };

export type SourceLocator = {
  snapshot: string;
  path: string;
  startLine: number;
  endLine: number;
  /** sha256 of the excerpt (lines startLine..endLine joined with "\n"). */
  sha256: string;
};

export type LocatorCheck = { ok: true } | { ok: false; reason: string };

// ── verification ───────────────────────────────────────────────────────────────────────────

export const VERDICTS = [
  "PASS",
  "FAIL",
  "INCONCLUSIVE",
  "NOT_RUN_COMPILER_UNAVAILABLE",
  "NOT_RUN_NO_FIXTURES",
  "TIMEOUT",
  "CANCELLED",
] as const;
export type Verdict = (typeof VERDICTS)[number];

export type OutputClass = "EQUIVALENT" | "INTENDED_CHANGE" | "REGRESSION" | "INCONCLUSIVE";

export type RunLimits = {
  /** Wall clock per compile or execution, ms. */
  timeoutMs: number;
  /** Cap on stdout, stderr and each output file, bytes; over it the run is INCONCLUSIVE. */
  maxOutputBytes: number;
  /** CPU seconds per execution (prlimit), when prlimit exists. */
  cpuSeconds: number;
};

export type VerifyPolicy = {
  limits: RunLimits;
  /** COBOL dialect (`cobc -std=`), null = compiler default. */
  dialect: string | null;
  /** Extra compiler flags, recorded and hashed into the policy. */
  flags: string[];
  /** Entry source (path inside the snapshot), null = detected. */
  entry: string | null;
  /** Baseline executions per fixture; more than one checks the baseline is reproducible. */
  baselineRuns: number;
};

export type Isolation = {
  /** Human-readable level, recorded in every report. */
  level: string;
  network: "namespace" | "not-isolated";
  rlimits: boolean;
  env: Record<string, string>;
};

export type ExecutionRecord = {
  side: "baseline" | "candidate";
  fixture: string;
  attempt: number;
  status: "ok" | "timeout" | "cancelled" | "output-capped" | "spawn-error";
  exitCode: number | null;
  signal: string | null;
  ms: number;
  stdoutSha256: string;
  stderrSha256: string;
  outputs: Record<string, { sha256: string; size: number }>;
};

export type BuildRecord = {
  side: "baseline" | "candidate";
  status: "ok" | "failed" | "timeout" | "cancelled";
  command: string[];
  ms: number;
  executableSha256: string | null;
  diagnostics: string;
};

export type DiffFinding = {
  fixture: string;
  output: string;
  class: OutputClass;
  detail: string;
  record?: number;
  field?: string;
  baseline?: string;
  candidate?: string;
};

export type VerificationReport = {
  schema: "kurahi.verification-report/1";
  runId: string;
  verdict: Verdict;
  reason: string;
  language: SourceLanguage | "unknown";
  startedAt: string;
  endedAt: string;
  baseline: { snapshot: string; toolchain: ToolchainIdentity };
  candidate: { snapshot: string; toolchain: ToolchainIdentity };
  fixtures: { digest: string; cases: string[] };
  changeSpec: { id: string; sha256: string } | null;
  policy: VerifyPolicy;
  policySha256: string;
  isolation: Isolation;
  builds: BuildRecord[];
  executions: ExecutionRecord[];
  outputs: Array<{ fixture: string; output: string; class: OutputClass }>;
  findings: DiffFinding[];
  counts: Record<OutputClass, number>;
  limitations: string[];
};
