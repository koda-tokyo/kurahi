import type { MessageId } from "../i18n";

export type ConnectorStatus = "active" | "unverified" | "disabled" | "planned";
export type ConnectorKind = "business" | "hook" | "plugin" | "mcp";

export type ConnectorRow = {
  id: string;
  name: string;
  nameKey?: MessageId;
  kind: ConnectorKind;
  status: ConnectorStatus;
  capabilities: MessageId[];
  why: MessageId;
};

type CatalogueEntry = Pick<ConnectorRow, "id" | "name" | "capabilities"> & {
  aliases: string[];
};

const BUSINESS_CATALOGUE: CatalogueEntry[] = [
  {
    id: "business:microsoft-365",
    name: "Microsoft 365",
    aliases: ["microsoft 365", "microsoft-365", "microsoft365", "m365", "office365", "office-365"],
    capabilities: [
      "connectors.capability.mail",
      "connectors.capability.calendar",
      "connectors.capability.filesSharePoint",
      "connectors.capability.teams",
    ],
  },
  {
    id: "business:gmail",
    name: "Gmail",
    aliases: ["gmail", "google-gmail", "gmail-business"],
    capabilities: ["connectors.capability.mail"],
  },
  {
    id: "business:entra",
    name: "Microsoft Entra ID",
    aliases: ["entra", "entra-id", "microsoft-entra", "microsoft-entra-id", "azuread", "azure-ad"],
    capabilities: ["connectors.capability.sso", "connectors.capability.directoryRead"],
  },
];

const ALIAS_TO_BUSINESS_ID = new Map(
  BUSINESS_CATALOGUE.flatMap((entry) => entry.aliases.map((alias) => [alias, entry.id] as const)),
);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function businessId(...values: unknown[]): string | undefined {
  for (const value of values) {
    const match = ALIAS_TO_BUSINESS_ID.get(text(value));
    if (match) {
      return match;
    }
  }
  return undefined;
}

function whyFor(status: ConnectorStatus): MessageId {
  return `connectors.why.${status}` as MessageId;
}

export function pluginStatus(
  plugin: Record<string, unknown>,
  configuredEnabled?: boolean,
): ConnectorStatus {
  if (plugin.enabled === false || configuredEnabled === false) {
    return "disabled";
  }
  const explicitHealth = text(plugin.health);
  const explicitConnection = text(plugin.connectionState);
  const connected =
    plugin.connected === true ||
    explicitHealth === "healthy" ||
    explicitHealth === "connected" ||
    explicitConnection === "connected";
  return connected && !plugin.error && plugin.quarantined !== true ? "active" : "unverified";
}

export function mcpStatus(
  server: Record<string, unknown>,
  configuredEnabled?: boolean,
): ConnectorStatus {
  if (server.enabled === false || configuredEnabled === false) {
    return "disabled";
  }
  return server.state === "connected" ? "active" : "unverified";
}

function setBusinessEvidenceStatus(rows: ConnectorRow[], id: string, next: ConnectorStatus) {
  const row = rows.find((candidate) => candidate.id === id);
  if (!row) {
    return;
  }
  // Alias matching proves only that related runtime configuration exists. A business catalogue
  // row cannot be Active until that connector has its own health contract and probe.
  row.status = row.status === "disabled" || next === "disabled" ? "disabled" : "unverified";
  row.why = whyFor(row.status);
}

// Ids the business connector plugins report through `connectors.status`.
const HEALTH_TO_BUSINESS_ID: Record<string, string> = {
  "microsoft-365": "business:microsoft-365",
  gmail: "business:gmail",
  entra: "business:entra",
};

/** A probe older than this no longer proves anything (the longest probe interval is 24 h). */
export const BUSINESS_PROBE_MAX_AGE_MS = 25 * 60 * 60 * 1000;

/**
 * Status from a `connectors.status` entry. Active needs all of: configured, signed in, and a
 * successful live probe that is recent. Everything else the plugin reports is unverified.
 */
export function businessHealthStatus(
  entry: Record<string, unknown>,
  now: number = Date.now(),
): ConnectorStatus {
  const at = typeof entry.lastProbeAt === "string" ? Date.parse(entry.lastProbeAt) : Number.NaN;
  const fresh = Number.isFinite(at) && now - at <= BUSINESS_PROBE_MAX_AGE_MS && at - now < 300_000;
  return entry.configured === true &&
    entry.authenticated === true &&
    entry.lastProbeOk === true &&
    fresh
    ? "active"
    : "unverified";
}

function applyBusinessHealth(rows: ConnectorRow[], health: unknown, now: number) {
  const entries = isRecord(health) && Array.isArray(health.connectors) ? health.connectors : [];
  for (const entry of entries) {
    if (!isRecord(entry) || typeof entry.id !== "string") {
      continue;
    }
    const businessId = HEALTH_TO_BUSINESS_ID[entry.id];
    const row = rows.find((candidate) => candidate.id === businessId);
    if (!row || row.status === "disabled") {
      continue;
    }
    row.status = businessHealthStatus(entry, now);
    row.why = whyFor(row.status);
  }
}

function genericRuntimeRow(
  kind: "plugin" | "mcp",
  index: number,
  status: ConnectorStatus,
  name: string,
): ConnectorRow {
  return {
    id: `runtime:${kind}:${index}`,
    name,
    kind,
    status,
    capabilities: [],
    why: whyFor(status),
  };
}

