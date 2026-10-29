// eDiscovery export (docs/security/data-governance.md#ediscovery-export): a signed,
// self-verifying zip of everything in a scope. Runs as a background job; the archive is written
// under <KOLO_HOME>/governance/exports/<id>.zip and downloaded through an authenticated route.
//
// Archive layout:
//   manifest.json                 export id, who, when, reason, scope, counts, SHA-256 + size of
//                                 every other file, Ed25519 signature (the evidence key)
//   verification.json             evidence verification report (every bundle, every work item
//                                 chain incl. tombstones, the audit chain)
//   README.txt                    how to verify
//   workitems/<project>/<id>/item.json, .../evidence/<bundle>/*   items with history + bundles
//   evidence/<jobId>/*            job evidence bundles (verbatim, so their signatures verify)
//   evidence/_tombstones/*.json   tombstones of deleted job evidence in scope
//   transcripts/<agent>/<file>    conversation transcripts
//   attachments/index.json        attachment metadata (+ attachments/files/* with files: true)
//   outputs/<artifact>/*          generated outputs (artifacts)
//   memory/<agent>/<id>.json      memory quarantine records
//   audit/rows.jsonl              audit rows in scope (raw lines; each recomputes its hash)
//
// With `redact`, personal identifiers are replaced in items, transcripts, outputs and audit rows
// (manifest says so). Evidence bundles are always verbatim: they are redacted when recorded, and
// a changed byte would fail their signature.
import fs from "node:fs";
import path from "node:path";
import type { GovernanceDataClass } from "../config/types.governance.js";
import { auditFileForMonth, listAuditMonths, type AuditEntry } from "../audit/audit-log.js";
import { verifyAuditChain } from "../audit/verify.js";
import { sha256Hex } from "../continuity-suite/manifest.js";
import { listJobTombstones, verifyTombstone } from "../evidence/tombstone.js";
import { verifyEvidenceBundle } from "../evidence/verify.js";
import { readZip, writeZip, type BundleFiles } from "../evidence/zip.js";
import { verifyWorkItemEvidenceChain } from "../workitems/evidence.js";
import {
  cleanHoldScope,
  holdCovers,
  type DataRef,
  type HoldScope,
  type LegalHold,
} from "./holds.js";
import { redactPersonalData } from "./personal-data.js";
import { GovernanceRefused } from "./policy.js";
import { collectRecords } from "./records.js";
import {
  auditDirOf,
  governanceDir,
  isGovernanceId,
  newGovernanceId,
  readJsonFile,
  signRecord,
  verifyRecord,
  writeJsonAtomic,
} from "./store.js";

export const EXPORT_CLASSES = [
  "workitems",
  "evidence",
  "transcripts",
  "attachments",
  "outputs",
  "memory",
  "audit",
] as const satisfies readonly GovernanceDataClass[];
export type ExportClass = (typeof EXPORT_CLASSES)[number];

export type ExportStatus = {
  id: string;
  status: "running" | "done" | "failed";
  createdAt: string;
  createdBy: string;
  reason: string;
  matterId: string | null;
  scope: HoldScope;
  classes: ExportClass[];
  attachmentFiles: boolean;
  redacted: boolean;
  finishedAt: string | null;
  bytes: number | null;
  sha256: string | null;
  files: number | null;
  verificationOk: boolean | null;
  error: string | null;
};

export type ExportInput = {
  reason?: unknown;
  matterId?: unknown;
  scope?: unknown;
  classes?: unknown;
  attachmentFiles?: unknown;
  redact?: unknown;
};

function exportsDir(home: string): string {
  return path.join(governanceDir(home), "exports");
}

export function exportArchivePath(home: string, id: string): string {
  if (!isGovernanceId(id, "exp")) {
    throw new GovernanceRefused("export_not_found", "export not found");
  }
  return path.join(exportsDir(home), `${id}.zip`);
}

export function readExport(home: string, id: unknown): ExportStatus | null {
  if (!isGovernanceId(id, "exp")) {
    return null;
  }
  return readJsonFile<ExportStatus | null>(path.join(exportsDir(home), `${id}.json`), null);
}

