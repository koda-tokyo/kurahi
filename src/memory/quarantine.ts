// Memory quarantine (OWASP ASI06). With `memory.provenance.mode: enforce`, a memory write whose
// turn followed untrusted input, or whose text matches the prompt-injection patterns, is held
// here instead of landing in MEMORY.md / memory/**. The operator reviews it with
// `kurahi memory quarantine list|approve|reject`; approve performs the held write and records
// it as `approved`, reject keeps the entry for the audit trail and never writes it.
//
//   <KOLO_HOME>/memory-provenance/<agentId>/quarantine/<id>.json

import fs from "node:fs";
import path from "node:path";
import { applyPatch } from "../agents/apply-patch.js";
import { appendAudit } from "../audit/audit-log.js";
import {
  appendProvenanceRecord,
  memoryPathKey,
  newProvenanceId,
  resolveProvenanceDir,
  resolveProvenanceRoot,
  sha256File,
  sha256Text,
  type MemoryProvenanceRecord,
} from "./provenance.js";

export type QuarantinedOp =
  | { kind: "write"; path: string; content: string }
  | { kind: "edit"; path: string; oldText: string; newText: string }
  | { kind: "patch"; cwd: string; input: string; paths: string[] };

export type QuarantineEntry = {
  v: 1;
  id: string;
  createdAt: string;
  status: "pending" | "approved" | "rejected";
  /** Why it was held: trust level, tainting tool, suspicious patterns. */
  reasons: string[];
  provenance: Omit<MemoryProvenanceRecord, "status" | "fileSha256After">;
  op: QuarantinedOp;
  decidedAt?: string;
  decidedBy?: string;
  note?: string;
};

const ID_RE = /^[0-9a-f-]{8,64}$/i;

export function resolveQuarantineDir(agentId: string, env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveProvenanceDir(agentId, env), "quarantine");
}

function entryFile(dir: string, id: string): string {
  if (!ID_RE.test(id)) {
    throw new Error(`invalid quarantine id: ${id}`);
  }
  return path.join(dir, `${id}.json`);
}

function writeEntry(dir: string, entry: QuarantineEntry): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = entryFile(dir, entry.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function holdInQuarantine(params: {
  agentId: string;
  reasons: string[];
  provenance: QuarantineEntry["provenance"];
  op: QuarantinedOp;
  env?: NodeJS.ProcessEnv;
}): QuarantineEntry {
  const entry: QuarantineEntry = {
    v: 1,
    id: params.provenance.quarantineId ?? newProvenanceId(),
    createdAt: new Date().toISOString(),
    status: "pending",
    reasons: params.reasons,
    provenance: params.provenance,
    op: params.op,
  };
  entry.provenance = { ...entry.provenance, quarantineId: entry.id };
  writeEntry(resolveQuarantineDir(params.agentId, params.env), entry);
  appendProvenanceRecord(resolveProvenanceDir(params.agentId, params.env), {
    ...entry.provenance,
    status: "quarantined",
    fileSha256After: null,
  });
  return entry;
}

export function readQuarantineEntry(
  agentId: string,
  id: string,
  env?: NodeJS.ProcessEnv,
): QuarantineEntry | null {
  try {
    return JSON.parse(
      fs.readFileSync(entryFile(resolveQuarantineDir(agentId, env), id), "utf8"),
    ) as QuarantineEntry;
  } catch {
    return null;
  }
}

/** Agents that have a quarantine folder (for `list` without `--agent`). */
export function listQuarantineAgents(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return fs
      .readdirSync(resolveProvenanceRoot(env), { withFileTypes: true })
      .filter(
        (d) =>
          d.isDirectory() &&
          fs.existsSync(path.join(resolveProvenanceRoot(env), d.name, "quarantine")),
      )
      .map((d) => d.name)
      .toSorted();
  } catch {
    return [];
  }
}

export function listQuarantine(
  agentId: string,
  opts: { status?: QuarantineEntry["status"] | "all"; env?: NodeJS.ProcessEnv } = {},
): QuarantineEntry[] {
  const dir = resolveQuarantineDir(agentId, opts.env);
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const want = opts.status ?? "pending";
  const out: QuarantineEntry[] = [];
  for (const name of names) {
    try {
      const entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")) as QuarantineEntry;
      if (want === "all" || entry.status === want) {
        out.push(entry);
      }
    } catch {
      // Unreadable entry: skipped here, still on disk for inspection.
    }
  }
  return out.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt));
}

