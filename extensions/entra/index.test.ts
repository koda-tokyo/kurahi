import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ConnectorRuntime } from "../../src/connectors/business/index.js";
import {
  jsonResponse,
  MemorySecretStore,
  mockFetch,
  noSleep,
  on,
  type Route,
} from "../../src/connectors/business/test-helpers.js";
import { createEntraTools, probeEntra, verifySignIn } from "./index.js";
import {
  buildClient,
  configProblems,
  createSsoValidator,
  readSettings,
  requestedScopes,
} from "./src/config.js";

const TENANT = "11111111-2222-3333-4444-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const G = "https://graph.microsoft.com/v1.0";
const LOGIN = `https://login.microsoftonline.com/${TENANT}`;
const key = generateKeyPairSync("rsa", { modulusLength: 2048 });

const discovery: Route[] = [
  on("GET", `${LOGIN}/v2.0/.well-known/openid-configuration`, () =>
    jsonResponse({ issuer: `${LOGIN}/v2.0`, jwks_uri: `${LOGIN}/discovery/v2.0/keys` }),
  ),
  on("GET", `${LOGIN}/discovery/v2.0/keys`, () => {
    const j = key.publicKey.export({ format: "jwk" }) as { n: string; e: string };
    return jsonResponse({ keys: [{ kty: "RSA", use: "sig", kid: "k1", n: j.n, e: j.e }] });
  }),
];

function idToken(claims: Record<string, unknown>) {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: "k1" });
  const body = enc(claims);
  return `${head}.${body}.${sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key.privateKey).toString("base64url")}`;
}

