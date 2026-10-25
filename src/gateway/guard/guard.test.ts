/**
 * guard/guard.test.ts — Unit tests for permission hardening module
 *
 * Operation Payback 🔴 — Iris
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProtected, validatePath } from "./path-guard.js";
import { decide, PermissionMode } from "./permission-modes.js";
import { classifyToolRisk, RiskTier, RiskFlag } from "./risk-classifier.js";

// ── Risk Classification ──────────────────────────────────────────

describe("classifyToolRisk", () => {
  it("classifies read-only tools as LOW risk", () => {
    const r = classifyToolRisk({ toolName: "read" });
    assert.equal(r.tier, RiskTier.LOW);
    assert.equal(r.isReadOnly, true);
    assert.equal(r.isDestructive, false);
  });

  it("classifies web_search as LOW (read-only)", () => {
    const r = classifyToolRisk({ toolName: "web_search" });
    assert.equal(r.tier, RiskTier.LOW);
    assert.equal(r.isReadOnly, true);
    assert.equal(r.hasNetworkAccess, true);
  });

  it("classifies exec as MEDIUM by default, HIGH with system commands", () => {
    const safe = classifyToolRisk({ toolName: "exec", command: "ls -la" });
    assert.equal(safe.tier, RiskTier.MEDIUM);
    assert.ok(safe.flags.includes(RiskFlag.SHELL_EXECUTION));

    const dangerous = classifyToolRisk({ toolName: "exec", command: "sudo rm -rf /" });
    assert.equal(dangerous.tier, RiskTier.HIGH);
    assert.ok(dangerous.flags.includes(RiskFlag.SYSTEM_CONFIG));
  });

  it("classifies write as MEDIUM (destructive)", () => {
    const r = classifyToolRisk({ toolName: "write" });
    assert.equal(r.tier, RiskTier.MEDIUM);
    assert.equal(r.isDestructive, true);
  });

  it("classifies gateway as HIGH (system config + process mgmt)", () => {
    const r = classifyToolRisk({ toolName: "gateway" });
    assert.equal(r.tier, RiskTier.HIGH);
    assert.ok(r.flags.includes(RiskFlag.SYSTEM_CONFIG));
    assert.ok(r.flags.includes(RiskFlag.PROCESS_MANAGEMENT));
  });

  it("classifies message.send as MEDIUM (network)", () => {
    const r = classifyToolRisk({ toolName: "message.send" });
    assert.equal(r.tier, RiskTier.MEDIUM);
    assert.equal(r.hasNetworkAccess, true);
  });
});

// ── Permission Modes ─────────────────────────────────────────────

describe("decide (permission modes)", () => {
  const ctx = { mode: PermissionMode.DEFAULT, sessionTrusted: false };

  it("YOLO mode denies everything", () => {
    const d = decide({
      toolName: "read",
      context: { ...ctx, mode: PermissionMode.YOLO },
    });
    assert.equal(d.action, "deny");
  });

  it("BYPASS mode allows everything in trusted session", () => {
    const d = decide({
      toolName: "write",
      context: { mode: PermissionMode.BYPASS, sessionTrusted: true },
    });
    assert.equal(d.action, "allow");
  });

  it("AUTO mode auto-approves LOW risk", () => {
    const d = decide({
      toolName: "read",
      context: { ...ctx, mode: PermissionMode.AUTO },
    });
    assert.equal(d.action, "allow");
  });

  it("AUTO mode asks for HIGH risk", () => {
    const d = decide({
      toolName: "gateway",
      context: { ...ctx, mode: PermissionMode.AUTO },
    });
    assert.equal(d.action, "ask");
  });

  it("DEFAULT mode asks for most operations", () => {
    const d = decide({
      toolName: "write",
      context: ctx,
    });
    assert.equal(d.action, "ask");
  });

  it("session overrides take precedence", () => {
    const d = decide({
      toolName: "exec",
      command: "sudo rm -rf /",
      context: {
        ...ctx,
        mode: PermissionMode.DEFAULT,
        sessionOverrides: { exec: "deny" },
      },
    });
    assert.equal(d.action, "deny");
  });
});

// ── Path Protection ──────────────────────────────────────────────

describe("isProtected", () => {
  it("flags .env files", () => {
    const r = isProtected("/home/user/project/.env");
    assert.equal(r.protected, true);
    assert.ok(r.reason.includes(".env"));
  });

  it("flags .gitconfig files", () => {
    const r = isProtected("/home/user/.gitconfig");
    assert.equal(r.protected, true);
  });

  it("allows normal project files", () => {
    const r = isProtected("/home/user/project/src/main.ts");
    assert.equal(r.protected, false);
  });

  it("flags .ssh directory", () => {
    const r = isProtected("/home/user/.ssh/id_rsa");
    assert.equal(r.protected, true);
  });
});

describe("validatePath", () => {
  it("rejects paths outside allowed roots", async () => {
    const r = await validatePath("/etc/passwd", ["/home/user"]);
    assert.equal(r.safe, false);
  });

  it("allows paths within allowed roots", async () => {
    const r = await validatePath("/home/user/project/file.txt", ["/home/user"]);
    assert.equal(r.safe, true);
  });

  it("detects Unicode traversal: fullwidth dots", async () => {
    const r = await validatePath("/home/user/\uff0e\uff0e/etc/passwd", ["/home/user"]);
    assert.equal(r.safe, false);
  });

  it("resolves ../ traversal", async () => {
    const r = await validatePath("/home/user/../etc/passwd", ["/home/user"]);
    assert.equal(r.safe, false);
  });

  it("allows nested project paths", async () => {
    const r = await validatePath("/home/user/project/deep/nested/file.ts", ["/home/user/project"]);
    assert.equal(r.safe, true);
  });

  it("allows a root given through a symlink (macOS /var, /tmp, /home)", async ({ skip }) => {
    const base = await mkdtemp(join(tmpdir(), "kolo-guard-"));
    try {
      const real = join(base, "real");
      const link = join(base, "link");
      await mkdir(join(real, "src"), { recursive: true });
      try {
        await symlink(real, link);
      } catch (err) {
        if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") {
          // Symlink creation needs SeCreateSymbolicLinkPrivilege (admin or Developer Mode).
          skip("symlinks are not permitted for this Windows user");
        }
        throw err;
      }
      const viaLink = await validatePath(join(link, "src", "main.ts"), [link]);
      assert.equal(viaLink.safe, true);
      const mixed = await validatePath(join(real, "src", "main.ts"), [link]);
      assert.equal(mixed.safe, true);
      const outside = await validatePath(join(base, "elsewhere.ts"), [link]);
      assert.equal(outside.safe, false);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});

describe("guardToolCall baseDir", () => {
  it("resolves relative paths against baseDir before checking the roots", async () => {
    const { guardToolCall } = await import("./guard-integration.js");
    const os = await import("node:os");
    const fsm = await import("node:fs");
    const pathm = await import("node:path");
    const root = fsm.mkdtempSync(pathm.join(os.tmpdir(), "guard-base-"));
    fsm.mkdirSync(pathm.join(root, "source"));
    const inside = await guardToolCall({
      toolName: "read",
      args: { path: "source" },
      workspaceRoots: [root],
      baseDir: root,
    });
    expect(inside.blocked).toBe(false);
    const absolute = await guardToolCall({
      toolName: "read",
      args: { path: pathm.join(root, "source") },
      workspaceRoots: [root],
      baseDir: root,
    });
    expect(absolute.blocked).toBe(false);
    const escape = await guardToolCall({
      toolName: "read",
      args: { path: "../outside" },
      workspaceRoots: [root],
      baseDir: root,
    });
    expect(escape.blocked).toBe(true);
    fsm.rmSync(root, { recursive: true, force: true });
  });
});
