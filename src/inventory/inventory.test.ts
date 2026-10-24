import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { runInventoryExport, runInventoryShow, runInventoryVerify } from "../cli/inventory-cli.js";
import { EvidenceRecorder } from "../evidence/recorder.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import {
  buildInventory,
  finalizeInventory,
  inventoryConfigDigest,
  inventoryToCsv,
  redactEndpoint,
  verifyInventory,
} from "./inventory.js";

let home: string;
let env: NodeJS.ProcessEnv;
let out: string[];
let runtime: RuntimeEnv;

const cfg = {
  agents: {
    defaults: { model: { primary: "local/small-model" } },
    list: [
      {
        id: "ops-bot",
        default: true,
        name: "Ops",
        model: { primary: "acme/large", fallbacks: ["local/small-model"] },
        tools: { profile: "coding", deny: ["exec"] },
      },
      { id: "reporter" },
    ],
  },
  mcp: {
    servers: {
      crm: {
        transport: "http",
        url: "https://user:pw@crm.example.com/mcp?token=SECRET",
        headers: { authorization: "Bearer SECRET" },
      },
      files: {
        transport: "stdio",
        command: "/opt/tools/files-server",
        args: ["--key", "SECRET"],
        env: { API_KEY: "SECRET" },
        enabled: false,
      },
    },
  },
  channels: { defaults: {}, slack: { enabled: true }, telegram: { enabled: false } },
} as unknown as KoLoConfig;

function writePolicy(yaml: string) {
  fs.mkdirSync(path.join(home, "policy"), { recursive: true });
  fs.writeFileSync(path.join(home, "policy", "policy.yaml"), yaml);
}

