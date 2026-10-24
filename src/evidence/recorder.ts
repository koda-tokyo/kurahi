// Evidence recorder (KoLo 2.0, M12a): one per job. Appends an ordered, hash-chained event log
// under <KOLO_HOME>/evidence/<jobId>/events.jsonl while the job runs and signs a manifest when it
// ends. Everything written is redacted with the audit patterns and bounded by `evidence.*`; raw
// prompts and assistant text are digests unless `evidence.includePrompts` is on.
//
// Failures never reach the run: every write is wrapped, and a recorder that cannot write simply
// stops recording (the manifest then says how many events it holds).
import fs from "node:fs";
import path from "node:path";
import type { JobRecord } from "../agents/jobs.js";
import type { LoopLimits, LoopVerdict } from "../agents/loop-guard.js";
import type { AuditEntry } from "../audit/audit-log.js";
import type { KoLoConfig } from "../config/config.js";
import type { SigningKey } from "../continuity-suite/manifest.js";
import type { EvidenceEvent, EvidenceEventType, EvidenceUsage, EvidenceManifest } from "./types.js";
import { inventoryConfigDigest } from "../inventory/inventory.js";
import { getPolicyEngine } from "../policy/engine.js";
import { emitEvidenceSignal, subscribeEvidenceSignals, type EvidenceSignal } from "./bus.js";
import { costSnapshot } from "./cost.js";
import { pruneEvidence } from "./prune.js";
import { boundedText, boundedValue, digestOf, resultText } from "./redact.js";
import { evidenceProcessOwner, sealInterruptedEvidence } from "./seal.js";
import {
  EVENTS_FILE,
  EVIDENCE_GENESIS,
  EVIDENCE_VERSION,
  type EvidenceLimits,
  eventHash,
  fileEntryOf,
  MANIFEST_FILE,
  resolveEvidenceLimits,
  resolveEvidenceSigningKey,
  resolveJobEvidenceDir,
  signEvidenceManifest,
} from "./store.js";

export { emitEvidenceSignal };

export type RecorderOptions = {
  limits?: EvidenceLimits;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  key?: SigningKey;
  gatewayVersion?: string;
  /** Where write failures are reported (default: stderr, once). */
  onError?: (message: string) => void;
  /** Defaults for `job.start`'s policy and inventory digests (startEvidence fills these). */
  startDigests?: { policyDigest?: string | null; inventoryDigest?: string | null };
};

export type ModelTurnInput = {
  provider?: string;
  model?: string;
  profileId?: string;
  usage?: EvidenceUsage;
  stopReason?: string;
  text?: string;
  /** Reasoning of this turn; recorded only with `evidence.includeReasoning`. */
  reasoning?: string;
  errorMessage?: string;
};

export class EvidenceRecorder {
  readonly jobId: string;
  readonly dir: string;
  readonly limits: EvidenceLimits;
  private readonly env: NodeJS.ProcessEnv;
  private readonly now: () => Date;
  private readonly key?: SigningKey;
  private readonly gatewayVersion?: string;
  private readonly onError: (message: string) => void;
  private readonly toolStarts = new Map<string, number>();
  private readonly usageByModel = new Map<
    string,
    { provider: string; model: string; input: number; output: number }
  >();
  private readonly outputs = new Map<
    string,
    { path: string; sha256: string | null; size: number | null }
  >();
  private readonly startDigests: { policyDigest?: string | null; inventoryDigest?: string | null };
  private readonly unsubscribe: () => void;
  private seq = 0;
  private prev = EVIDENCE_GENESIS;
  private bytes = 0;
  private turns = 0;
  private truncated = false;
  private failed = false;
  private finished = false;
  private manifest: EvidenceManifest | null = null;
  private readonly job: Pick<JobRecord, "id" | "agent" | "sessionKey" | "kind" | "startedAt">;

