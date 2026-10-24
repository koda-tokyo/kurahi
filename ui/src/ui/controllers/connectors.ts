import type { GatewayBrowserClient } from "../gateway";
import {
  businessHealthStatus,
  connectorRows,
  filterConnectorRows,
  mcpStatus,
  pluginStatus,
  type ConnectorRow,
  type ConnectorStatus,
} from "../connectors/catalogue";

export { businessHealthStatus, connectorRows, filterConnectorRows, mcpStatus, pluginStatus };
export type { ConnectorRow, ConnectorStatus };

export type ConnectorSourceState = "ready" | "partial" | "unavailable";

type ConnectorHost = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  configSnapshot?: { config?: unknown } | null;
  enterprise: {
    connectorsLoading: boolean;
    connectorsSource: ConnectorSourceState | null;
    connectors: ConnectorRow[] | null;
  };
};

function patch(host: ConnectorHost, next: Partial<ConnectorHost["enterprise"]>) {
  host.enterprise = { ...host.enterprise, ...next };
}

export async function loadConnectors(host: ConnectorHost) {
  if (!host.client || !host.connected) return;

  patch(host, { connectorsLoading: true });
  const [plugins, mcp, health] = await Promise.allSettled([
    host.client.request("plugins.list", {}),
    host.client.request("mcp.status", {}),
    // Business connector probes; an older gateway without the method simply shows no Active.
    host.client.request("connectors.status", {}),
  ]);
  const failed = Number(plugins.status === "rejected") + Number(mcp.status === "rejected");
  patch(host, {
    connectorsLoading: false,
    connectorsSource: failed === 2 ? "unavailable" : failed === 1 ? "partial" : "ready",
    connectors: connectorRows(
      plugins.status === "fulfilled" ? plugins.value : null,
      mcp.status === "fulfilled" ? mcp.value : null,
      host.configSnapshot?.config,
      health.status === "fulfilled" ? health.value : null,
    ),
  });
}
