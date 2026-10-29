import { describe, expect, it } from "vitest";
import type { HandOffRecord } from "./handoff.js";
import type { Actor } from "./types.js";
import {
  CLOSURE_TEXT,
  INVOICE_RECONCILE_FIELDS,
  SELF_ATTESTED_SETTLEMENT_TEXT,
  approveHandOff,
  compareHandOff,
  invalidateOnCaseChange,
  transitionHandOff as t,
  verifyHandOffHistory,
} from "./handoff.js";

const clerk: Actor = { id: "device:clerk0000001", kind: "person" };
const agent: Actor = { id: "agent:finance", kind: "agent" };
const now = new Date("2026-10-26T01:00:00Z");
const sha = "a".repeat(64);

function fresh(writable = true): HandOffRecord {
  return approveHandOff(
    {
      id: "ho_1",
      caseId: "wi_inv_1",
      caseRevision: 3,
      action: "enter approved invoice as a deal",
      destination: { product: "freee 会計", object: "deals", writable },
      correlationId: "kurahi-wi_inv_1-r3",
    },
    clerk,
    now,
  );
}

const invoice = {
  supplierId: "S-0042",
  invoiceNumber: "INV-2026-118",
  grossAmount: 110000,
  netAmount: 100000,
};

function refused(fn: () => unknown, code: string) {
  expect(fn).toThrow(expect.objectContaining({ code }));
}

describe("hand-off lifecycle: the five contract paths", () => {
  it("normal transfer: submitted → confirmed → reconciled → closed, payment not verified", () => {
    let r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "confirm", externalId: "deal_9001", externalStatus: "unsettled" }, agent, now);
    const diffs = compareHandOff(["supplierId", "invoiceNumber"], invoice, invoice, invoice);
    r = t(r, { type: "reconcile", diffs }, agent, now);
    expect(r.state).toBe("reconciled");
    r = t(r, { type: "close", objective: "handoff_completed" }, clerk, now);
    expect(r.state).toBe("closed");
    expect(r.history.at(-1)?.detail.text).toEqual(CLOSURE_TEXT.handoff_completed);
    expect(CLOSURE_TEXT.handoff_completed.ja).toBe("受け渡し完了・支払いは未確認");
    expect(verifyHandOffHistory(r)).toBe(true);
  });

  it("timeout after the destination created the record: read-back finds it, no second attempt", () => {
    let r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "timeout" }, agent, now);
    expect(r.state).toBe("unknown");
    refused(
      () => t(r, { type: "retry", reason: "try again" }, clerk, now),
      "handoff_lookup_required",
    );
    refused(
      () => t(r, { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now),
      "handoff_bad_transition",
    );
    r = t(
      r,
      { type: "lookup", found: { externalId: "deal_9001", externalStatus: "unsettled" } },
      agent,
      now,
    );
    expect(r.state).toBe("confirmed");
    expect(r.attempts).toHaveLength(1);
    expect(r.externalId).toBe("deal_9001");
  });

  it("timeout with nothing created: lookup not_found, a person retries, one more attempt", () => {
    let r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "timeout" }, agent, now);
    r = t(r, { type: "lookup", found: null }, agent, now);
    refused(
      () => t(r, { type: "retry", reason: "lookup empty" }, agent, now),
      "handoff_person_required",
    );
    r = t(r, { type: "retry", reason: "lookup empty" }, clerk, now);
    r = t(r, { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    expect(r.state).toBe("submitted");
    expect(r.attempts).toHaveLength(2);
    expect(r.history.at(-1)?.detail.correlationId).toBe("kurahi-wi_inv_1-r3");
  });

  it("rejection: refused by the destination, corrected and re-approved on a newer revision", () => {
    let r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "reject", reason: "account 5xx unknown", notCreated: true }, agent, now);
    expect(r.state).toBe("rejected");
    refused(
      () => t(r, { type: "close", objective: "handoff_completed" }, clerk, now),
      "handoff_bad_transition",
    );
    r = t(r, { type: "reopen", reason: "fix the account code" }, clerk, now);
    refused(
      () => t(r, { type: "reapprove", caseRevision: 3 }, clerk, now),
      "handoff_stale_revision",
    );
    r = t(r, { type: "reapprove", caseRevision: 4 }, clerk, now);
    expect(r).toMatchObject({ state: "approved", caseRevision: 4 });
  });

  it("mismatch, then correction and re-reconciliation", () => {
    let r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "confirm", externalId: "deal_9001", externalStatus: "unsettled" }, agent, now);
    const readBack = { ...invoice, grossAmount: 100000, invoiceNumber: "INV-2026-118 " };
    const diffs = compareHandOff(INVOICE_RECONCILE_FIELDS, invoice, invoice, readBack);
    expect(diffs.map((d) => d.field)).toEqual(["invoiceNumber", "grossAmount"]);
    r = t(r, { type: "reconcile", diffs }, agent, now);
    expect(r.state).toBe("mismatch");
    refused(
      () =>
        t(r, { type: "resolve", field: "grossAmount", kind: "accepted", reason: "ok" }, agent, now),
      "handoff_person_required",
    );
    r = t(
      r,
      { type: "resolve", field: "invoiceNumber", kind: "accepted", reason: "trailing space only" },
      clerk,
      now,
    );
    expect(r.state).toBe("mismatch");
    // The amount is wrong in the destination: correct the case, re-approve, update the same record.
    r = t(r, { type: "reopen", reason: "gross amount differs" }, clerk, now);
    r = t(r, { type: "reapprove", caseRevision: 4 }, clerk, now);
    r = t(r, { type: "submit", payloadVersion: 2, payloadSha256: "b".repeat(64) }, agent, now);
    r = t(r, { type: "confirm", externalId: "deal_9001", externalStatus: "unsettled" }, agent, now);
    r = t(
      r,
      {
        type: "reconcile",
        diffs: compareHandOff(INVOICE_RECONCILE_FIELDS, invoice, invoice, invoice),
      },
      agent,
      now,
    );
    expect(r).toMatchObject({ state: "reconciled", externalId: "deal_9001" });
    expect(verifyHandOffHistory(r)).toBe(true);
  });
});

