import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { flushAudit } from "../audit/audit-log.js";
import { loadRoutines } from "../autopilot/routines.js";
import { evaluatePolicy } from "../workitems/checks.js";
import { createWorkItem } from "../workitems/lifecycle.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { buildRoute } from "../workitems/routes.js";
import { loadProjectPack, seedStarterFiles, seedStarterPack } from "./pack.js";
import { createProject } from "./store.js";
import { loadTemplates, resolveTemplatesDir } from "./templates.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-people-pack-"));
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
  (t) => t.id === "business-people-operations",
)!;
const folder = path.join(root, "project");
fs.mkdirSync(folder);
const project = createProject(
  { name: "People operations example", folder },
  { createdBy: "device:requester01", template },
);
const policy = loadWorkQueuePolicy(project);
const now = new Date("2035-01-01T00:00:00Z");
const common = { employeeId: "EX-001", department: "operations" };
const attendance = { attendanceSource: "attendance/example.csv", attendanceAsOf: "2034-12-31" };
const cases = [
  {
    queue: "people-leave",
    type: "leave" as const,
    role: "people-manager",
    fields: {
      ...attendance,
      leaveType: "annual",
      startDate: "2035-01-04",
      endDate: "2035-01-04",
      requestedDays: 1,
      availableDays: 5,
    },
  },
  {
    queue: "people-overtime",
    type: "request" as const,
    role: "people-manager",
    fields: {
      ...attendance,
      date: "2035-01-02",
      hours: 2,
      reason: "Month-end review",
      monthToDateHours: 10,
      forecastMonthHours: 30,
    },
  },
  {
    queue: "people-onboarding",
    type: "case" as const,
    role: "people-reviewer",
    fields: {
      effectiveOn: "2035-01-10",
      caseOwner: "Example coordinator",
      checklistReference: "requests/onboarding.md",
    },
  },
  {
    queue: "people-offboarding",
    type: "case" as const,
    role: "people-reviewer",
    fields: {
      effectiveOn: "2034-12-30",
      caseOwner: "Example coordinator",
      checklistReference: "requests/offboarding.md",
    },
  },
];
function check(index: number, patch: Record<string, unknown> = {}, draft: string | null = null) {
  const c = cases[index];
  return evaluatePolicy(
    policy,
    {
      queue: c.queue,
      type: c.type,
      source: { fields: { ...common, ...c.fields, ...patch }, documents: [] },
    },
    draft === null ? null : { text: draft, version: 1 },
    now,
  );
}

