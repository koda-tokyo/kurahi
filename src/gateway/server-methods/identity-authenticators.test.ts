import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GatewayClient } from "./types.js";
import { AuthenticatorStore } from "../../identity/authenticators.js";
import { resolveIdentitySettings } from "../../identity/config.js";
import { IdentityService, setIdentityServiceForTest } from "../../identity/service.js";
import { SessionStore } from "../../identity/sessions.js";
import { IdentityStore } from "../../identity/store.js";
import { TestAuthenticator } from "../../identity/webauthn/test-authenticator.js";
import { resolveMethodSchemaNames } from "../protocol/json-schema.js";
import { wsMethodMinScope } from "../scopes.js";
import { BASE_GATEWAY_METHODS } from "../server-methods-list.js";
import { handleGatewayRequest } from "../server-methods.js";

const ORIGIN = "https://gateway.example.test";
let svc: IdentityService;

beforeEach(() => {
  const key = randomBytes(32);
  svc = new IdentityService(
    resolveIdentitySettings({ publicUrl: ORIGIN, passkeys: { enabled: true } }),
    {
      store: new IdentityStore({ filePath: null }),
      sessions: new SessionStore({ filePath: null }),
      authenticators: new AuthenticatorStore({ filePath: null, dataKey: () => key }),
    },
  );
  setIdentityServiceForTest(svc);
});
afterEach(() => setIdentityServiceForTest(null));

function client(scopes: string[], person?: unknown): GatewayClient {
  return {
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "kolo-control-ui", version: "1", platform: "test", mode: "webchat" },
      role: "operator",
      scopes,
    },
    ...(person ? { person } : {}),
  } as unknown as GatewayClient;
}
const owner = () => client(["operator.admin"]);

async function call(c: GatewayClient, method: string, params: Record<string, unknown> = {}) {
  let out:
    // oxlint-disable-next-line typescript/no-explicit-any
    | { ok: boolean; payload?: any; error?: { message: string; details?: { code?: string } } }
    | undefined;
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params },
    client: c,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      out = { ok, payload, error: error as never };
    },
    context: { broadcast: () => {} } as never,
  });
  return out!;
}

/** Create a person, give a role, enrol a passkey through the issued code, sign in. */
async function personWithPasskey(role: "org-admin" | "member") {
  const created = await call(owner(), "identity.persons.create", {
    userName: `${role}-${randomBytes(3).toString("hex")}@example.com`,
    displayName: role,
  });
  expect(created.ok).toBe(true);
  const personId = created.payload.person.id as string;
  const enroll = await call(owner(), "identity.authenticators.enroll", { personId });
  const a = new TestAuthenticator();
  const begin = svc.passkeys.beginRegistration({
    source: "t",
    enrollmentCode: enroll.payload.code,
  });
  svc.passkeys.finishRegistration({
    ceremonyId: begin.ceremonyId,
    credential: a.register(begin.publicKey, ORIGIN),
  });
  svc.store.assign(`person:${personId}`, role, null, "test");
  const login = svc.passkeys.beginSignIn({ source: "t" });
  const signed = svc.passkeys.finishSignIn({
    ceremonyId: login.ceremonyId,
    credential: a.assert(login.publicKey, ORIGIN),
  });
  return { personId, principal: signed.principal, enroll };
}