describe("hand-off evidence rules", () => {
  it("read-only destination: awaiting external entry, only a person confirms with the external id", () => {
    refused(
      () => t(fresh(false), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now),
      "handoff_not_writable",
    );
    let r = t(fresh(false), { type: "await_entry" }, agent, now);
    expect(r.state).toBe("awaiting_external_entry");
    refused(
      () =>
        t(r, { type: "confirm", externalId: "deal_1", externalStatus: "unsettled" }, agent, now),
      "handoff_person_required",
    );
    refused(
      () => t(r, { type: "confirm", externalId: " ", externalStatus: "x" }, clerk, now),
      "handoff_evidence_missing",
    );
    r = t(r, { type: "confirm", externalId: "deal_1", externalStatus: "unsettled" }, clerk, now);
    expect(r.state).toBe("confirmed");
  });

  it("approval needs a person, a revision and an exact destination", () => {
    const base = {
      id: "ho_2",
      caseId: "wi_2",
      caseRevision: 1,
      action: "enter",
      destination: {
        product: "Money Forward Accounts Payable",
        object: "invoices",
        writable: true,
      },
      correlationId: "c2",
    };
    refused(() => approveHandOff(base, agent, now), "handoff_person_required");
    refused(
      () => approveHandOff({ ...base, caseRevision: 0 }, clerk, now),
      "handoff_evidence_missing",
    );
    refused(
      () =>
        approveHandOff({ ...base, destination: { ...base.destination, product: "" } }, clerk, now),
      "handoff_evidence_missing",
    );
  });

  it("submission needs a payload version and SHA-256", () => {
    refused(
      () => t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: "abc" }, agent, now),
      "handoff_evidence_missing",
    );
    refused(
      () => t(fresh(), { type: "submit", payloadVersion: 0, payloadSha256: sha }, agent, now),
      "handoff_evidence_missing",
    );
  });

  it("a partial record cannot be blindly resubmitted; a person completes or reopens it", () => {
    let r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "partial", externalId: "deal_9", missing: ["attachments"] }, agent, now);
    refused(() => t(r, { type: "retry", reason: "again" }, clerk, now), "handoff_bad_transition");
    refused(
      () =>
        t(r, { type: "confirm", externalId: "deal_9", externalStatus: "unsettled" }, agent, now),
      "handoff_person_required",
    );
    expect(
      t(r, { type: "confirm", externalId: "deal_9", externalStatus: "unsettled" }, clerk, now)
        .state,
    ).toBe("confirmed");
  });

  it("payment settled needs settlement evidence; hand-off completion does not claim payment", () => {
    const requester = "device:requester001";
    const treasurer: Actor = { id: "device:treasurer0001", kind: "person" };
    let r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "confirm", externalId: "d", externalStatus: "unsettled" }, agent, now);
    r = t(r, { type: "reconcile", diffs: [] }, agent, now);
    refused(
      () => t(r, { type: "close", objective: "payment_settled" }, treasurer, now),
      "handoff_evidence_missing",
    );
    const c = t(
      r,
      { type: "close", objective: "payment_settled", settlementRef: "bank:stmt-2026-10#14" },
      treasurer,
      now,
      { caseRequestedBy: requester },
    );
    expect(c.objective).toBe("payment_settled");
    expect(c.history.at(-1)?.detail).toMatchObject({
      attestedBy: treasurer.id,
      settlementSod: "strict",
      sodOverlap: [],
      selfAttested: false,
    });
    expect(c.history.at(-1)?.detail.text).toEqual(CLOSURE_TEXT.payment_settled);
    expect(CLOSURE_TEXT.payment_settled.en).not.toMatch(/verified/i);
    expect(CLOSURE_TEXT.payment_settled.ja).not.toContain("確認済み");
  });

  it("strict SoD refuses an attester who approved or resolved; an independent person may attest", () => {
    const treasurer: Actor = { id: "device:treasurer0001", kind: "person" };
    let r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "confirm", externalId: "d", externalStatus: "unsettled" }, agent, now);
    r = t(
      r,
      { type: "reconcile", diffs: compareHandOff(["netAmount"], invoice, invoice, {}) },
      agent,
      now,
    );
    r = t(
      r,
      { type: "resolve", field: "netAmount", kind: "accepted", reason: "rounding" },
      treasurer,
      now,
    );
    const close = { type: "close", objective: "payment_settled", settlementRef: "bank:1" } as const;
    const ctx = { caseRequestedBy: "device:requester001" };
    expect(() => t(r, close, treasurer, now, ctx)).toThrow(
      expect.objectContaining({ code: "handoff_sod_conflict", details: { roles: ["resolver"] } }),
    );
    expect(() => t(r, close, clerk, now, ctx)).toThrow(
      expect.objectContaining({ code: "handoff_sod_conflict", details: { roles: ["approver"] } }),
    );
    // Strict is the default: an unknown mode is not read as warn.
    refused(
      () => t(r, close, clerk, now, { ...ctx, settlementSod: "lax" as never }),
      "handoff_sod_conflict",
    );
    const other: Actor = { id: "device:auditor00001", kind: "person" };
    const c = t(r, close, other, now, ctx);
    expect(c.history.at(-1)?.detail.sodOverlap).toEqual([]);
    expect(verifyHandOffHistory(c)).toBe(true);
  });

  it("strict SoD still refuses a resolver from before a reopen and re-approval", () => {
    const treasurer: Actor = { id: "device:treasurer0001", kind: "person" };
    const deliver = (rec: HandOffRecord) => {
      rec = t(rec, { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
      return t(rec, { type: "confirm", externalId: "d", externalStatus: "unsettled" }, agent, now);
    };
    let r = deliver(fresh());
    r = t(
      r,
      { type: "reconcile", diffs: compareHandOff(["netAmount"], invoice, invoice, {}) },
      agent,
      now,
    );
    r = t(
      r,
      { type: "resolve", field: "netAmount", kind: "accepted", reason: "rounding" },
      treasurer,
      now,
    );
    r = t(r, { type: "reopen", reason: "case corrected" }, clerk, now);
    r = t(r, { type: "reapprove", caseRevision: 4 }, clerk, now);
    r = deliver(r);
    r = t(r, { type: "reconcile", diffs: [] }, agent, now);
    expect(r.diffs).toEqual([]);
    const close = { type: "close", objective: "payment_settled", settlementRef: "bank:1" } as const;
    expect(() => t(r, close, treasurer, now, { caseRequestedBy: "device:requester001" })).toThrow(
      expect.objectContaining({ code: "handoff_sod_conflict", details: { roles: ["resolver"] } }),
    );
  });

  it("strict SoD refuses the case requester; warn allows it and says self-attested", () => {
    const requester: Actor = { id: "device:requester001", kind: "person" };
    const opened = approveHandOff(
      {
        id: "ho_2",
        caseId: "wi_inv_2",
        caseRevision: 1,
        action: "enter approved invoice as a deal",
        destination: { product: "freee 会計", object: "deals", writable: true },
        correlationId: "kurahi-wi_inv_2-r1",
        requestedBy: requester.id,
      },
      clerk,
      now,
    );
    expect(opened.requestedBy).toBe(requester.id);
    let r = t(opened, { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "confirm", externalId: "d", externalStatus: "unsettled" }, agent, now);
    r = t(r, { type: "reconcile", diffs: [] }, agent, now);
    const close = { type: "close", objective: "payment_settled", settlementRef: "bank:2" } as const;
    expect(() => t(r, close, requester, now)).toThrow(
      expect.objectContaining({ code: "handoff_sod_conflict", details: { roles: ["requester"] } }),
    );
    // The record's own requester wins over a later lookup.
    refused(
      () => t(r, close, requester, now, { caseRequestedBy: "device:someoneelse1" }),
      "handoff_sod_conflict",
    );
    const c = t(r, close, requester, now, { settlementSod: "warn" });
    expect(c.state).toBe("closed");
    expect(c.history.at(-1)?.detail).toMatchObject({
      settlementSod: "warn",
      sodOverlap: ["requester"],
      selfAttested: true,
      text: SELF_ATTESTED_SETTLEMENT_TEXT,
    });
    expect(SELF_ATTESTED_SETTLEMENT_TEXT.en).toMatch(/self-attested/);
    expect(SELF_ATTESTED_SETTLEMENT_TEXT.en).not.toMatch(/verified/i);
    expect(SELF_ATTESTED_SETTLEMENT_TEXT.ja).not.toContain("確認済み");
    expect(verifyHandOffHistory(c)).toBe(true);
  });

  it("a record written before the requester was captured: unknown is not independent", () => {
    // An old record read back from storage has no requestedBy field at all.
    const legacy = JSON.parse(JSON.stringify(fresh())) as HandOffRecord;
    delete legacy.requestedBy;
    let r = t(legacy, { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "confirm", externalId: "d", externalStatus: "unsettled" }, agent, now);
    r = t(r, { type: "reconcile", diffs: [] }, agent, now);
    const close = { type: "close", objective: "payment_settled", settlementRef: "bank:3" } as const;
    const other: Actor = { id: "device:auditor00001", kind: "person" };
    refused(() => t(r, close, other, now), "handoff_requester_unknown");
    refused(() => t(r, close, other, now, { caseRequestedBy: "  " }), "handoff_requester_unknown");
    // A looked-up requester makes the check possible, including a match.
    refused(() => t(r, close, other, now, { caseRequestedBy: other.id }), "handoff_sod_conflict");
    const c = t(r, close, other, now, { caseRequestedBy: "device:requester001" });
    expect("requestedBy" in c).toBe(false);
    expect(c.history.at(-1)?.detail.sodOverlap).toEqual([]);
    expect(verifyHandOffHistory(c)).toBe(true);
    // Warn closes it but records that the requester was unknown.
    const w = t(r, close, other, now, { settlementSod: "warn" });
    expect(w.history.at(-1)?.detail).toMatchObject({ requesterUnknown: true, selfAttested: false });
  });

  it("an agent cannot attest payment settled, even with a reference; it may still close the hand-off", () => {
    let r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = t(r, { type: "confirm", externalId: "d", externalStatus: "created" }, agent, now);
    r = t(r, { type: "reconcile", diffs: [] }, agent, now);
    refused(
      () =>
        t(
          r,
          {
            type: "close",
            objective: "payment_settled",
            settlementRef: "nonexistent-bank-evidence",
          },
          agent,
          now,
        ),
      "handoff_person_required",
    );
    expect(t(r, { type: "close", objective: "handoff_completed" }, agent, now).objective).toBe(
      "handoff_completed",
    );
  });

  it("a case change after approval reopens an open hand-off; closed ones stay closed", () => {
    const r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    expect(invalidateOnCaseChange(r, 3, agent, now).state).toBe("submitted");
    const reopened = invalidateOnCaseChange(r, 4, agent, now);
    expect(reopened.state).toBe("reopened");
    expect(r.state).toBe("submitted");
  });

  it("reopened mid-flight: the corrected case is not resubmitted until the destination is queried", () => {
    let r = t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now);
    r = invalidateOnCaseChange(r, 4, agent, now);
    r = t(r, { type: "reapprove", caseRevision: 4 }, clerk, now);
    refused(
      () => t(r, { type: "submit", payloadVersion: 2, payloadSha256: sha }, agent, now),
      "handoff_lookup_required",
    );
    let found = invalidateOnCaseChange(
      t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now),
      4,
      agent,
      now,
    );
    found = t(
      found,
      { type: "lookup", found: { externalId: "deal_7", externalStatus: "unsettled" } },
      agent,
      now,
    );
    found = t(
      t(found, { type: "reapprove", caseRevision: 4 }, clerk, now),
      { type: "submit", payloadVersion: 2, payloadSha256: sha },
      agent,
      now,
    );
    expect(found).toMatchObject({ state: "submitted", externalId: "deal_7" });
  });

  it("an edited, dropped or reordered history entry breaks the chain", () => {
    const r = t(
      t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now),
      { type: "timeout" },
      agent,
      now,
    );
    expect(verifyHandOffHistory(r)).toBe(true);
    const edited = structuredClone(r);
    edited.history[1].detail.payloadSha256 = "c".repeat(64);
    expect(verifyHandOffHistory(edited)).toBe(false);
    const dropped = structuredClone(r);
    dropped.history.splice(1, 1);
    expect(verifyHandOffHistory(dropped)).toBe(false);
  });

  it("a rejection that does not say nothing was created needs a lookup before any retry", () => {
    const submit = { type: "submit", payloadVersion: 1, payloadSha256: sha } as const;
    const rejected = t(
      t(fresh(), submit, agent, now),
      { type: "reject", reason: "422 without detail", notCreated: false },
      agent,
      now,
    );
    expect(() => t(rejected, { type: "retry", reason: "again" }, clerk, now)).toThrow(
      expect.objectContaining({ code: "handoff_lookup_required" }),
    );
    const found = t(
      rejected,
      { type: "lookup", found: { externalId: "deal_9", externalStatus: "draft" } },
      agent,
      now,
    );
    expect(found).toMatchObject({ state: "confirmed", externalId: "deal_9" });
    const missing = t(rejected, { type: "lookup", found: null }, agent, now);
    const retried = t(
      t(missing, { type: "retry", reason: "nothing there" }, clerk, now),
      submit,
      agent,
      now,
    );
    expect(retried).toMatchObject({ state: "submitted", attempts: [{}, {}] });

    const refused = t(
      t(fresh(), submit, agent, now),
      { type: "reject", reason: "validation", notCreated: true },
      agent,
      now,
    );
    expect(() => t(refused, { type: "lookup", found: null }, agent, now)).toThrow(
      expect.objectContaining({ code: "handoff_bad_transition" }),
    );
    expect(t(refused, { type: "retry", reason: "fixed" }, clerk, now).state).toBe("retry_pending");
  });

  it("a reconcile event cannot resolve its own differences; only a person can", () => {
    const confirmed = t(
      t(fresh(), { type: "submit", payloadVersion: 1, payloadSha256: sha }, agent, now),
      { type: "confirm", externalId: "deal_1", externalStatus: "created" },
      agent,
      now,
    );
    const r = t(
      confirmed,
      {
        type: "reconcile",
        diffs: [
          {
            field: "grossAmount",
            approved: 100,
            submitted: 100,
            destination: 900,
            resolution: { by: agent.id, reason: "agent accepted", kind: "accepted" },
          },
        ],
      },
      agent,
      now,
    );
    expect(r.state).toBe("mismatch");
    expect(r.diffs[0].resolution).toBeUndefined();
    expect(() => t(r, { type: "close", objective: "handoff_completed" }, agent, now)).toThrow(
      expect.objectContaining({ code: "handoff_bad_transition" }),
    );
    expect(() =>
      t(r, { type: "resolve", field: "grossAmount", kind: "accepted", reason: "ok" }, agent, now),
    ).toThrow(expect.objectContaining({ code: "handoff_person_required" }));
  });

  it("a record field changed outside the history fails verification", () => {
    const r = t(fresh(false), { type: "await_entry" }, clerk, now);
    expect(verifyHandOffHistory(r)).toBe(true);
    for (const edit of [
      (x: HandOffRecord) => (x.destination.writable = true),
      (x: HandOffRecord) => (x.destination.product = "another ledger"),
      (x: HandOffRecord) => (x.caseRevision = 999),
      (x: HandOffRecord) =>
        x.attempts.push({ at: now.toISOString(), payloadVersion: 1, payloadSha256: sha }),
    ]) {
      const edited = structuredClone(r);
      edit(edited);
      expect(verifyHandOffHistory(edited)).toBe(false);
    }
    // Key order is not part of the record: a store that reorders keys still verifies.
    const reordered = JSON.parse(
      JSON.stringify({
        ...r,
        destination: { writable: false, object: "deals", product: "freee 会計" },
      }),
    );
    expect(verifyHandOffHistory(reordered)).toBe(true);
  });
});
