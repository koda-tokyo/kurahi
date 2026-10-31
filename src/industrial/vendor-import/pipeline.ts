// Offline import of vendor modernisation results (KIMS spec 4.1 Path A and 4.2; KIMS-021).
//
//   1. gate        the provider registry allows OFFLINE_IMPORT for this provider (and, once the
//                  manifest is read, this format) before anything else runs
//   2. bundle      zip or folder read under limits: traversal, symlinks, zip bombs (bundle.ts)
//   3. manifest    origin, every file's size and SHA-256; extra or missing files refused
//   4. scan        the extracted files, repacked uncompressed into one quarantined archive, go
//                  through the attachment-intake malware scanner with its configuration
//                  (security.attachments: scanner, requireScan, scanTimeoutSeconds); fail closed
//   5. parse       the format's parser; an unknown structure is SCHEMA_REJECTED, never guessed
//   6. store       content-addressed objects + normalised artefacts in the Project's state,
//                  committed by one rename under an id derived from the content (idempotent)
//   7. evidence    a signed evidence bundle and an audit row, for imports and for refusals
//
// A cancellation (AbortSignal) between stages leaves nothing behind but the refusal evidence.

import JSZip from "jszip";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FormatParser, ImportFormat } from "../providers.js";
import type { BundleLimits } from "./bundle.js";
import type { ParseInput, ParseResult } from "./formats/types.js";
import type { ImportRecord } from "./store.js";
import { auditSafe } from "../../audit/audit-log.js";
import { writeSealedBundle } from "../../evidence/sealed-bundle.js";
import { getProject, projectDataDir } from "../../projects/store.js";
import {
  type AttachmentSecurityConfig,
  resolveAttachmentSecurity,
} from "../../security/attachment-intake.js";
import { type FileScanner, resolveScanner, scanWithDeadline } from "../../security/scanner.js";
import { ProviderError, requireProviderAction } from "../providers.js";
import { DEFAULT_BUNDLE_LIMITS, readBundle } from "./bundle.js";
import { parseDocgenMd } from "./formats/docgen-md.js";
import { parseEarsRequirementsMd } from "./formats/ears-requirements-md.js";
import { parseGenericMapped } from "./formats/generic-mapped.js";
import { parseNeo4jJsonl } from "./formats/neo4j-jsonl.js";
import { MANIFEST_FILE, parseManifest, sha256Hex, verifyIntegrity } from "./manifest.js";
import {
  commitStaged,
  idempotencyKeyOf,
  importIdOf,
  importsRoot,
  readImportRecord,
  stagingDir,
  writeStaged,
} from "./store.js";

const PARSERS: Record<FormatParser, (input: ParseInput) => ParseResult> = {
  "neo4j-jsonl": parseNeo4jJsonl,
  "ears-requirements-md": parseEarsRequirementsMd,
  "docgen-md": parseDocgenMd,
  "generic-mapped": parseGenericMapped,
};

export type ImportStage = "gate" | "bundle" | "manifest" | "scan" | "parse" | "store" | "cancelled";

export type VendorImportInput = {
  projectId: string;
  provider: string;
  /** Path of the .zip or folder. */
  bundle: string;
  /** Who started the import (agent id, `cli:<user>`), for the audit row and evidence. */
  actor: string;
  sessionKey?: string;
};

export type VendorImportDeps = {
  home?: string;
  env?: NodeJS.ProcessEnv;
  config?: AttachmentSecurityConfig;
  scanner?: FileScanner;
  limits?: BundleLimits;
  signal?: AbortSignal;
  now?: () => Date;
  /** Test hook: runs between stages (e.g. to abort at a given point). */
  onStage?: (stage: ImportStage) => void;
};

export type VendorImportResult =
  | {
      status: "imported" | "duplicate";
      importId: string;
      idempotencyKey: string;
      record: ImportRecord;
    }
  | {
      status: "refused";
      stage: ImportStage;
      code: string;
      reason: string;
      remediation: string;
      evidence: { bundle: string; root: string } | null;
    };

