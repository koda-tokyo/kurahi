import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Project } from "../projects/types.js";
import type { Actor, WorkItem } from "./types.js";
import { flushAudit } from "../audit/audit-log.js";
import { saveArtifact } from "../projects/artifacts.js";
import { createProject, projectDataDir } from "../projects/store.js";
import { canRead, viewerFilter } from "./access.js";
import { decideWorkItem } from "./decide.js";
import {
  delegateStage,
  escalateIfDue,
  sweepEscalations,
  withdrawDelegation,
} from "./escalation.js";
import { createWorkItem, updateWorkItem } from "./lifecycle.js";
import { loadWorkQueuePolicy, parsePolicy } from "./policy.js";
import { listWorkItems, readWorkItem, workItemDir } from "./store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-ringi-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

const person = (id: string, privileged = false): Actor => ({
  id: `device:${id}`,
  kind: "person",
  privileged,
});
const requester = person("requester01");
const other = person("requester02");
const mgrSales = person("mgr-sales01");
const mgrHr = person("mgr-hr00001");
const finance = person("finance0001");
const financeMgr = person("finance0002");
const director = person("director001");
const deputy = person("deputy00001");
const ops = person("opsadmin001");

const RINGI_POLICY = `
version: 1
timezone: Asia/Tokyo
separationOfDuties: true
queues:
  - { id: ringi, name: { ja: 稟議, en: Ringi }, types: [request] }
  - { id: plain, name: { en: Plain }, types: [request] }
routes:
  - id: ringi
    queues: [ringi]
    stages:
      - id: manager
        name: { ja: 所属長, en: Manager }
        approvers: { roles: [approver], departmentField: department }
        dueHours: 24
        delegation: true
        escalation: { afterHours: 48, to: { roles: [director] } }
      - id: finance
        when: [{ field: amount, gte: 100000 }]
        approvers: { roles: [finance] }
        onReturn: previous
      - id: director
        when: [{ field: amount, gte: 1000000 }]
        approvers: { roles: [director] }
        onReturn: previous
access:
  members:
    - { principal: device:mgr-sales01, roles: [approver], departments: [sales] }
    - { principal: device:mgr-hr00001, roles: [approver], departments: [HR] }
    - { principal: device:finance0001, roles: [finance] }
    - { principal: device:finance0002, roles: [finance, approver], departments: [sales] }
    - { principal: device:director001, roles: [director] }
    - { principal: device:opsadmin001, roles: [operator] }
rules: []
`;

