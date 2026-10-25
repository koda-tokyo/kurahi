import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { CronJob, CronJobCreate, CronJobPatch } from "../cron/types.js";
import type { Project } from "../projects/types.js";
import { flushAudit } from "../audit/audit-log.js";
import { createProject } from "../projects/store.js";
import {
  autopilotJobName,
  isAutopilotJob,
  parseAutopilotJobName,
  runAutopilotCronJob,
  syncRoutineJobs,
  type CronLike,
} from "./cron.js";
import { routineState, updateRoutineState } from "./store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-cron-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

function fakeCron(): CronLike & { jobs: CronJob[]; writes: number } {
  let n = 0;
  const c = {
    jobs: [] as CronJob[],
    writes: 0,
    async list() {
      return c.jobs.map((j) => structuredClone(j));
    },
    async add(input: CronJobCreate) {
      c.writes++;
      const job = {
        ...structuredClone(input),
        id: `job-${++n}`,
        createdAtMs: 1,
        updatedAtMs: 1,
        state: {},
      } as CronJob;
      c.jobs.push(job);
      return job;
    },
    async update(id: string, patch: CronJobPatch) {
      c.writes++;
      const j = c.jobs.find((x) => x.id === id)!;
      Object.assign(j, structuredClone(patch));
      return j;
    },
    async remove(id: string) {
      c.writes++;
      c.jobs = c.jobs.filter((x) => x.id !== id);
      return { ok: true, removed: true };
    },
  };
  return c as unknown as CronLike & { jobs: CronJob[]; writes: number };
}

let project: Project;
const routine = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  edition: "core",
  area: "platform-ops",
  trigger: { interval: 30 },
  gather: [{ id: "disk", tool: "health_disk" }],
  reasoning: { prompt: "platform-health" },
  actions: ["workitem.intake"],
  level: "L2",
  ...over,
});
const write = (routines: unknown[]) =>
  fs.writeFileSync(
    path.join(project.folder, "context", "autopilot.yaml"),
    YAML.stringify({ routines }),
  );

beforeAll(() => {
  const folder = path.join(root, "proj");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  project = createProject(
    { name: "Ops", folder, allowedAgents: [] },
    { createdBy: "device:admin" },
  );
});
afterAll(async () => {
  await flushAudit();
  process.env.KOLO_HOME = saved.home;
  process.env.KOLO_STATE_DIR = saved.state;
  if (saved.home === undefined) {
    delete process.env.KOLO_HOME;
  }
  if (saved.state === undefined) {
    delete process.env.KOLO_STATE_DIR;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

describe("autopilot cron registration", () => {
  it("names jobs by project and routine", () => {
    const name = autopilotJobName(project.id, "platform-health");
    expect(parseAutopilotJobName(name)).toEqual({
      projectId: project.id,
      routineId: "platform-health",
    });
    expect(isAutopilotJob({ name: "autopilot:bad" })).toBe(false);
    expect(isAutopilotJob({ name: "nightly-tests" })).toBe(false);
  });

  it("is idempotent by routine id", async () => {
    const cron = fakeCron();
    write([routine("a"), routine("b", { trigger: { schedule: "0 9 * * 1-5", tz: "Asia/Tokyo" } })]);
    const first = await syncRoutineJobs(cron, project);
    expect(first.added.toSorted()).toEqual(["a", "b"]);
    expect(cron.jobs).toHaveLength(2);
    const b = cron.jobs.find((j) => j.name.endsWith(":b"))!;
    expect(b).toMatchObject({
      enabled: true,
      sessionTarget: "isolated",
      schedule: { kind: "cron", expr: "0 9 * * 1-5", tz: "Asia/Tokyo" },
      payload: { kind: "agentTurn", deliver: false },
      isolation: { postToMainMode: "none" },
    });
    expect(cron.jobs.find((j) => j.name.endsWith(":a"))!.schedule).toEqual({
      kind: "every",
      everyMs: 30 * 60_000,
    });
    expect(routineState(project.id, "a").cronJobId).toBe(cron.jobs[0].id);
    const writes = cron.writes;
    const second = await syncRoutineJobs(cron, project);
    expect(second).toEqual({ added: [], updated: [], removed: [], unchanged: ["a", "b"] });
    expect(cron.writes).toBe(writes);
    expect(cron.jobs).toHaveLength(2);
  });

  it("updates changed routines, removes deleted ones and disables paused ones", async () => {
    const cron = fakeCron();
    write([routine("a"), routine("b")]);
    await syncRoutineJobs(cron, project);
    updateRoutineState(project.id, "a", (cur) => ({ ...cur, paused: true }));
    write([routine("a"), routine("c")]);
    const res = await syncRoutineJobs(cron, project);
    expect(res).toMatchObject({ added: ["c"], updated: ["a"], removed: ["b"] });
    expect(cron.jobs.find((j) => j.name.endsWith(":a"))!.enabled).toBe(false);
    updateRoutineState(project.id, "a", (cur) => ({ ...cur, paused: false }));
  });

  it("an invalid file switches the Project's jobs off (fail closed) without deleting them", async () => {
    const cron = fakeCron();
    write([routine("a")]);
    await syncRoutineJobs(cron, project);
    write([routine("a", { gather: [{ tool: "m365_mail_send" }] })]);
    const res = await syncRoutineJobs(cron, project);
    expect(res.removed).toEqual([]);
    expect(cron.jobs).toHaveLength(1);
    expect(cron.jobs[0].enabled).toBe(false);
  });

  it("a fired job runs only when it is the job the engine registered", async () => {
    write([routine("a")]);
    const cron = fakeCron();
    await syncRoutineJobs(cron, project);
    const job = { ...cron.jobs[0], id: "look-alike" };
    expect(await runAutopilotCronJob(job)).toMatchObject({ status: "skipped" });
    expect(await runAutopilotCronJob({ ...job, name: "autopilot:pzzzzzzzzzz:a" })).toMatchObject({
      status: "error",
    });
  });
});
