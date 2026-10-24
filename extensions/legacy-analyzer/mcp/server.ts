// kurahi-legacy: an MCP server that puts the legacy analyser in the engineer's own tools (VS Code,
// Eclipse-based mainframe IDEs, any MCP client). One project root per server, fixed at launch;
// read-only tools from the registry in ./tools.ts; every call audited to the project's
// `.kurahi/legacy-mcp/audit.jsonl`.
//
// This is a product server. It shares nothing with the gateway or any resident state.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createIndexCache, type IndexCache } from "./index-cache.js";
import { PathRefusedError, openProjectRoot, type ProjectRoot } from "./root-guard.js";
import { DEFAULT_MAX_BYTES, MAX_LIMIT, annotateLocations, pageLine, shapeResult } from "./shape.js";
import { argsHash, openServerState, type ServerState } from "./state.js";
import { LEGACY_TOOLS, type LegacyToolContext, type LegacyToolDef } from "./tools.js";

export const SERVER_NAME = "kurahi-legacy";
export const SERVER_VERSION = "1.0.0";

const ENVELOPE_BYTES = 1024;

export type LegacyMcpOptions = {
  /** The project folder; every tool is confined to it. */
  root: string;
  /** Cap on the serialized result of one call (bytes). */
  maxBytes?: number;
  /** Tool table; defaults to LEGACY_TOOLS. */
  tools?: LegacyToolDef[];
};

export type LegacyMcpContext = {
  root: ProjectRoot;
  state: ServerState;
  cache: IndexCache;
  maxBytes: number;
  tools: LegacyToolDef[];
};

export function openLegacyMcp(opts: LegacyMcpOptions): LegacyMcpContext {
  const root = openProjectRoot(opts.root);
  const state = openServerState(root);
  const maxBytes = Math.max(4096, Math.floor(opts.maxBytes ?? DEFAULT_MAX_BYTES));
  return {
    root,
    state,
    cache: createIndexCache(state),
    maxBytes,
    tools: opts.tools ?? LEGACY_TOOLS,
  };
}

const COMMON_INPUT = {
  path: z
    .string()
    .max(1024)
    .optional()
    .describe(
      "Sub-folder or file of the project to analyse (relative to the project root). Default: the root.",
    ),
  offset: z.number().int().min(0).optional().describe("Pagination: first entry of each list."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .optional()
    .describe(`Pagination: entries per list (default 100, max ${MAX_LIMIT}).`),
};

type CallResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** Run one tool call: resolve the scope, run, annotate, shape, audit. */
export function callTool(
  ctx: LegacyMcpContext,
  def: LegacyToolDef,
  args: Record<string, unknown>,
): CallResult {
  const started = performance.now();
  const audit = (entry: Record<string, unknown>) =>
    ctx.state.appendAudit({
      ts: new Date().toISOString(),
      tool: def.name,
      argsSha256: argsHash(args),
      durationMs: Math.round((performance.now() - started) * 10) / 10,
      ...entry,
    });
  try {
    const scope = ctx.root.resolve(typeof args.path === "string" ? args.path : undefined);
    const toolCtx: LegacyToolContext = {
      scope: scope.rel,
      index: () => ctx.cache.get(scope.abs, scope.rel),
      peek: () => ctx.cache.peek(scope.abs, scope.rel),
      rebuild: () => ctx.cache.build(scope.abs, scope.rel),
    };
    const raw = def.run(toolCtx, args);
    const base = fs.statSync(scope.abs).isFile() ? path.dirname(scope.abs) : scope.abs;
    const located = annotateLocations(raw, (file) => ctx.root.relative(path.resolve(base, file)));
    const shaped = shapeResult(located, {
      offset: args.offset as number | undefined,
      limit: args.limit as number | undefined,
      // Leave room for the envelope (summary, page) so the whole JSON stays under the cap.
      maxBytes: ctx.maxBytes - ENVELOPE_BYTES,
    });
    const summary = [def.summarize(raw, args), pageLine(shaped.page), shaped.reduced?.reason]
      .filter(Boolean)
      .join(" ");
    const structured = {
      tool: def.name,
      scope: scope.rel,
      summary,
      page: shaped.page,
      ...(shaped.reduced ? { reduced: shaped.reduced } : {}),
      result: shaped.data,
    };
    const json = JSON.stringify(structured);
    audit({
      ok: !shaped.overflow,
      resultBytes: Buffer.byteLength(json, "utf8"),
      ...(shaped.overflow ? { error: "overflow" } : {}),
    });
    if (shaped.overflow) {
      return {
        content: [
          { type: "text", text: `${summary} Narrow the request (path, program, a smaller limit).` },
        ],
        structuredContent: structured,
        isError: true,
      };
    }
    return {
      content: [
        { type: "text", text: summary },
        { type: "text", text: json },
      ],
      structuredContent: structured,
    };
  } catch (err) {
    const refused = err instanceof PathRefusedError;
    const message = err instanceof Error ? err.message : String(err);
    audit({ ok: false, resultBytes: 0, error: refused ? "path-refused" : "error" });
    return {
      content: [{ type: "text", text: refused ? message : `Legacy analyser error: ${message}` }],
      isError: true,
    };
  }
}

export function buildMcpServer(ctx: LegacyMcpContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Read-only static analysis of the COBOL, copybook and JCL sources of one project. Every fact " +
        "carries path:line; cite it. Business meaning is not inferred. Large lists are paginated " +
        "(offset, limit; see page.nextOffset).",
    },
  );
  for (const def of ctx.tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: { ...def.input, ...COMMON_INPUT },
        annotations: {
          title: def.title,
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      // The SDK validates the arguments against inputSchema before this runs.
      ((args: Record<string, unknown>) => callTool(ctx, def, args ?? {})) as never,
    );
  }
  return server;
}

/** Serve over stdio until the client closes the pipe. Logs go to stderr only. */
export async function runLegacyMcpStdio(opts: LegacyMcpOptions): Promise<void> {
  const ctx = openLegacyMcp(opts);
  const server = buildMcpServer(ctx);
  // The stdio transport does not watch for end of input; a closed pipe ends the session.
  const closed = new Promise<void>((resolve) => {
    process.stdin.once("end", () => void server.close().finally(resolve));
  });
  await server.connect(new StdioServerTransport());
  process.stderr.write(
    `${SERVER_NAME}: serving ${ctx.root.abs} over stdio (${ctx.tools.length} tools; audit ${ctx.state.auditFile})\n`,
  );
  await closed;
}
