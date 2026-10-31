import { describe, expect, it } from "vitest";
import { loadScopedKoLoPlugins } from "./loader.js";
import { getPluginToolMeta, resolveProjectScopedPluginTools } from "./tools.js";

// Project-scoped plugins: enabled for one project's sessions, never for the gateway.
const LEGACY = [
  "legacy_baseline_advance",
  "legacy_changes",
  "legacy_design_doc",
  "legacy_dictionary",
  "legacy_impact",
  "legacy_index",
  "legacy_query",
  "legacy_rules",
  "legacy_wave_plan",
  "modernise_crud",
  "modernise_impact",
  "modernise_import",
  "modernise_inventory",
  "modernise_plan",
  "modernise_verify",
];

function scopedTools(config: Record<string, unknown>, pluginIds = ["legacy-analyzer"]) {
  return resolveProjectScopedPluginTools({
    pluginIds,
    context: { config: config as never, workspaceDir: "/tmp" },
  });
}

describe("project-scoped plugins", () => {
  it("loads the legacy analyser's tools for a project while it is off for the gateway", () => {
    const tools = scopedTools({});
    expect(tools.map((t) => t.name).toSorted()).toEqual(LEGACY);
    expect(getPluginToolMeta(tools[0])?.pluginId).toBe("legacy-analyzer");
  });

  it("respects a config that blocks the plugin", () => {
    expect(scopedTools({ plugins: { deny: ["legacy-analyzer"] } })).toEqual([]);
    expect(scopedTools({ plugins: { enabled: false } })).toEqual([]);
    expect(scopedTools({ plugins: { allow: ["lobster"] } })).toEqual([]);
    expect(
      scopedTools({ plugins: { entries: { "legacy-analyzer": { enabled: false } } } }),
    ).toEqual([]);
  });

  it("refuses plugins that do not declare projectScope", () => {
    const registry = loadScopedKoLoPlugins({ config: {}, pluginIds: ["lobster", "nope"] });
    expect(registry.tools).toEqual([]);
    const messages = registry.diagnostics.map((d) => `${d.pluginId}: ${d.message}`);
    expect(messages).toContain(
      "lobster: only bundled plugins with projectScope: true can be enabled per project",
    );
    expect(messages).toContain("nope: plugin not found");
  });

  it("skips a plugin the gateway already enables (its tools come from the gateway registry)", () => {
    const registry = loadScopedKoLoPlugins({
      config: { plugins: { entries: { "legacy-analyzer": { enabled: true } } } },
      pluginIds: ["legacy-analyzer"],
    });
    expect(registry.tools).toEqual([]);
  });
});