describe("People operations Preview pack", () => {
  it("loads and seeds five forms without overwriting; all context fits the default budget", () => {
    expect(template).toBeDefined();
    expect(policy.error).toBeNull();
    expect(policy.access.fallback).toBe("none");
    expect(policy.separationOfDuties).toBe(true);
    expect(policy.queues.map((q) => q.slaHours)).toEqual([24, 8, 72, 24]);
    const packDir = path.join(resolveTemplatesDir({}), "packs", template.id);
    expect(seedStarterPack(project.id, packDir)).toBe(3);
    expect(loadProjectPack(project).files.every((f) => !f.truncated)).toBe(true);
    expect(seedStarterFiles(project, packDir, template.starterFiles)).toHaveLength(5);
    expect(fs.readFileSync(path.join(folder, "requests/lifecycle-evidence.md"), "utf8")).toContain(
      "Lifecycle task evidence",
    );
    const file = path.join(folder, template.starterFiles[0]);
    fs.writeFileSync(file, "Person completed this form");
    expect(seedStarterFiles(project, packDir, template.starterFiles)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("Person completed this form");
    // A review starter must not imply automatic HR actions.
    expect(loadRoutines(project).routines).toEqual([]);
  });

  it.each(cases)("creates a valid stored $queue item and isolates required fields", (c) => {
    const item = createWorkItem(
      project,
      {
        queue: c.queue,
        type: c.type,
        title: "Example request",
        source: { fields: { ...common, ...c.fields } },
      },
      { id: "device:requester01", kind: "person" },
      { now },
    );
    expect(item.checks.every((x) => x.result === "pass")).toBe(true);
    expect(item.checks.filter((x) => x.policyId.endsWith(".required"))).toHaveLength(1);
    expect(buildRoute(policy, item).stages[0].approvers.roles).toEqual([c.role]);
    for (const field of Object.keys(c.fields)) {
      const fields: Record<string, unknown> = { ...common, ...c.fields };
      delete fields[field];
      const result = evaluatePolicy(
        policy,
        { ...item, source: { fields, documents: [] } },
        null,
        now,
      );
      expect(result.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            policyId: c.queue + ".required",
            result: "fail",
            blocking: true,
          }),
        ]),
      );
    }
  });

  it("scopes managers by department and adds a distinct HR stage above forecast45", () => {
    for (const [forecastMonthHours, stages] of [
      [45, 1],
      [45.01, 2],
    ]) {
      const item = {
        queue: "people-overtime",
        type: "request" as const,
        source: { fields: { ...common, ...cases[1].fields, forecastMonthHours }, documents: [] },
        requiredApprovals: 1,
      };
      const route = buildRoute(policy, item);
      expect(route.stages).toHaveLength(stages);
      expect(route.stages[0].approvers.department).toBe("operations");
      if (stages === 2) {
        expect(route.stages[1].approvers.roles).toEqual(["people-reviewer"]);
      }
    }
    const route = buildRoute(policy, {
      queue: "people-leave",
      type: "leave",
      source: { fields: { ...common, ...cases[0].fields }, documents: [] },
      requiredApprovals: 1,
    });
    expect(route.stages.map((s) => s.id)).toEqual(["manager", "hr"]);
  });

  it("blocks invalid dates, future snapshots and normal approval above example limits", () => {
    for (const [index, patch, id] of [
      [0, { startDate: "2035-01-03" }, "people.leave.start"],
      [0, { endDate: "2035-01-03" }, "people.leave.start"],
      [0, { endDate: "invalid" }, "people.leave.end"],
      [1, { date: "2034-12-31" }, "people.overtime.date"],
      [1, { attendanceAsOf: "2035-01-02" }, "people.attendance.asof"],
      [1, { hours: 8.1 }, "people.overtime.daily"],
      [1, { monthToDateHours: 80.1 }, "people.overtime.actual"],
      [1, { forecastMonthHours: 80.1 }, "people.overtime.forecast"],
    ] as const) {
      expect(check(index, patch).checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ policyId: id, result: "fail", blocking: true }),
        ]),
      );
    }
    expect(
      check(1, { forecastMonthHours: 36 }).checks.find(
        (c) => c.policyId === "people.overtime.forecast",
      )?.result,
    ).toBe("pass");
    expect(
      check(1, { forecastMonthHours: 36.1 }).checks.find(
        (c) => c.policyId === "people.overtime.forecast",
      )?.result,
    ).toBe("warn");
  });

  it("refuses premature approval and downstream claims in drafts", () => {
    for (const draft of ["承認済み", "request approved", "payroll updated", "access revoked"]) {
      expect(check(3, {}, draft).checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            policyId: "people.no-completion",
            result: "fail",
            blocking: true,
          }),
        ]),
      );
    }
  });

  it("allows an honest pending-review notice", () => {
    expect(
      check(0, {}, "This request is not approved. Awaiting HR review.").checks.find(
        (c) => c.policyId === "people.no-completion",
      )?.result,
    ).toBe("pass");
  });

  it("ships manual task manifests with resolvable dependency keys and outcome evidence columns", () => {
    for (const slug of ["onboarding", "offboarding"]) {
      const text = fs.readFileSync(path.join(folder, "requests", slug + ".md"), "utf8");
      const manifest = text.split("## Manual task manifest")[1]?.split("\n## ")[0];
      expect(manifest).toBeDefined();
      const rows = manifest.split("\n").filter((l) => l.startsWith("| `" + slug + "."));
      expect(rows).toHaveLength(5);
      const keys = rows.map((r) => r.split("`")[1]);
      expect(new Set(keys).size).toBe(5);
      for (const row of rows) {
        const deps = [...row.split("|")[3].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        for (const dep of deps) {
          expect(keys).toContain(dep);
        }
      }
      expect(text).toContain("not executable configuration");
      expect(text).toContain("Evidence");
      expect(text).toContain("担当");
    }
  });
});
