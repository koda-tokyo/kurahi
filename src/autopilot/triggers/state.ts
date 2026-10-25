// Trigger state on disk, per Project, under its autopilot data area:
//
//   <KOLO_HOME>/projects/<projectId>/autopilot/triggers/
//     m365-mail-<folder digest>.json   the mail watcher's Graph delta link for one folder (the
//                                      only thing stored for mail: no ids, no subjects, no bodies)
//     deadline.json                    per routine: the item windows already signalled
//
// Writes are atomic (tmp + rename), mode 0600.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { autopilotDir, writeAtomic } from "../store.js";

const DEADLINE_KEYS_MAX = 2000;

export function triggersDir(projectId: string, home?: string): string {
  return path.join(autopilotDir(projectId, home), "triggers");
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function mailFile(projectId: string, folder: string, home?: string): string {
  const digest = createHash("sha256").update(folder, "utf8").digest("hex").slice(0, 16);
  return path.join(triggersDir(projectId, home), `m365-mail-${digest}.json`);
}

/** Where a mail watcher keeps its delta link for one Project folder subscription. */
export type DeltaStore = {
  read(): string | null;
  /** null forgets the link (the next poll does a fresh initial sync). */
  write(deltaLink: string | null): void;
};

export function mailDeltaStore(projectId: string, folder: string, home?: string): DeltaStore {
  const file = mailFile(projectId, folder, home);
  return {
    read() {
      const doc = readJson<{ deltaLink?: unknown }>(file);
      return typeof doc?.deltaLink === "string" ? doc.deltaLink : null;
    },
    write(deltaLink) {
      if (deltaLink === null) {
        fs.rmSync(file, { force: true });
        return;
      }
      writeAtomic(
        file,
        `${JSON.stringify({ version: 1, deltaLink, updatedAt: new Date().toISOString() })}\n`,
      );
    },
  };
}

type DeadlineDoc = { version: 1; routines: Record<string, string[]> };

function deadlineFile(projectId: string, home?: string): string {
  return path.join(triggersDir(projectId, home), "deadline.json");
}

/** Windows (`<itemId>@<dueAt>`) already signalled to the routine. */
export function readDeadlineSignalled(
  projectId: string,
  routineId: string,
  home?: string,
): Set<string> {
  const doc = readJson<DeadlineDoc>(deadlineFile(projectId, home));
  const list = doc?.routines?.[routineId];
  return new Set(Array.isArray(list) ? list.filter((k) => typeof k === "string") : []);
}

export function addDeadlineSignalled(
  projectId: string,
  routineId: string,
  keys: string[],
  home?: string,
): void {
  if (keys.length === 0) {
    return;
  }
  const file = deadlineFile(projectId, home);
  const doc = readJson<DeadlineDoc>(file) ?? { version: 1, routines: {} };
  const routines = doc.routines && typeof doc.routines === "object" ? doc.routines : {};
  const cur = Array.isArray(routines[routineId]) ? routines[routineId] : [];
  routines[routineId] = [...cur, ...keys.filter((k) => !cur.includes(k))].slice(-DEADLINE_KEYS_MAX);
  writeAtomic(file, `${JSON.stringify({ version: 1, routines }, null, 2)}\n`);
}
