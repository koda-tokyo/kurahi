// Kurahi v0.3 gateway methods: projects, project templates, chunked document upload, artifacts
// and chat history helpers. Scopes: reads are observe, chat-side writes are attach, and project
// create / update / archive are admin (see scopes.ts and server-methods.ts).
import fs from "node:fs";
import path from "node:path";
import type { GatewayClient, GatewayRequestHandlers, RespondFn } from "./types.js";
import { auditSafe } from "../../audit/audit-log.js";
import {
  addArtifactVersion,
  getArtifact,
  listArtifacts,
  saveArtifact,
  setArtifactStatus,
} from "../../projects/artifacts.js";
import { loadArchivedChats, searchChatTranscripts, setChatArchived } from "../../projects/chats.js";
import { loadProjectPack, PACK_SECTIONS, seedStarterPack } from "../../projects/pack.js";
import {
  parseProjectSessionKey,
  projectSessionKey,
  writableForMode,
} from "../../projects/scope.js";
import {
  createProject,
  EXCLUDED_DIR_NAMES,
  getProject,
  loadProjects,
  setProjectMode,
  updateProject,
} from "../../projects/store.js";
import {
  loadTemplates,
  loadTerminalProfiles,
  resolveTemplatesDir,
} from "../../projects/templates.js";
import { abortUpload, appendChunk, beginUpload, commitUpload } from "../../projects/uploads.js";
import { ErrorCodes, errorShape } from "../protocol/index.js";

/** Who is acting: a paired credential, a device key, or the shared owner token. */
export function actorOf(client: GatewayClient | null | undefined): string {
  if (client?.pairing) {
    return `pair:${client.pairing.fingerprint.slice(0, 12)}`;
  }
  const device = client?.connect?.device?.id;
  if (typeof device === "string" && device) {
    return `device:${device.slice(0, 12)}`;
  }
  return "owner";
}

function fail(respond: RespondFn, err: unknown) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.INVALID_REQUEST, err instanceof Error ? err.message : String(err)),
  );
}

type FileRow = {
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
  access: "read" | "write";
};

const MAX_FILES = 500;
const MAX_DEPTH = 4;

/** A read-only listing of a project folder (no excluded or hidden entries). */
export function listProjectFiles(folder: string, writable: string[]): FileRow[] {
  const rows: FileRow[] = [];
  const access = (rel: string): "read" | "write" =>
    writable.some((w) => w === "." || rel === w || rel.startsWith(`${w}/`)) ? "write" : "read";
  const walk = (dir: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      if (rows.length >= MAX_FILES) {
        return;
      }
      if (e.name.startsWith(".") || EXCLUDED_DIR_NAMES.includes(e.name) || e.isSymbolicLink()) {
        continue;
      }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      const full = path.join(dir, e.name);
      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch {
        continue;
      }
      rows.push({
        path: relPath,
        type: e.isDirectory() ? "dir" : "file",
        size: e.isDirectory() ? 0 : stat.size,
        mtime: stat.mtime.toISOString(),
        access: access(relPath),
      });
      if (e.isDirectory() && depth < MAX_DEPTH) {
        walk(full, relPath, depth + 1);
      }
    }
  };
  walk(folder, "", 1);
  return rows;
}

function projectOr404(id: unknown) {
  const project = typeof id === "string" ? getProject(id) : null;
  if (!project) {
    throw new Error("project not found");
  }
  return project;
}

