// `kurahi legacy …` — the legacy analyser outside the gateway.
//
//   kurahi legacy mcp --root <dir>                 MCP server over stdio for one project
//        [--http <port>]                           loopback streamable HTTP instead (127.0.0.1)
//        [--max-bytes <n>]                         cap on one response (default 65536)
//
// The server is the bundled `extensions/legacy-analyzer/mcp/` module, loaded the way plugins are
// (jiti), so it ships with the analyser it wraps. stdout carries MCP only; messages go to stderr.
// HTTP needs a bearer token: KURAHI_LEGACY_MCP_TOKEN, or one generated and printed at start.
import type { Command } from "commander";
import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

type ServeOptions = { root: string; maxBytes?: number };

export type LegacyMcpModules = {
  runLegacyMcpStdio(opts: ServeOptions): Promise<void>;
  startLegacyMcpHttp(
    opts: ServeOptions & { port: number; token?: string },
  ): Promise<{ url: string; token: string; close(): Promise<void> }>;
};

export function resolveLegacyMcpDir(bundled = resolveBundledPluginsDir()): string {
  const dir = bundled ? path.join(bundled, "legacy-analyzer", "mcp") : "";
  if (!dir || !fs.existsSync(path.join(dir, "server.ts"))) {
    throw new Error(
      "The legacy analyser MCP server is not installed (extensions/legacy-analyzer/mcp).",
    );
  }
  return dir;
}

export async function loadLegacyMcpModules(): Promise<LegacyMcpModules> {
  const dir = resolveLegacyMcpDir();
  const jiti = createJiti(import.meta.url, { interopDefault: true });
  const server = await jiti.import<Pick<LegacyMcpModules, "runLegacyMcpStdio">>(
    path.join(dir, "server.ts"),
  );
  const http = await jiti.import<Pick<LegacyMcpModules, "startLegacyMcpHttp">>(
    path.join(dir, "http.ts"),
  );
  return { ...server, ...http };
}

function intOption(raw: string | undefined, flag: string, min: number, max: number) {
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`${flag} must be an integer from ${min} to ${max}`);
  }
  return n;
}

export async function runLegacyMcp(
  opts: { root?: string; http?: string; maxBytes?: string },
  deps: { runtime?: RuntimeEnv; load?: () => Promise<LegacyMcpModules> } = {},
): Promise<void> {
  const runtime = deps.runtime ?? defaultRuntime;
  let port: number | undefined;
  let maxBytes: number | undefined;
  try {
    if (!opts.root) {
      throw new Error("--root <dir> is required: the project folder to serve");
    }
    port = intOption(opts.http, "--http", 0, 65_535);
    maxBytes = intOption(opts.maxBytes, "--max-bytes", 4096, 16 * 1024 * 1024);
  } catch (err) {
    runtime.error(`kurahi legacy mcp: ${err instanceof Error ? err.message : String(err)}`);
    runtime.exit(2);
    return;
  }
  const mods = await (deps.load ?? loadLegacyMcpModules)();
  const root = path.resolve(opts.root);
  if (port === undefined) {
    await mods.runLegacyMcpStdio({ root, maxBytes });
    return;
  }
  const envToken = process.env.KURAHI_LEGACY_MCP_TOKEN?.trim();
  const srv = await mods.startLegacyMcpHttp({ root, maxBytes, port, token: envToken });
  if (!envToken) {
    runtime.error(`kurahi legacy mcp: bearer token for this run: ${srv.token}`);
  }
  await new Promise<void>((resolve) => {
    const stop = () => void srv.close().finally(resolve);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export function registerLegacyCli(program: Command) {
  const cmd = program
    .command("legacy")
    .description("Legacy analyser (COBOL, copybooks, JCL) for engineers' own tools");

  cmd
    .command("mcp")
    .description("Serve the read-only legacy analyser tools to an MCP client, for one project")
    .requiredOption("--root <dir>", "project folder; every tool is confined to it")
    .option("--http <port>", "serve streamable HTTP on 127.0.0.1:<port> instead of stdio")
    .option("--max-bytes <n>", "cap on one response, in bytes (default 65536)")
    .action(async (opts: { root?: string; http?: string; maxBytes?: string }) => {
      try {
        await runLegacyMcp(opts);
      } catch (err) {
        defaultRuntime.error(
          `kurahi legacy mcp: ${err instanceof Error ? err.message : String(err)}`,
        );
        defaultRuntime.exit(1);
      }
    });
}
