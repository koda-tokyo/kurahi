// Real pseudo-terminal: commands run through @lydell/node-pty and bash on this machine.
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostBackend, type ShellBackend } from "./pty-backend.js";
import { createHarness, type Harness } from "./test-harness.js";

let h: Harness | null = null;
afterEach(() => {
  h?.cleanup();
  h = null;
});

const groupAlive = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
};

function recordingHostBackend(pids: number[]) {
  return async (): Promise<ShellBackend> => {
    const host = await createHostBackend();
    return {
      sandboxed: false,
      spawn(req) {
        const proc = host.spawn(req);
        pids.push(proc.pid);
        return proc;
      },
    };
  };
}

describe.skipIf(process.platform === "win32")("terminal broker with a real PTY", () => {
  it("runs a read-only command in the project folder and reports its exit", async () => {
    const pids: number[] = [];
    h = createHarness({ mode: "plan", createBackend: recordingHostBackend(pids) });
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "pwd\r");
    await vi.waitFor(() => expect(h?.ofType("exit")).toHaveLength(1), { timeout: 10_000 });
    expect(h.ofType("exit")[0]).toMatchObject({ exitCode: 0, reason: "exited" });
    expect(h.stdout()).toContain(h.folder);
  });

  it("cancel kills the whole process group, background children included", async () => {
    const pids: number[] = [];
    h = createHarness({ createBackend: recordingHostBackend(pids) });
    const { sessionId } = await h.open();
    h.broker.input(sessionId, "owner", "sh -c 'sleep 30 & sleep 31 & wait'\r");
    await vi.waitFor(() => expect(h?.ofType("approval.requested")).toHaveLength(1));
    expect(pids).toHaveLength(0);
    h.approvals.resolve(h.ofType("approval.requested")[0].approvalId, "allow-once");
    await vi.waitFor(() => expect(pids).toHaveLength(1), { timeout: 10_000 });
    const pgid = pids[0];
    await new Promise((r) => setTimeout(r, 300));
    expect(groupAlive(pgid)).toBe(true);
    h.broker.cancel(sessionId, "owner");
    await vi.waitFor(() => expect(h?.ofType("exit")).toHaveLength(1), { timeout: 10_000 });
    expect(h.ofType("exit")[0]).toMatchObject({ reason: "cancelled" });
    await vi.waitFor(() => expect(groupAlive(pgid)).toBe(false), { timeout: 5_000 });
  });
});