function record(id: string, agent: string) {
  const idn = loadOrCreateDeviceIdentity(path.join(home, "identity", "continuity-signing.json"));
  const endedAt = new Date().toISOString();
  const r = new EvidenceRecorder(
    {
      id,
      agent,
      sessionKey: `agent:${agent}:main`,
      kind: "agent",
      startedAt: new Date(Date.parse(endedAt) - 1000).toISOString(),
    },
    { env, key: { privateKeyPem: idn.privateKeyPem, publicKeyPem: idn.publicKeyPem } },
  );
  r.start({ prompt: "hello" });
  r.finish({ status: "succeeded", steps: 0, toolCalls: 0, endedAt });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-inv-"));
  env = { ...process.env, KOLO_HOME: home, KOLO_STATE_DIR: home, KOLO_POLICY_MODE: "" };
  out = [];
  runtime = {
    log: (...a: unknown[]) => void out.push(a.join(" ")),
    error: (...a: unknown[]) => void out.push(a.join(" ")),
    exit: (code: number) => {
      throw new Error(`exit ${code}`);
    },
  };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("AI inventory", () => {
  test("lists agents, models, MCP servers and channels without secrets", () => {
    record("job-1", "ops-bot");
    record("job-2", "ops-bot");
    const inv = buildInventory(cfg, { env });
    expect(inv.agents.map((a) => a.id)).toEqual(["ops-bot", "reporter"]);
    const ops = inv.agents[0];
    expect(ops).toMatchObject({
      default: true,
      name: "Ops",
      model: {
        primary: "acme/large",
        fallbacks: ["local/small-model"],
        providers: ["acme", "local"],
      },
      tools: { profile: "coding", deny: ["exec"] },
      evidence: { jobs: 2 },
    });
    expect(inv.agents[1].model.primary).toBe("local/small-model");
    expect(inv.totals).toMatchObject({
      agents: 2,
      models: 2,
      providers: 2,
      mcpServers: 2,
      channels: 2,
      evidenceJobs: 2,
    });
    expect(inv.mcpServers).toEqual([
      {
        id: "crm",
        transport: "http",
        endpoint: "https://crm.example.com/mcp",
        enabled: true,
        allowTools: null,
      },
      {
        id: "files",
        transport: "stdio",
        endpoint: "files-server",
        enabled: false,
        allowTools: null,
      },
    ]);
    expect(inv.channels).toEqual([
      { id: "slack", enabled: true },
      { id: "telegram", enabled: false },
    ]);
    expect(inv.runtime.host).toBeNull();
    const text = JSON.stringify(inv);
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("user:pw");
    expect(inv.policy.state).toBe("absent");
  });

  test("binds policy rules, approvals, budgets and kill state to each agent", () => {
    writePolicy(
      [
        "version: 1",
        "agents:",
        '  "ops-*":',
        "    models: [acme/large]",
        "    tools: { deny: [browser] }",
        "approvals:",
        "  require:",
        "    - class: exec",
        "      agents: [ops-bot]",
        "    - class: write",
        "budgets:",
        "  agents:",
        "    reporter: { tokensPerDay: 1000 }",
        "kill:",
        "  agents: [reporter]",
        "attestation: { required: false }",
        "",
      ].join("\n"),
    );
    const inv = buildInventory(cfg, { env });
    expect(inv.policy.state).toBe("loaded");
    const [ops, rep] = inv.agents;
    expect(ops.policy).toMatchObject({
      rules: ["ops-*"],
      allowedModels: ["acme/large"],
      toolDeny: ["browser"],
      approvals: ["exec", "write"],
      budget: false,
      stopped: false,
    });
    expect(rep.policy).toMatchObject({
      rules: [],
      approvals: ["write"],
      budget: true,
      stopped: true,
    });
  });

  test("signed export verifies, and any edit breaks it", async () => {
    const file = path.join(home, "inv.json");
    await runInventoryExport({ output: file }, { runtime, env, config: cfg });
    expect(out[0]).toContain("signed");
    const inv = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(verifyInventory(inv)).toMatchObject({ ok: true, signed: true, signatureOk: true });
    out = [];
    await runInventoryVerify(file, {}, { runtime });
    expect(out[0]).toContain("inventory ok");

    inv.agents[0].model.primary = "other/model";
    fs.writeFileSync(file, JSON.stringify(inv));
    expect(verifyInventory(inv).ok).toBe(false);
    out = [];
    await expect(runInventoryVerify(file, {}, { runtime })).rejects.toThrow("exit 1");
    expect(out[0]).toContain("FAILED");

    // Re-digesting without the key still fails the signature.
    const forged = finalizeInventory({
      ...inv,
      digest: undefined,
      signer: undefined,
      signature: undefined,
    });
    const resigned = { ...forged, signer: inv.signer, signature: inv.signature };
    expect(verifyInventory(resigned)).toMatchObject({
      digestOk: true,
      signatureOk: false,
      ok: false,
    });
  });

  test("CSV has one quoted row per agent and neutralises formulas", () => {
    const body = buildInventory(
      {
        agents: { list: [{ id: "a1", name: "=HYPERLINK(1)", model: "p/m" }] },
      } as unknown as KoLoConfig,
      { env },
    );
    const csv = inventoryToCsv(body).trim().split("\n");
    expect(csv).toHaveLength(2);
    expect(csv[0].startsWith("agent,name,")).toBe(true);
    expect(csv[1]).toContain(`"'=HYPERLINK(1)"`);
  });

  test("table view and redaction helpers", async () => {
    await runInventoryShow({}, { runtime, env, config: cfg });
    expect(out[0]).toContain("2 agent(s)");
    expect(out.join("\n")).toContain("ops-bot (default) · Ops");
    expect(redactEndpoint({ url: "not a url" })).toBe("(invalid url)");
    expect(redactEndpoint({ command: "C:\\tools\\srv.exe" })).toBe("srv.exe");
  });

  test("the configuration digest ignores time and evidence counts but tracks configuration", () => {
    const before = inventoryConfigDigest(cfg, { env });
    record("job-3", "ops-bot");
    expect(inventoryConfigDigest(cfg, { env })).toBe(before);
    const changed = {
      ...cfg,
      agents: { ...cfg.agents, list: [...(cfg.agents?.list ?? []), { id: "new-agent" }] },
    } as unknown as KoLoConfig;
    expect(inventoryConfigDigest(changed, { env })).not.toBe(before);
    writePolicy("version: 1\nagents:\n  '*':\n    tools:\n      deny: [exec]\n");
    expect(inventoryConfigDigest(cfg, { env })).not.toBe(before);
  });
});
