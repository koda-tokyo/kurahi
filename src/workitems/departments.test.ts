import AjvPkg from "ajv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { flushAudit } from "../audit/audit-log.js";
import { resolveMethodSchemaNames } from "../gateway/protocol/json-schema.js";
import { ProtocolSchemas } from "../gateway/protocol/schema/protocol-schemas.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import { createProject } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { departmentQueueMatcher, loadWorkQueuePolicy, parsePolicy } from "./policy.js";
import { DEPARTMENT_IDS } from "./types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-workitems-dept-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
type Reply = { ok: boolean; payload?: Json; error?: { code?: string; message: string } };
const context = { broadcast: () => {}, deps: {} } as unknown as GatewayRequestContext;
const PERSON = ["operator.read", "operator.write", "operator.approvals"];
const ADMIN = ["operator.admin"];

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
        scopes: who.scopes ?? PERSON,
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

const reqA = { device: "req-a" };
const reqB = { device: "req-b" };
const admin = { device: "admin-1", scopes: ADMIN };

const POLICY = `
version: 1
queues:
  - { id: fin, department: finance, name: { en: Finance }, types: [expense] }
  - { id: hr, department: hr, name: { en: HR }, types: [leave] }
  - { id: misc, name: { en: Misc }, types: [request] }
`;

