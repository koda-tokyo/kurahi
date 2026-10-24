// Microsoft 365 file tools (opt-in): search OneDrive and shared files (Files.Read.All), search
// SharePoint sites and their libraries (Sites.Read.All), read a file's text (PDF, DOCX, XLSX,
// CSV, TXT, MD) with a size cap checked before download. Read-only.
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