function applyEdit(file: string, oldText: string, newText: string): void {
  const current = fs.readFileSync(file, "utf8");
  const first = current.indexOf(oldText);
  if (!oldText || first < 0) {
    throw new Error(`the text to replace is no longer in ${file}`);
  }
  if (current.indexOf(oldText, first + oldText.length) >= 0) {
    throw new Error(`the text to replace occurs more than once in ${file}`);
  }
  fs.writeFileSync(
    file,
    current.slice(0, first) + newText + current.slice(first + oldText.length),
    "utf8",
  );
}

async function performOp(op: QuarantinedOp): Promise<string[]> {
  if (op.kind === "write") {
    fs.mkdirSync(path.dirname(op.path), { recursive: true });
    fs.writeFileSync(op.path, op.content, "utf8");
    return [op.path];
  }
  if (op.kind === "edit") {
    applyEdit(op.path, op.oldText, op.newText);
    return [op.path];
  }
  await applyPatch(op.input, { cwd: op.cwd });
  return op.paths;
}

export type QuarantineDecision = { entry: QuarantineEntry; written: string[] };

function pendingOrThrow(agentId: string, id: string, env?: NodeJS.ProcessEnv): QuarantineEntry {
  const entry = readQuarantineEntry(agentId, id, env);
  if (!entry) {
    throw new Error(`no quarantined memory write ${id} for agent ${agentId}`);
  }
  if (entry.status !== "pending") {
    throw new Error(`quarantined memory write ${id} is already ${entry.status}`);
  }
  return entry;
}

/** Operator approval: perform the held write, tag it `approved`, audit the decision. */
export async function approveQuarantined(params: {
  agentId: string;
  id: string;
  approver: string;
  note?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<QuarantineDecision> {
  const entry = pendingOrThrow(params.agentId, params.id, params.env);
  let written: string[];
  try {
    written = await performOp(entry.op);
  } catch (err) {
    await appendAudit({
      identity: params.approver,
      scope: entry.provenance.sessionKey,
      action: "memory.quarantine.approve",
      outcome: "failed",
      source: "cli",
      detail: { agentId: params.agentId, id: entry.id, error: String(err) },
    }).catch(() => null);
    throw err;
  }
  const decided: QuarantineEntry = {
    ...entry,
    status: "approved",
    decidedAt: new Date().toISOString(),
    decidedBy: params.approver,
    ...(params.note ? { note: params.note } : {}),
  };
  writeEntry(resolveQuarantineDir(params.agentId, params.env), decided);
  const provDir = resolveProvenanceDir(params.agentId, params.env);
  for (const file of written) {
    appendProvenanceRecord(provDir, {
      ...entry.provenance,
      id: newProvenanceId(),
      ts: decided.decidedAt!,
      path: memoryPathKey(file),
      contentSha256: entry.provenance.contentSha256 || sha256Text(""),
      fileSha256After: sha256File(file),
      status: "approved",
      approvedBy: params.approver,
    });
  }
  await appendAudit({
    identity: params.approver,
    scope: entry.provenance.sessionKey,
    action: "memory.quarantine.approve",
    outcome: "ok",
    source: "cli",
    detail: {
      agentId: params.agentId,
      id: entry.id,
      trust: entry.provenance.trust,
      paths: written,
      contentSha256: entry.provenance.contentSha256,
    },
  });
  return { entry: decided, written };
}

/** Operator rejection: the write never lands; the entry stays as the record of the decision. */
export async function rejectQuarantined(params: {
  agentId: string;
  id: string;
  approver: string;
  note?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<QuarantineDecision> {
  const entry = pendingOrThrow(params.agentId, params.id, params.env);
  const decided: QuarantineEntry = {
    ...entry,
    status: "rejected",
    decidedAt: new Date().toISOString(),
    decidedBy: params.approver,
    ...(params.note ? { note: params.note } : {}),
  };
  writeEntry(resolveQuarantineDir(params.agentId, params.env), decided);
  await appendAudit({
    identity: params.approver,
    scope: entry.provenance.sessionKey,
    action: "memory.quarantine.reject",
    outcome: "ok",
    source: "cli",
    detail: {
      agentId: params.agentId,
      id: entry.id,
      trust: entry.provenance.trust,
      contentSha256: entry.provenance.contentSha256,
    },
  });
  return { entry: decided, written: [] };
}
