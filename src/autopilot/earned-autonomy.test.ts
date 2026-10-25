import { Value } from "@sinclair/typebox/value";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AutonomyEvidence } from "./earned-autonomy.js";
import type { Routine } from "./types.js";
import {
  AutopilotAutonomyDeclineResultSchema,
  AutopilotAutonomyProposalsResultSchema,
} from "../gateway/protocol/schema/autopilot.js";
import { autonomyProposals, decideAutonomy, declineAutonomyProposal } from "./earned-autonomy.js";
import { readAutonomyDeclines } from "./store.js";

const mocks = vi.hoisted(() => ({
  corrections: new Map<string, { items: number; corrected: number }>(),
  routines: [] as Routine[],
  audit: vi.fn(async () => {}),
}));
vi.mock("./workitems-adapter.js", () => ({ autopilotCorrections: () => mocks.corrections }));
vi.mock("./routines.js", () => ({ loadRoutines: () => ({ routines: mocks.routines }) }));
vi.mock("../audit/audit-log.js", () => ({ auditSafe: mocks.audit }));

const evidence = (workItems: number, corrected: number, failedRuns = 0): AutonomyEvidence => ({
  from: "2026-09-25T00:00:00.000Z",
  to: "2026-10-25T00:00:00.000Z",
  runs: 10,
  failedRuns,
  workItems,
  corrected,
  correctionRate: workItems > 0 ? corrected / workItems : null,
  escalated: 0,
});

describe("decideAutonomy", () => {
  it("promotes one level on a low correction rate with enough evidence", () => {
    expect(decideAutonomy("inbox", "L1", evidence(40, 1))).toMatchObject({
      kind: "promote",
      proposed: "L2",
      reason: "low_correction_rate",
      needsStandingApproval: false,
    });
  });

  it("marks a promotion to L3 as needing a standing approval", () => {
    expect(decideAutonomy("inbox", "L2", evidence(40, 0))).toMatchObject({
      kind: "promote",
      proposed: "L3",
      needsStandingApproval: true,
    });
  });

  it("holds without enough work items, even with zero corrections", () => {
    expect(decideAutonomy("inbox", "L1", evidence(19, 0))).toMatchObject({
      kind: "hold",
      proposed: "L1",
      reason: "insufficient_evidence",
    });
    expect(decideAutonomy("inbox", "L1", evidence(0, 0)).reason).toBe("insufficient_evidence");
  });

  it("holds on failed runs, inside the band and at the top", () => {
    expect(decideAutonomy("inbox", "L1", evidence(40, 0, 1)).reason).toBe("failed_runs");
    expect(decideAutonomy("inbox", "L1", evidence(40, 4)).reason).toBe("within_band");
    expect(decideAutonomy("inbox", "L3", evidence(40, 0))).toMatchObject({
      kind: "hold",
      reason: "at_top",
    });
  });

  it("demotes one level on a high correction rate with less evidence than a promotion", () => {
    expect(decideAutonomy("inbox", "L3", evidence(10, 2))).toMatchObject({
      kind: "demote",
      proposed: "L2",
      reason: "high_correction_rate",
      needsStandingApproval: false,
    });
    expect(decideAutonomy("inbox", "L1", evidence(9, 9)).kind).toBe("hold");
    expect(decideAutonomy("inbox", "L0", evidence(40, 40))).toMatchObject({
      kind: "hold",
      proposed: "L0",
    });
  });
});

