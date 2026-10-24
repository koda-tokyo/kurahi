import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/types.js";
import { flushAudit } from "../audit/audit-log.js";
import { pinArtifacts } from "../cli/supply-chain-actions.js";
import { resetSupplyChainReports } from "../integrity/supply-chain-gate.js";
import { clearArtifactDigestCache } from "../integrity/supply-chain-hash.js";
import { clearLockStateCache } from "../integrity/supply-chain-lock.js";
import { loadKoLoPlugins } from "./loader.js";

let home: string;
let pluginDir: string;
let pluginFile: string;
const saved = {
  home: process.env.KOLO_HOME,
  bundled: process.env.KOLO_BUNDLED_PLUGINS_DIR,
};

function restore(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

const config = (mode: "warn" | "enforce"): KoLoConfig => ({
  integrity: { supplyChain: { mode } },
  plugins: { load: { paths: [pluginFile] }, allow: ["pinme"] },
});

const load = (mode: "warn" | "enforce") =>
  loadKoLoPlugins({
    cache: false,
    workspaceDir: pluginDir,
    config: config(mode),
    audit: true,
  }).plugins.find((p) => p.id === "pinme");

async function auditActions(): Promise<string[]> {
  await flushAudit();
  const dir = path.join(home, "audit");
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n"))
        .map((line) => (JSON.parse(line) as { action: string }).action)
    : [];
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-sc-plugin-"));
  process.env.KOLO_HOME = home;
  process.env.KOLO_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
  pluginDir = path.join(home, "ext");
  fs.mkdirSync(pluginDir, { recursive: true });
  pluginFile = path.join(pluginDir, "pinme.js");
  fs.writeFileSync(pluginFile, `export default { id: "pinme", register() {} };`);
  fs.writeFileSync(
    path.join(pluginDir, "KoLo.plugin.json"),
    JSON.stringify({
      id: "pinme",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  clearArtifactDigestCache();
  clearLockStateCache();
  resetSupplyChainReports();
});

afterEach(async () => {
  await flushAudit();
  restore("KOLO_HOME", saved.home);
  restore("KOLO_BUNDLED_PLUGINS_DIR", saved.bundled);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("plugin loader supply-chain gate", () => {
  it("warn loads an unpinned plugin; enforce quarantines it before import and audits", async () => {
    expect(load("warn")?.status).toBe("loaded");
    const refused = load("enforce");
    expect(refused?.status).toBe("error");
    expect(refused?.error).toMatch(/supply-chain refused: plugin "pinme".*not pinned/);
    expect(await auditActions()).toContain("supply-chain.refused");
  });

  it("a pinned plugin loads in enforce until its file changes", () => {
    const res = pinArtifacts({
      kind: "plugin",
      artifacts: [{ kind: "plugin", name: "pinme", target: pluginFile, bundled: false }],
      names: ["pinme"],
      all: false,
      force: false,
    });
    expect(res.outcomes[0].status).toBe("pinned");
    expect(load("enforce")?.status).toBe("loaded");
    fs.appendFileSync(pluginFile, "\n// changed\n");
    expect(load("enforce")?.error).toMatch(/changed since it was pinned/);
  });
});
