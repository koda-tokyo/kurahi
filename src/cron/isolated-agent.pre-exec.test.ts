import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { KoLoConfig } from "../config/config.js";
import type { CronJob } from "./types.js";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";

// payload.preExec: the runtime runs the job's command through the agent's exec tool before the
// model turn; the model only reports on the output (tools off unless keepTools).
vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
}));
vi.mock("../agents/model-catalog.js", () => ({ loadModelCatalog: vi.fn() }));
vi.mock("../agents/pi-tools.js", () => ({ createKoLoCodingTools: vi.fn() }));

import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { createKoLoCodingTools } from "../agents/pi-tools.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";

const deps = {
  sendMessageWhatsApp: vi.fn(),
  sendMessageTelegram: vi.fn(),
  sendMessageDiscord: vi.fn(),
  sendMessageSignal: vi.fn(),
  sendMessageIMessage: vi.fn(),
} as unknown as CliDeps;

async function setup(home: string): Promise<KoLoConfig> {
  const dir = path.join(home, ".kolo", "sessions");
  await fs.mkdir(dir, { recursive: true });
  const storePath = path.join(dir, "sessions.json");
  await fs.writeFile(storePath, "{}", "utf-8");
  return {
    agents: {
      defaults: { model: "anthropic/claude-opus-4-5", workspace: path.join(home, "ws") },
      list: [{ id: "ops", tools: { allow: ["exec"] } }],
    },
    session: { store: storePath, mainKey: "main" },
  } as KoLoConfig;
}

function job(preExec: { command: string; keepTools?: boolean; pinHead?: boolean }): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    agentId: "ops",
    name: "backup-verify",
    enabled: true,
    createdAtMs: now,
    updatedAtMs: now,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    payload: { kind: "agentTurn", message: "Report the verdict.", deliver: false, preExec },
    state: {},
  };
}

const fakeExec = (execute: (...args: unknown[]) => Promise<unknown>) =>
  vi
    .mocked(createKoLoCodingTools)
    .mockReturnValue([
      { name: "exec", label: "exec", description: "", parameters: {}, execute },
    ] as never);

const run = (cfg: KoLoConfig, j: CronJob) =>
  runCronIsolatedAgentTurn({
    cfg,
    deps,
    job: j,
    message: j.payload.kind === "agentTurn" ? j.payload.message : "",
    sessionKey: "cron:job-1",
    agentId: "ops",
    lane: "cron",
  });

