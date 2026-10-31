// Where vendor imports live: the Project's state directory (never the client folder agents can
// write), one folder per import, written atomically:
//
//   <projectDataDir>/industrial-imports/<importId>/
//     record.json       manifest, origin, hashes, fingerprint, verification, counts
//     artefacts.json    the normalised items, edges, rules and findings
//     objects/<sha256>  the bundle files, content-addressed, as received
//     evidence/         signed evidence bundle (events.jsonl + manifest.json)
//   <projectDataDir>/industrial-imports/refused/<refusalId>/evidence/
//
// The import id is derived from the idempotency key (provider, format, the file hashes), and the
// folder appears by one rename: importing the same bundle again, or two imports racing, can
// never produce two records (AC-032).

import fs from "node:fs";
import path from "node:path";
import type { FormatVerification } from "../providers.js";
import type { ImportManifest } from "./manifest.js";
import type { NormalisedArtefacts } from "./model.js";
import { projectDataDir } from "../../projects/store.js";
import { sha256Hex } from "./manifest.js";

export const IMPORTS_DIR = "industrial-imports";

export type ImportRecord = {
  schema: "kurahi.vendor-import-record/1";
  importId: string;
  idempotencyKey: string;
  projectId: string;
  provider: string;
  format: string;
  verification: FormatVerification;
  docs: string[];
  provenance: "IMPORTED_VENDOR_ARTEFACT";
  confidence: "UNVERIFIED";
  importedAt: string;
  importedBy: string;
  bundle: { kind: "zip" | "folder"; sha256: string | null };
  manifest: ImportManifest;
  scan: { scanner: string; verdict: string };
  fingerprint: string;
  fingerprintDetail: string[];
  counts: { items: number; edges: number; rules: number; findings: number; notes: number };
  evidence: { bundle: string; root: string } | null;
};

export function importsRoot(projectId: string, home?: string): string {
  return path.join(projectDataDir(projectId, home), IMPORTS_DIR);
}

export function idempotencyKeyOf(manifest: ImportManifest, files: Map<string, Buffer>): string {
  const parts = [...files.keys()]
    .toSorted()
    .map((p) => `${p}\0${sha256Hex(files.get(p) ?? Buffer.alloc(0))}`);
  return sha256Hex([manifest.provider, manifest.format, ...parts].join("\n"));
}

export const importIdOf = (key: string) => `imp-${key.slice(0, 20)}`;

export function readImportRecord(
  projectId: string,
  importId: string,
  home?: string,
): ImportRecord | null {
  if (!/^imp-[a-f0-9]{20}$/.test(importId)) {
    return null;
  }
  try {
    return JSON.parse(
      fs.readFileSync(path.join(importsRoot(projectId, home), importId, "record.json"), "utf8"),
    ) as ImportRecord;
  } catch {
    return null;
  }
}

export function readImportArtefacts(
  projectId: string,
  importId: string,
  home?: string,
): NormalisedArtefacts | null {
  if (!/^imp-[a-f0-9]{20}$/.test(importId)) {
    return null;
  }
  try {
    return JSON.parse(
      fs.readFileSync(path.join(importsRoot(projectId, home), importId, "artefacts.json"), "utf8"),
    ) as NormalisedArtefacts;
  } catch {
    return null;
  }
}

export function listImports(projectId: string, home?: string): ImportRecord[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(importsRoot(projectId, home));
  } catch {
    return [];
  }
  return names
    .map((n) => readImportRecord(projectId, n, home))
    .filter((r): r is ImportRecord => r !== null)
    .toSorted((a, b) => (a.importedAt < b.importedAt ? -1 : 1));
}

/** A private staging folder next to the final one (same file system, so the rename is atomic). */
export function stagingDir(projectId: string, importId: string, home?: string): string {
  const root = importsRoot(projectId, home);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, `.${importId}.staging-`));
}

export function writeStaged(
  dir: string,
  record: ImportRecord,
  artefacts: NormalisedArtefacts,
  files: Map<string, Buffer>,
): void {
  const objects = path.join(dir, "objects");
  fs.mkdirSync(objects, { recursive: true, mode: 0o700 });
  for (const data of files.values()) {
    const target = path.join(objects, sha256Hex(data));
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, data, { mode: 0o600, flag: "wx" });
    }
  }
  fs.writeFileSync(path.join(dir, "artefacts.json"), JSON.stringify(artefacts), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "record.json"), `${JSON.stringify(record, null, 1)}\n`, {
    mode: 0o600,
  });
}

/**
 * Move the staged folder to its final name. False when an import with the same id already
 * exists (a re-import or a concurrent one won the race); the staging folder is then removed.
 */
export function commitStaged(
  dir: string,
  projectId: string,
  importId: string,
  home?: string,
): boolean {
  const final = path.join(importsRoot(projectId, home), importId);
  try {
    fs.renameSync(dir, final);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    fs.rmSync(dir, { recursive: true, force: true });
    if (code === "ENOTEMPTY" || code === "EEXIST" || code === "EPERM") {
      return false;
    }
    throw err;
  }
}
