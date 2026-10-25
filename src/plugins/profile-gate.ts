// Release-profile gate for plugins (Kurahi 2.2, docs/security/enterprise-profile.md). The loader
// asks before it imports a plugin module that would otherwise load. Under the standard profile
// everything passes. Under the enterprise profile:
//   - enterprise tier: allowed;
//   - excluded tier: refused, whatever the config says and wherever the plugin was found (a
//     consumer channel copied into <KOLO_HOME>/extensions is refused like the bundled one);
//   - optional tier and plugins the manifest does not know (a customer's own plugin): allowed only
//     when the administrator opted in explicitly (plugins.entries.<id>.enabled: true,
//     plugins.allow, or the memory slot). Implicit enablement of a non-bundled plugin is not
//     enough under this profile.
// The loader records a refusal as an audited `plugin.refused` row (outcome "denied").
import type { NormalizedPluginsConfig } from "./config-state.js";
import {
  ENTERPRISE_PROFILE,
  extensionTier,
  type ExtensionTier,
  type ProfileManifest,
  type ReleaseProfile,
} from "../packaging/release-profile.js";

export type ProfileGateDecision =
  | { allowed: true; tier: ExtensionTier | "unclassified" }
  | { allowed: false; tier: ExtensionTier | "unclassified"; reason: string };

function explicitlyOptedIn(pluginId: string, normalized: NormalizedPluginsConfig): boolean {
  return (
    normalized.entries[pluginId]?.enabled === true ||
    normalized.allow.includes(pluginId) ||
    normalized.slots.memory === pluginId
  );
}

/**
 * The memory slot defaults to memory-core, which is enterprise tier anyway, so the slot can only
 * opt an optional plugin in (memory-lancedb) when the administrator set it.
 */
export function decidePluginForProfile(params: {
  profile: ReleaseProfile;
  pluginId: string;
  normalized: NormalizedPluginsConfig;
  manifest?: ProfileManifest;
}): ProfileGateDecision {
  const entry = extensionTier(params.pluginId, params.manifest ?? ENTERPRISE_PROFILE);
  const tier = entry?.tier ?? "unclassified";
  if (params.profile !== "enterprise" || tier === "enterprise") {
    return { allowed: true, tier };
  }
  if (tier === "excluded") {
    return {
      allowed: false,
      tier,
      reason: `excluded from the enterprise profile: ${entry?.reason ?? ""}`.trim(),
    };
  }
  if (explicitlyOptedIn(params.pluginId, params.normalized)) {
    return { allowed: true, tier };
  }
  return {
    allowed: false,
    tier,
    reason:
      tier === "optional"
        ? "optional under the enterprise profile: enable it explicitly with plugins.entries.<id>.enabled: true"
        : "not classified for the enterprise profile: enable it explicitly with plugins.entries.<id>.enabled: true",
  };
}