export function listExports(home: string): ExportStatus[] {
  let names: string[];
  try {
    names = fs.readdirSync(exportsDir(home)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  return names
    .map((n) => readExport(home, n.slice(0, -5)))
    .filter((s): s is ExportStatus => s !== null)
    .toSorted((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function writeStatus(home: string, s: ExportStatus): void {
  writeJsonAtomic(path.join(exportsDir(home), `${s.id}.json`), s);
}

/** Scope as a pseudo-hold so export and hold use one inclusion rule (fail closed). */
function inScope(scope: HoldScope, rec: DataRef): boolean {
  const hold: LegalHold = {
    id: "export",
    matterId: "",
    reason: "",
    scope,
    status: "active",
    createdAt: "",
    createdBy: "",
  };
  return holdCovers(hold, rec);
}

function rel(p: string): string {
  return p.split(path.sep).join("/");
}

function addDir(files: BundleFiles, dir: string, prefix: string): void {
  const walk = (d: string, pre: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) {
        walk(abs, `${pre}/${e.name}`);
      } else if (e.isFile() && e.name !== ".lock") {
        files.set(`${pre}/${e.name}`, fs.readFileSync(abs));
      }
    }
  };
  walk(dir, prefix);
}

function maybeRedact(text: string, redact: boolean): string {
  return redact ? redactPersonalData(text).text : text;
}

function auditRowInScope(scope: HoldScope, row: AuditEntry): boolean {
  const d = (row.detail ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const projectId = str(d.projectId) ?? (row.scope?.startsWith("p") ? row.scope : null);
  const itemId =
    str(d.itemId) ?? str(d.workItemId) ?? (str(d.id)?.startsWith("w") ? str(d.id) : null);
  if (scope.projectIds && !(projectId && scope.projectIds.includes(projectId))) {
    return false;
  }
  if (scope.workItemIds && !(itemId && scope.workItemIds.includes(itemId))) {
    return false;
  }
  const people = [...(scope.persons ?? []), ...(scope.custodians ?? [])];
  if (people.length > 0 && !(row.identity && people.includes(row.identity))) {
    return false;
  }
  if (scope.from && row.ts < scope.from) {
    return false;
  }
  if (scope.to && row.ts > scope.to) {
    return false;
  }
  return true;
}

export type BuiltArchive = {
  files: BundleFiles;
  manifest: Record<string, unknown>;
  verificationOk: boolean;
};

/** Build the archive in memory (exported for tests). */
export async function buildExportArchive(home: string, s: ExportStatus): Promise<BuiltArchive> {
  const files: BundleFiles = new Map();
  const want = new Set<GovernanceDataClass>(s.classes);
  const records = collectRecords({ home, classes: want }).filter((r) => inScope(s.scope, r));
  const verification: Record<string, unknown> = { bundles: [], workItems: [], tombstones: [] };
  const vBundles = verification.bundles as Array<Record<string, unknown>>;
  const vItems = verification.workItems as Array<Record<string, unknown>>;
  let allOk = true;
  const counts: Record<string, number> = {};
  const count = (c: string) => (counts[c] = (counts[c] ?? 0) + 1);
  const attachments: Array<Record<string, unknown>> = [];

  for (const rec of records) {
    switch (rec.class) {
      case "workitems": {
        const [projectId, id] = rec.id.split("/");
        const prefix = `workitems/${projectId}/${id}`;
        const itemFile = path.join(rec.path, "item.json");
        if (fs.existsSync(itemFile)) {
          files.set(
            `${prefix}/item.json`,
            Buffer.from(maybeRedact(fs.readFileSync(itemFile, "utf8"), s.redacted)),
          );
        }
        if (want.has("evidence")) {
          addDir(files, path.join(rec.path, "evidence"), `${prefix}/evidence`);
          const chain = await verifyWorkItemEvidenceChain({ projectId, id }, home);
          allOk &&= chain.chainOk;
          vItems.push({ projectId, id, chainOk: chain.chainOk, bundles: chain.bundles });
        }
        count("workitems");
        break;
      }
      case "evidence": {
        if (rec.id.startsWith("job:")) {
          const jobId = rec.id.slice(4);
          addDir(files, rec.path, `evidence/${jobId}`);
          const v = await verifyEvidenceBundle(rec.path);
          allOk &&= v.ok;
          vBundles.push({
            jobId,
            ok: v.ok,
            problems: v.problems,
            root: v.manifest?.events.root ?? null,
          });
          count("evidence");
        }
        // Work item bundles travel with their item (above).
        break;
      }
      case "transcripts": {
        const agent = rec.id.split(":")[0];
        files.set(
          `transcripts/${agent}/${path.basename(rec.path)}`,
          Buffer.from(maybeRedact(fs.readFileSync(rec.path, "utf8"), s.redacted)),
        );
        count("transcripts");
        break;
      }
      case "attachments": {
        const buf = fs.readFileSync(rec.path);
        const entry: Record<string, unknown> = {
          id: rec.id,
          projectId: rec.projectId ?? null,
          name: path.basename(rec.path),
          size: buf.length,
          sha256: sha256Hex(buf),
          modifiedAt: rec.at,
        };
        if (s.attachmentFiles) {
          const name = `attachments/files/${sha256Hex(rec.id).slice(0, 16)}-${path.basename(rec.path)}`;
          files.set(name, buf);
          entry.file = name;
        }
        attachments.push(entry);
        count("attachments");
        break;
      }
      case "outputs": {
        const id = rec.id.slice("artifact:".length);
        const tmp: BundleFiles = new Map();
        addDir(tmp, rec.path, `outputs/${id}`);
        for (const [k, v] of tmp) {
          files.set(k, s.redacted ? Buffer.from(maybeRedact(v.toString("utf8"), true)) : v);
        }
        count("outputs");
        break;
      }
      case "memory": {
        const [agent, id] = rec.id.slice("quarantine:".length).split("/");
        files.set(
          `memory/${agent}/${id}.json`,
          Buffer.from(maybeRedact(fs.readFileSync(rec.path, "utf8"), s.redacted)),
        );
        count("memory");
        break;
      }
      default:
        break;
    }
  }
  if (want.has("evidence")) {
    const tombs = listJobTombstones(home).filter((t) =>
      inScope(s.scope, {
        class: "evidence",
        id: t.jobId,
        projectId: t.projectId,
        workItemId: null,
        from: t.manifest?.startedAt ?? null,
        to: t.manifest?.endedAt ?? null,
      }),
    );
    for (const t of tombs) {
      const check = verifyTombstone(t);
      allOk &&= check.ok;
      (verification.tombstones as unknown[]).push({ jobId: t.jobId, ...check });
      files.set(
        `evidence/_tombstones/${t.jobId}.json`,
        Buffer.from(`${JSON.stringify(t, null, 2)}\n`),
      );
    }
  }
  if (want.has("attachments")) {
    files.set("attachments/index.json", Buffer.from(`${JSON.stringify(attachments, null, 2)}\n`));
  }
  if (want.has("audit")) {
    const dir = auditDirOf(home);
    const rows: string[] = [];
    for (const month of listAuditMonths(dir)) {
      let text = "";
      try {
        text = fs.readFileSync(auditFileForMonth(dir, month), "utf8");
      } catch {
        continue;
      }
      for (const line of text.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          if (auditRowInScope(s.scope, JSON.parse(line) as AuditEntry)) {
            rows.push(maybeRedact(line, s.redacted));
          }
        } catch {
          // reported by the chain check
        }
      }
    }
    counts.audit = rows.length;
    files.set("audit/rows.jsonl", Buffer.from(rows.length ? `${rows.join("\n")}\n` : ""));
    const chain = verifyAuditChain(dir);
    allOk &&= chain.ok;
    verification.audit = chain;
  }
  verification.ok = allOk;
  files.set("verification.json", Buffer.from(`${JSON.stringify(verification, null, 2)}\n`));
  files.set(
    "README.txt",
    Buffer.from(
      [
        "Kurahi eDiscovery export",
        "",
        "manifest.json lists every other file with its SHA-256 and size and is signed (Ed25519).",
        "Verify with: kurahi governance verify-export <file.zip>  (or verifyGovernanceExport()).",
        "Evidence bundles inside verify on their own with: kurahi evidence verify <dir>.",
        "verification.json is the evidence verification report made when the export was built.",
        "",
      ].join("\n"),
    ),
  );
  const fileTable: Record<string, { sha256: string; size: number }> = {};
  for (const [name, buf] of [...files.entries()].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
    fileTable[rel(name)] = { sha256: sha256Hex(buf), size: buf.length };
  }
  const manifest = signRecord(
    "export",
    {
      v: 1,
      exportId: s.id,
      createdAt: s.createdAt,
      createdBy: s.createdBy,
      reason: s.reason,
      matterId: s.matterId,
      scope: s.scope,
      classes: s.classes,
      attachmentFiles: s.attachmentFiles,
      redacted: s.redacted,
      counts,
      verificationOk: allOk,
      files: fileTable,
    },
    home,
  );
  files.set("manifest.json", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
  return { files, manifest, verificationOk: allOk };
}

export type ExportVerification = {
  ok: boolean;
  signatureOk: boolean;
  filesOk: boolean;
  problems: string[];
  manifest: Record<string, unknown> | null;
};

/** Verify an archive on its own: signature, every file's hash, nothing extra, nothing missing. */
export async function verifyGovernanceExport(buffer: Buffer): Promise<ExportVerification> {
  const problems: string[] = [];
  const files = await readZip(buffer);
  const raw = files.get("manifest.json");
  if (!raw) {
    return {
      ok: false,
      signatureOk: false,
      filesOk: false,
      problems: ["manifest.json missing"],
      manifest: null,
    };
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      signatureOk: false,
      filesOk: false,
      problems: ["manifest.json unreadable"],
      manifest: null,
    };
  }
  const signatureOk = verifyRecord("export", manifest);
  if (!signatureOk) {
    problems.push("manifest signature does not verify");
  }
  const table = (manifest.files ?? {}) as Record<string, { sha256: string; size: number }>;
  let filesOk = true;
  for (const [name, entry] of Object.entries(table)) {
    const buf = files.get(name);
    if (!buf) {
      filesOk = false;
      problems.push(`missing: ${name}`);
    } else if (sha256Hex(buf) !== entry.sha256 || buf.length !== entry.size) {
      filesOk = false;
      problems.push(`hash mismatch: ${name}`);
    }
  }
  for (const name of files.keys()) {
    if (name !== "manifest.json" && !(name in table)) {
      filesOk = false;
      problems.push(`not in manifest: ${name}`);
    }
  }
  return { ok: signatureOk && filesOk, signatureOk, filesOk, problems, manifest };
}

function cleanClasses(raw: unknown): ExportClass[] {
  if (raw === undefined || raw === null) {
    return [...EXPORT_CLASSES];
  }
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    raw.some((c) => !EXPORT_CLASSES.includes(c as ExportClass))
  ) {
    throw new GovernanceRefused(
      "bad_classes",
      `classes must be a non-empty subset of ${EXPORT_CLASSES.join(", ")}`,
    );
  }
  return [...new Set(raw as ExportClass[])];
}

/**
 * Start an export job. Returns at once with status `running`; the archive is built on the next
 * turn of the event loop and the status file is updated when it is done or failed.
 */
export function startExport(
  home: string,
  input: ExportInput,
  by: string,
  opts: { now?: Date; redactDefault?: boolean; onDone?: (s: ExportStatus) => void } = {},
): { status: ExportStatus; done: Promise<ExportStatus> } {
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 2 || reason.length > 2000) {
    throw new GovernanceRefused("reason_required", "a written reason is required");
  }
  const matterId =
    typeof input.matterId === "string" && input.matterId.trim()
      ? input.matterId.trim().slice(0, 120)
      : null;
  const status: ExportStatus = {
    id: newGovernanceId("exp"),
    status: "running",
    createdAt: (opts.now ?? new Date()).toISOString(),
    createdBy: by,
    reason,
    matterId,
    scope: cleanHoldScope(input.scope),
    classes: cleanClasses(input.classes),
    attachmentFiles: input.attachmentFiles === true,
    redacted: typeof input.redact === "boolean" ? input.redact : Boolean(opts.redactDefault),
    finishedAt: null,
    bytes: null,
    sha256: null,
    files: null,
    verificationOk: null,
    error: null,
  };
  writeStatus(home, status);
  const done = (async () => {
    await new Promise((r) => setImmediate(r));
    try {
      const built = await buildExportArchive(home, status);
      const zip = await writeZip(built.files);
      const file = exportArchivePath(home, status.id);
      fs.writeFileSync(file, zip, { mode: 0o600 });
      const next: ExportStatus = {
        ...status,
        status: "done",
        finishedAt: new Date().toISOString(),
        bytes: zip.length,
        sha256: sha256Hex(zip),
        files: built.files.size,
        verificationOk: built.verificationOk,
      };
      writeStatus(home, next);
      return next;
    } catch (err) {
      const next: ExportStatus = {
        ...status,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      };
      writeStatus(home, next);
      return next;
    }
  })().then((s) => {
    opts.onDone?.(s);
    return s;
  });
  return { status, done };
}
