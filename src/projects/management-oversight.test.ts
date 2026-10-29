import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { flushAudit } from "../audit/audit-log.js";
import { loadRoutines } from "../autopilot/routines.js";
import { loadProjectPack, seedStarterFiles, seedStarterPack } from "./pack.js";
import { createProject } from "./store.js";
import { loadTemplates, resolveTemplatesDir } from "./templates.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-management-pack-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");
afterAll(async () => {
  await flushAudit();
  if (saved.home === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = saved.home;
  }
  if (saved.state === undefined) {
    delete process.env.KOLO_STATE_DIR;
  } else {
    process.env.KOLO_STATE_DIR = saved.state;
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const template = loadTemplates(resolveTemplatesDir({})).find(
  (t) => t.id === "business-management-oversight",
)!;
const packDir = path.join(resolveTemplatesDir({}), "packs", template.id);
const folder = path.join(root, "report");
fs.mkdirSync(folder);
const project = createProject(
  { name: "Management report example", folder },
  { createdBy: "device:reporter01", template },
);

describe("Management oversight Preview starter", () => {
  it("loads all reporting instructions without losing definitions to the context budget", () => {
    expect(seedStarterPack(project.id, packDir)).toBe(3);
    const pack = loadProjectPack(project);
    expect(pack.files).toHaveLength(3);
    expect(pack.text.length).toBeLessThanOrEqual(6000);
    expect(pack.files.every((f) => !f.truncated)).toBe(true);
    expect(template.rules.readOnly).toEqual(["sources", "reports"]);
    expect(template.rules.writable).toEqual(["output"]);
    expect(template.rules.artifactApprovalRequired).toBe(true);
  });

  it("seeds bilingual reports and preserves a person's completed worksheet on reseeding", () => {
    expect(template.starterFiles).toContain("reports/review-decisions.md");
    expect(seedStarterFiles(project, packDir, template.starterFiles)).toHaveLength(4);
    for (const name of template.starterFiles) {
      const content = fs.readFileSync(path.join(folder, name), "utf8");
      expect(content).toMatch(/[\u3040-\u30ff\u4e00-\u9fff]/);
      expect(content).toContain("reference");
    }
    const file = path.join(folder, "reports/review-decisions.md");
    fs.writeFileSync(file, "Reviewer recorded decisions and follow-up");
    expect(seedStarterFiles(project, packDir, template.starterFiles)).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe("Reviewer recorded decisions and follow-up");
  });

  it("installs no automated collection or replacement source queue policy", () => {
    expect(loadRoutines(project).routines).toEqual([]);
    expect(fs.existsSync(path.join(packDir, "autopilot.yaml"))).toBe(false);
    expect(fs.existsSync(path.join(packDir, "workqueue.yaml"))).toBe(false);
  });
});
