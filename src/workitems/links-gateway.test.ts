import AjvPkg from "ajv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { flushAudit } from "../audit/audit-log.js";
import { resolveMethodSchemaNames } from "../gateway/protocol/json-schema.js";
import { ProtocolSchemas } from "../gateway/protocol/schema/protocol-schemas.js";
import { wsMethodMinScope } from "../gateway/scopes.js";
import { BASE_GATEWAY_METHODS } from "../gateway/server-methods-list.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import { createProject } from "../projects/store.js";
import { mutateWorkItem } from "./store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-links-gw-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
type Reply = { ok: boolean; payload?: Json; error?: { message: string; details?: Json } };
const context = { broadcast: () => {}, deps: {} } as unknown as GatewayRequestContext;
const ajv = new (AjvPkg as unknown as new (o?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
});

async function call(
  method: string,
  params: Record<string, unknown>,
  who: { device: string; scopes?: string[] },
): Promise<Reply> {
  let reply: Reply | null = null;
  const respond: RespondFn = (ok, payload, error) => {
    reply = { ok, payload, error: error as Reply["error"] };
  };
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params },
    respond,
    client: {
      connId: "c",
      connect: {
        minProtocol: 3,
        maxProtocol: 3,
        client: { id: "kolo-control-ui", version: "1", platform: "t", mode: "ui" },
        role: "operator",
        scopes: who.scopes ?? ["operator.read", "operator.write"],
        device: { id: who.device },
      },
    } as never,
    isWebchatConnect: () => false,
    context,
  });
  const r = reply!;
  if (r.ok) {
    const name = resolveMethodSchemaNames(method).result!;
    const validate = ajv.compile(ProtocolSchemas[name]);
    expect(validate(r.payload), `${method}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
  return r;
}

const hr = { device: "hr-1" };
const other = { device: "other-1" };
const admin = { device: "admin-1", scopes: ["operator.admin"] };

const POLICY = `
version: 1
queues:
  - { id: hr-onboard, name: { en: Onboarding }, types: [request], department: hr }
  - { id: it-desk, name: { en: IT desk }, types: [request], department: it }
  - { id: misc, name: { en: Misc }, types: [request] }
`;
const PLAN = {
  steps: [
    { key: "hr-confirm", department: "hr", title: { en: "Confirm hire" }, dependsOn: [] },
    { key: "access", department: "it", title: { en: "Accounts" }, dependsOn: ["hr-confirm"] },
  ],
};

let projectId = "";
beforeAll(() => {
  const folder = path.join(root, "proj");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  fs.writeFileSync(path.join(folder, "context", "workqueue.yaml"), POLICY);
  projectId = createProject({ name: "Links", folder }, { createdBy: "owner", template: null }).id;
});

afterAll(async () => {
  await flushAudit();
  for (const [k, v] of [
    ["KOLO_HOME", saved.home],
    ["KOLO_STATE_DIR", saved.state],
  ] as const) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});

async function item(queue: string, who: { device: string }): Promise<string> {
  const r = await call("workitems.create", { projectId, queue, title: `item ${queue}` }, who);
  expect(r.ok, r.error?.message).toBe(true);
  return r.payload.item.id as string;
}

describe("linked case gateway methods", () => {
  it("are registered with schemas and the right scopes", () => {
    for (const m of [
      "workitems.linked.get",
      "workitems.linked.plans",
      "workitems.linked.create",
      "workitems.linked.attach",
    ]) {
      expect(BASE_GATEWAY_METHODS).toContain(m);
      expect(resolveMethodSchemaNames(m).params, m).toBeTruthy();
      expect(resolveMethodSchemaNames(m).result, m).toBeTruthy();
    }
    expect(wsMethodMinScope("workitems.linked.get")).toBe("observe");
    expect(wsMethodMinScope("workitems.linked.plans")).toBe("observe");
    expect(wsMethodMinScope("workitems.linked.create")).toBe("attach");
    expect(wsMethodMinScope("workitems.linked.attach")).toBe("attach");
  });

  it("offers the pack worksheet plans to whoever may read the case, installing nothing", async () => {
    const parent = await item("hr-onboard", hr);
    const folder = path.join(root, "proj");
    fs.mkdirSync(path.join(folder, "requests"), { recursive: true });
    fs.copyFileSync(
      path.resolve(
        import.meta.dirname,
        "../../templates/projects/packs/business-people-operations/starter/requests/onboarding.md",
      ),
      path.join(folder, "requests", "onboarding.md"),
    );
    try {
      const r = await call("workitems.linked.plans", { projectId, id: parent }, hr);
      expect(r.ok, r.error?.message).toBe(true);
      expect(r.payload.plans.map((p: Json) => [p.file, p.problems])).toEqual([
        ["requests/onboarding.md", []],
      ]);
      expect(r.payload.plans[0].plan.steps[0].key).toBe("onboarding-hr-confirm");
      const denied = await call("workitems.linked.plans", { projectId, id: parent }, other);
      expect(denied.ok).toBe(false);
      expect((await call("workitems.linked.get", { projectId, id: parent }, hr)).payload).toEqual({
        linkedCase: null,
      });
    } finally {
      fs.rmSync(path.join(folder, "requests"), { recursive: true, force: true });
    }
  });

  it("creates a plan, attaches ready steps in the right department and reports progress", async () => {
    const parent = await item("hr-onboard", hr);
    expect((await call("workitems.linked.get", { projectId, id: parent }, hr)).payload).toEqual({
      linkedCase: null,
    });

    // Only the requester (or a privileged operator) may plan the case; others cannot read it.
    const denied = await call(
      "workitems.linked.create",
      { projectId, id: parent, plan: PLAN },
      other,
    );
    expect(denied.error?.details?.code).toBe("not_authorised");
    expect((await call("workitems.linked.get", { projectId, id: parent }, other)).ok).toBe(false);
    const bad = await call(
      "workitems.linked.create",
      {
        projectId,
        id: parent,
        plan: { steps: [{ ...PLAN.steps[0], department: "general-affairs" }] },
      },
      hr,
    );
    expect(bad.ok).toBe(false);

    const created = await call(
      "workitems.linked.create",
      { projectId, id: parent, plan: PLAN },
      hr,
    );
    expect(created.ok, created.error?.message).toBe(true);
    expect(created.payload.linkedCase.ready).toEqual(["hr-confirm"]);
    const again = await call("workitems.linked.create", { projectId, id: parent, plan: PLAN }, hr);
    expect(again.error?.details?.code).toBe("linked_case_exists");

    // Department comes from the policy: an IT-queue item cannot fill the HR step.
    const itChild = await item("it-desk", hr);
    const wrong = await call(
      "workitems.linked.attach",
      { projectId, id: parent, stepKey: "hr-confirm", childId: itChild },
      hr,
    );
    expect(wrong.error?.details?.code).toBe("linked_child_wrong_department");
    // Dependencies first.
    const early = await call(
      "workitems.linked.attach",
      { projectId, id: parent, stepKey: "access", childId: itChild },
      hr,
    );
    expect(early.error?.details?.code).toBe("linked_step_not_ready");

    // A child the caller cannot read is refused, even for an otherwise valid step.
    const hidden = await item("hr-onboard", other);
    const notMine = await call(
      "workitems.linked.attach",
      { projectId, id: parent, stepKey: "hr-confirm", childId: hidden },
      hr,
    );
    expect(notMine.error?.details?.code).toBe("not_authorised");

    const hrChild = await item("hr-onboard", hr);
    const ok = await call(
      "workitems.linked.attach",
      { projectId, id: parent, stepKey: "hr-confirm", childId: hrChild },
      hr,
    );
    expect(ok.ok, ok.error?.message).toBe(true);
    expect(ok.payload.linkedCase.children).toEqual({ "hr-confirm": hrChild });

    mutateWorkItem(projectId, hrChild, undefined, (cur) => ({ ...cur, status: "done" }));
    const after = await call("workitems.linked.get", { projectId, id: parent }, hr);
    expect(after.payload.linkedCase.ready).toEqual(["access"]);
    // An administrator may attach to someone else's case.
    const adminAttach = await call(
      "workitems.linked.attach",
      { projectId, id: parent, stepKey: "access", childId: itChild },
      admin,
    );
    expect(adminAttach.ok, adminAttach.error?.message).toBe(true);
    expect(adminAttach.payload.linkedCase.done).toBe(1);
  });

  it("rejects malformed params before touching storage", async () => {
    const parent = await item("hr-onboard", hr);
    const extra = await call(
      "workitems.linked.attach",
      { projectId, id: parent, stepKey: "Bad Key", childId: parent },
      hr,
    );
    expect(extra.error?.message).toMatch(/invalid workitems.linked.attach params/);
  });
});
