import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { flushAudit, resolveAuditDir } from "../audit/audit-log.js";
import { resolveMethodSchemaNames } from "../gateway/protocol/json-schema.js";
import { wsMethodMinScope } from "../gateway/scopes.js";
import { BASE_GATEWAY_METHODS } from "../gateway/server-methods-list.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import { createProject } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { emergencyStopFile } from "./control.js";
import { setAutopilotDepsForTests } from "./gateway-deps.js";
import { routineState, updateRoutineState } from "./store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-ctl-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
type Reply = { ok: boolean; payload?: Json; error?: { message: string; details?: Json } };
const events: Array<{ event: string; payload: Json }> = [];
const context = {
  broadcast: (event: string, payload: unknown) => events.push({ event, payload }),
  deps: {},
} as unknown as GatewayRequestContext;

function client(kind: "ui" | "agent", scopes: string[]) {
  return {
    connId: `c-${kind}`,
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client:
        kind === "agent"
          ? {
              id: "gateway-client",
              displayName: "agent",
              version: "1",
              platform: "t",
              mode: "backend",
            }
          : { id: "kolo-control-ui", version: "1", platform: "t", mode: "ui" },
      role: "operator",
      scopes,
      device: { id: "dev-person-0001" },
    },
  } as never;
}

const ATTACH = ["operator.read", "operator.write", "operator.approvals"];
async function call(
  method: string,
  params: Record<string, unknown>,
  who: { kind?: "ui" | "agent"; scopes?: string[] } = {},
): Promise<Reply> {
  let reply: Reply | null = null;
  const respond: RespondFn = (ok, payload, error) => {
    reply = { ok, payload, error: error as Reply["error"] };
  };
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params },
    respond,
    client: client(who.kind ?? "ui", who.scopes ?? ATTACH),
    isWebchatConnect: () => false,
    context,
  });
  return reply!;
}

let projectId = "";
const ROUTINE = {
  id: "inbox",
  edition: "business",
  area: "secretariat",
  trigger: { schedule: "*/15 * * * *", tz: "Asia/Tokyo" },
  gather: [{ id: "list", tool: "m365_mail_list" }],
  reasoning: { prompt: "mail-triage" },
  actions: ["workitem.intake"],
  level: "L1",
  queue: "ga-requests",
};

beforeAll(() => {
  const folder = path.join(root, "ga");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  fs.writeFileSync(
    path.join(folder, "context", "autopilot.yaml"),
    YAML.stringify({ routines: [ROUTINE] }),
  );
  const template = loadTemplates(resolveTemplatesDir({})).find(
    (t) => t.id === "business-general-affairs",
  )!;
  projectId = createProject(
    { name: "GA", folder, allowedAgents: [] },
    { createdBy: "device:admin", template },
  ).id;
  setAutopilotDepsForTests({
    reasoner: {
      reason: async () => ({
        text: JSON.stringify({ items: [] }),
        backend: "fake",
        model: null,
      }),
    },
    tools: async () => ({ ok: true, text: "1. id: m1", pluginId: "microsoft-365" }),
    killed: () => null,
  });
});

