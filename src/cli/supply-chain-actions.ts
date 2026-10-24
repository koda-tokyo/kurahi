// `kurahi skills pin|verify` and `kurahi plugins pin|verify` (OWASP ASI04): the operator path
// into the supply-chain lock (src/integrity/supply-chain-lock.ts). Pinning scans first and
// refuses flagged content without `--force`; verifying reports every artifact's status.

import type { KoLoConfig } from "../config/types.js";
import { loadWorkspaceSkillEntries } from "../agents/skills/workspace.js";
import {
  checkArtifact,
  isBundledArtifactPath,
  type ArtifactCheck,
} from "../integrity/supply-chain-gate.js";
import { digestArtifact } from "../integrity/supply-chain-hash.js";
import {
  emptyLock,
  lockKey,
  readLockState,
  resolveSupplyChainLocations,
  writeLock,
  type LockTrust,
  type SupplyChainKind,
  type SupplyChainLocations,
  type WriteLockResult,
} from "../integrity/supply-chain-lock.js";
import { scanArtifact, type ScanFinding } from "../integrity/supply-chain-scan.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { discoverKoLoPlugins } from "../plugins/discovery.js";
import { pluginArtifactTarget } from "../plugins/integrity.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";

export type SupplyChainArtifact = {
  kind: SupplyChainKind;
  name: string;
  target: string;
  bundled: boolean;
};

/** Every skill the loader would see for this workspace, before the gate filters it. */
export function collectSkillArtifacts(
  cfg: KoLoConfig,
  workspaceDir: string,
  opts: { managedSkillsDir?: string; bundledSkillsDir?: string } = {},
): SupplyChainArtifact[] {
  return loadWorkspaceSkillEntries(workspaceDir, {
    config: cfg,
    ...opts,
    verifyIntegrity: false,
  }).map((entry) => ({
    kind: "skill",
    name: entry.skill.name,
    target: entry.skill.baseDir,
    bundled: entry.skill.source === "kolo-bundled" || isBundledArtifactPath(entry.skill.baseDir),
  }));
}

/** Every discovered plugin package (first candidate per id, as the loader picks it). */
export function collectPluginArtifacts(
  cfg: KoLoConfig,
  workspaceDir?: string,
): SupplyChainArtifact[] {
  const discovery = discoverKoLoPlugins({
    workspaceDir,
    extraPaths: normalizePluginsConfig(cfg.plugins).loadPaths,
  });
  const manifests = loadPluginManifestRegistry({
    config: cfg,
    workspaceDir,
    cache: false,
    candidates: discovery.candidates,
    diagnostics: discovery.diagnostics,
  });
  const idByRoot = new Map(manifests.plugins.map((m) => [m.rootDir, m.id]));
  const out = new Map<string, SupplyChainArtifact>();
  for (const candidate of discovery.candidates) {
    const id = idByRoot.get(candidate.rootDir);
    if (!id || out.has(id)) {
      continue;
    }
    out.set(id, {
      kind: "plugin",
      name: id,
      target: pluginArtifactTarget(candidate),
      bundled: candidate.origin === "bundled",
    });
  }
  return [...out.values()];
}

export type PinOutcome = {
  name: string;
  status: "pinned" | "unchanged" | "flagged" | "exempt" | "error";
  sha256?: string;
  findings?: ScanFinding[];
  error?: string;
};

export type PinResult = {
  kind: SupplyChainKind;
  outcomes: PinOutcome[];
  /** Null when nothing was written (no change, refused, or everything flagged). */
  written: WriteLockResult | null;
  /** True when an untrusted lock was discarded and rebuilt (`--all`). */
  rebuilt: boolean;
  /** Set when the whole call was refused. */
  refused?: string;
  lockPath: string;
};

/**
 * Pin `names` (or every non-bundled artifact with `all`). Content the scan flags is left
 * unchanged unless `force`. With `all`, lock entries of this kind that no longer exist are
 * dropped. An untrusted lock (bad or missing signature while owners are pinned) is only
 * replaced by a full re-pin (`all`), never patched entry by entry.
 */
