import { describe, expect, it, vi } from "vitest";
import type {
  TerminalEvent,
  TerminalOpenResult,
} from "../../../../packages/client/src/generated/types";
import type { Project } from "./projects";
import {
  emptyTerminal,
  openTerminal,
  replayTerminal,
  terminalAction,
  terminalEvent,
  disconnectTerminal,
  type TerminalHost,
} from "./terminal";
const project = { id: "p1234567890", mode: "plan" } as Project;
const session: TerminalOpenResult = {
  sessionId: "term-1",
  projectId: project.id,
  name: "Workbench",
  mode: "plan",
  sandboxed: false,
  cwd: "/demo/plant",
  seq: 2,
  limits: {
    maxLineLength: 4096,
    idleTimeoutMs: 1800000,
    outputBytesPerSecond: 524288,
    approvalTimeoutMs: 120000,
  },
};
const stdout = (seq: number, data = "output"): TerminalEvent => ({
  sessionId: session.sessionId,
  seq,
  ts: 1,
  type: "stdout",
  data,
});
const page = (events: TerminalEvent[], hasMore = false, lastSeq = events.at(-1)?.seq ?? 0) => ({
  events,
  hasMore,
  lastSeq,
  truncated: false,
});
function setup() {
  const request = vi.fn();
  const host: TerminalHost = {
    connected: true,
    client: { request },
    terminal: emptyTerminal(),
    execApprovalQueue: [],
  };
  return { host, request };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("project terminal", () => {
  it("recovers pre-response startup output and pages using returned events, not server high-water mark", async () => {
    const { host, request } = setup();
    request
      .mockResolvedValueOnce(session)
      .mockResolvedValueOnce(page([stdout(1)], true, 3))
      .mockResolvedValueOnce(page([stdout(2), stdout(3)]));
    await openTerminal(host, project);
    expect(request.mock.calls).toEqual([
      ["terminal.open", { projectId: project.id, name: "Workbench" }],
      ["terminal.replay", { sessionId: "term-1", afterSeq: 0, limit: 200 }],
      ["terminal.replay", { sessionId: "term-1", afterSeq: 1, limit: 200 }],
    ]);
    expect(host.terminal.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(host.terminal.synced).toBe(true);
  });
  it("coalesces live notifications during replay without dropping or duplicating output", async () => {
    const { host, request } = setup();
    host.terminal.session = session;
    const pending = deferred<ReturnType<typeof page>>();
    request
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(page([stdout(1), stdout(2)]));
    const replay = replayTerminal(host);
    terminalEvent(host, stdout(2));
    pending.resolve(page([stdout(1)]));
    await replay;
    expect(host.terminal.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("discards stale replay responses after disconnect and recovers on reconnect", async () => {
    const { host, request } = setup();
    host.terminal.session = session;
    const pending = deferred<ReturnType<typeof page>>();
    request.mockReturnValueOnce(pending.promise);
    const replay = replayTerminal(host);
    host.connected = false;
    disconnectTerminal(host);
    pending.resolve(page([stdout(1, "stale")]));
    await replay;
    expect(host.terminal.events).toEqual([]);
    expect(host.terminal.synced).toBe(false);
    host.connected = true;
    request.mockResolvedValueOnce(page([stdout(1, "recovered")]));
    await replayTerminal(host);
    expect(host.terminal.synced).toBe(true);
    expect(host.terminal.events).toEqual([stdout(1, "recovered")]);
  });
  it("never retries uncertain input and blocks input until output is recovered", async () => {
    const { host, request } = setup();
    host.terminal = { ...emptyTerminal(), session, synced: true, draft: "echo test" };
    request.mockRejectedValueOnce(new Error("ack lost"));
    await terminalAction(host, "input", project);
    expect(request).toHaveBeenCalledWith("terminal.input", {
      sessionId: "term-1",
      data: "echo test\r",
    });
    expect(host.terminal.draft).toBe("");
    expect(host.terminal.synced).toBe(false);
    await terminalAction(host, "input", project);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("blocks read-mode, cross-project, offline and multiline input", async () => {
    const { host, request } = setup();
    await openTerminal(host, { ...project, mode: "read" });
    host.terminal = { ...emptyTerminal(), session, synced: true, draft: "echo hi" };
    await terminalAction(host, "input", { ...project, mode: "read" });
    await terminalAction(host, "input", { ...project, id: "other" });
    host.connected = false;
    await terminalAction(host, "input", project);
    host.connected = true;
    host.terminal.draft = "one\ntwo";
    await terminalAction(host, "input", project);
    expect(request).not.toHaveBeenCalled();
  });
  it("restores missing approvals once and removes them on replayed resolution", async () => {
    const { host, request } = setup();
    host.terminal.session = session;
    const approval: TerminalEvent = {
      sessionId: "term-1",
      seq: 1,
      ts: Date.now(),
      type: "approval.requested",
      runId: "run-1",
      approvalId: "approval-1",
      command: "touch example",
      cwd: "/demo/plant",
      risk: { code: "writes-files" },
      risks: [{ code: "writes-files" }],
      expiresAtMs: Date.now() + 60000,
    };
    request.mockResolvedValueOnce(page([approval]));
    await replayTerminal(host);
    expect(host.execApprovalQueue[0]?.request.sessionKey).toBe("terminal:term-1");
    request.mockResolvedValueOnce(page([approval]));
    await replayTerminal(host);
    expect(host.execApprovalQueue).toHaveLength(1);
    request.mockResolvedValueOnce(
      page([
        {
          sessionId: "term-1",
          seq: 2,
          ts: 2,
          type: "approval.resolved",
          runId: "run-1",
          approvalId: "approval-1",
          decision: "deny",
          resolvedBy: "operator",
        },
      ]),
    );
    await replayTerminal(host);
    expect(host.execApprovalQueue).toEqual([]);
  });
  it("distinguishes command exit from session closure and retains bounded output", async () => {
    const { host, request } = setup();
    host.terminal.session = session;
    request
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 200 }, (_, i) => stdout(i + 1)),
          true,
          302,
        ),
      )
      .mockResolvedValueOnce(
        page([
          ...Array.from({ length: 101 }, (_, i) => stdout(i + 201)),
          {
            sessionId: "term-1",
            seq: 302,
            ts: 1,
            type: "exit",
            runId: "run-1",
            exitCode: 0,
            signal: null,
            durationMs: 20,
            reason: "exited",
          },
        ]),
      );
    await replayTerminal(host);
    expect(host.terminal.events).toHaveLength(250);
    expect(host.terminal.truncated).toBe(true);
    expect(host.terminal.closed).toBe(false);
    request.mockResolvedValueOnce(
      page([{ sessionId: "term-1", seq: 303, ts: 1, type: "notice", code: "idle-timeout" }]),
    );
    await replayTerminal(host);
    expect(host.terminal.closed).toBe(true);
  });
  it("does not resurrect a terminal opened before a connection reset", async () => {
    const { host, request } = setup();
    const pending = deferred<TerminalOpenResult>();
    request.mockReturnValueOnce(pending.promise);
    const opening = openTerminal(host, project);
    disconnectTerminal(host, true);
    pending.resolve(session);
    await opening;
    expect(host.terminal.session).toBeNull();
    expect(host.terminal.busy).toBe(false);
  });
  it("allows reopening only after a definitive lost-session response", async () => {
    const { host, request } = setup();
    host.terminal.session = session;
    request.mockRejectedValueOnce(new Error("network failure"));
    await replayTerminal(host);
    expect(host.terminal.closed).toBe(false);
    request.mockRejectedValueOnce(
      Object.assign(new Error("session missing"), { details: { code: "not-found" } }),
    );
    await replayTerminal(host);
    expect(host.terminal.closed).toBe(true);
    request.mockResolvedValueOnce(session).mockResolvedValueOnce(page([]));
    await openTerminal(host, project);
    expect(host.terminal.closed).toBe(false);
    expect(host.terminal.synced).toBe(true);
  });
  it("caps a single large output chunk as well as the event count", async () => {
    const { host, request } = setup();
    host.terminal.session = session;
    request.mockResolvedValueOnce(page([stdout(1, "x".repeat(300000))]));
    await replayTerminal(host);
    expect(JSON.stringify(host.terminal.events).length).toBeLessThan(40000);
    expect(host.terminal.truncated).toBe(true);
    expect(host.terminal.cursor).toBe(1);
  });
});
