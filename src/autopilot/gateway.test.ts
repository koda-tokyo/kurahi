import { Value } from "@sinclair/typebox/value";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import YAML from "yaml";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { flushAudit } from "../audit/audit-log.js";
import {
  resolveEventSchemaName,
  resolveMethodSchemaNames,
} from "../gateway/protocol/json-schema.js";
import { AutopilotRoutineSchema } from "../gateway/protocol/schema/autopilot.js";
import { wsMethodMinScope } from "../gateway/scopes.js";
import { BASE_GATEWAY_METHODS, GATEWAY_EVENTS } from "../gateway/server-methods-list.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import { createProject } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { setAutopilotDepsForTests } from "./gateway-deps.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autopilot-gw-"));
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
              platform: "test",
              mode: "backend",
            }
          : { id: "kolo-control-ui", version: "1", platform: "test", mode: "ui" },
      role: "operator",
      scopes,
      device: { id: "dev-person-0001" },
    },
  } as never;
}

const ADMIN = ["operator.admin"];
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
    client: client(who.kind ?? "ui", who.scopes ?? ADMIN),
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
  actions: ["workitem.intake", "mail.draft", "mail.send"],
  level: "L3",
  queue: "ga-requests",
  metrics: { baselineMinutes: 3 },
};
const future = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
const createParams = () => ({
  projectId,
  routineId: "inbox",
  action: "mail.send",
  scope: { domains: ["client.example.jp"], templates: ["ack"], maxPerDay: 5 },
  reason: "acknowledgements to known clients",
  expiresAt: future(30),
});

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
        text: JSON.stringify({
          items: [
            { ref: "m1", title: "Hello", summary: "", actions: [{ kind: "workitem.intake" }] },
          ],
        }),
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