describe("cron preExec", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(createKoLoCodingTools).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
    vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
      payloads: [{ text: "VERDICT: OK — fine" }],
      meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
    });
  });

  it("runs the command through the agent's exec tool, then a tool-less model turn", async () => {
    await withTempHomeBase(async (home) => {
      const cfg = await setup(home);
      const execute = vi.fn(async () => ({
        content: [{ type: "text", text: "VERDICT: OK — fine\nrecord #3 abc" }],
        details: { status: "completed", exitCode: 0, durationMs: 1, aggregated: "" },
      }));
      fakeExec(execute);
      const res = await run(cfg, job({ command: "/opt/ops-job.mjs backup-verify" }));
      expect(execute).toHaveBeenCalledWith(
        expect.any(String),
        { command: "/opt/ops-job.mjs backup-verify" },
        undefined,
      );
      const toolOpts = vi.mocked(createKoLoCodingTools).mock.calls[0]?.[0];
      expect(toolOpts?.exec).toMatchObject({ origin: "cron", allowBackground: false });
      expect(toolOpts?.sessionKey).toBe("agent:ops:cron:job-1");
      const turn = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(turn?.disableTools).toBe(true);
      expect(turn?.prompt).toContain("Report the verdict.");
      expect(turn?.prompt).toContain("VERDICT: OK — fine");
      expect(turn?.prompt).toContain("do not run it again");
      expect(res.status).toBe("ok");
      expect(res.summary).toBe("VERDICT: OK — fine");
      expect(res.preExec).toMatchObject({ status: "ok", exitCode: 0, head: "VERDICT: OK — fine" });
      expect(res.preExec).not.toHaveProperty("output");
    });
  });

  it("pinHead: a model reply cannot replace or contradict the runtime's verdict line", async () => {
    await withTempHomeBase(async (home) => {
      const cfg = await setup(home);
      // 2026-10-23 00:47Z repo-health: the record said ESCALATE, the local model replied this.
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "```text\nVERDICT: NO ESCALATE\n```" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });
      fakeExec(
        vi.fn(async () => ({
          content: [{ type: "text", text: "VERDICT: ESCALATE — 7 stale worktree(s)\nrecord #19" }],
          details: { status: "completed", exitCode: 0, durationMs: 1, aggregated: "" },
        })),
      );
      const res = await run(cfg, job({ command: "/opt/ops-job.mjs repo-health", pinHead: true }));
      expect(res.status).toBe("ok");
      // The false reassurance is not delivered anywhere a person reads, not even after the verdict.
      expect(res.summary).toBe("VERDICT: ESCALATE — 7 stale worktree(s)");
      expect(res.outputText).toBe("VERDICT: ESCALATE — 7 stale worktree(s)");
      expect(JSON.stringify(res.summary) + JSON.stringify(res.outputText)).not.toContain(
        "NO ESCALATE",
      );
      expect(res.preExec).toMatchObject({
        pinned: true,
        modelSummary: "```text\nVERDICT: NO ESCALATE\n```",
      });
    });
  });

  it("pinHead: a near-copy of the verdict is not passed through as the verdict", async () => {
    await withTempHomeBase(async (home) => {
      const cfg = await setup(home);
      // 7bf5 review: a prefix match let "VERDICT: OK" accept "VERDICT: OKAY ..." and a tail.
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "VERDICT: OK — fineXX, and pruned 3 snapshots" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });
      fakeExec(
        vi.fn(async () => ({
          content: [{ type: "text", text: "VERDICT: OK — fine\nrecord #3 abc" }],
          details: { status: "completed", exitCode: 0, durationMs: 1, aggregated: "" },
        })),
      );
      const res = await run(cfg, job({ command: "/opt/ops-job.mjs backup-verify", pinHead: true }));
      expect(res.summary).toBe("VERDICT: OK — fine");
      expect(res.outputText).toBe("VERDICT: OK — fine");
      expect(res.preExec).toMatchObject({
        pinned: true,
        modelSummary: "VERDICT: OK — fineXX, and pruned 3 snapshots",
      });
    });
  });

  it("without pinHead the model's reply is reported unchanged", async () => {
    await withTempHomeBase(async (home) => {
      const cfg = await setup(home);
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "VERDICT: NO ESCALATE" }],
        meta: { durationMs: 5, agentMeta: { sessionId: "s", provider: "p", model: "m" } },
      });
      fakeExec(
        vi.fn(async () => ({
          content: [{ type: "text", text: "VERDICT: ESCALATE — stale" }],
          details: { status: "completed", exitCode: 0, durationMs: 1, aggregated: "" },
        })),
      );
      const res = await run(cfg, job({ command: "/opt/ops-job.mjs repo-health" }));
      expect(res.summary).toBe("VERDICT: NO ESCALATE");
      expect(res.preExec).not.toHaveProperty("pinned");
    });
  });

  it("a command that ran and exited non-zero is reported as failed and still summarised", async () => {
    await withTempHomeBase(async (home) => {
      const cfg = await setup(home);
      fakeExec(async () => {
        throw new Error("VERDICT: ESCALATE — stale\n\nCommand exited with code 3");
      });
      const res = await run(cfg, job({ command: "probe", keepTools: true }));
      expect(res.preExec).toMatchObject({
        status: "failed",
        exitCode: 3,
        head: "VERDICT: ESCALATE — stale",
      });
      const turn = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(turn?.disableTools).toBe(false);
      expect(turn?.prompt).toContain("VERDICT: ESCALATE — stale");
    });
  });

  it("a refused command fails the job without a model turn", async () => {
    await withTempHomeBase(async (home) => {
      const cfg = await setup(home);
      fakeExec(async () => {
        throw new Error("exec denied: allowlist miss");
      });
      const res = await run(cfg, job({ command: "rm -rf /tmp/x" }));
      expect(res.status).toBe("error");
      expect(res.error).toMatch(/preExec refused: exec denied: allowlist miss/);
      expect(res.preExec?.status).toBe("error");
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("an agent without the exec tool cannot run a pre-step", async () => {
    await withTempHomeBase(async (home) => {
      const cfg = await setup(home);
      vi.mocked(createKoLoCodingTools).mockReturnValue([]);
      const res = await run(cfg, job({ command: "probe" }));
      expect(res.status).toBe("error");
      expect(res.error).toMatch(/exec tool is not available to agent ops/);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });

  it("a command that needs an approval does not run unattended", async () => {
    await withTempHomeBase(async (home) => {
      const cfg = await setup(home);
      fakeExec(async () => ({
        content: [{ type: "text", text: "Approval required (id abc)" }],
        details: { status: "approval-pending", approvalId: "abc" },
      }));
      const res = await run(cfg, job({ command: "probe" }));
      expect(res.status).toBe("error");
      expect(res.error).toMatch(/needs an approval/);
      expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
    });
  });
});
