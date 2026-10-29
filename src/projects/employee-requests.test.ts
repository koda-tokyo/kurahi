import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { flushAudit } from "../audit/audit-log.js";
import { loadRoutines } from "../autopilot/routines.js";
import { evaluatePolicy } from "../workitems/checks.js";
import { createWorkItem, updateWorkItem } from "../workitems/lifecycle.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { buildRoute } from "../workitems/routes.js";
import { loadProjectPack, seedStarterFiles, seedStarterPack } from "./pack.js";
import { createProject } from "./store.js";
import { loadTemplates, resolveTemplatesDir } from "./templates.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-employee-pack-"));
const homeBefore = process.env.KOLO_HOME;
const stateBefore = process.env.KOLO_STATE_DIR;
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");
afterAll(async () => {
  await flushAudit();
  if (homeBefore === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = homeBefore;
  }
  if (stateBefore === undefined) {
    delete process.env.KOLO_STATE_DIR;
  } else {
    process.env.KOLO_STATE_DIR = stateBefore;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
const template = loadTemplates(resolveTemplatesDir({})).find(
  (t) => t.id === "business-employee-requests",
)!;
const folder = path.join(root, "project");
fs.mkdirSync(folder);
const project = createProject(
  { name: "Employee requests example", folder },
  { createdBy: "device:requester01", template },
);
const policy = loadWorkQueuePolicy(project);
const now = new Date("2035-01-01T00:00:00Z");
const common = {
  requester: "Example Employee",
  department: "operations",
  description: "Please review this request",
  neededBy: "2035-01-05",
};
const cases = [
  {
    queue: "er-equipment",
    role: "it-reviewer",
    fields: {
      item: "Laptop",
      quantity: 1,
      estimatedCost: 50000,
      budgetCode: "EX-01",
      businessReason: "Replacement",
    },
  },
  {
    queue: "er-cards",
    role: "admin-reviewer",
    fields: {
      printedName: "Example Employee",
      jobTitle: "Coordinator",
      workEmail: "employee@example.invalid",
      quantity: 100,
      deliveryLocation: "Office reception",
    },
  },
  {
    queue: "er-facilities",
    role: "facilities-reviewer",
    fields: {
      location: "Room A",
      startsOn: "2035-01-05",
      endsOn: "2035-01-05",
      attendees: 4,
      purpose: "Planning",
    },
  },
  {
    queue: "er-certificates",
    role: "hr-reviewer",
    fields: {
      certificateType: "Employment",
      purpose: "Personal records",
      language: "ja",
      deliveryMethod: "Verified internal collection",
    },
  },
];
function check(queue: string, fields: Record<string, unknown>, draft: string | null = null) {
  return evaluatePolicy(
    policy,
    { queue, type: "request", source: { fields, documents: [] } },
    draft === null ? null : { text: draft, version: 1 },
    now,
  );
}

describe("Employee requests starter pack", () => {
  it("loads through the template registry, seeds bilingual forms without overwriting, and fits context", () => {
    expect(template).toBeDefined();
    expect(policy.error).toBeNull();
    expect(policy.access.fallback).toBe("none");
    expect(policy.separationOfDuties).toBe(true);
    expect(policy.queues).toHaveLength(5);
    expect(policy.queues.every((q) => q.name.ja && q.name.en && q.slaHours)).toBe(true);
    const packDir = path.join(resolveTemplatesDir({}), "packs", template.id);
    expect(seedStarterPack(project.id, packDir)).toBe(3);
    const pack = loadProjectPack(project);
    expect(pack.files.every((f) => !f.truncated)).toBe(true);
    expect(seedStarterFiles(project, packDir, template.starterFiles)).toHaveLength(5);
    for (const file of template.starterFiles) {
      const content = fs.readFileSync(path.join(folder, file), "utf8");
      if (file !== "requests/fulfillment.md") {
        expect(content).toContain("source.fields");
      }
      expect(content).toContain("記入");
    }
    for (const file of template.starterFiles) {
      fs.writeFileSync(path.join(folder, file), `Person's completed form: ${file}`);
    }
    expect(seedStarterFiles(project, packDir, template.starterFiles)).toEqual([]);
    for (const file of template.starterFiles) {
      expect(fs.readFileSync(path.join(folder, file), "utf8")).toBe(
        `Person's completed form: ${file}`,
      );
    }
  });

  it.each(cases)(
    "validates category fields and reviewer routing for $queue",
    ({ queue, role, fields }) => {
      const source = { fields: { ...common, ...fields }, documents: [] };
      expect(check(queue, source.fields).checks.every((c) => c.result === "pass")).toBe(true);
      const route = buildRoute(policy, { queue, type: "request", source, requiredApprovals: 1 });
      expect(route.stages[0].approvers.roles).toEqual([role]);
      for (const field of Object.keys(fields)) {
        const missing: Record<string, unknown> = { ...source.fields };
        delete missing[field];
        expect(check(queue, missing).checks).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              policyId: `${queue}.required`,
              result: "fail",
              blocking: true,
            }),
          ]),
        );
      }
      expect(
        check(queue, source.fields).checks.filter((c) => c.policyId.endsWith(".required")),
      ).toHaveLength(1);
    },
  );

  it("requires a budget stage only above the boundary, and blocks excessive or invalid cost", () => {
    for (const [cost, stages] of [
      [100000, 1],
      [100001, 2],
    ]) {
      const source = {
        fields: { ...common, ...cases[0].fields, estimatedCost: cost },
        documents: [],
      };
      expect(
        buildRoute(policy, { queue: "er-equipment", type: "request", source, requiredApprovals: 1 })
          .stages,
      ).toHaveLength(stages);
    }
    for (const estimatedCost of [500001, "not priced"]) {
      expect(
        check("er-equipment", { ...common, ...cases[0].fields, estimatedCost }).checks,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            policyId: "er.equipment.cost",
            result: "fail",
            blocking: true,
          }),
        ]),
      );
    }
  });

  it("rejects too-short lead dates, reversed facilities dates, and premature completion claims", () => {
    expect(
      check("er-cards", { ...common, ...cases[1].fields, neededBy: "2035-01-02" }).checks,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ policyId: "er.date", result: "fail" })]),
    );
    expect(
      check("er-facilities", { ...common, ...cases[2].fields, endsOn: "2035-01-04" }).checks,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ policyId: "er.facilities.start", result: "fail" }),
      ]),
    );
    for (const draft of ["予約済み", "already ordered", "certificate issued"]) {
      expect(check("er-certificates", { ...common, ...cases[3].fields }, draft).checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            policyId: "er.no-completion-claims",
            result: "fail",
            blocking: true,
          }),
        ]),
      );
    }
  });

  it("reclassifies the same stored triage item and applies category checks and route", () => {
    const actor = { id: "device:requester01", kind: "person" as const };
    const item = createWorkItem(
      project,
      {
        queue: "er-triage",
        type: "request",
        title: "Equipment request",
        source: { fields: common },
      },
      actor,
      { now },
    );
    const moved = updateWorkItem(
      project,
      item.id,
      {
        queue: "er-equipment",
        source: { fields: { ...common, ...cases[0].fields } },
        status: "awaiting_review",
      },
      actor,
      item.revision,
      { now },
    );
    expect(moved.id).toBe(item.id);
    expect(moved.queue).toBe("er-equipment");
    expect(moved.route?.stages[0].approvers.roles).toEqual(["it-reviewer"]);
    expect(moved.checks.every((c) => c.result === "pass")).toBe(true);
  });

  it("loads an opt-in L1 routine with bounded read gathering and only intake/draft actions", () => {
    const routines = loadRoutines(project);
    expect(routines.error).toBeNull();
    expect(routines.routines).toHaveLength(1);
    expect(routines.routines[0]).toMatchObject({
      id: "employee-request-intake",
      enabled: false,
      level: "L1",
      queue: "er-triage",
      actions: ["workitem.intake", "mail.draft"],
      limits: { maxItemsPerRun: 10, maxActionsPerDay: 40 },
    });
    expect(routines.routines[0].gather.map((g) => g.tool)).toEqual([
      "m365_mail_list",
      "m365_mail_read",
    ]);
  });
});
