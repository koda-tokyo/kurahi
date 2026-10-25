import { describe, expect, it } from "vitest";
import type { ProviderHealth } from "../../src/autopilot/triggers/mail-source.js";
import { ConnectorRuntime } from "../../src/connectors/business/index.js";
import {
  jsonResponse,
  MemorySecretStore,
  mockFetch,
  noSleep,
  on,
  type Route,
} from "../../src/connectors/business/test-helpers.js";
import { buildClient, publicUrlOf, readSettings } from "./src/config.js";
import { M365MailWatcher, NOTIFICATIONS_PATH } from "./src/mail-watch.js";

// The m365.mail trigger watcher against recorded Graph responses: no test reaches Microsoft.

const G = "https://graph.microsoft.com/v1.0";
const DELTA = `${G}/me/mailFolders/inbox/messages/delta`;
const link = (n: number) => `${G}/me/mailFolders('inbox')/messages/delta?$deltatoken=t${n}`;
const page = (ids: string[], deltaLink?: string, nextLink?: string) =>
  jsonResponse({
    value: ids.map((id) => ({ id, receivedDateTime: "2026-10-25T01:00:00Z" })),
    ...(deltaLink ? { "@odata.deltaLink": deltaLink } : {}),
    ...(nextLink ? { "@odata.nextLink": nextLink } : {}),
  });

function setup(routes: Route[], opts: { publicUrl?: string; token?: "ok" | "expired" } = {}) {
  const settings = readSettings({
    tenantId: "11111111-2222-3333-4444-555555555555",
    clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  });
  const client = buildClient(settings)!;
  const secrets = new MemorySecretStore();
  const fetch = mockFetch(routes);
  const runtime = new ConnectorRuntime(
    { id: "microsoft-365", client },
    { secrets: () => secrets, fetch, sleep: noSleep, random: () => 0 },
  );
  const save = (obtainedAt: number, expired = false) =>
    runtime.tokens.save({
      accessToken: "graph-at",
      ...(expired ? {} : { refreshToken: "rt" }),
      expiresAt: expired ? Date.now() - 1000 : Date.now() + 3_600_000,
      scopes: client.scopes,
      tokenType: "Bearer",
      obtainedAt,
    });
  save(1, opts.token === "expired");
  let now = 1_000_000;
  const watcher = new M365MailWatcher(runtime, {
    pollMs: 60_000,
    publicUrl: opts.publicUrl ?? null,
    now: () => now,
  });
  let stored: string | null = null;
  const signals: number[] = [];
  const health: ProviderHealth[] = [];
  const unsub = watcher.subscribe({
    key: "p1:inbox",
    folder: "inbox",
    store: { read: () => stored, write: (v) => void (stored = v) },
    onNewMail: (n) => signals.push(n),
    onHealth: (h) => health.push(h),
  });
  return {
    watcher,
    fetch,
    signals,
    health,
    stored: () => stored,
    setStored: (v: string | null) => void (stored = v),
    advance: (ms: number) => void (now += ms),
    resign: (obtainedAt: number) => save(obtainedAt),
    unsub,
  };
}

