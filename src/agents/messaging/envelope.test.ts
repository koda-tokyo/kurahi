import { describe, expect, it } from "vitest";
import { NonceCache, signAgentMessage, verifyAgentMessage } from "./envelope.js";
import { ensureAgentSigningKey, loadOrCreateAgentKey, verifyAgentRegistry } from "./keys.js";
import { tempAgentKeyLocations } from "./test-helpers.js";

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const MAX_AGE_MS = 300_000;
const RECIPIENT = "agent:ops:main";
const payload = {
  message: "status of the deploy?",
  extraSystemPrompt: "Agent-to-agent message context:",
};

function setup() {
  const loc = tempAgentKeyLocations();
  const key = ensureAgentSigningKey("main", { loc });
  const registry = verifyAgentRegistry(loc);
  if (!registry.ok) {
    throw new Error(registry.reason);
  }
  const sign = (overrides: Partial<Parameters<typeof signAgentMessage>[0]> = {}) =>
    signAgentMessage({
      key,
      senderSessionKey: "agent:main:main",
      recipientSessionKey: RECIPIENT,
      payload,
      now: NOW,
      ...overrides,
    });
  const verify = (
    envelope: unknown,
    opts: { now?: number; replay?: NonceCache; message?: string } = {},
  ) =>
    verifyAgentMessage({
      envelope,
      payload: opts.message ? { ...payload, message: opts.message } : payload,
      recipientSessionKeys: [RECIPIENT],
      registry,
      maxAgeMs: MAX_AGE_MS,
      replay: opts.replay ?? new NonceCache(),
      now: opts.now ?? NOW + 1000,
    });
  return { loc, key, registry, sign, verify };
}

describe("signed inter-agent envelope", () => {
  it("sign/verify roundtrip", () => {
    const { sign, verify, key } = setup();
    const envelope = sign();
    expect(envelope).toMatchObject({
      version: 1,
      alg: "ed25519",
      senderAgentId: "main",
      senderSessionKey: "agent:main:main",
      recipientSessionKey: RECIPIENT,
      timestamp: NOW,
      keyId: key.keyId,
    });
    expect(envelope.nonce.length).toBeGreaterThanOrEqual(22);
    expect(verify(envelope)).toEqual({
      ok: true,
      senderAgentId: "main",
      senderSessionKey: "agent:main:main",
      keyId: key.keyId,
    });
  });

  it("a tampered message fails the payload hash", () => {
    const { sign, verify } = setup();
    expect(verify(sign(), { message: "delete everything" })).toMatchObject({
      ok: false,
      failure: "payload-mismatch",
    });
  });

  it("tampered envelope fields fail the signature", () => {
    const { sign, verify } = setup();
    const envelope = sign();
    expect(verify({ ...envelope, senderSessionKey: "agent:main:other" })).toMatchObject({
      ok: false,
      failure: "bad-signature",
    });
    expect(verify({ ...envelope, timestamp: NOW + 5 })).toMatchObject({ failure: "bad-signature" });
  });

  it("an envelope signed for another session is rejected", () => {
    const { sign, verify } = setup();
    expect(verify(sign({ recipientSessionKey: "agent:ops:telegram:group:1" }))).toMatchObject({
      ok: false,
      failure: "recipient-mismatch",
    });
  });

  it("a replayed nonce is rejected", () => {
    const { sign, verify } = setup();
    const replay = new NonceCache();
    const envelope = sign();
    expect(verify(envelope, { replay }).ok).toBe(true);
    expect(verify(envelope, { replay })).toMatchObject({ ok: false, failure: "replay" });
  });

  it("a stale (or future) timestamp is rejected", () => {
    const { sign, verify } = setup();
    expect(verify(sign(), { now: NOW + MAX_AGE_MS + 1 })).toMatchObject({ failure: "stale" });
    expect(verify(sign(), { now: NOW - MAX_AGE_MS - 1 })).toMatchObject({ failure: "stale" });
  });

  it("an unknown sender is rejected, even with a self-consistent signature", () => {
    const { sign, verify, loc } = setup();
    // Key that exists on disk but was never registered by the owner.
    const rogue = loadOrCreateAgentKey(loc, "rogue");
    expect(verify(sign({ key: rogue }))).toMatchObject({
      ok: false,
      failure: "unknown-sender",
      reason: "sender agent is not registered",
    });
    // Claiming a registered agent id with another key.
    expect(verify(sign({ key: { ...rogue, agentId: "main" } }))).toMatchObject({
      ok: false,
      failure: "unknown-sender",
      reason: "sender key is not the registered key",
    });
  });

  it("an untrusted registry rejects every sender", () => {
    const { sign } = setup();
    const result = verifyAgentMessage({
      envelope: sign(),
      payload,
      recipientSessionKeys: [RECIPIENT],
      registry: { ok: false, reason: "agent key registry is not signed" },
      maxAgeMs: MAX_AGE_MS,
      replay: new NonceCache(),
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, failure: "registry" });
  });

  it("malformed envelopes fail the schema", () => {
    const { sign, verify } = setup();
    expect(verify({ ...sign(), extra: true })).toMatchObject({ failure: "schema" });
    expect(verify({ ...sign(), senderAgentId: "../main" })).toMatchObject({ failure: "schema" });
    expect(verify("not an object")).toMatchObject({ failure: "schema" });
  });

  it("the nonce cache stays bounded", () => {
    const cache = new NonceCache(3);
    for (let i = 0; i < 10; i += 1) {
      expect(cache.remember(`n${i}`, NOW + 1000, NOW)).toBe(true);
    }
    expect(cache.remember("n9", NOW + 1000, NOW)).toBe(false);
  });
});