export function pinArtifacts(params: {
  kind: SupplyChainKind;
  artifacts: SupplyChainArtifact[];
  names: string[];
  all: boolean;
  force: boolean;
  loc?: SupplyChainLocations;
  now?: Date;
}): PinResult {
  const loc = params.loc ?? resolveSupplyChainLocations();
  const now = params.now ?? new Date();
  const base = { kind: params.kind, lockPath: loc.lockPath, rebuilt: false, written: null };
  const state = readLockState(loc);
  if (state.trust === "untrusted" && !params.all) {
    return {
      ...base,
      outcomes: [],
      refused: `the lock is not trusted (${state.reason ?? "bad signature"}); review every artifact and re-pin with --all`,
    };
  }
  const rebuilt = state.trust === "untrusted";
  const lock = rebuilt || !state.lock ? emptyLock(now) : structuredClone(state.lock);
  const byName = new Map(params.artifacts.map((a) => [a.name, a]));
  const targets = params.all
    ? params.artifacts.filter((a) => !a.bundled)
    : params.names.map(
        (name) => byName.get(name) ?? { kind: params.kind, name, target: "", bundled: false },
      );

  const outcomes: PinOutcome[] = [];
  let changed = rebuilt;
  for (const artifact of targets) {
    if (!artifact.target) {
      outcomes.push({
        name: artifact.name,
        status: "error",
        error: `no ${params.kind} named ${artifact.name}`,
      });
      continue;
    }
    if (artifact.bundled) {
      outcomes.push({ name: artifact.name, status: "exempt" });
      continue;
    }
    try {
      const scan = scanArtifact(artifact.target);
      if (scan.findings.length > 0 && !params.force) {
        outcomes.push({ name: artifact.name, status: "flagged", findings: scan.findings });
        continue;
      }
      const digest = digestArtifact(artifact.target, { cache: false });
      const key = lockKey(params.kind, artifact.name);
      if (lock.entries[key]?.sha256 === digest.sha256) {
        outcomes.push({ name: artifact.name, status: "unchanged", sha256: digest.sha256 });
        continue;
      }
      lock.entries[key] = {
        kind: params.kind,
        name: artifact.name,
        path: artifact.target,
        sha256: digest.sha256,
        files: digest.files,
        bytes: digest.bytes,
        pinnedAt: now.toISOString(),
        ...(scan.findings.length > 0
          ? { scan: { findings: [...new Set(scan.findings.map((f) => f.rule))], forced: true } }
          : {}),
      };
      changed = true;
      outcomes.push({
        name: artifact.name,
        status: "pinned",
        sha256: digest.sha256,
        ...(scan.findings.length > 0 ? { findings: scan.findings } : {}),
      });
    } catch (err) {
      outcomes.push({ name: artifact.name, status: "error", error: String(err) });
    }
  }
  if (params.all) {
    const present = new Set(params.artifacts.map((a) => lockKey(params.kind, a.name)));
    for (const [key, entry] of Object.entries(lock.entries)) {
      if (entry.kind === params.kind && !present.has(key)) {
        delete lock.entries[key];
        changed = true;
      }
    }
  }
  const written = changed ? writeLock(lock, loc, now) : null;
  return { ...base, outcomes, written, rebuilt };
}

export type VerifyResult = {
  trust: LockTrust;
  trustReason?: string;
  checks: ArtifactCheck[];
  /** True when every artifact is pinned or exempt and the lock is trusted (or absent+empty). */
  ok: boolean;
  lockPath: string;
};

export function verifyArtifacts(params: {
  artifacts: SupplyChainArtifact[];
  loc?: SupplyChainLocations;
}): VerifyResult {
  const loc = params.loc ?? resolveSupplyChainLocations();
  const state = readLockState(loc);
  const checks = params.artifacts.map((a) =>
    checkArtifact({ kind: a.kind, name: a.name, target: a.target, bundled: a.bundled, loc }),
  );
  const ok =
    state.trust !== "untrusted" &&
    checks.every((c) => c.status === "pinned" || c.status === "exempt");
  return { trust: state.trust, trustReason: state.reason, checks, ok, lockPath: loc.lockPath };
}
