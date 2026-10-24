import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { KoLoConfig } from "../config/config.js";
import type { CronJob, CronPromptMode } from "./types.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import { validateCronAddParams, validateCronUpdateParams } from "../gateway/protocol/index.js";
import { applyJobPatch } from "./service/jobs.js";

// payload.promptMode: a cron agentTurn can ask for the minimal system prompt (the subagent one),
// which keeps a single-tool ops job small for a small local model.
vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({ loadModelCatalog: vi.fn() }));

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

const deps = {
  sendMessageWhatsApp: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendMessageDiscord: vi.fn(),
  sendMessageSignal: vi.fn(),
  sendMessageIMessage: vi.fn(),
} as unknown as CliDeps;

function job(promptMode?: CronPromptMode): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    agentId: "ops",
    name: "probe",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Run the probe.", deliver: false, promptMode },
    state: {},
  };
}

async function runWith(home: string, promptMode?: CronPromptMode) {
  const dir = path.join(home, ".kolo", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, "{}", "utf-8");
  const cfg = {
    agents: {
      defaults: { model: "anthropic/claude-opus-4-5", workspace: path.join(home, "ws") },
      list: [{ id: "ops" }],
    },
    session: { store: storePath, mainKey: "main" },
  } as KoLoConfig;
  await runCronIsolatedAgentTurn({
    cfg,
    deps,
    job: job(promptMode),
    message: "Run the probe.",
    sessionKey: "cron:job-1",
    agentId: "ops",
    lane: "cron",
  });
  return vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
}

describe("cron payload.promptMode", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [{ text: "done" }],
      meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    });
  });

  it("passes the job's prompt mode to the agent turn; unset leaves the runner default", async () => {
    await withTempHomeBase(async (home) => {
      expect((await runWith(home, "minimal"))?.promptMode).toBe("minimal");
      expect((await runWith(home))?.promptMode).toBeUndefined();
    });
  });

  it("is accepted by the protocol as full|minimal, null clears on update", () => {
    const add = (promptMode: unknown) =>
      validateCronAddParams({
        name: "ops",
        schedule: { kind: "cron", expr: "* * * * *" },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hi", promptMode },
      });
    const update = (promptMode: unknown) =>
      validateCronUpdateParams({
        id: "job-1",
        patch: { payload: { kind: "agentTurn", promptMode } },
      });
    expect(add("minimal")).toBe(true);
    expect(add("full")).toBe(true);
    expect(add("none")).toBe(false);
    expect(add("lean")).toBe(false);
    expect(update("minimal")).toBe(true);
    expect(update(null)).toBe(true);
    expect(update("lean")).toBe(false);
  });

  it("is set by a patch and removed by null", () => {
    const j = job();
    applyJobPatch(j, { payload: { kind: "agentTurn", promptMode: "minimal" } });
    expect(j.payload).toMatchObject({ kind: "agentTurn", promptMode: "minimal" });
    applyJobPatch(j, { payload: { kind: "agentTurn", promptMode: null } });
    expect(j.payload).not.toHaveProperty("promptMode");
  });
});
