// Ransomware shield wiring (Kurahi 2.0, M17a): which folders to watch and what a detection does.
// Mode comes from KOLO_SHIELD (emergency override), then `shield.mode` in the policy, then "stop".
import os from "node:os";
import path from "node:path";
import type { KoLoConfig } from "../config/config.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { ShieldTrigger } from "./detect.js";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { auditSafe } from "../audit/audit-log.js";
import { resolveStateDir } from "../config/paths.js";
import { startShieldWatcher, type ShieldWatcher } from "./watch.js";

export type ShieldMode = "stop" | "alert" | "off";

export function resolveShieldMode(
  env: NodeJS.ProcessEnv,
  configured: string | undefined,
): ShieldMode {
  const raw = (env.KOLO_SHIELD?.trim() || configured || "stop").toLowerCase();
  return raw === "alert" || raw === "off" ? raw : "stop";
}

function expandHome(p: string): string {
  return p === "~" ? os.homedir() : p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

export function resolveShieldRoots(
  cfg: KoLoConfig,
  extra: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots = [resolveStateDir(env)];
  for (const id of listAgentIds(cfg)) {
    try {
      roots.push(resolveAgentWorkspaceDir(cfg, id));
    } catch {
      // agent without a resolvable workspace: skip
    }
  }
  roots.push(...extra.map(expandHome));
  // Kurahi Guardian: company file shares the operator listed (docs/security/guardian.md). The
  // shield plants its decoy file in each, so only explicitly listed shares are watched.
  if (cfg.guardian?.enabled !== false) {
    roots.push(...(cfg.guardian?.shares ?? []).map(expandHome));
  }
  return roots;
}

export function describeTrigger(t: ShieldTrigger): string {
  const where = t.paths.slice(0, 3).join(", ");
  return `shield: ${t.reason} (${t.detail})${where ? `: ${where}` : ""}`;
}

export function startShield(params: {
  cfg: KoLoConfig;
  engine: PolicyEngine;
  env?: NodeJS.ProcessEnv;
  log: { info: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}): ShieldWatcher | null {
  const env = params.env ?? process.env;
  const shield = params.engine.document?.shield;
  const mode = resolveShieldMode(env, shield?.mode);
  if (mode === "off") {
    params.log.info("shield: off");
    return null;
  }
  return startShieldWatcher({
    roots: resolveShieldRoots(params.cfg, shield?.paths ?? [], env),
    canaries: shield?.canaries !== false,
    thresholds: {
      ...(shield?.rewrites ? { rewrites: shield.rewrites } : {}),
      ...(shield?.windowSeconds ? { windowMs: shield.windowSeconds * 1000 } : {}),
    },
    log: params.log,
    onTrigger: (trigger) => {
      const reason = describeTrigger(trigger);
      params.log.error(`${reason}${mode === "stop" ? " — stopping every agent" : ""}`);
      void auditSafe({
        identity: "shield",
        scope: null,
        action: "shield.trigger",
        outcome: mode === "stop" ? "denied" : "ok",
        source: "shield",
        detail: { reason: trigger.reason, detail: trigger.detail, paths: trigger.paths, mode },
      });
      if (mode === "stop") {
        params.engine.kill({ agent: null, by: "shield", reason });
      }
    },
  });
}
