import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "../projects/types.js";
import { readPackPlans } from "./pack-plan-file.js";

const starter = path.resolve(
  import.meta.dirname,
  "../../templates/projects/packs/business-people-operations/starter/requests",
);

let root = "";
let folder = "";
const project = (writable: string[] = ["output"]) =>
  ({ folder, rules: { readOnly: ["requests"], writable } }) as unknown as Project;
const put = (name: string, from = name) => {
  fs.mkdirSync(path.join(folder, "requests"), { recursive: true });
  fs.copyFileSync(path.join(starter, from), path.join(folder, "requests", name));
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-pack-plan-file-"));
  folder = path.join(root, "proj");
  fs.mkdirSync(folder);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("readPackPlans", () => {
  it("offers the onboarding and offboarding plans a person keeps under requests/", () => {
    put("onboarding.md");
    put("offboarding.md");
    const plans = readPackPlans(project());
    expect(plans.map((p) => [p.file, p.problems])).toEqual([
      ["requests/onboarding.md", []],
      ["requests/offboarding.md", []],
    ]);
    expect(plans[0].plan?.steps.find((s) => s.key === "onboarding-access")?.dependsOn).toEqual([
      "onboarding-equipment",
      "onboarding-facilities",
    ]);
    expect(plans[0].sourceKeys["onboarding-hr-confirm"]).toBe("onboarding.hr-confirm");
  });

  it("offers nothing for a missing worksheet", () => {
    expect(readPackPlans(project())).toEqual([]);
    put("offboarding.md");
    expect(readPackPlans(project()).map((p) => p.file)).toEqual(["requests/offboarding.md"]);
  });

  it("refuses a worksheet in a folder the agent can write", () => {
    put("onboarding.md");
    const [plan] = readPackPlans(project(["output", "requests"]));
    expect(plan).toEqual({
      file: "requests/onboarding.md",
      plan: null,
      sourceKeys: {},
      problems: [{ code: "untrusted_file" }],
    });
  });

  it("refuses a symbolic link, even to a file inside the project", () => {
    fs.mkdirSync(path.join(folder, "output"));
    fs.copyFileSync(path.join(starter, "onboarding.md"), path.join(folder, "output", "o.md"));
    fs.mkdirSync(path.join(folder, "requests"));
    fs.symlinkSync(
      path.join(folder, "output", "o.md"),
      path.join(folder, "requests", "onboarding.md"),
    );
    expect(readPackPlans(project())[0].problems).toEqual([{ code: "unreadable_file" }]);
  });

  it("refuses a requests/ folder that is a link into a writable folder", () => {
    fs.mkdirSync(path.join(folder, "output"));
    fs.copyFileSync(
      path.join(starter, "onboarding.md"),
      path.join(folder, "output", "onboarding.md"),
    );
    fs.symlinkSync(path.join(folder, "output"), path.join(folder, "requests"));
    expect(readPackPlans(project())[0].problems).toEqual([{ code: "unreadable_file" }]);
  });

  it("refuses a hard-linked worksheet", () => {
    put("onboarding.md");
    fs.mkdirSync(path.join(folder, "output"));
    fs.linkSync(
      path.join(folder, "requests", "onboarding.md"),
      path.join(folder, "output", "x.md"),
    );
    expect(readPackPlans(project())[0].problems).toEqual([{ code: "unreadable_file" }]);
  });

  it("refuses a worksheet over 64 KB", () => {
    put("onboarding.md");
    fs.appendFileSync(path.join(folder, "requests", "onboarding.md"), "x".repeat(64 * 1024));
    expect(readPackPlans(project())[0].problems).toEqual([{ code: "file_too_large" }]);
  });

  it("reports the worksheet's own problems with no plan", () => {
    fs.mkdirSync(path.join(folder, "requests"));
    fs.writeFileSync(path.join(folder, "requests", "onboarding.md"), "# no tables\n");
    expect(readPackPlans(project())[0]).toMatchObject({
      plan: null,
      problems: [{ code: "no_manifest" }, { code: "no_department_mapping" }],
    });
  });
});
