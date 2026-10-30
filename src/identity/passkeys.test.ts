import { describe, expect, it } from "vitest";
import type { IdentityService } from "./service.js";
import { resolveIdentitySettings } from "./config.js";
import {
  enrolPasskey,
  freshSession,
  ORIGIN,
  passkeyService,
  RP_ID,
} from "./passkey-test-helpers.js";
import { PasskeyError, stepUpWithPasskey, TOTP_FAILURES_PER_SOURCE } from "./passkeys.js";
import { base32Decode, totp } from "./totp.js";
import { TestAuthenticator } from "./webauthn/test-authenticator.js";
import { FLAG_UP } from "./webauthn/verify.js";

const reason = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return err instanceof PasskeyError ? err.reason : String(err);
  }
  return "accepted";
};

function signIn(svc: IdentityService, a: TestAuthenticator, o = {}) {
  const begin = svc.passkeys.beginSignIn({ source: "t" });
  return svc.passkeys.finishSignIn({
    ceremonyId: begin.ceremonyId,
    credential: a.assert(begin.publicKey, ORIGIN, o),
  });
}

describe("passkey settings", () => {
  it("derive the RP id and origin from publicUrl and refuse mismatches", () => {
    const s = resolveIdentitySettings({ publicUrl: ORIGIN, passkeys: { enabled: true } });
    expect(s.passkeys).toMatchObject({
      enabled: true,
      rpId: RP_ID,
      origins: [ORIGIN],
      userVerification: "required",
      totp: true,
      rpName: "Kurahi",
    });
    // Passkeys alone count as configured identity (local persons off) and satisfy ssoRequired.
    expect(s.configured).toBe(true);
    expect(s.localPersons).toBe(false);
    const required = resolveIdentitySettings({
      publicUrl: ORIGIN,
      ssoRequired: true,
      passkeys: { enabled: true },
    });
    expect(required.problems).toEqual([]);
    // A parent-domain RP id covers subdomain origins; an unrelated origin is refused.
    expect(
      resolveIdentitySettings({
        publicUrl: ORIGIN,
        passkeys: { enabled: true, rpId: "example.test" },
      }).passkeys.enabled,
    ).toBe(true);
    const bad = resolveIdentitySettings({
      publicUrl: ORIGIN,
      passkeys: { enabled: true, allowedOrigins: ["https://evil.example"] },
    });
    expect(bad.passkeys.enabled).toBe(false);
    expect(bad.problems.join(" ")).toMatch(/not kurahi\.example\.test/);
    expect(resolveIdentitySettings({ passkeys: { enabled: true } }).passkeys.enabled).toBe(false);
    expect(
      resolveIdentitySettings({ publicUrl: "https://10.0.0.5", passkeys: { enabled: true } })
        .passkeys.enabled,
    ).toBe(false);
    expect(
      resolveIdentitySettings({ publicUrl: ORIGIN, passkeys: { enabled: true, totp: false } })
        .passkeys.totp,
    ).toBe(false);
  });
});

