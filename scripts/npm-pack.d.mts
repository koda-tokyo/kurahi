export function rewriteWorkspaceSpecs<T extends Record<string, unknown>>(
  pkg: T,
  versions: Map<string, string>,
): T;
export function packAll(outDir: string): string[];
export function packEnterprise(outDir: string): string;
export function extensionsToDrop(
  present: string[],
  profile: { extensions: Record<string, { tier: string }> },
): string[];
