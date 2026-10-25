import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { KoLoConfig } from "../config/config.js";

// Each request loads its own config snapshot. The first request below is held inside its
// bearer check while a second request with another config arrives: the first must still decide
// by its own snapshot (SSO required), never by the one loaded after it.
const configs = vi.hoisted(() => ({ queue: [] as KoLoConfig[] }));
const gate = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const state = {
    hold: false,
    entered: 0,
    released: Promise.resolve(),
    arm() {
      state.hold = true;
      state.released = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release(),
  };
  return state;
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, loadConfig: () => configs.queue.shift() ?? {} };
});
vi.mock("./pair-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pair-auth.js")>();
  return {
    ...actual,
    authorizeHttpBearer: async (...args: Parameters<typeof actual.authorizeHttpBearer>) => {
      gate.entered += 1;
      if (gate.hold) {
        gate.hold = false;
        await gate.released;
      }
      return await actual.authorizeHttpBearer(...args);
    },
  };
});

const { createGatewayHttpServer } = await import("./server-http.js");
const { setIdentityServiceForTest } = await import("../identity/service.js");

const TOKEN = "fake-gateway-token-for-snapshot-test-0000";
const ssoRequired: KoLoConfig = {
  gateway: { identity: { publicUrl: "https://gateway.example.test", ssoRequired: true } },
};

describe("per-request config snapshot", () => {
  const server = createGatewayHttpServer({
    canvasHost: null,
    controlUiEnabled: false,
    controlUiBasePath: "",
    openAiChatCompletionsEnabled: false,
    openResponsesEnabled: false,
    handleHooksRequest: async () => false,
    resolvedAuth: { mode: "token", token: TOKEN, allowTailscale: false },
  });
  let port = 0;

  beforeAll(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  afterEach(() => setIdentityServiceForTest(null));

  it("a concurrent request never swaps the snapshot an earlier request decides by", async () => {
    setIdentityServiceForTest(null);
    const get = () =>
      fetch(`http://127.0.0.1:${port}/api/policy/status`, {
        headers: { authorization: `Bearer ${TOKEN}` },
      });
    configs.queue.push(ssoRequired, {});
    gate.arm();
    gate.entered = 0;
    const first = get();
    await vi.waitFor(() => expect(gate.entered).toBe(1));
    const second = await get();
    gate.release();
    // The second request (no identity configured): the token works as before.
    expect(second.status).not.toBe(401);
    // The first request (SSO required, no break-glass reason): refused by its own snapshot.
    expect((await first).status).toBe(401);
  });
});
