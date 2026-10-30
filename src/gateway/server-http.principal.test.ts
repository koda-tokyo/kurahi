import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// L1: a shared-secret credential that verifies (here a Tailscale owner identity) but is then
// refused because SSO is required must not leave an "owner" principal on the request: the SSO
// session that the next authenticator admits is what the policy gate has to see.
const seen = vi.hoisted(() => ({ scopes: [] as string[] }));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => ({}) };
});
vi.mock("./auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./auth.js")>();
  return {
    ...actual,
    authorizeGatewayConnect: async () => ({ ok: true, method: "tailscale", user: "o@ts" }),
  };
});
vi.mock("../policy/engine.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../policy/engine.js")>();
  return {
    ...actual,
    getPolicyEngine: () => ({
      evaluate: (_kind: string, ctx: { scope?: string }) => {
        seen.scopes.push(String(ctx.scope));
        return { effect: "allow" };
      },
    }),
  };
});

const { createGatewayHttpServer } = await import("./server-http.js");
const { setIdentityServiceForTest, IdentityService } = await import("../identity/service.js");
const { resolveIdentitySettings } = await import("../identity/config.js");
const { SessionStore } = await import("../identity/sessions.js");
const { IdentityStore } = await import("../identity/store.js");

describe("HTTP principal after a refused shared secret", () => {
  const server = createGatewayHttpServer({
    canvasHost: null,
    controlUiEnabled: false,
    controlUiBasePath: "",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: { mode: "token", token: "unused-token-0000000000000000", allowTailscale: true },
  });
  let port = 0;
  let token = "";

  beforeAll(async () => {
    const svc = new IdentityService(
      resolveIdentitySettings({
        publicUrl: "https://gateway.example.test",
        defaultRole: "member",
        ssoRequired: true,
        providers: [
          { id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "kurahi" },
        ],
      }),
      {
        store: new IdentityStore({ filePath: null }),
        sessions: new SessionStore({ filePath: null }),
      },
    );
    setIdentityServiceForTest(svc);
    const r = svc.signIn({
      providerId: "corp",
      protocol: "oidc",
      issuer: "https://idp.example.test",
      subject: "s-1",
      email: "alice@example.com",
      emailVerified: true,
      displayName: "Alice",
      givenName: null,
      familyName: null,
      groups: [],
      idTokenHint: null,
      auth: { at: new Date().toISOString(), methods: ["pwd"], context: null },
    });
    if (!r.ok) {
      throw new Error(r.reason);
    }
    token = r.token;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    setIdentityServiceForTest(null);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("the policy gate sees the person's scope, never owner", async () => {
    seen.scopes = [];
    const res = await fetch(`http://127.0.0.1:${port}/api/jobs/job-x/evidence`, {
      headers: { authorization: `Bearer ${token}` },
    });
    // Admitted as the SSO person (the job does not exist).
    expect(res.status).toBe(404);
    expect(seen.scopes).toEqual(["attach"]);
  });
});
