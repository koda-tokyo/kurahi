// Memory provenance (OWASP ASI06, memory and context poisoning).
//
// Every memory write an agent tool makes (write/edit/apply_patch/exec on MEMORY.md, memory/**
// or a configured memorySearch.extraPaths entry) is recorded in a sidecar index outside the
// workspace, so the memory files themselves keep their exact format:
//
//   <KOLO_HOME>/memory-provenance/<agentId>/index.jsonl     one record per write (append-only)
//   <KOLO_HOME>/memory-provenance/<agentId>/quarantine/     held writes (src/memory/quarantine.ts)
//
// The sidecar lives in the state dir, not the workspace: a sandboxed agent with a writable
// workspace cannot forge its own provenance, and agent tools are refused writes to it
// (src/memory/provenance-guard.ts). Provenance is per file: retrieval reports the least trusted
// origin among the recorded writes still in the file, and "unverified" when the file has no
// record (legacy) or changed outside the recorded writes.

import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { KoLoConfig } from "../config/config.js";
import type { MemoryTrustLevel } from "../config/types.memory.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import { isExternalHookSession } from "../security/external-content.js";

export type { MemoryTrustLevel };
export type MemoryProvenanceMode = "off" | "warn" | "enforce";
/** What retrieval reports: a recorded trust level, or no usable record. */
export type MemoryEntryTrust = MemoryTrustLevel | "unverified";

/** Fallback when `memory.provenance.mode` is unset (existing installs). */
export const LEGACY_PROVENANCE_MODE: MemoryProvenanceMode = "warn";
export const SECURE_PROVENANCE_MODE: MemoryProvenanceMode = "enforce";
export const DEFAULT_QUARANTINE_TRUST: MemoryTrustLevel[] = ["external"];

const TRUST_RANK: Record<MemoryTrustLevel, number> = {
  operator: 0,
  cron: 1,
  channel: 2,
  external: 3,
};

export type MemoryWriteOp = "write" | "edit" | "patch" | "exec";

export type MemoryProvenanceRecord = {
  v: 1;
  id: string;
  ts: string;
  agentId: string;
  sessionKey: string | null;
  /** Cron job id when the turn ran from a cron job. */
  jobId: string | null;
  trust: MemoryTrustLevel;
  /** Why the turn got that trust level (session kind, tainting tool, prompt marker, …). */
  trustReasons: string[];
  tool: string;
  op: MemoryWriteOp;
  /** Absolute path of the memory file. */
  path: string;
  /** SHA-256 of the text the call wrote (content, newText, patch or command). */
  contentSha256: string;
  /** SHA-256 of the whole file after the write; null when the file is gone or unknown. */
  fileSha256After: string | null;
  /** active: landed; approved: landed after operator review; quarantined/refused: not written. */
  status: "active" | "approved" | "quarantined" | "refused";
  suspicious?: string[];
  quarantineId?: string;
  approvedBy?: string;
};

export function resolveMemoryProvenanceMode(
  cfg: KoLoConfig | undefined,
  agentId?: string,
): MemoryProvenanceMode {
  const perAgent = agentId
    ? resolveAgentConfig(cfg ?? {}, agentId)?.memory?.provenance?.mode
    : undefined;
  return perAgent ?? cfg?.memory?.provenance?.mode ?? LEGACY_PROVENANCE_MODE;
}

export function resolveQuarantineTrust(
  cfg: KoLoConfig | undefined,
  agentId?: string,
): MemoryTrustLevel[] {
  const perAgent = agentId
    ? resolveAgentConfig(cfg ?? {}, agentId)?.memory?.provenance?.quarantineTrust
    : undefined;
  return perAgent ?? cfg?.memory?.provenance?.quarantineTrust ?? DEFAULT_QUARANTINE_TRUST;
}

export function resolveProvenanceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "memory-provenance");
}

function safeAgentDir(agentId: string): string {
  return agentId.replace(/[^A-Za-z0-9_.-]/g, "_") || "main";
}

export function resolveProvenanceDir(agentId: string, env: NodeJS.ProcessEnv = process.env) {
  return path.join(resolveProvenanceRoot(env), safeAgentDir(agentId));
}

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function sha256File(absPath: string): string | null {
  try {
    return createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
  } catch {
    return null;
  }
}

/** Canonical key for a memory file path (resolved, symlinks of the parent folded). */
/**
 * Canonical key for a path: symlinks are resolved through the nearest EXISTING ancestor and the
 * rest is appended. Resolving only the direct parent left paths under a not-yet-created folder
 * unresolved while the existing store root was resolved, so on macOS (/var -> /private/var) a
 * write into the provenance store did not match the store and was not refused.
 */
export function memoryPathKey(absPath: string): string {
  const resolved = path.resolve(absPath);
  const rest: string[] = [];
  let cur = resolved;
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.toReversed());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) {
        return resolved;
      }
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

export function worstTrust(levels: MemoryTrustLevel[]): MemoryTrustLevel | null {
  let worst: MemoryTrustLevel | null = null;
  for (const level of levels) {
    if (worst === null || TRUST_RANK[level] > TRUST_RANK[worst]) {
      worst = level;
    }
  }
  return worst;
}

