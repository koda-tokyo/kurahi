// Types for scripts/src-shims.mjs (imported by src/packaging/src-shims.test.ts).
export type MissingImport = { file: string; spec: string; dynamic: boolean; target: string };
export function writeSrcShims(
  lib: string,
  extensions: string[],
): { written: number; missing: MissingImport[] };
export function hasDefaultExport(code: string): boolean;
