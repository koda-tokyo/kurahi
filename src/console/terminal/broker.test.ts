import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalError } from "./broker.js";
import { createHarness, type Harness } from "./test-harness.js";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const errorCode = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return err instanceof TerminalError ? err.code : String(err);
  }
  return "no error";
};

describe("terminal broker: opening", () => {
  it("is refused when the terminal is off", async () => {
    h = createHarness({ terminal: { enabled: false } });
    expect(await errorCode(h.open())).toBe("disabled");
  });

  it("is refused in read mode (参照), with an audit line", async () => {
    h = createHarness({ mode: "read" });
    expect(await errorCode(h.open())).toBe("read-mode");
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: "terminal.open",
        outcome: "denied",
        detail: expect.objectContaining({ code: "read-mode" }),
      }),
    ]);
  });

  it("is refused when the required sandbox cannot start (never runs on the host)", async () => {
    h = createHarness({
      terminal: { sandbox: "required" },
      createBackend: async () => {
        throw new Error("Cannot connect to the Docker daemon");
      },
    });
    expect(await errorCode(h.open())).toBe("sandbox-unavailable");
    expect(h.backend.spawns).toHaveLength(0);
  });

  it("opens at the project root with a ready notice and a prompt", async () => {
    h = createHarness({ mode: "plan" });
    const res = await h.open();
    expect(res).toMatchObject({ mode: "plan", cwd: ".", sandboxed: false, seq: 2 });
    expect(h.events[0]).toMatchObject({ type: "notice", code: "ready", seq: 1 });
    expect(h.stdout()).toBe("~ $ ");
  });

  it("refuses a replay cursor newer than the last event instead of an empty page", async () => {
    h = createHarness({ mode: "plan" });
    const { sessionId, seq } = await h.open();
    expect(h.broker.replay(sessionId, "owner", seq)).toMatchObject({
      events: [],
      hasMore: false,
      lastSeq: seq,
    });
    expect(
      await errorCode(Promise.resolve().then(() => h?.broker.replay(sessionId, "owner", seq + 1))),
    ).toBe("cursor-ahead");
  });
});

describe("terminal broker: line gate", () => {
  it("plan mode runs read-only lines at the project root", async () => {
    h = createHarness({ mode: "plan" });
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "ls -la\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    const proc = h.backend.spawns[0];
    expect(proc.req).toMatchObject({ line: "ls -la", cwd: h.folder });
    expect(proc.req.env.HOME).toBe(h.folder);
    proc.out("a.txt\r\nsrc\r\n");
    proc.exit(0);
    await vi.waitFor(() => expect(h?.ofType("exit")).toHaveLength(1));
    expect(h.ofType("exit")[0]).toMatchObject({ exitCode: 0, reason: "exited" });
    expect(h.ofType("approval.requested")).toHaveLength(0);
    expect(h.stdout()).toContain("a.txt\r\nsrc\r\n");
  });

  it("plan mode asks before anything that is not read-only", async () => {
    h = createHarness({ mode: "plan" });
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "touch new.txt\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    expect(h.backend.spawns).toHaveLength(0);
  });

  it("a destructive command waits for approval and nothing reaches the PTY before it", async () => {
    h = createHarness();
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "rm -f a.txt\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    const req = h.ofType("approval.requested")[0];
    expect(req.risk).toEqual({ code: "deletes-files", params: { count: 1 } });
    expect(req.command).toBe("rm -f a.txt");
    expect(typeof req.runId).toBe("string");
    // Typing while the approval is pending does not reach any shell either.
    h.broker.input(sessionId, "owner", "echo sneaky\r");
    expect(h.backend.spawns).toHaveLength(0);
    expect(h.notices()).toContain("busy");

    h.approvals.resolve(req.approvalId, "deny");
    await vi.waitFor(() => expect(h?.notices()).toContain("approval-denied"));
    expect(h.backend.spawns).toHaveLength(0);
    expect(h.ofType("approval.resolved")[0]).toMatchObject({ decision: "deny", runId: req.runId });
  });

  it("an approved command runs, and its file changes arrive as a diff summary", async () => {
    h = createHarness();
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "rm -f a.txt\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    const req = h.ofType("approval.requested")[0];
    h.approvals.resolve(req.approvalId, "allow-once");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    const proc = h.backend.spawns[0];
    expect(proc.req.runId).toBe(req.runId);
    fs.rmSync(path.join(h.folder, "a.txt"));
    fs.writeFileSync(path.join(h.folder, "src", "main.ts"), "export const x = 2;\n");
    proc.exit(0);
    await vi.waitFor(() => expect(h?.ofType("file.diff")).toHaveLength(1));
    const diff = h.ofType("file.diff")[0];
    expect(diff).toMatchObject({
      runId: req.runId,
      totals: { files: 2, added: 1, removed: 4 },
      files: [
        { path: "a.txt", status: "deleted", added: 0, removed: 3 },
        { path: "src/main.ts", status: "modified", added: 1, removed: 1 },
      ],
    });
    const full = h.broker.diff(diff.diffId, "owner");
    expect(full.files[1].lines).toContain("+export const x = 2;");
    expect(full.nextCursor).toBeNull();
    expect(() => h?.broker.diff(diff.diffId, "someone-else")).toThrow(TerminalError);
  });

  it("refuses path escapes and hardline commands without asking", async () => {
    h = createHarness();
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "cat ../../etc/passwd\r");
    await vi.waitFor(() => expect(h?.notices()).toContain("path-escape"));
    h.broker.input(sessionId, "owner", "cd ..\r");
    await vi.waitFor(() => expect(h?.notices().filter((c) => c === "path-escape")).toHaveLength(2));
    h.broker.input(sessionId, "owner", "rm -rf /etc\r");
    await vi.waitFor(() => expect(h?.notices()).toContain("hardline-blocked"));
    h.broker.input(sessionId, "owner", "vim a.txt\r");
    await vi.waitFor(() => expect(h?.notices()).toContain("interactive-refused"));
    expect(h.ofType("approval.requested")).toHaveLength(0);
    expect(h.backend.spawns).toHaveLength(0);
  });

  it("cd stays inside the project and later commands run there", async () => {
    h = createHarness();
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "cd src\r");
    await vi.waitFor(() => expect(h?.notices()).toContain("cwd-changed"));
    expect(h.stdout()).toContain("~/src $ ");
    h.broker.input(sessionId, "owner", "ls\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    expect(h.backend.spawns[0].req.cwd).toBe(path.join(h.folder, "src"));
  });

  it("re-checks the project mode after the approval", async () => {
    h = createHarness();
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "touch b.txt\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    h.project.mode = "read";
    h.approvals.resolve(h.ofType("approval.requested")[0].approvalId, "allow-once");
    await vi.waitFor(() => expect(h?.notices()).toContain("read-mode"));
    expect(h.backend.spawns).toHaveLength(0);
  });

  it("policy mode: the allowlist decides, risky lines still ask", async () => {
    h = createHarness({
      terminal: { actApprovals: "policy" },
      policy: { security: "allowlist", ask: "on-miss", analysisOk: true, allowlistSatisfied: true },
    });
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "make build\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    h.backend.spawns[0].exit(0);
    await vi.waitFor(() => expect(h?.ofType("exit")).toHaveLength(1));
    h.broker.input(sessionId, "owner", "rm a.txt\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    expect(h.backend.spawns).toHaveLength(1);
  });
});

