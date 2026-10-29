import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import type { WorkQueuePolicy } from "./policy.js";
import type { Actor, WorkItem } from "./types.js";
import { flushAudit } from "../audit/audit-log.js";
import { saveArtifact } from "../projects/artifacts.js";
import { createProject, projectDataDir } from "../projects/store.js";
import { awaitsPrincipal, setPrincipalGroupResolver } from "./access.js";
import { decideWorkItem } from "./decide.js";
import { delegateStage, escalateIfDue, withdrawDelegation } from "./escalation.js";
import { createWorkItem, updateWorkItem } from "./lifecycle.js";
import { listNotifications } from "./notifications-store.js";
import { notificationRecipients } from "./notify.js";
import { parsePolicy } from "./policy.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-notify-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

const person = (id: string): Actor => ({ id: `device:${id}`, kind: "person", privileged: false });
const requester = person("requester01");
const mgrSales = person("mgr-sales01");
const finance = person("finance0001");
const financeMgr = person("finance0002");
const director = person("director001");
const deputy = person("deputy00001");

const POLICY = `
version: 1
timezone: Asia/Tokyo
separationOfDuties: true
queues:
  - { id: ringi, name: { en: Ringi }, types: [request] }
routes:
  - id: ringi
    queues: [ringi]
    stages:
      - id: manager
        approvers: { roles: [approver], departmentField: department }
        dueHours: 24
        delegation: true
        escalation: { afterHours: 48, to: { roles: [director] } }
      - id: finance
        when: [{ field: amount, gte: 100000 }]
        approvers: { roles: [finance] }
access:
  members:
    - { principal: device:mgr-sales01, roles: [approver], departments: [sales] }
    - { principal: device:mgr-hr00001, roles: [approver], departments: [HR] }
    - { principal: device:finance0001, roles: [finance] }
    - { principal: device:finance0002, roles: [finance, approver], departments: [sales] }
    - { principal: device:director001, roles: [director] }
  groups:
    finance-team: { roles: [finance] }
rules: []
`;

let project: Project;
let policy: WorkQueuePolicy;
const T0 = new Date("2026-11-02T00:00:00Z");
const at = (hours: number) => new Date(T0.getTime() + hours * 3_600_000);

