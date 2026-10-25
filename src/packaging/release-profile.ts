/**
 * Release profiles (Kurahi 2.2): which bundled extensions an edition ships and may load.
 *
 * The classification lives in `profiles/enterprise.json` (one entry per directory in
 * `extensions/`, each with a tier and a reason). Packaging reads the same file from the scripts
 * (`scripts/bundle.mjs --profile enterprise`, `scripts/npm-pack.mjs --profile enterprise`,
 * `scripts/pack-plugin.mjs --tier optional`, `scripts/enterprise-check.mjs`); the runtime reads
 * it here for the plugin gate (`src/plugins/profile-gate.ts`). See
 * docs/security/enterprise-profile.md.
 *
 * The profile is "enterprise" when either `KURAHI_PROFILE=enterprise` is set or the config says
 * `profile: "enterprise"`. Neither source can switch the other off: an enterprise config stays
 * enterprise whatever the environment says, and the launcher of an enterprise bundle always sets
 * the variable.
 */
import type { KoLoConfig } from "../config/types.js";
import ENTERPRISE_PROFILE_JSON from "./profiles/enterprise.json" with { type: "json" };

export type ReleaseProfile = "standard" | "enterprise";
export type ExtensionTier = "enterprise" | "optional" | "excluded";

export type ProfileManifest = {
  schema: 1;
  profile: "enterprise";
  release: string;
  tiers: Record<ExtensionTier, string>;
  licensePolicy: { fail: string[]; warn: string[]; exceptions: Record<string, string> };
  extensions: Record<string, { tier: ExtensionTier; reason: string }>;
};

export const RELEASE_PROFILE_ENV = "KURAHI_PROFILE";

export const ENTERPRISE_PROFILE = ENTERPRISE_PROFILE_JSON as ProfileManifest;

/** The profile this process runs under (see the module comment for the precedence rule). */
export function resolveReleaseProfile(
  cfg?: Pick<KoLoConfig, "profile"> | null,
  env: Record<string, string | undefined> = process.env,
): ReleaseProfile {
  const fromEnv = env[RELEASE_PROFILE_ENV]?.trim().toLowerCase();
  if (fromEnv === "enterprise" || cfg?.profile === "enterprise") {
    return "enterprise";
  }
  return "standard";
}

export function isEnterpriseProfile(
  cfg?: Pick<KoLoConfig, "profile"> | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return resolveReleaseProfile(cfg, env) === "enterprise";
}

/** Tier of a bundled extension id, or null when the manifest does not know it. */
export function extensionTier(
  id: string,
  manifest: ProfileManifest = ENTERPRISE_PROFILE,
): { tier: ExtensionTier; reason: string } | null {
  return Object.hasOwn(manifest.extensions, id) ? manifest.extensions[id] : null;
}
