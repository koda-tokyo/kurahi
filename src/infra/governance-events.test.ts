import { afterEach, describe, expect, it } from "vitest";
import type { RunRecord } from "../autopilot/types.js";
import type { KoLoConfig } from "../config/config.js";
import { type DiagnosticEventPayload, onDiagnosticEvent } from "./diagnostic-events.js";
import { contentCapture, emitAutopilotRun, observeAgentRun } from "./governance-events.js";

const events: DiagnosticEventPayload[] = [];
const stop = onDiagnosticEvent((evt) => events.push(evt));
afterEach(() => {
  events.length = 0;
});
void stop;

const on = (otel: Record<string, unknown> = {}) =>
  ({ diagnostics: { enabled: true, otel } }) as unknown as KoLoConfig;

const info = {
  runId: "run-1",
  sessionId: "s-1",
  agentId: "support",
  provider: "watsonx",
  model: "m",
  prompt: "secret question",
};

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("governance events", () => {
  it("emits ids, timings and counts, never content, by default", async () => {
    let t = 1000;
    await observeAgentRun(
      on(),
      info,
      Promise.resolve({
        payloads: [{ text: "secret answer" }],
        meta: {
          durationMs: 5,
          steps: 2,
          toolCalls: 1,
          agentMeta: { sessionId: "s-1", provider: "watsonx", model: "m", usage: { input: 3 } },
        },
      }),
      () => (t += 40),
    );
    await flush();
    const evt = events.find((e) => e.type === "agent.run");
    expect(evt).toMatchObject({
      runId: "run-1",
      outcome: "completed",
      durationMs: 40,
      steps: 2,
      toolCalls: 1,
      payloads: 1,
      usage: { input: 3 },
    });
    expect(JSON.stringify(evt)).not.toContain("secret");
  });

  it("attaches truncated content only when captureContent is on", async () => {
    expect(contentCapture(on())).toBeNull();
    expect(contentCapture(on({ captureContent: true }))).toBe(4000);
    await observeAgentRun(
      on({ captureContent: true, maxContentChars: 100 }),
      { ...info, prompt: "q".repeat(150) },
      Promise.resolve({ payloads: [{ text: "answer" }], meta: { durationMs: 1 } }),
    );
    await flush();
    const evt = events.find((e) => e.type === "agent.run") as Extract<
      DiagnosticEventPayload,
      { type: "agent.run" }
    >;
    expect(evt.content?.output).toBe("answer");
    expect(evt.content?.input).toBe(`${"q".repeat(100)}…[truncated]`);
  });

  it("reports a thrown run by error class only and passes the rejection through", async () => {
    const run = observeAgentRun(on(), info, Promise.reject(new TypeError("leaks secret text")));
    await expect(run).rejects.toThrow("leaks secret text");
    await flush();
    const evt = events.find((e) => e.type === "agent.run");
    expect(evt).toMatchObject({ outcome: "error", errorKind: "TypeError" });
    expect(JSON.stringify(evt)).not.toContain("secret");
  });

  it("does nothing when diagnostics are off", async () => {
    await observeAgentRun(undefined, info, Promise.resolve({ meta: { durationMs: 1 } }));
    emitAutopilotRun(undefined, {} as RunRecord);
    await flush();
    expect(events).toHaveLength(0);
  });

  it("summarises an autopilot run as decisions and counts", () => {
    const record = {
      id: "ap-1",
      projectId: "p1",
      routineId: "inbox",
      edition: "business",
      area: "secretariat",
      level: "L1",
      trigger: "schedule",
      triggeredBy: "cron",
      startedAt: "2026-10-25T00:00:00.000Z",
      endedAt: "2026-10-25T00:00:05.000Z",
      status: "ok",
      reason: "free text that is not exported",
      routineDigest: "d",
      gather: [
        { id: "inbox", tool: "m365_mail_list", calls: 1, bytes: 10, error: null },
        { id: "mail", tool: "m365_mail_read", calls: 3, bytes: 30, error: null },
      ],
      reasoning: { backend: "codex-cli", model: null, ms: 900, outputSha256: "x" },
      counts: {
        items: 3,
        prepared: 3,
        acted: 2,
        escalated: 1,
        refused: 0,
        failed: 0,
        handled: 2,
        deferred: 0,
      },
      actions: [
        { decision: "allow", executed: true },
        { decision: "allow", executed: false },
        { decision: "needs_person", executed: false },
      ],
      workItems: ["w1"],
      evidence: { bundle: "b", root: "sha256:root" },
      watchdog: { tripped: false, reasons: [], baseline: "static", metrics: null },
    } as unknown as RunRecord;
    emitAutopilotRun(on(), record);
    const evt = events.find((e) => e.type === "autopilot.run");
    expect(evt).toMatchObject({
      runId: "ap-1",
      durationMs: 5000,
      decisions: { allow: 1, allow_failed: 1, needs_person: 1 },
      gatherCalls: 4,
      workItems: 1,
      evidenceRoot: "sha256:root",
      watchdogTripped: false,
    });
    expect(JSON.stringify(evt)).not.toContain("free text");
  });
});