export type SessionTrust = {
  trust: MemoryTrustLevel;
  reasons: string[];
  jobId: string | null;
};

/** Operator surfaces: a message from one of these with no channel sender is the operator. */
const OPERATOR_PROVIDERS = new Set(["", "cli", "tui", "webchat", "desktop", "gateway"]);

/**
 * Trust level of the input that started a turn, from what the run knows about it. Conservative:
 * anything that is not provably the operator or a cron job is a channel user.
 */
export function classifySessionTrust(params: {
  sessionKey?: string | null;
  senderId?: string | null;
  messageProvider?: string | null;
  prompt?: string | null;
}): SessionTrust {
  const raw = (params.sessionKey ?? "").trim();
  // Store keys are `agent:<id>:<rest>`; request keys are `<rest>`.
  const rest = raw.startsWith("agent:") ? raw.split(":").slice(2).join(":") : raw;
  const reasons: string[] = [];
  let trust: MemoryTrustLevel;
  let jobId: string | null = null;
  const cron = /^cron:([^:]+)/.exec(rest);
  if (cron) {
    trust = "cron";
    jobId = cron[1] ?? null;
    reasons.push(`cron job ${jobId}`);
  } else if (rest && isExternalHookSession(rest)) {
    trust = "external";
    reasons.push("hook session (email/webhook input)");
  } else if (/(^|:)subagent:/.test(rest)) {
    // A sub-agent's input is its parent's task text, which may carry anything the parent read.
    trust = "channel";
    reasons.push("sub-agent run");
  } else {
    const provider = (params.messageProvider ?? "").trim().toLowerCase();
    const sender = (params.senderId ?? "").trim();
    if (!sender && OPERATOR_PROVIDERS.has(provider)) {
      trust = "operator";
      reasons.push(provider ? `operator via ${provider}` : "operator session");
    } else {
      trust = "channel";
      reasons.push(`channel user${provider ? ` via ${provider}` : ""}`);
    }
  }
  if (params.prompt && /<<<EXTERNAL_UNTRUSTED_CONTENT>>>/.test(params.prompt)) {
    trust = "external";
    reasons.push("prompt carries external untrusted content");
  }
  return { trust, reasons, jobId };
}

export function newProvenanceId(): string {
  return randomUUID();
}

export function appendProvenanceRecord(dir: string, record: MemoryProvenanceRecord): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.appendFileSync(path.join(dir, "index.jsonl"), `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

type IndexCache = { key: string; byPath: Map<string, MemoryProvenanceRecord[]> };
const indexCache = new Map<string, IndexCache>();

/** Records for one agent, grouped by memory file key, oldest first. Cached on size + mtime. */
export function readProvenanceIndex(dir: string): Map<string, MemoryProvenanceRecord[]> {
  const file = path.join(dir, "index.jsonl");
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return new Map();
  }
  const key = `${stat.size}:${stat.mtimeMs}`;
  const cached = indexCache.get(file);
  if (cached?.key === key) {
    return cached.byPath;
  }
  const byPath = new Map<string, MemoryProvenanceRecord[]>();
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const rec = JSON.parse(line) as MemoryProvenanceRecord;
      if (rec?.v !== 1 || typeof rec.path !== "string") {
        continue;
      }
      const list = byPath.get(rec.path) ?? [];
      list.push(rec);
      byPath.set(rec.path, list);
    } catch {
      // A torn line is skipped; the rest of the index still counts.
    }
  }
  indexCache.set(file, { key, byPath });
  return byPath;
}

export type EntryTrust = {
  trust: MemoryEntryTrust;
  /** Least trusted recorded origin, even when the file is unverified now. */
  origin: MemoryTrustLevel | null;
  detail: string;
};

/** Trust of a memory file as it is on disk now. */
export function resolveEntryTrust(params: {
  agentId: string;
  absPath: string;
  env?: NodeJS.ProcessEnv;
}): EntryTrust {
  const key = memoryPathKey(params.absPath);
  const records = (
    readProvenanceIndex(resolveProvenanceDir(params.agentId, params.env)).get(key) ?? []
  ).filter((r) => r.status === "active" || r.status === "approved");
  if (records.length === 0) {
    return {
      trust: "unverified",
      origin: null,
      detail: "no provenance record (written before provenance was on, or outside agent tools)",
    };
  }
  const origin = worstTrust(records.map((r) => r.trust));
  const last = records[records.length - 1];
  const current = sha256File(params.absPath);
  if (origin === "external") {
    // External origin wins over every other state: never downgrade it to "unverified".
    return { trust: "external", origin, detail: "contains a write that followed external input" };
  }
  if (!current || current !== last.fileSha256After) {
    return {
      trust: "unverified",
      origin,
      detail: "file changed since the last recorded write",
    };
  }
  return { trust: origin ?? "unverified", origin, detail: `${records.length} recorded write(s)` };
}

export const __testing = {
  resetCache() {
    indexCache.clear();
  },
};
