// Supply-chain gate (OWASP ASI04): verify a skill or plugin package against the signed lock
// (supply-chain-lock.ts) right before the loader reads it.
//
//   integrity.supplyChain.mode   unpinned / modified / untrusted lock
//   enforce (new installs)       refused (not loaded) + audit `supply-chain.refused`
//   warn (unset: legacy)         loaded + warning; tamper also audited `supply-chain.unverified`
//   off                          no check
//
// Bundled skills and plugins (shipped inside the runtime package, same trust as its code) are
// exempt. Warnings and audit rows are emitted once per process per artifact and digest.

import fs from "node:fs";
import path from "node:path";
import type { KoLoConfig } from "../config/types.js";
import { resolveBundledSkillsDir } from "../agents/skills/bundled-dir.js";
import { auditSafe } from "../audit/audit-log.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { digestArtifact } from "./supply-chain-hash.js";
import {
  lockKey,
  readLockState,
  resolveSupplyChainLocations,
  type SupplyChainKind,
  type SupplyChainLocations,
} from "./supply-chain-lock.js";

export type SupplyChainMode = "off" | "warn" | "enforce";

export type ArtifactStatus =
  | "pinned"
  | "unpinned"
  | "modified"
  | "unreadable"
  | "lock-untrusted"
  | "exempt";

export type ArtifactCheck = {
  kind: SupplyChainKind;
  name: string;
  path: string;
  status: ArtifactStatus;
  expected?: string;
  actual?: string;
  reason?: string;
};

export type GateDecision = { allowed: boolean; check: ArtifactCheck; message?: string };

const logger = createSubsystemLogger("supply-chain");
const reported = new Set<string>();

/** Effective mode: the configured value, else `warn` (the legacy fallback; see secure-defaults). */
export function resolveSupplyChainMode(cfg?: KoLoConfig | null): SupplyChainMode {
  const raw = cfg?.integrity?.supplyChain?.mode;
  return raw === "off" || raw === "enforce" ? raw : "warn";
}

function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** True for paths inside the runtime package's bundled skills or extensions directory. */
export function isBundledArtifactPath(target: string): boolean {
  const real = realOrSelf(target);
  for (const dir of [resolveBundledSkillsDir(), resolveBundledPluginsDir()]) {
    if (!dir) {
      continue;
    }
    const base = realOrSelf(dir);
    if (real === base || real.startsWith(`${base}${path.sep}`)) {
      return true;
    }
  }
  return false;
}

/** Compare one artifact with the lock. No logging, no audit. */
export function checkArtifact(params: {
  kind: SupplyChainKind;
  name: string;
  target: string;
  bundled?: boolean;
  loc?: SupplyChainLocations;
}): ArtifactCheck {
  const base = { kind: params.kind, name: params.name, path: params.target };
  if (params.bundled || isBundledArtifactPath(params.target)) {
    return { ...base, status: "exempt" };
  }
  const state = readLockState(params.loc ?? resolveSupplyChainLocations());
  let actual: string;
  try {
    actual = digestArtifact(params.target).sha256;
  } catch (err) {
    return { ...base, status: "unreadable", reason: String(err) };
  }
  if (state.trust === "untrusted") {
    return { ...base, status: "lock-untrusted", actual, reason: state.reason };
  }
  const entry = state.lock?.entries[lockKey(params.kind, params.name)];
  if (!entry) {
    return { ...base, status: "unpinned", actual };
  }
  if (entry.sha256 !== actual) {
    return { ...base, status: "modified", expected: entry.sha256, actual };
  }
  return { ...base, status: "pinned", expected: entry.sha256, actual };
}

export function describeCheck(check: ArtifactCheck): string {
  const what = `${check.kind} "${check.name}" (${check.path})`;
  const pin = `kurahi ${check.kind === "skill" ? "skills" : "plugins"} pin ${check.name}`;
  switch (check.status) {
    case "unpinned":
      return `${what} is not pinned in the supply-chain lock. Review it, then run \`${pin}\`.`;
    case "modified":
      return `${what} changed since it was pinned (pinned ${check.expected?.slice(0, 12)}, now ${check.actual?.slice(0, 12)}). Review the change, then run \`${pin}\`.`;
    case "unreadable":
      return `${what} could not be hashed: ${check.reason ?? "unknown error"}.`;
    case "lock-untrusted":
      return `${what} cannot be verified: the supply-chain lock is not trusted (${check.reason ?? "bad signature"}). Re-pin with \`kurahi skills pin --all\`.`;
    default:
      return `${what} is ${check.status}.`;
  }
}

/**
 * Decide whether the loader may read an artifact, logging and auditing the outcome once. In
 * `enforce` anything but pinned/exempt is refused; in `warn` it loads with a warning.
 */
export function gateArtifact(params: {
  kind: SupplyChainKind;
  name: string;
  target: string;
  mode: SupplyChainMode;
  /** Subsystem for the audit row (`skills`, `plugins`). */
  source: string;
  bundled?: boolean;
  /** Write audit rows (default true). */
  audit?: boolean;
  loc?: SupplyChainLocations;
}): GateDecision {
  const base = { kind: params.kind, name: params.name, path: params.target };
  if (params.mode === "off") {
    return { allowed: true, check: { ...base, status: "exempt", reason: "mode off" } };
  }
  const check = checkArtifact(params);
  if (check.status === "pinned" || check.status === "exempt") {
    return { allowed: true, check };
  }
  const enforce = params.mode === "enforce";
  const message = `${enforce ? "refused" : "warning"}: ${describeCheck(check)}`;
  const onceKey = `${params.mode}|${lockKey(check.kind, check.name)}|${check.status}|${check.actual ?? ""}`;
  if (!reported.has(onceKey)) {
    reported.add(onceKey);
    logger.warn(message, { kind: check.kind, name: check.name, status: check.status });
    const tamper = check.status !== "unpinned";
    if (params.audit !== false && (enforce || tamper)) {
      void auditSafe({
        action: enforce ? "supply-chain.refused" : "supply-chain.unverified",
        outcome: enforce ? "denied" : "warned",
        source: params.source,
        detail: {
          kind: check.kind,
          name: check.name,
          path: check.path,
          status: check.status,
          expected: check.expected ?? null,
          actual: check.actual ?? null,
          reason: check.reason ?? null,
          mode: params.mode,
        },
      });
    }
  }
  return { allowed: !enforce, check, message };
}

/** Test hook: forget which artifacts were already reported. */
export function resetSupplyChainReports(): void {
  reported.clear();
}
