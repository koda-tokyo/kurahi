// Kurahi Industrial Edition, release acceptance (end to end, no model).
//
// Proves, from a clean temporary home, that a customer can install and use the Industrial
// Edition with the BUILT product (dist/, run through kolo.mjs exactly as `kurahi` would be):
//
//   1. `kurahi init --non-interactive` writes the secure defaults; the Industrial edition and
//      workspace are what the Control UI selects; the gateway starts on a free loopback port.
//   2. An Industrial project is created from the legacy modernisation template over a copy of a
//      polyglot source tree (COBOL/JCL, Java, SQL DDL, FORTRAN, PL/I), in plan mode (計画).
//   3. The analyser tools run through the gateway's tool invocation path (/tools/invoke with the
//      project session key, the path CLI bridges and the agent use): path:line citations, all
//      five languages active, a coverage section, and byte-identical output across two runs.
//   4. The design document is saved as an Artifact, exported the way the Control UI exports it,
//      and the .sha256 sidecar verifies (sha256sum -c).
//   5. The terminal broker: plan mode runs a read-only command and holds a write for approval;
//      act mode holds a destructive command until exec.approval.resolve, then runs it and emits
//      file.diff; the hash-chained audit log records it and verifies; read mode refuses to open.
//   6. Security defaults: supply-chain lock, memory provenance and message signing enforce; the
//      family-internal check is clean on the built dist.
//
// Every step's result and timing goes to test/acceptance/REPORT-<version>.md.
//
// Needs `pnpm build` first (dist/). Run: scripts/acceptance-industrial.sh
// The gateway is a child of this test, bound to 127.0.0.1 on a free port in 18960-18980, with
// its own temporary KOLO_HOME, and is killed in afterAll.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { KoLoConfig } from "../../src/config/types.js";
import { uncitedFactLines } from "../../packages/legacy-analyzer/src/test-fixtures/doc-check.js";
import { POLY_FILES } from "../../packages/legacy-analyzer/src/test-fixtures/payroll-poly.js";
import { SCI_FILES } from "../../packages/legacy-analyzer/src/test-fixtures/sci-batch.js";
import { resolveAgentMessageSigning } from "../../src/agents/messaging/signing.js";
import { GatewayClient } from "../../src/gateway/client.js";
import { loadOrCreateDeviceIdentity } from "../../src/infra/device-identity.js";
import { resolveSupplyChainMode } from "../../src/integrity/supply-chain-gate.js";
import { resolveMemoryProvenanceMode } from "../../src/memory/provenance.js";
import { LEGACY_ANALYZER_TOOLS, projectSessionKey } from "../../src/projects/scope.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../../src/utils/message-channel.js";
import { buildArtifactExport } from "../../ui/src/ui/controllers/artifact-export.js";
import {
  getEditionManifest,
  getWorkspaceManifest,
  resolveWorkspaceId,
} from "../../ui/src/ui/editions/manifests.js";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const ENTRY = path.join(REPO, "kolo.mjs");
const HAS_DIST = fs.existsSync(path.join(REPO, "dist", "index.js"));
const VERSION = (
  JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { version: string }
).version;
const TARGET_RELEASE = process.env.KURAHI_ACCEPT_RELEASE ?? "2.1.0";
const REPORT = path.join(REPO, "test", "acceptance", `REPORT-${TARGET_RELEASE}.md`);
const IDENTITY = "acme";
const LOCAL_MODEL = "qwen2.5:1.5b";
const TEMPLATE = "industry-legacy-modernisation";
const PORT_RANGE = [18960, 18980] as const;
const STEP_TIMEOUT = 120_000;

// ── report ───────────────────────────────────────────────────────────────────────────────────

type StepResult = {
  id: string;
  title: string;
  status: "pass" | "fail" | "not run";
  ms: number;
  evidence: string[];
  error?: string;
};

const STEPS: Array<{ id: string; title: string }> = [
  { id: "1", title: "Install: kurahi init (secure defaults), Industrial edition, gateway start" },
  { id: "2", title: "Industrial project from the legacy modernisation template, plan mode (計画)" },
  {
    id: "3",
    title:
      "Analyser tools (MCP stdio + agent tool layer; /tools/invoke probed): citations, five languages, determinism",
  },
  { id: "4", title: "Design document saved as an Artifact, exported, .sha256 sidecar verified" },
  { id: "5", title: "Terminal broker: plan/act/read modes, approvals, file.diff, audit chain" },
  { id: "6", title: "Security defaults and family-internal check on the built dist" },
];
const results = new Map<string, StepResult>(
  STEPS.map((s) => [s.id, { ...s, status: "not run", ms: 0, evidence: [] }]),
);

async function step(id: string, fn: (ev: (line: string) => void) => Promise<void>) {
  const r = results.get(id)!;
  const started = performance.now();
  const ev = (line: string) => r.evidence.push(line);
  try {
    await fn(ev);
    r.status = "pass";
  } catch (err) {
    r.status = "fail";
    r.error = (err instanceof Error ? err.message : String(err)).slice(0, 1500);
    throw err;
  } finally {
    r.ms = Math.round(performance.now() - started);
  }
}

function writeReport(extra: { gatewayMs?: number; notes: string[] }) {
  const all = [...results.values()];
  const passed = all.filter((r) => r.status === "pass").length;
  const lines = [
    `# Kurahi ${TARGET_RELEASE} Industrial Edition: acceptance report`,
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Product build under test: kurahi ${VERSION} (dist/, ${gitHead()})`,
    `- Host: ${os.platform()} ${os.arch()}, node ${process.version}`,
    `- Test: test/acceptance/industrial-edition.e2e.test.ts (scripts/acceptance-industrial.sh)`,
    `- Result: ${passed}/${all.length} steps passed`,
    "",
    "| Step | Result | Time |",
    "| --- | --- | --- |",
    ...all.map((r) => `| ${r.id}. ${r.title} | ${r.status.toUpperCase()} | ${fmtMs(r.ms)} |`),
    "",
  ];
  for (const r of all) {
    lines.push(
      `## Step ${r.id}: ${r.title}`,
      "",
      `Result: **${r.status.toUpperCase()}** (${fmtMs(r.ms)})`,
      "",
    );
    for (const e of r.evidence) {
      lines.push(`- ${e}`);
    }
    if (r.error) {
      lines.push("", "Failure:", "", "```", r.error, "```");
    }
    lines.push("");
  }
  if (extra.notes.length > 0) {
    lines.push("## Notes", "", ...extra.notes.map((n) => `- ${n}`), "");
  }
  fs.writeFileSync(REPORT, `${lines.join("\n")}`);
}

