// Microsoft 365 security alerts (Kurahi Guardian, Phase 2): Microsoft Defender and the other
// Microsoft security products' alerts through Graph Security (`/security/alerts_v2`,
// SecurityAlert.Read.All, an opt-in). Read-only: no alert is updated, assigned or commented.
// Only summary fields reach the agent (title, severity, status, category, source, the names of
// affected devices and users, the portal link); evidence blobs, descriptions and recommended
// actions are never returned.
import { Type } from "@sinclair/typebox";
import {
  asAgentTool,
  ConnectorError,
  type ConnectorRuntime,
  type GraphPage,
  graphUrl,
  intParam,
  isoParam,
  runConnectorTool,
  strParam,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import { SCOPES } from "./config.js";

const SEVERITIES = ["informational", "low", "medium", "high"] as const;
const STATUSES = ["new", "inProgress", "resolved"] as const;
const MAX_TOP = 50;
/** Evidence makes alerts large; the page is capped well above 50 summarised alerts. */
const MAX_PAGE_BYTES = 8 * 1024 * 1024;
const NAMES_MAX = 5;
const FIELD_MAX = 256;

type Evidence = {
  "@odata.type"?: string;
  deviceDnsName?: string;
  userAccount?: { userPrincipalName?: string; accountName?: string; displayName?: string };
};

type GraphAlert = {
  id: string;
  title?: string;
  severity?: string;
  status?: string;
  category?: string;
  createdDateTime?: string;
  serviceSource?: string;
  alertWebUrl?: string;
  evidence?: Evidence[];
};

export type AlertSummary = {
  id: string;
  title: string;
  severity: string;
  status: string;
  category: string;
  createdDateTime: string;
  serviceSource: string;
  devices: string[];
  users: string[];
  link: string;
};

function field(v: unknown): string {
  return typeof v === "string" ? v.replace(/[\r\n]+/g, " ").slice(0, FIELD_MAX) : "";
}

function portalLink(v: unknown): string {
  try {
    const u = new URL(String(v));
    return u.protocol === "https:" ? u.toString().slice(0, 2048) : "";
  } catch {
    return "";
  }
}

function pushName(set: Set<string>, v: unknown) {
  const s = field(v).trim();
  if (s && set.size < NAMES_MAX) {
    set.add(s);
  }
}

/** The summary of one alert: the evidence contributes names only. */
export function summariseAlert(a: GraphAlert): AlertSummary {
  const devices = new Set<string>();
  const users = new Set<string>();
  for (const ev of Array.isArray(a.evidence) ? a.evidence : []) {
    const type = String(ev?.["@odata.type"] ?? "");
    if (type.endsWith(".deviceEvidence")) {
      pushName(devices, ev.deviceDnsName);
    } else if (type.endsWith(".userEvidence")) {
      const acc = ev.userAccount;
      pushName(users, acc?.userPrincipalName || acc?.accountName || acc?.displayName);
    }
  }
  return {
    id: field(a.id),
    title: field(a.title),
    severity: field(a.severity),
    status: field(a.status),
    category: field(a.category),
    createdDateTime: field(a.createdDateTime),
    serviceSource: field(a.serviceSource),
    devices: [...devices],
    users: [...users],
    link: portalLink(a.alertWebUrl),
  };
}

export function formatAlerts(alerts: AlertSummary[]): string {
  if (alerts.length === 0) {
    return "No security alerts match.";
  }
  const lines = alerts.map((a, i) =>
    [
      `${i + 1}. id: ${a.id}`,
      `   title: ${a.title}`,
      `   severity: ${a.severity}  status: ${a.status}  category: ${a.category}`,
      `   created: ${a.createdDateTime}  source: ${a.serviceSource}`,
      `   devices: ${a.devices.join(", ")}`,
      `   users: ${a.users.join(", ")}`,
      `   link: ${a.link}`,
    ].join("\n"),
  );
  return wrapUntrusted(lines.join("\n"), { source: "api" });
}

function enumParam<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined {
  const s = strParam(value, name, { max: 32 });
  if (s === undefined) {
    return undefined;
  }
  const hit = allowed.find((x) => x.toLowerCase() === s.toLowerCase());
  if (!hit) {
    throw new ConnectorError("bad_request", `${name} must be one of ${allowed.join(", ")}`);
  }
  return hit;
}

export type SecurityToolDeps = { runtime: ConnectorRuntime; ctx: ToolContext };

export function createSecurityTools(deps: SecurityToolDeps) {
  const { runtime, ctx } = deps;
  const alerts = asAgentTool({
    name: "m365_security_alerts",
    label: "Microsoft 365: security alerts",
    description:
      "List Microsoft Defender / Microsoft 365 security alerts (Graph Security alerts_v2), newest first, as summaries: title, severity, status, category, source, affected device and user names, portal link. Filters: severity (informational|low|medium|high), status (new|inProgress|resolved), since (ISO 8601 created date). At most 50. Read-only.",
    parameters: Type.Object({
      severity: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
      since: Type.Optional(Type.String()),
      top: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TOP })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "security.alerts",
        async () => {
          const severity = enumParam(params.severity, "severity", SEVERITIES);
          const status = enumParam(params.status, "status", STATUSES);
          const since = isoParam(params.since, "since");
          const filters: string[] = [];
          if (severity) {
            filters.push(`severity eq '${severity}'`);
          }
          if (status) {
            filters.push(`status eq '${status}'`);
          }
          if (since) {
            filters.push(`createdDateTime ge ${since.toISOString()}`);
          }
          const page = await runtime.json<GraphPage<GraphAlert>>(
            {
              url: graphUrl("/security/alerts_v2", {
                $top: intParam(params.top, 20, 1, MAX_TOP),
                ...(filters.length > 0 ? { $filter: filters.join(" and ") } : {}),
              }),
              scopes: [SCOPES.securityAlerts],
            },
            MAX_PAGE_BYTES,
          );
          const value = (page.value ?? [])
            .slice(0, MAX_TOP)
            .map(summariseAlert)
            .toSorted((a, b) => b.createdDateTime.localeCompare(a.createdDateTime));
          return {
            value,
            result: textResult(formatAlerts(value), { count: value.length, alerts: value }),
          };
        },
        (v) => ({ ids: v.map((a) => a.id), count: v.length }),
      ),
  });
  return [alerts];
}
