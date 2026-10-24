export function rewriteWorkspaceSpecs<T extends Record<string, unknown>>(
  pkg: T,
  versions: Map<string, string>,
): T;
export function packAll(outDir: string): string[];