let project: Project;
const T0 = new Date("2026-11-02T00:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

beforeAll(() => {
  const folder = path.join(root, "ringi");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  fs.writeFileSync(path.join(folder, "context", "workqueue.yaml"), RINGI_POLICY);
  project = createProject({ name: "Ringi", folder }, { createdBy: requester.id, template: null });
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

/** A submitted ringi item (person-made draft) in the given department and amount. */
function submitted(amount: number, department = "sales", by: Actor = requester, queue = "ringi") {
  const item = createWorkItem(
    project,
    { queue, title: `Spend ${amount}`, source: { fields: { amount, department, purpose: "x" } } },
    by,
    { now: T0 },
  );
  const art = saveArtifact(
    { title: "ringi", content: `# 稟議\n金額 ${amount}`, projectId: project.id },
    by.id,
  );
  return updateWorkItem(project, item.id, { draft: { artifactId: art.id } }, by, undefined, {
    now: T0,
  });
}

const approve = (item: WorkItem, who: Actor, hours = 1) =>
  decideWorkItem(project, item.id, { decision: "approve" }, who, undefined, { now: at(hours) });
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
  return "no refusal";
};

describe("policy routes", () => {
  it("parses routes and access, and rejects invalid ones (fail closed)", () => {
    const p = parsePolicy(RINGI_POLICY);
    expect(p.routes[0].stages.map((s) => s.id)).toEqual(["manager", "finance", "director"]);
    expect(p.access.members).toHaveLength(6);
    expect(() => parsePolicy("routes: [{ id: r, stages: [{ id: s }] }]")).toThrow(/approvers/);
    expect(() =>
      parsePolicy(
        "routes: [{ id: r, stages: [{ id: s, approvers: { roles: [x] }, when: [{ field: amount, gte: 1, lt: 5 }] }] }]",
      ),
    ).toThrow(/exactly one/);
  });

  it("settlement SoD is strict unless the policy says exactly warn", () => {
    expect(parsePolicy(RINGI_POLICY).settlementSod).toBe("strict");
    expect(parsePolicy("settlementSod: warn").settlementSod).toBe("warn");
    expect(parsePolicy("settlementSod: Warn").settlementSod).toBe("strict");
    expect(parsePolicy("settlementSod: off").settlementSod).toBe("strict");
  });

  it("only the administrator's policy can relax settlement SoD to warn", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-sod-src-"));
    const p = { id: "psodsrc0001", folder: path.join(dir, "folder"), templateId: null };
    const home = path.join(dir, "home");
    const projectFile = path.join(p.folder, "context", "workqueue.yaml");
    const adminFile = path.join(projectDataDir(p.id, home), "workqueue.yaml");
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.mkdirSync(path.dirname(adminFile), { recursive: true });
    try {
      fs.writeFileSync(projectFile, "settlementSod: warn\n");
      fs.writeFileSync(adminFile, "settlementSod: warn\n");
      expect(loadWorkQueuePolicy(p, home).source?.kind).toBe("project");
      expect(loadWorkQueuePolicy(p, home).settlementSod).toBe("strict");
      fs.rmSync(projectFile);
      expect(loadWorkQueuePolicy(p, home).source?.kind).toBe("admin");
      expect(loadWorkQueuePolicy(p, home).settlementSod).toBe("warn");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unreadable higher-priority policy fails closed instead of falling through", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-sod-eacces-"));
    const p = { id: "psodacc0001", folder: path.join(dir, "folder"), templateId: null };
    const home = path.join(dir, "home");
    const projectFile = path.join(p.folder, "context", "workqueue.yaml");
    const adminFile = path.join(projectDataDir(p.id, home), "workqueue.yaml");
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.mkdirSync(path.dirname(adminFile), { recursive: true });
    const read = fs.readFileSync;
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      file: fs.PathOrFileDescriptor,
      ...rest: unknown[]
    ) => {
      if (String(file) === projectFile) {
        throw Object.assign(new Error("simulated unreadable policy"), { code: "EACCES" });
      }
      return (read as (...a: unknown[]) => unknown)(file, ...rest);
    }) as typeof fs.readFileSync);
    try {
      fs.writeFileSync(projectFile, "settlementSod: strict\n");
      fs.writeFileSync(adminFile, "settlementSod: warn\n");
      const policy = loadWorkQueuePolicy(p, home);
      expect(policy.source?.kind).toBe("project");
      expect(policy.settlementSod).toBe("strict");
      expect(policy.error).toContain("EACCES");
    } finally {
      spy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stage progression", () => {
  it("conditional stages: small amounts need the manager only", () => {
    const item = submitted(50_000);
    expect(item.route?.kind).toBe("staged");
    expect(item.route?.stages.map((s) => s.id)).toEqual(["manager"]);
    expect(item.route?.skipped.map((s) => s.id)).toEqual(["finance", "director"]);
    expect(item.route?.skipped[0].reason).toMatch(/amount gte 100000 not met \(value: 50000\)/);
    expect(item.requiredApprovals).toBe(1);
    expect(approve(item, mgrSales).status).toBe("approved");
  });

  it("manager → finance → director; approved only after the last stage", () => {
    const item = submitted(2_000_000);
    expect(item.route?.stages.map((s) => s.id)).toEqual(["manager", "finance", "director"]);
    expect(item.route?.current).toBe(0);
    expect(item.route?.stages[0].dueAt).toBe(at(24).toISOString());
    expect(item.requiredApprovals).toBe(3);
    // Wrong department, wrong role, the requester: refused on the current stage.
    expect(refusal(() => approve(item, mgrHr))).toBe("not_an_approver");
    expect(refusal(() => approve(item, director))).toBe("not_an_approver");
    expect(refusal(() => approve(item, requester))).toBe("separation_of_duties");
    const s1 = approve(item, mgrSales);
    expect(s1.status).toBe("awaiting_review");
    expect(s1.route?.current).toBe(1);
    expect(s1.route?.stages[0].status).toBe("approved");
    expect(refusal(() => approve(item, mgrSales))).toBe("already_approved");
    const s2 = approve(item, finance, 2);
    expect(s2.route?.current).toBe(2);
    const done = approve(item, director, 3);
    expect(done.status).toBe("approved");
    expect(done.route?.current).toBeNull();
    expect(done.approvals.map((a) => [a.stageId, a.by])).toEqual([
      ["manager", mgrSales.id],
      ["finance", finance.id],
      ["director", director.id],
    ]);
    expect(done.history.filter((h) => h.action === "decide.approve")).toHaveLength(3);
  });

  it("one person never approves two stages; the requester never approves", () => {
    const item = submitted(500_000);
    approve(item, financeMgr); // approver for sales at the manager stage
    expect(refusal(() => approve(item, financeMgr))).toBe("already_approved");
    const own = submitted(500_000, "sales", mgrSales);
    expect(refusal(() => approve(own, mgrSales))).toBe("separation_of_duties");
  });

  it("department field routes to that department's manager", () => {
    const item = submitted(10_000, "hr");
    expect(item.route?.stages[0].approvers.department).toBe("hr");
    expect(refusal(() => approve(item, mgrSales))).toBe("not_an_approver");
    expect(approve(item, mgrHr).status).toBe("approved");
  });
});

