// Change cases (KIMS-013, AC-017/018/019): the minimal R1 lifecycle that ties a baseline
// snapshot, a candidate snapshot, a change spec, a verification policy and test runs to an
// approval. The approval carries a scope hash over all of them; any change to candidate,
// change spec, policy or fixtures invalidates it, and handoff re-checks it (expiry, stored
// snapshots, optionally the live candidate folder) before anything leaves the case.
// APPROVED_FOR_HANDOFF is the highest R1 state and EXPORTED only writes a handoff manifest:
// nothing is deployed, ever, from here.
//
//   <data>/cases/<caseId>.json                      the case (revisioned, append-only events)
//   <data>/cases/<caseId>/evidence/<seq>-<kind>/    signed bundle per decision
//   <data>/cases/<caseId>/handoff.json              the handoff manifest (EXPORTED)
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { VerificationReport } from "./types.js";
import { canonicalJson, sha256Hex } from "../continuity-suite/manifest.js";
import {
  allowedTransitions,
  type Approval,
  type CaseState,
  type ChangeCase,
  MAIN_STATES as MAIN,
  TERMINAL_STATES as TERMINAL,
  type TestRunRef,
} from "./case-model.js";
import { writeCaseEvidence } from "./evidence.js";
import { diffLiveFolder, loadSnapshot, verifySnapshot } from "./snapshot.js";

export {
  allowedTransitions,
  type Approval,
  CASE_STATES,
  type CaseState,
  type ChangeCase,
  type TestRunRef,
} from "./case-model.js";

type Ctx = { dataDir: string; env?: NodeJS.ProcessEnv; now?: () => Date };

const ID_RE = /^cc-[0-9TZ]+-[0-9a-f]{8}$/;
const nowIso = (ctx: Ctx) => (ctx.now?.() ?? new Date()).toISOString();

function caseFile(dataDir: string, id: string): string {
  if (!ID_RE.test(id)) {
    throw new Error(`not a change case id: ${id}`);
  }
  return path.join(dataDir, "cases", `${id}.json`);
}

