import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { signAgentMessage, verifyAgentMessage } from "./envelope.js";
import { ensureAgentSigningKey, verifyAgentRegistry } from "./keys.js";
import { PersistentNonceCache } from "./nonce-store.js";
import { tempAgentKeyLocations } from "./test-helpers.js";

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-nonces-"));
  file = path.join(dir, "identity", "agent-message-nonces.jsonl");
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("persistent nonce store", () => {
  it("remembers nonces across a restart (a new instance on the same file)", () => {
    const first = new PersistentNonceCache(file);
    expect(first.remember("main:n1", 10_000, 1_000)).toBe(true);
    expect(first.remember("main:n1", 10_000, 1_001)).toBe(false);
    const restarted = new PersistentNonceCache(file);
    expect(restarted.remember("main:n1", 10_000, 2_000)).toBe(false);
    expect(restarted.remember("main:n2", 10_000, 2_000)).toBe(true);
  });

  it("creates the file 0600 in a 0700 folder", () => {
    new PersistentNonceCache(file).remember("main:n1", 10_000, 1_000);
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
  });

  it("drops expired entries on load and compacts the file", () => {
    const cache = new PersistentNonceCache(file);
    cache.remember("main:old", 1_500, 1_000);
    cache.remember("main:live", 9_000, 1_000);
    const restarted = new PersistentNonceCache(file);
    // The expired nonce is accepted again (its timestamp is outside the window anyway).
    expect(restarted.remember("main:old", 6_000, 5_000)).toBe(true);
    expect(restarted.remember("main:live", 9_000, 5_000)).toBe(false);
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines.some((l) => l.includes("main:live"))).toBe(true);
    expect(lines.filter((l) => l.includes("main:old"))).toHaveLength(1);
  });

  it("stays bounded: the file is rewritten past twice the entry cap", () => {
    const cache = new PersistentNonceCache(file, 10);
    for (let i = 0; i < 50; i++) {
      cache.remember(`main:n${i}`, 100_000, 1_000);
    }
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    expect(lines.length).toBeLessThanOrEqual(21);
    expect(cache.size()).toBeLessThanOrEqual(10);
  });

  it("ignores torn and malformed lines", () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"k":"main:a","e":9000}\nnot json\n{"k":"main:b","e":', {
      mode: 0o600,
    });
    const cache = new PersistentNonceCache(file);
    expect(cache.remember("main:a", 9_000, 1_000)).toBe(false);
    expect(cache.remember("main:b", 9_000, 1_000)).toBe(true);
  });

  it("keeps working from memory when the file cannot be written", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "");
    const cache = new PersistentNonceCache(path.join(blocker, "nonces.jsonl"));
    expect(cache.remember("main:n1", 10_000, 1_000)).toBe(true);
    expect(cache.remember("main:n1", 10_000, 1_000)).toBe(false);
  });

  it("a captured signed message cannot be replayed after a restart", () => {
    const loc = tempAgentKeyLocations();
    const key = ensureAgentSigningKey("main", { loc });
    const now = Date.now();
    const payload = { message: "run the report" };
    const envelope = signAgentMessage({
      key,
      senderSessionKey: "agent:main:main",
      recipientSessionKey: "agent:ops:main",
      payload,
      now,
    });
    const verify = (replay: PersistentNonceCache) =>
      verifyAgentMessage({
        envelope,
        payload,
        recipientSessionKeys: ["agent:ops:main"],
        registry: verifyAgentRegistry(loc),
        maxAgeMs: 300_000,
        replay,
        now: now + 1_000,
      });
    expect(verify(new PersistentNonceCache(file)).ok).toBe(true);
    const after = verify(new PersistentNonceCache(file));
    expect(after.ok).toBe(false);
    if (!after.ok) {
      expect(after.failure).toBe("replay");
    }
  });
});
