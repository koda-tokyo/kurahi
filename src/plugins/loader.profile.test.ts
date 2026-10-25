import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/types.js";
import { flushAudit } from "../audit/audit-log.js";
import { normalizePluginsConfig } from "./config-state.js";
import { loadKoLoPlugins } from "./loader.js";
import { decidePluginForProfile } from "./profile-gate.js";

let home: string;
const saved = {
  home: process.env.KOLO_HOME,
  bundled: process.env.KOLO_BUNDLED_PLUGINS_DIR,
  profile: process.env.KURAHI_PROFILE,
};

function restore(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

/** A plugin copied into a plugin directory by hand, outside the package. */
function copyIn(id: string): string {
  const dir = path.join(home, "extensions", id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.js`);
  fs.writeFileSync(file, `export default { id: ${JSON.stringify(id)}, register() {} };`);
  fs.writeFileSync(
    path.join(dir, "KoLo.plugin.json"),
    JSON.stringify({
      id,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  return file;
}

function load(files: string[], cfg: KoLoConfig = {}) {
  return loadKoLoPlugins({
    cache: false,
    workspaceDir: home,
    audit: true,
    config: {
      ...cfg,
      plugins: {
        ...cfg.plugins,
        load: { paths: files },
        entries: Object.fromEntries(files.map((f) => [path.basename(f, ".js"), { enabled: true }])),
      },
    },
  });
}

async function auditRows(): Promise<Array<{ action: string; outcome: string; detail?: unknown }>> {
  await flushAudit();
  const dir = path.join(home, "audit");
  return fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".jsonl"))
        .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n"))
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-profile-plugin-"));
  process.env.KOLO_HOME = home;
  process.env.KOLO_BUNDLED_PLUGINS_DIR = "/nonexistent/bundled/plugins";
  delete process.env.KURAHI_PROFILE;
});

afterEach(async () => {
  await flushAudit();
  restore("KOLO_HOME", saved.home);
  restore("KOLO_BUNDLED_PLUGINS_DIR", saved.bundled);
  restore("KURAHI_PROFILE", saved.profile);
  fs.rmSync(home, { recursive: true, force: true });
});

describe("plugin loader release-profile gate", () => {
  it("loads an excluded plugin under the standard profile", () => {
    const registry = load([copyIn("telegram")]);
    expect(registry.plugins.find((p) => p.id === "telegram")?.status).toBe("loaded");
  });

  it("refuses an excluded plugin copied in and enabled under KURAHI_PROFILE=enterprise, audited", async () => {
    process.env.KURAHI_PROFILE = "enterprise";
    const registry = load([copyIn("telegram"), copyIn("office")]);
    const telegram = registry.plugins.find((p) => p.id === "telegram");
    expect(telegram?.status).toBe("disabled");
    expect(telegram?.error).toMatch(/refused by the enterprise profile \(excluded/);
    expect(registry.plugins.find((p) => p.id === "office")?.status).toBe("loaded");
    const rows = await auditRows();
    const refused = rows.filter((r) => r.action === "plugin.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({
      outcome: "denied",
      detail: { plugin: "telegram", profile: "enterprise", tier: "excluded" },
    });
  });

  it("the config profile works without the environment, and the environment cannot undo it", () => {
    process.env.KURAHI_PROFILE = "standard";
    const registry = load([copyIn("zalouser")], { profile: "enterprise" });
    expect(registry.plugins.find((p) => p.id === "zalouser")?.status).toBe("disabled");
  });

  it("optional and unclassified plugins need an explicit opt-in under the profile", () => {
    const normalized = (cfg: KoLoConfig["plugins"]) => normalizePluginsConfig(cfg);
    for (const pluginId of ["whatsapp", "acme-internal-tool"]) {
      expect(
        decidePluginForProfile({ profile: "enterprise", pluginId, normalized: normalized({}) })
          .allowed,
      ).toBe(false);
      expect(
        decidePluginForProfile({
          profile: "enterprise",
          pluginId,
          normalized: normalized({ entries: { [pluginId]: { enabled: true } } }),
        }).allowed,
      ).toBe(true);
    }
    // Excluded stays refused even when enabled and allow-listed.
    expect(
      decidePluginForProfile({
        profile: "enterprise",
        pluginId: "discord",
        normalized: normalized({ allow: ["discord"], entries: { discord: { enabled: true } } }),
      }),
    ).toMatchObject({ allowed: false, tier: "excluded" });
    expect(
      decidePluginForProfile({
        profile: "standard",
        pluginId: "discord",
        normalized: normalized({}),
      }).allowed,
    ).toBe(true);
  });
});
