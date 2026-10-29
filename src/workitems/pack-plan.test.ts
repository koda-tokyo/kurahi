import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { linkedPlanFromWorksheet } from "./pack-plan.js";

const requests = path.resolve(
  import.meta.dirname,
  "../../templates/projects/packs/business-people-operations/starter/requests",
);
const worksheet = (name: string) => fs.readFileSync(path.join(requests, name), "utf8");

const manifest = (rows: string[]) =>
  [
    "| Key | Task / 作業 | Depends on / 依存 | Status / 状態 |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
const mapping = (rows: string[]) =>
  ["| Task key | Department ID / 部署ID |", "| --- | --- |", ...rows].join("\n");
const sheet = (m: string[], d: string[]) => `${manifest(m)}\n\ntext\n\n${mapping(d)}\n`;

describe("linkedPlanFromWorksheet", () => {
  it("reads the onboarding worksheet as a plan with parallel equipment and facilities", () => {
    const out = linkedPlanFromWorksheet(worksheet("onboarding.md"));
    expect(out.problems).toEqual([]);
    expect(out.plan?.steps.map((s) => [s.key, s.department, s.dependsOn])).toEqual([
      ["onboarding-hr-confirm", "hr", []],
      ["onboarding-equipment", "procurement", ["onboarding-hr-confirm"]],
      ["onboarding-facilities", "admin", ["onboarding-hr-confirm"]],
      ["onboarding-access", "it", ["onboarding-equipment", "onboarding-facilities"]],
      ["onboarding-hr-close", "hr", ["onboarding-access"]],
    ]);
    expect(out.plan?.steps[1].title).toEqual({
      en: "IT/Procurement equipment",
      ja: "IT・購買の機器手配",
    });
    expect(out.sourceKeys["onboarding-hr-confirm"]).toBe("onboarding.hr-confirm");
  });

  it("reads the offboarding worksheet with the final review waiting for all three", () => {
    const out = linkedPlanFromWorksheet(worksheet("offboarding.md"));
    expect(out.problems).toEqual([]);
    const close = out.plan?.steps.find((s) => s.key === "offboarding-hr-close");
    expect(close?.dependsOn).toEqual([
      "offboarding-access",
      "offboarding-assets",
      "offboarding-records",
    ]);
    expect(out.plan?.steps).toHaveLength(5);
  });

  it("refuses a worksheet without both tables", () => {
    expect(linkedPlanFromWorksheet(worksheet("leave.md")).plan).toBeNull();
    expect(linkedPlanFromWorksheet(manifest(["| `a` | A | — | pending |"])).problems).toEqual([
      { code: "no_department_mapping" },
    ]);
  });

  it("refuses rather than drops a dependency it cannot read", () => {
    const out = linkedPlanFromWorksheet(
      sheet(
        ["| `a` | A | — | pending |", "| `b` | B | `a` and IT | pending |"],
        ["| `a` | `hr` |", "| `b` | `it` |"],
      ),
    );
    expect(out.plan).toBeNull();
    expect(out.problems).toEqual([{ code: "bad_dependency_cell", key: "b" }]);
  });

  it("refuses unmapped tasks, extra mappings, duplicates and unknown departments", () => {
    const out = linkedPlanFromWorksheet(
      sheet(
        ["| `a` | A | — | pending |", "| `b` | B | `a` | pending |", "| `a` | A2 | — | pending |"],
        ["| `a` | `hr` |", "| `a` | `it` |", "| `c` | `it` |", "| `x` | `nowhere` |"],
      ),
    );
    expect(out.plan).toBeNull();
    expect(out.problems).toEqual(
      expect.arrayContaining([
        { code: "duplicate_mapping", key: "a" },
        { code: "duplicate_task", key: "a" },
        { code: "unmapped_task", key: "b" },
        { code: "mapping_without_task", key: "c" },
        { code: "mapping_without_task", key: "x" },
      ]),
    );
    const bad = linkedPlanFromWorksheet(
      sheet(["| `a` | A | — | pending |"], ["| `a` | `nowhere` |"]),
    );
    expect(bad.problems).toEqual([{ code: "bad_department", key: "a", department: "nowhere" }]);
  });

  it("refuses a repeated structural column or table instead of reading only the first", () => {
    const twoDeps = [
      "| Key | Task | Depends on | Depends on |",
      "| --- | --- | --- | --- |",
      "| `a` | A | — | — |",
      "| `b` | B | — | `a` |",
    ].join("\n");
    const deps = linkedPlanFromWorksheet(
      `${twoDeps}\n\n${mapping(["| `a` | `hr` |", "| `b` | `it` |"])}\n`,
    );
    expect(deps.plan).toBeNull();
    expect(deps.problems).toEqual([
      { code: "duplicate_column", table: "manifest", column: "Depends on" },
    ]);
    const twoDepts = [
      "| Task key | Department ID | Department ID |",
      "| --- | --- | --- |",
      "| `a` | `hr` | `it` |",
    ].join("\n");
    const depts = linkedPlanFromWorksheet(
      `${manifest(["| `a` | A | — | pending |"])}\n\n${twoDepts}\n`,
    );
    expect(depts.problems).toEqual([
      { code: "duplicate_column", table: "mapping", column: "Department ID" },
    ]);
    const m = manifest(["| `a` | A | — | pending |"]);
    const d = mapping(["| `a` | `hr` |"]);
    const tables = linkedPlanFromWorksheet(`${m}\n\n${m}\n\n${d}\n\n${d}\n`);
    expect(tables.problems).toEqual([
      { code: "duplicate_table", table: "manifest" },
      { code: "duplicate_table", table: "mapping" },
    ]);
  });

  it("checks dependencies against the worksheet keys before normalizing them", () => {
    const out = linkedPlanFromWorksheet(
      sheet(
        ["| `a.b` | A | — | pending |", "| `c` | C | `a-b` | pending |"],
        ["| `a.b` | `hr` |", "| `c` | `it` |"],
      ),
    );
    expect(out.plan).toBeNull();
    expect(out.problems).toEqual([{ code: "unknown_dependency", key: "c", dependsOn: "a-b" }]);
    const dotted = linkedPlanFromWorksheet(
      sheet(
        ["| `a.b` | A | — | pending |", "| `c` | C | `a.b` | pending |"],
        ["| `a.b` | `hr` |", "| `c` | `it` |"],
      ),
    );
    expect(dotted.problems).toEqual([]);
    expect(dotted.plan?.steps[1].dependsOn).toEqual(["a-b"]);
  });

  it("refuses bad rows, keys and titles", () => {
    const out = linkedPlanFromWorksheet(
      sheet(
        ["| a | A | — | pending |", "| `b` |  | — | pending |", "| `c` | C | — |"],
        ["| `b` | `hr` |", "| `c` | `hr` |"],
      ),
    );
    expect(out.problems).toEqual(
      expect.arrayContaining([
        { code: "bad_task_key", line: 3 },
        { code: "bad_title", key: "b" },
        { code: "bad_row", table: "manifest", line: 5 },
      ]),
    );
    const long = linkedPlanFromWorksheet(
      sheet([`| \`a\` | ${"x".repeat(201)} | — | pending |`], ["| `a` | `hr` |"]),
    );
    expect(long.problems).toEqual([{ code: "bad_title", key: "a" }]);
  });

  it("passes the plan through the linked-case validator", () => {
    const cycle = linkedPlanFromWorksheet(
      sheet(
        ["| `a` | A | `b` | pending |", "| `b` | B | `a` | pending |"],
        ["| `a` | `hr` |", "| `b` | `it` |"],
      ),
    );
    expect(cycle.plan).toBeNull();
    expect(cycle.problems.map((p) => p.code)).toContain("cycle");
    const unknown = linkedPlanFromWorksheet(
      sheet(["| `a` | A | `z` | pending |"], ["| `a` | `hr` |"]),
    );
    expect(unknown.problems).toEqual([{ code: "unknown_dependency", key: "a", dependsOn: "z" }]);
    const clash = linkedPlanFromWorksheet(
      sheet(
        ["| `a.b` | A | — | pending |", "| `a-b` | B | — | pending |"],
        ["| `a.b` | `hr` |", "| `a-b` | `it` |"],
      ),
    );
    expect(clash.problems).toEqual([{ code: "duplicate_key", key: "a-b" }]);
  });
});
