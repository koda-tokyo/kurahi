import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OrgRole, PersonPrincipal } from "../../identity/types.js";
import type { GatewayClient } from "./types.js";
import { resolveIdentitySettings } from "../../identity/config.js";
import { IdentityService, setIdentityServiceForTest } from "../../identity/service.js";
import { SessionStore } from "../../identity/sessions.js";
import { IdentityStore } from "../../identity/store.js";
import { resolveMethodSchemaNames } from "../protocol/json-schema.js";
import { wsMethodMinScope } from "../scopes.js";
import { BASE_GATEWAY_METHODS } from "../server-methods-list.js";
import { handleGatewayRequest } from "../server-methods.js";

let svc: IdentityService;

beforeEach(() => {
  svc = new IdentityService(
    resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      providers: [
        {
          id: "corp",
          kind: "oidc",
          issuer: "https://idp.example.test",
          clientId: "kurahi",
          trustEmailForLinking: true,
        },
      ],
    }),
    {
      store: new IdentityStore({ filePath: null }),
      sessions: new SessionStore({ filePath: null }),
    },
  );
  setIdentityServiceForTest(svc);
});
afterEach(() => setIdentityServiceForTest(null));

let n = 0;
function signInAs(
  role: OrgRole,
  unit: string | null = null,
): { principal: PersonPrincipal; token: string } {
  n += 1;
  const email = `user${n}@example.com`;
  svc.store.assign(`email:${email}`, role, unit, "test");
  const r = svc.signIn({
    providerId: "corp",
    protocol: "oidc",
    issuer: "https://idp.example.test",
    subject: `sub-${n}`,
    email,
    emailVerified: true,
    displayName: `User ${n}`,
    givenName: null,
    familyName: null,
    groups: [],
    idTokenHint: null,
  });
  if (!r.ok) {
    throw new Error(`sign-in refused: ${r.reason}`);
  }
  return r;
}

function personClient(p: PersonPrincipal, mode = "webchat", id = "kolo-control-ui"): GatewayClient {
  return {
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id, version: "1", platform: "test", mode },
      role: "operator",
      scopes: [],
    },
    person: p,
  } as unknown as GatewayClient;
}

function ownerClient(extra: Partial<GatewayClient> = {}): GatewayClient {
  return {
    connect: {
      minProtocol: 3,
      maxProtocol: 3,
      client: { id: "kolo-control-ui", version: "1", platform: "test", mode: "webchat" },
      role: "operator",
      scopes: ["operator.admin"],
    },
    ...extra,
  } as unknown as GatewayClient;
}

async function call(client: GatewayClient, method: string, params: Record<string, unknown> = {}) {
  let out:
    | { ok: boolean; payload?: unknown; error?: { message: string; details?: { code?: string } } }
    | undefined;
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params },
    client,
    isWebchatConnect: () => false,
    respond: (ok, payload, error) => {
      out = { ok, payload, error: error as never };
    },
    context: { broadcast: () => {} } as never,
  });
  return out!;
}