describe("terminal broker: redaction and audit", () => {
  it("never shows or logs secret values or env values", async () => {
    const secret = "gw-secret-0123456789abcdef";
    h = createHarness({ secretValues: [secret], mode: "plan" });
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "export API_TOKEN=abcdefghijklmnopqrstuvwxyz0123\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    h.backend.spawns[0].exit(0);
    await vi.waitFor(() => expect(h?.ofType("exit")).toHaveLength(1));
    h.broker.input(sessionId, "owner", "env\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(2));
    h.backend.spawns[1].out(`HOME=${h.folder}\r\nLEAK=${secret}\r\n`);
    h.backend.spawns[1].exit(0);
    await vi.waitFor(() => expect(h?.ofType("exit")).toHaveLength(2));

    const replayed = JSON.stringify(h.broker.replay(sessionId, "owner", 0).events);
    expect(replayed).not.toContain(secret);
    expect(replayed).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(replayed).not.toContain(`HOME=${h.folder}`);
    expect(replayed).toContain("HOME=[redacted]");
    const audit = JSON.stringify(h.audits);
    expect(audit).not.toContain(secret);
    expect(audit).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
  });

  it("audits open, command, approval, exit, cancel and close with the runId", async () => {
    h = createHarness();
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "touch b.txt\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    const { runId, approvalId } = h.ofType("approval.requested")[0];
    h.approvals.resolve(approvalId, "allow-once");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    h.broker.cancel(sessionId, "owner");
    await vi.waitFor(() => expect(h?.ofType("exit")).toHaveLength(1));
    h.broker.close(sessionId, "owner");
    // terminal.exit is written after the post-command snapshot, so it may follow the close.
    await vi.waitFor(() => expect(h?.audits).toHaveLength(6));
    expect(h.audits.map((a) => a.action).toSorted()).toEqual([
      "terminal.approval",
      "terminal.cancel",
      "terminal.close",
      "terminal.command",
      "terminal.exit",
      "terminal.open",
    ]);
    const byAction = Object.fromEntries(h.audits.map((a) => [a.action, a]));
    for (const action of [
      "terminal.command",
      "terminal.approval",
      "terminal.cancel",
      "terminal.exit",
    ]) {
      expect(byAction[action].detail, action).toMatchObject({ runId, sessionId });
    }
    expect(byAction["terminal.command"]).toMatchObject({
      identity: "owner",
      outcome: "ok",
      source: "console.terminal",
      detail: { command: "touch b.txt", decision: "approve", risks: ["writes-files"] },
    });
    expect(byAction["terminal.exit"].detail).toMatchObject({ reason: "cancelled" });
  });
});
