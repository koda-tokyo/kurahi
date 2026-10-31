import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import "./test-helpers/fast-coding-tools.js";
import type { KoLoConfig } from "../config/config.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import {
  checkToolPermission,
  classifyToolCall,
  extractPatchPaths,
  globToRegExp,
  parsePermissionRule,
  resolveToolPermissions,
  toPosixPath,
  ToolPermissionDeniedError,
  wrapToolWithPermissionGuard,
} from "./permissions.js";
import { createKoLoCodingTools } from "./pi-tools.js";

const WS = "/ws";

function ruleSet(rules: string[], workspaceDir = WS) {
  return resolveToolPermissions({ entry: rules, workspaceDir });
}

describe("globToRegExp (path mode)", () => {
  it("trailing /** matches contents and the base path itself", () => {
    const re = globToRegExp("/workspace/**", "path");
    expect(re.test("/workspace")).toBe(true);
    expect(re.test("/workspace/a")).toBe(true);
    expect(re.test("/workspace/a/b.txt")).toBe(true);
    expect(re.test("/workspacex")).toBe(false);
    expect(re.test("/etc/passwd")).toBe(false);
  });

  it("single * stays within a path segment", () => {
    const re = globToRegExp("/workspace/*", "path");
    expect(re.test("/workspace/a")).toBe(true);
    expect(re.test("/workspace/a/b")).toBe(false);
  });

  it("mid-pattern **/ matches zero or more directories", () => {
    const re = globToRegExp("/ws/**/x.txt", "path");
    expect(re.test("/ws/x.txt")).toBe(true);
    expect(re.test("/ws/a/b/x.txt")).toBe(true);
    expect(re.test("/ws/x.md")).toBe(false);
  });

  it("? matches exactly one non-separator char", () => {
    const re = globToRegExp("/ws/f?le", "path");
    expect(re.test("/ws/file")).toBe(true);
    expect(re.test("/ws/fale")).toBe(true);
    expect(re.test("/ws/ffile")).toBe(false);
    expect(re.test("/ws/f/le")).toBe(false);
  });

  it("escapes regex metacharacters in literal parts", () => {
    const re = globToRegExp("/ws/a+b(c).txt", "path");
    expect(re.test("/ws/a+b(c).txt")).toBe(true);
    expect(re.test("/ws/aabbc.txt")).toBe(false);
  });
});

describe("globToRegExp (command mode)", () => {
  it("prefix glob matches commands with arguments", () => {
    const re = globToRegExp("git *", "command");
    expect(re.test("git status")).toBe(true);
    expect(re.test("git commit -m 'x y'")).toBe(true);
    expect(re.test("git")).toBe(false);
    expect(re.test("gitx")).toBe(false);
    expect(re.test("rm -rf /")).toBe(false);
  });

  it("bare * matches any command", () => {
    expect(globToRegExp("*", "command").test("anything at all")).toBe(true);
  });
});

describe("parsePermissionRule", () => {
  it("parses absolute path rules", () => {
    const { rule, problem } = parsePermissionRule("write:/workspace/**", WS);
    expect(problem).toBeUndefined();
    expect(rule?.ruleClass).toBe("write");
    expect(rule?.pattern).toBe(toPosixPath(path.resolve("/workspace/**")));
  });

  it("resolves relative path rules against the workspace", () => {
    const { rule } = parsePermissionRule("write:out/**", WS);
    expect(rule?.pattern).toBe(toPosixPath(path.resolve(WS, "out/**")));
  });

  it("keeps universal patterns universal", () => {
    const { rule } = parsePermissionRule("read:**", WS);
    expect(rule?.pattern).toBe("**");
    expect(rule?.regex.test("/anywhere/at/all")).toBe(true);
  });

  it("lowercases the class", () => {
    const { rule } = parsePermissionRule("EXEC:git *", WS);
    expect(rule?.ruleClass).toBe("exec");
  });

  it("rejects malformed rules with a helpful problem", () => {
    expect(parsePermissionRule("nocolon", WS).problem).toContain("class:pattern");
    expect(parsePermissionRule(":pattern", WS).problem).toContain("class:pattern");
    expect(parsePermissionRule("write:", WS).problem).toContain("class:pattern");
    expect(parsePermissionRule("wr ite:x", WS).problem).toContain("alphanumeric");
  });
});

