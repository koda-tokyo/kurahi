// Workflow Evaluator phase 0: approvals, start digests, declared outputs and cost in evidence.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { emitEvidenceSignal } from "./bus.js";
import { costSnapshot } from "./cost.js";
import { __resetEvidenceForTest, EvidenceRecorder } from "./recorder.js";
import { digestOf } from "./redact.js";
import { readEventsFile, resolveEvidenceLimits, verifyEventChain } from "./store.js";

let home: string;
let env: NodeJS.ProcessEnv;
let key: { privateKeyPem: string; publicKeyPem: string };
const job = {
  id: "job-p0",
  agent: "inspector",
  sessionKey: "agent:inspector:main",
  kind: "csv-inspection",
  startedAt: "2026-10-18T00:00:00.000Z",
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-evidence-p0-"));
  env = { ...process.env, KOLO_HOME: home, KOLO_STATE_DIR: home };
  const id = loadOrCreateDeviceIdentity(path.join(home, "identity", "signing.json"));
  key = { privateKeyPem: id.privateKeyPem, publicKeyPem: id.publicKeyPem };
});
afterEach(() => {
  __resetEvidenceForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

function make(startDigests?: { policyDigest?: string | null; inventoryDigest?: string | null }) {
  return new EvidenceRecorder(job, {
    env,
    key,
    limits: resolveEvidenceLimits(),
    now: () => new Date("2026-10-18T00:00:05.000Z"),
    startDigests,
    onError: (m) => {
      throw new Error(m);
    },
  });
}

describe("phase 0 evidence", () => {
  test("job.start carries the policy and inventory digests", () => {
    const r = make({ policyDigest: "p".repeat(64), inventoryDigest: "i".repeat(64) });
    r.start({ prompt: "check the CSV" });
    r.finish({ status: "succeeded", steps: 1, toolCalls: 0 });
    const events = readEventsFile(path.join(r.dir, "events.jsonl"));
    expect(events[0]?.data).toMatchObject({
      policyDigest: "p".repeat(64),
      inventoryDigest: "i".repeat(64),
    });
  });

  test("an explicit start digest wins over the default; none recorded as null", () => {
    const r = make();
    r.start({ prompt: "x", policyDigest: "a".repeat(64) });
    r.finish({ status: "succeeded", steps: 0, toolCalls: 0 });
    const events = readEventsFile(path.join(r.dir, "events.jsonl"));
    expect(events[0]?.data).toMatchObject({ policyDigest: "a".repeat(64), inventoryDigest: null });
  });

  test("an approval signal becomes a hash-chained approval event", () => {
    const r = make();
    r.start({ prompt: "x" });
    const args = { to: "qa@example.test", subject: "Exceptions" };
    emitEvidenceSignal({
      kind: "approval",
      sessionKey: job.sessionKey,
      tool: "message.send",
      decision: "allow",
      ruleId: "send-needs-approval",
      approvalId: "ap-1",
      approver: "device:owner",
      argsDigest: digestOf(args),
    });
    r.toolStart({ toolCallId: "t1", name: "message.send", args });
    r.finish({ status: "succeeded", steps: 1, toolCalls: 1 });
    const events = readEventsFile(path.join(r.dir, "events.jsonl"));
    const approval = events.find((e) => e.type === "approval");
    const call = events.find((e) => e.type === "tool.call");
    expect(approval?.data).toMatchObject({
      decision: "allow",
      approver: "device:owner",
      ruleId: "send-needs-approval",
    });
    expect(approval!.seq).toBeLessThan(call!.seq);
    expect(approval?.data.argsDigest).toBe(call?.data.argsDigest);
    expect(verifyEventChain(events).ok).toBe(true);
  });

  test("declared outputs are recorded in job.end with their SHA-256", () => {
    const r = make();
    r.start({ prompt: "x" });
    const out = path.join(home, "report.json");
    fs.writeFileSync(out, '{"exceptions":[]}');
    r.declareOutput("report", "report.json", home);
    r.declareOutput("missing", "nope.json", home);
    r.finish({ status: "succeeded", steps: 1, toolCalls: 0 });
    const end = readEventsFile(path.join(r.dir, "events.jsonl")).at(-1)!;
    const outputs = end.data.outputs as Record<
      string,
      { sha256: string | null; size: number | null }
    >;
    expect(outputs.report?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(outputs.report?.size).toBe(17);
    expect(outputs.missing?.sha256).toBeNull();
  });

  test("job.end carries a cost snapshot priced from the catalogue", () => {
    const r = make();
    r.start({ prompt: "x" });
    r.modelTurn({
      provider: "sakura",
      model: "gpt-oss-120b",
      usage: { input: 1_000_000, output: 100_000 },
      text: "a",
    });
    r.modelTurn({
      provider: "sakura",
      model: "gpt-oss-120b",
      usage: { input: 0, output: 100_000 },
      text: "b",
    });
    r.modelTurn({
      provider: "nowhere",
      model: "unknown",
      usage: { input: 10, output: 10 },
      text: "c",
    });
    r.finish({ status: "succeeded", steps: 3, toolCalls: 0 });
    const end = readEventsFile(path.join(r.dir, "events.jsonl")).at(-1)!;
    const cost = end.data.cost as ReturnType<typeof costSnapshot>;
    // 1M input × 15 + 200k output × 75, per million tokens = 15 + 15 = 30 JPY
    expect(cost.totals.JPY).toBeCloseTo(30, 6);
    expect(cost.unpriced).toBe(1);
    expect(cost.lines.find((l) => l.provider === "sakura")?.price?.asOf).toBe("2026-10-14");
  });
});
