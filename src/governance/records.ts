// What each data class is on disk, as records the sweeper, holds, exports and data subject
// requests can reason about. Every collector is deterministic (directory order is sorted) and
// read-only; `apply` deletes or anonymizes one record.
import { createHmac } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GovernanceDataClass } from "../config/types.governance.js";
import type { DataRef } from "./holds.js";
import { updateSessionStore } from "../config/sessions/store.js";
import { isSafeJobId, MANIFEST_FILE, readManifestFile, EVENTS_FILE } from "../evidence/store.js";
import { TOMBSTONE_FILE, tombstoneBundleDir, tombstoneJobEvidence } from "../evidence/tombstone.js";
import { parseProjectSessionKey } from "../projects/scope.js";
import { loadProjects, projectDataDir } from "../projects/store.js";
import { INBOX_ATTACHMENTS_DIR } from "../security/attachment-intake.js";
import { listEvidenceBundles, evidenceBundleDir } from "../workitems/evidence.js";
import {
  isWorkItemId,
  removeWorkItemFiles,
  withItemLock,
  workItemsRoot,
  writeWorkItem,
} from "../workitems/store.js";
import { TERMINAL_STATUSES, type WorkItem } from "../workitems/types.js";
import { personalDataKey } from "./store.js";

export type ApplyMode = "delete" | "anonymize";

export type ApplyContext = {
  home: string;
  now: Date;
  /** Deletion manifest id that will list this record. */
  manifestId: string | null;
  /** `retention` | `dsr`. */
  cause: string;
  /** Stable pseudonym for an identity (`anon:<hmac>`). */
  pseudonym: (identity: string) => string;
};

export type GovRecord = DataRef & {
  /** When the record last changed (retention age). */
  at: string;
  /** Absolute path (for exports and reports; never written to audit). */
  path: string;
  /** Short label for reports (no content). */
  label: string;
  apply?: (mode: ApplyMode, ctx: ApplyContext) => Promise<void> | void;
};

export function pseudonymizer(home: string): (identity: string) => string {
  const key = personalDataKey(home);
  return (identity: string) =>
    `anon:${createHmac("sha256", key).update(`person:${identity}`).digest("hex").slice(0, 12)}`;
}

function sortedDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).toSorted();
  } catch {
    return [];
  }
}

function mtimeIso(file: string): string | null {
  try {
    return new Date(fs.statSync(file).mtimeMs).toISOString();
  } catch {
    return null;
  }
}

function walkFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 6) {
    return out;
  }
  for (const name of sortedDir(dir)) {
    const p = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkFiles(p, out, depth + 1);
    } else if (st.isFile()) {
      out.push(p);
    }
  }
  return out;
}

function uniq(list: Array<string | null | undefined>): string[] {
  return [...new Set(list.filter((v): v is string => typeof v === "string" && v.length > 0))];
}

// ── transcripts ─────────────────────────────────────────────────────────────────────────────

type StoreEntry = { sessionId?: string; sessionFile?: string; updatedAt?: number };

/** First `timestamp` in a transcript's first lines (its start), when recorded. */
function transcriptStart(file: string): string | null {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(8192);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.subarray(0, n).toString("utf8").split("\n").slice(0, 5)) {
        try {
          const ts = (JSON.parse(line) as { timestamp?: unknown }).timestamp;
          if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) {
            return new Date(Date.parse(ts)).toISOString();
          }
        } catch {
          // partial line
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
  return null;
}

const KEEP_KEYS = new Set([
  "role",
  "type",
  "id",
  "timestamp",
  "toolCallId",
  "toolName",
  "name",
  "model",
  "provider",
  "api",
  "stopReason",
  "parentId",
]);

function anonymizeValue(v: unknown, key = ""): unknown {
  if (typeof v === "string") {
    return KEEP_KEYS.has(key) ? v : "[anonymized]";
  }
  if (Array.isArray(v)) {
    return v.map((x) => anonymizeValue(x, key));
  }
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, anonymizeValue(x, k)]),
    );
  }
  return v;
}

/** Keep every line, its type, ids, roles and times; replace message text and tool payloads. */
export function anonymizeTranscriptText(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) {
        return line;
      }
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        for (const k of ["message", "content", "summary", "text", "data"]) {
          if (k in rec) {
            rec[k] = anonymizeValue(rec[k], k);
          }
        }
        return JSON.stringify(rec);
      } catch {
        return JSON.stringify({ type: "anonymized" });
      }
    })
    .join("\n");
}

