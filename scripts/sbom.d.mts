// Types for scripts/sbom.mjs (imported by src/packaging/sbom.test.ts).
export function normaliseNpmLicence(pkg: { license?: unknown; licenses?: unknown }): string;
export function sniffLicenceFile(dir: string): string;
export function classifyLicence(expr: string): "ok" | "weak-copyleft" | "copyleft" | "unknown";
export function parseCargoLock(text: string): Array<{
  name: string;
  version: string;
  source?: string;
  checksum?: string;
  dependencies: string[];
}>;
