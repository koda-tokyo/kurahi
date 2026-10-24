// Evidence bundles (KoLo 2.0, M12): shared types. Nothing here runs at import time.
import type { ManifestSigner } from "../continuity-suite/types.js";

export const EVIDENCE_VERSION = 1 as const;

export const EVIDENCE_EVENT_TYPES = [
  "job.start",
  "model.turn",
  "tool.call",
  "tool.result",
  "snapshot",
  "permission",
  "approval",
  "redaction",
  "loop_guard",
  "audit",
  "truncated",
  "job.end",
] as const;
export type EvidenceEventType = (typeof EVIDENCE_EVENT_TYPES)[number];

/**
 * One line of `events.jsonl`. `hash` chains the event to the previous one:
 * `sha256(prev + "\n" + canonicalJson(event without prev and hash))`; genesis 64 zeros.
 */
export type EvidenceEvent = {
  seq: number;
  ts: string;
  type: EvidenceEventType;
  jobId: string;
  data: Record<string, unknown>;
  prev: string;
  hash: string;
};

export type EvidenceUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

export type EvidenceFileEntry = { sha256: string; size: number };

/** What the recorder signs at job end, and what an export re-signs with the bundle files. */
export type EvidenceManifest = {
  version: typeof EVIDENCE_VERSION;
  jobId: string;
  agent: string;
  sessionKey: string;
  kind: string;
  status: string;
  startedAt: string;
  endedAt: string;
  createdAt: string;
  gatewayVersion?: string;
  events: { count: number; root: string; truncated: boolean };
  /** Bundle files by relative path (always includes events.jsonl). */
  files: Record<string, EvidenceFileEntry>;
  /** Present on an exported bundle: the signature the recorder produced at job end. */
  recorded?: {
    createdAt: string;
    root: string;
    count: number;
    signer: ManifestSigner;
    signature: string;
  };
  signer: ManifestSigner;
  /** Ed25519 signature over `evidenceSigningInput(manifest)`, base64url. */
  signature: string;
};

export type EvidenceSummary = {
  jobId: string;
  agent: string;
  sessionKey: string;
  kind: string;
  status: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  events: number;
  modelTurns: number;
  toolCalls: number;
  toolErrors: number;
  filesChanged: string[];
  tools: Record<string, number>;
  usage: EvidenceUsage;
  permissions: { allowed: number; denied: number };
  loopStops: number;
  auditSeqs: number[];
  promptDigest: string | null;
  promptChars: number | null;
  finalTextDigest: string | null;
  finalTextExcerpt: string | null;
  error: string | null;
  truncated: boolean;
  signed: boolean;
};

export type EvidenceVerification = {
  ok: boolean;
  chainOk: boolean;
  rootOk: boolean;
  filesOk: boolean;
  signatureOk: boolean;
  keyIdOk: boolean;
  recordedOk: boolean | null;
  events: number;
  firstBreak?: number;
  problems: string[];
};