afterAll(async () => {
  setAutopilotDepsForTests(null);
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

describe("autopilot.stopAll / startAll", () => {
  it("are registered as person-only approval methods with schemas", () => {
    for (const m of ["autopilot.stopAll", "autopilot.startAll"]) {
      expect(BASE_GATEWAY_METHODS).toContain(m);
      const names = resolveMethodSchemaNames(m);
      expect(names.params, m).toBeDefined();
      expect(names.result, m).toBeDefined();
      expect(wsMethodMinScope(m)).toBe("attach");
    }
  });

  it("refuse agents, missing operator.approvals, voice and a missing reason", async () => {
    expect(
      (await call("autopilot.stopAll", { reason: "incident" }, { kind: "agent" })).error?.details
        ?.code,
    ).toBe("not_a_person");
    const scope = await call(
      "autopilot.stopAll",
      { reason: "incident" },
      { scopes: ["operator.read", "operator.write"] },
    );
    expect(scope.error?.message).toMatch(/operator\.approvals/);
    expect((await call("autopilot.stopAll", { reason: "incident", voice: true })).ok).toBe(false);
    expect((await call("autopilot.stopAll", {})).ok).toBe(false);
    expect((await call("autopilot.stopAll", { reason: "x" })).ok).toBe(false);
    expect(routineState(projectId, "inbox").paused).toBe(false);
  });

  it("a person stops everything; runs are refused; startAll lifts it", async () => {
    const stop = await call("autopilot.stopAll", { reason: "suspected compromise" });
    expect(stop.ok).toBe(true);
    expect(stop.payload.control).toMatchObject({ stopped: true, emergencyStop: false });
    expect(stop.payload.changed).toContainEqual({ projectId, routineIds: ["inbox"] });
    expect(
      events.some((e) => e.payload.kind === "stopAll" && e.payload.projectId === projectId),
    ).toBe(true);
    const list = await call(
      "autopilot.routines.list",
      { projectId },
      { scopes: ["operator.read"] },
    );
    expect(list.payload.control.stopped).toBe(true);
    expect(list.payload.routines[0].state).toMatchObject({ paused: true, pausedBy: "stopAll" });
    const run = await call("autopilot.run", { projectId, routineId: "inbox" });
    expect(run.error?.details?.code).toBe("stopped_all");
    // A routine stopAll paused cannot be resumed alone while the stop holds.
    const resume = await call("autopilot.resume", {
      projectId,
      routineId: "inbox",
      reason: "only this one",
    });
    expect(resume.error?.details?.code).toBe("stopped_all");
    const start = await call("autopilot.startAll", { reason: "incident closed" });
    expect(start.ok).toBe(true);
    expect(start.payload.control.stopped).toBe(false);
    expect(start.payload.changed).toContainEqual({ projectId, routineIds: ["inbox"] });
    expect(routineState(projectId, "inbox").paused).toBe(false);
    expect((await call("autopilot.run", { projectId, routineId: "inbox" })).ok).toBe(true);
  });

  it("a routine a person paused stays paused while a global stop holds", async () => {
    expect(
      (await call("autopilot.pause", { projectId, routineId: "inbox", reason: "noisy" })).ok,
    ).toBe(true);
    expect((await call("autopilot.stopAll", { reason: "suspected compromise" })).ok).toBe(true);
    try {
      expect(routineState(projectId, "inbox").pausedBy).not.toBe("stopAll");
      const resume = await call("autopilot.resume", { projectId, routineId: "inbox" });
      expect(resume.error?.details?.code).toBe("stopped_all");
      expect(routineState(projectId, "inbox").paused).toBe(true);
    } finally {
      expect((await call("autopilot.startAll", { reason: "incident closed" })).ok).toBe(true);
    }
    // startAll lifts only stopAll pauses; the person's own pause is still theirs to lift.
    expect(routineState(projectId, "inbox").paused).toBe(true);
    const stopFile = emergencyStopFile();
    fs.mkdirSync(path.dirname(stopFile), { recursive: true });
    fs.writeFileSync(stopFile, "");
    try {
      const blocked = await call("autopilot.resume", { projectId, routineId: "inbox" });
      expect(blocked.error?.details?.code).toBe("emergency_stop");
      expect(routineState(projectId, "inbox").paused).toBe(true);
    } finally {
      fs.rmSync(stopFile, { force: true });
      updateRoutineState(projectId, "inbox", (cur) => ({ ...cur, paused: true }));
    }
    expect((await call("autopilot.resume", { projectId, routineId: "inbox" })).ok).toBe(true);
  });

  it("a second stopAll keeps the first stop's by, at and reason", async () => {
    const first = await call("autopilot.stopAll", { reason: "suspected compromise" });
    expect(first.payload.alreadyStopped).toBe(false);
    const second = await call("autopilot.stopAll", { reason: "me too" });
    expect(second.ok).toBe(true);
    expect(second.payload.alreadyStopped).toBe(true);
    expect(second.payload.control).toMatchObject({
      stopped: true,
      by: first.payload.control.by,
      at: first.payload.control.at,
      reason: "suspected compromise",
    });
    expect((await call("autopilot.startAll", { reason: "incident closed" })).ok).toBe(true);
  });

  it("startAll with nothing stopped keeps the last start's by, at and reason", async () => {
    expect((await call("autopilot.stopAll", { reason: "suspected compromise" })).ok).toBe(true);
    const first = await call("autopilot.startAll", { reason: "incident closed" });
    expect(first.payload.alreadyStarted).toBe(false);
    const second = await call("autopilot.startAll", { reason: "second start" });
    expect(second.ok).toBe(true);
    expect(second.payload.alreadyStarted).toBe(true);
    expect(second.payload.changed.flatMap((c: { routineIds: string[] }) => c.routineIds)).toEqual(
      [],
    );
    expect(second.payload.control).toMatchObject({
      stopped: false,
      by: first.payload.control.by,
      at: first.payload.control.at,
      reason: "incident closed",
    });
  });
});

describe("resume after a watchdog pause", () => {
  it("is person-only and needs a written reason", async () => {
    updateRoutineState(projectId, "inbox", (cur) => ({
      ...cur,
      paused: true,
      pausedBy: "watchdog",
      pausedAt: new Date().toISOString(),
      pauseReason: "watchdog: actions 40 > 20 (static)",
    }));
    const agent = await call(
      "autopilot.resume",
      { projectId, routineId: "inbox", reason: "looks fine" },
      { kind: "agent" },
    );
    expect(agent.error?.details?.code).toBe("not_a_person");
    const bare = await call("autopilot.resume", { projectId, routineId: "inbox" });
    expect(bare.error?.details?.code).toBe("reason_required");
    const ok = await call("autopilot.resume", {
      projectId,
      routineId: "inbox",
      reason: "checked the run: a newsletter burst, not an attack",
    });
    expect(ok.ok).toBe(true);
    expect(ok.payload.routine.state).toMatchObject({ paused: false, pausedBy: null });
  });

  it("a person cannot re-pause it to drop the reason rule", async () => {
    updateRoutineState(projectId, "inbox", (cur) => ({
      ...cur,
      paused: true,
      pausedBy: "watchdog",
      pausedAt: new Date().toISOString(),
      pauseReason: "watchdog: actions 40 > 20 (static)",
    }));
    const again = await call("autopilot.pause", { projectId, routineId: "inbox", reason: "x" });
    expect(again.error?.details).toMatchObject({ code: "already_paused", pausedBy: "watchdog" });
    expect(routineState(projectId, "inbox")).toMatchObject({
      pausedBy: "watchdog",
      pauseReason: "watchdog: actions 40 > 20 (static)",
    });
    const bare = await call("autopilot.resume", { projectId, routineId: "inbox" });
    expect(bare.error?.details?.code).toBe("reason_required");
  });

  it("pausing needs a non-blank reason", async () => {
    updateRoutineState(projectId, "inbox", (cur) => ({ ...cur, paused: false, pausedBy: null }));
    const blank = await call("autopilot.pause", { projectId, routineId: "inbox", reason: "   " });
    expect(blank.error?.details?.code).toBe("reason_required");
    expect(routineState(projectId, "inbox").paused).toBe(false);
  });

  it("resuming a routine that is not paused is refused and not audited as a resume", async () => {
    updateRoutineState(projectId, "inbox", (cur) => ({ ...cur, paused: false, pausedBy: null }));
    const before = events.length;
    const r = await call("autopilot.resume", {
      projectId,
      routineId: "inbox",
      reason: "just in case",
    });
    expect(r.error?.details?.code).toBe("not_paused");
    expect(routineState(projectId, "inbox").paused).toBe(false);
    expect(events.slice(before).some((e) => e.payload.kind === "resumed")).toBe(false);
    await flushAudit();
    const dir = resolveAuditDir();
    const audit = fs.existsSync(dir)
      ? fs
          .readdirSync(dir, { recursive: true, encoding: "utf8" })
          .filter((f) => f.endsWith(".jsonl"))
          .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
          .join("")
      : "";
    expect(audit).toContain('"autopilot.pause"');
    expect(audit).not.toContain("just in case");
  });

  it("routines.list and stats expose the watchdog per routine", async () => {
    const list = await call(
      "autopilot.routines.list",
      { projectId },
      { scopes: ["operator.read"] },
    );
    expect(list.payload.routines[0].state.watchdog).toMatchObject({
      baseline: "static",
      thresholds: { items: expect.any(Number), actions: expect.any(Number) },
      lastTrip: null,
    });
    const stats = await call("autopilot.stats", { projectId }, { scopes: ["operator.read"] });
    expect(stats.payload.routines[0].watchdog).toMatchObject({ baseline: "static" });
    expect(stats.payload.control).toMatchObject({ stopped: false, emergencyStop: false });
  });
});
