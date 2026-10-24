// Artifacts (成果物): documents, tables and drafts saved from a chat, with versions, a SHA-256
// per version, and a review status 下書き (draft) → 確認中 (review) → 承認済み (approved).
// Stored under `<KOLO_HOME>/artifacts/<id>/` as meta.json plus one file per version.

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveKoloHome } from "../config/kolo-home.js";
import { getProject, isProjectId } from "./store.js";

export type ArtifactStatus = "draft" | "review" | "approved";
export type ArtifactType = "document" | "table" | "draft" | "code" | "other";
export type ArtifactFormat = "md" | "txt" | "csv" | "json";

export type ArtifactVersion = {
  version: number;
  sha256: string;
  size: number;
  createdAt: string;
  createdByUser: string;
  createdByAgent: string | null;
  sourceSession: string | null;
  note: string | null;
};

export type ArtifactEvent = {
  at: string;
  by: string;
  action: "created" | "version" | "status";
  from?: ArtifactStatus;
  to?: ArtifactStatus;
  version?: number;
  note?: string | null;
};

export type Artifact = {
  id: string;
  title: string;
  type: ArtifactType;
  format: ArtifactFormat;
  projectId: string | null;
  status: ArtifactStatus;
  versions: ArtifactVersion[];
  history: ArtifactEvent[];
  createdAt: string;
  updatedAt: string;
};

export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const TYPES = new Set<string>(["document", "table", "draft", "code", "other"]);
const FORMATS = new Set<string>(["md", "txt", "csv", "json"]);
const ID_RE = /^a[a-z0-9]{12}$/;

/** Allowed status changes. Approved artifacts change only by saving a new version. */
const TRANSITIONS: Record<ArtifactStatus, ArtifactStatus[]> = {
  draft: ["review"],
  review: ["approved", "draft"],
  approved: [],
};

export function artifactsRoot(home: string = resolveKoloHome()): string {
  return path.join(home, "artifacts");
}

function dirOf(id: string, home: string): string {
  if (!ID_RE.test(id)) {
    throw new Error("invalid artifact id");
  }
  return path.join(artifactsRoot(home), id);
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readMeta(id: string, home: string): Artifact {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id, home), "meta.json"), "utf8")) as Artifact;
  } catch {
    throw new Error("artifact not found");
  }
}

function writeMeta(a: Artifact, home: string): void {
  writeAtomic(path.join(dirOf(a.id, home), "meta.json"), `${JSON.stringify(a, null, 2)}\n`);
}

function cleanContent(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new Error("content is required");
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_ARTIFACT_BYTES) {
    throw new Error("content is larger than 2 MB");
  }
  return raw;
}

function cleanOptional(raw: unknown, max: number): string | null {
  return typeof raw === "string" && raw.trim() ? raw.trim().slice(0, max) : null;
}

export type SaveInput = {
  title?: unknown;
  type?: unknown;
  format?: unknown;
  content?: unknown;
  projectId?: unknown;
  sourceSession?: unknown;
  agentId?: unknown;
  note?: unknown;
};

/** Save a new artifact as version 1 (status 下書き / draft). */
export function saveArtifact(
  input: SaveInput,
  user: string,
  opts: { home?: string; now?: Date } = {},
): Artifact {
  const home = opts.home ?? resolveKoloHome();
  const title = cleanOptional(input.title, 200);
  if (!title) {
    throw new Error("title is required");
  }
  const content = cleanContent(input.content);
  let projectId: string | null = null;
  if (input.projectId) {
    if (!isProjectId(input.projectId) || !getProject(input.projectId, home)) {
      throw new Error("project not found");
    }
    projectId = input.projectId;
  }
  const now = (opts.now ?? new Date()).toISOString();
  const id = `a${randomBytes(9).toString("hex").slice(0, 12)}`;
  const version: ArtifactVersion = {
    version: 1,
    sha256: sha256Hex(content),
    size: Buffer.byteLength(content, "utf8"),
    createdAt: now,
    createdByUser: user,
    createdByAgent: cleanOptional(input.agentId, 64),
    sourceSession: cleanOptional(input.sourceSession, 256),
    note: cleanOptional(input.note, 500),
  };
  const artifact: Artifact = {
    id,
    title,
    type:
      typeof input.type === "string" && TYPES.has(input.type)
        ? (input.type as ArtifactType)
        : "document",
    format:
      typeof input.format === "string" && FORMATS.has(input.format)
        ? (input.format as ArtifactFormat)
        : "md",
    projectId,
    status: "draft",
    versions: [version],
    history: [{ at: now, by: user, action: "created", version: 1 }],
    createdAt: now,
    updatedAt: now,
  };
  fs.mkdirSync(dirOf(id, home), { recursive: true, mode: 0o700 });
  writeAtomic(path.join(dirOf(id, home), `v1.${artifact.format}`), content);
  writeMeta(artifact, home);
  return artifact;
}