describe("return paths", () => {
  it("finance sends back to the previous stage; the manager sends back to the requester", () => {
    const item = submitted(300_000);
    approve(item, mgrSales);
    const back = decideWorkItem(
      project,
      item.id,
      { decision: "send_back", comment: "budget code?" },
      finance,
      undefined,
      { now: at(2) },
    );
    expect(back.status).toBe("awaiting_review");
    expect(back.route?.current).toBe(0);
    expect(back.route?.stages[0].approvals).toEqual([]);
    expect(back.route?.stages[1].status).toBe("pending");
    expect(back.approvals).toEqual([]);
    expect(back.history.at(-1)?.detail).toMatchObject({ returnTo: "previous", toStage: "manager" });
    expect(
      refusal(() =>
        decideWorkItem(project, item.id, { decision: "send_back", comment: "x" }, mgrHr, undefined),
      ),
    ).toBe("not_an_approver");
    const toRequester = decideWorkItem(
      project,
      item.id,
      { decision: "send_back", comment: "please fix" },
      mgrSales,
      undefined,
      { now: at(3) },
    );
    expect(toRequester.status).toBe("sent_back");
    expect(toRequester.route?.current).toBeNull();
    expect(toRequester.route?.stages.every((s) => s.status === "pending")).toBe(true);
  });
});