const fmtMs = (ms: number) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${ms} ms`);

function gitHead(): string {
  const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { cwd: REPO, encoding: "utf8" });
  return r.status === 0 ? `commit ${r.stdout.trim()}` : "commit unknown";
}

// ── process helpers ──────────────────────────────────────────────────────────────────────────

/** A clean environment for the product: none of the test runner's variables leak in. */
function productEnv(t: Tmp, port: number): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    TZ: "UTC",
    HOME: t.home,
    KOLO_HOME: t.state,
    KOLO_STATE_DIR: t.state,
    KOLO_GATEWAY_PORT: String(port),
    KOLO_SKIP_CHANNELS: "1",
    KOLO_SKIP_BROWSER_CONTROL_SERVER: "1",
    KOLO_SKIP_CANVAS_HOST: "1",
    KOLO_SHIELD: "off",
    NO_COLOR: "1",
  };
}

function cli(t: Tmp, args: string[], timeoutMs = 60_000) {
  const r = spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: t.root,
    env: productEnv(t, t.port),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

async function portFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });
}

async function pickPort(): Promise<number> {
  for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++) {
    if (await portFree(p)) {
      return p;
    }
  }
  throw new Error(`no free port in ${PORT_RANGE.join("-")}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(
  what: string,
  fn: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== undefined) {
      return v;
    }
    await sleep(50);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`);
}

// ── fixture tree ─────────────────────────────────────────────────────────────────────────────

type Tmp = {
  root: string;
  home: string;
  state: string;
  folder: string;
  exportDir: string;
  port: number;
};

/** The polyglot payroll and scientific batch fixtures, materialised under source/. */
function materialiseSource(folder: string): Record<string, number> {
  const files = { ...POLY_FILES, ...SCI_FILES };
  const byExt: Record<string, number> = {};
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(folder, "source", rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, `${content}\n`);
    const ext = path.extname(rel).toLowerCase() || "(none)";
    byExt[ext] = (byExt[ext] ?? 0) + 1;
  }
  return byExt;
}

// ── gateway client ───────────────────────────────────────────────────────────────────────────

type Frame = { event: string; payload: Record<string, unknown> };

class Operator {
  readonly events: Frame[] = [];
  private client: GatewayClient | null = null;

  constructor(
    private readonly port: number,
    private readonly token: string,
    private readonly identityPath: string,
  ) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no hello-ok within 15 s")), 15_000);
      this.client = new GatewayClient({
        url: `ws://127.0.0.1:${this.port}`,
        token: this.token,
        clientName: GATEWAY_CLIENT_NAMES.CLI,
        clientDisplayName: "acceptance",
        clientVersion: VERSION,
        mode: GATEWAY_CLIENT_MODES.CLI,
        role: "operator",
        scopes: ["operator.admin", "operator.approvals", "operator.pairing"],
        deviceIdentity: loadOrCreateDeviceIdentity(this.identityPath),
        onEvent: (evt) => {
          this.events.push({
            event: evt.event,
            payload: (evt.payload ?? {}) as Record<string, unknown>,
          });
        },
        onHelloOk: () => {
          clearTimeout(timer);
          resolve();
        },
        onConnectError: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.client.start();
    });
  }

  async call<T = Record<string, unknown>>(method: string, params: unknown): Promise<T> {
    return (await this.client!.request(method, params)) as T;
  }

  async callError(method: string, params: unknown): Promise<string> {
    try {
      await this.client!.request(method, params);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    throw new Error(`${method} succeeded, expected a refusal`);
  }

  terminal(sessionId: string): Array<Record<string, unknown>> {
    return this.events
      .filter((e) => e.event === "terminal.event" && e.payload.sessionId === sessionId)
      .map((e) => e.payload);
  }

  stop() {
    this.client?.stop();
  }
}

