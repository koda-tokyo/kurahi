import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { flushAudit } from "../audit/audit-log.js";
import { LEGACY_QUEUE_DEPARTMENTS } from "../projects/department-chat.js";
import { loadProjectPack, PACK_BUDGET_CHARS, seedStarterPack } from "../projects/pack.js";
import { createProject } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { createWorkItem } from "./lifecycle.js";
import { loadWorkQueuePolicy, parsePolicy } from "./policy.js";
import { listWorkItems } from "./store.js";
import { DEPARTMENT_IDS } from "./types.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-departments-"));
const previousHome = process.env.KOLO_HOME;
const previousState = process.env.KOLO_STATE_DIR;
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");
afterAll(async () => {
  await flushAudit();
  if (previousHome === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = previousHome;
  }
  if (previousState === undefined) {
    delete process.env.KOLO_STATE_DIR;
  } else {
    process.env.KOLO_STATE_DIR = previousState;
  }
  fs.rmSync(root, { recursive: true, force: true });
});
describe("company operations project template", () => {
  it("ships 15 bilingual queues and supports real stored requests in every department", () => {
    const directory = resolveTemplatesDir({});
    const template = loadTemplates(directory).find((t) => t.id === "business-company-operations")!;
    expect(template).toBeDefined();
    expect(template.name.en && template.name.ja).toBeTruthy();
    expect(template.starterPrompts.every((p) => p.en && p.ja)).toBe(true);
    const folder = path.join(root, "company");
    fs.mkdirSync(folder);
    const project = createProject(
      { name: "Company operations", folder },
      { createdBy: "device:requester01", template },
    );
    const policy = loadWorkQueuePolicy(project);
    expect(policy.error).toBeNull();
    expect(policy.queues.map((q) => q.department)).toEqual([...DEPARTMENT_IDS]);
    expect(new Set(policy.queues.map((q) => q.id)).size).toBe(15);
    expect(policy.access.fallback).toBe("none");
    expect(policy.separationOfDuties).toBe(true);
    const packDir = path.join(directory, "packs", template.id);
    expect(seedStarterPack(project.id, packDir)).toBeGreaterThan(1);
    const pack = loadProjectPack(project);
    expect(pack.totalChars).toBeLessThanOrEqual(PACK_BUDGET_CHARS);
    for (const queue of policy.queues) {
      expect(queue.name.en && queue.name.ja).toBeTruthy();
      expect(queue.defaultAgent).toBe("main");
      expect(queue.types).toEqual(["request", "case", "document"]);
      const item = createWorkItem(
        project,
        {
          queue: queue.id,
          type: "request",
          title: `${queue.department} request`,
          source: { fields: { requester: "Employee", description: "Review supplied request" } },
        },
        { id: "device:requester01", kind: "person" },
      );
      expect(item.queue).toBe(queue.id);
      expect(
        item.checks.find((check) => check.policyId === "company.request-details")?.result,
      ).toBe("pass");
      expect(listWorkItems(project.id, { queue: queue.id }).items.map((x) => x.id)).toEqual([
        item.id,
      ]);
    }
  });
  it("preserves the merged general affairs pack department mapping", () => {
    const policy = parsePolicy(
      fs.readFileSync(
        path.join(resolveTemplatesDir({}), "packs", "business-general-affairs", "workqueue.yaml"),
        "utf8",
      ),
    );
    expect(policy.queues.find((q) => q.id === "ga-facilities")?.department).toBe("admin");
    expect(policy.queues.find((q) => q.id === "ga-requests")?.department).toBe("admin");
  });
  it("keeps the legacy chat department fallback identical to the shipped packs", () => {
    for (const [templateId, mapping] of Object.entries(LEGACY_QUEUE_DEPARTMENTS)) {
      const policy = parsePolicy(
        fs.readFileSync(
          path.join(resolveTemplatesDir({}), "packs", templateId, "workqueue.yaml"),
          "utf8",
        ),
      );
      const shipped = Object.fromEntries(policy.queues.map((q) => [q.id, q.department]));
      expect(shipped, templateId).toEqual(mapping);
    }
  });
});
