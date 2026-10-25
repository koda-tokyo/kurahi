// Attachment intake (docs/security/attachment-intake.md): one inbound file, from bytes a
// connector downloaded to a path inside the Project, through
//
//   1. quarantine   <projectDataDir>/quarantine/attachments/<id>.quarantine (0600, no name, no
//                   extension, never the client folder, deleted when the intake ends)
//   2. static policy (attachment-policy.ts, always, whatever the scanner)
//   3. malware scan  (scanner.ts; fail closed; `unscanned` refused while requireScan is on)
//   4. store         a copy into the Project's writable `inbox-attachments/` folder, under the
//                    Project's write guards (mode, writable folders, no symbolic links, the
//                    integrity registry), never over an existing different file
//   5. extract       text in a bounded child process (isolated-extract.ts)
//
// Only a clean verdict reaches step 4, so a project-relative path is returned only for a file
// that passed. The bytes never go back to the caller. Every refusal is audited (ids, hash,
// verdict, scanner, code; never the file name or content) and sealed as a signed evidence bundle.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { KoLoConfig } from "../config/config.js";
import type { DocumentKind } from "../projects/documents.js";
import type { Project } from "../projects/types.js";
import { auditSafe } from "../audit/audit-log.js";
import { loadConfig } from "../config/config.js";
import { writeSealedBundle } from "../evidence/sealed-bundle.js";
import { currentProtectedSet, isProtectedPath } from "../integrity/write-policy.js";
import { safeFileName } from "../projects/documents.js";
import { writableForMode } from "../projects/scope.js";
import { projectDataDir } from "../projects/store.js";
import { ATTACHMENT_MAX_BYTES, checkAttachmentPolicy } from "./attachment-policy.js";
import { extractTextIsolated, type IsolatedExtractOptions } from "./isolated-extract.js";
import {
  DEFAULT_SCAN_TIMEOUT_MS,
  type FileScanner,
  resolveScanner,
  type ScannerChoice,
  type ScanVerdict,
  scanWithDeadline,
} from "./scanner.js";

/** The Project folder that receives accepted attachments (must be writable in the Project). */
export const INBOX_ATTACHMENTS_DIR = "inbox-attachments";
/**
 * Other intake folders a caller may name (`folder`): fixed names, never a path a model chose.
 * `corpus-inbox`: open-access papers the Scholars sources fetch (extensions/scholar-sources).
 */
export const INTAKE_FOLDERS = [INBOX_ATTACHMENTS_DIR, "corpus-inbox"] as const;
export type IntakeFolder = (typeof INTAKE_FOLDERS)[number];
const QUARANTINE_DIR = path.join("quarantine", "attachments");
const MAX_TEXT_CHARS = 20_000;

export type AttachmentSecurityConfig = {
  scanner: ScannerChoice;
  requireScan: boolean;
  scanTimeoutMs: number;
  extractTimeoutMs: number;
  extractMaxOldSpaceMb: number;
};

export function resolveAttachmentSecurity(cfg?: KoLoConfig): AttachmentSecurityConfig {
  let c: NonNullable<NonNullable<KoLoConfig["security"]>["attachments"]> = {};
  try {
    c = (cfg ?? loadConfig()).security?.attachments ?? {};
  } catch {
    c = {};
  }
  const secs = (v: unknown, def: number, max: number) =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, max) * 1000 : def;
  return {
    scanner: c.scanner ?? "auto",
    // Only an explicit false turns the requirement off.
    requireScan: c.requireScan !== false,
    scanTimeoutMs: secs(c.scanTimeoutSeconds, DEFAULT_SCAN_TIMEOUT_MS, 600),
    extractTimeoutMs: secs(c.extractTimeoutSeconds, 30_000, 300),
    extractMaxOldSpaceMb: typeof c.extractMaxOldSpaceMb === "number" ? c.extractMaxOldSpaceMb : 256,
  };
}

export const ATTACHMENT_REFUSAL_CODES = [
  "infected",
  "scan_failed",
  "unscanned",
  "not_writable",
  "store_failed",
] as const;