describe("autopilot gateway methods", () => {
  it("registers every method with a schema and a scope", () => {
    const methods = {
      "autopilot.routines.list": "observe",
      "autopilot.runs.list": "observe",
      "autopilot.runs.get": "observe",
      "autopilot.approvals.list": "observe",
      "autopilot.stats": "observe",
      "autopilot.autonomy.proposals": "observe",
      "autopilot.run": "attach",
      "autopilot.pause": "attach",
      "autopilot.resume": "attach",
      "autopilot.approvals.create": "attach",
      "autopilot.approvals.revoke": "attach",
      "autopilot.autonomy.decline": "attach",
      "autopilot.autonomy.accept": "attach",
      "autopilot.reportError": "attach",
      "autopilot.brief.get": "observe",
      "autopilot.routines.sync": "admin",
    };
    for (const [m, scope] of Object.entries(methods)) {
      expect(BASE_GATEWAY_METHODS).toContain(m);
      const names = resolveMethodSchemaNames(m);
      expect(names.params, m).toBeDefined();
      expect(names.result, m).toBeDefined();
      expect(wsMethodMinScope(m)).toBe(scope);
    }
    expect(GATEWAY_EVENTS).toContain("autopilot.changed");
    expect(resolveEventSchemaName("autopilot.changed")).toBe("AutopilotChangedEvent");
  });

  it("lists routines with the action catalogue and edition areas", async () => {
    const r = await call("autopilot.routines.list", { projectId }, { scopes: ["operator.read"] });
    expect(r.ok).toBe(true);
    expect(r.payload.error).toBeNull();
    expect(r.payload.routines[0]).toMatchObject({
      id: "inbox",
      edition: "business",
      department: "secretariat",
      level: "L3",
      state: { paused: false },
    });
    expect(r.payload.routines[0].actions).toContainEqual(
      expect.objectContaining({ id: "mail.send", class: "external" }),
    );
    // Schedule-only routine: no event triggers; the view matches the published schema.
    expect(r.payload.routines[0].state.triggers).toEqual([]);
    expect(Value.Check(AutopilotRoutineSchema, r.payload.routines[0])).toBe(true);
    expect(r.payload.catalogue.find((d: Json) => d.id === "plc.write").class).toBe("never");
    expect(r.payload.editions.scholars).toContain("literature");
  });

  describe("standing approvals are person-only", () => {
    it("refuses agent tool connections (and cron sessions, which connect the same way)", async () => {
      const r = await call("autopilot.approvals.create", createParams(), { kind: "agent" });
      expect(r.ok).toBe(false);
      expect(r.error?.details?.code).toBe("not_a_person");
      const rv = await call(
        "autopilot.approvals.revoke",
        { projectId, id: "s00000000000000", reason: "stop" },
        { kind: "agent" },
      );
      expect(rv.error?.details?.code).toBe("not_a_person");
    });

    it("needs operator.approvals", async () => {
      const r = await call("autopilot.approvals.create", createParams(), {
        scopes: ["operator.read", "operator.write"],
      });
      expect(r.ok).toBe(false);
      expect(r.error?.message).toMatch(/operator\.approvals/);
    });

    it("refuses a voice origin", async () => {
      const r = await call("autopilot.approvals.create", { ...createParams(), voice: true });
      expect(r.ok).toBe(false);
    });

    it.each([
      [{ expiresAt: future(91) }, "invalid_expiry"],
      [{ expiresAt: new Date(Date.now() - 1000).toISOString() }, "invalid_expiry"],
      [{ action: "mail.draft" }, "not_external"],
      [{ action: "payment.execute" }, "not_external"],
      [{ scope: { maxPerDay: 5, templates: ["ack"] } }, "invalid_scope"],
      [{ scope: { domains: ["client.example.jp"], maxPerDay: 5 } }, "invalid_scope"],
      [{ scope: { domains: ["*.example"], templates: ["ack"], maxPerDay: 5 } }, "invalid_scope"],
      [{ routineId: "missing" }, "routine_not_found"],
    ])("refuses %o", async (over, code) => {
      const r = await call(
        "autopilot.approvals.create",
        { ...createParams(), ...over },
        { scopes: ATTACH },
      );
      expect(r.ok).toBe(false);
      expect(r.error?.details?.code).toBe(code);
    });

    it("refuses a missing reason (schema)", async () => {
      const r = await call(
        "autopilot.approvals.create",
        { ...createParams(), reason: "" },
        { scopes: ATTACH },
      );
      expect(r.ok).toBe(false);
    });

    it("a person creates, lists and revokes", async () => {
      const c = await call("autopilot.approvals.create", createParams(), { scopes: ATTACH });
      expect(c.ok).toBe(true);
      const id = c.payload.approval.id;
      expect(c.payload.approval).toMatchObject({
        state: "active",
        createdBy: "device:dev-person-0",
        action: "mail.send",
      });
      const l = await call(
        "autopilot.approvals.list",
        { projectId },
        { scopes: ["operator.read"] },
      );
      expect(l.payload.approvals.map((a: Json) => a.id)).toContain(id);
      const rv = await call(
        "autopilot.approvals.revoke",
        { projectId, id, reason: "client asked" },
        { scopes: ATTACH },
      );
      expect(rv.payload.approval).toMatchObject({ state: "revoked", revokeReason: "client asked" });
      const again = await call(
        "autopilot.approvals.revoke",
        { projectId, id, reason: "again" },
        { scopes: ATTACH },
      );
      expect(again.error?.details?.code).toBe("already_revoked");
      expect((await call("autopilot.approvals.list", { projectId })).payload.approvals).toEqual([]);
      const all = await call("autopilot.approvals.list", { projectId, includeInactive: true });
      expect(all.payload.approvals[0].state).toBe("revoked");
      expect(
        events.some((e) => e.event === "autopilot.changed" && e.payload.kind === "approval"),
      ).toBe(true);
    });
  });

  describe("declining an autonomy proposal is person-only", () => {
    const params = () => ({
      projectId,
      routineId: "inbox",
      kind: "promote",
      proposed: "L2",
      reason: "not this quarter",
    });

    it("refuses agent tool connections, voice and a missing operator.approvals", async () => {
      const agent = await call("autopilot.autonomy.decline", params(), { kind: "agent" });
      expect(agent.error?.details?.code).toBe("not_a_person");
      const voice = await call("autopilot.autonomy.decline", { ...params(), voice: true });
      expect(voice.ok).toBe(false);
      const scoped = await call("autopilot.autonomy.decline", params(), {
        scopes: ["operator.read", "operator.write"],
      });
      expect(scoped.error?.message).toMatch(/operator\.approvals/);
    });

    it("refuses a hold, an unknown kind and a missing reason", async () => {
      // The fixture has too little evidence: every routine holds, so nothing can be declined.
      const hold = await call("autopilot.autonomy.decline", params(), { scopes: ATTACH });
      expect(hold.error?.details?.code).toBe("nothing_to_decline");
      const kind = await call(
        "autopilot.autonomy.decline",
        { ...params(), kind: "hold" },
        { scopes: ATTACH },
      );
      expect(kind.ok).toBe(false);
      const reason = await call(
        "autopilot.autonomy.decline",
        { ...params(), reason: "" },
        { scopes: ATTACH },
      );
      expect(reason.ok).toBe(false);
    });
  });

  describe("accepting a proposal and reporting an error are person-only", () => {
    const acceptParams = () => ({
      projectId,
      routineId: "inbox",
      kind: "promote",
      proposed: "L2",
      reason: "steady for a month",
    });
    const reportParams = () => ({
      projectId,
      itemId: "wabcdefghijkl",
      reason: "replied to the wrong client",
    });

    it("refuses agent tool connections, voice and a missing operator.approvals", async () => {
      for (const [method, params] of [
        ["autopilot.autonomy.accept", acceptParams()],
        ["autopilot.reportError", reportParams()],
      ] as const) {
        const agent = await call(method, params, { kind: "agent" });
        expect(agent.error?.details?.code, method).toBe("not_a_person");
        const voice = await call(method, { ...params, voice: true });
        expect(voice.ok, method).toBe(false);
        const scoped = await call(method, params, { scopes: ["operator.read", "operator.write"] });
        expect(scoped.error?.message, method).toMatch(/operator\.approvals/);
      }
    });

    it("refuses a hold and an unknown item", async () => {
      const hold = await call("autopilot.autonomy.accept", acceptParams(), { scopes: ATTACH });
      expect(hold.error?.details?.code).toBe("nothing_to_accept");
      const missing = await call("autopilot.reportError", reportParams(), { scopes: ATTACH });
      expect(missing.error?.details?.code).toBe("item_not_found");
      const bad = await call(
        "autopilot.reportError",
        { ...reportParams(), reason: "" },
        { scopes: ATTACH },
      );
      expect(bad.ok).toBe(false);
    });

    it("lists the effective level, the override and the last demotion", async () => {
      const r = await call("autopilot.routines.list", { projectId }, { scopes: ["operator.read"] });
      expect(r.payload.routines[0]).toMatchObject({
        level: "L3",
        effectiveLevel: "L3",
        override: null,
        lastDemotion: null,
      });
    });
  });

  it("autopilot.brief.get returns the caller's own brief, people only", async () => {
    const agent = await call("autopilot.brief.get", { projectId }, { kind: "agent" });
    expect(agent.error?.details?.code).toBe("not_a_person");
    const r = await call("autopilot.brief.get", { projectId }, { scopes: ["operator.read"] });
    expect(r.ok).toBe(true);
    expect(r.payload.brief).toMatchObject({ projectId, version: 1 });
    expect(r.payload.brief.waiting.proposals).toEqual([]);
    const range = await call(
      "autopilot.brief.get",
      { projectId, from: "2026-10-02T00:00:00Z", to: "2026-10-01T00:00:00Z" },
      { scopes: ["operator.read"] },
    );
    expect(range.error?.details?.code).toBe("invalid_range");
  });

  it("pause and resume are person-only; a paused routine does not run", async () => {
    const a = await call(
      "autopilot.pause",
      { projectId, routineId: "inbox", reason: "x" },
      { kind: "agent" },
    );
    expect(a.error?.details?.code).toBe("not_a_person");
    const p = await call(
      "autopilot.pause",
      { projectId, routineId: "inbox", reason: "holiday" },
      { scopes: ATTACH },
    );
    expect(p.payload.routine.state).toMatchObject({ paused: true, pauseReason: "holiday" });
    const run = await call("autopilot.run", { projectId, routineId: "inbox" }, { scopes: ATTACH });
    expect(run.error?.details?.code).toBe("paused");
    const r = await call("autopilot.resume", { projectId, routineId: "inbox" }, { scopes: ATTACH });
    expect(r.payload.routine.state.paused).toBe(false);
  });

  it("runs by hand, lists runs with server totals, verifies a run, and reports stats", async () => {
    const first = await call(
      "autopilot.run",
      { projectId, routineId: "inbox" },
      { scopes: ATTACH },
    );
    expect(first.ok).toBe(true);
    expect(first.payload.run).toMatchObject({
      trigger: "manual",
      status: "ok",
      counts: { prepared: 1 },
    });
    await call("autopilot.run", { projectId, routineId: "inbox" }, { scopes: ATTACH });
    await call("autopilot.run", { projectId, routineId: "inbox" }, { scopes: ATTACH });
    const page = await call(
      "autopilot.runs.list",
      { projectId, limit: 2 },
      { scopes: ["operator.read"] },
    );
    expect(page.payload.total).toBe(3);
    expect(page.payload.runs).toHaveLength(2);
    const rest = await call("autopilot.runs.list", {
      projectId,
      limit: 2,
      cursor: page.payload.nextCursor,
    });
    expect(rest.payload.runs).toHaveLength(1);
    expect(rest.payload.nextCursor).toBeNull();
    expect(rest.payload.runs[0].id).toBe(first.payload.run.id);
    const got = await call("autopilot.runs.get", { projectId, id: first.payload.run.id });
    expect(got.payload.evidence).toEqual({ ok: true, problems: [] });
    expect(got.payload.run.actions[0]).toMatchObject({ kind: "workitem.intake", executed: true });
    const stats = await call("autopilot.stats", { projectId }, { scopes: ["operator.read"] });
    expect(stats.payload.totals).toMatchObject({
      runs: 3,
      prepared: 3,
      handled: 3,
      minutesSaved: 9,
    });
    expect(stats.payload.areas[0]).toMatchObject({
      edition: "business",
      area: "secretariat",
      department: "secretariat",
    });
    const autonomy = await call(
      "autopilot.autonomy.proposals",
      { projectId },
      { scopes: ["operator.read"] },
    );
    expect(autonomy.ok).toBe(true);
    expect(autonomy.payload.policy.windowDays).toBe(30);
    expect(autonomy.payload.proposals.length).toBeGreaterThan(0);
    for (const proposal of autonomy.payload.proposals) {
      // Three runs and no corrected items is too little evidence: hold, never a guess.
      expect(proposal).toMatchObject({ kind: "hold", reason: "insufficient_evidence" });
      expect(proposal.proposed).toBe(proposal.current);
      expect(proposal.evidence.runs).toBeGreaterThanOrEqual(0);
    }
  });

  it("an observer cannot run a routine", async () => {
    const r = await call(
      "autopilot.run",
      { projectId, routineId: "inbox" },
      { scopes: ["operator.read"] },
    );
    expect(r.ok).toBe(false);
    expect(r.error?.message).toMatch(/operator\.write/);
  });
});
