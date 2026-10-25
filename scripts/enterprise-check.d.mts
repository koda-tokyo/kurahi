// Types for scripts/enterprise-check.mjs (imported by src/packaging/enterprise-check.test.ts).
export type Tier = "enterprise" | "optional" | "excluded";
export type Profile = {
  schema: number;
  profile: string;
  release: string;
  tiers: Record<Tier, string>;
  licensePolicy: { fail: string[]; warn: string[]; exceptions: Record<string, string> };
  extensions: Record<string, { tier: Tier; reason: string }>;
};
export type PackageResult = {
  kind: "bundle" | "npm" | "dir";
  extensions: string[];
  scannedFiles: number;
  packages: number;
  licences: Record<"ok" | "weak-copyleft" | "copyleft" | "unknown", number>;
  findings: string[];
  warnings: string[];
};
export const PROFILE_FILE: string;
export function loadProfile(root?: string): Profile;
export function extensionsForTier(profile: Profile, tier: Tier): string[];
export function checkClassification(root?: string, profile?: Profile): string[];
export function locatePackage(dir: string): {
  kind: "bundle" | "npm" | "dir";
  root: string;
  lib: string;
  bundleManifest: Record<string, unknown> | null;
};
export function collectInstalledPackages(
  nodeModules: string,
  out?: Array<{ name: string; version: string; licence: string; dir: string }>,
): Array<{ name: string; version: string; licence: string; dir: string }>;
export function checkPackageDir(
  dir: string,
  opts?: { repoRoot?: string; profile?: Profile; strict?: boolean },
): PackageResult;
export function unpackArchive(file: string): Promise<string>;
export function checkPackage(
  target: string,
  opts?: { repoRoot?: string; profile?: Profile; strict?: boolean },
): Promise<PackageResult>;
export function isTestOnlySource(name: string): boolean;
export function relativeImports(
  text: string,
): Array<{ spec: string; typeOnly: boolean; dynamic: boolean }>;
export function resolveRelative(fromFile: string, spec: string): string | null;
export function unresolvedImports(
  lib: string,
  extensionIds: string[],
): Array<{ file: string; spec: string; dynamic: boolean; target: string }>;