export type AttachmentIntakeInput = {
  project: Project;
  /** Connector id (`microsoft-365`). */
  connector: string;
  messageId: string;
  attachmentId: string;
  /** The sender-chosen file name: untrusted, used only to decide the type and the stored name. */
  name: string;
  bytes: Buffer;
  /** Who fetched it (agent id or `autopilot:<routineId>`), for the audit row. */
  actor: string;
  sessionKey?: string;
  /** Set when the fetch runs inside an autopilot run (engine invocation). */
  run?: { routineId: string; runId: string } | null;
  /** Writable Project folder that receives the file (default inbox-attachments). */
  folder?: IntakeFolder;
};

export type AttachmentEvidence = { bundle: string; root: string };

export type AttachmentIntakeResult =
  | {
      status: "accepted";
      /** Project-relative path of the stored copy. */
      path: string;
      kind: DocumentKind;
      sha256: string;
      size: number;
      scanner: ScanVerdict["scanner"];
      verdict: "clean" | "unscanned";
      /** Extracted text (bounded), or null when extraction failed. */
      text: string | null;
      textError: string | null;
    }
  | {
      status: "refused";
      stage: "policy" | "scan" | "store";
      code: string;
      reason: string;
      /** Null when the file was refused before it was downloaded. */
      sha256: string | null;
      size: number;
      scanner: ScanVerdict["scanner"] | null;
      verdict: ScanVerdict["verdict"] | null;
      signature: string | null;
      evidence: AttachmentEvidence | null;
    };

export type AttachmentIntakeDeps = {
  config?: AttachmentSecurityConfig;
  scanner?: FileScanner;
  extract?: IsolatedExtractOptions;
  home?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
};

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

function quarantineDir(projectId: string, home?: string): string {
  return path.join(projectDataDir(projectId, home), QUARANTINE_DIR);
}

export function attachmentEvidenceDir(projectId: string, id: string, home?: string): string {
  if (!/^q[a-f0-9]{16}$/.test(id)) {
    throw new Error("invalid intake id");
  }
  return path.join(projectDataDir(projectId, home), "security", "attachments", id, "evidence");
}

class StoreRefused extends Error {
  constructor(
    readonly code: "not_writable" | "store_failed",
    message: string,
  ) {
    super(message);
  }
}

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Copy the quarantined file into `inbox-attachments/` (or another of INTAKE_FOLDERS) of the
 * Project folder. The folder must be
 * writable in the Project's current mode; folders are walked one by one refusing symbolic links;
 * the name is the sanitised original prefixed with a date and the content hash, so the same
 * file stored twice lands on the same name and a different file never replaces another.
 */
