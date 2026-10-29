// Work item change journal: `<workitems>/.journal`, one line per change, so a list index can
// replay only what changed instead of re-reading every item (design:
// koda-autonomy/proposals/WORKITEMS_SCALE_INDEX_2026-10-26.md, v2).
//
// Line 1 is `epoch <128-bit hex>`; a reader that sees a different (dev, ino, epoch) rescans.
// Each record starts with a newline, so a fragment left by a failed short write is terminated
// and malformed instead of swallowing the next record.
// Each write appends `intent <id>` before item.json changes and `commit <id> <revision>` after,
// so a crash between the two leaves a pending id that readers keep re-reading, never a committed
// change that is invisible. Deletions append `intent <id>` then `delete <id>`.
// Compaction renames a fresh epoch over the file once it passes COMPACT_BYTES; an appender whose
// fd no longer names the live file appends again to the current path, so every line lands in the
// live epoch. The new epoch carries no history: every reader rescans the directory on an epoch
// change, and a writer still between its intent and its commit appends the commit to the new
// file. Carrying old intents forward could not be ordered against appends racing the rename.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const JOURNAL_FILE = ".journal";
const MAX_REAPPEND = 8;
/** About 20k records; each reader pays one rescan per compaction. */
export const COMPACT_BYTES = 1 << 20;

export type JournalLine =
  | { op: "intent"; id: string }
  | { op: "commit"; id: string; revision: number }
  | { op: "delete"; id: string };

export function journalPath(root: string): string {
  return path.join(root, JOURNAL_FILE);
}

function formatLine(line: JournalLine): string {
  if (line.op === "commit") {
    return `\ncommit ${line.id} ${line.revision}\n`;
  }
  return `\n${line.op} ${line.id}\n`;
}

/** A complete new-epoch file beside the journal, for link (create) or rename (compact). */
function writeEpochFile(file: string): string {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `epoch ${randomBytes(16).toString("hex")}\n`, { mode: 0o600 });
  return tmp;
}

/** Create the journal with its epoch line in one step (link of a complete file; never a bare file). */
function ensureJournal(file: string): void {
  if (fs.existsSync(file)) {
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = writeEpochFile(file);
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
      throw err;
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Replace the journal with an empty new epoch (readers rescan once). No-op without a journal. */
export function compactJournal(root: string): void {
  const file = journalPath(root);
  if (!fs.existsSync(file)) {
    return;
  }
  const tmp = writeEpochFile(file);
  try {
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Best effort after a completed record: the record already landed, so a failure here never throws. */
function maybeCompact(root: string, file: string, mine: fs.Stats): void {
  if (mine.size < COMPACT_BYTES) {
    return;
  }
  try {
    // Another appender may have compacted already; only the file we wrote to is rotated.
    const live = fs.statSync(file);
    if (live.ino === mine.ino && live.dev === mine.dev) {
      compactJournal(root);
    }
  } catch {
    // The next append past the threshold tries again.
  }
}

/**
 * Append one line to the live journal. Throws when it cannot; callers that append an `intent`
 * must not touch item.json after a throw.
 */
export function appendJournal(root: string, line: JournalLine): void {
  const file = journalPath(root);
  const data = Buffer.from(formatLine(line), "utf8");
  for (let attempt = 0; attempt < MAX_REAPPEND; attempt++) {
    ensureJournal(file);
    let fd: number;
    let landed: fs.Stats | null = null;
    try {
      // No O_CREAT: only ensureJournal creates the file, so an append never makes an epochless one.
      fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND);
    } catch (err) {
      // Removed between the check and the open: create it again.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }
    try {
      // A partial record is a failure, never a retry: another appender may already follow it.
      const written = fs.writeSync(fd, data);
      if (written !== data.length) {
        throw new Error(`work item journal short write (${written} of ${data.length} bytes)`);
      }
      const mine = fs.fstatSync(fd);
      let live: fs.Stats | null = null;
      try {
        live = fs.statSync(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
      if (live && live.ino === mine.ino && live.dev === mine.dev) {
        landed = mine;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (landed) {
      // Not after an intent: its writer is about to touch item.json and append again.
      if (line.op !== "intent") {
        maybeCompact(root, file, landed);
      }
      return;
    }
  }
  throw new Error("work item journal keeps rotating; try again");
}

/** Parse journal text: the epoch and the change lines (blank and malformed lines are skipped). */
export function parseJournal(text: string): { epoch: string | null; lines: JournalLine[] } {
  const rows = text.split("\n");
  const head = /^epoch ([0-9a-f]{32})$/.exec(rows[0] ?? "");
  const lines: JournalLine[] = [];
  for (const row of rows.slice(head ? 1 : 0)) {
    const [op, id, rev, extra] = row.split(" ");
    if (extra !== undefined || !id) {
      continue;
    }
    if (op === "commit" && rev !== undefined && /^\d+$/.test(rev)) {
      lines.push({ op, id, revision: Number(rev) });
    } else if ((op === "intent" || op === "delete") && rev === undefined) {
      lines.push({ op, id });
    }
  }
  return { epoch: head ? head[1] : null, lines };
}
