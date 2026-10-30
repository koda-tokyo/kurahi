// Tests only: an IdentityService with built-in passkeys on (in-memory stores, injected TOTP
// data key) and a person who may sign in.
import { randomBytes } from "node:crypto";
import { AuthenticatorStore } from "./authenticators.js";
import { resolveIdentitySettings } from "./config.js";
import { IdentityService } from "./service.js";
import { SessionStore } from "./sessions.js";
import { IdentityStore } from "./store.js";
import { TestAuthenticator } from "./webauthn/test-authenticator.js";

export const ORIGIN = "https://kurahi.example.test";
export const RP_ID = "kurahi.example.test";

export function passkeyService(
  opts: {
    now?: () => number;
    userVerification?: "required" | "preferred";
    totp?: boolean;
    requireProvisioned?: boolean;
  } = {},
) {
  const nowFn = opts.now ?? Date.now;
  const store = new IdentityStore({ filePath: null, now: () => new Date(nowFn()) });
  const dataKey = randomBytes(32);
  const svc = new IdentityService(
    resolveIdentitySettings({
      publicUrl: ORIGIN,
      requireProvisioned: opts.requireProvisioned,
      passkeys: {
        enabled: true,
        userVerification: opts.userVerification,
        totp: opts.totp,
      },
    }),
    {
      store,
      sessions: new SessionStore({ filePath: null, now: nowFn }),
      authenticators: new AuthenticatorStore({
        filePath: null,
        now: () => new Date(nowFn()),
        dataKey: () => dataKey,
      }),
      now: nowFn,
    },
  );
  const person = store.createPerson({
    userName: "aiko@example.com",
    email: "aiko@example.com",
    displayName: "Aiko",
    source: "admin",
  });
  store.assign(`person:${person.id}`, "member", null, "test");
  return { svc, store, person };
}

/** A session of the person that authenticated just now (with these RFC 8176 methods). */
export function freshSession(
  svc: IdentityService,
  personId: string,
  methods: string[] = ["hwk", "user"],
): { sessionId: string; token: string } {
  const r = svc.signInPerson(personId, { at: new Date(0).toISOString(), methods, context: null });
  if (!r.ok) {
    throw new Error(r.reason);
  }
  // "Now" on the service's own clock (tests fake it): the session's creation time.
  const id = r.principal.sessionId;
  svc.sessions.refreshAuth(id, { at: svc.sessions.get(id)!.createdAt, methods, context: null });
  return { sessionId: id, token: r.token };
}

/**
 * Enrol a passkey for the person: through an admin enrollment code for a first authenticator,
 * else from a freshly authenticated session of the person (step-up `authenticatorChange`).
 */
export function enrolPasskey(svc: IdentityService, personId: string, a = new TestAuthenticator()) {
  const first =
    svc.authenticators.listPasskeys(personId).length === 0 && !svc.authenticators.hasTotp(personId);
  const begin = first
    ? svc.passkeys.beginRegistration({
        source: "t",
        enrollmentCode: svc.passkeys.issueEnrollment(personId, "person:admin").code,
      })
    : svc.passkeys.beginRegistration({
        source: "t",
        personId,
        sessionId: freshSession(svc, personId).sessionId,
      });
  svc.passkeys.finishRegistration({
    ceremonyId: begin.ceremonyId,
    credential: a.register(begin.publicKey, ORIGIN),
    label: "Laptop",
  });
  return a;
}