beforeAll(() => {
  const folder = path.join(root, "notify");
  fs.mkdirSync(path.join(folder, "context"), { recursive: true });
  fs.writeFileSync(path.join(folder, "context", "workqueue.yaml"), POLICY);
  project = createProject({ name: "Notify", folder }, { createdBy: requester.id, template: null });
  policy = parsePolicy(POLICY);
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

/** Create, then submit (attach a draft); returns both revisions. */
function submit(amount: number, by: Actor = requester): { created: WorkItem; submitted: WorkItem } {
  const created = createWorkItem(
    project,
    {
      queue: "ringi",
      title: `Spend ${amount}`,
      source: { fields: { amount, department: "sales" } },
    },
    by,
    { now: T0 },
  );
  const art = saveArtifact({ title: "ringi", content: "# x", projectId: project.id }, by.id);
  const submitted = updateWorkItem(
    project,
    created.id,
    { draft: { artifactId: art.id } },
    by,
    undefined,
    { now: T0 },
  );
  return { created, submitted };
}

const approve = (item: WorkItem, who: Actor, hours = 1) =>
  decideWorkItem(project, item.id, { decision: "approve" }, who, undefined, { now: at(hours) });
const sorted = (r: { principal: string; reason: string }[]) =>
  [...r].toSorted((a, b) => a.principal.localeCompare(b.principal));

describe("notificationRecipients", () => {
  it("tells the current stage's approvers on submit, and nobody on a same-revision rewrite", () => {
    const { created, submitted } = submit(20_000);
    expect(sorted(notificationRecipients(created, submitted, policy, T0))).toEqual(
      [
        { principal: mgrSales.id, reason: "awaiting_you" },
        { principal: financeMgr.id, reason: "awaiting_you" },
      ].toSorted((a, b) => a.principal.localeCompare(b.principal)),
    );
    expect(notificationRecipients(submitted, submitted, policy, T0)).toEqual([]);
  });

  it("tells only the next stage on advance, and respects separation of duties", () => {
    // financeMgr requests: they are a finance approver, but never awaited on their own item.
    const { submitted } = submit(200_000, financeMgr);
    const advanced = approve(submitted, mgrSales);
    expect(advanced.route?.current).toBe(1);
    expect(notificationRecipients(submitted, advanced, policy, at(1))).toEqual([
      { principal: finance.id, reason: "awaiting_you" },
    ]);
  });

  it("tells the deputy on delegate and on withdraw, never the delegator", () => {
    const { submitted } = submit(20_000);
    const delegated = delegateStage(
      project,
      submitted.id,
      { to: deputy.id, reason: "on business trip", expiresAt: at(10).toISOString() },
      mgrSales,
      undefined,
      { now: at(1) },
    );
    expect(notificationRecipients(submitted, delegated, policy, at(1))).toEqual([
      { principal: deputy.id, reason: "delegated_to_you" },
    ]);
    const withdrawn = withdrawDelegation(project, submitted.id, {}, mgrSales, undefined, {
      now: at(2),
    });
    expect(notificationRecipients(delegated, withdrawn, policy, at(2))).toEqual([
      { principal: deputy.id, reason: "delegation_withdrawn" },
    ]);
  });

  it("tells escalation targets when the sweep escalates", () => {
    const { submitted } = submit(20_000);
    const escalated = escalateIfDue(project, submitted, { now: at(49) });
    expect(escalated.history.at(-1)?.action).toBe("stage.escalate");
    expect(notificationRecipients(submitted, escalated, policy, at(49))).toEqual([
      { principal: director.id, reason: "escalated_to_you" },
    ]);
  });

  it("tells the requester when someone else decides", () => {
    const { submitted } = submit(20_000);
    const approved = approve(submitted, mgrSales);
    expect(approved.status).toBe("approved");
    expect(notificationRecipients(submitted, approved, policy, at(1))).toEqual([
      { principal: requester.id, reason: "decided" },
    ]);
    const other = submit(20_000).submitted;
    const sentBack = decideWorkItem(
      project,
      other.id,
      { decision: "send_back", comment: "fix" },
      mgrSales,
      undefined,
      { now: at(1) },
    );
    expect(notificationRecipients(other, sentBack, policy, at(1))).toEqual([
      { principal: requester.id, reason: "decided" },
    ]);
  });

  it("never tells the actor about their own change", () => {
    const { submitted } = submit(20_000);
    const cancelled = decideWorkItem(
      project,
      submitted.id,
      { decision: "cancel", comment: "no longer needed" },
      requester,
      undefined,
      { now: at(1) },
    );
    expect(cancelled.status).toBe("cancelled");
    expect(notificationRecipients(submitted, cancelled, policy, at(1))).toEqual([]);
  });

  it("does not reach members known only through a group (documented gap)", () => {
    // finance0003 is a finance approver only via finance-team: awaited, but nobody can list them.
    const groupOnly = "device:finance0003";
    setPrincipalGroupResolver((p) => (p === groupOnly ? ["finance-team"] : null));
    try {
      const { submitted } = submit(200_000);
      const advanced = approve(submitted, mgrSales);
      expect(awaitsPrincipal(advanced, groupOnly, policy, at(1))).toBe(true);
      const told = notificationRecipients(submitted, advanced, policy, at(1)).map(
        (r) => r.principal,
      );
      expect(told).toContain(finance.id);
      expect(told).not.toContain(groupOnly);
    } finally {
      setPrincipalGroupResolver(null);
    }
  });
});

describe("the write boundary records notifications", () => {
  const mine = (principal: string, itemId: string) =>
    listNotifications(project.id, principal).filter((r) => r.itemId === itemId);

  it("stores each transition's recipients, and the decision for the requester", () => {
    const { submitted } = submit(20_000);
    expect(mine(mgrSales.id, submitted.id)).toMatchObject([
      { reason: "awaiting_you", revision: submitted.revision, readAt: null },
    ]);
    expect(mine(requester.id, submitted.id)).toEqual([]);
    const approved = approve(submitted, mgrSales);
    expect(approved.status).toBe("approved");
    expect(mine(requester.id, submitted.id)).toMatchObject([
      { reason: "decided", revision: approved.revision },
    ]);
    // The approver acted; they are not told about their own decision.
    expect(mine(mgrSales.id, submitted.id)).toHaveLength(1);
  });

  it("never fails the write, and one unreadable inbox does not skip the others", () => {
    const dir = path.join(projectDataDir(project.id), "notifications");
    const file = path.join(dir, `${createHash("sha256").update(mgrSales.id).digest("hex")}.json`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, "{}");
    try {
      const { submitted } = submit(20_000);
      expect(submitted.status).toBe("awaiting_review");
      expect(mine(financeMgr.id, submitted.id)).toMatchObject([{ reason: "awaiting_you" }]);
      expect(() => listNotifications(project.id, mgrSales.id)).toThrow(/corrupt/);
    } finally {
      fs.rmSync(file);
    }
  });
});
