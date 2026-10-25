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
import { saveArtifact } from "../projects/artifacts.js";
import { createProject, projectDataDir } from "../projects/store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-ringi-gw-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

// oxlint-disable-next-line typescript/no-explicit-any
type Json = any;
type Reply = { ok: boolean; payload?: Json; error?: { message: string; details?: Json } };
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
  who: { device: string; scopes?: string[]; agent?: boolean },
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
        client: who.agent
          ? { id: "gateway-client", version: "1", platform: "t", mode: "backend" }
          : { id: "kolo-control-ui", version: "1", platform: "t", mode: "ui" },
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
    // Every answer matches its published result schema.
    const name = resolveMethodSchemaNames(method).result!;
    const validate = ajv.compile(ProtocolSchemas[name]);
    expect(validate(r.payload), `${method}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  }
  return r;
}

const reqA = { device: "req-a" };
const reqB = { device: "req-b" };
const mgr = { device: "mgr-sales" };
const fin = { device: "fin-1" };
const deputy = { device: "deputy-1" };
const admin = { device: "admin-1", scopes: ADMIN };

const POLICY = `
version: 1
queues:
  - { id: ringi, name: { ja: 稟議, en: Ringi }, types: [request] }
routes:
  - id: ringi
    queues: [ringi]
    stages:
      - id: manager
        approvers: { roles: [approver], departmentField: department }
        delegation: true
      - id: finance
        when: [{ field: amount, gte: 100000 }]
        approvers: { roles: [finance] }
access:
  members:
    - { principal: device:mgr-sales, roles: [approver], departments: [sales] }
    - { principal: device:fin-1, roles: [finance] }
`;

let projectId = "";
beforeAll(() => {
  const folder = path.join(root, "proj");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  fs.writeFileSync(path.join(folder, "context", "workqueue.yaml"), POLICY);
  projectId = createProject({ name: "GW", folder }, { createdBy: "owner", template: null }).id;
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

describe("registration", () => {
  it("new methods are listed, typed and scoped", () => {
    for (const m of [
      "workitems.delegate",
      "workitems.document",
      "workitems.draftDiff",
      "workitems.stats",
    ]) {
      expect(BASE_GATEWAY_METHODS).toContain(m);
      expect(resolveMethodSchemaNames(m).params, m).toBeTruthy();
      expect(resolveMethodSchemaNames(m).result, m).toBeTruthy();
    }
    expect(wsMethodMinScope("workitems.document")).toBe("observe");
    expect(wsMethodMinScope("workitems.stats")).toBe("observe");
    expect(wsMethodMinScope("workitems.delegate")).toBe("attach");
  });
});

describe("ownership, inbox and authorization over the gateway", () => {
  it("requestedBy comes from the connection; mine / awaitingMe / refusals are enforced", async () => {
    const att = path.join(projectDataDir(projectId), "attachments");
    fs.mkdirSync(att, { recursive: true });
    fs.writeFileSync(path.join(att, "quote.html"), "<img src=x onerror=alert(1)>見積");
    const created = await call(
      "workitems.create",
      {
        projectId,
        queue: "ringi",
        title: "New CRM licence",
        source: {
          fields: { amount: 150000, department: "sales", purpose: "CRM" },
          documents: [{ kind: "attachment", ref: path.join(att, "quote.html") }],
        },
      },
      reqA,
    );
    expect(created.ok).toBe(true);
    const item = created.payload.item;
    expect(item.requestedBy).toBe("device:req-a");
    const id = item.id as string;

    // B cannot see or change A's request; nobody else's "mine" contains it.
    const bGet = await call("workitems.get", { projectId, id }, reqB);
    expect(bGet.error?.details?.code).toBe("not_authorised");
    const bUpd = await call("workitems.update", { projectId, id, patch: { title: "x" } }, reqB);
    expect(bUpd.error?.details?.code).toBe("not_authorised");
    const bAssign = await call("workitems.assignAgent", { projectId, id }, reqB);
    expect(bAssign.error?.details?.code).toBe("not_authorised");
    expect((await call("workitems.list", { projectId }, reqB)).payload.total).toBe(0);
    expect((await call("workitems.list", { projectId, mine: true }, admin)).payload.total).toBe(0);
    expect((await call("workitems.list", { projectId }, admin)).payload.total).toBe(1);
    const aMine = await call("workitems.list", { projectId, mine: true }, reqA);
    expect(aMine.payload.items.map((i: Json) => i.id)).toEqual([id]);
    expect(
      (await call("workitems.document", { projectId, id, ref: item.source.documents[0].ref }, reqB))
        .error?.details?.code,
    ).toBe("not_authorised");

    // Submit with a person-made draft: the manager's inbox now holds it, finance's does not.
    const art = saveArtifact({ title: "稟議書", content: "v1", projectId }, "device:req-a");
    const sub = await call(
      "workitems.update",
      { projectId, id, patch: { draft: { artifactId: art.id } } },
      reqA,
    );
    expect(sub.payload.item.route.current).toBe(0);
    const inbox = await call("workitems.list", { projectId, awaitingMe: true }, mgr);
    expect(inbox.payload.items.map((i: Json) => i.id)).toEqual([id]);
    expect(inbox.payload.items[0].currentStage).toMatchObject({
      id: "manager",
      index: 0,
      count: 2,
    });
    expect((await call("workitems.list", { projectId, awaitingMe: true }, fin)).payload.total).toBe(
      0,
    );
    expect(
      (await call("workitems.list", { projectId, stage: "manager" }, admin)).payload.total,
    ).toBe(1);

    // The approver reads the routed item and its documents (escaped, untrusted).
    const doc = await call(
      "workitems.document",
      { projectId, id, ref: item.source.documents[0].ref },
      mgr,
    );
    expect(doc.payload.document).toMatchObject({
      text: "&lt;img src=x onerror=alert(1)&gt;見積",
      untrusted: true,
      mediaType: "text/html",
    });

    // Finance may not decide the manager stage; agents may not delegate; the manager delegates.
    const early = await call("workitems.decide", { projectId, id, decision: "approve" }, fin);
    expect(early.error?.details?.code).toBe("not_an_approver");
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();
    const byAgent = await call(
      "workitems.delegate",
      { projectId, id, to: "device:deputy-1", reason: "on leave", expiresAt },
      { device: "mgr-sales", agent: true },
    );
    expect(byAgent.error?.details?.code).toBe("not_a_person");
    const noScope = await call(
      "workitems.delegate",
      { projectId, id, to: "device:deputy-1", reason: "on leave", expiresAt },
      { device: "mgr-sales", scopes: ["operator.read", "operator.write"] },
    );
    expect(noScope.error?.message).toMatch(/operator.approvals/);
    const del = await call(
      "workitems.delegate",
      { projectId, id, to: "device:deputy-1", reason: "on leave", expiresAt },
      mgr,
    );
    expect(del.ok).toBe(true);
    expect(
      (await call("workitems.list", { projectId, awaitingMe: true }, deputy)).payload.total,
    ).toBe(1);
    expect((await call("workitems.get", { projectId, id }, deputy)).ok).toBe(true);
    const s1 = await call("workitems.decide", { projectId, id, decision: "approve" }, deputy);
    expect(s1.payload.item.approvals[0]).toMatchObject({
      by: "device:deputy-1",
      onBehalfOf: "device:mgr-sales",
    });
    expect(s1.payload.item.status).toBe("awaiting_review");
    const s2 = await call(
      "workitems.decide",
      { projectId, id, decision: "approve", comment: "OK" },
      fin,
    );
    expect(s2.payload.item.status).toBe("approved");

    // Overview: operators see everything; a requester sees only their own share.
    const all = await call("workitems.stats", { projectId }, admin);
    expect(all.payload).toMatchObject({ scope: "all", total: 1 });
    expect(all.payload.byStatus.approved).toBe(1);
    expect(all.payload.timeToApprove.count).toBe(1);
    const mine = await call("workitems.stats", { projectId }, reqB);
    expect(mine.payload).toMatchObject({ scope: "visible", total: 0 });

    // The UI's viewer block.
    const cfg = await call("workitems.config", { projectId }, mgr);
    expect(cfg.payload.viewer).toMatchObject({
      principal: "device:mgr-sales",
      privileged: false,
      roles: ["approver", "requester"],
      departments: ["sales"],
    });
    expect(cfg.payload.access.members).toBeNull();
    expect(cfg.payload.routes[0].stages.map((s: Json) => s.id)).toEqual(["manager", "finance"]);
    expect(
      (await call("workitems.config", { projectId }, admin)).payload.access.members,
    ).toHaveLength(2);
  });

  it("draftDiff over the gateway, with provenance", async () => {
    const created = await call(
      "workitems.create",
      {
        projectId,
        queue: "ringi",
        title: "diff",
        source: { fields: { amount: 1, department: "sales" } },
      },
      reqA,
    );
    const id = created.payload.item.id as string;
    const art = saveArtifact({ title: "d", content: "a\nb", projectId }, "device:req-a");
    await call(
      "workitems.update",
      { projectId, id, patch: { draft: { artifactId: art.id } } },
      reqA,
    );
    const same = await call(
      "workitems.draftDiff",
      { projectId, id, fromVersion: 1, toVersion: 1 },
      reqA,
    );
    expect(same.payload).toMatchObject({ identical: true, hunks: [], untrusted: true });
    expect(same.payload.to.pinned).toBe(true);
    const bad = await call(
      "workitems.draftDiff",
      { projectId, id, fromVersion: 1, toVersion: 3 },
      reqA,
    );
    expect(bad.error?.details?.code).toBe("document_not_found");
  });
});
