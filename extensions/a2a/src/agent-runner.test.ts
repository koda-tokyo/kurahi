import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/agents/pi-embedded.js", () => ({
  runEmbeddedPiAgent: vi.fn(async () => ({ meta: {}, payloads: [{ text: "hello back" }] })),
}));

import type { KoLoConfig } from "../../../src/config/config.js";
import { runEmbeddedPiAgent } from "../../../src/agents/pi-embedded.js";
import { createEmbeddedRunAgent } from "./agent-runner.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "a2a-runner-"));
  vi.clearAllMocks();
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function cfg(model = "openai/gpt-test"): KoLoConfig {
  return {
    session: { store: path.join(dir, "sessions.json") },
    agents: {
      defaults: { workspace: path.join(dir, "ws"), skipBootstrap: true, model: { primary: model } },
      list: [{ id: "main" }],
    },
  } as KoLoConfig;
}

const params = (over: Record<string, unknown> = {}) => ({
  agentId: "main",
  sessionMainKey: "a2a:peer:ctx-1",
  prompt: "wrapped prompt",
  extraSystemPrompt: "a2a rules",
  allowTools: false,
  timeoutMs: 10_000,
  abortSignal: new AbortController().signal,
  runId: "a2a:t1",
  clientId: "peer",
  ...over,
});

describe("embedded A2A runner", () => {
  it("runs an isolated a2a session with tools disabled and reuses it per context", async () => {
    const run = createEmbeddedRunAgent(() => cfg());
    expect(await run(params())).toEqual({ text: "hello back" });
    await run(params());
    const mock = vi.mocked(runEmbeddedPiAgent);
    const first = mock.mock.calls[0][0];
    expect(first).toMatchObject({
      sessionKey: "agent:main:a2a:peer:ctx-1",
      messageProvider: "a2a",
      disableTools: true,
      prompt: "wrapped prompt",
      extraSystemPrompt: "a2a rules",
      lane: "a2a",
    });
    expect(mock.mock.calls[1][0].sessionId).toBe(first.sessionId);
    const store = JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf8"));
    expect(Object.keys(store)).toEqual(["agent:main:a2a:peer:ctx-1"]);
  });

  it("passes tools through only when allowed", async () => {
    await createEmbeddedRunAgent(() => cfg())(params({ allowTools: true }));
    expect(vi.mocked(runEmbeddedPiAgent).mock.calls[0][0].disableTools).toBe(false);
  });

  it("refuses unknown agents and CLI-backed providers", async () => {
    const run = createEmbeddedRunAgent(() => cfg());
    expect((await run(params({ agentId: "ghost" }))).error).toMatch(/not configured/);
    const cli = createEmbeddedRunAgent(() => cfg("claude-cli/opus"));
    await expect(cli(params())).rejects.toThrow(/CLI provider/);
    expect(vi.mocked(runEmbeddedPiAgent)).not.toHaveBeenCalled();
  });
});
