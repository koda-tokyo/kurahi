// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import type { WorkQueueDef } from "../../../packages/client/src/workitems.js";
import {
  BUSINESS_DEPARTMENTS,
  SME_DEPARTMENT_GROUPS,
  departmentForQueue,
  getBusinessDepartment,
} from "./business-departments.js";

const queue = (id: string): WorkQueueDef => ({
  id,
  name: { en: "Queue", ja: "キュー" },
  types: ["request"],
  slaHours: null,
  defaultAgent: null,
});

describe("Business department catalogue", () => {
  it("provides fifteen unique functions with localized responsibilities and workflow guidance", () => {
    expect(BUSINESS_DEPARTMENTS).toHaveLength(15);
    expect(new Set(BUSINESS_DEPARTMENTS.map(({ id }) => id)).size).toBe(15);
    for (const department of BUSINESS_DEPARTMENTS) {
      expect(getBusinessDepartment(department.id)).toBe(department);
      for (const locale of ["en", "ja"] as const) {
        expect(department.name[locale].trim().length).toBeGreaterThan(0);
        expect(department.description[locale].trim().length).toBeGreaterThan(10);
        expect(department.workflows[locale].length).toBeGreaterThanOrEqual(3);
        expect(department.workflows[locale].every((workflow) => workflow.trim().length > 0)).toBe(
          true,
        );
      }
      expect(department.workflows.en).toHaveLength(department.workflows.ja.length);
    }
    expect(getBusinessDepartment("unknown")).toBeUndefined();
    expect(getBusinessDepartment("constructor")).toBeUndefined();
  });

  it("keeps every enterprise function in exactly one of six SME desks", () => {
    expect(SME_DEPARTMENT_GROUPS).toHaveLength(6);
    expect(new Set(SME_DEPARTMENT_GROUPS.map(({ id }) => id)).size).toBe(6);
    const grouped = SME_DEPARTMENT_GROUPS.flatMap(({ departments }) => departments);
    expect(grouped.toSorted()).toEqual(BUSINESS_DEPARTMENTS.map(({ id }) => id).toSorted());
    expect(SME_DEPARTMENT_GROUPS.find(({ id }) => id === "leadership")?.departments).toEqual([
      "secretariat",
      "admin",
      "planning",
    ]);
  });
});

describe("departmentForQueue", () => {
  it("uses the approved department field and rejects unknown metadata", () => {
    const known = { ...queue("custom"), department: "finance" as const };
    const unknown = { ...queue("custom"), department: "future" };
    expect(departmentForQueue(known)).toBe("finance");
    expect(departmentForQueue(unknown as unknown as WorkQueueDef)).toBeNull();
  });
  it.each([
    ["business-general-affairs", "ga-requests", "admin"],
    ["business-general-affairs", "ga-facilities", "admin"],
    ["business-finance-expense-invoice", "fin-expense", "finance"],
    ["business-finance-expense-invoice", "fin-invoice", "finance"],
    ["business-finance-expense-invoice", "fin-ringi", "finance"],
    ["business-hr-leave-overtime", "hr-leave", "hr"],
    ["business-hr-leave-overtime", "hr-overtime", "hr"],
    ["business-procurement", "proc-requests", "procurement"],
  ])("maps the shipped %s / %s pair", (template, id, department) => {
    expect(departmentForQueue(queue(id), template)).toBe(department);
  });

  it("prefers valid explicit metadata, including custom queues without templates", () => {
    for (const department of BUSINESS_DEPARTMENTS) {
      const explicit = { ...queue("custom"), department: department.id };
      expect(departmentForQueue(explicit)).toBe(department.id);
    }
    const explicit = { ...queue("fin-invoice"), department: "legal" as const };
    expect(departmentForQueue(explicit, "business-finance-expense-invoice")).toBe("legal");
  });

  it.each([
    "future-department",
    "",
    "Finance",
    "constructor",
    "__proto__",
    null,
    undefined,
    42,
    {},
  ])("does not fall back when explicit metadata is unrecognized: %s", (department) => {
    const explicit = { ...queue("fin-invoice"), department } as unknown as WorkQueueDef;
    expect(departmentForQueue(explicit, "business-finance-expense-invoice")).toBeNull();
  });

  it.each([
    [undefined, "fin-invoice"],
    ["business-procurement", "fin-invoice"],
    ["business-finance-expense-invoice", "fin-custom"],
    ["business-finance-expense-invoice", "fin-invoice-copy"],
    ["business-finance-expense-invoice-copy", "fin-invoice"],
    ["business-finance-expense-invoice", "toString"],
    ["constructor", "fin-invoice"],
    ["business-general-affairs", "custom"],
  ])("leaves unknown template / queue pairs unassigned: %s / %s", (template, id) => {
    expect(departmentForQueue(queue(id), template)).toBeNull();
  });

  it("does not infer departments from work item types or localized names", () => {
    const custom: WorkQueueDef = {
      ...queue("custom"),
      types: ["invoice", "expense", "purchase"],
      name: { en: "Finance", ja: "経理" },
    };
    expect(departmentForQueue(custom, "business-finance-expense-invoice")).toBeNull();
  });
});
