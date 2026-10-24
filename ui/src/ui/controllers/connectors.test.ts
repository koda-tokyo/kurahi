import { describe, expect, it, vi } from "vitest";
import {
  businessHealthStatus,
  connectorRows,
  filterConnectorRows,
  loadConnectors,
  mcpStatus,
  pluginStatus,
} from "./connectors";

const localize = (id: string) =>
  ({
    "connectors.kind.business": "業務コネクター",
    "connectors.kind.hook": "実行時フック",
    "connectors.kind.plugin": "プラグイン",
    "connectors.kind.mcp": "MCP サーバー",
    "connectors.capability.calendar": "カレンダー",
  })[id] ?? id;

describe("connector catalogue", () => {
  it("starts the three business entries as planned with declared capabilities", () => {
    const rows = connectorRows(null, null, null);
    expect(rows.map(({ name, status }) => [name, status])).toEqual([
      ["Microsoft 365", "planned"],
      ["Gmail", "planned"],
      ["Microsoft Entra ID", "planned"],
    ]);
    expect(rows[0].capabilities).toEqual([
      "connectors.capability.mail",
      "connectors.capability.calendar",
      "connectors.capability.filesSharePoint",
      "connectors.capability.teams",
    ]);
    expect(rows[1].capabilities).toEqual(["connectors.capability.mail"]);
    expect(rows[2].capabilities).toEqual([
      "connectors.capability.sso",
      "connectors.capability.directoryRead",
    ]);
  });

  it("uses only exact conservative aliases and never infers M365 from Teams", () => {
    const rows = connectorRows(
      { plugins: [{ id: "msteams", name: "Microsoft Teams", enabled: true, status: "loaded" }] },
      null,
      null,
    );
    expect(rows.find((row) => row.id === "business:microsoft-365")?.status).toBe("planned");
    expect(rows.some((row) => row.name === "Microsoft Teams")).toBe(true);
  });

  it("caps alias-matched business rows at unverified without connector-specific health", () => {
    const rows = connectorRows(
      {
        plugins: [
          { id: "m365", enabled: true, status: "loaded" },
          { id: "entra", enabled: true, status: "loaded", error: "secret endpoint: abc" },
          { id: "gmail-business", enabled: true, status: "loading" },
        ],
      },
      { servers: [{ id: "microsoft-entra-id", enabled: true, state: "connected" }] },
      { plugins: { entries: { m365: { enabled: false }, "gmail-business": {} } } },
    );
    expect(rows.find((row) => row.id === "business:microsoft-365")?.status).toBe("disabled");
    expect(rows.find((row) => row.id === "business:entra")?.status).toBe("unverified");
    expect(rows.find((row) => row.id === "business:gmail")?.status).toBe("unverified");
    expect(JSON.stringify(rows)).not.toContain("secret endpoint");
  });

  it("keeps Gmail hook separate and marks configuration-only evidence unverified", () => {
    const rows = connectorRows(null, null, {
      hooks: { gmail: { account: "private@example.com" } },
    });
    expect(rows.find((row) => row.id === "business:gmail")?.status).toBe("planned");
    expect(rows.find((row) => row.id === "runtime:gmail-hook")).toMatchObject({
      name: "Gmail hook",
      status: "unverified",
      kind: "hook",
    });
    expect(JSON.stringify(rows)).not.toContain("private@example.com");

    const disabled = connectorRows(null, null, { hooks: { enabled: false, gmail: {} } });
    expect(disabled.find((row) => row.id === "runtime:gmail-hook")?.status).toBe("disabled");
    expect(
      connectorRows(null, null, { hooks: { gmail: false } }).find(
        (row) => row.id === "runtime:gmail-hook",
      )?.status,
    ).toBe("disabled");
  });

  it("marks configured-only MCP rows unverified or disabled", () => {
    const rows = connectorRows(null, null, {
      mcp: { servers: { docs: { target: "https://private.example" }, off: { enabled: false } } },
    });
    expect(rows.filter((row) => row.kind === "mcp").map((row) => row.status)).toEqual([
      "unverified",
      "disabled",
    ]);
    expect(JSON.stringify(rows)).not.toContain("private.example");
  });

  it("shows runtime names while excluding targets and other unsafe runtime fields", () => {
    const rows = connectorRows(
      {
        plugins: [
          { id: "private-plugin-id", name: "person@example.com", enabled: true, status: "loaded" },
        ],
      },
      {
        servers: [
          { id: "private-target", target: "secret --token=abc", enabled: true, state: "connected" },
        ],
      },
      null,
    );
    const serialized = JSON.stringify(rows);
    expect(serialized).toContain("person@example.com");
    expect(serialized).toContain("private-target");
    expect(serialized).not.toMatch(/secret|abc/);
    expect(
      rows.some((row) => row.name === "person@example.com" && row.status === "unverified"),
    ).toBe(true);
    expect(rows.some((row) => row.name === "private-target" && row.status === "active")).toBe(true);
  });

  it("keeps loaded aliases and connected MCP aliases below active", () => {
    const rows = connectorRows(
      { plugins: [{ id: "m365", enabled: true, status: "loaded" }] },
      { servers: [{ id: "gmail", enabled: true, state: "connected" }] },
      null,
    );
    expect(rows.find((row) => row.id === "business:microsoft-365")?.status).toBe("unverified");
    expect(rows.find((row) => row.id === "business:gmail")?.status).toBe("unverified");
  });

  it("filters by localized capabilities and status", () => {
    const rows = connectorRows(null, null, null);
    expect(filterConnectorRows(rows, "カレンダー", "all", localize).map((row) => row.name)).toEqual(
      ["Microsoft 365"],
    );
    expect(filterConnectorRows(rows, "", "planned", localize)).toHaveLength(3);
    expect(filterConnectorRows(rows, "missing", "all", localize)).toEqual([]);
  });

  it("applies exact plugin and MCP status rules", () => {
    expect(pluginStatus({ enabled: false, status: "loaded" })).toBe("disabled");
    expect(pluginStatus({ enabled: true, status: "loaded" })).toBe("unverified");
    expect(pluginStatus({ enabled: true, status: "loaded", health: "healthy" })).toBe("active");
    expect(pluginStatus({ enabled: true, status: "loaded", quarantined: true })).toBe("unverified");
    expect(pluginStatus({ enabled: true, status: "loaded", error: "private" })).toBe("unverified");
    expect(mcpStatus({ enabled: false, state: "connected" })).toBe("disabled");
    expect(mcpStatus({ enabled: true, state: "connected" })).toBe("active");
    expect(mcpStatus({ enabled: true, state: "connecting" })).toBe("unverified");
  });
});