export function loadCase(dataDir: string, id: string): ChangeCase {
  const file = caseFile(dataDir, id);
  if (!fs.existsSync(file)) {
    throw new Error(`change case ${id} does not exist`);
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as ChangeCase;
}

/** Read-modify-write under an exclusive lock and a revision check. */
function mutate(
  ctx: Ctx,
  id: string,
  expectedRevision: number | undefined,
  fn: (c: ChangeCase) => void,
): ChangeCase {
  const file = caseFile(ctx.dataDir, id);
  const lock = `${file}.lock`;
  let fd: number;
  try {
    fd = fs.openSync(lock, "wx");
  } catch {
    throw new Error(`change case ${id} is being changed by another operation; retry`);
  }
  try {
    const c = loadCase(ctx.dataDir, id);
    if (expectedRevision !== undefined && c.revision !== expectedRevision) {
      throw new Error(
        `change case ${id} is at revision ${c.revision}, not ${expectedRevision}: reload it`,
      );
    }
    fn(c);
    c.revision++;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(c, null, 1)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, file);
    return c;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}

function move(
  ctx: Ctx,
  c: ChangeCase,
  to: CaseState,
  actor: string,
  note: string,
  opts: { revision?: boolean } = {},
) {
  if (!opts.revision && !allowedTransitions(c.state).includes(to)) {
    throw new Error(`transition ${c.state} -> ${to} is not allowed`);
  }
  c.events.push({ seq: c.events.length + 1, at: nowIso(ctx), actor, from: c.state, to, note });
  c.state = to;
}

function evidence(
  ctx: Ctx,
  c: ChangeCase,
  kind: string,
  status: string,
  record: Record<string, unknown>,
): string {
  const seq = c.events.length + 1;
  const dir = path.join(
    ctx.dataDir,
    "cases",
    c.id,
    "evidence",
    `${String(seq).padStart(4, "0")}-${kind}`,
  );
  writeCaseEvidence(
    dir,
    { jobId: `${c.id}-${seq}-${kind}`, caseId: c.id, status, at: nowIso(ctx) },
    record,
    { env: ctx.env },
  );
  return dir;
}

/** The approval scope: everything an approval vouches for. */
export function scopeHashOf(c: ChangeCase): string {
  const run = latestValidRun(c);
  return sha256Hex(
    canonicalJson({
      case: c.id,
      baseline: c.baseline,
      candidate: c.candidate,
      changeSpec: c.changeSpec?.sha256 ?? null,
      policy: c.policySha256,
      fixtures: c.fixturesDigest,
      test: run ? { runId: run.runId, report: run.reportSha256, verdict: run.verdict } : null,
    }),
  );
}

export function latestValidRun(c: ChangeCase): TestRunRef | null {
  return c.testRuns.filter((r) => r.valid).at(-1) ?? null;
}

export function createCase(
  ctx: Ctx,
  p: {
    title: string;
    createdBy: string;
    baseline: string;
    candidate: string;
    candidateDir?: string;
    changeSpec?: { id: string; sha256: string } | null;
    policySha256: string;
    fixturesDigest?: string | null;
  },
): ChangeCase {
  loadSnapshot(ctx.dataDir, p.baseline);
  loadSnapshot(ctx.dataDir, p.candidate);
  if (p.baseline === p.candidate) {
    throw new Error("the candidate snapshot is the baseline: there is no change");
  }
  const at = nowIso(ctx);
  const id = `cc-${at.replace(/[-:]/g, "").replace(/\..*$/, "")}Z-${crypto.randomBytes(4).toString("hex")}`;
  const c: ChangeCase = {
    schema: "kurahi.change-case/1",
    id,
    title: p.title,
    createdAt: at,
    createdBy: p.createdBy,
    revision: 0,
    state: "DRAFT",
    baseline: p.baseline,
    candidate: p.candidate,
    candidateDir: p.candidateDir ?? null,
    changeSpec: p.changeSpec ?? null,
    policySha256: p.policySha256,
    fixturesDigest: p.fixturesDigest ?? null,
    approvalRequestedBy: null,
    testRuns: [],
    approvals: [],
    events: [],
    handoff: null,
  };
  move(ctx, c, "SNAPSHOT_FROZEN", p.createdBy, "baseline and candidate snapshots frozen");
  fs.mkdirSync(path.dirname(caseFile(ctx.dataDir, id)), { recursive: true, mode: 0o700 });
  fs.writeFileSync(caseFile(ctx.dataDir, id), `${JSON.stringify(c, null, 1)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  return c;
}

export function transitionCase(
  ctx: Ctx,
  id: string,
  to: CaseState,
  actor: string,
  opts: { note?: string; expectedRevision?: number } = {},
): ChangeCase {
  if (to === "APPROVED_FOR_HANDOFF" || to === "EXPORTED" || to === "APPROVAL_PENDING") {
    throw new Error(
      `${to} is reached through requestApproval / decideApproval / handoffCase, not a plain transition`,
    );
  }
  return mutate(ctx, id, opts.expectedRevision, (c) => {
    move(ctx, c, to, actor, opts.note ?? "");
    if (TERMINAL.has(to)) {
      evidence(ctx, c, to.toLowerCase(), to, {
        case: c.id,
        state: to,
        actor,
        note: opts.note ?? "",
      });
    }
  });
}

function invalidate(ctx: Ctx, c: ChangeCase, reason: string, actor: string): void {
  let hadApproval = false;
  for (const a of c.approvals) {
    if (a.valid) {
      a.valid = false;
      a.invalidatedReason = reason;
      hadApproval = true;
    }
  }
  for (const r of c.testRuns) {
    if (r.valid) {
      r.valid = false;
      r.invalidatedReason = reason;
    }
  }
  c.approvalRequestedBy = null;
  if (hadApproval) {
    evidence(ctx, c, "approval-invalidated", "INVALIDATED", { case: c.id, reason, actor });
  }
}

/** A new candidate, change spec, policy or fixture set: approvals and test runs no longer apply. */
export function reviseCase(
  ctx: Ctx,
  id: string,
  actor: string,
  change: {
    candidate?: string;
    candidateDir?: string;
    changeSpec?: { id: string; sha256: string } | null;
    policySha256?: string;
    fixturesDigest?: string | null;
  },
): ChangeCase {
  return mutate(ctx, id, undefined, (c) => {
    if (TERMINAL.has(c.state)) {
      throw new Error(`change case ${id} is ${c.state}; open a new case`);
    }
    if (change.candidate) {
      loadSnapshot(ctx.dataDir, change.candidate);
    }
    const what = Object.keys(change).join(", ");
    Object.assign(c, change);
    invalidate(ctx, c, `revised: ${what}`, actor);
    if (MAIN.indexOf(c.state) > MAIN.indexOf("CHANGE_PROPOSED")) {
      move(
        ctx,
        c,
        "CHANGE_PROPOSED",
        actor,
        `revised (${what}); approvals and test runs invalidated`,
        { revision: true },
      );
    }
  });
}

/** Attach a finished verification run (TEST_QUEUED/TEST_RUNNING → TEST_REVIEW). */
export function attachTestRun(
  ctx: Ctx,
  id: string,
  actor: string,
  run: { report: VerificationReport; bundleDir: string },
): ChangeCase {
  return mutate(ctx, id, undefined, (c) => {
    const r = run.report;
    if (r.baseline.snapshot !== c.baseline || r.candidate.snapshot !== c.candidate) {
      throw new Error("the run is for other snapshots than this case's baseline and candidate");
    }
    if (
      (r.changeSpec?.sha256 ?? null) !== (c.changeSpec?.sha256 ?? null) ||
      r.policySha256 !== c.policySha256
    ) {
      throw new Error("the run used another change spec or policy than this case");
    }
    if (c.fixturesDigest && r.fixtures.digest !== c.fixturesDigest) {
      throw new Error("the run used other fixtures than this case");
    }
    if (c.state === "TEST_QUEUED") {
      move(ctx, c, "TEST_RUNNING", actor, `run ${r.runId}`);
    }
    if (c.state !== "TEST_RUNNING") {
      throw new Error(`a test run can be attached in TEST_QUEUED or TEST_RUNNING, not ${c.state}`);
    }
    c.fixturesDigest ??= r.fixtures.digest;
    c.testRuns.push({
      runId: r.runId,
      verdict: r.verdict,
      bundle: run.bundleDir,
      reportSha256: sha256Hex(fs.readFileSync(path.join(run.bundleDir, "report.json"))),
      candidate: r.candidate.snapshot,
      policySha256: r.policySha256,
      changeSpecSha256: r.changeSpec?.sha256 ?? null,
      fixturesDigest: r.fixtures.digest,
      at: nowIso(ctx),
      valid: true,
    });
    move(ctx, c, "TEST_REVIEW", actor, `run ${r.runId}: ${r.verdict}`);
  });
}

export function requestApproval(ctx: Ctx, id: string, actor: string): ChangeCase {
  return mutate(ctx, id, undefined, (c) => {
    const run = latestValidRun(c);
    if (!run || run.verdict !== "PASS") {
      throw new Error(
        `approval needs a valid PASS test run; latest is ${run ? run.verdict : "none"}`,
      );
    }
    move(ctx, c, "APPROVAL_PENDING", actor, `requested on run ${run.runId}`);
    c.approvalRequestedBy = actor;
  });
}

/** G5: an independent approver approves (→ APPROVED_FOR_HANDOFF) or rejects (→ REJECTED). */
export function decideApproval(
  ctx: Ctx,
  id: string,
  p: {
    approver: string;
    role: string;
    decision: "approved" | "rejected";
    validForMs?: number;
    expectedRevision?: number;
  },
): ChangeCase {
  return mutate(ctx, id, p.expectedRevision, (c) => {
    if (c.state !== "APPROVAL_PENDING") {
      throw new Error(`no approval is pending (state ${c.state})`);
    }
    if (p.role !== "approver") {
      throw new Error("only the approver role can decide");
    }
    if (p.approver === c.createdBy || p.approver === c.approvalRequestedBy) {
      throw new Error(
        "segregation of duties: the approver must not be the case owner or the requester",
      );
    }
    const at = nowIso(ctx);
    const scopeHash = scopeHashOf(c);
    const approval: Approval = {
      id: `ap-${c.approvals.length + 1}`,
      decision: p.decision,
      approver: p.approver,
      role: p.role,
      scopeHash,
      decidedAt: at,
      expiresAt: p.validForMs ? new Date(Date.parse(at) + p.validForMs).toISOString() : null,
      valid: p.decision === "approved",
      evidence: "",
    };
    approval.evidence = evidence(
      ctx,
      c,
      p.decision === "approved" ? "approved" : "rejected",
      p.decision.toUpperCase(),
      {
        case: c.id,
        approval,
        baseline: c.baseline,
        candidate: c.candidate,
        changeSpec: c.changeSpec,
        policySha256: c.policySha256,
        fixturesDigest: c.fixturesDigest,
        testRun: latestValidRun(c),
        note: "R1 approval enables handoff only; it never deploys.",
      },
    );
    c.approvals.push(approval);
    move(
      ctx,
      c,
      p.decision === "approved" ? "APPROVED_FOR_HANDOFF" : "REJECTED",
      p.approver,
      `${p.decision} (scope ${scopeHash.slice(0, 16)})`,
    );
  });
}

/**
 * Hand off an approved case: re-check the approval (valid, unexpired, scope hash equal to the
 * case as it is now, snapshots intact, live candidate folder unchanged) and write a handoff
 * manifest. Never deploys; `deployed` is always false. A stale approval is invalidated.
 */
export function handoffCase(
  ctx: Ctx,
  id: string,
  actor: string,
  opts: { liveCandidateDir?: string } = {},
): { case: ChangeCase; manifest: string; deployed: false } {
  let manifest = "";
  const outcome = { stale: "" };
  const c = mutate(ctx, id, undefined, (c) => {
    if (c.state !== "APPROVED_FOR_HANDOFF") {
      throw new Error(`handoff needs APPROVED_FOR_HANDOFF, not ${c.state}`);
    }
    const a = c.approvals.filter((x) => x.valid && x.decision === "approved").at(-1);
    const problems: string[] = [];
    if (!a) {
      problems.push("no valid approval");
    } else {
      if (a.scopeHash !== scopeHashOf(c)) {
        problems.push("approval scope hash does not match the case");
      }
      if (a.expiresAt && Date.parse(a.expiresAt) <= Date.parse(nowIso(ctx))) {
        problems.push(`approval expired at ${a.expiresAt}`);
      }
    }
    for (const s of [c.baseline, c.candidate]) {
      problems.push(...verifySnapshot(ctx.dataDir, s));
    }
    const live = opts.liveCandidateDir ?? c.candidateDir;
    if (live && fs.existsSync(live)) {
      const diff = diffLiveFolder(loadSnapshot(ctx.dataDir, c.candidate), live);
      if (diff.length > 0) {
        problems.push(`candidate source changed after approval: ${diff.slice(0, 3).join(", ")}`);
      }
    }
    if (problems.length > 0) {
      outcome.stale = problems.join("; ");
      invalidate(ctx, c, `stale at handoff: ${outcome.stale}`, actor);
      move(ctx, c, "CHANGE_PROPOSED", actor, `handoff refused: ${outcome.stale}`, {
        revision: true,
      });
      return;
    }
    manifest = path.join(ctx.dataDir, "cases", c.id, "handoff.json");
    const record = {
      case: c.id,
      title: c.title,
      baseline: c.baseline,
      candidate: c.candidate,
      changeSpec: c.changeSpec,
      policySha256: c.policySha256,
      approval: a,
      testRun: latestValidRun(c),
      deployed: false,
      note: "Handoff package for a separately authorised deployment process. Kurahi R1 does not deploy.",
    };
    fs.writeFileSync(manifest, `${JSON.stringify(record, null, 1)}\n`, { mode: 0o600 });
    evidence(ctx, c, "handoff", "EXPORTED", record);
    move(ctx, c, "EXPORTED", actor, "handoff manifest written; nothing deployed");
    c.handoff = { at: nowIso(ctx), by: actor, manifest, deployed: false };
  });
  if (outcome.stale) {
    throw new Error(`handoff refused, approval invalidated: ${outcome.stale}`);
  }
  return { case: c, manifest, deployed: false };
}