export function connectorRows(
  plugins: unknown,
  mcp: unknown,
  config: unknown,
  businessHealth?: unknown,
  now: number = Date.now(),
): ConnectorRow[] {
  const rows: ConnectorRow[] = BUSINESS_CATALOGUE.map((entry) => ({
    id: entry.id,
    name: entry.name,
    kind: "business",
    status: "planned",
    capabilities: entry.capabilities,
    why: whyFor("planned"),
  }));
  const pluginEntries =
    isRecord(config) && isRecord(config.plugins) && isRecord(config.plugins.entries)
      ? config.plugins.entries
      : {};
  const observedPluginIds = new Set<string>();
  const runtimePlugins = isRecord(plugins) && Array.isArray(plugins.plugins) ? plugins.plugins : [];

  for (const plugin of runtimePlugins) {
    if (!isRecord(plugin)) {
      continue;
    }
    const id = text(plugin.id);
    const configuredKey = Object.keys(pluginEntries).find((key) => key.toLowerCase() === id);
    const configured = configuredKey ? pluginEntries[configuredKey] : undefined;
    const configuredEnabled = isRecord(configured) ? configured.enabled !== false : undefined;
    const status = pluginStatus(plugin, configuredEnabled);
    if (id) {
      observedPluginIds.add(id);
    }
    const mapped = businessId(plugin.id, plugin.name);
    if (mapped) {
      setBusinessEvidenceStatus(rows, mapped, status);
    } else if (plugin.enabled !== false || configured !== undefined) {
      rows.push(
        genericRuntimeRow(
          "plugin",
          rows.filter((row) => row.kind === "plugin").length + 1,
          status,
          String(plugin.name || plugin.id || "Plugin"),
        ),
      );
    }
  }

  for (const [id, entry] of Object.entries(pluginEntries)) {
    if (observedPluginIds.has(id.toLowerCase())) {
      continue;
    }
    const enabled = !isRecord(entry) || entry.enabled !== false;
    const status = enabled ? "unverified" : "disabled";
    const mapped = businessId(id);
    if (mapped) {
      setBusinessEvidenceStatus(rows, mapped, status);
    } else {
      rows.push(
        genericRuntimeRow(
          "plugin",
          rows.filter((row) => row.kind === "plugin").length + 1,
          status,
          id,
        ),
      );
    }
  }

  const servers = isRecord(mcp) && Array.isArray(mcp.servers) ? mcp.servers : [];
  const configuredServersRaw =
    isRecord(config) && isRecord(config.mcp) ? config.mcp.servers : undefined;
  const configuredServers: Array<[string, unknown]> = isRecord(configuredServersRaw)
    ? Object.entries(configuredServersRaw)
    : Array.isArray(configuredServersRaw)
      ? configuredServersRaw.flatMap((entry) =>
          isRecord(entry) && typeof entry.id === "string" ? [[entry.id, entry]] : [],
        )
      : [];
  const observedServerIds = new Set<string>();
  for (const server of servers) {
    if (!isRecord(server)) {
      continue;
    }
    const id = text(server.id);
    const configured = configuredServers.find(([key]) => key.toLowerCase() === id)?.[1];
    const configuredEnabled = isRecord(configured) ? configured.enabled !== false : undefined;
    const status = mcpStatus(server, configuredEnabled);
    if (id) {
      observedServerIds.add(id);
    }
    const mapped = businessId(server.id, server.serverName);
    if (mapped) {
      setBusinessEvidenceStatus(rows, mapped, status);
    } else {
      rows.push(
        genericRuntimeRow(
          "mcp",
          rows.filter((row) => row.kind === "mcp").length + 1,
          status,
          String(server.serverName || server.id || "MCP server"),
        ),
      );
    }
  }

  for (const [id, entry] of configuredServers) {
    if (observedServerIds.has(id.toLowerCase())) {
      continue;
    }
    const status = isRecord(entry) && entry.enabled === false ? "disabled" : "unverified";
    const mapped = businessId(id);
    if (mapped) {
      setBusinessEvidenceStatus(rows, mapped, status);
    } else {
      rows.push(
        genericRuntimeRow("mcp", rows.filter((row) => row.kind === "mcp").length + 1, status, id),
      );
    }
  }

  const hooks = isRecord(config) && isRecord(config.hooks) ? config.hooks : null;
  if (hooks && hooks.gmail !== undefined && hooks.gmail !== null) {
    const gmailHook = isRecord(hooks.gmail) ? hooks.gmail : {};
    const hookStatus =
      hooks.enabled === false || hooks.gmail === false || gmailHook.enabled === false
        ? "disabled"
        : "unverified";
    rows.push({
      id: "runtime:gmail-hook",
      name: "Gmail hook",
      kind: "hook",
      status: hookStatus,
      capabilities: [],
      why: whyFor(hookStatus),
    });
  }

  applyBusinessHealth(rows, businessHealth, now);
  return rows;
}

export function filterConnectorRows(
  rows: ConnectorRow[],
  query: string,
  status: ConnectorStatus | "all",
  localize: (id: MessageId) => string,
): ConnectorRow[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter((row) => {
    if (status !== "all" && row.status !== status) {
      return false;
    }
    if (!needle) {
      return true;
    }
    const haystack = [
      row.nameKey ? localize(row.nameKey) : row.name,
      localize(`connectors.kind.${row.kind}` as MessageId),
      ...row.capabilities.map(localize),
    ]
      .join(" ")
      .toLocaleLowerCase();
    return haystack.includes(needle);
  });
}