describe("m365 mail delta watcher", () => {
  it("initial sync records the delta link without signalling; new mail then signals a count", async () => {
    const t = setup([
      on("GET", /\$skiptoken=s1/, () => page(["old2"], link(1))),
      on("GET", DELTA, () => page(["old1"], undefined, `${DELTA}?$skiptoken=s1`)),
      on("GET", link(1), () => page(["new1", "new2"], link(2))),
      on("GET", link(2), () => page([], link(2))),
    ]);
    await t.watcher.settle();
    // Existing mail (two pages) is not "new": the link is stored, nothing is signalled.
    expect(t.fetch.calls).toHaveLength(2);
    expect(t.signals).toEqual([]);
    expect(t.stored()).toBe(link(1));
    // Only ids and receivedDateTime are selected; nothing else is asked of Graph.
    const first = new URL(t.fetch.calls[0].url);
    expect(first.searchParams.get("$select")).toBe("id,receivedDateTime");
    expect(t.fetch.calls[0].headers.prefer).toBe("odata.maxpagesize=200");
    await t.watcher.pollAll();
    expect(t.signals).toEqual([2]);
    expect(t.stored()).toBe(link(2));
    await t.watcher.pollAll();
    expect(t.signals).toEqual([2]);
    expect(t.health.at(-1)).toEqual({ status: "active", error: null });
    t.unsub();
  });

  it("410 Gone drops the delta link, re-syncs and signals once", async () => {
    let gone = true;
    const t = setup([
      on("GET", link(9), () =>
        gone ? jsonResponse({ error: { code: "SyncStateNotFound" } }, 410) : page([], link(9)),
      ),
      on("GET", DELTA, () => page(["a", "b"], link(10))),
      on("GET", link(10), () => page([], link(10))),
    ]);
    await t.watcher.settle();
    t.setStored(link(9));
    await t.watcher.pollAll();
    expect(t.stored()).toBe(link(10));
    expect(t.signals).toEqual([2]);
    gone = false;
    await t.watcher.pollAll();
    expect(t.signals).toEqual([2]);
    expect(t.health.at(-1)?.status).toBe("active");
  });

  it("429 with a long Retry-After backs off instead of hammering Graph", async () => {
    let throttled = true;
    const t = setup([
      on("GET", DELTA, () =>
        throttled
          ? new Response("{}", { status: 429, headers: { "retry-after": "120" } })
          : page([], link(1)),
      ),
    ]);
    await t.watcher.settle();
    expect(t.health.at(-1)).toEqual({ status: "degraded", error: "rate_limited" });
    const calls = t.fetch.calls.length;
    t.advance(60_000);
    await t.watcher.pollAll();
    expect(t.fetch.calls.length).toBe(calls);
    throttled = false;
    t.advance(120_000);
    await t.watcher.pollAll();
    expect(t.fetch.calls.length).toBe(calls + 1);
    expect(t.health.at(-1)).toEqual({ status: "active", error: null });
  });

  it("an expired sign-in marks the trigger degraded and does not spin until a new sign-in", async () => {
    const t = setup([on("GET", DELTA, () => page([], link(1)))], { token: "expired" });
    await t.watcher.settle();
    expect(t.health.at(-1)).toEqual({ status: "degraded", error: "reauth_required" });
    expect(t.fetch.calls).toEqual([]);
    for (let i = 0; i < 5; i++) {
      t.advance(3_600_000);
      await t.watcher.pollAll();
    }
    expect(t.fetch.calls).toEqual([]);
    t.resign(2);
    await t.watcher.pollAll();
    expect(t.fetch.calls.length).toBe(1);
    expect(t.health.at(-1)).toEqual({ status: "active", error: null });
  });

  it("refuses a stored delta link that is not a Graph URL (the token never leaves Graph)", async () => {
    const t = setup([on("GET", DELTA, () => page([], link(1)))]);
    await t.watcher.settle();
    t.setStored("https://evil.example/steal?$deltatoken=x");
    await t.watcher.pollAll();
    expect(t.fetch.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
    expect(t.stored()).toBeNull();
    expect(t.health.at(-1)).toEqual({ status: "degraded", error: "invalid_response" });
  });
});

describe("m365 change notifications (optional)", () => {
  const PUBLIC = "https://kurahi.example.com";

  it("only accepts an https base URL", () => {
    expect(publicUrlOf("https://kurahi.example.com/")).toBe("https://kurahi.example.com");
    expect(publicUrlOf("http://kurahi.example.com")).toBeNull();
    expect(publicUrlOf("https://u:p@kurahi.example.com")).toBeNull();
    expect(publicUrlOf("https://kurahi.example.com/?x=1")).toBeNull();
    expect(readSettings({ notifications: { publicUrl: "ftp://x" } }).notificationsPublicUrl).toBe(
      null,
    );
  });

  it("subscribes with a clientState, echoes the validation token, and checks clientState", async () => {
    const posts: Array<Record<string, unknown>> = [];
    let deltaCalls = 0;
    const t = setup(
      [
        on("GET", DELTA, () => {
          deltaCalls++;
          return page([], link(1));
        }),
        on("GET", link(1), () => {
          deltaCalls++;
          return page([], link(1));
        }),
        on("POST", `${G}/subscriptions`, (req) => {
          posts.push(JSON.parse(req.body) as Record<string, unknown>);
          return jsonResponse({ id: "sub-1", expirationDateTime: "2099-01-01T00:00:00Z" }, 201);
        }),
      ],
      { publicUrl: PUBLIC },
    );
    await t.watcher.settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      changeType: "created",
      notificationUrl: `${PUBLIC}${NOTIFICATIONS_PATH}`,
      resource: "me/mailFolders('inbox')/messages",
    });
    const clientState = String(posts[0].clientState);
    expect(clientState.length).toBeGreaterThanOrEqual(32);
    expect(t.watcher.webhookOf("p1:inbox")?.id).toBe("sub-1");

    // Validation handshake: the token comes back verbatim as text/plain.
    const v = t.watcher.handleNotification({
      query: new URLSearchParams({ validationToken: "Validation: Token 123" }),
      body: "",
    });
    expect(v).toMatchObject({ status: 200, body: "Validation: Token 123" });
    expect(v.contentType).toMatch(/^text\/plain/);
    expect(
      t.watcher.handleNotification({
        query: new URLSearchParams({ validationToken: "bad\u0000token" }),
        body: "",
      }).status,
    ).toBe(400);

    // Wrong clientState or unknown subscription: accepted (202) but nothing is polled.
    const before = deltaCalls;
    const wrong = t.watcher.handleNotification({
      query: new URLSearchParams(),
      body: JSON.stringify({
        value: [
          { subscriptionId: "sub-1", clientState: "forged" },
          { subscriptionId: "sub-x", clientState },
        ],
      }),
    });
    expect(wrong).toMatchObject({ status: 202, accepted: 0 });
    await t.watcher.settle();
    expect(deltaCalls).toBe(before);

    const ok = t.watcher.handleNotification({
      query: new URLSearchParams(),
      body: JSON.stringify({ value: [{ subscriptionId: "sub-1", clientState }] }),
    });
    expect(ok).toMatchObject({ status: 202, accepted: 1 });
    await t.watcher.settle();
    expect(deltaCalls).toBe(before + 1);
  });

  it("renews the subscription before it expires; a failed create falls back to polling", async () => {
    const patches: string[] = [];
    let create = 0;
    const t = setup(
      [
        on("GET", DELTA, () => page([], link(1))),
        on("GET", link(1), () => page([], link(1))),
        on("POST", `${G}/subscriptions`, () => {
          create++;
          return create === 1
            ? jsonResponse({ error: { code: "ValidationError" } }, 400)
            : jsonResponse({ id: "sub-2" }, 201);
        }),
        on("PATCH", `${G}/subscriptions/sub-2`, (req) => {
          patches.push(req.body);
          return jsonResponse({ id: "sub-2" });
        }),
      ],
      { publicUrl: PUBLIC },
    );
    await t.watcher.settle();
    expect(t.watcher.webhookOf("p1:inbox")).toBeNull();
    expect(t.health.at(-1)).toEqual({ status: "active", error: null });
    t.advance(31 * 60_000);
    await t.watcher.pollAll();
    expect(t.watcher.webhookOf("p1:inbox")?.id).toBe("sub-2");
    t.advance(43 * 3_600_000);
    await t.watcher.pollAll();
    expect(patches).toHaveLength(1);
    expect(JSON.parse(patches[0])).toHaveProperty("expirationDateTime");
  });
});
