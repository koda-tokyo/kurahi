import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KoLoConfig } from "../../config/config.js";
import type { CronJob } from "../types.js";
import { applyJobPatch } from "../service/jobs.js";
import { buildPreExecPrompt, pinHeadPayloads, runCronPreExec } from "./pre-exec.js";

// The pre-step goes through the agent's real tool list: tool policy, host, security and the
// hardline guard apply exactly as for a model's exec call.
vi.mock("../../agents/tools/gateway.js", () => ({ callGatewayTool: vi.fn() }));

const isWin = process.platform === "win32";
let prevHome: string | undefined;
let tempDir: string;

beforeEach(async () => {
  prevHome = process.env.HOME;
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "kurahi-pre-exec-"));
  process.env.HOME = tempDir;
});

afterEach(async () => {
  if (prevHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = prevHome;
  }
  await (await import("../../audit/audit-log.js")).flushAudit();
  await fs.rm(tempDir, { recursive: true, force: true });
});

const cfgFor = (tools: object): KoLoConfig =>
  ({
    agents: { list: [{ id: "ops", sandbox: { mode: "off" }, tools }] },
  }) as unknown as KoLoConfig;

const pre = (cfg: KoLoConfig, command: string) =>
  runCronPreExec({
    command,
    cfg,
    agentId: "ops",
    sessionKey: "agent:ops:cron:job-1",
    workspaceDir: tempDir,
  });

describe.skipIf(isWin)("runCronPreExec with the agent's real tools", () => {
  it("runs on the configured host with KOLO_EXEC_ORIGIN=cron", async () => {
    const cfg = cfgFor({
      allow: ["exec"],
      exec: { host: "gateway", security: "full", ask: "off" },
    });
    const res = await pre(cfg, 'echo "VERDICT: OK origin=$KOLO_EXEC_ORIGIN agent=$KOLO_AGENT_ID"');
    expect(res).toMatchObject({ status: "ok", exitCode: 0 });
    expect(res.head).toBe("VERDICT: OK origin=cron agent=ops");

    const failed = await pre(cfg, "echo 'VERDICT: ESCALATE — x'; exit 4");
    expect(failed).toMatchObject({ status: "failed", exitCode: 4, head: "VERDICT: ESCALATE — x" });
  }, 120_000);

  it("is refused when the agent's tool policy has no exec", async () => {
    const res = await pre(cfgFor({ allow: ["read"] }), "echo hi");
    expect(res.status).toBe("error");
    expect(res.error).toMatch(/exec tool is not available/);
  }, 120_000);

  it("is refused by exec security and by the hardline guard", async () => {
    const denied = await pre(
      cfgFor({ allow: ["exec"], exec: { host: "gateway", security: "deny", ask: "off" } }),
      "echo hi",
    );
    expect(denied.status).toBe("error");
    expect(denied.error).toMatch(/security=deny/);
    const hardline = await pre(
      cfgFor({ allow: ["exec"], exec: { host: "gateway", security: "full", ask: "off" } }),
      "rm -rf /",
    );
    expect(hardline.status).toBe("error");
  }, 120_000);
});

describe("preExec helpers", () => {
  it("builds the model prompt from the real output", () => {
    const prompt = buildPreExecPrompt("Report.", "probe x", {
      status: "ok",
      exitCode: 0,
      output: "VERDICT: OK — fine",
      durationMs: 1,
    });
    expect(prompt).toContain("Report.");
    expect(prompt).toContain("$ probe x");
    expect(prompt).toContain("VERDICT: OK — fine");
  });

  it("pinHead delivers the verdict line alone", () => {
    expect(pinHeadPayloads("VERDICT: ESCALATE — stale")).toEqual([
      { text: "VERDICT: ESCALATE — stale" },
    ]);
  });

  it("cron.update can set and remove a job's pre-step", () => {
    const now = Date.now();
    const job: CronJob = {
      id: "j",
      name: "j",
      enabled: true,
      createdAtMs: now,
      updatedAtMs: now,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: "m" },
      state: {},
    };
    applyJobPatch(job, { payload: { kind: "agentTurn", preExec: { command: "probe" } } });
    expect(job.payload).toMatchObject({ message: "m", preExec: { command: "probe" } });
    applyJobPatch(job, { payload: { kind: "agentTurn", preExec: null } });
    expect(job.payload).not.toHaveProperty("preExec");
  });
});