describe("resolveToolPermissions", () => {
  it("is inert when nothing is configured", () => {
    const set = resolveToolPermissions({ workspaceDir: WS });
    expect(set.active).toBe(false);
    expect(set.rules).toEqual([]);
  });

  it("merges defaults first, entry last", () => {
    const set = resolveToolPermissions({
      defaults: ["read:**"],
      entry: ["write:/ws/**"],
      workspaceDir: WS,
    });
    expect(set.active).toBe(true);
    expect(set.rules.map((r) => r.raw)).toEqual(["read:**", "write:/ws/**"]);
  });

  it("collects problems for malformed rules but keeps valid ones", () => {
    const set = resolveToolPermissions({
      entry: ["oops", "read:**"],
      workspaceDir: WS,
    });
    expect(set.rules).toHaveLength(1);
    expect(set.problems).toHaveLength(1);
  });
});

describe("classifyToolCall", () => {
  it("classifies the Claude-style file_path alias the file tools accept", () => {
    expect(classifyToolCall("read", { file_path: "/a" })).toEqual({
      toolClass: "read",
      targets: ["/a"],
    });
    expect(classifyToolCall("write", { file_path: "/b" }).targets).toEqual(["/b"]);
    expect(classifyToolCall("edit", { file_path: "/c" }).targets).toEqual(["/c"]);
    expect(classifyToolCall("read", { path: "/p", file_path: "/f" }).targets).toEqual(["/p"]);
  });

  it("classifies read/write/exec classes with targets", () => {
    expect(classifyToolCall("read", { path: "/a" })).toEqual({
      toolClass: "read",
      targets: ["/a"],
    });
    expect(classifyToolCall("write", { path: "/a" }).toolClass).toBe("write");
    expect(classifyToolCall("edit", { path: "/a" }).toolClass).toBe("write");
    expect(classifyToolCall("exec", { command: "ls -la" })).toEqual({
      toolClass: "exec",
      targets: ["ls -la"],
    });
    expect(classifyToolCall("bash", { command: "ls" }).toolClass).toBe("exec");
    expect(classifyToolCall("process", { action: "kill" })).toEqual({
      toolClass: "exec",
      targets: ["process:kill"],
    });
  });

  it("classifies modernise_verify as reads of every folder and file it is given", () => {
    expect(
      classifyToolCall("modernise_verify", {
        baseline: "src/v1",
        candidate: "src/v2",
        fixtures: "tests",
        change_spec: "chg.json",
      }),
    ).toEqual({ toolClass: "read", targets: ["src/v1", "src/v2", "tests", "chg.json"] });
    expect(classifyToolCall("modernise_verify", {})).toEqual({ toolClass: "read", targets: [""] });
  });

  it("classifies the legacy analyser tools as reads of their path", () => {
    for (const name of [
      "legacy_index",
      "legacy_query",
      "legacy_rules",
      "legacy_dictionary",
      "legacy_impact",
      "legacy_design_doc",
      "legacy_wave_plan",
      "legacy_changes",
      "legacy_baseline_advance",
      "modernise_plan",
      "modernise_crud",
      "modernise_impact",
      "modernise_inventory",
      "modernise_import",
    ]) {
      expect(classifyToolCall(name, { path: "/proj/source" })).toEqual({
        toolClass: "read",
        targets: ["/proj/source"],
      });
    }
    expect(
      checkToolPermission({
        toolName: "legacy_index",
        args: { path: "/elsewhere/_answer-keys/x" },
        permissionSet: {
          active: true,
          rules: [],
          problems: [],
          denyByDefault: ["read", "write", "exec"],
          denyPaths: [/\/_answer-keys(\/|$)/],
        },
        workspaceDir: "/proj",
      }).ok,
    ).toBe(false);
  });

  it("extracts every file from apply_patch payloads", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: /ws/a.txt",
      "@@ context @@",
      "*** Add File: /ws/b.txt",
      "+hello",
      "*** End Patch",
    ].join("\n");
    expect(classifyToolCall("apply_patch", { patch })).toEqual({
      toolClass: "write",
      targets: ["/ws/a.txt", "/ws/b.txt"],
    });
    expect(extractPatchPaths("not a patch")).toEqual([]);
  });

  it("leaves unclassified tools under their own class", () => {
    expect(classifyToolCall("message", { action: "send" })).toEqual({
      toolClass: "message",
      targets: [""],
    });
  });
});

