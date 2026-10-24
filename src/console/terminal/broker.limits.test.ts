import { afterEach, describe, expect, it, vi } from "vitest";
import { TerminalError } from "./broker.js";
import { createHarness, type Harness } from "./test-harness.js";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof TerminalError ? err.code : String(err);
  }
  return "no error";
};

describe("terminal broker: limits", () => {
  it("caps sessions per project and per user", async () => {
    h = createHarness({ terminal: { maxSessionsPerProject: 2, maxSessionsPerUser: 1 } });
    await h.open("alice");
    await expect(h.open("alice")).rejects.toMatchObject({ code: "session-limit" });
    await h.open("bob");
    await expect(h.open("carol")).rejects.toMatchObject({ code: "session-limit" });
  });

  it("stops accepting characters at the line limit", async () => {
    h = createHarness({ terminal: { maxLineLength: 64 } });
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", `echo ${"x".repeat(100)}`);
    expect(h.notices()).toEqual(["ready", "line-too-long"]);
    h.broker.input(sessionId, "owner", "\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    expect(h.backend.spawns[0].req.line).toHaveLength(64);
  });

  it("submits only the first line of a multi-line paste", async () => {
    h = createHarness({ mode: "plan" });
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "ls\rrm -rf src\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    expect(h.backend.spawns[0].req.line).toBe("ls");
    expect(h.notices()).toContain("paste-truncated");
  });

  it("drops output beyond the rate limit and says how much", async () => {
    h = createHarness({ mode: "plan", terminal: { outputBytesPerSecond: 1024 } });
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "cat a.txt\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    const proc = h.backend.spawns[0];
    proc.out(`${"a".repeat(1000)}\n`);
    proc.out(`${"b".repeat(4000)}\n`);
    proc.exit(0);
    await vi.waitFor(() => expect(h?.ofType("exit")).toHaveLength(1));
    const limited = h.ofType("notice").find((n) => n.code === "output-rate-limited");
    expect(limited?.params).toEqual({ droppedBytes: 4001 });
    expect(h.stdout()).not.toContain("bbbb");
  });

  it("closes idle sessions", async () => {
    h = createHarness({ terminal: { idleTimeoutMs: 60_000 } });
    const { sessionId } = await h.open();
    h.advance(30_000);
    h.broker.sweepIdle();
    expect(h.broker.openCount).toBe(1);
    h.advance(61_000);
    h.broker.sweepIdle();
    expect(h.broker.openCount).toBe(0);
    expect(h.notices()).toContain("idle-timeout");
    expect(codeOf(() => h?.broker.input(sessionId, "owner", "ls\r"))).toBe("closed");
    // The closed session's events can still be replayed by its owner.
    expect(h.broker.replay(sessionId, "owner", 0).events.length).toBeGreaterThan(0);
  });

  it("only the identity that opened a session may use it", async () => {
    h = createHarness();
    const { sessionId } = await h.open("alice");
    expect(codeOf(() => h?.broker.input(sessionId, "mallory", "ls\r"))).toBe("forbidden");
    expect(codeOf(() => h?.broker.replay(sessionId, "mallory", 0))).toBe("forbidden");
    expect(codeOf(() => h?.broker.close(sessionId, "mallory"))).toBe("forbidden");
    expect(h.audits.at(-1)).toMatchObject({ action: "terminal.access", outcome: "denied" });
  });
});

describe("terminal broker: cancel, close and shutdown", () => {
  it("cancel kills the running command's process group", async () => {
    h = createHarness({ mode: "plan" });
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "sleep 100\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(1));
    h.broker.cancel(sessionId, "owner");
    expect(h.backend.spawns[0].signals).toEqual(["SIGTERM"]);
    await vi.waitFor(() => expect(h?.ofType("exit")[0]).toMatchObject({ reason: "cancelled" }));
  });

  it("cancel during an approval denies it and runs nothing", async () => {
    h = createHarness();
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "rm a.txt\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    h.broker.cancel(sessionId, "owner");
    await vi.waitFor(() => expect(h?.notices()).toContain("approval-cancelled"));
    expect(h.approvals.cancels).toEqual([h.ofType("approval.requested")[0].approvalId]);
    expect(h.ofType("approval.resolved")[0].decision).toBe("cancelled");
    expect(h.backend.spawns).toHaveLength(0);
  });

  it("Ctrl-C at an approval cancels it; at the prompt it clears the line", async () => {
    h = createHarness();
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "rm a");
    h.broker.input(sessionId, "owner", "\x03");
    expect(h.stdout()).toContain("^C\r\n~ $ ");
    h.broker.input(sessionId, "owner", "rm a.txt\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    h.broker.input(sessionId, "owner", "\x03");
    await vi.waitFor(() => expect(h?.notices()).toContain("approval-cancelled"));
  });

  it("close and shutdown kill running commands", async () => {
    h = createHarness({ mode: "plan" });
    const a = await h.open();
    const b = await h.open();
    h.broker.input(a.sessionId, "owner", "sleep 100\r");
    h.broker.input(b.sessionId, "owner", "sleep 200\r");
    await vi.waitFor(() => expect(h?.backend.spawns).toHaveLength(2));
    h.broker.close(a.sessionId, "owner");
    expect(h.backend.spawns[0].signals[0]).toBe("SIGTERM");
    h.broker.shutdown();
    // Shutdown does not wait for a grace period: SIGTERM then SIGKILL to the group at once.
    expect(h.backend.spawns[1].signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.broker.openCount).toBe(0);
    expect(h.notices()).toEqual(expect.arrayContaining(["closed", "shutdown"]));
  });
});
