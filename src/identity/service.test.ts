import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkQueuePolicy } from "../workitems/policy.js";
import type { SignInClaims } from "./types.js";
import { isStageApprover, parseAccess, setPrincipalGroupResolver } from "../workitems/access.js";
import { resolveIdentitySettings } from "./config.js";
import { legacyScopesForPerson, projectGroupsFor, scopeForRoles } from "./rbac.js";
import { IdentityService } from "./service.js";
import { SessionStore } from "./sessions.js";
import { IdentityStore } from "./store.js";

const claims = (over: Partial<SignInClaims> = {}): SignInClaims => ({
  providerId: "corp",
  protocol: "oidc",
  issuer: "https://idp.example.test",
  subject: "sub-1",
  email: "alice@example.com",
  emailVerified: true,
  displayName: "Alice",
  givenName: null,
  familyName: null,
  groups: ["g-finance"],
  idTokenHint: "id.token.hint",
  ...over,
});

function service(over: Record<string, unknown> = {}, now?: () => number) {
  const settings = resolveIdentitySettings({
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
    ...over,
  });
  return new IdentityService(settings, {
    store: new IdentityStore({ filePath: null }),
    sessions: new SessionStore({ filePath: null, now }),
  });
}

afterEach(() => setPrincipalGroupResolver(null));

describe("roles → scopes", () => {
  it("takes the highest role's scope; approvals only for approval roles", () => {
    expect(scopeForRoles(["viewer"])).toBe("observe");
    expect(scopeForRoles(["viewer", "member"])).toBe("attach");
    // Identity admin roles are attach for the gateway; their admin power is the area scopes.
    expect(scopeForRoles(["auditor", "org-admin"])).toBe("attach");
    expect(scopeForRoles([])).toBeNull();
    expect(legacyScopesForPerson({ scope: "attach", approvals: false })).toEqual([
      "operator.read",
      "operator.write",
    ]);
    expect(legacyScopesForPerson({ scope: "attach", approvals: true })).toContain(
      "operator.approvals",
    );
    expect(legacyScopesForPerson({ scope: "observe", approvals: false })).toEqual([
      "operator.read",
    ]);
    expect(
      legacyScopesForPerson({ scope: "attach", approvals: true, adminAreas: ["identity"] }),
    ).toEqual(["operator.read", "operator.write", "operator.approvals", "operator.identity"]);
    expect(
      legacyScopesForPerson({
        scope: "attach",
        approvals: true,
        adminAreas: ["sessions", "pairing", "policy"],
      }),
    ).toEqual([
      "operator.read",
      "operator.write",
      "operator.approvals",
      "operator.identity",
      "operator.pairing",
      "operator.policy",
    ]);
  });
});

