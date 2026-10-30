import { afterEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ connectTokens: [] as string[], pairLink: 0 }));

vi.mock("./app-gateway", () => ({
  connectGateway: (host: { settings: { token: string } }) => {
    calls.connectTokens.push(host.settings.token);
  },
}));
vi.mock("./app-polling", () => ({
  startLogsPolling: () => {},
  startNodesPolling: () => {},
  stopLogsPolling: () => {},
  stopNodesPolling: () => {},
  startDebugPolling: () => {},
  stopDebugPolling: () => {},
}));
vi.mock("./sso", () => ({
  takeSsoFragment: () => Promise.resolve({ notice: null }),
  fetchSsoConfig: () => Promise.resolve(null),
  takeEnrollFragment: () => undefined,
}));
vi.mock("./pair-link", () => ({
  handlePairLink: async (host: { useToken: (token: string) => void }) => {
    calls.pairLink += 1;
    host.useToken("kpa_stored_phone_credential");
    return true;
  },
}));
vi.mock("./app-settings", () => ({
  applySettings: (host: { settings: unknown }, next: unknown) => {
    host.settings = next;
  },
  applySettingsFromUrl: () => {},
  attachThemeListener: () => {},
  detachThemeListener: () => {},
  inferBasePath: () => "",
  syncTabWithLocation: () => {},
  syncThemeWithSettings: () => {},
}));

const { handleConnected, handleDisconnected } = await import("./app-lifecycle");

const CODE = "kdi_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_xyz";

function makeHost() {
  return {
    basePath: "",
    tab: "chat",
    settings: { token: "old-owner-token" },
    lastError: null,
    popStateHandler: () => {},
    topbarObserver: null,
  };
}

async function settle() {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

describe("handleConnected with a demo invite link", () => {
  afterEach(() => {
    calls.connectTokens.length = 0;
    calls.pairLink = 0;
    window.history.replaceState(null, "", "/");
  });

  it("connects with the invite code, strips it, and skips the stored phone credential", async () => {
    window.history.replaceState(null, "", `/#invite=${CODE}`);
    const host = makeHost();
    handleConnected(host as never);
    await settle();
    expect(window.location.href).not.toContain("kdi_");
    expect(host.settings.token).toBe(CODE);
    expect(calls.pairLink).toBe(0);
    expect(calls.connectTokens).toEqual([CODE]);
    handleDisconnected(host as never);
  });

  it("keeps the usual pairing path without an invite", async () => {
    const host = makeHost();
    handleConnected(host as never);
    await settle();
    expect(calls.pairLink).toBe(1);
    expect(calls.connectTokens).toEqual(["kpa_stored_phone_credential"]);
    handleDisconnected(host as never);
  });

  it("ignores a malformed invite and keeps the stored token", async () => {
    window.history.replaceState(null, "", "/#invite=kdi_bad");
    const host = makeHost();
    handleConnected(host as never);
    await settle();
    expect(window.location.href).not.toContain("kdi_");
    expect(calls.pairLink).toBe(1);
    handleDisconnected(host as never);
  });
});
