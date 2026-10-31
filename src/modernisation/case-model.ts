// Change-case model (KIMS-013): states, the allowed transitions of spec §5, and the stored
// record. Pure data; the operations are in case.ts.
export const CASE_STATES = [
  "DRAFT",
  "SNAPSHOT_FROZEN",
  "ANALYSING",
  "ANALYSIS_REVIEW",
  "CHANGE_PROPOSED",
  "CHANGE_REVIEW",
  "TEST_QUEUED",
  "TEST_RUNNING",
  "TEST_REVIEW",
  "APPROVAL_PENDING",
  "APPROVED_FOR_HANDOFF",
  "EXPORTED",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
  "RECONCILIATION_REQUIRED",
  "REVIEWED_RETRY",
  "REJECTED",
] as const;
export type CaseState = (typeof CASE_STATES)[number];

export const MAIN_STATES: CaseState[] = CASE_STATES.slice(0, 12);
const ACTIVE = new Set<CaseState>(MAIN_STATES.slice(0, 11));
export const TERMINAL_STATES = new Set<CaseState>(["EXPORTED", "FAILED", "CANCELLED", "REJECTED"]);

/** Allowed explicit transitions (spec §5). Revisions back to CHANGE_PROPOSED are separate. */
export function allowedTransitions(from: CaseState): CaseState[] {
  const out: CaseState[] = [];
  const i = MAIN_STATES.indexOf(from);
  if (i >= 0 && i < MAIN_STATES.length - 1) {
    out.push(MAIN_STATES[i + 1]);
  }
  if (ACTIVE.has(from)) {
    out.push("BLOCKED", "FAILED", "CANCELLED", "RECONCILIATION_REQUIRED");
  }
  if (from === "CHANGE_REVIEW" || from === "TEST_REVIEW" || from === "APPROVAL_PENDING") {
    out.push("REJECTED");
  }
  if (from === "RECONCILIATION_REQUIRED") {
    out.push("REVIEWED_RETRY", "FAILED", "CANCELLED");
  }
  if (from === "REVIEWED_RETRY") {
    out.push("TEST_QUEUED", "CANCELLED");
  }
  if (from === "BLOCKED") {
    out.push("CANCELLED", "FAILED");
  }
  return out;
}

export type TestRunRef = {
  runId: string;
  verdict: string;
  bundle: string;
  reportSha256: string;
  candidate: string;
  policySha256: string;
  changeSpecSha256: string | null;
  fixturesDigest: string;
  at: string;
  valid: boolean;
  invalidatedReason?: string;
};

export type Approval = {
  id: string;
  decision: "approved" | "rejected";
  approver: string;
  role: string;
  scopeHash: string;
  decidedAt: string;
  expiresAt: string | null;
  valid: boolean;
  invalidatedReason?: string;
  evidence: string;
};

export type ChangeCase = {
  schema: "kurahi.change-case/1";
  id: string;
  title: string;
  createdAt: string;
  createdBy: string;
  revision: number;
  state: CaseState;
  baseline: string;
  candidate: string;
  candidateDir: string | null;
  changeSpec: { id: string; sha256: string } | null;
  policySha256: string;
  fixturesDigest: string | null;
  approvalRequestedBy: string | null;
  testRuns: TestRunRef[];
  approvals: Approval[];
  events: Array<{
    seq: number;
    at: string;
    actor: string;
    from: CaseState | null;
    to: CaseState;
    note: string;
  }>;
  handoff: { at: string; by: string; manifest: string; deployed: false } | null;
};