describe("PasskeyService", () => {
  it("enrols with an admin code and signs in usernameless with protocol passkey", () => {
    const { svc, person } = passkeyService();
    const a = enrolPasskey(svc, person.id);
    const [cred] = svc.authenticators.listPasskeys(person.id);
    expect(cred).toMatchObject({ label: "Laptop", personId: person.id, signCount: 0 });
    const out = signIn(svc, a);
    expect(out.principal.providerId).toBe("passkey");
    expect(out.principal.auth?.methods).toEqual(["hwk", "user"]);
    expect(svc.sessions.get(out.principal.sessionId)?.protocol).toBe("passkey");
    // The session stays valid on later checks (built-in provider counts as configured).
    expect(svc.verifyToken(out.token).ok).toBe(true);
    expect(svc.authenticators.getPasskey(cred.id)?.lastUsedAt).not.toBeNull();
  });

  it("an enrollment code works once, and a revoked or expired one not at all", () => {
    let now = Date.parse("2026-10-30T00:00:00Z");
    const { svc, person } = passkeyService({ now: () => now });
    const { code } = svc.passkeys.issueEnrollment(person.id, "person:admin");
    const spare = svc.passkeys.issueEnrollment(person.id, "person:admin");
    // Revoked between begin and finish.
    const second = svc.passkeys.issueEnrollment(person.id, "person:admin");
    const begin = svc.passkeys.beginRegistration({ source: "t", enrollmentCode: second.code });
    svc.authenticators.revokeEnrollment(second.enrollment.id);
    expect(
      reason(() =>
        svc.passkeys.finishRegistration({
          ceremonyId: begin.ceremonyId,
          credential: new TestAuthenticator().register(begin.publicKey, ORIGIN),
        }),
      ),
    ).toBe("enrollment_invalid");
    // Expired.
    const third = svc.passkeys.issueEnrollment(person.id, "person:admin", 5 * 60_000);
    now += 6 * 60_000;
    expect(
      reason(() => svc.passkeys.beginRegistration({ source: "t", enrollmentCode: third.code })),
    ).toBe("enrollment_invalid");
    enrolWith(code);
    // Used.
    expect(
      reason(() => svc.passkeys.beginRegistration({ source: "t", enrollmentCode: code })),
    ).toBe("enrollment_invalid");
    // An admin's code only sets up a first authenticator: a still-pending one stops working,
    // and no new one is issued once the person has a passkey.
    expect(
      reason(() => svc.passkeys.beginRegistration({ source: "t", enrollmentCode: spare.code })),
    ).toBe("has_authenticators");
    expect(reason(() => svc.passkeys.issueEnrollment(person.id, "person:admin"))).toBe(
      "has_authenticators",
    );
    // Unknown, or no code and no session.
    expect(
      reason(() => svc.passkeys.beginRegistration({ source: "t", enrollmentCode: "kpe_nope" })),
    ).toBe("enrollment_invalid");
    expect(reason(() => svc.passkeys.beginRegistration({ source: "t" }))).toBe("not_signed_in");
    expect(svc.authenticators.listPasskeys(person.id)).toHaveLength(1);

    function enrolWith(c: string) {
      const b = svc.passkeys.beginRegistration({ source: "t", enrollmentCode: c });
      svc.passkeys.finishRegistration({
        ceremonyId: b.ceremonyId,
        credential: new TestAuthenticator().register(b.publicKey, ORIGIN),
      });
    }
  });

  it("a signed-in person adds another passkey; existing ones are excluded", () => {
    const { svc, person } = passkeyService();
    const first = enrolPasskey(svc, person.id);
    const { sessionId } = freshSession(svc, person.id);
    const begin = svc.passkeys.beginRegistration({ source: "t", personId: person.id, sessionId });
    expect(begin.publicKey.excludeCredentials.map((c) => c.id)).toEqual([
      first.credentialId.toString("base64url"),
    ]);
    expect(begin.publicKey.authenticatorSelection.residentKey).toBe("required");
    svc.passkeys.finishRegistration({
      ceremonyId: begin.ceremonyId,
      credential: new TestAuthenticator("RS256").register(begin.publicKey, ORIGIN),
    });
    expect(svc.authenticators.listPasskeys(person.id)).toHaveLength(2);
    // The same authenticator cannot be registered twice.
    const again = svc.passkeys.beginRegistration({ source: "t", personId: person.id, sessionId });
    expect(
      reason(() =>
        svc.passkeys.finishRegistration({
          ceremonyId: again.ceremonyId,
          credential: first.register(again.publicKey, ORIGIN),
        }),
      ),
    ).toBe("already_registered");
  });

  it("refuses wrong origin, wrong RP id, a replayed challenge and missing UV", () => {
    const { svc, person } = passkeyService();
    const a = enrolPasskey(svc, person.id);
    expect(reason(() => signIn(svc, a, { origin: "https://evil.example" }))).toBe(
      "origin_mismatch",
    );
    expect(reason(() => signIn(svc, a, { rpId: "evil.example" }))).toBe("rp_id_mismatch");
    expect(reason(() => signIn(svc, a, { flags: FLAG_UP }))).toBe("user_not_verified");
    // A ceremony is spent by its first finish: the same assertion cannot be replayed.
    const begin = svc.passkeys.beginSignIn({ source: "t" });
    const assertion = a.assert(begin.publicKey, ORIGIN);
    svc.passkeys.finishSignIn({ ceremonyId: begin.ceremonyId, credential: assertion });
    expect(
      reason(() =>
        svc.passkeys.finishSignIn({ ceremonyId: begin.ceremonyId, credential: assertion }),
      ),
    ).toBe("ceremony_unknown");
    // An assertion for one challenge does not answer another ceremony.
    const other = svc.passkeys.beginSignIn({ source: "t" });
    const stale = svc.passkeys.beginSignIn({ source: "t" });
    expect(
      reason(() =>
        svc.passkeys.finishSignIn({
          ceremonyId: other.ceremonyId,
          credential: a.assert(stale.publicKey, ORIGIN),
        }),
      ),
    ).toBe("challenge_mismatch");
  });

  it("UV preferred lets a present-only authenticator in, without `user`", () => {
    const { svc, person } = passkeyService({ userVerification: "preferred" });
    const a = enrolPasskey(svc, person.id);
    const out = signIn(svc, a, { flags: FLAG_UP });
    expect(out.auth.methods).toEqual(["hwk"]);
  });

  it("detects a cloned authenticator by its signature counter", () => {
    const { svc, person } = passkeyService();
    const a = new TestAuthenticator("ES256", { signCount: 10 });
    enrolPasskey(svc, person.id, a);
    signIn(svc, a, { signCount: 11 });
    expect(reason(() => signIn(svc, a, { signCount: 11 }))).toBe("sign_count_regression");
    expect(reason(() => signIn(svc, a, { signCount: 3 }))).toBe("sign_count_regression");
    expect(svc.authenticators.listPasskeys(person.id)[0].signCount).toBe(11);
  });

  it("refuses unknown credentials and deactivated or deleted persons", () => {
    const { svc, store, person } = passkeyService();
    const a = enrolPasskey(svc, person.id);
    expect(reason(() => signIn(svc, new TestAuthenticator()))).toBe("unknown_credential");
    store.updatePerson(person.id, { active: false });
    expect(reason(() => signIn(svc, a))).toBe("inactive");
    // No new passkey for a deactivated person either.
    expect(reason(() => svc.passkeys.beginRegistration({ source: "t", personId: person.id }))).toBe(
      "person_inactive",
    );
    store.updatePerson(person.id, { active: true });
    store.deletePerson(person.id);
    expect(reason(() => signIn(svc, a))).toBe("unknown_credential");
  });

  it("requireProvisioned keeps admin-created persons out", () => {
    const { svc, person } = passkeyService({ requireProvisioned: true });
    const a = enrolPasskey(svc, person.id);
    expect(reason(() => signIn(svc, a))).toBe("not_provisioned");
  });

  it("step-up records a fresh passkey authentication on the session's own person only", () => {
    let now = Date.parse("2026-10-30T00:00:00Z");
    const { svc, store, person } = passkeyService({ now: () => now });
    const a = enrolPasskey(svc, person.id, new TestAuthenticator("EdDSA"));
    const out = signIn(svc, a);
    const sessionId = out.principal.sessionId;
    now += 10 * 60_000;
    const begin = svc.passkeys.beginStepUp({ source: "t", sessionId });
    expect(begin.publicKey.allowCredentials).toHaveLength(1);
    const res = stepUpWithPasskey(svc, {
      sessionId,
      ceremonyId: begin.ceremonyId,
      credential: a.assert(begin.publicKey, ORIGIN),
    });
    expect(res).toEqual({
      ok: true,
      auth: { at: new Date(now).toISOString(), methods: ["hwk", "user"], context: null },
    });
    expect(svc.sessions.get(sessionId)?.auth?.at).toBe(new Date(now).toISOString());
    // Another person's passkey never steps this session up.
    const other = store.createPerson({ userName: "ken@example.com", source: "admin" });
    store.assign(`person:${other.id}`, "member", null, "test");
    const b = enrolPasskey(svc, other.id);
    const again = svc.passkeys.beginStepUp({ source: "t", sessionId });
    expect(
      stepUpWithPasskey(svc, {
        sessionId,
        ceremonyId: again.ceremonyId,
        credential: b.assert(again.publicKey, ORIGIN),
      }),
    ).toEqual({ ok: false, reason: "wrong_person" });
    // A ceremony begun for one session does not step up another.
    const otherSession = signIn(svc, b).principal.sessionId;
    const mine = svc.passkeys.beginStepUp({ source: "t", sessionId });
    expect(
      stepUpWithPasskey(svc, {
        sessionId: otherSession,
        ceremonyId: mine.ceremonyId,
        credential: b.assert(mine.publicKey, ORIGIN),
      }),
    ).toEqual({ ok: false, reason: "session_ended" });
    // A revoked session cannot be stepped up.
    svc.sessions.revoke(sessionId, "test");
    expect(reason(() => svc.passkeys.beginStepUp({ source: "t", sessionId }))).toBe(
      "session_ended",
    );
  });

  it("bounds open ceremonies per source", () => {
    const { svc } = passkeyService();
    const first = svc.passkeys.beginSignIn({ source: "flood" });
    for (let i = 0; i < 25; i += 1) {
      svc.passkeys.beginSignIn({ source: "flood" });
    }
    // The flood replaced its own oldest ceremony; another source is unaffected.
    expect(
      reason(() => svc.passkeys.finishSignIn({ ceremonyId: first.ceremonyId, credential: {} })),
    ).toBe("ceremony_unknown");
  });
});