describe("checkToolPermission", () => {
  it("allows everything when the guard is inert", () => {
    const set = resolveToolPermissions({ workspaceDir: WS });
    expect(
      checkToolPermission({
        toolName: "exec",
        args: { command: "rm -rf /" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(true);
  });

  it("read is allowed by default, write and exec are denied by default", () => {
    const set = ruleSet(["write:/ws/**"]);
    expect(
      checkToolPermission({
        toolName: "read",
        args: { path: "/anywhere" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(true);
    const denied = checkToolPermission({
      toolName: "exec",
      args: { command: "ls" },
      permissionSet: set,
      workspaceDir: WS,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) {
      expect(denied.rule).toBe("default-deny:exec");
      expect(denied.reason).toContain("Permission denied");
      expect(denied.reason).toContain("deny-by-default");
    }
  });

  it("allows writes inside the permitted tree and denies outside", () => {
    const set = ruleSet(["write:/ws/**"]);
    expect(
      checkToolPermission({
        toolName: "write",
        args: { path: "/ws/out.txt", content: "x" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(true);
    expect(
      checkToolPermission({
        toolName: "edit",
        args: { path: "/etc/passwd" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(false);
  });

  it("resolves relative targets against the workspace", () => {
    const set = ruleSet(["write:/ws/out/**"]);
    expect(
      checkToolPermission({
        toolName: "write",
        args: { path: "out/x.txt" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(true);
    expect(
      checkToolPermission({
        toolName: "write",
        args: { path: "src/x.txt" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(false);
  });

  it("normalises .. traversal before matching", () => {
    const set = ruleSet(["write:/ws/**"]);
    expect(
      checkToolPermission({
        toolName: "write",
        args: { path: "/ws/../etc/passwd" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(false);
    expect(
      checkToolPermission({
        toolName: "write",
        args: { path: "/ws/a/../b.txt" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(true);
  });

  it("matches exec commands by prefix glob", () => {
    const set = ruleSet(["exec:git *"]);
    expect(
      checkToolPermission({
        toolName: "exec",
        args: { command: "git status" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(true);
    expect(
      checkToolPermission({
        toolName: "exec",
        args: { command: "curl http://evil" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(false);
  });

  it("requires every apply_patch target to be allowed", () => {
    const set = ruleSet(["write:/ws/**"]);
    const goodPatch = "*** Update File: /ws/a.txt\n@@\n-x\n+y\n";
    const badPatch = "*** Update File: /ws/a.txt\n@@\n*** Update File: /etc/shadow\n@@\n";
    expect(
      checkToolPermission({
        toolName: "apply_patch",
        args: { patch: goodPatch },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(true);
    expect(
      checkToolPermission({
        toolName: "apply_patch",
        args: { patch: badPatch },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(false);
  });

  it("unclassified tools are allowed (governed by tools.allow/deny)", () => {
    const set = ruleSet(["read:**", "write:/ws/**", "exec:git *"]);
    expect(
      checkToolPermission({
        toolName: "message",
        args: { action: "send" },
        permissionSet: set,
        workspaceDir: WS,
      }).ok,
    ).toBe(true);
  });
});

describe("wrapToolWithPermissionGuard", () => {
  const makeTool = (name: string, execute = vi.fn(async () => ({ content: [], details: {} }))) =>
    ({ name, label: name, description: name, parameters: {}, execute }) as unknown as AnyAgentTool;

  it("is inert when no rules are configured", () => {
    const tool = makeTool("exec");
    const set = resolveToolPermissions({ workspaceDir: WS });
    expect(wrapToolWithPermissionGuard(tool, { permissionSet: set, workspaceDir: WS })).toBe(tool);
  });

  it("denies with a model-visible error and does not execute", async () => {
    const execute = vi.fn();
    const tool = makeTool("exec", execute);
    const set = ruleSet(["exec:git *"]);
    const guarded = wrapToolWithPermissionGuard(tool, {
      permissionSet: set,
      workspaceDir: WS,
      agentId: "main",
      sessionKey: "agent:main:main",
    });
    await expect(
      guarded.execute("call-1", { command: "rm -rf /tmp/x" } as never, undefined, undefined),
    ).rejects.toBeInstanceOf(ToolPermissionDeniedError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes allowed calls through to the tool", async () => {
    const execute = vi.fn(async () => ({ content: [], details: {} }));
    const tool = makeTool("exec", execute);
    const set = ruleSet(["exec:git *"]);
    const guarded = wrapToolWithPermissionGuard(tool, { permissionSet: set, workspaceDir: WS });
    await guarded.execute("call-2", { command: "git status" } as never, undefined, undefined);
    expect(execute).toHaveBeenCalledOnce();
  });
});

describe("createKoLoCodingTools permission integration", () => {
  const tmpWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-perm-"));
  afterAll(() => {
    fs.rmSync(tmpWorkspace, { recursive: true, force: true });
  });

  function buildTools(permissions: string[], defaults?: string[]) {
    const cfg = {
      tools: { exec: { security: "deny" } },
      agents: {
        defaults: defaults ? { permissions: defaults } : undefined,
        list: [{ id: "main", permissions }],
      },
    } as unknown as KoLoConfig;
    return createKoLoCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: tmpWorkspace,
      agentDir: tmpWorkspace,
    });
  }

  it("denies a write outside the permitted tree through the real dispatch", async () => {
    const tools = buildTools(["read:**", `write:${tmpWorkspace}/**`, "exec:git *"]);
    const writeTool = tools.find((tool) => tool.name === "write");
    expect(writeTool).toBeDefined();
    await expect(
      writeTool?.execute(
        "call-1",
        { path: "/etc/evil.txt", content: "nope" } as never,
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(ToolPermissionDeniedError);
  });

  it("allows a write inside the permitted tree", async () => {
    const tools = buildTools([`write:${tmpWorkspace}/**`]);
    const writeTool = tools.find((tool) => tool.name === "write");
    const target = path.join(tmpWorkspace, "ok.txt");
    await writeTool?.execute(
      "call-2",
      { path: target, content: "hi" } as never,
      undefined,
      undefined,
    );
    expect(fs.existsSync(target)).toBe(true);
  });

  it("denies non-matching exec commands and lets matching ones reach the exec policy", async () => {
    const tools = buildTools(["exec:git *"]);
    const execTool = tools.find((tool) => tool.name === "exec");
    expect(execTool).toBeDefined();
    await expect(
      execTool?.execute("call-3", { command: "rm -rf /tmp/x" } as never, undefined, undefined),
    ).rejects.toBeInstanceOf(ToolPermissionDeniedError);
    // "git status" passes the permission layer; the inner exec security policy
    // (deny) rejects it without running anything — either way, not a permission error.
    let permissionError = false;
    try {
      await execTool?.execute("call-4", { command: "git status" } as never, undefined, undefined);
    } catch (err) {
      permissionError = err instanceof ToolPermissionDeniedError;
    }
    expect(permissionError).toBe(false);
  });

  it("applies agents.defaults.permissions when the entry has none", async () => {
    const tools = buildTools([], [`write:${tmpWorkspace}/**`]);
    // Entry list is empty but defaults exist → merged set is active.
    const writeTool = tools.find((tool) => tool.name === "write");
    await expect(
      writeTool?.execute(
        "call-5",
        { path: "/etc/evil.txt", content: "nope" } as never,
        undefined,
        undefined,
      ),
    ).rejects.toBeInstanceOf(ToolPermissionDeniedError);
    const target = path.join(tmpWorkspace, "defaults-ok.txt");
    await writeTool?.execute(
      "call-6",
      { path: target, content: "hi" } as never,
      undefined,
      undefined,
    );
    expect(fs.existsSync(target)).toBe(true);
  });

  it("leaves tools untouched when no permissions are configured anywhere", async () => {
    const cfg = {
      tools: { exec: { security: "deny" } },
      agents: { list: [{ id: "main" }] },
    } as unknown as KoLoConfig;
    const tools = createKoLoCodingTools({
      config: cfg,
      sessionKey: "agent:main:main",
      workspaceDir: tmpWorkspace,
      agentDir: tmpWorkspace,
    });
    const writeTool = tools.find((tool) => tool.name === "write");
    const target = path.join(tmpWorkspace, "inert-ok.txt");
    // No permission rules → guard inert; the write succeeds as before this feature.
    await writeTool?.execute(
      "call-7",
      { path: target, content: "hi" } as never,
      undefined,
      undefined,
    );
    expect(fs.existsSync(target)).toBe(true);
  });
});