  constructor(
    job: Pick<JobRecord, "id" | "agent" | "sessionKey" | "kind" | "startedAt">,
    opts: RecorderOptions = {},
  ) {
    this.job = job;
    this.jobId = job.id;
    this.env = opts.env ?? process.env;
    this.limits = opts.limits ?? resolveEvidenceLimits();
    this.now = opts.now ?? (() => new Date());
    this.key = opts.key;
    this.gatewayVersion = opts.gatewayVersion;
    this.startDigests = opts.startDigests ?? {};
    let reported = false;
    this.onError =
      opts.onError ??
      ((message) => {
        if (!reported) {
          reported = true;
          process.stderr.write(`${message}\n`);
        }
      });
    this.dir = resolveJobEvidenceDir(job.id, this.env);
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    } catch (err) {
      this.fail(`evidence: cannot create ${this.dir}: ${String(err)}`);
    }
    this.unsubscribe = subscribeEvidenceSignals(job.sessionKey, (signal) => this.onSignal(signal));
  }

  get eventCount(): number {
    return this.seq;
  }

  get root(): string {
    return this.prev;
  }

  get isTruncated(): boolean {
    return this.truncated;
  }

  get isFinished(): boolean {
    return this.finished;
  }

  get signedManifest(): EvidenceManifest | null {
    return this.manifest;
  }

  private fail(message: string): void {
    if (!this.failed) {
      this.failed = true;
      this.onError(message);
    }
  }

  /** Append one event; the only writer of the chain. Caps close the log with `truncated`. */
  append(type: EvidenceEventType, data: Record<string, unknown>): EvidenceEvent | null {
    if (this.failed || this.finished) {
      return null;
    }
    if (this.truncated) {
      return type === "job.end" ? this.write(type, data) : null;
    }
    if (
      type !== "job.end" &&
      (this.seq >= this.limits.maxEvents || this.bytes >= this.limits.maxBytesPerJob)
    ) {
      this.truncated = true;
      return this.write("truncated", {
        reason: this.seq >= this.limits.maxEvents ? "max_events" : "max_bytes",
        events: this.seq,
        bytes: this.bytes,
      });
    }
    return this.write(type, data);
  }

  private write(type: EvidenceEventType, data: Record<string, unknown>): EvidenceEvent | null {
    const base = { seq: this.seq + 1, ts: this.now().toISOString(), type, jobId: this.jobId, data };
    const hash = eventHash(this.prev, base);
    const event: EvidenceEvent = { ...base, prev: this.prev, hash };
    const line = `${JSON.stringify(event)}\n`;
    try {
      fs.appendFileSync(path.join(this.dir, EVENTS_FILE), line, { mode: 0o600 });
    } catch (err) {
      this.fail(`evidence: append failed for job ${this.jobId}: ${String(err)}`);
      return null;
    }
    this.seq = base.seq;
    this.prev = hash;
    this.bytes += Buffer.byteLength(line, "utf8");
    return event;
  }

  start(input: {
    prompt?: string;
    provider?: string;
    model?: string;
    runId?: string;
    workspaceDir?: string;
    parentJobId?: string;
    /** SHA-256 of the policy in force when the job started (null: no policy loaded). */
    policyDigest?: string | null;
    /** Configuration digest of the AI inventory when the job started. */
    inventoryDigest?: string | null;
  }): void {
    const prompt = input.prompt ?? "";
    const data: Record<string, unknown> = {
      agent: this.job.agent,
      sessionKey: this.job.sessionKey,
      kind: this.job.kind,
      startedAt: this.job.startedAt,
      // Which process is writing this log: the seal never closes a log whose owner is alive.
      owner: evidenceProcessOwner(),
      runId: input.runId ?? null,
      provider: input.provider ?? null,
      model: input.model ?? null,
      workspaceDir: input.workspaceDir ?? null,
      parentJobId: input.parentJobId ?? null,
      policyDigest: input.policyDigest ?? this.startDigests.policyDigest ?? null,
      inventoryDigest: input.inventoryDigest ?? this.startDigests.inventoryDigest ?? null,
      promptDigest: digestOf(prompt),
      promptChars: prompt.length,
      includePrompts: this.limits.includePrompts,
      limits: {
        maxEvents: this.limits.maxEvents,
        maxEventBytes: this.limits.maxEventBytes,
        maxBytesPerJob: this.limits.maxBytesPerJob,
      },
    };
    if (this.limits.includePrompts) {
      const bounded = boundedText(prompt, this.limits.maxEventBytes);
      data.prompt = bounded.text;
      data.promptClipped = bounded.clipped;
    }
    this.append("job.start", data);
  }

  modelTurn(input: ModelTurnInput): void {
    this.turns += 1;
    const text = input.text ?? "";
    if (input.usage && (input.provider || input.model)) {
      const k = `${input.provider ?? ""}/${input.model ?? ""}`;
      const acc = this.usageByModel.get(k) ?? {
        provider: input.provider ?? "",
        model: input.model ?? "",
        input: 0,
        output: 0,
      };
      acc.input += input.usage.input ?? 0;
      acc.output += input.usage.output ?? 0;
      this.usageByModel.set(k, acc);
    }
    const data: Record<string, unknown> = {
      index: this.turns,
      provider: input.provider ?? null,
      model: input.model ?? null,
      profileId: input.profileId ?? null,
      usage: input.usage ?? null,
      stopReason: input.stopReason ?? null,
      textDigest: digestOf(text),
      textChars: text.length,
      error: input.errorMessage ? boundedText(input.errorMessage, 1024).text : null,
    };
    if (this.limits.includePrompts) {
      const bounded = boundedText(text, this.limits.maxEventBytes);
      data.text = bounded.text;
      data.textClipped = bounded.clipped;
    } else {
      // A short redacted excerpt so a reviewer can follow the run without the full text.
      const excerpt = boundedText(text, Math.min(512, this.limits.maxEventBytes));
      data.excerpt = excerpt.text;
      data.excerptClipped = excerpt.clipped;
    }
    const reasoning = input.reasoning?.trim() ?? "";
    if (this.limits.includeReasoning && reasoning) {
      // Digest of the raw text (so a reviewer holding it can match), text redacted and bounded.
      const bounded = boundedText(reasoning, this.limits.maxEventBytes);
      data.reasoningDigest = digestOf(reasoning);
      data.reasoningChars = reasoning.length;
      data.reasoning = bounded.text;
      data.reasoningClipped = bounded.clipped;
    }
    this.append("model.turn", data);
  }

  toolStart(input: { toolCallId: string; name: string; args: unknown; meta?: string }): void {
    this.toolStarts.set(input.toolCallId, Date.now());
    const bounded = boundedValue(input.args, this.limits.maxEventBytes);
    this.append("tool.call", {
      toolCallId: input.toolCallId,
      name: input.name,
      meta: input.meta ?? null,
      argsDigest: digestOf(input.args ?? null),
      args: bounded.value,
      argsClipped: bounded.clipped,
    });
  }

  toolEnd(input: {
    toolCallId: string;
    name: string;
    result: unknown;
    isError: boolean;
    error?: string;
  }): void {
    const startedAt = this.toolStarts.get(input.toolCallId);
    this.toolStarts.delete(input.toolCallId);
    const text = resultText(input.result);
    const bounded = boundedText(text, this.limits.maxEventBytes);
    this.append("tool.result", {
      toolCallId: input.toolCallId,
      name: input.name,
      isError: input.isError,
      error: input.error ? boundedText(input.error, 1024).text : null,
      durationMs: startedAt ? Math.max(0, Date.now() - startedAt) : null,
      resultDigest: digestOf(text),
      resultChars: text.length,
      result: bounded.text,
      resultClipped: bounded.clipped,
    });
  }

  /**
   * Declare a deliverable of this job (a file the job produced). Recorded in `job.end` with its
   * SHA-256 so an evaluator never has to guess which file is the result. Relative paths resolve
   * against `baseDir` (default: the process cwd). A missing file is recorded with sha256 null.
   */
  declareOutput(name: string, filePath: string, baseDir?: string): void {
    const abs = path.resolve(baseDir ?? process.cwd(), filePath);
    let sha256: string | null = null;
    let size: number | null = null;
    try {
      const entry = fileEntryOf(abs);
      sha256 = entry.sha256;
      size = entry.size;
    } catch {
      // recorded as missing
    }
    this.outputs.set(name, { path: filePath, sha256, size });
  }

  loopStop(
    verdict: Extract<LoopVerdict, { stop: true }>,
    extra: { steps: number; limits: LoopLimits },
  ): void {
    this.append("loop_guard", {
      reason: verdict.reason,
      summary: boundedText(verdict.summary, 1024).text,
      steps: extra.steps,
      limits: extra.limits,
    });
  }

  /** Link an audit entry written for this job (its seq and hash, never its detail). */
  audit(
    entry: Pick<AuditEntry, "seq" | "hash" | "action" | "outcome" | "ts"> | null | undefined,
  ): void {
    if (!entry) {
      return;
    }
    this.append("audit", {
      seq: entry.seq,
      hash: entry.hash,
      action: entry.action,
      outcome: entry.outcome,
      ts: entry.ts,
    });
  }

  private onSignal(signal: EvidenceSignal): void {
    if (signal.kind === "permission") {
      this.append("permission", {
        tool: signal.tool,
        decision: signal.decision,
        class: signal.toolClass ?? null,
        target: signal.target ? boundedText(signal.target, 1024).text : null,
        rule: signal.rule ?? null,
        reason: signal.reason ? boundedText(signal.reason, 1024).text : null,
        auditSeq: signal.auditSeq ?? null,
      });
      return;
    }
    if (signal.kind === "approval") {
      this.append("approval", {
        tool: signal.tool,
        decision: signal.decision,
        ruleId: signal.ruleId ?? null,
        approvalId: signal.approvalId ?? null,
        approver: signal.approver ?? null,
        argsDigest: signal.argsDigest ?? null,
      });
      return;
    }
    if (signal.kind === "redaction") {
      this.append("redaction", {
        tool: signal.tool,
        counts: signal.counts,
        restored: signal.restored,
      });
      return;
    }
    this.append("snapshot", {
      snapshotId: signal.snapshotId,
      tool: signal.tool,
      files: signal.files.map((f) => ({
        path: f.path,
        existed: f.existed,
        hash: f.hash ?? null,
        size: f.size,
        skipped: f.skipped ?? null,
      })),
    });
  }

  /**
   * Close the log with the job's outcome and sign the manifest. Idempotent; a second call is a
   * no-op. Returns the manifest, or null when the log could not be written or signed.
   */
  finish(
    job: Pick<JobRecord, "status" | "steps" | "toolCalls" | "endedAt" | "error" | "summary">,
  ): EvidenceManifest | null {
    if (this.finished) {
      return this.manifest;
    }
    this.unsubscribe();
    const endedAt = job.endedAt ?? this.now().toISOString();
    const durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(this.job.startedAt));
    this.append("job.end", {
      status: job.status,
      steps: job.steps,
      toolCalls: job.toolCalls,
      endedAt,
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      error: job.error ? boundedText(job.error, 1024).text : null,
      summary: job.summary ? boundedText(job.summary, 1024).text : null,
      outputs: Object.fromEntries(this.outputs),
      cost: costSnapshot([...this.usageByModel.values()]),
    });
    this.finished = true;
    if (this.failed) {
      return null;
    }
    try {
      const eventsPath = path.join(this.dir, EVENTS_FILE);
      const unsigned: Omit<EvidenceManifest, "signer" | "signature"> = {
        version: EVIDENCE_VERSION,
        jobId: this.jobId,
        agent: this.job.agent,
        sessionKey: this.job.sessionKey,
        kind: String(this.job.kind),
        status: job.status,
        startedAt: this.job.startedAt,
        endedAt,
        createdAt: this.now().toISOString(),
        gatewayVersion: this.gatewayVersion,
        events: { count: this.seq, root: this.prev, truncated: this.truncated },
        files: { [EVENTS_FILE]: fileEntryOf(eventsPath) },
      };
      const manifest = signEvidenceManifest(
        unsigned,
        this.key ?? resolveEvidenceSigningKey(this.env),
      );
      const target = path.join(this.dir, MANIFEST_FILE);
      const tmp = `${target}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, target);
      this.manifest = manifest;
      return manifest;
    } catch (err) {
      this.fail(`evidence: manifest failed for job ${this.jobId}: ${String(err)}`);
      return null;
    }
  }
}

// ── process-wide registry: the runner starts a recorder per job and finishes it ─────────────

const recorders = new Map<string, EvidenceRecorder>();
const digestCache = new WeakMap<object, { at: number; inventoryDigest: string | null }>();
const DIGEST_TTL_MS = 30_000;

/** Policy and inventory digests for `job.start`. Best effort: a failure records null. */
function startDigestsFor(
  config: KoLoConfig | undefined,
  env?: NodeJS.ProcessEnv,
): { policyDigest: string | null; inventoryDigest: string | null } {
  let policyDigest: string | null = null;
  try {
    policyDigest = getPolicyEngine().status().sha256 ?? null;
  } catch {
    policyDigest = null;
  }
  let inventoryDigest: string | null = null;
  if (config) {
    const cached = digestCache.get(config);
    if (cached && Date.now() - cached.at < DIGEST_TTL_MS) {
      inventoryDigest = cached.inventoryDigest;
    } else {
      try {
        inventoryDigest = inventoryConfigDigest(config, { env });
      } catch {
        inventoryDigest = null;
      }
      digestCache.set(config, { at: Date.now(), inventoryDigest });
    }
  }
  return { policyDigest, inventoryDigest };
}
let autoPruned = false;
/** When the last seal pass left a log it may close later (recent writes, owner alive, locked). */
let sealRetryAt: number | null = null;

/** Retry interval for logs a seal pass skipped; a retry is a directory listing, not a scan. */
export const SEAL_RETRY_MS = 60_000;

/** Seal interrupted logs on the first job, then again on later jobs while some were skipped. */
function sealInterruptedPass(env: NodeJS.ProcessEnv | undefined, first: boolean): void {
  const at = Date.now();
  if (!first && (sealRetryAt === null || at < sealRetryAt)) {
    return;
  }
  const { skipped } = sealInterruptedEvidence({ env, isLive: (id) => recorders.has(id) });
  sealRetryAt = skipped.some((s) => RETRYABLE_SEAL_SKIPS.has(s.reason)) ? at + SEAL_RETRY_MS : null;
}

/** Skips that can change while this process runs; broken or foreign logs never become sealable. */
const RETRYABLE_SEAL_SKIPS = new Set([
  "recent writes",
  "owner process alive",
  "seal in progress elsewhere",
  "changed while sealing",
]);

/** Start recording a job. Returns null when evidence is disabled. Never throws. */
export function startEvidence(
  job: Pick<JobRecord, "id" | "agent" | "sessionKey" | "kind" | "startedAt">,
  opts: { config?: KoLoConfig; gatewayVersion?: string; env?: NodeJS.ProcessEnv } = {},
): EvidenceRecorder | null {
  const limits = resolveEvidenceLimits(opts.config?.evidence);
  if (!limits.enabled) {
    return null;
  }
  try {
    const first = !autoPruned;
    if (first) {
      autoPruned = true;
      // Once per process, best effort: retention is enforced without an operator in the loop.
      pruneEvidence({ days: limits.retentionDays, env: opts.env });
    }
    // Logs left open by a previous process are closed as interrupted and signed; one skipped for
    // now (written to recently, owner still alive) is retried on a later job.
    sealInterruptedPass(opts.env, first);
    const recorder = new EvidenceRecorder(job, {
      limits,
      gatewayVersion: opts.gatewayVersion,
      env: opts.env,
      startDigests: startDigestsFor(opts.config, opts.env),
    });
    recorders.set(job.id, recorder);
    return recorder;
  } catch {
    return null;
  }
}

export function getEvidenceRecorder(jobId: string): EvidenceRecorder | undefined {
  return recorders.get(jobId);
}

/** Close and sign a job's evidence; the recorder is dropped from the registry either way. */
export function finishEvidence(
  jobId: string,
  job: Parameters<EvidenceRecorder["finish"]>[0],
): EvidenceManifest | null {
  const recorder = recorders.get(jobId);
  recorders.delete(jobId);
  if (!recorder) {
    return null;
  }
  try {
    return recorder.finish(job);
  } catch {
    return null;
  }
}

/** Test helper. */
export function __resetEvidenceForTest(): void {
  for (const recorder of recorders.values()) {
    try {
      recorder.finish({ status: "failed", steps: 0, toolCalls: 0, error: "test reset" });
    } catch {
      // ignore
    }
  }
  recorders.clear();
  autoPruned = false;
  sealRetryAt = null;
}