describe("sign-in → person", () => {
  it("refuses a person with no role, admits one with a mapped IdP group", () => {
    const svc = service();
    expect(svc.signIn(claims())).toEqual({ ok: false, reason: "no_role" });
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["approver"], units: [] },
      "test",
    );
    const r = svc.signIn(claims());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.principal.scope).toBe("attach");
      expect(r.principal.approvals).toBe(true);
      expect(r.principal.principal).toMatch(/^person:[0-9a-f-]{36}$/);
      expect(r.token).toMatch(/^kss_/);
    }
  });

  it("uses the default role when configured, and e-mail pre-assignments", () => {
    const svc = service({ defaultRole: "viewer" });
    const r = svc.signIn(claims({ groups: [] }));
    expect(r.ok && r.principal.scope).toBe("observe");
    svc.store.assign("email:bob@example.com", "org-admin", null, "test");
    const bob = svc.signIn(claims({ subject: "sub-2", email: "bob@example.com", groups: [] }));
    expect(bob.ok && bob.principal.adminAreas).toEqual(["identity", "sessions"]);
  });

  it("links a SCIM-provisioned person by e-mail; requireProvisioned refuses others", () => {
    const svc = service({ requireProvisioned: true, defaultRole: "member" });
    expect(svc.signIn(claims())).toEqual({ ok: false, reason: "not_provisioned" });
    const p = svc.store.createPerson({ userName: "alice@example.com", source: "scim" });
    const r = svc.signIn(claims());
    expect(r.ok && r.principal.personId).toBe(p.id);
    // A different subject of the same provider cannot take the linked person over.
    expect(svc.signIn(claims({ subject: "attacker" }))).toEqual({
      ok: false,
      reason: "link_conflict",
    });
  });

  it("refuses a cross-provider takeover by e-mail; an admin link is the only way", () => {
    const svc = service({
      defaultRole: "member",
      providers: [
        { id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" },
        {
          id: "social",
          kind: "oidc",
          issuer: "https://social.example.test",
          clientId: "k",
          trustEmailForLinking: true,
        },
      ],
    });
    const victim = svc.signIn(claims());
    if (!victim.ok) {
      throw new Error("sign-in failed");
    }
    // Another provider asserting the same (verified, trusted) e-mail does not attach.
    const attacker = claims({
      providerId: "social",
      issuer: "https://social.example.test",
      subject: "attacker",
    });
    expect(svc.signIn(attacker)).toEqual({ ok: false, reason: "link_conflict" });
    expect(svc.store.getPerson(victim.principal.personId)?.links).toHaveLength(1);
    // An admin link approves the second identity explicitly.
    svc.store.addLink(victim.principal.personId, {
      providerId: "social",
      issuer: "https://social.example.test",
      subject: "attacker",
    });
    const linked = svc.signIn(attacker);
    expect(linked.ok && linked.principal.personId).toBe(victim.principal.personId);
  });

  it("refuses unverified or untrusted e-mail for linking and for email: assignments", () => {
    const svc = service({
      providers: [
        { id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" },
        {
          id: "trusted",
          kind: "oidc",
          issuer: "https://trusted.example.test",
          clientId: "k",
          trustEmailForLinking: true,
        },
      ],
    });
    const scim = svc.store.createPerson({
      userName: "alice@example.com",
      email: "alice@example.com",
      emailVerifiedBy: "scim",
      source: "scim",
    });
    svc.store.assign("email:alice@example.com", "org-admin", null, "test");
    svc.store.assign("email:mallory@example.com", "org-admin", null, "test");
    // Verified but the provider is not trusted for linking: refused.
    expect(svc.signIn(claims())).toEqual({ ok: false, reason: "link_conflict" });
    // Trusted provider but unverified e-mail: refused.
    const trusted = { providerId: "trusted", issuer: "https://trusted.example.test" };
    expect(svc.signIn(claims({ ...trusted, emailVerified: false }))).toEqual({
      ok: false,
      reason: "link_conflict",
    });
    // Trusted and verified: links onto the provisioned person.
    const ok = svc.signIn(claims({ ...trusted, subject: "alice-t" }));
    expect(ok.ok && ok.principal.personId).toBe(scim.id);
    expect(ok.ok && ok.principal.adminAreas).toContain("identity");
    // A new person from an untrusted provider never matches an email: assignment.
    const mallory = svc.signIn(claims({ subject: "m", email: "mallory@example.com", groups: [] }));
    expect(mallory).toEqual({ ok: false, reason: "no_role" });
  });

  it("links a SCIM person by externalId = subject without trusting e-mail", () => {
    const svc = service({
      defaultRole: "member",
      providers: [{ id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" }],
    });
    const p = svc.store.createPerson({
      userName: "alice@example.com",
      externalId: "sub-1",
      source: "scim",
    });
    const r = svc.signIn(claims({ email: null, emailVerified: false }));
    expect(r.ok && r.principal.personId).toBe(p.id);
    // Already linked: another provider presenting the same subject does not attach.
    const other = svc.signIn(
      claims({ providerId: "other", issuer: "https://other.example.test", email: null }),
    );
    expect(other.ok && other.principal.personId).not.toBe(p.id);
  });

  it("matches a SCIM externalId only for the provider the directory belongs to", () => {
    const providers = [
      { id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" },
      { id: "lab", kind: "oidc", issuer: "https://lab.example.test", clientId: "k" },
    ];
    const fromLab = claims({
      providerId: "lab",
      issuer: "https://lab.example.test",
      email: null,
      emailVerified: false,
    });
    // Unset with several providers: nobody claims an unlinked SCIM person by externalId.
    const unset = service({ defaultRole: "member", providers });
    const p1 = unset.store.createPerson({ userName: "a", externalId: "sub-1", source: "scim" });
    const r1 = unset.signIn(fromLab);
    expect(r1.ok && r1.principal.personId).not.toBe(p1.id);
    expect(unset.store.findByExternalId("sub-1")?.links).toEqual([]);
    // Scoped to corp: lab presenting the same subject does not attach; corp does.
    const scoped = service({
      defaultRole: "member",
      providers,
      scim: { providerId: "corp" },
    });
    const p2 = scoped.store.createPerson({ userName: "a", externalId: "sub-1", source: "scim" });
    const r2 = scoped.signIn(fromLab);
    expect(r2.ok && r2.principal.personId).not.toBe(p2.id);
    const r3 = scoped.signIn(claims({ email: null, emailVerified: false }));
    expect(r3.ok && r3.principal.personId).toBe(p2.id);
  });

  it("refuses a deactivated person and revokes their sessions on deactivation", () => {
    const svc = service({ defaultRole: "member" });
    const r = svc.signIn(claims());
    if (!r.ok) {
      throw new Error("sign-in failed");
    }
    let closed = 0;
    svc.sessions.onRevoked(r.principal.sessionId, () => {
      closed += 1;
    });
    svc.store.updatePerson(r.principal.personId, { active: false });
    expect(svc.revokePersonSessions(r.principal.personId, "scim_deactivated", "scim")).toBe(1);
    expect(closed).toBe(1);
    expect(svc.verifyToken(r.token).ok).toBe(false);
    expect(svc.signIn(claims())).toEqual({ ok: false, reason: "inactive" });
  });

  it("re-resolves roles on every check: revoking a mapping drops the person", () => {
    const svc = service();
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["member"], units: [] },
      "test",
    );
    const r = svc.signIn(claims());
    if (!r.ok) {
      throw new Error("sign-in failed");
    }
    expect(svc.principalForSession(r.principal.sessionId).ok).toBe(true);
    svc.store.removeMapping("corp", "g-finance");
    expect(svc.principalForSession(r.principal.sessionId)).toEqual({
      ok: false,
      reason: "no_role",
    });
  });
});

describe("group mappings are scoped by source and immutable id", () => {
  const twoProviders = () =>
    service({
      providers: [
        { id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" },
        { id: "other", kind: "oidc", issuer: "https://other.example.test", clientId: "k" },
      ],
    });
  const other = (over: Partial<SignInClaims> = {}) =>
    claims({ providerId: "other", issuer: "https://other.example.test", subject: "o-1", ...over });

  it("a group value asserted by one provider never satisfies another provider's mapping", () => {
    const svc = twoProviders();
    svc.store.setMapping(
      { source: "corp", group: "admins", roles: ["org-admin"], units: [] },
      "test",
    );
    svc.store.setMapping({ source: "other", group: "staff", roles: ["viewer"], units: [] }, "t");
    // `other` asserts the corp admin group name: no admin grant, only its own mapping.
    const r = svc.signIn(other({ email: null, emailVerified: false, groups: ["admins", "staff"] }));
    expect(r.ok && r.principal.roles.map((g) => g.role)).toEqual(["viewer"]);
    expect(r.ok && r.principal.groups.toSorted()).toEqual(["other:admins", "other:staff"]);
    const corp = svc.signIn(claims({ groups: ["admins"] }));
    expect(corp.ok && corp.principal.roles).toEqual([
      { role: "org-admin", unit: null, via: "group:corp:admins" },
    ]);
  });

  it("SCIM mappings match the group id or externalId; display names only by opt-in", () => {
    const svc = twoProviders();
    const p = svc.store.createPerson({ userName: "alice@example.com", source: "scim" });
    const g = svc.store.createGroup({
      displayName: "Admins",
      externalId: "ext-1",
      members: [p.id],
    });
    const roles = () => svc.projectGroupsForPrincipal(`person:${p.id}`);
    svc.store.setMapping({ source: "scim", group: "Admins", roles: ["org-admin"], units: [] }, "t");
    expect(roles()).toBeNull(); // no role: the display name alone does not match
    svc.store.setMapping({ source: "scim", group: g.id, roles: ["member"], units: [] }, "t");
    expect(roles()).toEqual(expect.arrayContaining(["role:member", `group:scim:${g.id}`]));
    expect(roles()).not.toContain("role:org-admin");
    svc.store.setMapping({ source: "scim", group: "ext-1", roles: ["viewer"], units: [] }, "t");
    expect(roles()).toContain("role:viewer");
    svc.store.setMapping(
      { source: "scim", group: "Admins", roles: ["auditor"], units: [], matchDisplayName: true },
      "t",
    );
    expect(roles()).toContain("role:auditor");
    // A provider claim equal to the SCIM group id does not satisfy the SCIM mapping.
    const q = svc.signIn(otherClaims(g.id));
    expect(q).toEqual({ ok: false, reason: "no_role" });
    expect(() =>
      svc.store.setMapping(
        { source: "corp", group: "x", roles: ["viewer"], units: [], matchDisplayName: true },
        "t",
      ),
    ).toThrow(/SCIM groups only/);
  });

  it("unscoped mappings from an older directory match nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-directory-"));
    const file = path.join(dir, "directory.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        org: { name: null },
        persons: [],
        groups: [],
        units: [],
        assignments: [],
        mappings: [
          { group: "g-finance", roles: ["org-admin"], units: [], updatedAt: "x", updatedBy: "x" },
        ],
      }),
    );
    const store = new IdentityStore({ filePath: file });
    expect(store.listMappings()).toEqual([
      expect.objectContaining({ source: "legacy", group: "g-finance", matchDisplayName: false }),
    ]);
    const svc = new IdentityService(
      resolveIdentitySettings({
        publicUrl: "https://gateway.example.test",
        providers: [
          { id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" },
        ],
      }),
      { store, sessions: new SessionStore({ filePath: null }) },
    );
    expect(svc.signIn(claims())).toEqual({ ok: false, reason: "no_role" });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function otherClaims(group: string): SignInClaims {
  return claims({
    providerId: "other",
    issuer: "https://other.example.test",
    subject: "o-2",
    email: null,
    emailVerified: false,
    groups: [group],
  });
}

describe("a provider removed from the config", () => {
  it("ends its sessions and its asserted groups stop counting", () => {
    const svc = service({ defaultRole: "viewer" });
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["approver"], units: [] },
      "test",
    );
    const r = svc.signIn(claims());
    if (!r.ok) {
      throw new Error(r.reason);
    }
    expect(r.principal.approvals).toBe(true);
    expect(svc.projectGroupsForPrincipal(r.principal.principal)).toContain("group:corp:g-finance");
    svc.updateSettings(
      resolveIdentitySettings({
        publicUrl: "https://gateway.example.test",
        defaultRole: "viewer",
        providers: [
          { id: "other", kind: "oidc", issuer: "https://other.example.test", clientId: "k" },
        ],
      }),
    );
    expect(svc.verifyToken(r.token)).toEqual({ ok: false, reason: "provider_removed" });
    // Revoked, not just refused: the session stays ended if the provider comes back.
    expect(svc.sessions.get(r.principal.sessionId)?.revokedAt).not.toBeNull();
    // The groups corp asserted no longer map to roles or Project groups.
    const groups = svc.projectGroupsForPrincipal(r.principal.principal) ?? [];
    expect(groups).not.toContain("group:corp:g-finance");
    expect(groups).not.toContain("role:approver");
  });
});