describe("identity.authenticators.* and identity.persons.create", () => {
  it("are typed core methods with the expected scopes", () => {
    for (const m of [
      "identity.persons.create",
      "identity.authenticators.enroll",
      "identity.authenticators.list",
      "identity.authenticators.remove",
    ]) {
      expect(BASE_GATEWAY_METHODS).toContain(m);
    }
    expect(wsMethodMinScope("identity.authenticators.list")).toBe("observe");
    expect(wsMethodMinScope("identity.authenticators.enroll")).toBe("admin");
    expect(resolveMethodSchemaNames("identity.authenticators.enroll")).toEqual({
      params: "IdentityAuthenticatorsEnrollParams",
      result: "IdentityAuthenticatorsEnrollResult",
    });
    expect(resolveMethodSchemaNames("identity.persons.create").result).toBe("IdentityAdminResult");
  });

  it("a bootstrap owner creates a person and issues a one-time enrollment link", async () => {
    const { personId, enroll, principal } = await personWithPasskey("member");
    expect(enroll.payload.link).toBe(`${ORIGIN}/#kurahi_enroll=${enroll.payload.code}`);
    expect(enroll.payload.enrollment.personId).toBe(personId);
    expect(principal.providerId).toBe("passkey");
    expect(svc.store.getPerson(personId)?.source).toBe("admin");
    // The admin-typed e-mail is not trusted.
    expect(svc.store.getPerson(personId)?.emailVerifiedBy).toBeNull();
    const list = await call(owner(), "identity.authenticators.list", { personId });
    expect(list.ok).toBe(true);
    const [entry] = list.payload.persons;
    expect(entry.passkeys).toHaveLength(1);
    expect(entry.enrollments[0]).toMatchObject({ state: "used", usedFor: "passkey" });
    expect(JSON.stringify(list.payload)).not.toContain("publicKey");
  });

  it("only org-admins issue codes; members cannot list or remove", async () => {
    // The member first: once an org-admin exists the owner is no longer a bootstrap admin.
    const member = await personWithPasskey("member");
    const admin = await personWithPasskey("org-admin");
    const adminClient = client(["operator.identity"], admin.principal);
    const memberClient = client(["operator.identity"], member.principal);
    const newcomer = (
      await call(adminClient, "identity.persons.create", { userName: "new@example.com" })
    ).payload.person.id as string;
    expect((await call(owner(), "identity.authenticators.enroll", { personId: newcomer })).ok).toBe(
      false,
    );
    // A person who already has a passkey adds devices themselves: no admin code for them.
    const impersonate = await call(adminClient, "identity.authenticators.enroll", {
      personId: member.personId,
    });
    expect(impersonate.error?.details?.code).toBe("has_authenticators");
    expect(impersonate.error?.message).toMatch(/only for a first authenticator/);
    const issued = await call(adminClient, "identity.authenticators.enroll", {
      personId: newcomer,
      ttlMinutes: 15,
    });
    expect(issued.ok).toBe(true);
    const refused = await call(memberClient, "identity.authenticators.enroll", {
      personId: member.personId,
    });
    // Refused before the handler (a member's session has no admin scope).
    expect(refused.ok).toBe(false);
    expect((await call(memberClient, "identity.authenticators.list")).error?.details?.code).toBe(
      "role_required",
    );

    // Revoke the open code; remove the passkey (a lost laptop).
    const rev = await call(adminClient, "identity.authenticators.remove", {
      personId: newcomer,
      enrollmentId: issued.payload.enrollment.id,
    });
    expect(rev.ok).toBe(true);
    expect(
      svc.authenticators.stateOf(svc.authenticators.getEnrollment(issued.payload.enrollment.id)!),
    ).toBe("revoked");
    const [cred] = svc.authenticators.listPasskeys(member.personId);
    expect(
      (
        await call(adminClient, "identity.authenticators.remove", {
          personId: admin.personId,
          passkeyId: cred.id,
        })
      ).error?.details?.code,
    ).toBe("not_found");
    expect(
      (
        await call(adminClient, "identity.authenticators.remove", {
          personId: member.personId,
          passkeyId: cred.id,
          totp: true,
        })
      ).error?.details?.code,
    ).toBe("invalid");
    const removed = await call(adminClient, "identity.authenticators.remove", {
      personId: member.personId,
      passkeyId: cred.id,
    });
    expect(removed.ok).toBe(true);
    expect(svc.authenticators.listPasskeys(member.personId)).toHaveLength(0);
  });

  it("refuses an enrollment code for a deactivated person, and duplicate user names", async () => {
    const created = await call(owner(), "identity.persons.create", { userName: "ken@example.com" });
    const personId = created.payload.person.id as string;
    expect(
      (await call(owner(), "identity.persons.create", { userName: "KEN@example.com" })).ok,
    ).toBe(false);
    svc.store.updatePerson(personId, { active: false });
    const r = await call(owner(), "identity.authenticators.enroll", { personId });
    expect(r.error?.details?.code).toBe("person_inactive");
  });
});
