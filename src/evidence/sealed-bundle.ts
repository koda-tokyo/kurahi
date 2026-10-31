// Write a small, complete evidence bundle in one go: a hash-chained events.jsonl and an
// Ed25519-signed manifest.json in the standard format (store.ts), so `kolo evidence verify`
// and verifyEvidenceBundle() check it like any job bundle. Used by records that are written
// once (autopilot runs, security refusals, modernisation verification runs) rather than streamed
// by the recorder. Extra files (reports, captured outputs) are listed in the signed manifest with
// their SHA-256, so altering any of them fails verification.

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

const EXTRA_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;

/** Write `bodies` as a sealed bundle in `dir`; returns the chain root (last event hash). */
export function writeSealedBundle(
  dir: string,
  meta: SealedBundleMeta,
  bodies: SealedEventBody[],
  opts: { env?: NodeJS.ProcessEnv; files?: Record<string, Buffer> } = {},
): { root: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const extra: Record<string, ReturnType<typeof fileEntryOf>> = {};
  for (const [name, data] of Object.entries(opts.files ?? {})) {
    if (
      !EXTRA_NAME_RE.test(name) ||
      name.includes("..") ||
      name === EVENTS_FILE ||
      name === MANIFEST_FILE
    ) {
      throw new Error(`invalid bundle file name: ${name}`);
    }
    const target = path.join(dir, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.writeFileSync(target, data, { mode: 0o600 });
    extra[name] = fileEntryOf(target);
  }
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
    files: { ...extra, [EVENTS_FILE]: fileEntryOf(eventsPath) },
  };
  const manifest = signEvidenceManifest(unsigned, resolveEvidenceSigningKey(opts.env));
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { root: prev };
}