export function collectTranscripts(home: string): GovRecord[] {
  const out: GovRecord[] = [];
  const agentsDir = path.join(home, "agents");
  for (const agent of sortedDir(agentsDir)) {
    const sessionsDir = path.join(agentsDir, agent, "sessions");
    const storePath = path.join(sessionsDir, "sessions.json");
    let store: Record<string, StoreEntry>;
    try {
      store = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, StoreEntry>;
    } catch {
      continue;
    }
    for (const key of Object.keys(store).toSorted()) {
      const entry = store[key];
      const file = entry?.sessionFile
        ? path.resolve(sessionsDir, entry.sessionFile)
        : entry?.sessionId
          ? path.join(sessionsDir, `${entry.sessionId}.jsonl`)
          : null;
      if (!file || !file.startsWith(sessionsDir + path.sep)) {
        continue;
      }
      const at = mtimeIso(file);
      if (!at) {
        continue;
      }
      const project = parseProjectSessionKey(key);
      out.push({
        class: "transcripts",
        id: `${agent}:${path.basename(file)}`,
        label: `${agent} session ${path.basename(file)}`,
        projectId: project?.projectId ?? null,
        workItemId: null,
        custodians: [agent],
        from: transcriptStart(file) ?? at,
        to: at,
        at,
        path: file,
        apply: async (mode) => {
          if (mode === "anonymize") {
            const text = fs.readFileSync(file, "utf8");
            fs.writeFileSync(file, anonymizeTranscriptText(text), { mode: 0o600 });
            return;
          }
          fs.rmSync(file, { force: true });
          await updateSessionStore(storePath, (s) => {
            delete s[key];
          });
        },
      });
    }
  }
  return out;
}

// ── work items and their evidence ───────────────────────────────────────────────────────────

function itemPersons(item: WorkItem): string[] {
  return uniq([
    item.createdBy,
    item.requestedBy,
    item.assignee?.id,
    ...item.approvals.map((a) => (a as { by?: string }).by),
    ...item.history.map((h) => h.by),
    ...(item.flagClearances ?? []).map((c) => c.by),
    item.source.origin?.from,
  ]);
}

/** Replace personal and free-text content; keep ids, statuses, dates, counts and evidence refs. */
export function anonymizeWorkItem(
  item: WorkItem,
  pseudonym: (s: string) => string,
  now: Date = new Date(),
): WorkItem {
  const p = (s: string) => (s.startsWith("anon:") ? s : pseudonym(s));
  const next = structuredClone(item);
  next.title = "[anonymized]";
  delete next.summary;
  delete next.flagReason;
  next.createdBy = p(item.createdBy);
  next.requestedBy = p(item.requestedBy);
  if (next.assignee?.kind === "person") {
    next.assignee = { kind: "person", id: p(next.assignee.id) };
  }
  next.source = {
    documents: item.source.documents.map((d) => ({
      ...d,
      name: "[anonymized]",
      ref: "[anonymized]",
    })),
    fields: Object.fromEntries(Object.keys(item.source.fields).map((k) => [k, null])),
    ...(item.source.origin
      ? {
          origin: {
            kind: item.source.origin.kind,
            connector: item.source.origin.connector,
            messageId: "[anonymized]",
            ...(item.source.origin.receivedAt ? { receivedAt: item.source.origin.receivedAt } : {}),
          },
        }
      : {}),
  };
  next.approvals = item.approvals.map((a) => {
    const row = { ...(a as Record<string, unknown>) };
    if (typeof row.by === "string") {
      row.by = p(row.by);
    }
    if (typeof row.comment === "string") {
      row.comment = "[anonymized]";
    }
    return row as unknown as (typeof item.approvals)[number];
  });
  next.history = item.history.map((h) => ({
    ...h,
    by: h.actorKind === "person" ? p(h.by) : h.by,
    ...(h.comment ? { comment: "[anonymized]" } : {}),
    ...(h.detail ? { detail: {} } : {}),
  }));
  if (next.flagClearances) {
    next.flagClearances = next.flagClearances.map((c) => ({
      ...c,
      by: p(c.by),
      reason: "[anonymized]",
    }));
  }
  next.lastError = null;
  (next as WorkItem & { anonymizedAt?: string }).anonymizedAt = now.toISOString();
  return next;
}

function readItemFile(dir: string): WorkItem | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "item.json"), "utf8")) as WorkItem;
  } catch {
    return null;
  }
}

