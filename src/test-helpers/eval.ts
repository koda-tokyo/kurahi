// Test helpers for the Workflow Evaluator: copy the bundled example into a temp home and build
// synthetic evidence events.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EvidenceEvent, EvidenceEventType } from "../evidence/types.js";

export const EXAMPLE_DIR = fileURLToPath(
  new URL("../../eval/workflows/csv-inspection.exceptions/", import.meta.url),
);

export function tempHome(prefix = "kolo-eval-") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = { ...process.env, KOLO_HOME: home, KOLO_STATE_DIR: home };
  return { home, env, cleanup: () => fs.rmSync(home, { recursive: true, force: true }) };
}

/** A writable copy of the example workflow inside `home`. */
export function copyExample(home: string): string {
  const dir = path.join(home, "eval", "specs", "csv-inspection.exceptions");
  fs.cpSync(EXAMPLE_DIR, dir, { recursive: true });
  return dir;
}

/** Synthetic events (not hash-chained; checks do not depend on the chain). */
export function events(
  list: Array<{ type: EvidenceEventType; data?: Record<string, unknown>; ts?: string }>,
): EvidenceEvent[] {
  return list.map((e, i) => ({
    seq: i + 1,
    ts: e.ts ?? `2026-10-14T20:30:${String(i).padStart(2, "0")}.000Z`,
    type: e.type,
    jobId: "job-t",
    data: e.data ?? {},
    prev: "0".repeat(64),
    hash: "0".repeat(64),
  }));
}
