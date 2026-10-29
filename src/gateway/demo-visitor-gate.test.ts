import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import { DemoInviteStore, setDemoInviteStoreForTest } from "../packaging/demo-invites.js";
import { handleGatewayRequest } from "./server-methods.js";

const ok = vi.fn(({ respond }: { respond: (ok: boolean) => void }) => respond(true));

async function call(method: string, params: Record<string, unknown>, c: GatewayClient) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params } as never,
    respond,
    client: c,
    isWebchatConnect: () => false,
    context: {} as GatewayRequestContext,
    extraHandlers: { "chat.send": ok as never, "config.get": ok as never },
  });
  return respond.mock.calls[0] as [boolean, unknown, { message?: string } | undefined];
}

function visitor(store: DemoInviteStore, projectId: string) {
  const created = store.create({ label: "Tanaka, Example Corp", projectId });
  if (!created.ok) {
    throw new Error(created.reason);
  }
  const client = {
    connect: { role: "operator", scopes: ["operator.read", "operator.write"] },
    demoVisitor: { inviteId: created.invite.id, projectId },
  } as unknown as GatewayClient;
  return { client, invite: created.invite };
}

afterEach(() => setDemoInviteStoreForTest(null));

describe("demo visitor request gate", () => {
  it("lets a visitor drive its own Project's chat and nothing else", async () => {
    const store = new DemoInviteStore({ filePath: null, audit: vi.fn() });
    setDemoInviteStoreForTest(store);
    const { client } = visitor(store, "pdemogate01");
    const own = await call("chat.send", { sessionKey: "agent:main:proj-pdemogate01-c1" }, client);
    expect(own[0]).toBe(true);
    const other = await call("chat.send", { sessionKey: "agent:main:proj-pdemogate02-c1" }, client);
    expect(other[0]).toBe(false);
    expect(other[2]?.message).toBe("session not allowed for this demo invite");
    const config = await call("config.get", {}, client);
    expect(config[0]).toBe(false);
    expect(config[2]?.message).toBe("method not allowed for a demo invite");
  });

  it("refuses the next request once the invite is revoked", async () => {
    const store = new DemoInviteStore({ filePath: null, audit: vi.fn() });
    setDemoInviteStoreForTest(store);
    const { client, invite } = visitor(store, "pdemogate03");
    const params = { sessionKey: "agent:main:proj-pdemogate03-c1" };
    expect((await call("chat.send", params, client))[0]).toBe(true);
    store.revoke(invite.id);
    const after = await call("chat.send", params, client);
    expect(after[0]).toBe(false);
    expect(after[2]?.message).toMatch(/^demo invite revoked/);
  });

  it("refuses a client whose Project does not match its invite", async () => {
    const store = new DemoInviteStore({ filePath: null, audit: vi.fn() });
    setDemoInviteStoreForTest(store);
    const { client } = visitor(store, "pdemogate04");
    client.demoVisitor = { inviteId: client.demoVisitor!.inviteId, projectId: "pdemogate05" };
    const res = await call("chat.send", { sessionKey: "agent:main:proj-pdemogate05-c1" }, client);
    expect(res[0]).toBe(false);
    expect(res[2]?.message).toMatch(/^demo invite unknown_invite/);
  });
});
