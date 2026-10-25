import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import { ToolPermissionDeniedError } from "../agents/permissions.js";
import { getPluginToolMeta } from "../plugins/tools.js";
import { projectSessionKey, READ_MODE_TOOLS } from "../projects/scope.js";
import { createProject, setProjectMode, updateProject } from "../projects/store.js";
import { checkInvocableCapability, resolveInvocableTools } from "./invocable-tools.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-invoke-scope-test-"));
const home = path.join(tmpRoot, "state");
const prevHome = process.env.KOLO_HOME;
process.env.KOLO_HOME = home;

afterAll(() => {
  if (prevHome === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = prevHome;
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const cfg = {} as KoLoConfig;
const rules = {
  readOnly: ["source"],
  writable: ["output"],
  artifactApprovalRequired: false,
  instructions: [],
};

function makeProject(name: string) {
  const dir = path.join(tmpRoot, name);
  fs.mkdirSync(path.join(dir, "source"), { recursive: true });
  fs.mkdirSync(path.join(dir, "output"), { recursive: true });
  return createProject({ name, folder: fs.realpathSync(dir), rules }, { createdBy: "owner", home });
}

describe("gateway-invoked tools in a project session", () => {
  it("applies the project's mode: a read-mode session cannot run a non-read tool", async () => {
    const project = makeProject("read-mode");
    setProjectMode(project.id, "read", { home });
    const sessionKey = projectSessionKey("main", project.id, "c1");

    const plain = resolveInvocableTools({ cfg, sessionKey: "agent:main:main" });
    const outside = plain.tools.find(
      (t) => typeof t.execute === "function" && !READ_MODE_TOOLS.includes(t.name),
    );
    expect(outside, "a gateway tool outside read mode").toBeDefined();

    const resolved = resolveInvocableTools({ cfg, sessionKey });
    expect(checkInvocableCapability(resolved, outside!.name, "test").ok).toBe(true);
    const tool = resolved.tools.find((t) => t.name === outside!.name);
    expect(tool).toBeDefined();
    await expect(tool!.execute("t1", {})).rejects.toBeInstanceOf(ToolPermissionDeniedError);
  });

  it("refuses every tool for an unknown or archived project", () => {
    const unknown = resolveInvocableTools({
      cfg,
      sessionKey: projectSessionKey("main", "pzzzzzzzzzz", "c1"),
    });
    expect(unknown.tools).toEqual([]);
    expect(checkInvocableCapability(unknown, "agents_list", "test")).toEqual({
      ok: false,
      reason: "Permission denied: project not found or archived.",
    });

    const project = makeProject("archived");
    updateProject(project.id, { archived: true }, { home });
    const archived = resolveInvocableTools({
      cfg,
      sessionKey: projectSessionKey("main", project.id, "c1"),
    });
    expect(archived.tools).toEqual([]);
    expect(checkInvocableCapability(archived, "agents_list", "test").ok).toBe(false);
  });

  it("refuses an agent the project does not allow", () => {
    const project = makeProject("agents");
    const resolved = resolveInvocableTools({
      cfg,
      sessionKey: projectSessionKey("intruder", project.id, "c1"),
    });
    expect(resolved.tools).toEqual([]);
    expect(checkInvocableCapability(resolved, "agents_list", "test")).toEqual({
      ok: false,
      reason: "Permission denied: agent intruder is not allowed in this project.",
    });
  });

  it("keeps a project plugin tool's origin on its guard wrapper", () => {
    const dir = path.join(tmpRoot, "plugins");
    fs.mkdirSync(path.join(dir, "source"), { recursive: true });
    const project = createProject(
      { name: "plugins", folder: fs.realpathSync(dir), rules },
      {
        createdBy: "owner",
        home,
        template: { id: "t-legacy", plugins: ["legacy-analyzer"] } as never,
      },
    );
    const resolved = resolveInvocableTools({
      cfg,
      sessionKey: projectSessionKey("main", project.id, "c1"),
    });
    const tool = resolved.tools.find((t) => t.name === "legacy_index");
    expect(tool, "legacy_index from the project's plugin").toBeDefined();
    // The autopilot engine refuses a tool whose origin is not the plugin that declared it.
    expect(getPluginToolMeta(tool!)?.pluginId).toBe("legacy-analyzer");
  });

  it("leaves non-project sessions unchanged", () => {
    const resolved = resolveInvocableTools({ cfg, sessionKey: "agent:main:main" });
    expect(resolved.projectDenied).toBeUndefined();
    expect(resolved.tools.length).toBeGreaterThan(0);
  });
});
