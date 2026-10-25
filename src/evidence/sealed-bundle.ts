// Write a small, complete evidence bundle in one go: a hash-chained events.jsonl and an
// Ed25519-signed manifest.json in the standard format (store.ts), so `kolo evidence verify`
// and verifyEvidenceBundle() check it like any job bundle. Used by records that are written
// once (autopilot runs, security refusals) rather than streamed by the recorder.

import fs from "node:fs";
import path from "node:path";
import type { EvidenceEvent, EvidenceEventType, EvidenceManifest } from "./types.js";
import { redactAuditValue } from "../audit/redact.js";
import {
  EVENTS_FILE,
  EVIDENCE_GENESIS,
  EVIDENCE_VERSION,
  eventHash,
  fileEntryOf,
  MANIFEST_FILE,
  resolveEvidenceSigningKey,
  signEvidenceManifest,
} from "./store.js";

export type SealedEventBody = {
  type: EvidenceEventType;
  ts: string;
  data: Record<string, unknown>;
};

export type SealedBundleMeta = {
  jobId: string;
  agent: string;
  sessionKey: string;
  kind: string;
  status: string;
  startedAt: string;
  endedAt: string;
};

/** Write `bodies` as a sealed bundle in `dir`; returns the chain root (last event hash). */
export function writeSealedBundle(
  dir: string,
  meta: SealedBundleMeta,
  bodies: SealedEventBody[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): { root: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let prev = EVIDENCE_GENESIS;
  const lines: string[] = [];
  bodies.forEach((b, i) => {
    const base = {
      seq: i + 1,
      ts: b.ts,
      type: b.type,
      jobId: meta.jobId,
      data: redactAuditValue(b.data) as Record<string, unknown>,
    };
    const hash = eventHash(prev, base);
    const event: EvidenceEvent = { ...base, prev, hash };
    lines.push(JSON.stringify(event));
    prev = hash;
  });
  const eventsPath = path.join(dir, EVENTS_FILE);
  fs.writeFileSync(eventsPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  const unsigned: Omit<EvidenceManifest, "signer" | "signature"> = {
    version: EVIDENCE_VERSION,
    jobId: meta.jobId,
    agent: meta.agent,
    sessionKey: meta.sessionKey,
    kind: meta.kind,
    status: meta.status,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    createdAt: meta.endedAt,
    events: { count: lines.length, root: prev, truncated: false },
    files: { [EVENTS_FILE]: fileEntryOf(eventsPath) },
  };
  const manifest = signEvidenceManifest(unsigned, resolveEvidenceSigningKey(opts.env));
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { root: prev };
}
