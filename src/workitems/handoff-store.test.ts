import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Actor, WorkItem } from "./types.js";
import { applyHandOffEvent, listHandOffs, openHandOff, readHandOff } from "./handoff-store.js";
import { insertWorkItem, mutateWorkItem, workItemDir } from "./store.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-handoff-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

const clerk: Actor = { id: "device:clerk0000001", kind: "person" };
const agent: Actor = { id: "agent:finance", kind: "agent" };
const now = new Date("2026-10-26T01:00:00Z");
const projectId = "pfinance001";
const freee = { product: "freee 会計", object: "deals", writable: true };
const action = "enter approved invoice as a deal";
let seq = 0;

function makeCase(status: WorkItem["status"] = "approved"): string {
  const id = `wcase${String(++seq).padStart(8, "0")}`;
  insertWorkItem(
    { id, projectId, status, revision: 3, createdBy: clerk.id, history: [] } as unknown as WorkItem,
    home,
  );
  return id;
}

function touchCase(id: string): void {
  mutateWorkItem(projectId, id, undefined, (cur) => cur, home);
}

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code;
  }
  return undefined;
}

describe("hand-off store", () => {
  it("opens a hand-off bound to the approved case revision and reads it back", () => {
    const caseId = makeCase();
    const rec = openHandOff(projectId, caseId, { action, destination: freee }, clerk, now, home);
    expect(rec.caseRevision).toBe(3);
    expect(rec.correlationId).toContain(caseId);
    expect(rec.requestedBy).toBe(clerk.id);
    expect(readHandOff(projectId, caseId, rec.id, home)).toEqual(rec);
    expect(listHandOffs(projectId, caseId, home).map((r) => r.id)).toEqual([rec.id]);
  });

  it("refuses a case that is not approved, an agent opener and a duplicate open hand-off", () => {
    const pending = makeCase("pending" as WorkItem["status"]);
    expect(
      code(() => openHandOff(projectId, pending, { action, destination: freee }, clerk, now, home)),
    ).toBe("handoff_case_not_approved");
    const caseId = makeCase();
    expect(
      code(() => openHandOff(projectId, caseId, { action, destination: freee }, agent, now, home)),
    ).toBe("handoff_person_required");
    openHandOff(projectId, caseId, { action, destination: freee }, clerk, now, home);
    expect(
      code(() => openHandOff(projectId, caseId, { action, destination: freee }, clerk, now, home)),
    ).toBe("handoff_duplicate");
  });

  it("persists transitions and refuses a record edited on disk", () => {
    const caseId = makeCase();
    const rec = openHandOff(projectId, caseId, { action, destination: freee }, clerk, now, home);
    const sha = "b".repeat(64);
    applyHandOffEvent(
      projectId,
      caseId,
      rec.id,
      { type: "submit", payloadVersion: 1, payloadSha256: sha },
      agent,
      now,
      home,
    );
    expect(readHandOff(projectId, caseId, rec.id, home)?.state).toBe("submitted");

    const file = path.join(workItemDir(projectId, caseId, home), "handoffs", `${rec.id}.json`);
    const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { state: string };
    onDisk.state = "closed";
    fs.writeFileSync(file, JSON.stringify(onDisk));
    expect(code(() => readHandOff(projectId, caseId, rec.id, home))).toBe("handoff_tampered");
    expect(
      code(() =>
        applyHandOffEvent(projectId, caseId, rec.id, { type: "timeout" }, agent, now, home),
      ),
    ).toBe("handoff_tampered");
  });

  it("settlement through the store applies strict SoD by default and warn only when asked", () => {
    const caseId = makeCase();
    const rec = openHandOff(projectId, caseId, { action, destination: freee }, clerk, now, home);
    const step = (event: Parameters<typeof applyHandOffEvent>[3], by: Actor = agent) =>
      applyHandOffEvent(projectId, caseId, rec.id, event, by, now, home);
    step({ type: "submit", payloadVersion: 1, payloadSha256: "c".repeat(64) });
    step({ type: "confirm", externalId: "deal_1", externalStatus: "unsettled" });
    step({ type: "reconcile", diffs: [] });
    const close = { type: "close", objective: "payment_settled", settlementRef: "bank:9" } as const;
    expect(code(() => step(close, clerk))).toBe("handoff_sod_conflict");
    expect(readHandOff(projectId, caseId, rec.id, home)?.state).toBe("reconciled");
    const warned = applyHandOffEvent(projectId, caseId, rec.id, close, clerk, now, home, {
      settlementSod: "warn",
    });
    expect(warned.history.at(-1)?.detail).toMatchObject({
      selfAttested: true,
      sodOverlap: ["requester", "approver"],
    });
  });

  it("a case written after approval reopens the hand-off, and re-approval binds the new revision", () => {
    const caseId = makeCase();
    const rec = openHandOff(projectId, caseId, { action, destination: freee }, clerk, now, home);
    touchCase(caseId);
    expect(
      code(() =>
        applyHandOffEvent(
          projectId,
          caseId,
          rec.id,
          { type: "submit", payloadVersion: 1, payloadSha256: "c".repeat(64) },
          agent,
          now,
          home,
        ),
      ),
    ).toBe("handoff_bad_transition");
    // The reopen is kept even though the submit was refused.
    expect(readHandOff(projectId, caseId, rec.id, home)?.state).toBe("reopened");

    const back = applyHandOffEvent(
      projectId,
      caseId,
      rec.id,
      { type: "reapprove", caseRevision: 999 },
      clerk,
      now,
      home,
    );
    expect(back.state).toBe("approved");
    expect(back.caseRevision).toBe(4);
  });

  it("re-approval waits until the corrected case is approved again", () => {
    const caseId = makeCase();
    const rec = openHandOff(projectId, caseId, { action, destination: freee }, clerk, now, home);
    mutateWorkItem(
      projectId,
      caseId,
      undefined,
      (cur) => ({ ...cur, status: "pending" as WorkItem["status"] }),
      home,
    );
    expect(
      code(() =>
        applyHandOffEvent(
          projectId,
          caseId,
          rec.id,
          { type: "reapprove", caseRevision: 4 },
          clerk,
          now,
          home,
        ),
      ),
    ).toBe("handoff_case_not_approved");
  });

  it("refuses a record whose destination or revision was edited on disk", () => {
    const caseId = makeCase();
    const rec = openHandOff(
      projectId,
      caseId,
      { action, destination: { ...freee, writable: false } },
      clerk,
      now,
      home,
    );
    const file = path.join(workItemDir(projectId, caseId, home), "handoffs", `${rec.id}.json`);
    const disk = JSON.parse(fs.readFileSync(file, "utf8"));
    disk.destination.writable = true;
    disk.caseRevision = 999;
    fs.writeFileSync(file, JSON.stringify(disk));
    expect(code(() => readHandOff(projectId, caseId, rec.id, home))).toBe("handoff_tampered");
    expect(
      code(() =>
        applyHandOffEvent(
          projectId,
          caseId,
          rec.id,
          { type: "submit", payloadVersion: 1, payloadSha256: "a".repeat(64) },
          agent,
          now,
          home,
        ),
      ),
    ).toBe("handoff_tampered");
  });

  it("refuses, rather than hides, a corrupt record, so a duplicate cannot be opened past it", () => {
    const corrupt: Array<(disk: Record<string, unknown>, raw: string) => string> = [
      (disk) => JSON.stringify({ ...disk, caseId: "wcaseother001" }),
      (disk) => JSON.stringify({ ...disk, id: "hzzzzzzzzzzzz" }),
      (_disk, raw) => raw.slice(0, raw.length / 2),
      () => "null",
    ];
    for (const edit of corrupt) {
      const caseId = makeCase();
      const rec = openHandOff(projectId, caseId, { action, destination: freee }, clerk, now, home);
      const file = path.join(workItemDir(projectId, caseId, home), "handoffs", `${rec.id}.json`);
      const raw = fs.readFileSync(file, "utf8");
      fs.writeFileSync(file, edit(JSON.parse(raw), raw));
      expect(code(() => readHandOff(projectId, caseId, rec.id, home))).toBe("handoff_tampered");
      expect(code(() => listHandOffs(projectId, caseId, home))).toBe("handoff_tampered");
      expect(
        code(() =>
          openHandOff(projectId, caseId, { action, destination: freee }, clerk, now, home),
        ),
      ).toBe("handoff_tampered");
    }
    expect(readHandOff(projectId, makeCase(), "hmissing00000", home)).toBeNull();
  });

  it("stores reconciliation values as JSON, so a Date survives the write/read round trip", () => {
    const caseId = makeCase();
    const rec = openHandOff(projectId, caseId, { action, destination: freee }, clerk, now, home);
    const events = [
      { type: "submit", payloadVersion: 1, payloadSha256: "c".repeat(64) },
      { type: "confirm", externalId: "deal-1", externalStatus: "registered" },
      {
        type: "reconcile",
        diffs: [
          {
            field: "issueDate",
            approved: new Date("2026-10-01T00:00:00Z"),
            submitted: new Date("2026-10-01T00:00:00Z"),
            destination: "2026-10-02",
          },
        ],
      },
    ] as const;
    let last = rec;
    for (const event of events) {
      last = applyHandOffEvent(projectId, caseId, rec.id, event, clerk, now, home);
    }
    const reread = readHandOff(projectId, caseId, rec.id, home);
    expect(reread?.state).toBe("mismatch");
    expect(reread?.diffs[0]?.approved).toBe("2026-10-01T00:00:00.000Z");
    expect(reread).toEqual(last);
  });
});
