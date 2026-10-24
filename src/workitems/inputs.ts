// Input cleaning for work items: titles, form fields, source documents (which must point
// inside the project), enums, due dates, person assignees and queues.

import fs from "node:fs";
import path from "node:path";
import type { Project } from "../projects/types.js";
import type { WorkQueuePolicy } from "./policy.js";
import type { WorkItemAssignee, WorkItemSource, WorkItemSourceDocument } from "./types.js";
import { getArtifact } from "../projects/artifacts.js";
import { cleanRelPath, projectDataDir } from "../projects/store.js";

const QUEUE_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const MAX_FIELDS = 64;
const MAX_DOCS = 32;

export function cleanTitle(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("title is required");
  }
  return raw.trim().slice(0, 200);
}

export function cleanFields(raw: unknown): WorkItemSource["fields"] {
  if (raw === undefined || raw === null) {
    return {};
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("source.fields must be an object");
  }
  const out: WorkItemSource["fields"] = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, MAX_FIELDS)) {
    if (!FIELD_RE.test(k)) {
      throw new Error(`source.fields: invalid field name ${k}`);
    }
    if (typeof v === "string") {
      out[k] = v.slice(0, 4000);
    } else if (typeof v === "number" && Number.isFinite(v)) {
      out[k] = v;
    } else if (typeof v === "boolean" || v === null) {
      out[k] = v;
    } else {
      throw new Error(`source.fields.${k} must be a string, number, boolean or null`);
    }
  }
  return out;
}

/** Source documents must point inside the project: its attachments, its folder, or an artifact. */
export function cleanDocuments(
  raw: unknown,
  project: Pick<Project, "id" | "folder">,
  home: string,
): WorkItemSourceDocument[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new Error("source.documents must be an array");
  }
  return raw.slice(0, MAX_DOCS).map((d, i) => {
    const r = (d ?? {}) as Record<string, unknown>;
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 200) : "";
    const ref = typeof r.ref === "string" ? r.ref.trim() : "";
    const sha =
      typeof r.sha256 === "string" && /^[a-f0-9]{64}$/.test(r.sha256) ? r.sha256 : undefined;
    if (r.kind === "artifact") {
      const a = getArtifact(ref, null, { home }).artifact;
      if (a.projectId !== project.id) {
        throw new Error(`source.documents[${i}]: artifact is not in this project`);
      }
      return { kind: "artifact", ref, name: name || a.title, ...(sha ? { sha256: sha } : {}) };
    }
    if (r.kind === "attachment") {
      const base = fs.realpathSync(path.join(projectDataDir(project.id, home), "attachments"));
      let real: string;
      try {
        real = fs.realpathSync(ref);
      } catch {
        throw new Error(`source.documents[${i}]: attachment not found`);
      }
      if (!real.startsWith(`${base}${path.sep}`)) {
        throw new Error(`source.documents[${i}]: attachment is not in this project`);
      }
      return {
        kind: "attachment",
        ref: real,
        name: name || path.basename(real),
        ...(sha ? { sha256: sha } : {}),
      };
    }
    if (r.kind === "file") {
      const rel = cleanRelPath(ref);
      if (!rel || rel === ".") {
        throw new Error(`source.documents[${i}]: file must be a project-relative path`);
      }
      if (!fs.existsSync(path.join(project.folder, rel))) {
        throw new Error(`source.documents[${i}]: file not found in the project folder`);
      }
      return {
        kind: "file",
        ref: rel,
        name: name || path.basename(rel),
        ...(sha ? { sha256: sha } : {}),
      };
    }
    throw new Error(`source.documents[${i}]: kind must be attachment, file or artifact`);
  });
}

export function cleanEnum<T extends string>(raw: unknown, list: readonly T[], what: string): T {
  if (typeof raw !== "string" || !(list as readonly string[]).includes(raw)) {
    throw new Error(`${what} must be one of ${list.join(", ")}`);
  }
  return raw as T;
}

export function cleanDueAt(raw: unknown): string | null {
  if (raw === null) {
    return null;
  }
  if (typeof raw !== "string" || Number.isNaN(Date.parse(raw))) {
    throw new Error("dueAt must be an ISO date-time");
  }
  return new Date(raw).toISOString();
}

export function cleanPersonAssignee(raw: unknown): WorkItemAssignee {
  if (raw === null) {
    return null;
  }
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.kind !== "person") {
    throw new Error("assignee.kind must be person (use workitems.assignAgent for agents)");
  }
  if (typeof r.id !== "string" || !r.id.trim()) {
    throw new Error("assignee.id is required");
  }
  return { kind: "person", id: r.id.trim().slice(0, 128) };
}

export function resolveQueue(policy: WorkQueuePolicy, raw: unknown) {
  if (typeof raw !== "string" || !QUEUE_RE.test(raw)) {
    throw new Error("queue is required");
  }
  if (policy.queues.length > 0 && !policy.queues.some((q) => q.id === raw)) {
    throw new Error(`queue ${raw} is not defined in this project's work queue policy`);
  }
  return { id: raw, def: policy.queues.find((q) => q.id === raw) ?? null };
}