describe("connector status loading", () => {
  it("uses generic partial-source state without exposing request errors", async () => {
    const host = {
      client: {
        request: vi.fn((method: string) =>
          method === "plugins.list"
            ? Promise.reject(new Error("https://tenant.example/account?token=private"))
            : Promise.resolve({ servers: [] }),
        ),
      },
      connected: true,
      configSnapshot: { config: null },
      enterprise: { connectorsLoading: false, connectorsSource: null, connectors: null },
    } as unknown as Parameters<typeof loadConnectors>[0];
    await loadConnectors(host);
    expect(host.enterprise.connectorsSource).toBe("partial");
    expect(host.enterprise.connectorsLoading).toBe(false);
    expect(JSON.stringify(host.enterprise)).not.toMatch(/tenant\.example|private/);
  });

  it("marks both failed runtime sources unavailable while preserving planned rows", async () => {
    const host = {
      client: { request: vi.fn(() => Promise.reject(new Error("raw failure"))) },
      connected: true,
      enterprise: { connectorsLoading: false, connectorsSource: null, connectors: null },
    } as unknown as Parameters<typeof loadConnectors>[0];
    await loadConnectors(host);
    expect(host.enterprise.connectorsSource).toBe("unavailable");
    expect(host.enterprise.connectors?.map((row) => row.status)).toEqual([
      "planned",
      "planned",
      "planned",
    ]);
  });
});

describe("business connector health", () => {
  const now = Date.parse("2026-10-23T10:00:00Z");
  const healthy = {
    id: "microsoft-365",
    configured: true,
    authenticated: true,
    lastProbeOk: true,
    lastProbeAt: "2026-10-23T09:50:00.000Z",
    scopes: ["Mail.Read"],
    error: null,
  };

  it("shows Active only for a configured, signed-in connector with a recent successful probe", () => {
    expect(businessHealthStatus(healthy, now)).toBe("active");
    expect(businessHealthStatus({ ...healthy, lastProbeOk: false }, now)).toBe("unverified");
    expect(businessHealthStatus({ ...healthy, lastProbeOk: null, lastProbeAt: null }, now)).toBe(
      "unverified",
    );
    expect(businessHealthStatus({ ...healthy, authenticated: false }, now)).toBe("unverified");
    expect(businessHealthStatus({ ...healthy, configured: false }, now)).toBe("unverified");
    expect(businessHealthStatus({ ...healthy, lastProbeAt: "2026-10-21T09:50:00.000Z" }, now)).toBe(
      "unverified",
    );
  });

  it("maps connectors.status entries onto the business rows and never overrides disabled", () => {
    const health = {
      connectors: [
        healthy,
        { ...healthy, id: "gmail", lastProbeOk: false, error: "reauth_required" },
        { ...healthy, id: "entra" },
      ],
    };
    const rows = connectorRows(
      {
        plugins: [
          { id: "microsoft-365", enabled: true, status: "loaded" },
          { id: "gmail", enabled: true, status: "loaded" },
        ],
      },
      null,
      { plugins: { entries: { entra: { enabled: false } } } },
      health,
      now,
    );
    expect(rows.find((row) => row.id === "business:microsoft-365")?.status).toBe("active");
    expect(rows.find((row) => row.id === "business:gmail")?.status).toBe("unverified");
    expect(rows.find((row) => row.id === "business:entra")?.status).toBe("disabled");
    expect(JSON.stringify(rows)).not.toContain("reauth_required");
  });

  it("requests connectors.status and tolerates a gateway without it", async () => {
    const request = vi.fn((method: string) => {
      if (method === "connectors.status") {
        return Promise.reject(new Error("unknown method"));
      }
      if (method === "plugins.list") {
        return Promise.resolve({ plugins: [{ id: "gmail", enabled: true, status: "loaded" }] });
      }
      return Promise.resolve({ servers: [] });
    });
    const host = {
      client: { request },
      connected: true,
      enterprise: { connectorsLoading: false, connectorsSource: null, connectors: null },
    } as unknown as Parameters<typeof loadConnectors>[0];
    await loadConnectors(host);
    expect(request).toHaveBeenCalledWith("connectors.status", {});
    expect(host.enterprise.connectorsSource).toBe("ready");
    expect(host.enterprise.connectors?.find((row) => row.id === "business:gmail")?.status).toBe(
      "unverified",
    );
  });
});