export function storeAccepted(
  project: Project,
  source: string,
  name: string,
  hash: string,
  now: Date,
  folder: IntakeFolder = INBOX_ATTACHMENTS_DIR,
): string {
  if (!(INTAKE_FOLDERS as readonly string[]).includes(folder)) {
    throw new StoreRefused("not_writable", "unknown intake folder");
  }
  const writable = writableForMode(project);
  if (!writable.some((w) => w === "." || w === folder)) {
    throw new StoreRefused(
      "not_writable",
      `"${folder}" is not a writable folder of this Project in its current mode`,
    );
  }
  let root: string;
  try {
    root = fs.realpathSync(project.folder);
  } catch {
    throw new StoreRefused("store_failed", "the Project folder is not available");
  }
  const dir = path.join(root, folder);
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(dir);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink() || (st && !st.isDirectory())) {
    throw new StoreRefused("not_writable", `"${folder}" is not a plain folder`);
  }
  if (!st) {
    fs.mkdirSync(dir, { mode: 0o755 });
  }
  if (!within(fs.realpathSync(dir), root)) {
    throw new StoreRefused("not_writable", "the attachments folder resolves outside the Project");
  }
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  const base = `${day}-${hash.slice(0, 8)}-${safeFileName(name)}`.slice(0, 140);
  const abs = path.join(dir, base);
  const rel = `${folder}/${base}`;
  if (isProtectedPath(abs, root, currentProtectedSet())) {
    throw new StoreRefused("not_writable", "the target is protected by the integrity registry");
  }
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(abs);
  } catch {
    existing = null;
  }
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new StoreRefused("store_failed", "the target name exists and is not a plain file");
    }
    if (sha256(fs.readFileSync(abs)) === hash) {
      return rel;
    }
    throw new StoreRefused("store_failed", "a different file already has that name");
  }
  const tmp = path.join(dir, `.${randomBytes(6).toString("hex")}.intake.tmp`);
  try {
    fs.copyFileSync(source, tmp, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(tmp, 0o644);
    try {
      fs.lstatSync(abs);
      throw new StoreRefused("store_failed", "the target appeared while storing");
    } catch (err) {
      if (err instanceof StoreRefused) {
        throw err;
      }
    }
    fs.renameSync(tmp, abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return rel;
}

export type AttachmentRefusalInput = Omit<AttachmentIntakeInput, "name" | "bytes">;

/**
 * Record a refusal: an audit row (ids, hash, verdict, scanner, code; never the name or content)
 * and a sealed evidence bundle. Also used by connectors for refusals before any download
 * (item or reference attachments, an oversize declaration).
 */
export function recordAttachmentRefusal(
  input: AttachmentRefusalInput,
  r: {
    stage: "policy" | "scan" | "store";
    code: string;
    reason: string;
    size: number;
    sha256?: string | null;
    scan?: ScanVerdict | null;
    id?: string;
    startedAt?: string;
  },
  deps: AttachmentIntakeDeps = {},
): Extract<AttachmentIntakeResult, { status: "refused" }> {
  const now = deps.now ?? (() => new Date());
  const id = r.id ?? `q${randomBytes(8).toString("hex")}`;
  const ended = now().toISOString();
  const started = r.startedAt ?? ended;
  const out: Extract<AttachmentIntakeResult, { status: "refused" }> = {
    status: "refused",
    stage: r.stage,
    code: r.code,
    reason: r.reason,
    sha256: r.sha256 ?? null,
    size: r.size,
    scanner: r.scan?.scanner ?? null,
    verdict: r.scan?.verdict ?? null,
    signature: r.scan?.signature ?? null,
    evidence: null,
  };
  const ids = {
    projectId: input.project.id,
    connector: input.connector,
    messageId: input.messageId,
    attachmentId: input.attachmentId,
    intakeId: id,
    ...(input.run ? { routineId: input.run.routineId, runId: input.run.runId } : {}),
  };
  const verdict = {
    stage: out.stage,
    code: out.code,
    verdict: out.verdict,
    scanner: out.scanner,
    signature: out.signature,
    sha256: out.sha256,
    size: out.size,
  };
  void auditSafe({
    identity: input.actor,
    scope: input.project.id,
    action: "attachment.intake",
    outcome: "denied",
    source: "security.attachments",
    detail: { ...ids, ...verdict },
  });
  try {
    const dir = attachmentEvidenceDir(input.project.id, id, deps.home);
    const { root } = writeSealedBundle(
      dir,
      {
        jobId: `att-${id}`,
        agent: input.actor,
        sessionKey: input.sessionKey ?? `attachment:${input.project.id}`,
        kind: "security.attachment",
        status: "refused",
        startedAt: started,
        endedAt: ended,
      },
      [
        { type: "job.start", ts: started, data: { kind: "attachment.intake", ...ids } },
        { type: "permission", ts: ended, data: { decision: "refuse", ...verdict } },
        { type: "job.end", ts: ended, data: { status: "refused" } },
      ],
      { env: deps.env },
    );
    out.evidence = {
      bundle: path.relative(projectDataDir(input.project.id, deps.home), dir),
      root,
    };
  } catch {
    // The audit row stands; a missing bundle never turns a refusal into an acceptance.
  }
  return out;
}

export async function intakeAttachment(
  input: AttachmentIntakeInput,
  deps: AttachmentIntakeDeps = {},
): Promise<AttachmentIntakeResult> {
  const now = deps.now ?? (() => new Date());
  const started = now().toISOString();
  const cfg = deps.config ?? resolveAttachmentSecurity();
  const id = `q${randomBytes(8).toString("hex")}`;
  const hash = sha256(input.bytes);
  const size = input.bytes.length;
  const refused = (
    stage: "policy" | "scan" | "store",
    code: string,
    reason: string,
    scan: ScanVerdict | null = null,
  ): AttachmentIntakeResult =>
    recordAttachmentRefusal(
      input,
      { stage, code, reason, size, sha256: hash, scan, id, startedAt: started },
      deps,
    );

  // Oversize first: never write more than the cap to disk.
  if (size > ATTACHMENT_MAX_BYTES) {
    return refused("policy", "too_large", "the file is larger than 20 MB");
  }
  const qdir = quarantineDir(input.project.id, deps.home);
  fs.mkdirSync(qdir, { recursive: true, mode: 0o700 });
  const qfile = path.join(qdir, `${id}.quarantine`);
  fs.writeFileSync(qfile, input.bytes, { flag: "wx", mode: 0o600 });
  try {
    const policy = await checkAttachmentPolicy(input.name, input.bytes);
    if (!policy.ok) {
      return refused("policy", policy.code, policy.reason);
    }
    const scanner = deps.scanner ?? resolveScanner(cfg.scanner);
    const scan = await scanWithDeadline(scanner, qfile, cfg.scanTimeoutMs);
    if (scan.verdict === "infected") {
      return refused("scan", "infected", "the malware scanner found a threat", scan);
    }
    if (scan.verdict === "error") {
      return refused("scan", "scan_failed", scan.detail ?? "the scan did not complete", scan);
    }
    if (scan.verdict === "unscanned" && cfg.requireScan) {
      return refused(
        "scan",
        "unscanned",
        "no malware scanner is available and security.attachments.requireScan is on",
        scan,
      );
    }
    // The quarantined bytes are what was checked; make sure they are still those bytes.
    if (sha256(fs.readFileSync(qfile)) !== hash) {
      return refused("store", "store_failed", "the quarantined file changed during the scan", scan);
    }
    let rel: string;
    try {
      rel = storeAccepted(input.project, qfile, input.name, hash, now(), input.folder);
    } catch (err) {
      const code = err instanceof StoreRefused ? err.code : "store_failed";
      return refused(
        "store",
        code,
        err instanceof StoreRefused ? err.message : "the file could not be stored",
        scan,
      );
    }
    const stored = path.join(fs.realpathSync(input.project.folder), rel);
    const extracted = await extractTextIsolated(policy.kind, stored, {
      timeoutMs: cfg.extractTimeoutMs,
      maxOldSpaceMb: cfg.extractMaxOldSpaceMb,
      ...deps.extract,
    });
    void auditSafe({
      identity: input.actor,
      scope: input.project.id,
      action: "attachment.intake",
      outcome: "ok",
      source: "security.attachments",
      detail: {
        projectId: input.project.id,
        connector: input.connector,
        messageId: input.messageId,
        attachmentId: input.attachmentId,
        intakeId: id,
        ...(input.run ? { routineId: input.run.routineId, runId: input.run.runId } : {}),
        sha256: hash,
        size,
        kind: policy.kind,
        verdict: scan.verdict,
        scanner: scan.scanner,
        extracted: extracted.ok ? "ok" : extracted.code,
      },
    });
    return {
      status: "accepted",
      path: rel,
      kind: policy.kind,
      sha256: hash,
      size,
      scanner: scan.scanner,
      verdict: scan.verdict === "clean" ? "clean" : "unscanned",
      text: extracted.ok ? extracted.text.slice(0, MAX_TEXT_CHARS) : null,
      textError: extracted.ok ? null : extracted.error,
    };
  } finally {
    fs.rmSync(qfile, { force: true });
  }
}