describe("delegation", () => {
  it("an approver delegates with reason and expiry; the delegate decides on their behalf", () => {
    const item = submitted(20_000);
    const d = (input: Record<string, unknown>, who: Actor = mgrSales) =>
      refusal(() => delegateStage(project, item.id, input, who, undefined, { now: at(1) }));
    const exp = at(10).toISOString();
    expect(d({ to: deputy.id, reason: "on leave", expiresAt: exp }, mgrHr)).toBe("not_an_approver");
    expect(d({ to: deputy.id, reason: "x", expiresAt: exp })).toBe("reason_required");
    expect(d({ to: requester.id, reason: "on leave", expiresAt: exp })).toBe("invalid_delegate");
    expect(d({ to: deputy.id, reason: "on leave", expiresAt: at(24 * 31).toISOString() })).toBe(
      "invalid_expiry",
    );
    expect(refusal(() => approve(item, deputy))).toBe("not_an_approver");
    const delegated = delegateStage(
      project,
      item.id,
      { to: deputy.id, reason: "on business trip", expiresAt: exp },
      mgrSales,
      undefined,
      { now: at(1) },
    );
    expect(delegated.route?.stages[0].delegations[0]).toMatchObject({
      from: mgrSales.id,
      to: deputy.id,
      expiresAt: exp,
    });
    expect(delegated.history.at(-1)?.action).toBe("delegate");
    expect(delegated.history.at(-1)?.evidence?.bundle).toMatch(/-delegate$/);
    const ok = approve(item, deputy, 2);
    expect(ok.status).toBe("approved");
    expect(ok.approvals[0]).toMatchObject({
      by: deputy.id,
      onBehalfOf: mgrSales.id,
      via: "delegation",
    });
  });

  it("an expired delegation no longer lets the delegate decide; stages may forbid delegation", () => {
    const item = submitted(2_000_000);
    delegateStage(
      project,
      item.id,
      { to: deputy.id, reason: "covering today", expiresAt: at(4).toISOString() },
      mgrSales,
      undefined,
      { now: at(1) },
    );
    expect(refusal(() => approve(item, deputy, 5))).toBe("not_an_approver");
    approve(item, mgrSales, 5);
    approve(item, finance, 6);
    expect(
      refusal(() =>
        delegateStage(
          project,
          item.id,
          { to: deputy.id, reason: "covering today", expiresAt: at(10).toISOString() },
          director,
          undefined,
          { now: at(7) },
        ),
      ),
    ).toBe("delegation_not_allowed");
  });

  it("the delegator withdraws before the delegate acts; the delegate can no longer decide", () => {
    const item = submitted(21_000);
    const w = (who: Actor, hours = 2) =>
      refusal(() =>
        withdrawDelegation(project, item.id, { reason: "back early" }, who, undefined, {
          now: at(hours),
        }),
      );
    expect(w(mgrSales)).toBe("no_delegation");
    delegateStage(
      project,
      item.id,
      { to: deputy.id, reason: "on business trip", expiresAt: at(10).toISOString() },
      mgrSales,
      undefined,
      { now: at(1) },
    );
    expect(w(deputy)).toBe("no_delegation");
    expect(w({ id: mgrSales.id, kind: "agent" })).toBe("not_a_person");
    const back = withdrawDelegation(
      project,
      item.id,
      { reason: "back early" },
      mgrSales,
      undefined,
      { now: at(2) },
    );
    expect(back.route?.stages[0].delegations).toEqual([]);
    expect(back.history.at(-1)).toMatchObject({
      action: "delegate.withdraw",
      comment: "back early",
    });
    expect(back.history.at(-1)?.evidence?.bundle).toMatch(/-delegate\.withdraw$/);
    expect(refusal(() => approve(item, deputy, 3))).toBe("not_an_approver");
    expect(w(mgrSales, 3)).toBe("no_delegation");
    expect(approve(item, mgrSales, 4).approvals[0]).toMatchObject({
      by: mgrSales.id,
      via: "approver",
    });
  });

  it("refuses withdrawal after the delegate approves a stage that still needs another approval", () => {
    const folder = path.join(root, "ringi-two-approvals");
    fs.mkdirSync(path.join(folder, "context"), { recursive: true });
    fs.writeFileSync(
      path.join(folder, "context", "workqueue.yaml"),
      RINGI_POLICY.replace(
        "      - id: manager\n",
        "      - id: manager\n        minApprovals: 2\n",
      ),
    );
    const twoApprovalProject = createProject(
      { name: "Ringi two approvals", folder },
      { createdBy: requester.id, template: null },
    );
    const item = createWorkItem(
      twoApprovalProject,
      {
        queue: "ringi",
        title: "Two approvals",
        source: { fields: { amount: 20_000, department: "sales" } },
      },
      requester,
      { now: T0 },
    );
    const art = saveArtifact(
      { title: "ringi", content: "# Two approvals", projectId: twoApprovalProject.id },
      requester.id,
    );
    updateWorkItem(
      twoApprovalProject,
      item.id,
      { draft: { artifactId: art.id } },
      requester,
      undefined,
      { now: T0 },
    );
    delegateStage(
      twoApprovalProject,
      item.id,
      { to: deputy.id, reason: "on business trip", expiresAt: at(10).toISOString() },
      mgrSales,
      undefined,
      { now: at(1) },
    );
    const afterApproval = decideWorkItem(
      twoApprovalProject,
      item.id,
      { decision: "approve" },
      deputy,
      undefined,
      { now: at(2) },
    );
    expect(afterApproval.status).toBe("awaiting_review");
    expect(afterApproval.route?.stages[0].approvals).toHaveLength(1);
    expect(
      refusal(() =>
        withdrawDelegation(twoApprovalProject, item.id, {}, mgrSales, undefined, { now: at(3) }),
      ),
    ).toBe("already_approved");
    expect(readWorkItem(twoApprovalProject.id, item.id)?.route?.stages[0].delegations).toHaveLength(
      1,
    );
  });
});

