import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveIdentitySettings } from "./config.js";
import { createScimHandler } from "./scim.js";
import { IdentityService } from "./service.js";
import { SessionStore } from "./sessions.js";
import { IdentityStore } from "./store.js";

const TOKEN = "scim-test-token-0123456789abcdef0123456789";

let server: Server;
let base = "";
let svc: IdentityService;

function start(over: Record<string, unknown> = {}) {
  svc = new IdentityService(
    resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      defaultRole: "member",
      providers: [
        {
          id: "corp",
          kind: "oidc",
          issuer: "https://idp.example.test",
          clientId: "kurahi",
          trustEmailForLinking: true,
        },
      ],
      scim: { enabled: true, token: TOKEN, rateLimitPerMinute: 1000 },
      ...over,
    }),
    {
      store: new IdentityStore({ filePath: null }),
      sessions: new SessionStore({ filePath: null }),
    },
  );
  const scim = createScimHandler({ service: () => svc });
  server = createServer((req, res) => {
    if (!scim.authorize(req)) {
      res.statusCode = 401;
      res.end();
      return;
    }
    void scim.handle(req, res);
  });
  return new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/scim/v2`;
      resolve();
    }),
  );
}

async function call(method: string, path: string, body?: unknown, token = TOKEN) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/scim+json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return {
    status: res.status,
    body: text ? (JSON.parse(text) as Record<string, unknown>) : null,
    headers: res.headers,
  };
}

const user = (userName: string, extra: Record<string, unknown> = {}) => ({
  schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
  userName,
  externalId: `ext-${userName}`,
  name: { givenName: "Alice", familyName: "Example" },
  emails: [{ value: userName, type: "work", primary: true }],
  active: true,
  ...extra,
});

beforeEach(async () => {
  await start();
});
afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("SCIM 2.0 Users", () => {
  it("requires the bearer token", async () => {
    expect((await call("GET", "/Users", undefined, "wrong")).status).toBe(401);
  });

  it("creates, reads, filters and paginates", async () => {
    const created = await call("POST", "/Users", user("alice@example.com"));
    expect(created.status).toBe(201);
    expect(created.headers.get("content-type")).toContain("application/scim+json");
    const id = created.body?.id as string;
    expect(created.headers.get("location")).toBe(
      `https://gateway.example.test/scim/v2/Users/${id}`,
    );
    expect((await call("POST", "/Users", user("ALICE@example.com"))).status).toBe(409);
    for (const n of ["b", "c", "d"]) {
      await call("POST", "/Users", user(`${n}@example.com`));
    }
    const filtered = await call(
      "GET",
      `/Users?filter=${encodeURIComponent('userName eq "alice@example.com"')}`,
    );
    expect(filtered.body).toMatchObject({ totalResults: 1, startIndex: 1, itemsPerPage: 1 });
    const page = await call("GET", "/Users?startIndex=2&count=2");
    expect(page.body).toMatchObject({ totalResults: 4, startIndex: 2, itemsPerPage: 2 });
    const byExt = await call(
      "GET",
      `/Users?filter=${encodeURIComponent('externalId eq "ext-b@example.com"')}`,
    );
    expect(byExt.body?.totalResults).toBe(1);
    expect((await call("GET", `/Users?filter=${encodeURIComponent('emails co "x"')}`)).status).toBe(
      400,
    );
    expect((await call("GET", `/Users/${id}`)).body).toMatchObject({
      userName: "alice@example.com",
      active: true,
    });
  });

  it("patches Entra-style (Replace, string booleans) and Okta-style (no path) operations", async () => {
    const id = (await call("POST", "/Users", user("alice@example.com"))).body?.id as string;
    const entra = await call("PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [
        { op: "Replace", path: "displayName", value: "Alice E." },
        { op: "Replace", path: "name.familyName", value: "Example-Smith" },
        {
          op: "Add",
          path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
          value: "Sales",
        },
      ],
    });
    expect(entra.status).toBe(200);
    expect(entra.body).toMatchObject({
      displayName: "Alice E.",
      name: { familyName: "Example-Smith" },
    });
    const okta = await call("PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", value: { active: false } }],
    });
    expect(okta.body?.active).toBe(false);
  });

  it("deactivation and deletion end the person's SSO sessions immediately", async () => {
    const id = (await call("POST", "/Users", user("alice@example.com"))).body?.id as string;
    const signed = svc.signIn({
      providerId: "corp",
      protocol: "oidc",
      issuer: "https://idp.example.test",
      subject: "s1",
      email: "alice@example.com",
      emailVerified: true,
      displayName: null,
      givenName: null,
      familyName: null,
      groups: [],
      idTokenHint: null,
    });
    if (!signed.ok) {
      throw new Error("sign-in failed");
    }
    expect(signed.principal.personId).toBe(id);
    let closed = false;
    svc.sessions.onRevoked(signed.principal.sessionId, () => {
      closed = true;
    });
    const res = await call("PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    expect(res.body?.active).toBe(false);
    expect(closed).toBe(true);
    expect(svc.verifyToken(signed.token).ok).toBe(false);

    await call("PATCH", `/Users/${id}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "replace", path: "active", value: true }],
    });
    const again = svc.signIn({
      providerId: "corp",
      protocol: "oidc" as const,
      issuer: "https://idp.example.test",
      subject: "s1",
      email: "alice@example.com",
      emailVerified: true,
      displayName: null,
      givenName: null,
      familyName: null,
      groups: [],
      idTokenHint: null,
    });
    expect(again.ok).toBe(true);
    expect((await call("DELETE", `/Users/${id}`)).status).toBe(204);
    expect(again.ok && svc.verifyToken(again.token).ok).toBe(false);
    expect((await call("GET", `/Users/${id}`)).status).toBe(404);
  });
});

describe("SCIM deprovisioning fails closed", () => {
  const PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
  const signInAlice = (subject = "s1") =>
    svc.signIn({
      providerId: "corp",
      protocol: "oidc",
      issuer: "https://idp.example.test",
      subject,
      email: "alice@example.com",
      emailVerified: true,
      displayName: null,
      givenName: null,
      familyName: null,
      groups: [],
      idTokenHint: null,
    });

  it("a URN-prefixed active path deprovisions; unknown paths and ops are 400", async () => {
    const id = (await call("POST", "/Users", user("alice@example.com"))).body?.id as string;
    const signed = signInAlice();
    expect(signed.ok).toBe(true);
    const urn = await call("PATCH", `/Users/${id}`, {
      schemas: [PATCH],
      Operations: [
        { op: "replace", path: "urn:ietf:params:scim:schemas:core:2.0:User:active", value: false },
      ],
    });
    expect(urn.status).toBe(200);
    expect(urn.body?.active).toBe(false);
    expect(signed.ok && svc.verifyToken(signed.token).ok).toBe(false);
    // No-path value with URN keys, and the enterprise extension (accepted, ignored).
    const noPath = await call("PATCH", `/Users/${id}`, {
      schemas: [PATCH],
      Operations: [
        { op: "replace", value: { "urn:ietf:params:scim:schemas:core:2.0:User:active": true } },
        {
          op: "add",
          path: "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:department",
          value: "Finance",
        },
        { op: "replace", path: 'phoneNumbers[type eq "work"].value', value: "000" },
      ],
    });
    expect(noPath.status).toBe(200);
    expect(noPath.body?.active).toBe(true);
    for (const op of [
      { op: "replace", path: "activ", value: false },
      { op: "replace", path: "urn:ietf:params:scim:schemas:core:2.0:User:enabled", value: false },
      { op: "replace", value: { disabled: true } },
      { op: "remove", path: "active" },
      { op: "remove", path: "bogus" },
      { op: "move", path: "active", value: false },
    ]) {
      const res = await call("PATCH", `/Users/${id}`, { schemas: [PATCH], Operations: [op] });
      expect(res.status, JSON.stringify(op)).toBe(400);
    }
    expect(svc.store.getPerson(id)?.active).toBe(true);
    const g = (await call("POST", "/Groups", { displayName: "G" })).body?.id as string;
    const bad = await call("PATCH", `/Groups/${g}`, {
      schemas: [PATCH],
      Operations: [{ op: "add", path: "owners", value: [{ value: id }] }],
    });
    expect(bad.status).toBe(400);
    const urnGroup = await call("PATCH", `/Groups/${g}`, {
      schemas: [PATCH],
      Operations: [
        {
          op: "add",
          path: "urn:ietf:params:scim:schemas:core:2.0:Group:members",
          value: [{ value: id }],
        },
      ],
    });
    expect(urnGroup.status).toBe(200);
    expect(svc.store.getGroup(g)?.members).toEqual([id]);
  });

  it("a PUT without active keeps the current state (never reactivates)", async () => {
    const id = (await call("POST", "/Users", user("alice@example.com", { active: false }))).body
      ?.id as string;
    const { active: _drop, ...withoutActive } = user("alice@example.com", { displayName: "A" });
    const put = await call("PUT", `/Users/${id}`, withoutActive);
    expect(put.status).toBe(200);
    expect(put.body?.active).toBe(false);
    expect(signInAlice()).toEqual({ ok: false, reason: "inactive" });
  });

  it("requireProvisioned defaults to true with SCIM on", async () => {
    expect(svc.settings.requireProvisioned).toBe(true);
    expect(signInAlice()).toEqual({ ok: false, reason: "not_provisioned" });
    expect(
      resolveIdentitySettings({
        scim: { enabled: true, token: TOKEN },
        requireProvisioned: false,
      }).requireProvisioned,
    ).toBe(false);
    expect(resolveIdentitySettings({}).requireProvisioned).toBe(false);
  });

  it("delete removes assignments and leaves a tombstone that blocks JIT re-creation", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ requireProvisioned: false, defaultRole: "member" });
    const id = (await call("POST", "/Users", user("alice@example.com"))).body?.id as string;
    svc.store.assign(`person:${id}`, "approver", null, "test");
    svc.store.assign("email:alice@example.com", "org-admin", null, "test");
    expect(signInAlice().ok).toBe(true);
    expect((await call("DELETE", `/Users/${id}`)).status).toBe(204);
    expect(svc.store.listAssignments()).toEqual([]);
    // The IdP still signs alice in: she is not re-created just in time.
    expect(signInAlice()).toEqual({ ok: false, reason: "deprovisioned" });
    expect(signInAlice("another-subject")).toEqual({ ok: false, reason: "deprovisioned" });
    const [t] = svc.store.listTombstones();
    expect(t).toMatchObject({ personId: id, userName: "alice@example.com", deletedBy: "scim" });
    // An admin restore lifts it (a new person, with no old grants).
    svc.store.restoreTombstone(t.id);
    const back = signInAlice();
    expect(back.ok && back.principal.personId).not.toBe(id);
    expect(back.ok && back.principal.roles.map((r) => r.role)).toEqual(["member"]);
  });

  it("tombstones are evicted only while sign-in requires provisioning", () => {
    const store = new IdentityStore({ filePath: null, maxTombstones: 1 });
    const a = store.createPerson({ userName: "a@example.com", source: "scim" });
    const b = store.createPerson({ userName: "b@example.com", source: "scim" });
    store.deletePerson(a.id, { tombstone: "scim" });
    // Full and JIT sign-in allowed: refused before anything changes.
    expect(() => store.deletePerson(b.id, { tombstone: "scim" })).toThrow(
      /tombstone store is full/,
    );
    expect(store.getPerson(b.id)).not.toBeNull();
    expect(store.listTombstones()).toHaveLength(1);
    // With requireProvisioned the oldest may go: an evicted person still cannot sign in.
    store.deletePerson(b.id, { tombstone: "scim", evictOldestTombstone: true });
    expect(store.listTombstones().map((t) => t.userName)).toEqual(["b@example.com"]);
  });

  it("a SCIM DELETE with the tombstone store full and JIT allowed deactivates instead", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ requireProvisioned: false });
    const full = new IdentityStore({ filePath: null, maxTombstones: 0 });
    (svc as unknown as { store: IdentityStore }).store = full;
    const id = (await call("POST", "/Users", user("dave@example.com"))).body?.id as string;
    expect((await call("DELETE", `/Users/${id}`)).status).toBe(204);
    expect(full.getPerson(id)?.active).toBe(false);
  });

  it("requireProvisioned defaults to true whenever SCIM is enabled, even without its token", () => {
    expect(resolveIdentitySettings({ scim: { enabled: true } }).requireProvisioned).toBe(true);
  });

  it("SCIM provisioning the user again clears the tombstone", async () => {
    const id = (await call("POST", "/Users", user("alice@example.com"))).body?.id as string;
    await call("DELETE", `/Users/${id}`);
    expect(svc.store.listTombstones()).toHaveLength(1);
    const again = (await call("POST", "/Users", user("alice@example.com"))).body?.id as string;
    expect(svc.store.listTombstones()).toHaveLength(0);
    const r = signInAlice();
    expect(r.ok && r.principal.personId).toBe(again);
  });
});

describe("SCIM 2.0 Groups", () => {
  it("creates groups, adds and removes members, filters by displayName", async () => {
    const a = (await call("POST", "/Users", user("alice@example.com"))).body?.id as string;
    const b = (await call("POST", "/Users", user("bob@example.com"))).body?.id as string;
    const g = await call("POST", "/Groups", {
      displayName: "Finance",
      externalId: "g-fin",
      members: [{ value: a }],
    });
    expect(g.status).toBe(201);
    const gid = g.body?.id as string;
    await call("PATCH", `/Groups/${gid}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "Add", path: "members", value: [{ value: b }] }],
    });
    let read = await call("GET", `/Groups/${gid}`);
    expect(
      ((read.body?.members ?? []) as Array<{ value: string }>).map((m) => m.value).toSorted(),
    ).toEqual([a, b].toSorted());
    await call("PATCH", `/Groups/${gid}`, {
      schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      Operations: [{ op: "Remove", path: `members[value eq "${a}"]` }],
    });
    read = await call("GET", `/Groups/${gid}?excludedAttributes=members`);
    expect(read.body?.members).toBeUndefined();
    expect(svc.store.getGroup(gid)?.members).toEqual([b]);
    // Group values feed role mappings and Project access, scoped and immutable (no names).
    expect(svc.store.groupValuesOf(b).toSorted()).toEqual([`scim:${gid}`, "scim:g-fin"].toSorted());
    const list = await call(
      "GET",
      `/Groups?filter=${encodeURIComponent('displayName eq "finance"')}`,
    );
    expect(list.body?.totalResults).toBe(1);
    expect((await call("DELETE", `/Groups/${gid}`)).status).toBe(204);
  });

  it("attribute names are case-insensitive: Active: false in a PUT deactivates", async () => {
    const created = await call("POST", "/Users", {
      Schemas: ["urn:ietf:params:scim:schemas:core:2.0:User"],
      UserName: "carol@example.com",
      ExternalId: "ext-carol",
      Name: { GivenName: "Carol" },
      Emails: [{ Value: "carol@example.com", Primary: true }],
    });
    expect(created.status).toBe(201);
    const id = created.body?.id as string;
    const p = svc.store.getPerson(id);
    expect(p).toMatchObject({
      userName: "carol@example.com",
      externalId: "ext-carol",
      givenName: "Carol",
      email: "carol@example.com",
      active: true,
    });
    const put = await call("PUT", `/Users/${id}`, {
      userName: "carol@example.com",
      externalId: "ext-carol",
      ACTIVE: false,
    });
    expect(put.status).toBe(200);
    expect(svc.store.getPerson(id)?.active).toBe(false);
    // A PatchOp with differently cased message and operation attributes applies too.
    const patch = await call("PATCH", `/Users/${id}`, {
      SCHEMAS: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
      operations: [{ OP: "replace", Path: "displayName", Value: "Carol E." }],
    });
    expect(patch.status).toBe(200);
    expect(svc.store.getPerson(id)?.displayName).toBe("Carol E.");
    // The same attribute twice in different case is ambiguous.
    expect(
      (
        await call("PUT", `/Users/${id}`, {
          userName: "carol@example.com",
          active: true,
          Active: false,
        })
      ).status,
    ).toBe(400);
    const g = await call("POST", "/Groups", { DisplayName: "Ops", Members: [{ Value: id }] });
    expect(g.status).toBe(201);
    expect(svc.store.getGroup(g.body?.id as string)?.members).toEqual([id]);
  });

  it("a malformed member removal is a 400, never a silent no-op", async () => {
    const a = (await call("POST", "/Users", user("alice@example.com"))).body?.id as string;
    const g = await call("POST", "/Groups", { displayName: "Finance", members: [{ value: a }] });
    const gid = g.body?.id as string;
    for (const value of [[{ id: a }], [{ value: 42 }], "not-a-member-list", []]) {
      const res = await call("PATCH", `/Groups/${gid}`, {
        schemas: ["urn:ietf:params:scim:api:messages:2.0:PatchOp"],
        Operations: [{ op: "remove", path: "members", value }],
      });
      expect(res.status, JSON.stringify(value)).toBe(400);
    }
    expect(svc.store.getGroup(gid)?.members).toEqual([a]);
  });

  it("answers discovery and rate-limits", async () => {
    expect((await call("GET", "/ServiceProviderConfig")).body).toMatchObject({
      patch: { supported: true },
    });
    expect((await call("GET", "/ResourceTypes")).body?.totalResults).toBe(2);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await start({ scim: { enabled: true, token: TOKEN, rateLimitPerMinute: 2 } });
    expect((await call("GET", "/Users")).status).toBe(200);
    expect((await call("GET", "/Users")).status).toBe(200);
    expect((await call("GET", "/Users")).status).toBe(429);
  });
});