describe("sessions", () => {
  it("ends at the idle timeout and at the absolute lifetime", () => {
    let t = 1_000_000;
    const store = new SessionStore({ filePath: null, now: () => t });
    const a = store.create({
      personId: "p",
      providerId: "x",
      protocol: "oidc",
      lifetimeMs: 60_000,
      idleMs: 10_000,
    });
    t += 9_000;
    expect(store.verify(a.token, { touch: true }).ok).toBe(true);
    t += 9_000;
    expect(store.verify(a.token, { touch: true }).ok).toBe(true);
    t += 11_000;
    expect(store.verify(a.token)).toEqual({ ok: false, reason: "idle" });
    const b = store.create({
      personId: "p",
      providerId: "x",
      protocol: "oidc",
      lifetimeMs: 20_000,
      idleMs: 60_000,
    });
    t += 21_000;
    expect(store.verify(b.token)).toEqual({ ok: false, reason: "expired" });
    const c = store.create({
      personId: "p",
      providerId: "x",
      protocol: "saml",
      lifetimeMs: 60_000,
      idleMs: 60_000,
      notAfterMs: t + 5_000,
    });
    expect(Date.parse(c.session.expiresAt)).toBe(t + 5_000);
  });

  it("keeps the OIDC ID token (logout hint) in memory only", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-sessions-"));
    const file = path.join(dir, "sessions.json");
    const s1 = new SessionStore({ filePath: file });
    const { token, session } = s1.create({
      personId: "p",
      providerId: "x",
      protocol: "oidc",
      lifetimeMs: 60_000,
      idleMs: 60_000,
      idTokenHint: "eyJhbGciOi.secret-id-token.sig",
    });
    expect(s1.get(session.id)?.idTokenHint).toBe("eyJhbGciOi.secret-id-token.sig");
    expect(fs.readFileSync(file, "utf8")).not.toContain("secret-id-token");
    const s2 = new SessionStore({ filePath: file });
    expect(s2.verify(token).ok).toBe(true);
    expect(s2.get(session.id)?.idTokenHint).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("persists hashes only and survives a restart", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-sessions-"));
    const file = path.join(dir, "sessions.json");
    const s1 = new SessionStore({ filePath: file });
    const { token } = s1.create({
      personId: "p",
      providerId: "x",
      protocol: "oidc",
      lifetimeMs: 60_000,
      idleMs: 60_000,
    });
    expect(fs.readFileSync(file, "utf8")).not.toContain(token);
    const s2 = new SessionStore({ filePath: file });
    expect(s2.verify(token).ok).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("org units and project access", () => {
  it("unit-scoped roles cover sub-units; membership goes up", () => {
    const svc = service();
    svc.store.upsertUnit({
      id: "sales",
      name: "Sales",
      kind: "department",
      department: "planning",
    });
    svc.store.upsertUnit({ id: "sales-east", name: "Sales East", kind: "team", parentId: "sales" });
    expect(() => svc.store.upsertUnit({ id: "orphan", name: "x", kind: "team" })).toThrow(/parent/);
    expect(() =>
      svc.store.upsertUnit({
        id: "sales",
        name: "Sales",
        kind: "department",
        parentId: "sales-east",
      }),
    ).toThrow(/cycle/);
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["department-manager"], units: ["sales"] },
      "test",
    );
    const r = svc.signIn(claims());
    if (!r.ok) {
      throw new Error("sign-in failed");
    }
    const groups = projectGroupsFor(r.principal);
    expect(groups).toEqual(
      expect.arrayContaining([
        "role:department-manager",
        "role:department-manager@sales",
        "role:department-manager@sales-east",
        "unit:sales",
        "group:corp:g-finance",
      ]),
    );
    expect(groups).not.toContain("unit:sales-east");
    expect(() => svc.store.removeUnit("sales")).toThrow(/child/);
  });

  it("an org approver role makes a person eligible only where the Project maps it", () => {
    const svc = service();
    svc.store.setMapping(
      { source: "corp", group: "g-finance", roles: ["approver"], units: [] },
      "test",
    );
    const r = svc.signIn(claims());
    if (!r.ok) {
      throw new Error("sign-in failed");
    }
    setPrincipalGroupResolver((principal) => svc.projectGroupsForPrincipal(principal));
    const stage = {
      approvers: {
        any: false,
        roles: ["approver"],
        principals: [],
        departmentField: null,
        department: null,
      },
    };
    const policy = (access: unknown) =>
      ({ access: parseAccess(access) }) as unknown as WorkQueuePolicy;
    // Project maps the org role to its approver role: eligible.
    expect(
      isStageApprover(
        stage,
        r.principal.principal,
        policy({ groups: { "role:approver": { roles: ["approver"] } } }),
        "p1",
      ),
    ).toBe(true);
    // Project lists other members only: the org role alone grants nothing.
    expect(
      isStageApprover(
        stage,
        r.principal.principal,
        policy({ members: [{ principal: "device:abc", roles: ["approver"] }] }),
        "p1",
      ),
    ).toBe(false);
    // The stage still decides: a department stage needs the department too.
    const deptStage = {
      approvers: { ...stage.approvers, departmentField: "department", department: "sales" },
    };
    expect(
      isStageApprover(
        deptStage,
        r.principal.principal,
        policy({ groups: { "role:approver": { roles: ["approver"] } } }),
        "p1",
      ),
    ).toBe(false);
  });
});
