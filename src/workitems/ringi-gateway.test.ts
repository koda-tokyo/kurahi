import AjvPkg from "ajv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { flushAudit, resolveAuditDir } from "../audit/audit-log.js";
import { resolveMethodSchemaNames } from "../gateway/protocol/json-schema.js";
import { ProtocolSchemas } from "../gateway/protocol/schema/protocol-schemas.js";
import { wsMethodMinScope } from "../gateway/scopes.js";
import { BASE_GATEWAY_METHODS } from "../gateway/server-methods-list.js";
import { handleGatewayRequest } from "../gateway/server-methods.js";
import { saveArtifact } from "../projects/artifacts.js";
import { createProject, projectDataDir } from "../projects/store.js";
import { openHandOff } from "./handoff-store.js";
import { listNotifications, recordNotifications } from "./notifications-store.js";
import { mutateWorkItem, workItemDir } from "./store.js";

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
      "workitems.withdrawDelegation",
      "workitems.document",
      "workitems.draftDiff",
      "workitems.handoffs",
      "workitems.handoff.open",
      "workitems.handoff.event",
      "workitems.stats",
      "workitems.notifications.list",
      "workitems.notifications.markRead",
    ]) {
      expect(BASE_GATEWAY_METHODS).toContain(m);
      expect(resolveMethodSchemaNames(m).params, m).toBeTruthy();
      expect(resolveMethodSchemaNames(m).result, m).toBeTruthy();
    }
    expect(wsMethodMinScope("workitems.document")).toBe("observe");
    expect(wsMethodMinScope("workitems.stats")).toBe("observe");
    expect(wsMethodMinScope("workitems.handoffs")).toBe("observe");
    expect(wsMethodMinScope("workitems.delegate")).toBe("attach");
    expect(wsMethodMinScope("workitems.withdrawDelegation")).toBe("attach");
    expect(wsMethodMinScope("workitems.handoff.open")).toBe("attach");
    expect(wsMethodMinScope("workitems.handoff.event")).toBe("attach");
    expect(wsMethodMinScope("workitems.notifications.list")).toBe("observe");
    expect(wsMethodMinScope("workitems.notifications.markRead")).toBe("attach");
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

    // The manager takes the delegation back (agents and the deputy may not), then delegates again.
    const wdAgent = await call(
      "workitems.withdrawDelegation",
      { projectId, id },
      { device: "mgr-sales", agent: true },
    );
    expect(wdAgent.error?.details?.code).toBe("not_a_person");
    const wdDeputy = await call("workitems.withdrawDelegation", { projectId, id }, deputy);
    expect(wdDeputy.error?.details?.code).toBe("no_delegation");
    const wd = await call(
      "workitems.withdrawDelegation",
      { projectId, id, reason: "back from leave" },
      mgr,
    );
    expect(wd.ok).toBe(true);
    expect(wd.payload.item.route.stages[0].delegations).toEqual([]);
    expect(
      (await call("workitems.list", { projectId, awaitingMe: true }, deputy)).payload.total,
    ).toBe(0);
    expect(
      (
        await call(
          "workitems.delegate",
          { projectId, id, to: "device:deputy-1", reason: "on leave", expiresAt },
          mgr,
        )
      ).ok,
    ).toBe(true);
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

  it("handoffs: read-only, gated like workitems.get, refuses a record edited on disk", async () => {
    const created = await call(
      "workitems.create",
      { projectId, queue: "ringi", title: "hand-off", source: { fields: { amount: 1 } } },
      reqA,
    );
    const id = created.payload.item.id as string;
    expect((await call("workitems.handoffs", { projectId, id }, reqA)).payload.handOffs).toEqual(
      [],
    );
    mutateWorkItem(projectId, id, undefined, (cur) => ({ ...cur, status: "approved" }));
    const rec = openHandOff(
      projectId,
      id,
      {
        action: "enter approved invoice as a deal",
        destination: { product: "freee 会計", object: "deals", writable: true },
      },
      { id: "device:req-a", kind: "person" },
      new Date(),
    );
    const mine = await call("workitems.handoffs", { projectId, id }, reqA);
    expect(mine.payload.handOffs.map((h: Json) => [h.id, h.state])).toEqual([[rec.id, "approved"]]);
    expect((await call("workitems.handoffs", { projectId, id }, reqB)).error?.details?.code).toBe(
      "not_authorised",
    );
    expect((await call("workitems.handoffs", { projectId, id, extra: 1 }, reqA)).ok).toBe(false);
    const file = path.join(workItemDir(projectId, id), "handoffs", `${rec.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ ...rec, state: "closed" }));
    expect((await call("workitems.handoffs", { projectId, id }, reqA)).error?.details?.code).toBe(
      "handoff_tampered",
    );
  });

  it("handoff.open / handoff.event: an approver opens, agents report, people decide", async () => {
    const created = await call(
      "workitems.create",
      {
        projectId,
        queue: "ringi",
        title: "invoice",
        source: { fields: { amount: 1, department: "sales" } },
      },
      reqA,
    );
    const id = created.payload.item.id as string;
    const open = {
      projectId,
      id,
      action: "enter approved invoice as a deal",
      destination: { product: "freee 会計", object: "deals", writable: true },
    };
    // Before the manager has approved, they are not yet an approver of this case.
    expect((await call("workitems.handoff.open", open, mgr)).error?.details?.code).toBe(
      "not_authorised",
    );
    const art = saveArtifact({ title: "invoice", content: "v1", projectId }, "device:req-a");
    await call(
      "workitems.update",
      { projectId, id, patch: { draft: { artifactId: art.id } } },
      reqA,
    );
    const decided = await call("workitems.decide", { projectId, id, decision: "approve" }, mgr);
    expect(decided.error?.message ?? "ok").toBe("ok");
    const agentMgr = { device: "mgr-sales", agent: true };
    expect((await call("workitems.handoff.open", open, agentMgr)).error?.details?.code).toBe(
      "not_a_person",
    );
    const noScope = { device: "mgr-sales", scopes: ["operator.read", "operator.write"] };
    expect((await call("workitems.handoff.open", open, noScope)).error?.message).toMatch(
      /operator.approvals/,
    );
    // The requester may read the case but not hand it off; others cannot read it at all.
    expect((await call("workitems.handoff.open", open, reqA)).error?.details?.code).toBe(
      "not_authorised",
    );
    expect((await call("workitems.handoff.open", open, reqB)).error?.details?.code).toBe(
      "not_authorised",
    );
    const opened = await call("workitems.handoff.open", open, mgr);
    expect(opened.payload.handOff.state).toBe("approved");
    expect(opened.payload.handOff.history[0].by).toBe("device:mgr-sales");
    expect((await call("workitems.handoff.open", open, mgr)).error?.details?.code).toBe(
      "handoff_duplicate",
    );

    const handOffId = opened.payload.handOff.id as string;
    const ev = (event: Json, who: Parameters<typeof call>[2]) =>
      call("workitems.handoff.event", { projectId, id, handOffId, event }, who);
    const sha = "a".repeat(64);
    expect(
      (await ev({ type: "submit", payloadVersion: 1, payloadSha256: sha }, agentMgr)).payload
        .handOff.state,
    ).toBe("submitted");
    expect((await ev({ type: "timeout" }, agentMgr)).payload.handOff.state).toBe("unknown");
    // Retrying is a person's decision, and only after a lookup found nothing.
    expect((await ev({ type: "retry", reason: "lost" }, mgr)).error?.details?.code).toBe(
      "handoff_lookup_required",
    );
    expect((await ev({ type: "lookup", found: null }, agentMgr)).ok).toBe(true);
    expect((await ev({ type: "retry", reason: "lost" }, agentMgr)).error?.details?.code).toBe(
      "handoff_person_required",
    );
    expect((await ev({ type: "retry", reason: "lost" }, mgr)).payload.handOff.state).toBe(
      "retry_pending",
    );
    // The caller cannot choose the re-approved revision, nor smuggle a resolution into reconcile.
    expect((await ev({ type: "reapprove", caseRevision: 99 }, mgr)).ok).toBe(false);
    expect(
      (
        await ev(
          {
            type: "reconcile",
            diffs: [
              {
                field: "amount",
                approved: 1,
                submitted: 1,
                destination: 2,
                resolution: { by: "device:mgr-sales", reason: "x", kind: "accepted" },
              },
            ],
          },
          agentMgr,
        )
      ).ok,
    ).toBe(false);
    // Someone who cannot read the case cannot move its hand-off.
    expect((await ev({ type: "timeout" }, reqB)).error?.details?.code).toBe("not_authorised");
    const listed = await call("workitems.handoffs", { projectId, id }, mgr);
    expect(listed.payload.handOffs.map((h: Json) => h.state)).toEqual(["retry_pending"]);

    // Reading a case is not enough: this one awaits the manager, who has not approved it.
    const unseen = await call(
      "workitems.create",
      {
        projectId,
        queue: "ringi",
        title: "unseen",
        source: { fields: { amount: 1, department: "sales" } },
      },
      reqA,
    );
    const unseenId = unseen.payload.item.id as string;
    const art2 = saveArtifact({ title: "unseen", content: "v1", projectId }, "device:req-a");
    await call(
      "workitems.update",
      { projectId, id: unseenId, patch: { draft: { artifactId: art2.id } } },
      reqA,
    );
    expect((await call("workitems.get", { projectId, id: unseenId }, mgr)).ok).toBe(true);
    expect(
      (await call("workitems.handoff.open", { ...open, id: unseenId }, mgr)).error?.details?.code,
    ).toBe("not_authorised");

    // A privileged operator may hand off others' cases, never their own.
    const own = await call(
      "workitems.create",
      { projectId, queue: "ringi", title: "own", source: { fields: { amount: 1 } } },
      admin,
    );
    const ownId = own.payload.item.id as string;
    mutateWorkItem(projectId, ownId, undefined, (cur) => ({ ...cur, status: "approved" }));
    expect(
      (await call("workitems.handoff.open", { ...open, id: ownId }, admin)).error?.details?.code,
    ).toBe("not_authorised");
    const other = await call("workitems.handoff.open", { ...open, action: "second entry" }, admin);
    expect(other.payload.handOff.state).toBe("approved");

    // A destination that matches the approval reconciles with no differences, and then closes.
    const ev2 = (event: Json) =>
      call(
        "workitems.handoff.event",
        { projectId, id, handOffId: other.payload.handOff.id, event },
        admin,
      );
    await ev2({ type: "submit", payloadVersion: 1, payloadSha256: sha });
    await ev2({ type: "confirm", externalId: "deal-1", externalStatus: "created" });
    expect((await ev2({ type: "reconcile", diffs: [] })).payload.handOff.state).toBe("reconciled");
    // Settlement SoD mode is server policy: strict by default, and the client cannot ask for warn.
    const settle = { type: "close", objective: "payment_settled", settlementRef: "bank:1" };
    expect((await ev2(settle)).error?.details).toMatchObject({
      code: "handoff_sod_conflict",
      roles: ["approver"],
    });
    expect((await ev2({ ...settle, settlementSod: "warn" })).ok).toBe(false);
    // "warn" in the client's project folder is read as strict; only the administrator relaxes it.
    const policyFile = path.join(root, "proj", "context", "workqueue.yaml");
    const adminFile = path.join(projectDataDir(projectId), "workqueue.yaml");
    fs.writeFileSync(policyFile, `${POLICY}settlementSod: warn\n`);
    try {
      expect((await ev2(settle)).error?.details?.code).toBe("handoff_sod_conflict");
      fs.rmSync(policyFile);
      fs.writeFileSync(adminFile, `${POLICY}settlementSod: warn\n`);
      const warned = (await ev2(settle)).payload.handOff;
      expect(warned.state).toBe("closed");
      expect(warned.history.at(-1).detail).toMatchObject({
        settlementSod: "warn",
        selfAttested: true,
        sodOverlap: ["approver"],
      });
    } finally {
      fs.rmSync(adminFile, { force: true });
      fs.writeFileSync(policyFile, POLICY);
    }

    // The agent refusal is audited like every other refusal.
    await flushAudit();
    const audited = fs
      .readdirSync(resolveAuditDir())
      .flatMap((f) => fs.readFileSync(path.join(resolveAuditDir(), f), "utf8").split("\n"))
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(
      audited.some(
        (e) =>
          e.action === "workitem.handoff.open" &&
          e.outcome === "denied" &&
          e.detail?.reason &&
          e.detail?.id === id,
      ),
    ).toBe(true);
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

const DIRECT_POLICY = `
version: 1
queues:
  - { id: direct, name: { ja: 直接, en: Direct }, types: [request] }
routes:
  - id: direct
    queues: [direct]
    stages:
      - id: lead
        approvers: { principals: ["device:mgr-sales"] }
        delegation: true
        escalation: { afterHours: 48, to: { principals: ["device:fin-1"] } }
`;

describe("awaitingMe on a principal-only route over the gateway", () => {
  // Named principals make the list index bound the deciders, so delegates and escalation
  // targets must survive its prefilter, not only the viewer filter.
  it("delegates and escalation targets find the item; others do not", async () => {
    const folder = path.join(root, "direct");
    fs.mkdirSync(path.join(folder, "context"), { recursive: true });
    fs.writeFileSync(path.join(folder, "context", "workqueue.yaml"), DIRECT_POLICY);
    const pid = createProject(
      { name: "Direct", folder },
      { createdBy: "owner", template: null },
    ).id;
    const created = await call(
      "workitems.create",
      { projectId: pid, queue: "direct", title: "Laptop", source: { fields: { amount: 1 } } },
      reqA,
    );
    const id = created.payload.item.id as string;
    const art = saveArtifact({ title: "稟議書", content: "v1", projectId: pid }, "device:req-a");
    const sub = await call(
      "workitems.update",
      { projectId: pid, id, patch: { draft: { artifactId: art.id } } },
      reqA,
    );
    expect(sub.payload.item.route.current).toBe(0);
    const awaiting = async (who: { device: string }) =>
      (await call("workitems.list", { projectId: pid, awaitingMe: true }, who)).payload.items.map(
        (i: Json) => i.id,
      );
    expect(await awaiting(mgr)).toEqual([id]);
    expect(await awaiting(deputy)).toEqual([]);
    expect(await awaiting(fin)).toEqual([]);
    expect(await awaiting(reqB)).toEqual([]);

    const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
    const del = await call(
      "workitems.delegate",
      { projectId: pid, id, to: "device:deputy-1", reason: "on leave", expiresAt },
      mgr,
    );
    expect(del.ok).toBe(true);
    expect(await awaiting(deputy)).toEqual([id]);
    expect(await awaiting(fin)).toEqual([]);

    // Escalation is recorded while listing, so the target's own list must reach the item.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 49 * 3_600_000);
      expect(await awaiting(fin)).toEqual([id]);
      expect(await awaiting(deputy)).toEqual([id]);
      expect(await awaiting(reqB)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("in-app notifications over the gateway", () => {
  it("each caller lists and marks only their own records, and only for items they can read", async () => {
    const created = await call(
      "workitems.create",
      {
        projectId,
        queue: "ringi",
        title: "Team offsite",
        source: { fields: { amount: 30000, department: "sales" } },
      },
      reqA,
    );
    const id = created.payload.item.id as string;
    const art = saveArtifact({ title: "稟議書", content: "v1", projectId }, "device:req-a");
    await call(
      "workitems.update",
      { projectId, id, patch: { draft: { artifactId: art.id } } },
      reqA,
    );

    const forItem = async (who: { device: string }, unreadOnly?: boolean) =>
      (
        await call("workitems.notifications.list", { projectId, unreadOnly }, who)
      ).payload.notifications.filter((n: Json) => n.itemId === id);
    const [mine] = await forItem(mgr);
    expect(mine).toMatchObject({ principal: "device:mgr-sales", reason: "awaiting_you" });
    expect(mine.title).toBeUndefined();
    // A record about an item the caller cannot read is never listed.
    recordNotifications(
      created.payload.item,
      [{ principal: "device:req-b", reason: "awaiting_you" }],
      new Date(),
    );
    expect(listNotifications(projectId, "device:req-b")).toHaveLength(1);
    expect(await forItem(reqB)).toEqual([]);

    // Someone else's id is not found for them; the owner marks it read explicitly.
    const theirs = await call("workitems.notifications.markRead", { projectId, id: mine.id }, reqB);
    expect(theirs.error?.details?.code).toBe("notification_not_found");
    const read = await call("workitems.notifications.markRead", { projectId, id: mine.id }, mgr);
    expect(read.payload.notification.readAt).not.toBeNull();
    expect(await forItem(mgr, true)).toEqual([]);
    expect(await forItem(mgr)).toHaveLength(1);

    // The requester hears about the decision; the request does not name a principal.
    await call("workitems.decide", { projectId, id, decision: "approve" }, mgr);
    expect((await forItem(reqA)).map((n: Json) => n.reason)).toEqual(["decided"]);
    const forged = await call(
      "workitems.notifications.list",
      { projectId, principal: "device:mgr-sales" },
      reqB,
    );
    expect(forged.ok).toBe(false);
  });
});