export const projectsHandlers: GatewayRequestHandlers = {
  // ---- templates ----
  "projects.templates": ({ respond }) => {
    respond(true, { templates: loadTemplates(), terminalProfiles: loadTerminalProfiles() });
  },

  // ---- projects ----
  "projects.list": ({ params, respond }) => {
    const includeArchived = params?.includeArchived === true;
    respond(true, {
      projects: loadProjects().filter((p) => includeArchived || !p.archived),
    });
  },

  "projects.get": ({ params, respond }) => {
    try {
      respond(true, { project: projectOr404(params?.id) });
    } catch (err) {
      fail(respond, err);
    }
  },

  "projects.files": ({ params, respond }) => {
    try {
      const project = projectOr404(params?.id);
      respond(true, {
        folder: project.folder,
        files: listProjectFiles(project.folder, writableForMode(project)),
        truncatedAt: MAX_FILES,
      });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** What the engineering pack gives the agent: files, sizes, budget (not the text). */
  "projects.pack": ({ params, respond }) => {
    try {
      const project = projectOr404(params?.id);
      const { text: _text, ...pack } = loadProjectPack(project);
      respond(true, { sections: PACK_SECTIONS, ...pack });
    } catch (err) {
      fail(respond, err);
    }
  },

  "projects.create": ({ params, respond, client }) => {
    const actor = actorOf(client);
    try {
      const templateId = typeof params?.templateId === "string" ? params.templateId : null;
      const template = templateId
        ? (loadTemplates().find((t) => t.id === templateId) ?? null)
        : null;
      if (templateId && !template) {
        throw new Error("template not found");
      }
      const project = createProject(params ?? {}, { createdBy: actor, template });
      // The template's starter engineering pack goes to the project's data area, never into
      // the client's folder.
      const seeded = templateId
        ? seedStarterPack(project.id, path.join(resolveTemplatesDir(), "packs", templateId))
        : 0;
      void auditSafe({
        identity: actor,
        scope: project.id,
        action: "project.create",
        outcome: "ok",
        source: "gateway.projects",
        detail: {
          id: project.id,
          name: project.name,
          folder: project.folder,
          template: templateId,
          mode: project.mode,
          starterPackFiles: seeded,
        },
      });
      respond(true, { project });
    } catch (err) {
      fail(respond, err);
    }
  },

  "projects.update": ({ params, respond, client }) => {
    const actor = actorOf(client);
    try {
      const { id, ...patch } = params ?? {};
      const existing = projectOr404(id);
      const project = updateProject(existing.id, patch);
      void auditSafe({
        identity: actor,
        scope: project.id,
        action: "project.update",
        outcome: "ok",
        source: "gateway.projects",
        detail: { id: project.id, fields: Object.keys(patch) },
      });
      respond(true, { project });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** Permission mode 参照 / 計画 / 実行 (admin). Every change is audited. */
  "projects.setMode": ({ params, respond, client }) => {
    const actor = actorOf(client);
    try {
      const existing = projectOr404(params?.id);
      const { project, from, to } = setProjectMode(existing.id, params?.mode);
      void auditSafe({
        identity: actor,
        scope: project.id,
        action: "project.mode",
        outcome: "ok",
        source: "gateway.projects",
        detail: { id: project.id, from, to },
      });
      respond(true, { project });
    } catch (err) {
      fail(respond, err);
    }
  },

  "projects.archive": ({ params, respond, client }) => {
    const actor = actorOf(client);
    try {
      projectOr404(params?.id);
      const archived = params?.archived !== false;
      const project = updateProject(String(params?.id), { archived });
      void auditSafe({
        identity: actor,
        scope: project.id,
        action: archived ? "project.archive" : "project.unarchive",
        outcome: "ok",
        source: "gateway.projects",
        detail: { id: project.id },
      });
      respond(true, { project });
    } catch (err) {
      fail(respond, err);
    }
  },

  /** A fresh session key for a new chat in a project (checks the agent is allowed there). */
  "projects.chatKey": ({ params, respond }) => {
    try {
      const project = projectOr404(params?.id);
      const agentId =
        typeof params?.agentId === "string" && params.agentId ? params.agentId : "main";
      if (project.allowedAgents.length > 0 && !project.allowedAgents.includes(agentId)) {
        throw new Error(`agent ${agentId} is not allowed in this project`);
      }
      const chatId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      respond(true, { sessionKey: projectSessionKey(agentId, project.id, chatId) });
    } catch (err) {
      fail(respond, err);
    }
  },

  // ---- uploads ----
  "files.upload.begin": ({ params, respond, client }) => {
    try {
      respond(true, beginUpload(params ?? {}, actorOf(client)));
    } catch (err) {
      void auditSafe({
        identity: actorOf(client),
        action: "file.upload",
        outcome: "denied",
        source: "gateway.files",
        detail: {
          name: params?.name,
          size: params?.size,
          project: params?.projectId ?? null,
          error: String(err),
        },
      });
      fail(respond, err);
    }
  },

  "files.upload.chunk": ({ params, respond, client }) => {
    try {
      respond(true, appendChunk(params ?? {}, actorOf(client)));
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.upload.abort": ({ params, respond, client }) => {
    try {
      abortUpload(params?.uploadId, actorOf(client));
      respond(true, { ok: true });
    } catch (err) {
      fail(respond, err);
    }
  },

  "files.upload.commit": async ({ params, respond, client }) => {
    const actor = actorOf(client);
    try {
      const doc = await commitUpload(params ?? {}, actor);
      void auditSafe({
        identity: actor,
        scope: doc.projectId ?? "scratch",
        action: "file.upload",
        outcome: "ok",
        source: "gateway.files",
        detail: {
          name: doc.name,
          kind: doc.kind,
          size: doc.size,
          sha256: doc.sha256,
          project: doc.projectId,
          path: doc.path,
        },
      });
      respond(true, { document: doc });
    } catch (err) {
      void auditSafe({
        identity: actor,
        action: "file.upload",
        outcome: "denied",
        source: "gateway.files",
        detail: { uploadId: params?.uploadId, error: String(err) },
      });
      fail(respond, err);
    }
  },

  // ---- artifacts ----
  "artifacts.list": ({ params, respond }) => {
    respond(true, {
      artifacts: listArtifacts({ projectId: params?.projectId, status: params?.status }),
    });
  },

  "artifacts.get": ({ params, respond }) => {
    try {
      const version = typeof params?.version === "number" ? params.version : null;
      respond(true, getArtifact(typeof params?.id === "string" ? params.id : "", version));
    } catch (err) {
      fail(respond, err);
    }
  },

  "artifacts.save": ({ params, respond, client }) => {
    const actor = actorOf(client);
    try {
      const session = typeof params?.sourceSession === "string" ? params.sourceSession : null;
      const ref = parseProjectSessionKey(session);
      const agentId =
        typeof params?.agentId === "string" ? params.agentId : (session?.split(":")[1] ?? null);
      const artifact = saveArtifact(
        { ...params, projectId: params?.projectId ?? ref?.projectId ?? null, agentId },
        actor,
      );
      void auditSafe({
        identity: actor,
        scope: artifact.projectId ?? "unfiled",
        action: "artifact.save",
        outcome: "ok",
        source: "gateway.artifacts",
        detail: {
          id: artifact.id,
          title: artifact.title,
          sha256: artifact.versions[0]?.sha256,
          session,
        },
      });
      respond(true, { artifact });
    } catch (err) {
      fail(respond, err);
    }
  },

  "artifacts.version": ({ params, respond, client }) => {
    const actor = actorOf(client);
    try {
      const artifact = addArtifactVersion(params ?? {}, actor);
      const v = artifact.versions[artifact.versions.length - 1];
      void auditSafe({
        identity: actor,
        scope: artifact.projectId ?? "unfiled",
        action: "artifact.version",
        outcome: "ok",
        source: "gateway.artifacts",
        detail: { id: artifact.id, version: v?.version, sha256: v?.sha256 },
      });
      respond(true, { artifact });
    } catch (err) {
      fail(respond, err);
    }
  },

  "artifacts.setStatus": ({ params, respond, client }) => {
    const actor = actorOf(client);
    try {
      const artifact = setArtifactStatus(params ?? {}, actor);
      void auditSafe({
        identity: actor,
        scope: artifact.projectId ?? "unfiled",
        action: `artifact.${artifact.status}`,
        outcome: "ok",
        source: "gateway.artifacts",
        detail: {
          id: artifact.id,
          status: artifact.status,
          version: artifact.versions.at(-1)?.version,
        },
      });
      respond(true, { artifact });
    } catch (err) {
      void auditSafe({
        identity: actor,
        action: "artifact.status",
        outcome: "denied",
        source: "gateway.artifacts",
        detail: { id: params?.id, status: params?.status, error: String(err) },
      });
      fail(respond, err);
    }
  },

  // ---- chat history ----
  "chats.archived": ({ respond }) => {
    respond(true, { archived: loadArchivedChats() });
  },

  "chats.archive": ({ params, respond, client }) => {
    try {
      const archived = setChatArchived(params?.key, params?.archived !== false);
      void auditSafe({
        identity: actorOf(client),
        scope: typeof params?.key === "string" ? params.key : null,
        action: params?.archived === false ? "chat.unarchive" : "chat.archive",
        outcome: "ok",
        source: "gateway.chats",
      });
      respond(true, { archived });
    } catch (err) {
      fail(respond, err);
    }
  },

  "chats.search": ({ params, respond }) => {
    respond(true, { keys: searchChatTranscripts(params?.query) });
  },
};

export const PROJECT_READ_METHODS = [
  "projects.templates",
  "projects.pack",
  "projects.list",
  "projects.get",
  "projects.files",
  "artifacts.list",
  "artifacts.get",
  "chats.archived",
  "chats.search",
] as const;

export const PROJECT_WRITE_METHODS = [
  "projects.chatKey",
  "files.upload.begin",
  "files.upload.chunk",
  "files.upload.abort",
  "files.upload.commit",
  "artifacts.save",
  "artifacts.version",
  "artifacts.setStatus",
  "chats.archive",
] as const;

export const PROJECT_ADMIN_METHODS = [
  "projects.create",
  "projects.update",
  "projects.archive",
  "projects.setMode",
] as const;
