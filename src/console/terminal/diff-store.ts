// File diffs produced by console terminal commands. The `file.diff` event carries a summary and
// the gateway-owned `diffId`; `terminal.diff` pages through the full diff (200 files per page).
// Diffs live in gateway memory, bounded by count and bytes (oldest dropped first); the audit log
// keeps each diff's summary with the command's runId for as long as the audit log is retained.

import { randomUUID } from "node:crypto";
import type { TerminalDiffFile, TerminalDiffFileSummary } from "../../gateway/protocol/index.js";
import type { TextRedactor } from "./redact.js";
import { buildUnifiedDiff } from "../../tui/diff.js";
import { SECRET_FILE_RE, sameContent, type FileState, type TreeSnapshot } from "./tree-snapshot.js";

export const DIFF_PAGE = 200;
const MAX_DIFFS = 200;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;

export type DiffRecord = {
  diffId: string;
  sessionId: string;
  runId: string;
  projectId: string;
  owner: string;
  files: TerminalDiffFile[];
  totals: { files: number; added: number; removed: number };
  truncated: boolean;
  bytes: number;
};

function lineCount(text: string | null): number {
  if (!text) {
    return 0;
  }
  const n = text.split("\n").length;
  return text.endsWith("\n") ? n - 1 : n;
}

function fileDiff(
  rel: string,
  before: FileState | undefined,
  after: FileState | undefined,
  redactor: TextRedactor,
): TerminalDiffFile {
  const status = !before ? "added" : !after ? "deleted" : "modified";
  const skipped = SECRET_FILE_RE.test(rel)
    ? "secret"
    : before?.binary || after?.binary
      ? "binary"
      : (before && before.text === null) || (after && after.text === null)
        ? "too-large"
        : undefined;
  if (skipped) {
    return { path: rel, status, added: 0, removed: 0, skipped, lines: null, linesTruncated: false };
  }
  const diff = buildUnifiedDiff(before?.text ?? "", after?.text ?? "", rel);
  return {
    path: rel,
    status,
    added: status === "added" ? lineCount(after?.text ?? null) : diff.stats.added,
    removed: status === "deleted" ? lineCount(before?.text ?? null) : diff.stats.removed,
    lines: diff.lines.map((line) => redactor.redact(line)),
    linesTruncated: diff.stats.truncated,
  };
}

/** Changed files between two snapshots, sorted by path. */
export function diffSnapshots(
  before: TreeSnapshot,
  after: TreeSnapshot,
  redactor: TextRedactor,
): TerminalDiffFile[] {
  const out: TerminalDiffFile[] = [];
  const paths = new Set([...before.files.keys(), ...after.files.keys()]);
  for (const rel of [...paths].toSorted()) {
    const a = before.files.get(rel);
    const b = after.files.get(rel);
    if (a && b && sameContent(a, b)) {
      continue;
    }
    out.push(fileDiff(rel, a, b, redactor));
  }
  return out;
}

export function summarize(files: TerminalDiffFile[]): TerminalDiffFileSummary[] {
  return files.slice(0, DIFF_PAGE).map(({ path, status, added, removed, skipped, violation }) => ({
    path,
    status,
    added,
    removed,
    ...(skipped ? { skipped } : {}),
    ...(violation ? { violation } : {}),
  }));
}

export class DiffStore {
  private records = new Map<string, DiffRecord>();
  private bytes = 0;

  add(input: Omit<DiffRecord, "diffId" | "totals" | "bytes">): DiffRecord {
    const totals = {
      files: input.files.length,
      added: input.files.reduce((n, f) => n + f.added, 0),
      removed: input.files.reduce((n, f) => n + f.removed, 0),
    };
    const bytes = Buffer.byteLength(JSON.stringify(input.files), "utf8");
    const record: DiffRecord = { ...input, diffId: randomUUID(), totals, bytes };
    this.records.set(record.diffId, record);
    this.bytes += bytes;
    for (const [id, old] of this.records) {
      if (this.records.size <= MAX_DIFFS && this.bytes <= MAX_TOTAL_BYTES) {
        break;
      }
      if (id === record.diffId) {
        break;
      }
      this.records.delete(id);
      this.bytes -= old.bytes;
    }
    return record;
  }

  get(diffId: string): DiffRecord | null {
    return this.records.get(diffId) ?? null;
  }

  page(
    record: DiffRecord,
    cursor?: string,
  ): { files: TerminalDiffFile[]; nextCursor: string | null } {
    const start = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    const files = record.files.slice(start, start + DIFF_PAGE);
    const next = start + DIFF_PAGE;
    return { files, nextCursor: next < record.files.length ? String(next) : null };
  }
}
