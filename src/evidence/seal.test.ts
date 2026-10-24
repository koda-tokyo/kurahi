import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { __resetEvidenceForTest, EvidenceRecorder, startEvidence } from "./recorder.js";
import {
  EVIDENCE_INTERRUPTED_ERROR,
  evidenceProcessOwner,
  sealInterruptedEvidence,
} from "./seal.js";
import {
  EVENTS_FILE,
  eventHash,
  fileEntryOf,
  listEvidenceJobs,
  MANIFEST_FILE,
  readEventsFile,
  readJobManifest,
  resolveEvidenceLimits,
  verifyEventChain,
  verifyEvidenceSignature,
} from "./store.js";

let home: string;
let env: NodeJS.ProcessEnv;
let key: { privateKeyPem: string; publicKeyPem: string };
const NOW = new Date("2026-10-23T06:00:00.000Z");
const now = () => NOW;
/** The next process after a restart: same pid (a container's pid 1), new instance. */
const self = { pid: process.pid, instance: "next-process" };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-evidence-seal-"));
  env = { ...process.env, KOLO_HOME: home, KOLO_STATE_DIR: home };
  const id = loadOrCreateDeviceIdentity(path.join(home, "identity", "signing.json"));
  key = { privateKeyPem: id.privateKeyPem, publicKeyPem: id.publicKeyPem };
});

afterEach(() => {
  __resetEvidenceForTest();
  fs.rmSync(home, { recursive: true, force: true });
});

/** A job whose process stopped mid-run: events written, never finished, last write `ageMs` ago. */
function orphan(id: string, ageMs = 60 * 60_000): EvidenceRecorder {
  const r = new EvidenceRecorder(
    {
      id,
      agent: "ops",
      sessionKey: "agent:ops:cron",
      kind: "cron",
      startedAt: "2026-10-23T04:00:00.000Z",
    },
    {
      env,
      key,
      limits: resolveEvidenceLimits(),
      now: () => new Date("2026-10-23T04:00:01.000Z"),
    },
  );
  r.start({ prompt: "verify backups", provider: "ollama", model: "qwen" });
  r.toolStart({ toolCallId: "t1", name: "exec", args: { command: "ops-job backup" } });
  const at = new Date(NOW.getTime() - ageMs);
  fs.utimesSync(path.join(r.dir, EVENTS_FILE), at, at);
  return r;
}