let projectId = "";
beforeAll(() => {
  const folder = path.join(root, "proj");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  fs.writeFileSync(path.join(folder, "context", "workqueue.yaml"), POLICY);
  projectId = createProject({ name: "Dept", folder }, { createdBy: "owner", template: null }).id;
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

describe("queue department config", () => {
  it("parses a valid department and leaves an absent one unmapped", () => {
    const p = parsePolicy(POLICY);
    expect(p.queues.find((q) => q.id === "fin")?.department).toBe("finance");
    expect(p.queues.find((q) => q.id === "hr")?.department).toBe("hr");
    const misc = p.queues.find((q) => q.id === "misc")!;
    expect(misc.department).toBeUndefined();
    expect("department" in misc).toBe(false);
  });

  it("rejects an unknown department naming the queue and the value", () => {
    const bad = "queues:\n  - { id: ops-q, department: logistics, types: [request] }\n";
    expect(() => parsePolicy(bad)).toThrow(/queue ops-q: unknown department "logistics"/);
    expect(() => parsePolicy("queues:\n  - { id: q1, department: 3 }\n")).toThrow(
      /queue q1: unknown department 3/,
    );
  });

  it("an unknown department is a load error (fail closed), not dropped", () => {
    const folder = path.join(root, "bad");
    fs.mkdirSync(path.join(folder, "context"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, "context", "workqueue.yaml"),
      "queues:\n  - { id: ops-q, department: Finance }\n",
    );
    const policy = loadWorkQueuePolicy({ id: "pbadbadbad0", folder, templateId: null });
    expect(policy.error).toMatch(/queue ops-q: unknown department "Finance"/);
    expect(policy.queues).toEqual([]);
  });

  it("department matcher: mapped queues, and unmapped incl. undefined queue ids", () => {
    const p = parsePolicy(POLICY);
    const fin = departmentQueueMatcher(p, "finance");
    expect(["fin", "hr", "misc", "gone"].filter(fin)).toEqual(["fin"]);
    const unmapped = departmentQueueMatcher(p, "unmapped");
    expect(["fin", "hr", "misc", "gone"].filter(unmapped)).toEqual(["misc", "gone"]);
  });

  it("bundled business templates map their queues to departments", () => {
    const expected: Record<string, string> = {
      "business-general-affairs": "admin",
      "business-finance-expense-invoice": "finance",
      "business-hr-leave-overtime": "hr",
      "business-procurement": "procurement",
    };
    const templates = loadTemplates(resolveTemplatesDir({}));
    for (const [id, department] of Object.entries(expected)) {
      expect(
        templates.some((t) => t.id === id),
        id,
      ).toBe(true);
      const policy = loadWorkQueuePolicy({
        id: "ptemplate00",
        folder: path.join(root, "none"),
        templateId: id,
      });
      expect(policy.error, id).toBeNull();
      expect(policy.queues.length, id).toBeGreaterThan(0);
      for (const q of policy.queues) {
        expect(q.department, `${id}/${q.id}`).toBe(department);
      }
    }
    const fin = loadWorkQueuePolicy({
      id: "ptemplate00",
      folder: path.join(root, "none"),
      templateId: "business-finance-expense-invoice",
    });
    expect(fin.queues.find((q) => q.id === "fin-ringi")?.department).toBe("finance");
  });
});

describe("department over the gateway", () => {
  const ids: Record<string, string> = {};
  beforeAll(async () => {
    const make = async (queue: string, type: string, title: string, who: { device: string }) => {
      const r = await call("workitems.create", { projectId, queue, type, title }, who);
      expect(r.ok, r.error?.message).toBe(true);
      ids[title] = r.payload.item.id;
    };
    await make("fin", "expense", "A expense 1", reqA);
    await make("fin", "expense", "A expense 2", reqA);
    await make("hr", "leave", "A leave", reqA);
    await make("misc", "request", "A misc", reqA);
    await make("fin", "expense", "B expense", reqB);
  });

  it("config carries the department catalogue and per-queue departments", async () => {
    const r = await call("workitems.config", { projectId }, reqA);
    expect(r.ok).toBe(true);
    expect(r.payload.departments).toEqual([...DEPARTMENT_IDS]);
    expect(r.payload.departments).toEqual([
      "secretariat",
      "finance",
      "admin",
      "hr",
      "planning",
      "it",
      "procurement",
      "sales",
      "marketing",
      "service",
      "operations",
      "legal",
      "product",
      "facilities",
      "quality",
    ]);
    const byId = Object.fromEntries(r.payload.queues.map((q: Json) => [q.id, q]));
    expect(byId.fin.department).toBe("finance");
    expect(byId.hr.department).toBe("hr");
    expect("department" in byId.misc).toBe(false);
  });

  it("filters list by department and by unmapped; totals match the filtered set", async () => {
    const fin = await call("workitems.list", { projectId, department: "finance" }, admin);
    expect(fin.payload.total).toBe(3);
    expect(fin.payload.items).toHaveLength(3);
    expect(fin.payload.items.every((i: Json) => i.queue === "fin")).toBe(true);
    expect(fin.payload.counts.new + fin.payload.counts.drafting).toBe(3);

    const hr = await call("workitems.list", { projectId, department: "hr" }, admin);
    expect(hr.payload.items.map((i: Json) => i.id)).toEqual([ids["A leave"]]);
    expect(hr.payload.total).toBe(1);

    const unmapped = await call("workitems.list", { projectId, department: "unmapped" }, admin);
    expect(unmapped.payload.items.map((i: Json) => i.id)).toEqual([ids["A misc"]]);
    expect(unmapped.payload.total).toBe(1);

    const legal = await call("workitems.list", { projectId, department: "legal" }, admin);
    expect(legal.payload.total).toBe(0);
    expect(legal.payload.items).toEqual([]);

    // Totals are server-side over the whole filtered set, not the page.
    const page = await call(
      "workitems.list",
      { projectId, department: "finance", limit: 1 },
      admin,
    );
    expect(page.payload.items).toHaveLength(1);
    expect(page.payload.total).toBe(3);
    expect(page.payload.nextCursor).toBeTruthy();

    // Combines with the other filters.
    const both = await call(
      "workitems.list",
      { projectId, department: "finance", q: "expense 2" },
      admin,
    );
    expect(both.payload.items.map((i: Json) => i.id)).toEqual([ids["A expense 2"]]);
  });

  it("rejects an invalid department value", async () => {
    for (const department of ["Finance", "logistics", "", 3, ["finance"]]) {
      const r = await call("workitems.list", { projectId, department }, admin);
      expect(r.ok, String(department)).toBe(false);
      expect(r.error?.code).toBe("INVALID_REQUEST");
    }
    const s = await call("workitems.stats", { projectId, department: "nope" }, admin);
    expect(s.ok).toBe(false);
  });

  it("is applied after access filtering: it never reveals items the caller cannot read", async () => {
    const b = await call("workitems.list", { projectId, department: "finance" }, reqB);
    expect(b.payload.items.map((i: Json) => i.id)).toEqual([ids["B expense"]]);
    expect(b.payload.total).toBe(1);
    expect(
      (await call("workitems.list", { projectId, department: "hr" }, reqB)).payload.total,
    ).toBe(0);
    expect(
      (await call("workitems.list", { projectId, department: "unmapped" }, reqB)).payload.total,
    ).toBe(0);
    const a = await call("workitems.list", { projectId, department: "finance" }, reqA);
    expect(a.payload.total).toBe(2);
    expect(a.payload.items.map((i: Json) => i.id).toSorted()).toEqual(
      [ids["A expense 1"], ids["A expense 2"]].toSorted(),
    );
  });

  it("stats accept the same department filter over the readable set", async () => {
    const all = await call("workitems.stats", { projectId, department: "finance" }, admin);
    expect(all.payload.total).toBe(3);
    expect(Object.keys(all.payload.byQueue)).toEqual(["fin"]);
    const un = await call("workitems.stats", { projectId, department: "unmapped" }, admin);
    expect(un.payload.total).toBe(1);
    const b = await call("workitems.stats", { projectId, department: "finance" }, reqB);
    expect(b.payload.scope).toBe("visible");
    expect(b.payload.total).toBe(1);
    const none = await call("workitems.stats", { projectId }, admin);
    expect(none.payload.total).toBe(5);
  });
});