/** The quarantined, uncompressed copy of exactly the bytes that will be parsed. */
async function packForScan(files: Map<string, Buffer>): Promise<Buffer> {
  const zip = new JSZip();
  for (const name of [...files.keys()].toSorted()) {
    zip.file(name, files.get(name) ?? Buffer.alloc(0), { date: new Date(0) });
  }
  return await zip.generateAsync({ type: "nodebuffer", compression: "STORE" });
}

export async function importVendorBundle(
  input: VendorImportInput,
  deps: VendorImportDeps = {},
): Promise<VendorImportResult> {
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const runId = randomBytes(8).toString("hex");
  const trail: { stage: ImportStage; ts: string; data: Record<string, unknown> }[] = [];
  let stage: ImportStage = "gate";
  let staging: string | null = null;
  let qfile: string | null = null;
  const step = (next: ImportStage, data: Record<string, unknown> = {}) => {
    trail.push({ stage, ts: now().toISOString(), data: { stage, ...data } });
    if (deps.signal?.aborted) {
      throw new ProviderError("CANCELLED", "the import was cancelled", "Start the import again.");
    }
    stage = next;
    deps.onStage?.(next);
    if (deps.signal?.aborted) {
      throw new ProviderError("CANCELLED", "the import was cancelled", "Start the import again.");
    }
  };
  const ids = { projectId: input.projectId, provider: input.provider, runId };
  try {
    const project = getProject(input.projectId, deps.home);
    if (!project || project.archived) {
      throw new ProviderError(
        "POLICY_DENIED",
        "the Project does not exist or is archived",
        "Import into an active Project.",
      );
    }
    requireProviderAction({ provider: input.provider, mode: "OFFLINE_IMPORT" });
    step("bundle");
    const bundle = await readBundle(input.bundle, deps.limits ?? DEFAULT_BUNDLE_LIMITS);
    step("manifest", {
      kind: bundle.kind,
      files: bundle.files.size,
      archiveSha256: bundle.archive ? sha256Hex(bundle.archive) : null,
    });
    const manifest = parseManifest(bundle.files);
    if (manifest.provider !== input.provider) {
      throw new ProviderError(
        "SCHEMA_REJECTED",
        `the manifest is for provider "${manifest.provider.slice(0, 40)}", not "${input.provider}"`,
        "Choose the provider the bundle was exported from.",
      );
    }
    const { descriptor, format } = requireProviderAction({
      provider: input.provider,
      mode: "OFFLINE_IMPORT",
      format: manifest.format,
    });
    const fmt = format as ImportFormat;
    verifyIntegrity(manifest, bundle.files);
    step("scan", { format: fmt.id, verification: fmt.verification });
    const cfg = deps.config ?? resolveAttachmentSecurity();
    const qdir = path.join(projectDataDir(input.projectId, deps.home), "quarantine", "imports");
    fs.mkdirSync(qdir, { recursive: true, mode: 0o700 });
    qfile = path.join(qdir, `${runId}.quarantine`);
    fs.writeFileSync(qfile, await packForScan(bundle.files), { flag: "wx", mode: 0o600 });
    const scanner = deps.scanner ?? resolveScanner(cfg.scanner);
    const scan = await scanWithDeadline(scanner, qfile, cfg.scanTimeoutMs);
    if (scan.verdict === "infected") {
      throw new ProviderError(
        "POLICY_DENIED",
        `the malware scanner found a threat (${scan.signature ?? "unnamed"})`,
        "Do not import this bundle; report it to your security team.",
      );
    }
    if (scan.verdict === "error") {
      throw new ProviderError(
        "POLICY_DENIED",
        `the malware scan did not complete (${scan.detail ?? "error"})`,
        "Check the scanner (security.attachments) and import again.",
      );
    }
    if (scan.verdict === "unscanned" && cfg.requireScan) {
      throw new ProviderError(
        "POLICY_DENIED",
        "no malware scanner is available and security.attachments.requireScan is on",
        "Install a scanner (clamav, defender or yara) and import again.",
      );
    }
    step("parse", { scanner: scan.scanner, verdict: scan.verdict });
    const data = manifest.files
      .filter((f) => f.role === "data")
      .map((f) => ({ path: f.path, sha256: f.sha256, bytes: bundle.files.get(f.path)! }));
    const mapEntry = manifest.files.find((f) => f.role === "mapping");
    const mapping = mapEntry
      ? { path: mapEntry.path, sha256: mapEntry.sha256, bytes: bundle.files.get(mapEntry.path)! }
      : null;
    if (fmt.parser !== "generic-mapped" && mapping) {
      throw new ProviderError(
        "SCHEMA_REJECTED",
        `${fmt.id} is read by its documented structure; a field mapping file is not used`,
        "Remove the mapping file or choose a mapped format.",
      );
    }
    const parsed = PARSERS[fmt.parser]({ manifest, data, mapping });
    const a = parsed.artefacts;
    const key = idempotencyKeyOf(manifest, bundle.files);
    const importId = importIdOf(key);
    step("store", {
      fingerprint: parsed.fingerprint,
      items: a.items.length,
      edges: a.edges.length,
      rules: a.rules.length,
      findings: a.findings.length,
    });
    const existing = readImportRecord(input.projectId, importId, deps.home);
    const duplicate = (record: ImportRecord): VendorImportResult => {
      void auditSafe({
        identity: input.actor,
        scope: input.projectId,
        action: "industrial.vendor-import",
        outcome: "ok",
        source: "industrial.import",
        detail: { ...ids, importId, duplicate: true },
      });
      return { status: "duplicate", importId, idempotencyKey: key, record };
    };
    if (existing) {
      return duplicate(existing);
    }
    staging = stagingDir(input.projectId, importId, deps.home);
    const endedAt = now().toISOString();
    const record: ImportRecord = {
      schema: "kurahi.vendor-import-record/1",
      importId,
      idempotencyKey: key,
      projectId: input.projectId,
      provider: descriptor.provider_id,
      format: fmt.id,
      verification: fmt.verification,
      docs: fmt.docs,
      provenance: "IMPORTED_VENDOR_ARTEFACT",
      confidence: "UNVERIFIED",
      importedAt: endedAt,
      importedBy: input.actor,
      bundle: { kind: bundle.kind, sha256: bundle.archive ? sha256Hex(bundle.archive) : null },
      manifest,
      scan: { scanner: scan.scanner, verdict: scan.verdict },
      fingerprint: parsed.fingerprint,
      fingerprintDetail: parsed.fingerprintDetail,
      counts: {
        items: a.items.length,
        edges: a.edges.length,
        rules: a.rules.length,
        findings: a.findings.length,
        notes: a.notes.length,
      },
      evidence: null,
    };
    const ev = writeSealedBundle(
      path.join(staging, "evidence"),
      {
        jobId: importId,
        agent: input.actor,
        sessionKey: input.sessionKey ?? `industrial-import:${input.projectId}`,
        kind: "industrial.vendor-import",
        status: "imported",
        startedAt,
        endedAt,
      },
      [
        { type: "job.start", ts: startedAt, data: { kind: "industrial.vendor-import", ...ids } },
        ...trail.map((t) => ({ type: "audit" as const, ts: t.ts, data: t.data })),
        {
          type: "audit",
          ts: endedAt,
          data: {
            stage: "store",
            importId,
            idempotencyKey: key,
            format: fmt.id,
            verification: fmt.verification,
            fingerprint: parsed.fingerprint,
            files: manifest.files.map((f) => ({ path: f.path, sha256: f.sha256, role: f.role })),
            origin: manifest.origin,
            counts: record.counts,
          },
        },
        { type: "job.end", ts: endedAt, data: { status: "imported" } },
      ],
      { env: deps.env },
    );
    record.evidence = { bundle: path.join(importId, "evidence"), root: ev.root };
    writeStaged(staging, record, a, bundle.files);
    if (deps.signal?.aborted) {
      throw new ProviderError("CANCELLED", "the import was cancelled", "Start the import again.");
    }
    const committed = commitStaged(staging, input.projectId, importId, deps.home);
    staging = null;
    if (!committed) {
      const winner = readImportRecord(input.projectId, importId, deps.home);
      if (winner) {
        return duplicate(winner);
      }
      throw new ProviderError(
        "UNKNOWN_EXTERNAL_STATE",
        "the import folder exists but has no readable record",
        "Check the Project's industrial-imports folder.",
      );
    }
    void auditSafe({
      identity: input.actor,
      scope: input.projectId,
      action: "industrial.vendor-import",
      outcome: "ok",
      source: "industrial.import",
      detail: { ...ids, importId, format: fmt.id, ...record.counts },
    });
    return { status: "imported", importId, idempotencyKey: key, record };
  } catch (err) {
    const pe =
      err instanceof ProviderError
        ? err
        : new ProviderError(
            "VENDOR_FAILED",
            `the import failed: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`,
            "Check the bundle and import again.",
          );
    return refuse(input, pe.code === "CANCELLED" ? "cancelled" : stage, pe, {
      ids,
      trail,
      startedAt,
      now,
      deps,
    });
  } finally {
    if (staging) {
      fs.rmSync(staging, { recursive: true, force: true });
    }
    if (qfile) {
      fs.rmSync(qfile, { force: true });
    }
  }
}

