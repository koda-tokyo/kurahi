// Types for scripts/family-internal-check.mjs (imported by scripts/release-check.ts and
// src/packaging/family-internal-check.test.ts).
export const PATTERNS: Array<{ id: string; re: RegExp }>;
export function loadAllow(root: string): Array<{ path: string; match: string }>;
export function sourcePathOf(file: string): string;
export function scanSource(text: string): Array<{ line: number; id: string; text: string }>;
export function scanPath(file: string): string[];
export function collectTargets(root: string): {
  sources: string[];
  dist: string[];
  distBuilt: boolean;
};
export function runCheck(root: string): {
  findings: string[];
  scanned: number;
  distBuilt: boolean;
};