export const DELETED_ITEM_FILE = "deleted.json";
const KEEP_ON_DELETE: ReadonlySet<string> = new Set(["evidence", ".lock"]);

export function collectWorkItems(home: string, projectIds: string[]): GovRecord[] {
  const out: GovRecord[] = [];
  for (const projectId of projectIds) {
    const root = workItemsRoot(projectId, home);
    for (const id of sortedDir(root).filter(isWorkItemId)) {
      const dir = path.join(root, id);
      const item = readItemFile(dir);
      if (!item || item.projectId !== projectId || item.id !== id) {
        continue;
      }
      const persons = itemPersons(item);
      const rec: GovRecord = {
        class: "workitems",
        id: `${projectId}/${id}`,
        label: `work item ${id}`,
        projectId,
        workItemId: id,
        persons,
        custodians: uniq([item.createdBy, item.requestedBy]),
        from: item.createdAt,
        to: item.updatedAt,
        at: item.updatedAt,
        path: dir,
      };
      // Only closed items expire; an open item is live business.
      if (TERMINAL_STATUSES.has(item.status)) {
        rec.apply = (mode, ctx) =>
          withItemLock(dir, () => {
            const cur = readItemFile(dir);
            if (!cur) {
              return;
            }
            if (mode === "anonymize") {
              const next = anonymizeWorkItem(cur, ctx.pseudonym, ctx.now);
              next.revision = cur.revision + 1;
              writeWorkItem(next, home);
              return;
            }
            // Delete everything but the evidence (governed by its own class, tombstoned there).
            removeWorkItemFiles(projectId, id, KEEP_ON_DELETE, home);
            fs.writeFileSync(
              path.join(dir, DELETED_ITEM_FILE),
              `${JSON.stringify({ id, projectId, deletedAt: ctx.now.toISOString(), cause: ctx.cause, deletionManifest: ctx.manifestId }, null, 2)}\n`,
              { mode: 0o600 },
            );
          });
      }
      out.push(rec);
    }
  }
  return out;
}

export function collectEvidence(home: string, projectIds: string[]): GovRecord[] {
  const out: GovRecord[] = [];
  // Job evidence. `gov-*` bundles are deletion manifests and export records: never expired.
  const root = path.join(home, "evidence");
  for (const jobId of sortedDir(root)) {
    if (!isSafeJobId(jobId) || jobId.startsWith("gov-")) {
      continue;
    }
    const dir = path.join(root, jobId);
    const manifest = readManifestFile(path.join(dir, MANIFEST_FILE));
    if (!manifest) {
      continue; // running, or never sealed: seal.ts closes it first
    }
    let projectId: string | null = parseProjectSessionKey(manifest.sessionKey)?.projectId ?? null;
    try {
      const first = fs.readFileSync(path.join(dir, EVENTS_FILE), "utf8").split("\n", 1)[0];
      const pid = (JSON.parse(first) as { data?: { projectId?: unknown } }).data?.projectId;
      if (typeof pid === "string") {
        projectId = pid;
      }
    } catch {
      // manifest is enough
    }
    out.push({
      class: "evidence",
      id: `job:${jobId}`,
      label: `job evidence ${jobId}`,
      projectId,
      workItemId: null,
      custodians: uniq([manifest.agent]),
      from: manifest.startedAt,
      to: manifest.endedAt,
      at: manifest.endedAt,
      path: dir,
      apply: (_mode, ctx) => {
        tombstoneJobEvidence({
          stateDir: home,
          jobId,
          cause: ctx.cause,
          deletionManifest: ctx.manifestId,
          now: ctx.now,
        });
      },
    });
  }
  // Work item transition bundles, for closed or deleted items only.
  for (const projectId of projectIds) {
    const itemsRoot = workItemsRoot(projectId, home);
    for (const id of sortedDir(itemsRoot).filter(isWorkItemId)) {
      const dir = path.join(itemsRoot, id);
      const item = readItemFile(dir);
      const closed = item
        ? TERMINAL_STATUSES.has(item.status)
        : fs.existsSync(path.join(dir, DELETED_ITEM_FILE));
      if (!closed) {
        continue;
      }
      const ref = { projectId, id };
      for (const bundle of listEvidenceBundles(ref, home)) {
        const bdir = evidenceBundleDir(ref, bundle, home);
        if (
          fs.existsSync(path.join(bdir, TOMBSTONE_FILE)) &&
          !fs.existsSync(path.join(bdir, MANIFEST_FILE))
        ) {
          continue;
        }
        const manifest = readManifestFile(path.join(bdir, MANIFEST_FILE));
        if (!manifest) {
          continue;
        }
        out.push({
          class: "evidence",
          id: `workitem:${projectId}/${id}/${bundle}`,
          label: `work item ${id} evidence ${bundle}`,
          projectId,
          workItemId: id,
          persons: uniq([manifest.agent]),
          custodians: uniq([manifest.agent]),
          from: manifest.startedAt,
          to: manifest.endedAt,
          at: manifest.endedAt,
          path: bdir,
          apply: (_mode, ctx) => {
            tombstoneBundleDir({
              stateDir: home,
              dir: bdir,
              jobId: manifest.jobId,
              bundle,
              workItemId: id,
              cause: ctx.cause,
              deletionManifest: ctx.manifestId,
              now: ctx.now,
            });
          },
        });
      }
    }
  }
  return out;
}

