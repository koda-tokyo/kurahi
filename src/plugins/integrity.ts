// Supply-chain gate for plugin packages (OWASP ASI04, docs/security/skill-integrity.md). The
// loader asks before it imports a plugin module; bundled plugins are exempt.
import type { KoLoConfig } from "../config/types.js";
import type { PluginCandidate } from "./discovery.js";
import {
  gateArtifact,
  resolveSupplyChainMode,
  type GateDecision,
} from "../integrity/supply-chain-gate.js";

/** What a plugin's digest covers: its package directory, or the single file it is. */
export function pluginArtifactTarget(candidate: PluginCandidate): string {
  return candidate.packageDir ?? candidate.source;
}

export function gatePluginCandidate(params: {
  cfg: KoLoConfig;
  pluginId: string;
  candidate: PluginCandidate;
  audit: boolean;
}): GateDecision {
  return gateArtifact({
    kind: "plugin",
    name: params.pluginId,
    target: pluginArtifactTarget(params.candidate),
    mode: resolveSupplyChainMode(params.cfg),
    source: "plugins",
    bundled: params.candidate.origin === "bundled",
    audit: params.audit,
  });
}