describe("one-time codes (TOTP)", () => {
  function enrolTotp(svc: IdentityService, personId: string, now: () => number) {
    const { code } = svc.passkeys.issueEnrollment(personId, "person:admin");
    const begin = svc.passkeys.beginTotpEnrollment({ source: "t", enrollmentCode: code });
    const secret = base32Decode(begin.secret) as Buffer;
    expect(
      reason(() =>
        svc.passkeys.finishTotpEnrollment({ ceremonyId: begin.ceremonyId, code: "000000" }),
      ),
    ).toBe("code_refused");
    svc.passkeys.finishTotpEnrollment({
      ceremonyId: begin.ceremonyId,
      code: totp(secret, now() / 1000),
    });
    return secret;
  }

  it("enrols, signs in once per step with amr otp, and stores the secret encrypted", () => {
    let now = Date.parse("2026-10-30T00:00:00Z");
    const { svc, person } = passkeyService({ now: () => now });
    const secret = enrolTotp(svc, person.id, () => now);
    expect(svc.authenticators.hasTotp(person.id)).toBe(true);
    // The confirming code is spent.
    expect(
      reason(() =>
        svc.passkeys.signInWithTotp({
          userName: "aiko@example.com",
          code: totp(secret, now / 1000),
        }),
      ),
    ).toBe("code_refused");
    now += 30_000;
    const code = totp(secret, now / 1000);
    const out = svc.passkeys.signInWithTotp({ userName: "AIKO@example.com", code });
    expect(out.auth.methods).toEqual(["otp"]);
    expect(out.principal.providerId).toBe("passkey");
    // Replay of the same code.
    expect(reason(() => svc.passkeys.signInWithTotp({ userName: "aiko@example.com", code }))).toBe(
      "code_refused",
    );
  });

  it("pauses a name after repeated wrong codes, known or not", () => {
    const now = Date.parse("2026-10-30T00:00:00Z");
    const { svc, person } = passkeyService({ now: () => now });
    const secret = enrolTotp(svc, person.id, () => now);
    for (let i = 0; i < 5; i += 1) {
      expect(
        reason(() => svc.passkeys.signInWithTotp({ userName: "aiko@example.com", code: "123456" })),
      ).toBe("code_refused");
      expect(
        reason(() => svc.passkeys.signInWithTotp({ userName: "nobody@example.com", code: "1" })),
      ).toBe("code_refused");
    }
    const good = totp(secret, now / 1000 + 30);
    expect(
      reason(() => svc.passkeys.signInWithTotp({ userName: "aiko@example.com", code: good })),
    ).toBe("locked");
    expect(
      reason(() => svc.passkeys.signInWithTotp({ userName: "nobody@example.com", code: "1" })),
    ).toBe("locked");
  });

  it("steps a session up with otp, and can be turned off", () => {
    let now = Date.parse("2026-10-30T00:00:00Z");
    const { svc, person } = passkeyService({ now: () => now });
    const secret = enrolTotp(svc, person.id, () => now);
    const a = enrolPasskey(svc, person.id);
    const sessionId = signIn(svc, a).principal.sessionId;
    now += 60_000;
    const auth = svc.passkeys.stepUpWithTotp({ sessionId, code: totp(secret, now / 1000) });
    expect(auth.methods).toEqual(["otp"]);
    expect(svc.sessions.get(sessionId)?.auth?.methods).toEqual(["otp"]);

    const off = passkeyService({ totp: false });
    expect(
      reason(() => off.svc.passkeys.signInWithTotp({ userName: "aiko@example.com", code: "1" })),
    ).toBe("totp_disabled");
  });

  it("wrong codes pause the name and the source, never passkey step-up", () => {
    let now = Date.parse("2026-10-30T00:00:00Z");
    const { svc, person } = passkeyService({ now: () => now });
    const secret = enrolTotp(svc, person.id, () => now);
    const a = enrolPasskey(svc, person.id);
    const sessionId = signIn(svc, a).principal.sessionId;
    now += 60_000;
    for (let i = 0; i < 5; i += 1) {
      reason(() =>
        svc.passkeys.signInWithTotp({ userName: "aiko@example.com", code: "000000", source: "a" }),
      );
    }
    expect(
      reason(() =>
        svc.passkeys.signInWithTotp({
          userName: "aiko@example.com",
          code: totp(secret, now / 1000),
          source: "b",
        }),
      ),
    ).toBe("locked");
    // A passkey still steps the session up while one-time codes pause for the name.
    const begin = svc.passkeys.beginStepUp({ source: "a", sessionId });
    expect(
      svc.passkeys.finishStepUp({
        ceremonyId: begin.ceremonyId,
        sessionId,
        credential: a.assert(begin.publicKey, ORIGIN),
      }).methods,
    ).toContain("hwk");
    // One address spraying many names pauses at TOTP_FAILURES_PER_SOURCE; others are unaffected.
    for (let i = 0; i < TOTP_FAILURES_PER_SOURCE; i += 1) {
      reason(() =>
        svc.passkeys.signInWithTotp({
          userName: `n${i}@example.com`,
          code: "000000",
          source: "sprayer",
        }),
      );
    }
    expect(
      reason(() =>
        svc.passkeys.signInWithTotp({ userName: "x@example.com", code: "1", source: "sprayer" }),
      ),
    ).toBe("locked");
    expect(
      reason(() =>
        svc.passkeys.signInWithTotp({ userName: "x@example.com", code: "1", source: "other" }),
      ),
    ).toBe("code_refused");
  });

  it("refuses a secret decrypted under another key or for another person", () => {
    const now = Date.parse("2026-10-30T00:00:00Z");
    const { svc, person } = passkeyService({ now: () => now });
    enrolTotp(svc, person.id, () => now);
    const raw = svc.authenticators as unknown as { totp: Map<string, { personId: string }> };
    const rec = raw.totp.get(person.id)!;
    raw.totp.set("someone-else", { ...rec, personId: "someone-else" });
    expect(() => svc.authenticators.readTotp("someone-else")).toThrow();
  });
});
