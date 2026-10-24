// Signed evidence for work item transitions. Every transition writes one sealed evidence bundle
// in the standard evidence format (events.jsonl hash chain + Ed25519-signed manifest.json, see
// src/evidence/store.ts), so `kolo evidence verify <dir>` and verifyEvidenceBundle() check it
// like any job bundle. Bundles live with the item, not in the job evidence store, so job
// retention never removes them:
//
//   <KOLO_HOME>/projects/<projectId>/workitems/<itemId>/evidence/<0001-action>/
//
// Each bundle's job.start names the previous bundle and its root, chaining the item's bundles.

import fs from "node:fs";
import path from "node:path";
import type { EvidenceEvent, EvidenceEventType, EvidenceManifest } from "../evidence/types.js";
import type { Actor, WorkItem, WorkItemStatus } from "./types.js";
import { redactAuditValue } from "../audit/redact.js";
import {
  EVENTS_FILE,
  EVIDENCE_GENESIS,
  EVIDENCE_VERSION,
  eventHash,
  fileEntryOf,
  MANIFEST_FILE,
  readManifestFile,
  resolveEvidenceSigningKey,
  signEvidenceManifest,
} from "../evidence/store.js";
import { workItemDir } from "./store.js";

export type TransitionEvidence = { bundle: string; root: string };

function evidenceRoot(item: Pick<WorkItem, "projectId" | "id">, home?: string): string {
  return path.join(workItemDir(item.projectId, item.id, home), "evidence");
}

export function listEvidenceBundles(item: Pick<WorkItem, "projectId" | "id">, home?: string) {
  try {
    return fs
      .readdirSync(evidenceRoot(item, home))
      .filter((n) => /^\d{4}-[a-z_.]+$/.test(n))
      .toSorted();
  } catch {
    return [];
  }
}

export function evidenceBundleDir(
  item: Pick<WorkItem, "projectId" | "id">,
  bundle: string,
  home?: string,
): string {
  if (!/^\d{4}-[a-z_.]+$/.test(bundle)) {
    throw new Error("invalid evidence bundle id");
  }
  return path.join(evidenceRoot(item, home), bundle);
}

/**
 * Write and sign the bundle for one transition. Called under the item lock, after the new item
 * state is known and before it is written, so the history entry can name the bundle.
 */
export function writeTransitionEvidence(
  item: Pick<WorkItem, "projectId" | "id">,
  t: {
    action: string;
    actor: Actor;
    from: WorkItemStatus | null;
    to: WorkItemStatus;
    data: Record<string, unknown>;
    now: Date;
  },
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {},
): TransitionEvidence {
  const existing = listEvidenceBundles(item, opts.home);
  const prevBundle = existing.at(-1) ?? null;
  let prevRoot: string | null = null;
  if (prevBundle) {
    prevRoot =
      readManifestFile(path.join(evidenceBundleDir(item, prevBundle, opts.home), MANIFEST_FILE))
        ?.events.root ?? null;
  }
  const seq = existing.length + 1;
  const safeAction = t.action.replace(/[^a-z_.]/g, "_").slice(0, 40);
  const bundle = `${String(seq).padStart(4, "0")}-${safeAction}`;
  const dir = evidenceBundleDir(item, bundle, opts.home);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jobId = `wi-${item.id}-${String(seq).padStart(4, "0")}`;
  const ts = t.now.toISOString();
  const type: EvidenceEventType = t.action.startsWith("decide") ? "approval" : "audit";
  const bodies: Array<{ type: EvidenceEventType; data: Record<string, unknown> }> = [
    {
      type: "job.start",
      data: {
        kind: "workitem.transition",
        projectId: item.projectId,
        itemId: item.id,
        prevBundle,
        prevRoot,
      },
    },
    {
      type,
      data: redactAuditValue({
        action: t.action,
        actor: t.actor.id,
        actorKind: t.actor.kind,
        from: t.from,
        to: t.to,
        ...t.data,
      }) as Record<string, unknown>,
    },
    { type: "job.end", data: { status: t.to } },
  ];
  let prev = EVIDENCE_GENESIS;
  const lines: string[] = [];
  bodies.forEach((b, i) => {
    const base = { seq: i + 1, ts, type: b.type, jobId, data: b.data };
    const hash = eventHash(prev, base);
    const event: EvidenceEvent = { ...base, prev, hash };
    lines.push(JSON.stringify(event));
    prev = hash;
  });
  const eventsPath = path.join(dir, EVENTS_FILE);
  fs.writeFileSync(eventsPath, `${lines.join("\n")}\n`, { mode: 0o600 });
  const unsigned: Omit<EvidenceManifest, "signer" | "signature"> = {
    version: EVIDENCE_VERSION,
    jobId,
    agent: t.actor.id,
    sessionKey: `workitem:${item.projectId}:${item.id}`,
    kind: `workitem.${safeAction}`,
    status: t.to,
    startedAt: ts,
    endedAt: ts,
    createdAt: ts,
    events: { count: lines.length, root: prev, truncated: false },
    files: { [EVENTS_FILE]: fileEntryOf(eventsPath) },
  };
  const manifest = signEvidenceManifest(unsigned, resolveEvidenceSigningKey(opts.env));
  fs.writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return { bundle, root: prev };
}
