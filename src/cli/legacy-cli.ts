// `kurahi legacy …` — the legacy analyser outside the gateway.
//
//   kurahi legacy mcp --root <dir>                 MCP server over stdio for one project
//        [--http <port>]                           loopback streamable HTTP instead (127.0.0.1)
//        [--max-bytes <n>]                         cap on one response (default 65536)
//        [--allow-host <host...>]                  Host names of a TLS reverse proxy in front (HTTP only)
//   kurahi legacy verify --baseline <dir> --candidate <dir> [--fixtures <dir>] [--change-spec <file>]
//        [--entry <path>] [--dialect <std>] [--flag <f...>] [--timeout <s>] [--project <id> | --data <dir>]
//        [--json]                                  modernisation verification with signed evidence
//
// The server is the bundled `extensions/legacy-analyzer/mcp/` module, loaded the way plugins are
// (jiti), so it ships with the analyser it wraps. stdout carries MCP only; messages go to stderr.
// HTTP needs a bearer token: KURAHI_LEGACY_MCP_TOKEN, or one generated and printed at start.
import type { Command } from "commander";
import { createJiti } from "jiti";
import fs from "node:fs";
import path from "node:path";
import type { VerificationReport } from "../modernisation/types.js";
import { resolveStateDir } from "../config/paths.js";
import { summarizeReport, verifyChange } from "../modernisation/verify.js";
import { resolveBundledPluginsDir } from "../plugins/bundled-dir.js";
import { projectDataDir } from "../projects/store.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

type ServeOptions = { root: string; maxBytes?: number };

export type LegacyMcpModules = {
  runLegacyMcpStdio(opts: ServeOptions): Promise<void>;
  startLegacyMcpHttp(
    opts: ServeOptions & { port: number; token?: string; allowedHosts?: string[] },
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
  opts: { root?: string; http?: string; maxBytes?: string; allowHost?: string[] },
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
    if (opts.allowHost?.length && port === undefined) {
      throw new Error("--allow-host needs --http <port>");
    }
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
  const srv = await mods.startLegacyMcpHttp({
    root,
    maxBytes,
    port,
    token: envToken,
    allowedHosts: opts.allowHost,
  });
  if (!envToken) {
    runtime.error(`kurahi legacy mcp: bearer token for this run: ${srv.token}`);
  }
  await new Promise<void>((resolve) => {
    const stop = () => void srv.close().finally(resolve);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export type LegacyVerifyOptions = {
  baseline?: string;
  candidate?: string;
  fixtures?: string;
  changeSpec?: string;
  entry?: string;
  dialect?: string;
  flag?: string[];
  timeout?: string;
  project?: string;
  data?: string;
  json?: boolean;
};

/** `kurahi legacy verify`: exit 0 only on PASS; 1 on any other verdict; 2 on usage errors. */
export async function runLegacyVerify(
  opts: LegacyVerifyOptions,
  deps: { runtime?: RuntimeEnv; env?: NodeJS.ProcessEnv } = {},
): Promise<{ code: number; report?: VerificationReport; bundleDir?: string }> {
  const runtime = deps.runtime ?? defaultRuntime;
  let timeout: number | undefined;
  try {
    if (!opts.baseline || !opts.candidate) {
      throw new Error("--baseline <dir> and --candidate <dir> are required");
    }
    if (opts.project && opts.data) {
      throw new Error("pass --project or --data, not both");
    }
    timeout = intOption(opts.timeout, "--timeout", 1, 3600);
  } catch (err) {
    runtime.error(`kurahi legacy verify: ${err instanceof Error ? err.message : String(err)}`);
    return { code: 2 };
  }
  const dataDir = opts.data
    ? path.resolve(opts.data)
    : opts.project
      ? path.join(projectDataDir(opts.project), "modernisation")
      : path.join(resolveStateDir(deps.env), "modernisation");
  const ac = new AbortController();
  const onSig = () => ac.abort();
  process.once("SIGINT", onSig);
  try {
    const out = await verifyChange({
      dataDir,
      baselineDir: path.resolve(opts.baseline),
      candidateDir: path.resolve(opts.candidate),
      fixturesDir: opts.fixtures ? path.resolve(opts.fixtures) : null,
      changeSpecFile: opts.changeSpec ? path.resolve(opts.changeSpec) : null,
      policy: {
        entry: opts.entry ?? null,
        dialect: opts.dialect ?? null,
        flags: opts.flag ?? [],
        ...(timeout
          ? {
              limits: {
                timeoutMs: timeout * 1000,
                maxOutputBytes: 4 * 1024 * 1024,
                cpuSeconds: timeout,
              },
            }
          : {}),
      },
      signal: ac.signal,
      env: deps.env,
    });
    runtime.log(
      opts.json
        ? JSON.stringify({ bundle: out.bundleDir, ...out.report }, null, 2)
        : summarizeReport(out.report, out.bundleDir).join("\n"),
    );
    return { code: out.report.verdict === "PASS" ? 0 : 1, ...out };
  } catch (err) {
    runtime.error(`kurahi legacy verify: ${err instanceof Error ? err.message : String(err)}`);
    return { code: 1 };
  } finally {
    process.off("SIGINT", onSig);
  }
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
    .option(
      "--allow-host <host...>",
      "with --http: also accept these Host names (a TLS reverse proxy in front)",
    )
    .action(
      async (opts: { root?: string; http?: string; maxBytes?: string; allowHost?: string[] }) => {
        try {
          await runLegacyMcp(opts);
        } catch (err) {
          defaultRuntime.error(
            `kurahi legacy mcp: ${err instanceof Error ? err.message : String(err)}`,
          );
          defaultRuntime.exit(1);
        }
      },
    );

  cmd
    .command("verify")
    .description(
      "Verify a modernisation change by execution: snapshot, compile, run both on the same fixtures, compare, sign",
    )
    .requiredOption("--baseline <dir>", "folder with the original sources")
    .requiredOption("--candidate <dir>", "folder with the changed sources")
    .option("--fixtures <dir>", "fixture cases (one sub-folder each: stdin, args, files/, golden/)")
    .option(
      "--change-spec <file>",
      "change spec JSON: comparators and approved intended differences",
    )
    .option("--entry <path>", "entry program inside the snapshot, when ambiguous")
    .option("--dialect <std>", "COBOL dialect passed to cobc -std=")
    .option("--flag <flag...>", "extra compiler flags (recorded in the policy)")
    .option("--timeout <seconds>", "per compile/execution timeout (default 60)")
    .option("--project <id>", "store snapshots and evidence in this Project's data area")
    .option("--data <dir>", "store snapshots and evidence here (default <state dir>/modernisation)")
    .option("--json", "JSON report", false)
    .action(async (opts: LegacyVerifyOptions) => {
      const { code } = await runLegacyVerify(opts);
      if (code !== 0) {
        defaultRuntime.exit(code);
      }
    });
}
