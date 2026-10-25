import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Actor } from "./types.js";
import { flushAudit } from "../audit/audit-log.js";
import { createProject } from "../projects/store.js";
import { loadTemplates, resolveTemplatesDir } from "../projects/templates.js";
import { createWorkItem } from "./lifecycle.js";
import { parsePolicy } from "./policy.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-ringi-tpl-"));
const saved = { home: process.env.KOLO_HOME, state: process.env.KOLO_STATE_DIR };
process.env.KOLO_HOME = path.join(root, "state");
process.env.KOLO_STATE_DIR = path.join(root, "state");
const requester: Actor = { id: "device:requester01", kind: "person" };

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

describe("templates", () => {
  it("finance: 3-stage ringi example (manager → finance ≥ ¥100,000 → director ≥ ¥1,000,000)", () => {
    const templates = loadTemplates(resolveTemplatesDir({}));
    const folder = path.join(root, "fin-template");
    fs.mkdirSync(folder, { recursive: true });
    const fin = createProject(
      { name: "Finance", folder },
      {
        createdBy: requester.id,
        template: templates.find((t) => t.id === "business-finance-expense-invoice")!,
      },
    );
    const stagesFor = (amount: number) =>
      createWorkItem(
        fin,
        {
          queue: "fin-ringi",
          title: "spend",
          source: { fields: { amount, department: "sales", purpose: "x" } },
        },
        requester,
      ).route?.stages.map((s) => s.id);
    expect(stagesFor(99_999)).toEqual(["manager"]);
    expect(stagesFor(100_000)).toEqual(["manager", "finance"]);
    expect(stagesFor(1_000_000)).toEqual(["manager", "finance", "director"]);
    // Existing expense queue keeps the single-stage review with its second-approver threshold.
    const exp = createWorkItem(
      fin,
      { queue: "fin-expense", title: "taxi", source: { fields: { amount: 80_000 } } },
      requester,
    );
    expect(exp.route).toMatchObject({ kind: "single" });
    expect(exp.route?.stages[0].minApprovals).toBe(2);
    const proc = parsePolicy(
      fs.readFileSync(
        path.join(resolveTemplatesDir({}), "packs", "business-procurement", "workqueue.yaml"),
        "utf8",
      ),
    );
    expect(proc.rules.find((r) => r.id === "proc.quotes")).toMatchObject({
      kind: "attachment",
      min: 2,
    });
  });
});