/** Add a version. An artifact in review or approved goes back to draft. */
export function addArtifactVersion(
  input: {
    id?: unknown;
    content?: unknown;
    agentId?: unknown;
    sourceSession?: unknown;
    note?: unknown;
  },
  user: string,
  opts: { home?: string; now?: Date } = {},
): Artifact {
  const home = opts.home ?? resolveKoloHome();
  const a = readMeta(typeof input.id === "string" ? input.id : "", home);
  const content = cleanContent(input.content);
  const sha = sha256Hex(content);
  const last = a.versions[a.versions.length - 1];
  if (last && last.sha256 === sha) {
    throw new Error("this content is identical to the latest version");
  }
  const now = (opts.now ?? new Date()).toISOString();
  const n = (last?.version ?? 0) + 1;
  a.versions.push({
    version: n,
    sha256: sha,
    size: Buffer.byteLength(content, "utf8"),
    createdAt: now,
    createdByUser: user,
    createdByAgent: cleanOptional(input.agentId, 64),
    sourceSession: cleanOptional(input.sourceSession, 256),
    note: cleanOptional(input.note, 500),
  });
  a.history.push({ at: now, by: user, action: "version", version: n });
  if (a.status !== "draft") {
    a.history.push({
      at: now,
      by: user,
      action: "status",
      from: a.status,
      to: "draft",
      version: n,
    });
    a.status = "draft";
  }
  a.updatedAt = now;
  writeAtomic(path.join(dirOf(a.id, home), `v${n}.${a.format}`), content);
  writeMeta(a, home);
  return a;
}

/**
 * Identities are "known" when they name a specific device or paired credential. The shared
 * owner token without a device key is not a person, so two of those cannot be told apart.
 */
export function isKnownIdentity(user: string): boolean {
  return /^(device|pair):/.test(user);
}

export function setArtifactStatus(
  input: { id?: unknown; status?: unknown; note?: unknown },
  user: string,
  opts: { home?: string; now?: Date } = {},
): Artifact {
  const home = opts.home ?? resolveKoloHome();
  const a = readMeta(typeof input.id === "string" ? input.id : "", home);
  const to = input.status as ArtifactStatus;
  if (!TRANSITIONS[a.status]?.includes(to)) {
    throw new Error(`cannot change status from ${a.status} to ${String(input.status)}`);
  }
  if (to === "approved") {
    const author = a.versions[a.versions.length - 1]?.createdByUser ?? "";
    if (isKnownIdentity(author) && isKnownIdentity(user) && author === user) {
      throw new Error("approval needs a different user than the author of this version");
    }
  }
  const now = (opts.now ?? new Date()).toISOString();
  a.history.push({
    at: now,
    by: user,
    action: "status",
    from: a.status,
    to,
    version: a.versions[a.versions.length - 1]?.version,
    note: cleanOptional(input.note, 500),
  });
  a.status = to;
  a.updatedAt = now;
  writeMeta(a, home);
  return a;
}

export function getArtifact(
  id: string,
  version: number | null,
  opts: { home?: string } = {},
): { artifact: Artifact; content: string; version: number } {
  const home = opts.home ?? resolveKoloHome();
  const a = readMeta(id, home);
  const v = version ?? a.versions[a.versions.length - 1]?.version ?? 1;
  const entry = a.versions.find((x) => x.version === v);
  if (!entry) {
    throw new Error("version not found");
  }
  const content = fs.readFileSync(path.join(dirOf(a.id, home), `v${v}.${a.format}`), "utf8");
  if (sha256Hex(content) !== entry.sha256) {
    throw new Error("stored content does not match its SHA-256");
  }
  return { artifact: a, content, version: v };
}

export function listArtifacts(
  filter: { projectId?: unknown; status?: unknown } = {},
  opts: { home?: string } = {},
): Artifact[] {
  const home = opts.home ?? resolveKoloHome();
  let ids: string[];
  try {
    ids = fs.readdirSync(artifactsRoot(home)).filter((n) => ID_RE.test(n));
  } catch {
    return [];
  }
  const out: Artifact[] = [];
  for (const id of ids) {
    try {
      const a = readMeta(id, home);
      if (filter.projectId && a.projectId !== filter.projectId) {
        continue;
      }
      if (filter.status && a.status !== filter.status) {
        continue;
      }
      out.push(a);
    } catch {
      // skip unreadable entries
    }
  }
  return out.toSorted((x, y) => y.updatedAt.localeCompare(x.updatedAt));
}
