import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type ConnectorAuditSink, ConnectorRuntime } from "../../src/connectors/business/index.js";
import {
  jsonResponse,
  MemorySecretStore,
  mockFetch,
  noSleep,
  on,
  type Route,
} from "../../src/connectors/business/test-helpers.js";
import { createLineWorksToolsFor, probeLineWorks } from "./index.js";
import { mintAccessToken, serviceAccountCredential, signAssertion } from "./src/auth.js";
import {
  API_BASE,
  configProblems,
  readSettings,
  requestedScopes,
  SCOPES,
  TOKEN_URL,
} from "./src/config.js";

// Recorded LINE WORKS responses only; the key pair is generated for the test.
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const CONFIG = {
  clientId: "lw-client-1",
  serviceAccount: "abcde.serviceaccount@example.co.jp",
  botId: "2000001",
  channels: ["ch-1"],
  users: ["u-1", "taro@example.co.jp"],
};
const BOT = `${API_BASE}/bots/2000001`;

function account(scopes: string[]) {
  return {
    clientId: CONFIG.clientId,
    serviceAccount: CONFIG.serviceAccount,
    scopes,
    privateKey: () => privateKey,
    clientSecret: () => "lw-secret",
  };
}

function setup(
  config: Record<string, unknown>,
  routes: Route[],
  opts: { expired?: boolean; grant?: string[] } = {},
) {
  const settings = readSettings({ ...CONFIG, ...config });
  const secrets = new MemorySecretStore();
  const fetch = mockFetch(routes);
  const audit: Parameters<ConnectorAuditSink>[0][] = [];
  const runtime = new ConnectorRuntime(
    { id: "line-works", credential: serviceAccountCredential(account(requestedScopes(settings))) },
    { secrets: () => secrets, fetch, sleep: noSleep, audit: (r) => void audit.push(r) },
  );
  runtime.tokens.save({
    accessToken: "lw-at",
    expiresAt: opts.expired ? Date.now() - 1000 : Date.now() + 3_600_000,
    scopes: opts.grant ?? requestedScopes(settings),
    tokenType: "Bearer",
    obtainedAt: 0,
  });
  let verdict: "allow" | "deny" = "deny";
  const asks: Array<{ args: unknown }> = [];
  const tools = createLineWorksToolsFor(settings, runtime, { agentId: "main" }, async (p) => {
    asks.push(p as { args: unknown });
    return verdict;
  });
  const tool = (name: string) => (params: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.execute("c", params) as Promise<{
      content: Array<{ text: string }>;
    }>;
  return {
    settings,
    runtime,
    tools,
    tool,
    fetch,
    audit,
    asks,
    allow: () => void (verdict = "allow"),
  };
}

describe("line works configuration and auth", () => {
  it("needs the service account, bot, targets and both secrets; read-only by default", () => {
    expect(configProblems(readSettings({}), {})).toEqual([
      "clientId (the app's Client ID) is not set",
      "serviceAccount (the app's Service Account id) is not set",
      "botId is not set",
      "channels or users must list at least one channel id or user id",
      "private key missing: run kurahi secrets set connector.line-works.privateKey",
      "client secret missing: run kurahi secrets set connector.line-works.clientSecret",
    ]);
    expect(requestedScopes(readSettings(CONFIG))).toEqual([SCOPES.read]);
    expect(requestedScopes(readSettings({ ...CONFIG, write: { send: true } }))).toEqual([
      SCOPES.read,
      SCOPES.send,
    ]);
    expect(setup({}, []).tools.map((t) => t.name)).toEqual([
      "lineworks_channel_get",
      "lineworks_channel_members",
    ]);
    expect(setup({ write: { send: true } }, []).tools.map((t) => t.name)).toContain(
      "lineworks_message_send",
    );
  });

  it("signs an RS256 assertion with iss, sub and a 60-minute expiry", () => {
    const jwt = signAssertion(
      { clientId: "c1", serviceAccount: "sa@x", privateKey },
      1_700_000_000_000,
    );
    const [h, c, s] = jwt.split(".");
    expect(JSON.parse(Buffer.from(h, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT",
    });
    expect(JSON.parse(Buffer.from(c, "base64url").toString())).toEqual({
      iss: "c1",
      sub: "sa@x",
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    expect(
      createVerify("RSA-SHA256").update(`${h}.${c}`).verify(publicKey, Buffer.from(s, "base64url")),
    ).toBe(true);
  });

  it("mints a token with the jwt-bearer grant and keeps no refresh token", async () => {
    const fetch = mockFetch([
      on("POST", TOKEN_URL, () =>
        jsonResponse({
          access_token: "new-at",
          refresh_token: "rt",
          expires_in: 86400,
          scope: "bot.read",
          token_type: "Bearer",
        }),
      ),
    ]);
    const t = await mintAccessToken(account([SCOPES.read]), { fetch, sleep: noSleep });
    const form = new URLSearchParams(fetch.calls[0].body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(form.get("client_id")).toBe("lw-client-1");
    expect(form.get("client_secret")).toBe("lw-secret");
    expect(form.get("scope")).toBe("bot.read");
    expect(form.get("assertion")?.split(".")).toHaveLength(3);
    expect(t).toMatchObject({ accessToken: "new-at", scopes: ["bot.read"] });
    expect(t.refreshToken).toBeUndefined();
  });

  it("re-mints an expired token once before the API call", async () => {
    const { tool, fetch } = setup(
      {},
      [
        on("POST", TOKEN_URL, () =>
          jsonResponse({ access_token: "fresh", expires_in: 3600, scope: "bot.read" }),
        ),
        on("GET", `${BOT}/channels/ch-1`, () =>
          jsonResponse({ channelId: "ch-1", title: "営業", channelType: { type: "group" } }),
        ),
      ],
      { expired: true },
    );
    const res = await tool("lineworks_channel_get")({ channelId: "ch-1" });
    expect(res.content[0].text).toContain("営業");
    expect(fetch.calls.map((c) => c.method)).toEqual(["POST", "GET"]);
    expect(fetch.calls[1].headers.authorization).toBe("Bearer fresh");
  });
});

describe("line works tools", () => {
  it("reads only configured channels and bounds member paging", async () => {
    const { tool, fetch, audit } = setup({}, [
      on("GET", `${BOT}/channels/ch-1/members?`, () =>
        jsonResponse({ members: ["u-1", "u-2"], responseMetaData: { nextCursor: "abc=" } }),
      ),
    ]);
    const res = await tool("lineworks_channel_members")({ channelId: "ch-1", count: 1000 });
    expect(new URL(fetch.calls[0].url).searchParams.get("count")).toBe("100");
    expect(res.content[0].text).toContain("u-2");
    expect(res.content[0].text).toContain("cursor abc=");
    expect(res.content[0].text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(audit[0].detail).toMatchObject({ op: "channels.members", ids: ["ch-1"], count: 2 });
    const other = await tool("lineworks_channel_get")({ channelId: "ch-9" });
    expect(other.content[0].text).toMatch(/^Error: forbidden/);
    expect(fetch.calls).toHaveLength(1);
  });

  it("sends only to configured targets, only after approval, at most 2,000 characters", async () => {
    const s = setup({ write: { send: true } }, [
      on("POST", `${BOT}/users/`, () => new Response(null, { status: 201 })),
      on("POST", `${BOT}/channels/ch-1/messages`, () => new Response(null, { status: 201 })),
    ]);
    const send = s.tool("lineworks_message_send");
    expect((await send({ to: "user", id: "stranger", text: "hi" })).content[0].text).toMatch(
      /^Error: forbidden/,
    );
    expect((await send({ to: "user", id: "u-1", text: "x".repeat(2001) })).content[0].text).toMatch(
      /^Error: bad_request/,
    );
    expect((await send({ to: "user", id: "u-1", text: "こんにちは" })).content[0].text).toMatch(
      /^Error: approval_denied/,
    );
    expect(s.fetch.calls).toHaveLength(0);
    s.allow();
    expect(
      (await send({ to: "user", id: "taro@example.co.jp", text: "会議は15時です" })).content[0]
        .text,
    ).toBe("Message sent to the user.");
    expect(s.fetch.calls[0].url).toBe(`${BOT}/users/taro%40example.co.jp/messages`);
    expect(JSON.parse(s.fetch.calls[0].body)).toEqual({
      content: { type: "text", text: "会議は15時です" },
    });
    await send({ to: "channel", id: "ch-1", text: "ok" });
    expect(s.fetch.calls[1].url).toBe(`${BOT}/channels/ch-1/messages`);
    // The audit row carries no message text and no address.
    expect(JSON.stringify(s.audit)).not.toMatch(/会議|taro@|こんにちは/);
    expect(s.audit.at(-1)?.detail).toMatchObject({ op: "messages.send", ids: ["ch-1"] });
  });

  it("refuses a send when the grant lacks bot.message, before any request", async () => {
    const s = setup({ write: { send: true } }, [], { grant: [SCOPES.read] });
    s.allow();
    const res = await s.tool("lineworks_message_send")({ to: "channel", id: "ch-1", text: "x" });
    expect(res.content[0].text).toMatch(/^Error: scope_missing/);
    expect(s.fetch.calls).toHaveLength(0);
    expect(s.asks).toHaveLength(0);
  });

  it("probe reads the first channel, or the bot list without channels", async () => {
    const { runtime, settings, fetch } = setup({}, [
      on("GET", `${BOT}/channels/ch-1`, () => jsonResponse({ channelId: "ch-1" })),
      on("GET", `${API_BASE}/bots?`, () => jsonResponse({ bots: [] })),
    ]);
    await probeLineWorks(runtime, settings);
    await probeLineWorks(runtime, { ...settings, channels: [] });
    expect(fetch.calls.map((c) => c.url)).toEqual([
      `${BOT}/channels/ch-1`,
      `${API_BASE}/bots?count=1`,
    ]);
  });
});
