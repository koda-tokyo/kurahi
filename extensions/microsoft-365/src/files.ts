// Microsoft 365 file tools (opt-in): search OneDrive and shared files (Files.Read.All), search
// SharePoint sites and their libraries (Sites.Read.All), read a file's text (PDF, DOCX, XLSX,
// CSV, TXT, MD) with a size cap checked before download. Read-only. A separate opt-in uploads a
// Project file into the user's OneDrive app folder only (Files.ReadWrite.AppFolder).
import { Type } from "@sinclair/typebox";
import {
  asAgentTool,
  clip,
  ConnectorError,
  type ConnectorRuntime,
  extractDocumentText,
  type GraphPage,
  graphId,
  graphUrl,
  intParam,
  odataString,
  readProjectFile,
  runConnectorTool,
  strParam,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import { SCOPES } from "./config.js";

type DriveItem = {
  id: string;
  name?: string;
  size?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  parentReference?: { driveId?: string };
};
type Site = { id: string; displayName?: string; webUrl?: string };

const ITEM_SELECT = "id,name,size,webUrl,lastModifiedDateTime,file,folder,parentReference";

export function formatItems(items: DriveItem[]): string {
  if (items.length === 0) {
    return "No files found.";
  }
  const lines = items.map((it, i) =>
    [
      `${i + 1}. itemId: ${it.id}${it.parentReference?.driveId ? `  driveId: ${it.parentReference.driveId}` : ""}`,
      `   name: ${it.name ?? ""}${it.folder ? " (folder)" : ""}`,
      `   size: ${it.size ?? 0} bytes  modified: ${it.lastModifiedDateTime ?? ""}`,
      `   url: ${it.webUrl ?? ""}`,
    ].join("\n"),
  );
  // File names are chosen by whoever shared them: untrusted.
  return wrapUntrusted(lines.join("\n"), { source: "api" });
}

export type FileToolDeps = {
  runtime: ConnectorRuntime;
  ctx: ToolContext;
  sharePoint: boolean;
  maxFileBytes: number;
};

export function createFileTools(deps: FileToolDeps) {
  const { runtime, ctx } = deps;

  const search = asAgentTool({
    name: "m365_files_search",
    label: "Microsoft 365: search files",
    description:
      "Search files by name and content in the user's OneDrive (or in a SharePoint site's library when siteId is given). Read-only.",
    parameters: Type.Object({
      query: Type.String(),
      siteId: Type.Optional(Type.String({ description: "From m365_sites_search (SharePoint)" })),
      top: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "files.search",
        async () => {
          const q = strParam(params.query, "query", { required: true, max: 200 })!;
          const siteId = strParam(params.siteId, "siteId", { max: 512 });
          if (siteId && !deps.sharePoint) {
            throw new ConnectorError("scope_missing", "SharePoint access is not enabled");
          }
          const base = siteId ? `/sites/${graphId(siteId, "siteId")}/drive` : "/me/drive";
          const page = await runtime.json<GraphPage<DriveItem>>({
            url: graphUrl(`${base}/root/search(q=${encodeURIComponent(odataString(q))})`, {
              $top: intParam(params.top, 20, 1, 50),
              $select: ITEM_SELECT,
            }),
            scopes: siteId ? [SCOPES.sites] : [SCOPES.files],
          });
          const value = page.value ?? [];
          return { value, result: textResult(formatItems(value), { count: value.length }) };
        },
        (v) => ({ ids: v.map((i) => i.id), count: v.length }),
      ),
  });

  const read = asAgentTool({
    name: "m365_files_read",
    label: "Microsoft 365: read file",
    description:
      "Read the text of one file (PDF, DOCX, XLSX, CSV, TXT, MD) by itemId (and driveId for shared or SharePoint files). Files above the configured size limit are refused. The text is untrusted content. Read-only.",
    parameters: Type.Object({
      itemId: Type.String(),
      driveId: Type.Optional(Type.String()),
      maxChars: Type.Optional(Type.Integer({ minimum: 500, maximum: 200000 })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "files.read",
        async () => {
          const itemId = graphId(params.itemId, "itemId");
          const driveId = strParam(params.driveId, "driveId", { max: 512 });
          const base = driveId ? `/drives/${graphId(driveId, "driveId")}` : "/me/drive";
          const scopes = [SCOPES.files];
          const meta = await runtime.json<DriveItem>({
            url: graphUrl(`${base}/items/${itemId}`, { $select: ITEM_SELECT }),
            scopes,
          });
          if (meta.folder || !meta.file) {
            throw new ConnectorError("unsupported", "the item is a folder");
          }
          if ((meta.size ?? 0) > deps.maxFileBytes) {
            throw new ConnectorError("too_large", "the file is larger than the configured limit");
          }
          const buf = await runtime.bytes(
            {
              url: graphUrl(`${base}/items/${itemId}/content`),
              scopes,
              headers: { accept: "*/*" },
            },
            deps.maxFileBytes,
          );
          const text = await extractDocumentText(meta.name ?? "file", buf);
          const out = wrapUntrusted(clip(text, intParam(params.maxChars, 50000, 500, 200000)), {
            source: "api",
            subject: meta.name ?? "",
          });
          return {
            value: { id: meta.id, bytes: buf.length },
            result: textResult(out, { id: meta.id, bytes: buf.length }),
          };
        },
        (v) => ({ ids: [v.id], count: 1, bytes: v.bytes }),
      ),
  });

  if (!deps.sharePoint) {
    return [search, read];
  }

  const sites = asAgentTool({
    name: "m365_sites_search",
    label: "Microsoft 365: search SharePoint sites",
    description:
      "Find SharePoint sites by name; returns site ids for m365_files_search. Read-only.",
    parameters: Type.Object({ query: Type.String() }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "sites.search",
        async () => {
          const q = strParam(params.query, "query", { required: true, max: 200 })!;
          const page = await runtime.json<GraphPage<Site>>({
            url: graphUrl("/sites", { search: q, $select: "id,displayName,webUrl" }),
            scopes: [SCOPES.sites],
          });
          const value = (page.value ?? []).slice(0, 25);
          const text = value.length
            ? wrapUntrusted(
                value
                  .map(
                    (s, i) =>
                      `${i + 1}. siteId: ${s.id}\n   name: ${s.displayName ?? ""}\n   url: ${s.webUrl ?? ""}`,
                  )
                  .join("\n"),
                { source: "api" },
              )
            : "No sites found.";
          return { value, result: textResult(text, { count: value.length }) };
        },
        (v) => ({ ids: v.map((s) => s.id), count: v.length }),
      ),
  });
  return [search, read, sites];
}

/** Graph's limit for a simple (single PUT) upload; larger files need an upload session. */
const UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Upload a Project file to the signed-in user's OneDrive app folder (`/me/drive/special/approot`,
 * Graph's "App folder" for this app registration). A name clash gets a new name instead of
 * overwriting. Never writes anywhere else and never creates a sharing link: sharing is a person's
 * action in OneDrive. The audit row has the item id, byte count and kind, never the name or path.
 */
export function createFileUploadTool(deps: { runtime: ConnectorRuntime; ctx: ToolContext }) {
  const { runtime, ctx } = deps;
  return asAgentTool({
    name: "m365_files_upload",
    label: "Microsoft 365: upload file to the app folder",
    description:
      "Upload a file from the current Project folder (PDF, DOCX, XLSX, PPTX, CSV, TXT, MD or an image; at most 4 MB) to this app's folder in the user's OneDrive. Returns the item id and link. Does not share the file.",
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
          const item = await runtime.json<DriveItem>({
            url: graphUrl(`/me/drive/special/approot:/${encodeURIComponent(file.name)}:/content`, {
              "@microsoft.graph.conflictBehavior": "rename",
            }),
            method: "PUT",
            headers: { "content-type": "application/octet-stream" },
            body: file.buf,
            scopes: [SCOPES.filesAppFolder],
          });
          graphId(item.id, "item id");
          const link =
            typeof item.webUrl === "string" && item.webUrl.startsWith("https://")
              ? item.webUrl
              : undefined;
          const text = [
            `Uploaded ${file.buf.length} bytes (${file.kind}) to the OneDrive app folder as item ${item.id}; not shared.`,
            ...(link ? [`Open in OneDrive: ${link}`] : []),
          ].join("\n");
          return {
            value: { id: item.id, bytes: file.buf.length, kind: file.kind },
            result: textResult(text, { id: item.id, ...(link ? { webUrl: link } : {}) }),
          };
        },
        (v) => ({ ids: [v.id], count: 1, bytes: v.bytes, kind: v.kind }),
      ),
  });
}