// ── files: attachments, outputs, connector caches ───────────────────────────────────────────

function fileRecords(
  cls: GovernanceDataClass,
  files: string[],
  meta: {
    projectId: string | null | undefined;
    custodians?: string[];
    base: string;
    /** The work item a file belongs to (null: none; undefined: unknown). */
    itemOf?: (file: string) => string | null | undefined;
  },
): GovRecord[] {
  return files.flatMap((file) => {
    const at = mtimeIso(file);
    if (!at) {
      return [];
    }
    return [
      {
        class: cls,
        id: `${meta.projectId ?? "-"}:${path.relative(meta.base, file).split(path.sep).join("/")}`,
        label: `${cls} file`,
        projectId: meta.projectId,
        workItemId: meta.itemOf ? meta.itemOf(file) : undefined,
        custodians: meta.custodians,
        from: at,
        to: at,
        at,
        path: file,
        apply: () => {
          fs.rmSync(file, { force: true });
        },
      } satisfies GovRecord,
    ];
  });
}

export function collectAttachments(
  home: string,
  projects: Array<{ id: string; folder: string }>,
): GovRecord[] {
  const out: GovRecord[] = [];
  for (const p of projects) {
    const dataRoot = projectDataDir(p.id, home);
    // Which item names a file as a source document (attachment: data-area path; file: folder path).
    const owner = new Map<string, string>();
    for (const id of sortedDir(workItemsRoot(p.id, home)).filter(isWorkItemId)) {
      const item = readItemFile(path.join(workItemsRoot(p.id, home), id));
      for (const d of item?.source?.documents ?? []) {
        const base = d.kind === "attachment" ? dataRoot : d.kind === "file" ? p.folder : null;
        if (base && typeof d.ref === "string") {
          owner.set(path.resolve(base, d.ref), id);
          owner.set(path.resolve(base, "attachments", d.ref), id);
        }
      }
    }
    const itemOf = (file: string) => owner.get(path.resolve(file)) ?? null;
    const data = path.join(dataRoot, "attachments");
    out.push(
      ...fileRecords("attachments", walkFiles(data), { projectId: p.id, base: data, itemOf }),
    );
    const inbox = path.join(p.folder, INBOX_ATTACHMENTS_DIR);
    out.push(
      ...fileRecords("attachments", walkFiles(inbox), { projectId: p.id, base: inbox, itemOf }),
    );
  }
  const scratch = path.join(home, "scratch");
  for (const user of sortedDir(scratch)) {
    const dir = path.join(scratch, user, "attachments");
    out.push(
      ...fileRecords("attachments", walkFiles(dir), {
        projectId: null,
        custodians: [user],
        base: dir,
      }),
    );
  }
  return out;
}

type ArtifactMeta = {
  id: string;
  projectId: string | null;
  updatedAt: string;
  createdAt: string;
  versions?: Array<{ createdByUser?: string; createdByAgent?: string | null }>;
};

