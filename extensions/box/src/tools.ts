import { Type } from "@sinclair/typebox";
// Box tools. Read (root_readonly): search, file metadata, and fetching one file INTO THE PROJECT
// through the core attachment intake (quarantine, static policy, malware scan, and only on a
// clean verdict a copy in the Project's inbox-attachments/ folder); the model gets the stored path
// and the extracted text inside the untrusted-content boundary, never the bytes. Write
// (root_readwrite, opt-in): upload one Project file into the ONE configured folder, after a
// person's approval; never anywhere else, never a shared link.
//
// API references (read 2026-10-25):
//   GET /search                https://developer.box.com/reference/get-search/
//   GET /files/{id}            https://developer.box.com/reference/get-files-id/
//   GET /files/{id}/content    https://developer.box.com/reference/get-files-id-content/
//                              (302 to a download URL, followed at once; 202 + Retry-After when
//                              the file is not ready yet)
//   POST upload.box.com/api/2.0/files/content (multipart; `attributes` before `file`)
//                              https://developer.box.com/reference/post-files-content/
import { randomBytes } from "node:crypto";
import type { Project } from "../../../src/projects/types.js";
import { currentEngineInvocation } from "../../../src/autopilot/engine-origin.js";
import {
  type ApprovalAsk,
  asAgentTool,
  assertScopes,
  ConnectorError,
  type ConnectorRuntime,
  intParam,
  RateLimiter,
  readCapped,
  readProjectFile,
  requireWriteApproval,
  runConnectorTool,
  strParam,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import { parseProjectSessionKey } from "../../../src/projects/scope.js";
import { getProject } from "../../../src/projects/store.js";
import {
  type AttachmentIntakeInput,
  type AttachmentIntakeResult,
  intakeAttachment,
  recordAttachmentRefusal,
} from "../../../src/security/attachment-intake.js";
import { ATTACHMENT_MAX_BYTES } from "../../../src/security/attachment-policy.js";
import { BOX_API, BOX_UPLOAD, type BoxSettings, isBoxId, SCOPES } from "./config.js";

type Obj = Record<string, unknown>;
export const FETCH_TOOL = "box_file_fetch";
export const MAX_SEARCH = 50;
export const MAX_OFFSET = 10_000;
/** Uploads stay well under Box's 50 MB single-request upload. */
export const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const META_FIELDS =
  "id,type,name,size,extension,modified_at,created_at,parent,path_collection,file_version,sha1";

// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;
function line(v: unknown, max = 200): string {
  const t = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  return t.replace(CONTROL_RE, " ").trim().slice(0, max);
}

function fileId(v: unknown): string {
  if (!isBoxId(v)) {
    throw new ConnectorError("bad_request", "invalid file id");
  }
  return v;
}

function pathOf(f: Obj): string {
  const pc = f.path_collection as { entries?: Obj[] } | undefined;
  const names = (pc?.entries ?? []).map((e) => line(e.name, 80)).filter(Boolean);
  return names.length ? `/${names.slice(1).join("/")}` : "";
}

function projectOfSession(ctx: ToolContext): Project {
  const ref = parseProjectSessionKey(ctx.sessionKey);
  const project = ref ? getProject(ref.projectId) : null;
  if (!project || project.archived) {
    throw new ConnectorError(
      "unsupported",
      "not in a project session",
      undefined,
      "files can be fetched only from a Project chat (they are stored in the Project)",
    );
  }
  return project;
}

/** multipart/form-data with `attributes` first, as Box requires, then the file. */
export function uploadBody(
  name: string,
  parentId: string,
  file: Buffer,
  mimeType: string,
  boundary = `kurahi${randomBytes(12).toString("hex")}`,
): { body: Uint8Array<ArrayBuffer>; contentType: string } {
  const quoted = name.replace(/["\r\n\\]/g, "_");
  const head =
    `--${boundary}\r\nContent-Disposition: form-data; name="attributes"\r\n\r\n` +
    `${JSON.stringify({ name, parent: { id: parentId } })}\r\n` +
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${quoted}"\r\n` +
    `Content-Type: ${mimeType}\r\n\r\n`;
  const buf = Buffer.concat([
    Buffer.from(head, "utf8"),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const body = new Uint8Array(new ArrayBuffer(buf.length));
  body.set(buf);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

export type BoxToolDeps = {
  runtime: ConnectorRuntime;
  ctx: ToolContext;
  ask: ApprovalAsk;
  settings: BoxSettings;
  /** Box allows 60 searches per minute per user; one limiter per plugin instance. */
  searchLimiter: RateLimiter;
  intake?: (input: AttachmentIntakeInput) => Promise<AttachmentIntakeResult>;
};

export function createBoxTools(deps: BoxToolDeps) {
  const { runtime, ctx, settings } = deps;
  const read = [SCOPES.read];
  const intake = deps.intake ?? ((input) => intakeAttachment(input));

  const search = asAgentTool({
    name: "box_search",
    label: "Box: search files",
    description: `Search Box files by name and content (Box search syntax; quoted phrases, AND/OR/NOT). Returns id, name, path, size, modified time; at most ${MAX_SEARCH}.${settings.searchFolderIds.length ? " Limited to the configured folders." : ""} Read-only.`,
    parameters: Type.Object({
      query: Type.String(),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_SEARCH })),
      offset: Type.Optional(Type.Integer({ minimum: 0, maximum: MAX_OFFSET })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "files.search",
        async () => {
          const q = strParam(params.query, "query", { required: true, max: 500 })!;
          const limit = intParam(params.limit, 20, 1, MAX_SEARCH);
          const u = new URL(`${BOX_API}/search`);
          u.searchParams.set("query", q);
          u.searchParams.set("type", "file");
          u.searchParams.set("limit", String(limit));
          u.searchParams.set("offset", String(intParam(params.offset, 0, 0, MAX_OFFSET)));
          u.searchParams.set("fields", "id,type,name,size,modified_at,path_collection");
          if (settings.searchFolderIds.length) {
            u.searchParams.set("ancestor_folder_ids", settings.searchFolderIds.join(","));
          }
          await deps.searchLimiter.acquire();
          const res = await runtime.json<{ entries?: Obj[]; total_count?: number }>({
            url: u.toString(),
            scopes: read,
          });
          const value = (res.entries ?? []).filter((e) => isBoxId(e.id)).slice(0, limit);
          const text = value.length
            ? wrapUntrusted(
                value
                  .map(
                    (f, i) =>
                      `${i + 1}. id: ${String(f.id)}\n   name: ${line(f.name)}\n   path: ${pathOf(f)}\n   size: ${Number(f.size) || 0} modified: ${line(f.modified_at, 40)}`,
                  )
                  .join("\n"),
                { source: "api" },
              )
            : "No files found.";
          return {
            value: value.map((f) => String(f.id)),
            result: textResult(text, { count: value.length }),
          };
        },
        (ids) => ({ ids, count: ids.length }),
      ),
  });

  const metadata = asAgentTool({
    name: "box_file_metadata",
    label: "Box: file metadata",
    description:
      "Metadata of one Box file: name, path, size, type, created/modified, version, SHA-1. Read-only.",
    parameters: Type.Object({ id: Type.String() }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "files.metadata",
        async () => {
          const id = fileId(params.id);
          const f = await runtime.json<Obj>(
            { url: `${BOX_API}/files/${id}?fields=${META_FIELDS}`, scopes: read },
            256 * 1024,
          );
          const version =
            f.file_version && typeof f.file_version === "object" ? (f.file_version as Obj).id : "";
          const text = [
            `id: ${id}`,
            `name: ${line(f.name)}`,
            `path: ${pathOf(f)}`,
            `size: ${Number(f.size) || 0}`,
            `extension: ${line(f.extension, 20)}`,
            `created: ${line(f.created_at, 40)} modified: ${line(f.modified_at, 40)}`,
            `version: ${line(version, 40)} sha1: ${line(f.sha1, 64)}`,
          ].join("\n");
          return { value: id, result: textResult(wrapUntrusted(text, { source: "api" })) };
        },
        (id) => ({ ids: [id], count: 1 }),
      ),
  });

  const fetchTool = asAgentTool({
    name: FETCH_TOOL,
    label: "Box: fetch file into the Project",
    description:
      "Fetch one Box file into the current Project: it is quarantined, checked and scanned for malware, and only a clean file is stored in inbox-attachments/. Returns the stored path and the file's text (untrusted content), never the bytes. Refused: executables, scripts, macros, encrypted files, unknown types, over 20 MB. Read-only on Box.",
    parameters: Type.Object({ id: Type.String() }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "files.fetch",
        async () => {
          const project = projectOfSession(ctx);
          const id = fileId(params.id);
          const meta = await runtime.json<Obj>(
            { url: `${BOX_API}/files/${id}?fields=id,name,size,file_version`, scopes: read },
            64 * 1024,
          );
          const version =
            meta.file_version && typeof meta.file_version === "object"
              ? line((meta.file_version as Obj).id, 40)
              : "";
          const inv = currentEngineInvocation();
          const run =
            inv && inv.tool === FETCH_TOOL && inv.sessionKey === ctx.sessionKey
              ? { routineId: inv.routineId, runId: inv.runId }
              : null;
          const base = {
            project,
            connector: runtime.id,
            messageId: id,
            attachmentId: /^[0-9]{1,20}$/.test(version) ? version : "current",
            actor: run ? `autopilot:${run.routineId}` : (ctx.agentId ?? "main"),
            sessionKey: ctx.sessionKey,
            run,
          };
          const size = Number(meta.size) || 0;
          let result: AttachmentIntakeResult;
          if (size > ATTACHMENT_MAX_BYTES) {
            result = recordAttachmentRefusal(base, {
              stage: "policy",
              code: "too_large",
              reason: "the file is larger than 20 MB",
              size,
            });
          } else {
            const res = await runtime.request({
              url: `${BOX_API}/files/${id}/content`,
              headers: { accept: "*/*" },
              scopes: read,
            });
            if (res.status === 202) {
              await res.body?.cancel().catch(() => {});
              throw new ConnectorError(
                "provider_unavailable",
                "file not ready",
                202,
                "Box is still preparing the file; try again in a minute",
              );
            }
            const bytes = await readCapped(res, ATTACHMENT_MAX_BYTES);
            result = await intake({ ...base, name: line(meta.name) || "box-file", bytes });
          }
          if (result.status === "refused") {
            return {
              value: { id, bytes: result.size, kind: "refused" },
              result: textResult(
                `File ${id} refused (${result.code}): ${result.reason}. Nothing was stored; a person can review it in Box.`,
                {
                  attachment: {
                    status: "refused",
                    stage: result.stage,
                    code: result.code,
                    fileId: id,
                    sha256: result.sha256,
                  },
                },
              ),
            };
          }
          const header = [
            `file: ${id}`,
            `stored: ${result.path}`,
            `kind: ${result.kind}`,
            `size: ${result.size}`,
            `sha256: ${result.sha256}`,
            `scan: ${result.verdict} (${result.scanner})`,
          ].join("\n");
          const body =
            result.text === null
              ? `[text not available: ${result.textError ?? "extraction failed"}]`
              : result.text;
          return {
            value: { id, bytes: result.size, kind: result.kind },
            result: textResult(wrapUntrusted(`${header}\n\n${body}`, { source: "api" }), {
              attachment: {
                status: "accepted",
                fileId: id,
                path: result.path,
                kind: result.kind,
                sha256: result.sha256,
                verdict: result.verdict,
              },
            }),
          };
        },
        (v) => ({ ids: [v.id], count: 1, bytes: v.bytes, kind: v.kind }),
      ),
  });

  const tools = [search, metadata, fetchTool];
  if (!settings.upload || !isBoxId(settings.uploadFolderId)) {
    return tools;
  }
  const folder = settings.uploadFolderId;

  tools.push(
    asAgentTool({
      name: "box_file_upload",
      label: "Box: upload file to the configured folder",
      description:
        "Upload one file from the current Project folder (PDF, DOCX, XLSX, PPTX, CSV, TXT, MD or an image; at most 20 MB) into the one Box folder the administrator configured. A person must approve every upload. Never overwrites (a name clash fails) and never shares the file.",
      parameters: Type.Object({
        path: Type.String({ description: "File path relative to the Project folder" }),
      }),
      execute: (_id, params) =>
        runConnectorTool(
          runtime,
          ctx,
          "files.upload",
          async () => {
            const file = await readProjectFile(ctx, params.path, UPLOAD_MAX_BYTES);
            // Refused before asking anyone when the grant cannot upload anyway.
            assertScopes(runtime.grantedScopes() ?? [], [SCOPES.write]);
            await requireWriteApproval(
              {
                connectorId: runtime.id,
                tool: "box_file_upload",
                agentId: ctx.agentId ?? "main",
                sessionKey: ctx.sessionKey,
                preview: {
                  folderId: folder,
                  name: file.name,
                  bytes: file.buf.length,
                  kind: file.kind,
                },
                timeoutMs: settings.approvalTimeoutMs,
              },
              deps.ask,
            );
            const { body, contentType } = uploadBody(file.name, folder, file.buf, file.mimeType);
            const res = await runtime.json<{ entries?: Obj[] }>({
              url: BOX_UPLOAD,
              method: "POST",
              headers: { "content-type": contentType },
              body,
              scopes: [SCOPES.write],
            });
            const id = line(res.entries?.[0]?.id, 20);
            if (!isBoxId(id)) {
              throw new ConnectorError("invalid_response", "upload returned no file id");
            }
            return {
              value: { id, bytes: file.buf.length, kind: file.kind },
              result: textResult(
                `Uploaded ${file.buf.length} bytes (${file.kind}) to the configured Box folder as file ${id}; not shared.`,
                { id },
              ),
            };
          },
          (v) => ({ ids: [v.id], count: 1, bytes: v.bytes, kind: v.kind }),
        ),
    }),
  );
  return tools;
}