describe("sealInterruptedEvidence", () => {
  test("closes an orphaned log as failed/interrupted with a chained job.end and signed manifest", () => {
    const r = orphan("job-cut");
    expect(listEvidenceJobs(env)[0]).toMatchObject({ status: "running", signed: false });

    const result = sealInterruptedEvidence({ env, key, now, self });
    expect(result.sealed).toEqual(["job-cut"]);

    const events = readEventsFile(path.join(r.dir, EVENTS_FILE));
    expect(events.map((e) => e.type)).toEqual(["job.start", "tool.call", "job.end"]);
    expect(events[2].data).toMatchObject({
      status: "failed",
      error: EVIDENCE_INTERRUPTED_ERROR,
      interrupted: true,
      lastEventAt: events[1].ts,
    });
    const chain = verifyEventChain(events);
    expect(chain.ok).toBe(true);

    const manifest = readJobManifest("job-cut", env)!;
    expect(manifest).toMatchObject({
      jobId: "job-cut",
      agent: "ops",
      sessionKey: "agent:ops:cron",
      kind: "cron",
      status: "failed",
      startedAt: "2026-10-23T04:00:00.000Z",
      endedAt: NOW.toISOString(),
      events: { count: 3, root: chain.root, truncated: false },
    });
    expect(manifest.files[EVENTS_FILE]).toEqual(fileEntryOf(path.join(r.dir, EVENTS_FILE)));
    expect(verifyEvidenceSignature(manifest, manifest.signer, manifest.signature)).toEqual({
      keyIdOk: true,
      signatureOk: true,
    });
    expect(listEvidenceJobs(env)[0]).toMatchObject({ status: "failed", signed: true });

    // Idempotent: a sealed log is not touched again.
    expect(sealInterruptedEvidence({ env, key, now, self }).sealed).toEqual([]);
    expect(readEventsFile(path.join(r.dir, EVENTS_FILE))).toHaveLength(3);
  });

  test("signs a log that already has job.end but lost its manifest, without a second job.end", () => {
    const r = orphan("job-nomanifest");
    r.finish({ status: "succeeded", steps: 1, toolCalls: 1 });
    fs.rmSync(path.join(r.dir, MANIFEST_FILE));
    const at = new Date(NOW.getTime() - 60 * 60_000);
    fs.utimesSync(path.join(r.dir, EVENTS_FILE), at, at);

    expect(sealInterruptedEvidence({ env, key, now, self }).sealed).toEqual(["job-nomanifest"]);
    const events = readEventsFile(path.join(r.dir, EVENTS_FILE));
    expect(events.filter((e) => e.type === "job.end")).toHaveLength(1);
    expect(readJobManifest("job-nomanifest", env)).toMatchObject({
      status: "succeeded",
      events: { count: events.length, root: verifyEventChain(events).root },
    });
  });

  test("leaves live, recently written, broken and unreadable logs untouched", () => {
    orphan("job-live");
    orphan("job-recent", 60_000);
    const broken = orphan("job-broken");
    const brokenFile = path.join(broken.dir, EVENTS_FILE);
    const at = new Date(NOW.getTime() - 60 * 60_000);
    fs.writeFileSync(brokenFile, fs.readFileSync(brokenFile, "utf8").replace("ops-job", "rm -rf"));
    fs.utimesSync(brokenFile, at, at);
    const partial = orphan("job-partial");
    const partialFile = path.join(partial.dir, EVENTS_FILE);
    fs.appendFileSync(partialFile, '{"seq":3,"ts":"2026');
    fs.utimesSync(partialFile, at, at);
    const before = Object.fromEntries(
      ["job-live", "job-recent", "job-broken", "job-partial"].map((id) => [
        id,
        fs.readFileSync(path.join(home, "evidence", id, EVENTS_FILE), "utf8"),
      ]),
    );

    const result = sealInterruptedEvidence({
      env,
      key,
      now,
      self,
      isLive: (id) => id === "job-live",
    });
    expect(result.sealed).toEqual([]);
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.jobId, s.reason]));
    expect(reasons["job-live"]).toBeUndefined();
    expect(reasons["job-recent"]).toBe("recent writes");
    expect(reasons["job-broken"]).toMatch(/does not recompute/);
    expect(reasons["job-partial"]).toMatch(/^unreadable/);
    for (const [id, text] of Object.entries(before)) {
      expect(fs.readFileSync(path.join(home, "evidence", id, EVENTS_FILE), "utf8")).toBe(text);
      expect(fs.existsSync(path.join(home, "evidence", id, MANIFEST_FILE))).toBe(false);
    }
  });

  test("job.start records the owner process", () => {
    const r = orphan("job-owner");
    const [start] = readEventsFile(path.join(r.dir, EVENTS_FILE));
    expect(start.data.owner).toEqual(evidenceProcessOwner());
  });

  test("never seals a log whose owner is alive, however idle it is", () => {
    const r = orphan("job-shared", 24 * 60 * 60_000);
    const text = fs.readFileSync(path.join(r.dir, EVENTS_FILE), "utf8");

    const own = sealInterruptedEvidence({ env, key, now });
    expect(own.skipped).toEqual([{ jobId: "job-shared", reason: "owned by this process" }]);

    const other = { pid: process.pid + 1, instance: "other-process" };
    const alive = sealInterruptedEvidence({ env, key, now, self: other, isPidAlive: () => true });
    expect(alive.skipped).toEqual([{ jobId: "job-shared", reason: "owner process alive" }]);
    expect(fs.readFileSync(path.join(r.dir, EVENTS_FILE), "utf8")).toBe(text);
    expect(fs.existsSync(path.join(r.dir, MANIFEST_FILE))).toBe(false);

    const dead = sealInterruptedEvidence({ env, key, now, self: other, isPidAlive: () => false });
    expect(dead.sealed).toEqual(["job-shared"]);
  });

  test("skips a log another process is sealing, and leaves no lock behind", () => {
    const r = orphan("job-locked");
    const lockPath = path.join(home, "evidence", ".seal.job-locked.lock");
    fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}`);

    const held = sealInterruptedEvidence({ env, key, now, self });
    expect(held.skipped).toEqual([{ jobId: "job-locked", reason: "seal in progress elsewhere" }]);
    expect(readEventsFile(path.join(r.dir, EVENTS_FILE))).toHaveLength(2);

    fs.rmSync(lockPath);
    expect(sealInterruptedEvidence({ env, key, now, self }).sealed).toEqual(["job-locked"]);
    expect(fs.readdirSync(path.join(home, "evidence")).filter((n) => n.endsWith(".lock"))).toEqual(
      [],
    );
  });

  test("never seals a log whose owner ran on another host (containers sharing a volume)", () => {
    const r = orphan("job-elsewhere", 24 * 60 * 60_000);
    reown(r.dir, { pid: process.pid, instance: "other-container", host: "container-b" });
    const other = { pid: process.pid, instance: "next-process", host: "container-a" };
    const result = sealInterruptedEvidence({ env, key, now, self: other });
    expect(result.skipped).toEqual([{ jobId: "job-elsewhere", reason: "owner on another host" }]);
    expect(fs.existsSync(path.join(r.dir, MANIFEST_FILE))).toBe(false);
  });

  test("a log skipped on the first job is sealed on a later job of the same process", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      const r = orphan("job-early", 5 * 60_000);
      reown(r.dir, { pid: 99_999_999, instance: "previous-process", host: os.hostname() }, 5);
      const job = (id: string) => ({
        id,
        agent: "ops",
        sessionKey: "agent:ops:cron",
        kind: "cron" as const,
        startedAt: NOW.toISOString(),
      });

      // First job of the process: the orphan was written 5 min ago, too recent to seal.
      startEvidence(job("job-first"), { env });
      expect(fs.existsSync(path.join(r.dir, MANIFEST_FILE))).toBe(false);

      // Six minutes later the next job retries it.
      vi.setSystemTime(new Date(NOW.getTime() + 6 * 60_000));
      startEvidence(job("job-second"), { env });
      expect(readJobManifest("job-early", env)).toMatchObject({ status: "failed" });
      const events = readEventsFile(path.join(r.dir, EVENTS_FILE));
      expect(events.at(-1)?.data).toMatchObject({ interrupted: true });
      expect(verifyEventChain(events).ok).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

/** Rewrite job.start's owner and re-chain the log, keeping its mtime `ageMin` minutes old. */
function reown(dir: string, owner: Record<string, unknown>, ageMin = 60): void {
  const file = path.join(dir, EVENTS_FILE);
  const events = readEventsFile(file);
  events[0] = { ...events[0], data: { ...events[0].data, owner } };
  let prev = events[0].prev;
  const lines = events.map((e) => {
    const { prev: _p, hash: _h, ...base } = e;
    const hash = eventHash(prev, base);
    const out = { ...base, prev, hash };
    prev = hash;
    return JSON.stringify(out);
  });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  const at = new Date(NOW.getTime() - ageMin * 60_000);
  fs.utimesSync(file, at, at);
}
