import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { flushAudit } from "../audit/audit-log.js";
import { loadRoutines } from "../autopilot/routines.js";
import { evaluatePolicy } from "../workitems/checks.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { buildRoute } from "../workitems/routes.js";
import { createProject } from "./store.js";
import { loadTemplates, resolveTemplatesDir } from "./templates.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-guardian-pack-"));
const previousHome = process.env.KOLO_HOME;
const previousState = process.env.KOLO_STATE_DIR;
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");
afterAll(async () => {
  await flushAudit();
  for (const [key, value] of [
    ["KOLO_HOME", previousHome],
    ["KOLO_STATE_DIR", previousState],
  ] as const) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(root, { recursive: true, force: true });
});
const template = loadTemplates(resolveTemplatesDir({})).find((t) => t.id === "core-guardian")!;
const folder = path.join(root, "guardian-project");
fs.mkdirSync(folder);
const project = createProject(
  { name: "Guardian example", folder },
  { createdBy: "device:security01", template },
);
const policy = loadWorkQueuePolicy(project);
const source = (fields: Record<string, unknown>) => ({ fields, documents: [] });
const item = (fields: Record<string, unknown>) => ({
  queue: "sec-incidents",
  type: "case" as const,
  source: source(fields),
  requiredApprovals: 1,
});
const base = {
  summary: "Backup older than 26 hours",
  note: "fact backup age 31h\nverdict ESCALATE",
};

describe("Kurahi Guardian pack", () => {
  it("loads the incident queue and both routines at L1", () => {
    expect(policy.error).toBeNull();
    expect(policy.queues.map((q) => [q.id, q.department])).toEqual([["sec-incidents", "it"]]);
    const set = loadRoutines(project);
    expect(set.error).toBeNull();
    expect(set.routines.map((r) => [r.id, r.edition, r.area, r.level])).toEqual([
      ["guardian-posture", "core", "security", "L1"],
      ["guardian-shares", "core", "security", "L1"],
    ]);
    expect(set.routines.every((r) => r.actions.join() === "workitem.intake")).toBe(true);
  });

  it("sends only high and urgent incidents to management", () => {
    for (const [priority, stages] of [
      ["low", ["security"]],
      ["normal", ["security"]],
      ["high", ["security", "management"]],
      ["urgent", ["security", "management"]],
    ] as const) {
      expect(buildRoute(policy, item({ ...base, priority })).stages.map((s) => s.id)).toEqual(
        stages,
      );
    }
  });

  it("requires evidence and refuses claims that a threat was handled", () => {
    const run = (fields: Record<string, unknown>) =>
      evaluatePolicy(policy, item(fields), null).checks.filter((c) => c.result === "fail");
    expect(run({ ...base, priority: "high" })).toEqual([]);
    expect(run({ summary: base.summary, priority: "high" }).map((c) => c.policyId)).toEqual([
      "sec.required",
    ]);
    expect(
      run({ ...base, summary: "Ransomware on share — malware removed" }).map((c) => c.policyId),
    ).toEqual(["sec.phrases"]);
  });
});