function setup(config: Record<string, unknown>, routes: Route[]) {
  const settings = readSettings({ tenantId: TENANT, clientId: CLIENT_ID, ...config });
  const client = buildClient(settings)!;
  const secrets = new MemorySecretStore();
  const fetch = mockFetch(routes);
  const runtime = new ConnectorRuntime(
    { id: "entra", client },
    { secrets: () => secrets, fetch, sleep: noSleep },
  );
  runtime.tokens.save({
    accessToken: "at",
    expiresAt: Date.now() + 3_600_000,
    scopes: client.scopes,
    tokenType: "Bearer",
    obtainedAt: 0,
  });
  const tools = createEntraTools(settings, runtime, { agentId: "main" });
  const tool = (name: string) => (params: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.execute("c", params) as Promise<{
      content: Array<{ text: string }>;
    }>;
  return { settings, runtime, fetch, tools, tool };
}

describe("entra configuration", () => {
  it("signs in with OIDC scopes; directory read is opt-in and least privilege", () => {
    const base = { tenantId: TENANT, clientId: CLIENT_ID };
    expect(requestedScopes(readSettings(base))).toEqual([
      "openid",
      "profile",
      "email",
      "offline_access",
      "User.Read",
    ]);
    expect(requestedScopes(readSettings({ ...base, directory: "basic" }))).toContain(
      "User.ReadBasic.All",
    );
    expect(requestedScopes(readSettings({ ...base, directory: "full" }))).toContain(
      "Directory.Read.All",
    );
    expect(configProblems(readSettings({ ...base, tenantId: "organizations" }))).toContain(
      'allowedTenants is required when tenantId is "organizations"',
    );
    expect(configProblems(readSettings({ ...base, allowedTenants: ["contoso"] }))).toContain(
      "allowedTenants must contain tenant GUIDs",
    );
  });

  it("registers directory tools per level", () => {
    expect(setup({}, []).tools).toEqual([]);
    expect(setup({ directory: "basic" }, []).tools.map((t) => t.name)).toEqual([
      "entra_users_search",
      "entra_user_get",
    ]);
    expect(setup({ directory: "full" }, []).tools.map((t) => t.name)).toEqual([
      "entra_users_search",
      "entra_user_get",
      "entra_groups_search",
      "entra_group_members",
      "entra_user_groups",
    ]);
  });
});

describe("directory lookup", () => {
  it("searches users with an escaped OData filter and basic properties only", async () => {
    const { tool, fetch } = setup({ directory: "basic" }, [
      on("GET", `${G}/users?`, () =>
        jsonResponse({
          value: [{ id: "u1", displayName: "O'Brien Aiko", mail: "aiko@contoso.example" }],
        }),
      ),
    ]);
    const res = await tool("entra_users_search")({ query: "O'Brien" });
    const url = new URL(fetch.calls[0].url);
    expect(url.searchParams.get("$filter")).toBe(
      "startswith(displayName,'O''Brien') or startswith(mail,'O''Brien') or startswith(userPrincipalName,'O''Brien')",
    );
    expect(url.searchParams.get("$select")).toBe("id,displayName,mail,userPrincipalName");
    expect(res.content[0].text).toContain("O'Brien Aiko");
  });

  it("looks up a user by UPN and refuses path tricks", async () => {
    const { tool, fetch } = setup({ directory: "basic" }, [
      on("GET", `${G}/users/aiko%40contoso.example?`, () =>
        jsonResponse({ id: "u1", displayName: "Aiko" }),
      ),
    ]);
    expect(
      (await tool("entra_user_get")({ id: "aiko@contoso.example" })).content[0].text,
    ).toContain("Aiko");
    expect((await tool("entra_user_get")({ id: "../groups" })).content[0].text).toMatch(
      /^Error: bad_request/,
    );
    expect(fetch.calls).toHaveLength(1);
  });

  it("lists a user's groups (full) and drops non-group directory objects", async () => {
    const { tool } = setup({ directory: "full" }, [
      on("GET", `${G}/users/u1/memberOf`, () =>
        jsonResponse({
          value: [
            {
              id: "g1",
              displayName: "Finance",
              securityEnabled: true,
              "@odata.type": "#microsoft.graph.group",
            },
            {
              id: "r1",
              displayName: "Global Reader",
              "@odata.type": "#microsoft.graph.directoryRole",
            },
          ],
        }),
      ),
    ]);
    const text = (await tool("entra_user_groups")({ userId: "u1" })).content[0].text;
    expect(text).toContain("Finance (security)");
    expect(text).not.toContain("Global Reader");
  });
});

describe("sign-in validation", () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: `${LOGIN}/v2.0`,
    aud: CLIENT_ID,
    sub: "s1",
    tid: TENANT,
    oid: "o1",
    nonce: "n-1",
    iat: now - 10,
    exp: now + 3600,
  };
  const token = (id: string) => ({
    accessToken: "a",
    idToken: id,
    expiresAt: 0,
    scopes: [],
    tokenType: "Bearer",
    obtainedAt: 0,
  });

  it("accepts the sign-in only with a valid ID token and the expected nonce", async () => {
    const validator = createSsoValidator(readSettings({ tenantId: TENANT, clientId: CLIENT_ID }), {
      fetch: mockFetch(discovery),
    });
    await expect(verifySignIn(validator, token(idToken(claims)), "n-1")).resolves.toMatchObject({
      tid: TENANT,
    });
    await expect(verifySignIn(validator, token(idToken(claims)), "other")).rejects.toMatchObject({
      code: "forbidden",
    });
    await expect(
      verifySignIn(
        validator,
        token(idToken({ ...claims, aud: "ffffffff-ffff-ffff-ffff-ffffffffffff" })),
        "n-1",
      ),
    ).rejects.toThrow(/wrong_audience/);
    await expect(
      verifySignIn(validator, { ...token(""), idToken: undefined }, undefined),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("probes the tenant keys and the stored sign-in", async () => {
    const ok = setup({}, [...discovery, on("GET", `${G}/me?`, () => jsonResponse({ id: "me" }))]);
    const v = createSsoValidator(ok.settings, { fetch: ok.fetch });
    await expect(probeEntra(ok.runtime, v)).resolves.toBeUndefined();

    const down = setup({}, [on("GET", LOGIN, () => jsonResponse({}, 503))]);
    const v2 = createSsoValidator(down.settings, { fetch: down.fetch, sleep: noSleep });
    await expect(probeEntra(down.runtime, v2)).rejects.toMatchObject({
      code: "provider_unavailable",
    });
  });
});