describe("identity methods", () => {
  it("are typed core methods with the expected scopes", () => {
    for (const m of [
      "identity.whoami",
      "identity.org.get",
      "identity.roles.assign",
      "identity.sessions.revoke",
    ]) {
      expect(BASE_GATEWAY_METHODS).toContain(m);
    }
    expect(wsMethodMinScope("identity.whoami")).toBe("observe");
    expect(wsMethodMinScope("identity.roles.assign")).toBe("admin");
    expect(resolveMethodSchemaNames("identity.whoami")).toEqual({
      params: "IdentityWhoamiParams",
      result: "IdentityWhoamiResult",
    });
    expect(resolveMethodSchemaNames("identity.roles.assign").result).toBe("IdentityAdminResult");
  });

  it("whoami shows the person, roles and session", async () => {
    const { principal } = signInAs("approver");
    const res = await call(personClient(principal), "identity.whoami");
    expect(res.ok).toBe(true);
    expect(res.payload).toMatchObject({
      kind: "person",
      principal: principal.principal,
      scope: "attach",
      approvals: true,
      roles: [{ role: "approver" }],
    });
    expect((await call(ownerClient(), "identity.whoami")).payload).toMatchObject({
      kind: "owner",
      scope: "owner",
    });
  });

  it("an org-admin manages units, roles and group mappings with evidence", async () => {
    const { principal } = signInAs("org-admin");
    const admin = personClient(principal);
    const unit = await call(admin, "identity.units.upsert", {
      id: "finance",
      name: "Finance",
      kind: "department",
      department: "finance",
    });
    expect(unit.ok).toBe(true);
    expect((unit.payload as { evidence: { root: string } | null }).evidence?.root).toMatch(
      /^[0-9a-f]{64}$/,
    );
    const assigned = await call(admin, "identity.roles.assign", {
      subject: "email:bob@example.com",
      role: "approver",
      unit: "finance",
    });
    expect(assigned.ok).toBe(true);
    const mapped = await call(admin, "identity.groupMappings.set", {
      source: "corp",
      group: "g-auditors",
      roles: ["auditor"],
    });
    expect(mapped.ok).toBe(true);
    // The source must be scim or a configured provider; display-name matching is SCIM only.
    expect(
      (
        await call(admin, "identity.groupMappings.set", {
          source: "nope",
          group: "g",
          roles: ["viewer"],
        })
      ).error?.details?.code,
    ).toBe("invalid");
    expect(
      (
        await call(admin, "identity.groupMappings.set", {
          source: "corp",
          group: "g",
          roles: ["viewer"],
          matchDisplayName: true,
        })
      ).error?.details?.code,
    ).toBe("invalid");
    const org = await call(admin, "identity.org.get");
    expect(org.payload).toMatchObject({
      units: [{ id: "finance" }],
      mappings: [{ source: "corp", group: "g-auditors", matchDisplayName: false }],
    });
    expect(
      (
        await call(admin, "identity.units.upsert", {
          id: "x",
          name: "X",
          kind: "department",
          department: "nope",
        })
      ).error?.details?.code,
    ).toBe("invalid");
  });

  it("an org-admin links an identity explicitly (the approval for a second provider)", async () => {
    const admin = personClient(signInAs("org-admin").principal);
    const target = signInAs("member").principal;
    const linked = await call(admin, "identity.persons.link", {
      personId: target.personId,
      providerId: "corp",
      subject: "second-subject",
    });
    expect(linked.ok).toBe(true);
    expect(svc.store.findByLink("corp", "https://idp.example.test", "second-subject")?.id).toBe(
      target.personId,
    );
    // An identity linked to someone else is not moved.
    const other = signInAs("member").principal;
    const moved = await call(admin, "identity.persons.link", {
      personId: other.personId,
      providerId: "corp",
      subject: "second-subject",
    });
    expect(moved.error?.details?.code).toBe("conflict");
    expect(
      (
        await call(admin, "identity.persons.link", {
          personId: target.personId,
          providerId: "nope",
          subject: "x",
        })
      ).error?.details?.code,
    ).toBe("not_found");
    // Unlinking ends the sessions opened through that provider.
    const unlinked = await call(admin, "identity.persons.unlink", {
      personId: other.personId,
      providerId: "corp",
    });
    expect((unlinked.payload as { revoked: number }).revoked).toBe(1);
    expect(svc.store.getPerson(other.personId)?.links).toEqual([]);
  });

  it("with SSO configured, the owner token is not a person, whatever the client declares", async () => {
    const cli = ownerClient({ authMethod: "token" });
    (cli.connect.client as { id: string; mode: string }).id = "cli";
    (cli.connect.client as { id: string; mode: string }).mode = "cli";
    for (const [method, params] of [
      ["workitems.decide", { projectId: "p", id: "w", decision: "approve" }],
      ["autopilot.stopAll", { reason: "test" }],
      ["autopilot.approvals.create", { projectId: "p", routineId: "r" }],
    ] as const) {
      const res = await call(cli, method, params);
      expect(res.ok, method).toBe(false);
      expect(res.error?.details?.code ?? res.error?.message, method).toMatch(/not_a_person/);
    }
    // A break-glass login (reason given and audited at connect) counts as a person for admin
    // and recovery (pause, the global stop), but the highest-impact decisions need SSO.
    const glass = ownerClient({ authMethod: "token", breakGlass: true });
    const res = await call(glass, "workitems.decide", {
      projectId: "p",
      id: "w",
      decision: "approve",
    });
    expect(res.error?.details?.code).toBe("not_a_person");
    expect(res.error?.message).toContain("needs an SSO sign-in");
    const pause = await call(glass, "autopilot.pause", { projectId: "p", routineId: "r" });
    expect(pause.error?.details?.code).not.toBe("not_a_person");
    // The owner remains the bootstrap identity admin (an authority, not personhood).
    expect((await call(cli, "identity.org.update", { name: "Example" })).ok).toBe(true);
  });

  it("identity admin roles never get operator.admin: no config, skills, cron or updates", async () => {
    const { principal } = signInAs("org-admin");
    const admin = personClient(principal);
    for (const [method, params] of [
      ["config.set", { raw: "{}" }],
      ["config.get", {}],
      ["skills.install", { name: "x", installId: "y" }],
      ["cron.add", { name: "x" }],
      ["cron.remove", { id: "x" }],
      ["update.run", {}],
      ["sessions.delete", { key: "main" }],
      ["exec.approvals.set", {}],
      ["device.pair.approve", { requestId: "r" }],
      ["policy.kill", { all: true, reason: "x" }],
    ] as const) {
      const res = await call(admin, method, params);
      expect(res.ok, method).toBe(false);
      expect(res.error?.message, method).toContain("missing scope");
    }
    expect(admin.connect.scopes).not.toContain("operator.admin");
    // … but identity administration works.
    expect((await call(admin, "identity.org.update", { name: "Example KK" })).ok).toBe(true);
    expect(
      (await call(admin, "identity.sessions.revoke", { personId: principal.personId })).ok,
    ).toBe(true);
  });

  it("security-admin: sessions, pairing and the kill switch only", async () => {
    const victim = signInAs("member");
    const sec = personClient(signInAs("security-admin").principal);
    expect(
      (await call(sec, "identity.sessions.revoke", { personId: victim.principal.personId })).ok,
    ).toBe(true);
    // Passes the gate to the handler (which may still refuse on its own terms).
    const pair = await call(sec, "device.pair.list", {});
    expect(pair.error?.message ?? "").not.toContain("missing scope");
    const kill = await call(sec, "policy.kill", { all: true, reason: "drill" });
    expect(kill.error?.message ?? "").not.toContain("missing scope");
    if (kill.ok) {
      await call(sec, "policy.release", { all: true, reason: "drill" });
    }
    for (const method of ["config.get", "cron.add", "identity.units.upsert"]) {
      expect((await call(sec, method, {})).error?.message, method).toContain("missing scope");
    }
  });

  it("host-level methods need operator.config, granted only by configRoles", async () => {
    const plain = personClient(signInAs("operator").principal);
    expect((await call(plain, "config.get", {})).error?.message).toContain("missing scope");
    svc.updateSettings({ ...svc.settings, configRoles: ["operator"] });
    const allowed = await call(plain, "config.get", {});
    expect(allowed.ok).toBe(true);
    expect(plain.connect.scopes).toContain("operator.config");
  });

  it("an org-admin restores a SCIM-deleted person (tombstone)", async () => {
    const admin = personClient(signInAs("org-admin").principal);
    const p = svc.store.createPerson({ userName: "gone@example.com", source: "scim" });
    const { tombstone } = svc.store.deletePerson(p.id, { tombstone: "scim" });
    const org = await call(admin, "identity.org.get");
    expect((org.payload as { tombstones: Array<{ id: string }> }).tombstones).toEqual([
      expect.objectContaining({ id: tombstone?.id, userName: "gone@example.com" }),
    ]);
    const res = await call(admin, "identity.persons.restore", { tombstoneId: tombstone?.id });
    expect(res.ok).toBe(true);
    expect(svc.store.listTombstones()).toEqual([]);
    const member = personClient(signInAs("member").principal);
    expect(
      (await call(member, "identity.persons.restore", { tombstoneId: tombstone?.id })).ok,
    ).toBe(false);
  });

  it("refuses non-admin roles, and directory detail is role-filtered", async () => {
    const { principal } = signInAs("department-manager");
    const res = await call(personClient(principal), "identity.roles.assign", {
      subject: "email:x@example.com",
      role: "viewer",
    });
    expect(res.ok).toBe(false);
    // department-manager has attach scope: the scope matrix refuses before the handler.
    expect(res.error?.message).toContain("missing scope: admin");
    const org = await call(personClient(principal), "identity.org.get");
    expect(org.ok).toBe(true);
    expect((org.payload as Record<string, unknown>).assignments).toBeUndefined();
    const sec = signInAs("security-admin");
    const denied = await call(personClient(sec.principal), "identity.roles.assign", {
      subject: "email:x@example.com",
      role: "viewer",
    });
    // security-admin holds sessions / pairing / policy, not identity: refused by the gate.
    expect(denied.error?.message).toContain("missing scope");
  });

  it("agents never administer identity, even carrying an org-admin session", async () => {
    const { principal } = signInAs("org-admin");
    const agent = personClient(principal, "backend", "gateway-client");
    const res = await call(agent, "identity.roles.assign", {
      subject: "email:x@example.com",
      role: "org-admin",
    });
    expect(res.error?.details?.code).toBe("not_a_person");
  });

  it("person-only methods still refuse agents with admin roles", async () => {
    const { principal } = signInAs("org-admin");
    const agent = personClient(principal, "backend", "gateway-client");
    const decide = await call(agent, "workitems.decide", {
      projectId: "p0000000000",
      id: "w1",
      decision: "approve",
    });
    expect(decide.ok).toBe(false);
    expect(decide.error?.details?.code).toBe("not_a_person");
    const stop = await call(agent, "autopilot.stopAll", { reason: "test" });
    expect(stop.ok).toBe(false);
    expect(stop.error?.details?.code).toBe("not_a_person");
  });

  it("the owner is a bootstrap admin only until an org-admin exists; then break-glass only", async () => {
    const first = await call(ownerClient(), "identity.roles.assign", {
      subject: "email:root@example.com",
      role: "org-admin",
    });
    expect(first.ok).toBe(true);
    const again = await call(ownerClient(), "identity.roles.assign", {
      subject: "email:x@example.com",
      role: "viewer",
    });
    expect(again.error?.details?.code).toBe("role_required");
    const glass = await call(ownerClient({ breakGlass: true }), "identity.roles.assign", {
      subject: "email:x@example.com",
      role: "viewer",
    });
    expect(glass.ok).toBe(true);
    // A pairing credential with admin scope is a device, not an admin.
    const paired = ownerClient({
      pairing: { kind: "pair", scope: "admin", fingerprint: "f".repeat(64) } as never,
    });
    expect(
      (await call(paired, "identity.units.upsert", { id: "u", name: "U", kind: "department" })).ok,
    ).toBe(false);
  });

  it("scopes follow roles on every request; revocation is immediate", async () => {
    const viewer = signInAs("viewer");
    const client = personClient(viewer.principal);
    const send = await call(client, "chat.send", {
      sessionKey: "main",
      message: "hi",
      idempotencyKey: "k",
    });
    expect(send.error?.message).toContain("missing scope: attach");
    // Role change applies on the next request, without a new sign-in.
    svc.store.assign(viewer.principal.principal as `person:${string}`, "org-admin", null, "test");
    const who = await call(client, "identity.whoami");
    expect(who.payload).toMatchObject({ scope: "attach", adminAreas: ["identity", "sessions"] });
    const sec = signInAs("security-admin");
    const revoked = await call(personClient(sec.principal), "identity.sessions.revoke", {
      personId: viewer.principal.personId,
    });
    expect(revoked.payload).toMatchObject({ ok: true, revoked: 1 });
    const after = await call(client, "identity.whoami");
    expect(after.ok).toBe(false);
    expect(after.error?.message).toContain("sign in again");
  });

  it("auditors list sessions but cannot revoke", async () => {
    const auditor = signInAs("auditor");
    const listed = await call(personClient(auditor.principal), "identity.sessions.list");
    expect(listed.ok).toBe(true);
    const revoke = await call(personClient(auditor.principal), "identity.sessions.revoke", {
      personId: auditor.principal.personId,
    });
    expect(revoke.error?.message).toContain("missing scope: admin");
  });
});