async function invokeToolRaw(
  port: number,
  token: string,
  sessionKey: string,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ status: number; message?: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/tools/invoke`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ tool, args, sessionKey }),
  });
  const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
  return { status: res.status, message: body.error?.message };
}

type McpPage = { page?: { nextOffset: number | null }; result?: unknown; [k: string]: unknown };

/** Every page of one tool call (the server caps one response and pages with offset). */
async function callAllPages(
  mcp: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<McpPage[]> {
  const pages: McpPage[] = [];
  let offset: number | null = 0;
  while (offset !== null && pages.length < 50) {
    const res = await mcp.callTool({ name, arguments: { ...args, ...(offset ? { offset } : {}) } });
    expect(res.isError ?? false, `${name}: ${JSON.stringify(res.content).slice(0, 500)}`).toBe(
      false,
    );
    const page = (res.structuredContent ?? {}) as McpPage;
    pages.push(page);
    offset = page.page?.nextOffset ?? null;
  }
  return pages;
}

/** The product's MCP server for one project folder, over stdio, from the built CLI. */
async function openMcp(t: Tmp): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [ENTRY, "legacy", "mcp", "--root", t.folder],
    cwd: t.root,
    env: productEnv(t, t.port) as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "kurahi-acceptance", version: VERSION });
  await client.connect(transport);
  return client;
}

type AuditEntry = { action: string; outcome: string; detail?: unknown; seq: number };

function readAudit(state: string): AuditEntry[] {
  const dir = path.join(state, "audit");
  return fs
    .readdirSync(dir)
    .filter((f) => /^audit-\d{4}-\d{2}\.jsonl$/.test(f))
    .sort()
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").split("\n").filter(Boolean))
    .map((l) => JSON.parse(l) as AuditEntry);
}

// ── the test ─────────────────────────────────────────────────────────────────────────────────

const CITATION = /source\/[A-Za-z0-9_./-]+\.(?:cbl|jcl|java|sql|ddl|f|f90|CMN|pli|plinc):\d+/g;

describe.skipIf(!HAS_DIST)(`Kurahi ${TARGET_RELEASE} Industrial Edition acceptance`, () => {
  const notes: string[] = [];
  let t: Tmp;
  let gateway: ChildProcess | null = null;
  const gatewayLog: string[] = [];
  let token = "";
  let op: Operator;
  let projectId = "";
  let sessionKey = "";
  const docs: Record<string, string> = {};

  beforeAll(async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-accept-")));
    t = {
      root,
      home: path.join(root, "home"),
      state: path.join(root, "kurahi-home"),
      folder: path.join(root, "client", "payroll-estate"),
      exportDir: path.join(root, "export"),
      port: await pickPort(),
    };
    fs.mkdirSync(t.home, { recursive: true });
    fs.mkdirSync(t.exportDir, { recursive: true });
  }, STEP_TIMEOUT);

  afterAll(async () => {
    op?.stop();
    if (gateway && gateway.exitCode === null) {
      gateway.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise<boolean>((r) => gateway!.once("exit", () => r(true))),
        sleep(10_000).then(() => false),
      ]);
      if (!exited) {
        gateway.kill("SIGKILL");
      }
    }
    if (VERSION !== TARGET_RELEASE) {
      notes.unshift(
        `Release metadata: package.json says ${VERSION}, the release under acceptance is ${TARGET_RELEASE}; CHANGELOG.md has no ${TARGET_RELEASE} section yet. Bump both when cutting the release, then rerun (the /health version check follows package.json).`,
      );
    }
    notes.push(
      "Regression guards in this test (bugs found and fixed on branch kolo-2-rel-accept): byte-identical analyser output across two `kurahi legacy mcp` processes (the analyser counted the MCP server's own `.kurahi/` call log as a source-tree file); authenticated /health `healthy` for a `kurahi init --provider local` installation (it reported auth `missing` / `degraded` for ever); the legacy template promising FORTRAN and PL/I, which modernise_plan reports active (its description and agent instruction said they were not covered).",
    );
    writeReport({ notes });
    if (t?.root && !process.env.KURAHI_ACCEPT_KEEP) {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  }, 30_000);

  it(
    "1. installs with secure defaults, selects the Industrial edition and starts the gateway",
    async () => {
      await step("1", async (ev) => {
        const init = cli(t, [
          "init",
          "--non-interactive",
          "--name",
          IDENTITY,
          "--phone",
          "skip",
          // On-premises model: the Industrial default. No model is called by this test.
          "--provider",
          "local",
          "--provider-model",
          LOCAL_MODEL,
          "--json",
        ]);
        expect(init.code, init.stderr.slice(0, 2000)).toBe(0);
        const out = JSON.parse(init.stdout) as {
          ok: boolean;
          koloHome: string;
          tokenFile: string;
          secureDefaults: { applied: string[]; legacy: string[] };
          policy: { installed: boolean };
        };
        expect(out.ok).toBe(true);
        expect(out.koloHome).toBe(t.state);
        for (const key of [
          "auth.isolation=explicit",
          "agents.defaults.sandbox.mode=non-main",
          "tools.exec.unsandboxed=approve",
          "integrity.supplyChain.mode=enforce",
          "memory.provenance.mode=enforce",
          "agents.messaging.signing.mode=enforce",
          "console.terminal.enabled=true",
          "console.terminal.actApprovals=always",
        ]) {
          expect(out.secureDefaults.applied).toContain(key);
        }
        expect(out.secureDefaults.legacy).toEqual([]);
        expect(out.policy.installed).toBe(true);
        token = fs.readFileSync(out.tokenFile, "utf8").trim();
        expect(token.length).toBeGreaterThanOrEqual(32);
        const mode = (fs.statSync(out.tokenFile).mode & 0o777).toString(8);
        expect(mode).toBe("600");
        ev(
          `\`kurahi init --non-interactive --name ${IDENTITY}\` exit 0; ${out.secureDefaults.applied.length} secure defaults applied, 0 legacy: ${out.secureDefaults.applied.join(", ")}`,
        );
        ev(`gateway token file created with mode ${mode}; signed starter policy installed`);

        // Edition: the Control UI chooses the edition manifest from its saved settings, default
        // "industrial" (ui/src/ui/storage.ts); there is no server-side edition key.
        const edition = getEditionManifest("industrial");
        expect(edition.licence.sku).toBe("kurahi-industrial");
        const ws = resolveWorkspaceId("industrial", undefined);
        expect(ws).toBe("industrial");
        const workspace = getWorkspaceManifest(ws);
        expect(workspace.navigation.map((n) => n.id)).toContain("modernize");
        expect(edition.availablePacks).toContain("modernisation");
        ev(
          `edition manifest \`industrial\` (sku ${edition.licence.sku}) → workspace \`${ws}\` (navigation: ${workspace.navigation.map((n) => n.id).join(", ")}); packs: ${edition.availablePacks.join(", ")}`,
        );
        const known = new Set(
          fs
            .readdirSync(path.join(REPO, "templates", "projects"))
            .map((f) => f.replace(/\.json$/, "")),
        );
        const dangling = workspace.projectTemplates.filter((id) => !known.has(id));
        if (dangling.length > 0) {
          notes.push(
            `Finding (not fixed): the Industrial workspace manifest lists projectTemplates [${workspace.projectTemplates.join(", ")}], none of which is a shipped template (templates/projects/); the shipped Industrial template is \`${TEMPLATE}\`. The list is not read anywhere in the UI today, so customers are not affected; it should be aligned before the UI starts using it.`,
          );
        }
        notes.push(
          "Edition selection is presentation-only: the Control UI reads `edition`/`workspace` from its saved settings (localStorage `KoLo.control.settings.v1`, default industrial/industrial). No gateway config key selects an edition, so step 1 checks the manifest resolution the UI uses.",
        );

        const started = performance.now();
        const env = productEnv(t, t.port);
        gateway = spawn(
          process.execPath,
          [ENTRY, "gateway", "--port", String(t.port), "--bind", "loopback"],
          {
            cwd: t.root,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        gateway.stdout?.setEncoding("utf8");
        gateway.stderr?.setEncoding("utf8");
        const keep = (d: string) => {
          if (gatewayLog.join("").length < 200_000) {
            gatewayLog.push(d);
          }
        };
        gateway.stdout?.on("data", keep);
        gateway.stderr?.on("data", keep);
        const health = await until(
          "gateway /health",
          async () => {
            if (gateway?.exitCode !== null) {
              throw new Error(
                `gateway exited ${gateway?.exitCode}: ${gatewayLog.join("").slice(-2000)}`,
              );
            }
            try {
              const r = await fetch(`http://127.0.0.1:${t.port}/health`);
              return r.ok ? ((await r.json()) as { status: string; version: string }) : undefined;
            } catch {
              return undefined;
            }
          },
          60_000,
        );
        expect(health.version).toBe(VERSION);
        ev(
          `gateway listening on 127.0.0.1:${t.port} after ${fmtMs(Math.round(performance.now() - started))}; /health status \`${health.status}\`, version ${health.version}`,
        );
        const logText = gatewayLog.join("");
        expect(logText).toMatch(/policy gate: starter loaded \(signed, mode enforce\)/);
        ev("gateway log: `policy gate: starter loaded (signed, mode enforce)`");

        op = new Operator(t.port, token, path.join(t.root, "operator-device.json"));
        await op.connect();
        ev("operator connected over WebSocket with the gateway token");
        const deep = (await (
          await fetch(`http://127.0.0.1:${t.port}/health`, {
            headers: { authorization: `Bearer ${token}` },
          })
        ).json()) as {
          status: string;
          auth: { status: string };
          integrity: unknown;
          readiness: string;
        };
        expect(deep.auth.status).toBe("ok");
        expect(deep.status).toBe("healthy");
        ev(
          `authenticated /health: status \`${deep.status}\`, auth \`${deep.auth.status}\` (local model ollama/${LOCAL_MODEL}, no credential needed), readiness \`${deep.readiness}\`, integrity ${JSON.stringify(deep.integrity)}`,
        );
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "2. creates an Industrial project from the legacy modernisation template in plan mode",
    async () => {
      await step("2", async (ev) => {
        const byExt = materialiseSource(t.folder);
        ev(
          `source tree materialised from payroll-poly + sci-batch fixtures: ${Object.entries(byExt)
            .map(([k, v]) => `${k}×${v}`)
            .join(", ")}`,
        );
        const { templates } = await op.call<{
          templates: Array<{
            id: string;
            name: Record<string, string>;
            description: Record<string, string>;
          }>;
        }>("projects.templates", {});
        const tpl = templates.find((x) => x.id === TEMPLATE);
        expect(tpl).toBeDefined();
        // The template promises what modernise_plan delivers (step 3): all five languages.
        expect(tpl!.description.en).toMatch(/Java, SQL DDL, FORTRAN and PL\/I/);
        const { project } = await op.call<{
          project: {
            id: string;
            mode: string;
            plugins: string[];
            templateId: string;
            folder: string;
          };
        }>("projects.create", {
          name: "Payroll estate (acceptance)",
          folder: t.folder,
          templateId: TEMPLATE,
          mode: "plan",
        });
        expect(project.templateId).toBe(TEMPLATE);
        expect(project.mode).toBe("plan");
        expect(project.plugins).toEqual(["legacy-analyzer"]);
        expect(project.folder).toBe(t.folder);
        for (const sub of ["plans", "output"]) {
          expect(fs.statSync(path.join(t.folder, sub)).isDirectory()).toBe(true);
        }
        projectId = project.id;
        sessionKey = projectSessionKey(IDENTITY, projectId, "accept");
        ev(
          `template \`${TEMPLATE}\` (${tpl!.name.ja} / ${tpl!.name.en}) → project ${projectId}, mode \`plan\` (計画), plugins [legacy-analyzer], folders plans/ and output/ created`,
        );
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "3. runs the analyser tools (kurahi legacy mcp over stdio) with citations, five languages and determinism",
    async () => {
      await step("3", async (ev) => {
        // The gateway's own tool path first: /tools/invoke with the project session key.
        const probe = await invokeToolRaw(t.port, token, sessionKey, "modernise_plan", {
          path: t.folder,
        });
        ev(
          `gateway \`POST /tools/invoke\` modernise_plan with the project session key: HTTP ${probe.status}${probe.message ? ` (${probe.message})` : ""}`,
        );
        if (probe.status !== 200) {
          notes.push(
            `Finding (not fixed): \`POST /tools/invoke\` does not expose project-scoped plugin tools. With the project session key (${"`agent:<id>:proj-<projectId>-<chat>`"}) the legacy analyser tools answer 404 "Tool not available", because src/gateway/invocable-tools.ts builds the list with createKoLoTools() and never adds the project's template plugins or the project permission guard that src/agents/pi-tools.ts applies for the embedded agent. Agents on the embedded runner are not affected; a CLI-bridged backend that reaches tools through /tools/invoke would not see the analyser in an Industrial project. Fixing it means porting the project scoping and guard into the shared resolver (a security-relevant change), so it is reported rather than patched here; step 3 uses the product's MCP server (\`kurahi legacy mcp --root\`), the other supported path.`,
          );
        }

        const calls: Array<[string, string, Record<string, unknown>]> = [
          ["plan", "modernise_plan", {}],
          ["doc-ja", "legacy_design_doc", { lang: "ja" }],
          ["doc-en", "legacy_design_doc", { lang: "en" }],
          ["wave", "legacy_wave_plan", { lang: "en" }],
          ["crud", "modernise_crud", {}],
          ["impact", "modernise_impact", { target: "EMPLOYEE" }],
        ];
        // Two independent server processes: determinism across runs, not a cache hit.
        const runs: Array<Record<string, { pages: McpPage[]; raw: string; ms: number }>> = [];
        for (let pass = 0; pass < 2; pass++) {
          const mcp = await openMcp(t);
          try {
            if (pass === 0) {
              const names = (await mcp.listTools()).tools.map((x) => x.name);
              for (const [, tool] of calls) {
                expect(names).toContain(tool);
              }
              ev(
                `\`kurahi legacy mcp --root <project>\` (stdio, built CLI) lists ${names.length} tools: ${names.join(", ")}`,
              );
            }
            const out: (typeof runs)[number] = {};
            for (const [key, tool, args] of calls) {
              const started = performance.now();
              const pages = await callAllPages(mcp, tool, args);
              out[key] = {
                pages,
                raw: pages.map((pg) => JSON.stringify(pg)).join("\n"),
                ms: Math.round(performance.now() - started),
              };
            }
            runs.push(out);
          } finally {
            await mcp.close();
          }
        }
        for (const [key, tool, args] of calls) {
          const first = runs[0][key].raw;
          const second = runs[1][key].raw;
          if (process.env.KURAHI_ACCEPT_DUMP) {
            fs.mkdirSync(process.env.KURAHI_ACCEPT_DUMP, { recursive: true });
            fs.writeFileSync(path.join(process.env.KURAHI_ACCEPT_DUMP, `${key}.1.json`), first);
            fs.writeFileSync(path.join(process.env.KURAHI_ACCEPT_DUMP, `${key}.2.json`), second);
          }
          const h1 = createHash("sha256").update(first).digest("hex");
          const h2 = createHash("sha256").update(second).digest("hex");
          expect(h2, `${tool} is deterministic across two server runs`).toBe(h1);
          const cites = new Set(first.match(CITATION) ?? []);
          expect(cites.size, `${tool} cites path:line`).toBeGreaterThan(0);
          ev(
            `\`${tool}\`${Object.keys(args).length ? ` ${JSON.stringify(args)}` : ""}: ${runs[0][key].pages.length} page(s), ${first.length} bytes, ${cites.size} distinct path:line citations, byte-identical across two server processes (sha256 ${h1.slice(0, 12)}), ${fmtMs(runs[0][key].ms)}`,
          );
        }
        const r = (key: string) =>
          runs[0][key].pages.map((pg) => pg.result as Record<string, unknown>);

        // modernise_plan: all five languages active, coverage present.
        const plan = r("plan")[0] as {
          languages: Array<{ id: string; status: string; analysedFiles: number }>;
          coverage: Record<string, unknown>;
        };
        const active = new Map(
          plan.languages.filter((l) => l.status === "active").map((l) => [l.id, l.analysedFiles]),
        );
        for (const lang of ["cobol", "java", "sql-ddl", "fortran", "pli"]) {
          expect(active.get(lang) ?? 0, `${lang} active with analysed files`).toBeGreaterThan(0);
        }
        for (const lang of ["cobol", "java", "sql", "fortran", "pli"]) {
          expect(plan.coverage, `coverage.${lang}`).toHaveProperty(lang);
        }
        ev(
          `modernise_plan languages: ${plan.languages.map((l) => `${l.id}=${l.status}${l.status === "active" ? `(${l.analysedFiles} files)` : ""}`).join(", ")}; coverage keys: ${Object.keys(plan.coverage).join(", ")}`,
        );

        // Design document, ja and en: every section, a coverage section, every fact line cited.
        for (const lang of ["ja", "en"] as const) {
          const parts = r(`doc-${lang}`).flatMap(
            (pg) => (pg.parts as Array<{ section: string; markdown: string }>) ?? [],
          );
          const sections = parts.map((p) => p.section);
          for (const sec of [
            "overview",
            "programs",
            "java",
            "fortran",
            "pli",
            "tables",
            "crud",
            "coverage",
          ]) {
            expect(sections, `${lang} design doc has ${sec}`).toContain(sec);
          }
          const md = parts.map((p) => p.markdown).join("\n");
          docs[`doc-${lang}`] = md;
          const uncited = uncitedFactLines(md);
          expect(uncited, `${lang}: fact lines without path:line`).toEqual([]);
          const cov = parts.find((p) => p.section === "coverage")!.markdown;
          expect(cov).toMatch(lang === "ja" ? /カバレッジ|網羅/ : /Coverage/);
          ev(
            `legacy_design_doc ${lang}: ${sections.length} sections (${sections.join(", ")}), ${md.length} chars, 0 uncited fact lines; coverage section ${cov.length} chars`,
          );
        }
        expect(docs["doc-ja"]).toContain("設計書");

        // Wave plan: a proposal for human review, cited.
        const wave = r("wave")[0] as { markdown: string; plan: { waves: unknown[] } };
        expect(wave.markdown).toMatch(/Proposal for human review/);
        expect(wave.markdown.match(CITATION)?.length ?? 0).toBeGreaterThan(0);
        ev(
          `legacy_wave_plan en: ${wave.plan.waves.length} wave(s), "Proposal for human review" banner present`,
        );

        // CRUD across languages, impact of a shared table across languages.
        const crud = r("crud")[0] as {
          tables: string[];
          rows: Array<{ language: string; table: string; evidence: Array<{ at: string }> }>;
        };
        expect(crud.tables).toEqual(expect.arrayContaining(["EMPLOYEE", "PAY_RESULT", "ACCOUNT"]));
        const crudLangs = [...new Set(crud.rows.map((x) => x.language))].sort();
        expect(crudLangs.length).toBeGreaterThanOrEqual(3);
        for (const row of crud.rows) {
          expect(row.evidence.length).toBeGreaterThan(0);
          for (const e of row.evidence) {
            expect(e.at).toMatch(/^source\/.+:\d+$/);
          }
        }
        ev(
          `modernise_crud: ${crud.rows.length} rows over ${crud.tables.length} tables, languages ${crudLangs.join(", ")}; every row carries path:line evidence`,
        );
        const impact = r("impact")[0] as {
          found: boolean;
          languages: string[];
          accessors: unknown[];
        };
        expect(impact.found).toBe(true);
        expect(impact.languages).toEqual(expect.arrayContaining(["COBOL", "Java", "SQL"]));
        ev(
          `modernise_impact EMPLOYEE: found, ${impact.accessors.length} accessors across ${impact.languages.join(", ")}`,
        );

        // The embedded agent's tool layer for the same project session (in-process, same home):
        // the analyser is there in plan mode and answers with the same facts as the MCP server.
        const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
        process.env.KOLO_HOME = t.state;
        process.env.KOLO_STATE_DIR = t.state;
        try {
          const { createKoLoCodingTools } = await import("../../src/agents/pi-tools.js");
          const tools = createKoLoCodingTools({
            sessionKey,
            workspaceDir: path.join(t.state, "workspace"),
            config: { plugins: { allow: ["legacy-analyzer"] } } as KoLoConfig,
          });
          const names = tools.map((x) => x.name);
          for (const name of LEGACY_ANALYZER_TOOLS) {
            expect(names, `agent tool ${name}`).toContain(name);
          }
          const agentPlan = await tools
            .find((x) => x.name === "modernise_plan")!
            .execute("accept-plan", { path: t.folder });
          const text = (
            agentPlan as { content: Array<{ type: string; text?: string }> }
          ).content.find((c) => c.type === "text")?.text;
          const parsed = JSON.parse(text ?? "{}") as {
            languages?: Array<{ id: string; status: string }>;
          };
          expect(parsed.languages?.map((l) => `${l.id}:${l.status}`)).toEqual(
            plan.languages.map((l) => `${l.id}:${l.status}`),
          );
          ev(
            `agent tool layer (createKoLoCodingTools, project session key, plan mode): all ${LEGACY_ANALYZER_TOOLS.length} analyser tools present; modernise_plan languages match the MCP server's`,
          );
        } finally {
          for (const [k, v] of [
            ["KOLO_HOME", saved.home],
            ["KOLO_STATE_DIR", saved.state],
          ] as const) {
            if (v === undefined) {
              delete process.env[k];
            } else {
              process.env[k] = v;
            }
          }
        }
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "4. saves the design document as an Artifact, exports it and verifies the .sha256 sidecar",
    async () => {
      await step("4", async (ev) => {
        const content = docs["doc-ja"];
        expect(content?.length ?? 0).toBeGreaterThan(1000);
        const saved = await op.call<{
          artifact: {
            id: string;
            status: string;
            versions: Array<{ sha256: string; size: number }>;
          };
        }>("artifacts.save", {
          title: "設計書 payroll-estate (ja)",
          type: "document",
          format: "md",
          content,
          projectId,
          sourceSession: sessionKey,
          note: "legacy_design_doc ja, acceptance run",
        });
        const id = saved.artifact.id;
        expect(saved.artifact.status).toBe("draft");
        expect(saved.artifact.versions[0].sha256).toBe(
          createHash("sha256").update(content, "utf8").digest("hex"),
        );
        ev(
          `artifacts.save → ${id} v1 draft, ${saved.artifact.versions[0].size} bytes, stored sha256 ${saved.artifact.versions[0].sha256.slice(0, 16)} = sha256 of the tool output`,
        );

        // Review by the author, approval by a different identity (four eyes).
        await op.call("artifacts.setStatus", { id, status: "review" });
        const sameUser = await op.callError("artifacts.setStatus", { id, status: "approved" });
        expect(sameUser).toMatch(/different user/);
        const reviewer = new Operator(t.port, token, path.join(t.root, "reviewer-device.json"));
        await reviewer.connect();
        try {
          await reviewer.call("artifacts.setStatus", {
            id,
            status: "approved",
            note: "acceptance reviewer",
          });
        } finally {
          reviewer.stop();
        }
        ev(
          'draft → review by the author; approval by the author refused ("approval needs a different user"); approved by a second device identity',
        );

        const got = await op.call<{
          artifact: {
            title: string;
            status: string;
            versions: Array<{ version: number; sha256: string }>;
          };
          content: string;
          version: number;
        }>("artifacts.get", { id });
        expect(got.artifact.status).toBe("approved");
        expect(got.content).toBe(content);
        const stored = got.artifact.versions.find((v) => v.version === got.version)!.sha256;
        // The Control UI's export (ui/src/ui/controllers/artifact-export.ts), written to disk.
        const exported = await buildArtifactExport({
          title: got.artifact.title,
          version: got.version,
          status: got.artifact.status,
          content: got.content,
          storedContentSha256: stored,
        });
        const file = path.join(t.exportDir, exported.filename);
        fs.writeFileSync(file, exported.payload);
        fs.writeFileSync(path.join(t.exportDir, exported.sidecarFilename), exported.sidecarPayload);
        expect(exported.sidecarPayload).toBe(`${exported.sha256}  ${exported.filename}\n`);
        expect(createHash("sha256").update(fs.readFileSync(file)).digest("hex")).toBe(
          exported.sha256,
        );
        expect(exported.payload).toContain(`stored sha256 ${stored}`);
        const check = spawnSync("sha256sum", ["-c", exported.sidecarFilename], {
          cwd: t.exportDir,
          encoding: "utf8",
        });
        expect(check.status, check.stderr).toBe(0);
        expect(check.stdout).toMatch(/: OK/);
        ev(
          `exported ${exported.filename} (${Buffer.byteLength(exported.payload)} bytes) + ${exported.sidecarFilename}; \`sha256sum -c\`: ${check.stdout.trim()}`,
        );
        // Tampering is caught.
        fs.appendFileSync(file, "\nedited after export\n");
        const tampered = spawnSync("sha256sum", ["-c", exported.sidecarFilename], {
          cwd: t.exportDir,
          encoding: "utf8",
        });
        expect(tampered.status).not.toBe(0);
        ev(
          `after appending a line to the export, \`sha256sum -c\` fails (exit ${tampered.status})`,
        );
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "5. terminal broker: plan, act and read modes with approvals, file.diff and audit",
    async () => {
      await step("5", async (ev) => {
        const typeLine = (sessionId: string, line: string) =>
          op.call("terminal.input", { sessionId, data: `${line}\r` });
        const eventsOf = (sessionId: string, type: string, runId?: string) =>
          op
            .terminal(sessionId)
            .filter((e) => e.type === type && (runId === undefined || e.runId === runId));
        const nextEvent = (sessionId: string, type: string, after: number, runId?: string) =>
          until(
            `terminal ${type}`,
            () => {
              const list = op.terminal(sessionId).slice(after);
              return list.find(
                (e) => e.type === type && (runId === undefined || e.runId === runId),
              );
            },
            20_000,
          );
        const stdoutOf = (sessionId: string, runId: string) =>
          eventsOf(sessionId, "stdout", runId)
            .map((e) => String(e.data))
            .join("");

        // ── plan mode (計画): read-only runs, a write waits for approval ──
        const plan = await op.call<{ sessionId: string; mode: string; sandboxed: boolean }>(
          "terminal.open",
          {
            projectId,
            name: "accept-plan",
          },
        );
        expect(plan.mode).toBe("plan");
        ev(
          `terminal.open in plan mode → session ${plan.sessionId.slice(0, 8)}…, mode ${plan.mode}, sandboxed ${plan.sandboxed}`,
        );
        let mark = op.terminal(plan.sessionId).length;
        await typeLine(plan.sessionId, "ls source");
        const lsExit = await nextEvent(plan.sessionId, "exit", mark);
        expect(lsExit.exitCode).toBe(0);
        expect(eventsOf(plan.sessionId, "approval.requested")).toHaveLength(0);
        expect(stdoutOf(plan.sessionId, String(lsExit.runId))).toMatch(/cobol/);
        expect(eventsOf(plan.sessionId, "file.diff", String(lsExit.runId))).toHaveLength(0);
        ev(`plan: \`ls source\` ran without approval, exit 0, output lists cobol/ …, no file.diff`);

        mark = op.terminal(plan.sessionId).length;
        const planTarget = path.join(t.folder, "output", "plan-note.txt");
        await typeLine(plan.sessionId, "touch output/plan-note.txt");
        const planAsk = await nextEvent(plan.sessionId, "approval.requested", mark);
        const planRun = String(planAsk.runId);
        const broadcast = await until("exec.approval.requested", () =>
          op.events.find(
            (e) => e.event === "exec.approval.requested" && e.payload.id === planAsk.approvalId,
          ),
        );
        expect(broadcast).toBeDefined();
        await sleep(500);
        expect(fs.existsSync(planTarget)).toBe(false);
        expect(eventsOf(plan.sessionId, "exit", planRun)).toHaveLength(0);
        await op.call("exec.approval.resolve", { id: planAsk.approvalId, decision: "deny" });
        const planResolved = await nextEvent(plan.sessionId, "approval.resolved", mark, planRun);
        expect(planResolved.decision).toBe("deny");
        await sleep(300);
        expect(fs.existsSync(planTarget)).toBe(false);
        expect(eventsOf(plan.sessionId, "exit", planRun)).toHaveLength(0);
        ev(
          `plan: \`touch output/plan-note.txt\` → approval.requested (risk ${JSON.stringify(planAsk.risk)}), exec.approval.requested broadcast; denied via exec.approval.resolve → approval.resolved deny, nothing ran, file not created`,
        );
        // The template marks source/ read-only. The terminal does not know folder rules: a write
        // into source/ is gated like any other write (approval), not refused. Record what happens.
        mark = op.terminal(plan.sessionId).length;
        const srcTarget = path.join(t.folder, "source", "cobol", "NEW.cbl");
        await typeLine(plan.sessionId, "touch source/cobol/NEW.cbl");
        const srcFirst = await until("source write decision", () =>
          op
            .terminal(plan.sessionId)
            .slice(mark)
            .find((e) => e.type === "approval.requested" || e.type === "notice"),
        );
        if (srcFirst.type === "approval.requested") {
          await op.call("exec.approval.resolve", { id: srcFirst.approvalId, decision: "deny" });
          await nextEvent(plan.sessionId, "approval.resolved", mark, String(srcFirst.runId));
          notes.push(
            "Observation (product decision, not changed): the template's read-only folders (`rules.readOnly`: source/, data/, docs/) are enforced for the agent's tools but not by the terminal broker. In plan mode (and in act mode, which gates writes the same way with `actApprovals: always`), `touch source/cobol/NEW.cbl` is not refused; it waits for an approval like any write, and an approver can let it through. This matches docs/work-console.md (\"every line that is not read-only waits for an explicit approval\"), but an Industrial customer may expect source/ to be immutable from the terminal as well.",
          );
        }
        await sleep(300);
        expect(fs.existsSync(srcTarget)).toBe(false);
        ev(
          `plan: \`touch source/cobol/NEW.cbl\` (template read-only folder) → ${srcFirst.type === "approval.requested" ? "approval.requested, not refused; denied, file not created" : `refused (${String(srcFirst.code)})`}`,
        );
        await op.call("terminal.close", { sessionId: plan.sessionId });

        // ── act mode (実行): a destructive command waits for approval, then runs ──
        await op.call("projects.setMode", { id: projectId, mode: "act" });
        const victim = path.join(t.folder, "output", "old-report.txt");
        fs.writeFileSync(victim, "line one\nline two\n");
        const act = await op.call<{ sessionId: string; mode: string }>("terminal.open", {
          projectId,
          name: "accept-act",
        });
        expect(act.mode).toBe("act");
        mark = op.terminal(act.sessionId).length;
        await typeLine(act.sessionId, "rm output/old-report.txt");
        const ask = await nextEvent(act.sessionId, "approval.requested", mark);
        const runId = String(ask.runId);
        const risks = (ask.risks as Array<{ code: string }>).map((r) => r.code);
        expect(risks).toContain("deletes-files");
        await sleep(1000);
        expect(fs.existsSync(victim), "nothing runs before approval").toBe(true);
        expect(eventsOf(act.sessionId, "exit", runId)).toHaveLength(0);
        ev(
          `act: \`rm output/old-report.txt\` → approval.requested (risks ${risks.join(", ")}); after 1 s the file still exists and no exit event`,
        );
        const decided = Date.now();
        await op.call("exec.approval.resolve", { id: ask.approvalId, decision: "allow-once" });
        const exit = await nextEvent(act.sessionId, "exit", mark, runId);
        expect(exit.exitCode).toBe(0);
        expect(fs.existsSync(victim)).toBe(false);
        const diff = await nextEvent(act.sessionId, "file.diff", mark, runId);
        const files = diff.files as Array<{ path: string; status: string; removed: number }>;
        expect(files).toEqual([
          expect.objectContaining({ path: "output/old-report.txt", status: "deleted", removed: 2 }),
        ]);
        const detail = await op.call<Record<string, unknown>>("terminal.diff", {
          diffId: diff.diffId,
        });
        expect(JSON.stringify(detail)).toContain("line two");
        ev(
          `approved (allow-once) via exec.approval.resolve; ran in ${fmtMs(Date.now() - decided)}, exit 0, file removed; file.diff ${String(diff.diffId).slice(0, 8)}…: ${files.map((f) => `${f.path} ${f.status} -${f.removed}`).join(", ")}; terminal.diff returns the removed lines`,
        );
        await op.call("terminal.close", { sessionId: act.sessionId });

        // ── audit: the hash-chained log has the whole story and verifies ──
        const entries = await until("terminal audit entries", () => {
          const all = readAudit(t.state);
          const exitEntry = all.find(
            (e) =>
              e.action === "terminal.exit" && (e.detail as { runId?: string })?.runId === runId,
          );
          return exitEntry ? all : undefined;
        });
        const forRun = (action: string) =>
          entries.find(
            (e) => e.action === action && (e.detail as { runId?: string })?.runId === runId,
          );
        expect(forRun("terminal.command")).toMatchObject({
          outcome: "ok",
          detail: { command: "rm output/old-report.txt", decision: "approve" },
        });
        expect(forRun("terminal.approval")).toMatchObject({
          outcome: "ok",
          detail: { decision: "allow-once" },
        });
        expect(forRun("terminal.exit")).toMatchObject({
          outcome: "ok",
          detail: { exitCode: 0, diff: { files: 1 } },
        });
        const planDenied = entries.find(
          (e) =>
            e.action === "terminal.approval" && (e.detail as { runId?: string })?.runId === planRun,
        );
        expect(planDenied).toMatchObject({ outcome: "denied", detail: { decision: "deny" } });
        expect(
          entries.some(
            (e) => e.action === "project.mode" && (e.detail as { to?: string })?.to === "act",
          ),
        ).toBe(true);
        const verify = cli(t, ["audit", "verify", "--json"]);
        expect(verify.code, verify.stdout.slice(0, 1000) + verify.stderr.slice(0, 1000)).toBe(0);
        ev(
          `audit log: terminal.command (decision approve) → terminal.approval ok allow-once → terminal.exit ok with diff, the plan-mode deny recorded as denied, project.mode → act; ${entries.length} entries; \`kurahi audit verify\` exit 0`,
        );

        // ── read mode (参照): no terminal at all ──
        await op.call("projects.setMode", { id: projectId, mode: "read" });
        const refused = await op.callError("terminal.open", { projectId, name: "accept-read" });
        expect(refused).toMatch(/read mode/);
        ev(`read mode: terminal.open refused ("${refused.slice(0, 120)}")`);
      });
    },
    STEP_TIMEOUT,
  );

  it(
    "6. security defaults are enforced and the built dist passes the family-internal check",
    async () => {
      await step("6", async (ev) => {
        const cfg = JSON.parse(
          fs.readFileSync(path.join(t.state, "kolo.json"), "utf8"),
        ) as KoLoConfig;
        expect(resolveSupplyChainMode(cfg)).toBe("enforce");
        expect(resolveMemoryProvenanceMode(cfg, IDENTITY)).toBe("enforce");
        expect(resolveAgentMessageSigning(cfg).mode).toBe("enforce");
        ev(
          "resolved from the installed config by the product's own resolvers: supply chain `enforce`, memory provenance `enforce` (agent acme), message signing `enforce`",
        );

        const verify = cli(t, ["skills", "verify", "--json"]);
        expect(verify.code, verify.stderr.slice(0, 1000)).toBe(0);
        const v = JSON.parse(verify.stdout) as {
          ok: boolean;
          mode: string;
          checks: Array<{ status: string }>;
        };
        expect(v.mode).toBe("enforce");
        expect(v.ok).toBe(true);
        const byStatus = v.checks.reduce<Record<string, number>>(
          (acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }),
          {},
        );
        ev(
          `\`kurahi skills verify --json\`: mode enforce, ok, ${v.checks.length} artifacts (${Object.entries(
            byStatus,
          )
            .map(([k, n]) => `${k} ${n}`)
            .join(", ")})`,
        );

        // Signing, live: an unsigned agent-to-agent message is rejected by the gateway.
        const forged = await op.callError("agent", {
          message: "forged inter-agent request",
          sessionKey: `agent:${IDENTITY}:main`,
          lane: "nested",
          idempotencyKey: `accept-${Date.now()}`,
        });
        expect(forged).toMatch(
          /inter-agent message rejected \(agents\.messaging\.signing\.mode=enforce\).*unsigned/,
        );
        ev(
          `gateway \`agent\` with an unsigned nested (agent-to-agent) message → rejected: "${forged.slice(0, 140)}"`,
        );

        const doctor = cli(t, ["doctor", "--json"]);
        const d = JSON.parse(doctor.stdout) as {
          ok: boolean;
          checks: Array<{ id: string; level: string; detail: string }>;
        };
        const sc = d.checks.find((c) => c.id === "supply-chain.lock");
        expect(sc?.detail).toMatch(/mode enforce/);
        const legacy = d.checks.filter((c) => c.id.startsWith("secure-defaults."));
        expect(legacy).toEqual([]);
        expect(d.checks.find((c) => c.id === "gateway.reachable")?.level).toBe("ok");
        ev(
          `\`kurahi doctor --json\`: ok ${d.ok}; supply-chain.lock "${sc?.detail}"; no secure-defaults.* warnings; gateway.reachable ok`,
        );

        const family = spawnSync(
          process.execPath,
          [path.join(REPO, "scripts", "family-internal-check.mjs")],
          {
            cwd: REPO,
            encoding: "utf8",
            timeout: 120_000,
          },
        );
        expect(
          family.status,
          `${family.stdout.slice(0, 2000)}${family.stderr.slice(0, 1000)}`,
        ).toBe(0);
        ev(
          `\`node scripts/family-internal-check.mjs\` over src/ and the built dist/: exit 0 (${family.stdout.trim().split("\n").at(-1)?.slice(0, 160)})`,
        );
      });
    },
    STEP_TIMEOUT,
  );
});
