import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { addOwner } from "../../policy/attestation.js";
import {
  ensureAgentSigningKey,
  loadOrCreateAgentKey,
  readAgentRegistry,
  registerAgentKey,
  verifyAgentRegistry,
} from "./keys.js";
import { tempAgentKeyLocations } from "./test-helpers.js";

const posix = process.platform !== "win32";

describe("agent signing keys", () => {
  it("creates a 0600 key on demand and registers it in an owner-signed registry", () => {
    const loc = tempAgentKeyLocations();
    const key = ensureAgentSigningKey("ops", { loc });
    expect(key.registered).toBe(true);
    expect(key.keyId).toMatch(/^[0-9a-f]{64}$/);
    if (posix) {
      expect(fs.statSync(`${loc.keysDir}/ops.json`).mode & 0o777).toBe(0o600);
      expect(fs.statSync(loc.keysDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(loc.registryPath).mode & 0o777).toBe(0o600);
    }
    // The registry holds public keys only.
    const raw = fs.readFileSync(loc.registryPath, "utf8");
    expect(raw).not.toContain("PRIVATE KEY");
    const verified = verifyAgentRegistry(loc);
    expect(verified.ok).toBe(true);
    expect(verified.ok && verified.agents.get("ops")?.keyId).toBe(key.keyId);
    // Idempotent: the same key is not re-registered.
    expect(ensureAgentSigningKey("ops", { loc }).registered).toBe(false);
    expect(ensureAgentSigningKey("ops", { loc }).keyId).toBe(key.keyId);
  });

  it("rejects agent ids that are not path-safe", () => {
    const loc = tempAgentKeyLocations();
    expect(() => loadOrCreateAgentKey(loc, "../evil")).toThrow(/invalid agent id/);
  });

  it("a tampered registry does not verify", () => {
    const loc = tempAgentKeyLocations();
    ensureAgentSigningKey("ops", { loc });
    const other = loadOrCreateAgentKey(loc, "mallory");
    const registry = readAgentRegistry(loc.registryPath);
    if (!registry) {
      throw new Error("registry missing");
    }
    registry.agents[0] = { ...registry.agents[0], keyId: other.keyId, publicKey: other.publicKey };
    fs.writeFileSync(loc.registryPath, JSON.stringify(registry));
    expect(verifyAgentRegistry(loc)).toEqual({
      ok: false,
      reason: "agent key registry changed since it was signed",
    });
  });

  it("trusts only pinned owners once owners are pinned", () => {
    const loc = tempAgentKeyLocations();
    ensureAgentSigningKey("ops", { loc });
    expect(verifyAgentRegistry(loc).ok).toBe(true);
    // Pin a different owner: the registry signed by the local key is no longer trusted, and
    // the local key cannot re-sign it.
    const stranger = loadOrCreateAgentKey(loc, "stranger");
    addOwner(loc.ownersPath, { publicKey: stranger.publicKey, label: "remote owner" });
    expect(verifyAgentRegistry(loc)).toEqual({
      ok: false,
      reason: "agent key registry is not signed by a trusted owner",
    });
    expect(() => registerAgentKey(loc, loadOrCreateAgentKey(loc, "ops"))).toThrow(
      /not a pinned policy owner/,
    );
  });

  it("an unsigned or missing registry is not trusted", () => {
    const loc = tempAgentKeyLocations();
    expect(verifyAgentRegistry(loc)).toEqual({ ok: false, reason: "no agent key registry" });
    fs.mkdirSync(`${loc.home}/identity`, { recursive: true });
    fs.writeFileSync(loc.registryPath, JSON.stringify({ version: 1, agents: [] }));
    expect(verifyAgentRegistry(loc)).toEqual({
      ok: false,
      reason: "agent key registry is not signed",
    });
  });
});
