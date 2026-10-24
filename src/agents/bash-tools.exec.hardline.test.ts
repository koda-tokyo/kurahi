import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalsResolved } from "../infra/exec-approvals.js";
import { flushAudit, listAuditMonths, auditFileForMonth } from "../audit/audit-log.js";
import { onAuditEvent, type AuditEvent } from "../security/audit-log.js";
import { EXEC_GUARD_AUDIT_ACTION } from "../security/exec-guard.js";

// Approvals wide open: the hardline floor must refuse even with security=full and ask=off.
vi.mock("../infra/exec-approvals.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/exec-approvals.js")>();
  const open = {
    security: "full",
    ask: "off",
    askFallback: "full",
    autoAllowSkills: false,
  } as const;
  const approvals: ExecApprovalsResolved = {
    path: "/tmp/exec-approvals.json",
    socketPath: "/tmp/exec-approvals.sock",
    token: "token",
    defaults: { ...open },
    agent: { ...open },
    allowlist: [],
    file: {
      version: 1,
      socket: { path: "/tmp/exec-approvals.sock", token: "token" },
      defaults: { ...open },
      agents: {},
    },
  };
  return { ...mod, resolveExecApprovals: () => approvals };
});

vi.mock("../infra/shell-env.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../infra/shell-env.js")>();
  return { ...mod, getShellPathFromLoginShell: vi.fn(() => null) };
});

const isWin = process.platform === "win32";

let home: string;
let prevHome: string | undefined;
let events: AuditEvent[];
let stop: () => void;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-exec-guard-"));
  prevHome = process.env.KOLO_HOME;
  process.env.KOLO_HOME = home;
  events = [];
  stop = onAuditEvent((e) => {
    if (e.action === EXEC_GUARD_AUDIT_ACTION) {
      events.push(e);
    }
  });
});

afterEach(async () => {
  stop();
  await flushAudit();
  if (prevHome === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = prevHome;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function auditLines(): Array<Record<string, unknown>> {
  const dir = path.join(home, "audit");
  return listAuditMonths(dir).flatMap((m) =>
    fs
      .readFileSync(auditFileForMonth(dir, m), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>),
  );
}

describe.skipIf(isWin)("exec tool: destructive-command guard", () => {
  it("refuses a hardline command before it runs, even with security=full, and audits it", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const marker = path.join(home, "should-not-exist");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off", agentId: "main" });
    await expect(tool.execute("call-1", { command: `touch ${marker}; rm -rf /` })).rejects.toThrow(
      /BLOCKED \(hardline\): recursive delete of root filesystem/,
    );
    expect(fs.existsSync(marker)).toBe(false);

    // Elevated full mode does not bypass the floor either.
    const elevated = createExecTool({
      host: "gateway",
      security: "full",
      ask: "off",
      elevated: { enabled: true, allowed: true, defaultLevel: "full" },
    });
    await expect(elevated.execute("call-2", { command: "mkfs.ext4 /dev/sdb1" })).rejects.toThrow(
      /hardline/,
    );

    expect(events.map((e) => [e.outcome, (e.detail as { pattern?: string }).pattern])).toEqual([
      ["denied", "rm-rootfs"],
      ["denied", "mkfs"],
    ]);
    await flushAudit();
    const denied = auditLines().filter(
      (l) => l.action === EXEC_GUARD_AUDIT_ACTION && l.outcome === "denied",
    );
    expect(denied).toHaveLength(2);
    expect(denied[0]).toMatchObject({ source: "exec", identity: "main" });
  });

  it("lets a normal command run and audits it as allowed", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const tool = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const result = await tool.execute("call-3", { command: "echo kurahi-ok" });
    const text = result.content.find((c) => c.type === "text")?.text ?? "";
    expect(text).toContain("kurahi-ok");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ outcome: "allowed", source: "exec" });
    await flushAudit();
    const lines = auditLines().filter((l) => l.action === EXEC_GUARD_AUDIT_ACTION);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "ok", source: "exec" });
    expect((lines[0].detail as { command: string }).command).toBe("echo kurahi-ok");
  });

  it("refuses a destructive command typed into a running shell through the process tool", async () => {
    const { createExecTool } = await import("./bash-tools.exec.js");
    const { createProcessTool } = await import("./bash-tools.process.js");
    const exec = createExecTool({ host: "gateway", security: "full", ask: "off" });
    const proc = createProcessTool({ agentId: "main", sessionKey: "agent:main:main" });
    const started = await exec.execute("call-4", { command: "cat", background: true });
    const sessionId = (started.details as { sessionId?: string }).sessionId;
    expect(sessionId).toBeTruthy();
    try {
      // Typed in two writes: the guard joins the unterminated line.
      await proc.execute("call-5", { action: "write", sessionId, data: "rm -rf " });
      await expect(
        proc.execute("call-6", { action: "write", sessionId, data: "/\n" }),
      ).rejects.toThrow(/hardline/);
      const ok = await proc.execute("call-7", { action: "write", sessionId, data: "hello\n" });
      expect(ok.details).toMatchObject({ status: "running" });
    } finally {
      await proc.execute("call-8", { action: "kill", sessionId });
    }
    expect(events.filter((e) => e.outcome === "denied")).toHaveLength(1);
    expect(events.find((e) => e.outcome === "denied")).toMatchObject({ source: "process.write" });
  });
});