export function collectOutputs(home: string, projectIds: string[] = []): GovRecord[] {
  const out: GovRecord[] = [];
  // Work items whose draft or source documents name an artifact.
  const owner = new Map<string, string>();
  for (const projectId of projectIds) {
    const itemsRoot = workItemsRoot(projectId, home);
    for (const id of sortedDir(itemsRoot).filter(isWorkItemId)) {
      const item = readItemFile(path.join(itemsRoot, id));
      if (item?.draft?.artifactId) {
        owner.set(item.draft.artifactId, id);
      }
      for (const d of item?.source?.documents ?? []) {
        if (d.kind === "artifact" && typeof d.ref === "string") {
          owner.set(d.ref, id);
        }
      }
    }
  }
  const root = path.join(home, "artifacts");
  for (const id of sortedDir(root)) {
    if (!/^a[a-z0-9]{12}$/.test(id)) {
      continue;
    }
    const dir = path.join(root, id);
    let meta: ArtifactMeta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")) as ArtifactMeta;
    } catch {
      continue;
    }
    const people = uniq((meta.versions ?? []).map((v) => v.createdByUser));
    out.push({
      class: "outputs",
      id: `artifact:${id}`,
      label: `artifact ${id}`,
      projectId: meta.projectId ?? null,
      workItemId: owner.get(id) ?? null,
      persons: people,
      custodians: uniq([...people, ...(meta.versions ?? []).map((v) => v.createdByAgent)]),
      from: meta.createdAt,
      to: meta.updatedAt,
      at: meta.updatedAt,
      path: dir,
      apply: () => {
        fs.rmSync(dir, { recursive: true, force: true });
      },
    });
  }
  return out;
}

export function collectConnectorCaches(home: string): GovRecord[] {
  const out: GovRecord[] = [];
  const root = path.join(home, "connectors");
  for (const connector of sortedDir(root)) {
    const dir = path.join(root, connector, "cache");
    out.push(
      // A cache is not attributed to a Project: any Project hold keeps it (fail closed).
      ...fileRecords("connectorCaches", walkFiles(dir), {
        projectId: undefined,
        custodians: [connector],
        base: dir,
        itemOf: () => null,
      }),
    );
  }
  return out;
}

// ── memory (provenance sidecar and quarantine) ──────────────────────────────────────────────

type QuarantineFile = {
  id: string;
  createdAt: string;
  status: string;
  decidedAt?: string;
  provenance?: { sessionKey?: string | null; agentId?: string };
  op?: Record<string, unknown>;
  note?: string;
};

export function collectMemory(home: string): GovRecord[] {
  const out: GovRecord[] = [];
  const root = path.join(home, "memory-provenance");
  for (const agent of sortedDir(root)) {
    const qdir = path.join(root, agent, "quarantine");
    for (const name of sortedDir(qdir).filter((n) => n.endsWith(".json"))) {
      const file = path.join(qdir, name);
      let entry: QuarantineFile;
      try {
        entry = JSON.parse(fs.readFileSync(file, "utf8")) as QuarantineFile;
      } catch {
        continue;
      }
      if (entry.status === "pending") {
        continue; // waiting for a person
      }
      const at = entry.decidedAt ?? entry.createdAt;
      out.push({
        class: "memory",
        id: `quarantine:${agent}/${entry.id}`,
        label: `memory quarantine entry ${entry.id}`,
        projectId: parseProjectSessionKey(entry.provenance?.sessionKey ?? null)?.projectId ?? null,
        workItemId: null,
        custodians: [agent],
        from: entry.createdAt,
        to: at,
        at,
        path: file,
        apply: (mode) => {
          if (mode === "anonymize") {
            const next = { ...entry, op: anonymizeValue(entry.op, "op"), note: undefined };
            fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
            return;
          }
          fs.rmSync(file, { force: true });
        },
      });
    }
  }
  return out;
}

export type CollectOptions = {
  home: string;
  classes?: ReadonlySet<GovernanceDataClass>;
};

/** Every record of the requested classes (audit is month-based and handled by the sweeper). */
export function collectRecords(opts: CollectOptions): GovRecord[] {
  const want = (c: GovernanceDataClass) => !opts.classes || opts.classes.has(c);
  const projects = loadProjects(opts.home).map((p) => ({ id: p.id, folder: p.folder }));
  const ids = projects.map((p) => p.id);
  return [
    ...(want("transcripts") ? collectTranscripts(opts.home) : []),
    ...(want("workitems") ? collectWorkItems(opts.home, ids) : []),
    ...(want("evidence") ? collectEvidence(opts.home, ids) : []),
    ...(want("attachments") ? collectAttachments(opts.home, projects) : []),
    ...(want("outputs") ? collectOutputs(opts.home, ids) : []),
    ...(want("memory") ? collectMemory(opts.home) : []),
    ...(want("connectorCaches") ? collectConnectorCaches(opts.home) : []),
  ];
}