function refuse(
  input: VendorImportInput,
  stage: ImportStage,
  err: ProviderError,
  ctx: {
    ids: Record<string, string>;
    trail: { stage: ImportStage; ts: string; data: Record<string, unknown> }[];
    startedAt: string;
    now: () => Date;
    deps: VendorImportDeps;
  },
): VendorImportResult {
  const endedAt = ctx.now().toISOString();
  const result: Extract<VendorImportResult, { status: "refused" }> = {
    status: "refused",
    stage,
    code: err.code,
    reason: err.message,
    remediation: err.remediation,
    evidence: null,
  };
  void auditSafe({
    identity: input.actor,
    scope: input.projectId,
    action: "industrial.vendor-import",
    outcome: "denied",
    source: "industrial.import",
    detail: { ...ctx.ids, stage, code: err.code },
  });
  try {
    if (getProject(input.projectId, ctx.deps.home)) {
      const rid = `ref-${ctx.ids.runId}`;
      const dir = path.join(
        importsRoot(input.projectId, ctx.deps.home),
        "refused",
        rid,
        "evidence",
      );
      const { root } = writeSealedBundle(
        dir,
        {
          jobId: rid,
          agent: input.actor,
          sessionKey: input.sessionKey ?? `industrial-import:${input.projectId}`,
          kind: "industrial.vendor-import",
          status: "refused",
          startedAt: ctx.startedAt,
          endedAt,
        },
        [
          {
            type: "job.start",
            ts: ctx.startedAt,
            data: { kind: "industrial.vendor-import", ...ctx.ids },
          },
          ...ctx.trail.map((t) => ({ type: "audit" as const, ts: t.ts, data: t.data })),
          {
            type: "permission",
            ts: endedAt,
            data: { decision: "refuse", stage, code: err.code, reason: err.message },
          },
          { type: "job.end", ts: endedAt, data: { status: "refused" } },
        ],
        { env: ctx.deps.env },
      );
      result.evidence = { bundle: path.join("refused", rid, "evidence"), root };
    }
  } catch {
    // The audit row stands; a missing bundle never turns a refusal into an import.
  }
  return result;
}

export { MANIFEST_FILE };
