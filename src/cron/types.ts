import type { ChannelId } from "../channels/plugins/types.js";

export type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

export type CronSessionTarget = "main" | "isolated";
export type CronWakeMode = "next-heartbeat" | "now";

export type CronMessageChannel = ChannelId | "last";

/**
 * A deterministic pre-step for an isolated agentTurn: the runtime runs `command` through the
 * agent's own exec tool (same policy, host, allowlist and approvals) before the model turn and
 * hands the output to the model. The model turn has no tools unless `keepTools` is true.
 * With `pinHead`, the command's first output line (its verdict) is the only text the job delivers,
 * posts and logs; the model's reply is kept solely as a non-authoritative diagnostic
 * (`CronPreExecOutcome.modelSummary`), so it cannot replace or contradict the verdict.
 */
export type CronPreExec = {
  command: string;
  keepTools?: boolean;
  pinHead?: boolean;
};

/** What a pre-step did, as the run log keeps it (the full output goes only to the model turn). */
export type CronPreExecOutcome = {
  /** ok: exit 0. failed: the command ran and exited non-zero (or timed out). error: did not run. */
  status: "ok" | "failed" | "error";
  exitCode?: number | null;
  /** First non-empty output line (at most 300 chars). */
  head?: string;
  error?: string;
  durationMs: number;
  /** pinHead: the head was the job's whole output; the model's reply is kept only for measurement. */
  pinned?: boolean;
  /** pinHead: the model's own summary, never delivered — diagnostic, not authoritative (≤300 chars). */
  modelSummary?: string;
};

/**
 * System prompt for an isolated agentTurn. full (default): the whole agent prompt. minimal: the
 * subagent prompt (tools, safety, workspace, runtime; no skills list, memory, messaging, voice or
 * docs sections), which keeps a single-tool ops job small enough for a small local model.
 */
export type CronPromptMode = "full" | "minimal";

export type CronPayload =
  | { kind: "systemEvent"; text: string }
  | {
      kind: "agentTurn";
      message: string;
      /** Optional model override (provider/model or alias). */
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      deliver?: boolean;
      channel?: CronMessageChannel;
      to?: string;
      bestEffortDeliver?: boolean;
      preExec?: CronPreExec;
      promptMode?: CronPromptMode;
    };

export type CronPayloadPatch =
  | { kind: "systemEvent"; text?: string }
  | {
      kind: "agentTurn";
      message?: string;
      model?: string;
      thinking?: string;
      timeoutSeconds?: number;
      allowUnsafeExternalContent?: boolean;
      deliver?: boolean;
      channel?: CronMessageChannel;
      to?: string;
      bestEffortDeliver?: boolean;
      /** null removes the pre-step. */
      preExec?: CronPreExec | null;
      /** null restores the default (full). */
      promptMode?: CronPromptMode | null;
    };

export type CronIsolation = {
  postToMainPrefix?: string;
  /**
   * What to post back into the main session after an isolated run.
   * - none: keep the isolated run fully out of the main session
   * - summary: small status/summary line (default)
   * - full: the agent's final text output (optionally truncated)
   */
  postToMainMode?: "none" | "summary" | "full";
  /** Max chars when postToMainMode="full". Default: 8000. */
  postToMainMaxChars?: number;
};

export type CronJobState = {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: "ok" | "error" | "skipped";
  lastError?: string;
  lastDurationMs?: number;
};

export type CronJob = {
  id: string;
  agentId?: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  payload: CronPayload;
  isolation?: CronIsolation;
  state: CronJobState;
};

export type CronStoreFile = {
  version: 1;
  jobs: CronJob[];
};

export type CronJobCreate = Omit<CronJob, "id" | "createdAtMs" | "updatedAtMs" | "state"> & {
  state?: Partial<CronJobState>;
};

export type CronJobPatch = Partial<Omit<CronJob, "id" | "createdAtMs" | "state" | "payload">> & {
  payload?: CronPayloadPatch;
  state?: Partial<CronJobState>;
};
