import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import type { Actor } from "./types.js";
import { flushAudit } from "../audit/audit-log.js";
import { verifyEvidenceBundle } from "../evidence/verify.js";
import { getArtifact, saveArtifact } from "../projects/artifacts.js";
import { loadProjectPack, PACK_BUDGET_CHARS, seedStarterPack } from "../projects/pack.js";
import { createProject, projectDataDir } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { decideWorkItem, DecisionRefused } from "./decide.js";
import { assignAgent } from "./drafting.js";
import { evidenceBundleDir, listEvidenceBundles } from "./evidence.js";
import { createWorkItem, updateWorkItem } from "./lifecycle.js";
import { evaluatePolicy, loadWorkQueuePolicy, parsePolicy } from "./policy.js";
import { listWorkItems, readWorkItem, withItemLock, workItemDir } from "./store.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-workitems-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");

const clerk: Actor = { id: "device:clerk0000001", kind: "person" };
const manager: Actor = { id: "device:manager00001", kind: "person" };
const director: Actor = { id: "device:director0001", kind: "person" };
const agent: Actor = { id: "agent:main", kind: "agent" };
const templates = loadTemplates(resolveTemplatesDir({}));

function makeProject(name: string, templateId: string | null): Project {
  const folder = path.join(root, "folders", name);
  fs.mkdirSync(folder, { recursive: true });
  const template = templateId ? (templates.find((t) => t.id === templateId) ?? null) : null;
  return createProject({ name, folder }, { createdBy: clerk.id, template });
}

let finance: Project;
let hr: Project;
let other: Project;

