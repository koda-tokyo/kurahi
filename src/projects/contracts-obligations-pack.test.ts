import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { flushAudit } from "../audit/audit-log.js";
import { evaluatePolicy } from "../workitems/checks.js";
import { loadWorkQueuePolicy } from "../workitems/policy.js";
import { buildRoute } from "../workitems/routes.js";
import { loadProjectPack, seedStarterFiles, seedStarterPack } from "./pack.js";
import { createProject } from "./store.js";
import { loadTemplates, resolveTemplatesDir } from "./templates.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-contracts-pack-"));
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
const template = loadTemplates(resolveTemplatesDir({})).find(
  (entry) => entry.id === "business-contracts-obligations",
)!;
const folder = path.join(root, "contracts-project");
fs.mkdirSync(folder);
const project = createProject(
  { name: "Contracts example", folder },
  { createdBy: "device:requester01", template },
);
const policy = loadWorkQueuePolicy(project);
const now = new Date("2035-01-01T00:00:00Z");
const common = { contractId: "EX-001", owner: "Example Owner", description: "Review source" };
const cases = [
  {
    queue: "co-register",
    role: "contract-coordinator",
    fields: {
      counterparty: "Example Company",
      documentReference: "contracts/source-v1.pdf",
      documentVersion: "revision-001",
      startsOn: "2034-01-01",
      endsOn: "2035-12-31",
    },
  },
  {
    queue: "co-review",
    role: "legal-reviewer",
    fields: {
      documentReference: "contracts/source-v1.pdf",
      documentVersion: "revision-001",
      reviewQuestion: "Check notice terms",
      neededBy: "2035-01-02",
    },
  },
  {
    queue: "co-renewals",
    role: "contract-reviewer",
    fields: {
      renewalOn: "2035-12-31",
      noticeBy: "2035-11-30",
      noticeMethod: "Written notice per clause 4",
    },
  },
  {
    queue: "co-obligations",
    role: "obligation-reviewer",
    fields: {
      obligation: "Supply report",
      dueOn: "2035-01-31",
      evidenceRequired: "Accepted report reference",
    },
  },
  {
    queue: "co-signature",
    role: "signature-coordinator",
    fields: {
      approvedVersion: "contracts/approved-v2.pdf",
      authorizedSigner: "Example Signer",
      handoffInstructions: "Verify approvals and authority before signing externally",
    },
  },
];
function check(queue: string, fields: Record<string, unknown>) {
  return evaluatePolicy(
    policy,
    { queue, type: "request", source: { fields, documents: [] } },
    null,
    now,
  ).checks;
}

describe("Contracts and obligations starter pack", () => {
  it("hydrates the template, policy, bilingual forms and context without scheduled automation", () => {
    expect(template).toBeDefined();
    expect(policy.error).toBeNull();
    expect(policy.access.fallback).toBe("none");
    expect(policy.separationOfDuties).toBe(true);
    expect(policy.queues.map((q) => q.id)).toEqual(cases.map((entry) => entry.queue));
    expect(policy.queues.every((q) => q.name.ja && q.name.en && q.slaHours)).toBe(true);
    const packDir = path.join(resolveTemplatesDir({}), "packs", template.id);
    expect(fs.existsSync(path.join(packDir, "autopilot.yaml"))).toBe(false);
    expect(seedStarterPack(project.id, packDir)).toBe(3);
    const pack = loadProjectPack(project);
    expect(pack.files).toHaveLength(3);
    expect(pack.files.every((file) => !file.truncated)).toBe(true);
    expect(pack.text).toContain("do not calculate notice periods");
    expect(pack.text).toContain("route approval never proves signature");
    expect(seedStarterFiles(project, packDir, template.starterFiles)).toHaveLength(5);
    for (const file of template.starterFiles) {
      const content = fs.readFileSync(path.join(folder, file), "utf8");
      expect(content).toContain("source.fields");
      expect(content).toContain("記入");
      expect(content).toContain("`owner`");
    }
    const form = path.join(folder, template.starterFiles[0]);
    fs.writeFileSync(form, "Human-maintained contract record");
    expect(seedStarterFiles(project, packDir, template.starterFiles)).toEqual([]);
    expect(fs.readFileSync(form, "utf8")).toBe("Human-maintained contract record");
  });

  it.each(cases)(
    "validates required fields and resolves the named role for $queue",
    ({ queue, role, fields }) => {
      const source = { fields: { ...common, ...fields }, documents: [] };
      expect(check(queue, source.fields).every((result) => result.result === "pass")).toBe(true);
      expect(
        buildRoute(policy, { queue, type: "request", source, requiredApprovals: 1 }).stages[0]
          .approvers.roles,
      ).toEqual([role]);
      for (const field of Object.keys(source.fields)) {
        const missing: Record<string, unknown> = { ...source.fields };
        delete missing[field];
        expect(check(queue, missing)).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              policyId: field in common ? "co.common" : `${queue}.required`,
              result: "fail",
              blocking: true,
            }),
          ]),
        );
      }
    },
  );

  it.each(["co-register", "co-review"])(
    "rejects blank source versions in %s even when the source reference is present",
    (queue) => {
      const entry = cases.find((candidate) => candidate.queue === queue)!;
      for (const documentVersion of ["", "   ", null]) {
        expect(check(queue, { ...common, ...entry.fields, documentVersion })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              policyId: `${queue}.required`,
              result: "fail",
              blocking: true,
            }),
          ]),
        );
      }
    },
  );

  it.each([
    { queue: "co-register", field: "startsOn", value: "2036-01-01", policyId: "co.startson" },
    { queue: "co-register", field: "endsOn", value: "unknown", policyId: "co.endson" },
    { queue: "co-review", field: "neededBy", value: "2034-12-31", policyId: "co.neededby" },
    { queue: "co-renewals", field: "noticeBy", value: "2036-01-01", policyId: "co.noticeby" },
    { queue: "co-renewals", field: "noticeBy", value: "2034-12-31", policyId: "co.noticeby" },
    { queue: "co-renewals", field: "renewalOn", value: "not a date", policyId: "co.renewalon" },
    { queue: "co-renewals", field: "renewalOn", value: "2034-12-31", policyId: "co.renewalon" },
    { queue: "co-obligations", field: "dueOn", value: "2034-12-31", policyId: "co.dueon" },
    { queue: "co-obligations", field: "dueOn", value: "unknown", policyId: "co.dueon" },
  ])("rejects $field=$value in $queue at check time", ({ queue, field, value, policyId }) => {
    const entry = cases.find((candidate) => candidate.queue === queue)!;
    expect(check(queue, { ...common, ...entry.fields, [field]: value })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ policyId, result: "fail", blocking: true }),
      ]),
    );
  });

  it("allows a fully expired contract in the register without changing its historical dates", () => {
    expect(
      check("co-register", {
        ...common,
        ...cases[0].fields,
        startsOn: "2033-01-01",
        endsOn: "2034-12-31",
      }).every((result) => result.result === "pass"),
    ).toBe(true);
  });

  it("allows same-day notice/renewal boundaries and keeps date rules scoped to their queues", () => {
    expect(
      check("co-renewals", {
        ...common,
        ...cases[2].fields,
        renewalOn: "2035-01-01",
        noticeBy: "2035-01-01",
      }).every((result) => result.result === "pass"),
    ).toBe(true);
    expect(
      check("co-signature", { ...common, ...cases[4].fields, noticeBy: "invalid" }).every(
        (result) => result.result === "pass",
      ),
    ).toBe(true);
    expect(policy.rules.filter((rule) => rule.kind === "date")).toHaveLength(6);
  });
});