describe("autonomyProposals", () => {
  it("holds every routine of a project with no recorded evidence", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-earned-autonomy-"));
    try {
      const routines = [
        { id: "b", level: "L2" },
        { id: "a", level: "L1" },
      ] as Routine[];
      const now = new Date("2026-10-25T00:00:00.000Z");
      const out = autonomyProposals("pnone000001", routines, { home, now });
      expect(out.map((p) => [p.routineId, p.kind, p.reason])).toEqual([
        ["a", "hold", "insufficient_evidence"],
        ["b", "hold", "insufficient_evidence"],
      ]);
      expect(out[0].evidence).toMatchObject({
        from: "2026-09-25T00:00:00.000Z",
        to: now.toISOString(),
        runs: 0,
        correctionRate: null,
      });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("declineAutonomyProposal", () => {
  const project = {
    id: "pdecline001",
    folder: "/nonexistent",
    templateId: "blank",
    archived: false,
  };
  const person = { id: "device:person", kind: "person" as const };
  const now = new Date("2026-10-25T00:00:00.000Z");
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-autonomy-decline-"));
    mocks.routines = [{ id: "replies", level: "L2" } as Routine];
    // 12 items, 4 corrected: a demotion from L2 to L1.
    mocks.corrections = new Map([["replies", { items: 12, corrected: 4 }]]);
    mocks.audit.mockClear();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    mocks.corrections = new Map();
    mocks.routines = [];
  });

  const decline = (over: Record<string, unknown> = {}, actor = person, at = now) =>
    declineAutonomyProposal(
      project,
      { routineId: "replies", kind: "demote", proposed: "L1", reason: "seasonal backlog", ...over },
      actor as typeof person,
      { home, now: at },
    );

  it("records the decline, marks the same proposal and changes no level", () => {
    const out = decline();
    expect(out).toMatchObject({ kind: "demote", current: "L2", proposed: "L1" });
    expect(out.declined).toEqual({
      by: "device:person",
      at: now.toISOString(),
      reason: "seasonal backlog",
    });
    expect(readAutonomyDeclines(project.id, home)).toHaveLength(1);
    expect(mocks.routines[0].level).toBe("L2");
    const listed = autonomyProposals(project.id, mocks.routines, { home, now });
    expect(listed[0].declined?.by).toBe("device:person");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "autopilot.autonomy.decline", identity: "device:person" }),
    );
  });

  it("stops holding once the evidence changes the proposal or the window passes", () => {
    decline();
    mocks.corrections = new Map([["replies", { items: 30, corrected: 0 }]]);
    const promoted = autonomyProposals(project.id, mocks.routines, { home, now });
    expect(promoted[0]).toMatchObject({ kind: "promote", proposed: "L3", declined: null });
    mocks.corrections = new Map([["replies", { items: 12, corrected: 4 }]]);
    const later = new Date(now.getTime() + 31 * 86_400_000);
    expect(autonomyProposals(project.id, mocks.routines, { home, now: later })[0].declined).toBe(
      null,
    );
  });

  it("matches the transport schema both declined and not", () => {
    const declared = Object.keys(
      AutopilotAutonomyDeclineResultSchema.properties.proposal.properties,
    ).toSorted();
    const out = decline();
    expect(Object.keys(out).toSorted()).toEqual(declared);
    expect(Value.Check(AutopilotAutonomyDeclineResultSchema, { proposal: out })).toBe(true);
    mocks.corrections = new Map([["replies", { items: 30, corrected: 0 }]]);
    const proposals = autonomyProposals(project.id, mocks.routines, { home, now });
    expect(proposals[0].declined).toBeNull();
    expect(Object.keys(proposals[0]).toSorted()).toEqual(declared);
    const policy = {
      windowDays: 30,
      minItemsToPromote: 20,
      promoteAtOrBelow: 0.05,
      minItemsToDemote: 10,
      demoteAtOrAbove: 0.2,
    };
    expect(Value.Check(AutopilotAutonomyProposalsResultSchema, { policy, proposals })).toBe(true);
  });

  it("keeps one decision per routine", () => {
    decline();
    decline({ reason: "still seasonal" }, person, new Date(now.getTime() + 1000));
    const all = readAutonomyDeclines(project.id, home);
    expect(all).toHaveLength(1);
    expect(all[0].reason).toBe("still seasonal");
  });

  it.each([
    [{}, { id: "agent:x", kind: "agent" }, "not_a_person"],
    [{ reason: "  no " }, person, "reason_required"],
    [{ routineId: "missing" }, person, "routine_not_found"],
    [{ kind: "promote", proposed: "L3" }, person, "proposal_changed"],
    [{ proposed: "L0" }, person, "proposal_changed"],
  ])("refuses %o by %o (%s) and records nothing", (over, actor, code) => {
    expect(() => decline(over, actor as typeof person)).toThrow(
      expect.objectContaining({ code }) as Error,
    );
    expect(readAutonomyDeclines(project.id, home)).toEqual([]);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("has nothing to decline on a hold", () => {
    mocks.corrections = new Map();
    expect(() => decline()).toThrow(
      expect.objectContaining({ code: "nothing_to_decline" }) as Error,
    );
  });
});