beforeAll(() => {
  finance = makeProject("finance", "business-finance-expense-invoice");
  hr = makeProject("hr", "business-hr-leave-overtime");
  other = makeProject("other", "business-procurement");
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

function expense(amount: number, extra: Record<string, unknown> = {}) {
  return createWorkItem(
    finance,
    {
      queue: "fin-expense",
      title: `Taxi ${amount}`,
      source: {
        fields: {
          employeeId: "E100",
          amount,
          expenseDate: "2026-10-01",
          category: "travel",
          purpose: "client visit",
          ...extra,
        },
      },
    },
    clerk,
    { now: new Date("2026-10-23T01:00:00Z") },
  );
}

describe("business templates", () => {
  it.each([
    "business-general-affairs",
    "business-hr-leave-overtime",
    "business-finance-expense-invoice",
    "business-procurement",
  ])("%s has JA + EN text, a valid policy and a pack within budget", (id) => {
    const t = templates.find((x) => x.id === id);
    expect(t?.name.ja && t.name.en).toBeTruthy();
    expect(t?.starterPrompts.every((p) => p.ja && p.en)).toBe(true);
    const packDir = path.join(resolveTemplatesDir({}), "packs", id);
    const policy = parsePolicy(fs.readFileSync(path.join(packDir, "workqueue.yaml"), "utf8"));
    expect(policy.queues.length).toBeGreaterThan(0);
    expect(policy.rules.length).toBeGreaterThan(2);
    const p = makeProject(`pack-${id}`, id);
    expect(seedStarterPack(p.id, packDir)).toBeGreaterThan(1);
    const pack = loadProjectPack(p);
    expect(pack.totalChars).toBeLessThanOrEqual(PACK_BUDGET_CHARS);
    expect(pack.files.some((f) => f.truncated)).toBe(false);
  });
});

describe("policy checks", () => {
  const now = new Date("2026-10-23T01:00:00Z");
  const policy = loadWorkQueuePolicy({
    id: "p0000000000",
    folder: root,
    templateId: "business-hr-leave-overtime",
  });

  it("required fields, thresholds with a second approver, dates and attachments", () => {
    const item = {
      type: "request" as const,
      queue: "hr-overtime",
      source: {
        documents: [],
        fields: {
          employeeId: "E1",
          date: "2026-10-24",
          hours: 3,
          reason: "release",
          monthToDateHours: 40,
          forecastMonthHours: 52,
        },
      },
    };
    const { checks, requiredApprovals } = evaluatePolicy(policy, item, null, now);
    const by = Object.fromEntries(checks.map((c) => [c.policyId, c]));
    expect(by["hr.ot.required"].result).toBe("pass");
    expect(by["hr.ot.forecast"].result).toBe("warn");
    expect(by["hr.ot.forecast"].evidence).toMatchObject({ value: 52, secondApproverAbove: 45 });
    expect(requiredApprovals).toBe(2);
    expect(by["hr.leave.required"]).toBeUndefined();

    const over = evaluatePolicy(
      policy,
      {
        ...item,
        source: {
          documents: [],
          fields: { ...item.source.fields, forecastMonthHours: 81, hours: 9 },
        },
      },
      null,
      now,
    );
    expect(over.checks.find((c) => c.policyId === "hr.ot.forecast")?.result).toBe("fail");
    expect(over.checks.find((c) => c.policyId === "hr.ot.hours")?.blocking).toBe(true);

    const leave = evaluatePolicy(
      policy,
      {
        type: "leave",
        queue: "hr-leave",
        source: {
          documents: [],
          fields: {
            employeeId: "E1",
            leaveType: "paid",
            startDate: "2026-10-24",
            endDate: "2026-10-22",
          },
        },
      },
      null,
      now,
    );
    const dates = leave.checks.find((c) => c.policyId === "hr.leave.dates")!;
    expect(dates.result).toBe("fail");
    expect(dates.evidence.problems).toEqual(["less than 3 days ahead", "after endDate"]);
    expect(leave.checks.find((c) => c.policyId === "hr.attachment")?.result).toBe("warn");
  });

  it("forbidden phrases are found in the draft with an excerpt", () => {
    const item = {
      type: "request" as const,
      queue: "hr-overtime",
      source: { documents: [], fields: {} },
    };
    const { checks } = evaluatePolicy(
      policy,
      item,
      { text: "ご申請の残業は承認済みです。", version: 1 },
      now,
    );
    const hit = checks.find((c) => c.policyId === "hr.phrases")!;
    expect(hit.result).toBe("fail");
    expect(hit.draftVersion).toBe(1);
    expect((hit.evidence.hits as Array<{ phrase: string }>)[0].phrase).toBe("承認済み");
  });

  it("an invalid policy fails closed", () => {
    fs.writeFileSync(
      path.join(projectDataDir(other.id), "workqueue.yaml"),
      "rules:\n  - kind: nope\n",
    );
    const p = loadWorkQueuePolicy(other);
    expect(p.error).toMatch(/id is required/);
    const { checks } = evaluatePolicy(
      p,
      { type: "purchase", queue: "x", source: { documents: [], fields: {} } },
      null,
    );
    expect(checks).toMatchObject([{ policyId: "policy.invalid", result: "fail", blocking: true }]);
    fs.rmSync(path.join(projectDataDir(other.id), "workqueue.yaml"));
    expect(loadWorkQueuePolicy(other).source.kind).toBe("template");
  });
});

describe("lifecycle", () => {
  it("create → agent draft → checks → approve → done, with evidence for every step", async () => {
    const item = expense(12000);
    expect(item.status).toBe("new");
    expect(item.dueAt).toBe("2026-10-26T01:00:00.000Z");
    expect(item.checks.find((c) => c.policyId === "fin.receipt")?.result).toBe("fail");

    const { item: drafting, done } = assignAgent(
      finance,
      item.id,
      {},
      clerk,
      item.revision,
      async (req) => {
        expect(req.sessionKey).toBe(`agent:main:proj-${finance.id}-wi${item.id.slice(1)}`);
        expect(req.message).toContain("fin.expense.amount");
        return { text: "# 確認結果\n領収書と金額が一致しています。" };
      },
    );
    expect(drafting.status).toBe("drafting");
    expect(drafting.assignee).toEqual({ kind: "agent", id: "main" });
    const drafted = (await done)!;
    expect(drafted.status).toBe("awaiting_review");
    expect(drafted.draft?.version).toBe(1);
    const art = getArtifact(drafted.draft!.artifactId, null).artifact;
    expect(art.status).toBe("review");
    expect(art.projectId).toBe(finance.id);
    expect(drafted.checks.every((c) => c.draftVersion === 1)).toBe(true);

    // No receipt attached: the blocking check refuses a plain approve.
    expect(() =>
      decideWorkItem(finance, item.id, { decision: "approve" }, manager, undefined),
    ).toThrow(/blocking checks failed \(fin.receipt\)/);
    const approved = decideWorkItem(
      finance,
      item.id,
      {
        decision: "approve",
        override: { reason: "Receipt lost; card statement checked by accounting" },
      },
      manager,
      undefined,
    );
    expect(approved.status).toBe("approved");
    expect(approved.override).toMatchObject({ by: manager.id, policyIds: ["fin.receipt"] });
    expect(getArtifact(drafted.draft!.artifactId, null).artifact.status).toBe("approved");
    const fin = updateWorkItem(finance, item.id, { status: "done" }, clerk, approved.revision);
    expect(fin.status).toBe("done");
    expect(fin.history.map((h) => h.action)).toEqual([
      "create",
      "assign_agent",
      "draft",
      "decide.approve",
      "done",
    ]);

    const bundles = listEvidenceBundles(fin);
    expect(bundles).toHaveLength(5);
    for (const b of bundles) {
      const v = await verifyEvidenceBundle(evidenceBundleDir(fin, b));
      expect(v.problems).toEqual([]);
      expect(v.ok).toBe(true);
    }
    const ov = fs.readFileSync(
      path.join(evidenceBundleDir(fin, bundles[3]), "events.jsonl"),
      "utf8",
    );
    expect(ov).toContain("Receipt lost");
    expect(ov).toContain('"type":"approval"');
  });

  it("only a person decides; send back needs a comment and returns to drafting", async () => {
    const item = expense(8000);
    const { done } = assignAgent(finance, item.id, {}, clerk, undefined, async () => ({
      text: "draft one",
    }));
    await done;
    expect(() =>
      decideWorkItem(finance, item.id, { decision: "approve" }, agent, undefined),
    ).toThrow(DecisionRefused);
    expect(() =>
      decideWorkItem(finance, item.id, { decision: "send_back" }, manager, undefined),
    ).toThrow(/comment/);
    const back = decideWorkItem(
      finance,
      item.id,
      { decision: "send_back", comment: "receipt missing" },
      manager,
      undefined,
    );
    expect(back.status).toBe("sent_back");
    const again = assignAgent(finance, item.id, {}, clerk, undefined, async (req) => {
      expect(req.message).toContain("receipt missing");
      return { text: "draft two" };
    });
    expect((await again.done)?.draft?.version).toBe(1);
    expect((await again.done)?.runIds).toHaveLength(2);
  });

  it("a failed run goes back to where it started, with the error kept", async () => {
    const item = expense(5000);
    const { done } = assignAgent(finance, item.id, {}, clerk, undefined, async () => {
      throw new Error("model unavailable");
    });
    const after = (await done)!;
    expect(after.status).toBe("new");
    expect(after.lastError).toBe("model unavailable");
  });

  it("amounts above the threshold need two distinct approvers, never the creator", () => {
    const item = expense(80000);
    const a = saveArtifact(
      { title: "manual", content: "manual review", projectId: finance.id },
      clerk.id,
    );
    const sub = updateWorkItem(finance, item.id, { draft: { artifactId: a.id } }, clerk, undefined);
    expect(sub.status).toBe("awaiting_review");
    expect(sub.requiredApprovals).toBe(2);
    const reason = { reason: "receipt checked on paper" };
    expect(() =>
      decideWorkItem(finance, item.id, { decision: "approve", override: reason }, clerk, undefined),
    ).toThrow(/created this item cannot approve/);
    const first = decideWorkItem(
      finance,
      item.id,
      { decision: "approve", override: reason },
      manager,
      undefined,
    );
    expect(first.status).toBe("awaiting_review");
    expect(() =>
      decideWorkItem(
        finance,
        item.id,
        { decision: "approve", override: reason },
        manager,
        undefined,
      ),
    ).toThrow(/already approved/);
    const second = decideWorkItem(
      finance,
      item.id,
      { decision: "approve", override: reason },
      director,
      undefined,
    );
    expect(second.status).toBe("approved");
    expect(second.approvals.map((x) => x.by)).toEqual([manager.id, director.id]);
  });

  it("refuses decision fields in update and stale revisions", () => {
    const item = expense(1000);
    expect(() => updateWorkItem(finance, item.id, { approvals: [] }, clerk, undefined)).toThrow(
      /workitems.decide/,
    );
    expect(() =>
      updateWorkItem(finance, item.id, { status: "approved" }, clerk, undefined),
    ).toThrow(/not an update/);
    const up = updateWorkItem(finance, item.id, { priority: "high" }, clerk, item.revision);
    expect(up.revision).toBe(item.revision + 1);
    expect(() =>
      updateWorkItem(finance, item.id, { priority: "low" }, clerk, item.revision),
    ).toThrow(/reload/);
  });
});

describe("project scoping, paging and concurrency", () => {
  it("items never leak across projects", () => {
    const item = createWorkItem(
      hr,
      { queue: "hr-leave", title: "Leave E7", source: { fields: { employeeId: "E7" } } },
      clerk,
    );
    expect(readWorkItem(finance.id, item.id)).toBeNull();
    expect(() => updateWorkItem(finance, item.id, { title: "x" }, clerk, undefined)).toThrow(
      /not found/,
    );
    expect(() => createWorkItem(hr, { queue: "fin-expense", title: "x" }, clerk)).toThrow(
      /not defined/,
    );
    const art = saveArtifact({ title: "fin", content: "x", projectId: finance.id }, clerk.id);
    expect(() =>
      updateWorkItem(hr, item.id, { draft: { artifactId: art.id } }, clerk, undefined),
    ).toThrow(/not in this project/);
    expect(listWorkItems(hr.id, {}).items.map((i) => i.id)).toEqual([item.id]);
  });

  it("pages with a stable cursor (max 200) and filters", () => {
    const p = makeProject("paging", "business-procurement");
    const base = Date.parse("2026-01-01T00:00:00Z");
    for (let i = 0; i < 230; i++) {
      createWorkItem(
        p,
        { queue: "proc-requests", title: `PR ${i}`, priority: i % 2 ? "high" : "normal" },
        clerk,
        {
          now: new Date(base + Math.floor(i / 3) * 1000),
        },
      );
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = listWorkItems(p.id, {}, { cursor, limit: 500 });
      expect(page.items.length).toBeLessThanOrEqual(200);
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor);
    expect(pages).toBe(2);
    expect(new Set(seen).size).toBe(230);
    const high = listWorkItems(p.id, { priority: ["high"] }, { limit: 50 });
    expect(high.total).toBe(115);
    expect(high.counts.new).toBe(115);
    expect(() => listWorkItems(p.id, {}, { cursor: "bad" })).toThrow(/cursor/);
  });

  it("concurrent writers keep every change (lock + revision)", async () => {
    const item = expense(2000);
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        Promise.resolve().then(() =>
          updateWorkItem(finance, item.id, { title: `t${i}` }, clerk, undefined),
        ),
      ),
    );
    const after = readWorkItem(finance.id, item.id)!;
    expect(after.revision).toBe(item.revision + 40);
    expect(after.history).toHaveLength(41);
    expect(listEvidenceBundles(after)).toHaveLength(41);
  });

  it("waits for a held lock and breaks a stale one", () => {
    const item = expense(3000);
    const dir = workItemDir(finance.id, item.id);
    const lock = path.join(dir, ".lock");
    fs.writeFileSync(lock, "999999\n");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(withItemLock(dir, () => "ok")).toBe("ok");
    expect(fs.existsSync(lock)).toBe(false);
    fs.writeFileSync(lock, "999999\n");
    const t0 = Date.now();
    expect(() => updateWorkItem(finance, item.id, { title: "x" }, clerk, undefined)).toThrow(
      /busy/,
    );
    expect(Date.now() - t0).toBeGreaterThanOrEqual(4000);
    fs.rmSync(lock);
  }, 15_000);
});
