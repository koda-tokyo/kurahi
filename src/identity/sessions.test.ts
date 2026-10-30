import { describe, expect, it } from "vitest";
import { SessionStore } from "./sessions.js";

describe("SSO session step-up", () => {
  it("refreshAuth records a fresh authentication only on a live session", () => {
    let t = Date.parse("2026-11-01T00:00:00Z");
    const store = new SessionStore({ filePath: null, now: () => t });
    const base = {
      personId: "p1",
      providerId: "corp",
      protocol: "oidc" as const,
      lifetimeMs: 3_600_000,
      idleMs: 600_000,
    };
    const { session } = store.create({
      ...base,
      auth: { at: new Date(t).toISOString(), methods: ["pwd"], context: null },
    });
    t += 60_000;
    const fresh = { at: new Date(t).toISOString(), methods: ["hwk", "user"], context: null };
    expect(store.refreshAuth(session.id, fresh)?.auth).toEqual(fresh);
    store.revoke(session.id, "test");
    expect(store.refreshAuth(session.id, fresh)).toBeNull();
    expect(store.refreshAuth("missing", fresh)).toBeNull();
  });
});
