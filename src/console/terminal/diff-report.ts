// After a console terminal command: store its file diff, send the `file.diff` event, and report
// changes inside the project's read-only folders as policy violations. The line gate refuses
// every write to those folders it can see (./readonly-guard.ts); a write it cannot see (a
// script, a build tool, an interpreter) shows up here instead, marked `violation:
// "read-only-path"` on the file, counted in the event's `violations`, announced with a
// `read-only-violation` notice and written to the audit log as `terminal.violation`.

import type { TerminalDiffFile } from "../../gateway/protocol/index.js";
import type { TerminalSafeParams } from "./codes.js";
import type { DiffStore } from "./diff-store.js";
import type { TerminalEventInput } from "./event-log.js";
import { summarize } from "./diff-store.js";
import { readOnlyFolderOf } from "./readonly-guard.js";

/** Paths listed in the audit entry of a violation (the diff keeps the rest). */
const AUDIT_PATHS = 50;

export type DiffReportInput = {
  files: TerminalDiffFile[];
  truncated: boolean;
  runId: string;
  sessionId: string;
  projectId: string;
  owner: string;
  readOnlyFolders: readonly string[];
  diffs: DiffStore;
  emit: (event: TerminalEventInput) => void;
  notice: (code: "read-only-violation" | "snapshot-truncated", params?: TerminalSafeParams) => void;
  audit: (action: string, outcome: string, detail: Record<string, unknown>) => void;
};

/** Returns the diff summary for the command's exit audit entry, if anything changed. */
export function reportRunDiff(input: DiffReportInput): Record<string, unknown> | undefined {
  const { files, truncated, runId } = input;
  if (files.length === 0) {
    if (truncated) {
      input.notice("snapshot-truncated");
    }
    return undefined;
  }
  const violating: Array<{ path: string; folder: string; status: string }> = [];
  for (const f of files) {
    const folder = readOnlyFolderOf(f.path, input.readOnlyFolders);
    if (folder) {
      f.violation = "read-only-path";
      violating.push({ path: f.path, folder, status: f.status });
    }
  }
  // Violations first, so the event's 200-entry summary always shows them.
  const ordered = violating.length > 0 ? [...files].toSorted((a, b) => rank(a) - rank(b)) : files;
  const record = input.diffs.add({
    sessionId: input.sessionId,
    runId,
    projectId: input.projectId,
    owner: input.owner,
    files: ordered,
    truncated,
  });
  input.emit({
    type: "file.diff",
    runId,
    diffId: record.diffId,
    files: summarize(ordered),
    totals: record.totals,
    truncated,
    ...(violating.length > 0 ? { violations: violating.length } : {}),
  });
  if (violating.length > 0) {
    const folders = [...new Set(violating.map((v) => v.folder))];
    input.notice("read-only-violation", { files: violating.length, folder: folders[0] });
    input.audit("terminal.violation", "denied", {
      runId,
      code: "read-only-path",
      diffId: record.diffId,
      folders,
      files: violating.length,
      paths: violating.slice(0, AUDIT_PATHS).map((v) => `${v.status}:${v.path}`),
    });
  }
  return {
    diffId: record.diffId,
    ...record.totals,
    ...(violating.length > 0 ? { violations: violating.length } : {}),
  };
}

function rank(f: TerminalDiffFile): number {
  return f.violation ? 0 : 1;
}