describe("escalation", () => {
  it("marks an overdue stage, then escalates to the director; each mark once", () => {
    const item = submitted(30_000);
    expect(escalateIfDue(project, item, { now: at(23) })).toBe(item);
    const overdue = escalateIfDue(project, readWorkItem(project.id, item.id)!, { now: at(25) });
    expect(overdue.route?.stages[0].overdueAt).toBe(at(25).toISOString());
    expect(overdue.route?.stages[0].escalatedAt).toBeNull();
    expect(overdue.history.at(-1)).toMatchObject({ action: "stage.overdue", actorKind: "system" });
    expect(refusal(() => approve(item, director, 26))).toBe("not_an_approver");
    const page = listWorkItems(project.id, {}, {}, { now: at(26) });
    expect(page.items.find((i) => i.id === item.id)?.currentStage).toMatchObject({
      id: "manager",
      overdue: true,
      escalated: false,
    });
    const changed = sweepEscalations(project, { now: at(49) });
    expect(changed.map((c) => c.id)).toContain(item.id);
    const esc = readWorkItem(project.id, item.id)!;
    expect(esc.route?.stages[0].escalatedAt).toBe(at(49).toISOString());
    expect(esc.history.at(-1)?.action).toBe("stage.escalate");
    const again = sweepEscalations(project, { now: at(50) });
    expect(again.map((c) => c.id)).not.toContain(item.id);
    const ok = approve(item, director, 50);
    expect(ok.status).toBe("approved");
    expect(ok.approvals[0].via).toBe("escalation");
  });
});

describe("ownership and visibility", () => {
  it("mine and awaitingMe are per principal; others' items stay private", () => {
    const mine = createWorkItem(project, { queue: "plain", title: "mine" }, other, { now: T0 });
    const policy = loadWorkQueuePolicy(project);
    const fresh = readWorkItem(project.id, mine.id)!;
    expect(fresh.requestedBy).toBe(other.id);
    expect(canRead(fresh, requester, policy, at(1))).toBe(false);
    expect(canRead(fresh, ops, policy, at(1))).toBe(true); // operator role
    expect(canRead(fresh, person("anyone00001", true), policy, at(1))).toBe(true); // operator.admin
    const list = (who: Actor, f: { mine?: boolean; awaitingMe?: boolean }) =>
      listWorkItems(
        project.id,
        { where: viewerFilter(who, policy, project.id, { ...f, now: at(1) }) },
        { limit: 200 },
        { now: at(1) },
      ).items;
    expect(list(other, { mine: true }).map((i) => i.id)).toEqual([mine.id]);
    expect(list(ops, { mine: true })).toEqual([]);
    expect(list(requester, {}).some((i) => i.id === mine.id)).toBe(false);

    const sales = submitted(400_000);
    const hr = submitted(400_000, "hr");
    const awaitingSales = list(mgrSales, { awaitingMe: true }).map((i) => i.id);
    expect(awaitingSales).toContain(sales.id);
    expect(awaitingSales).not.toContain(hr.id);
    expect(list(finance, { awaitingMe: true }).map((i) => i.id)).not.toContain(sales.id);
    approve(sales, mgrSales, 2);
    expect(list(mgrSales, { awaitingMe: true }).map((i) => i.id)).not.toContain(sales.id);
    expect(list(mgrSales, {}).map((i) => i.id)).toContain(sales.id); // participated
    expect(list(finance, { awaitingMe: true }).map((i) => i.id)).toContain(sales.id);
    expect(list(mgrHr, {}).map((i) => i.id)).not.toContain(sales.id);
  });

  it("only the requester, an operator or a current approver may cancel", () => {
    const item = submitted(10_000);
    const cancel = (who: Actor) =>
      decideWorkItem(
        project,
        item.id,
        { decision: "cancel", comment: "no longer needed" },
        who,
        undefined,
      );
    expect(refusal(() => cancel(mgrHr))).toBe("not_authorised");
    expect(cancel(requester).status).toBe("cancelled");
  });
});

describe("backward compatibility", () => {
  it("an item stored before routes gets a single-stage route and decides as before", () => {
    const item = submitted(10_000, "sales", requester, "plain");
    expect(item.route).toMatchObject({ kind: "single", id: "single", current: 0 });
    expect(item.route?.stages[0].approvers.any).toBe(true);
    const file = path.join(workItemDir(project.id, item.id), "item.json");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    delete raw.requestedBy;
    delete raw.route;
    fs.writeFileSync(file, JSON.stringify(raw));
    const legacy = readWorkItem(project.id, item.id)!;
    expect(legacy.requestedBy).toBe(requester.id);
    expect(legacy.route).toBeNull();
    expect(canRead(legacy, deputy, loadWorkQueuePolicy(project), at(1))).toBe(true); // any approver
    const ok = approve(legacy, deputy);
    expect(ok.status).toBe("approved");
    expect(ok.approvals).toMatchObject([{ by: deputy.id, stageId: "review", via: "approver" }]);
  });
});
