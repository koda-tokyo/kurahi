import { afterEach, describe, expect, it } from "vitest";
import { readToolDef } from "../../src/autopilot/tools.js";
import {
  type ConnectorAuditSink,
  ConnectorRuntime,
  clearConnectorStatusForTest,
} from "../../src/connectors/business/index.js";
import {
  jsonResponse,
  MemorySecretStore,
  mockFetch,
  noSleep,
  on,
  type Route,
} from "../../src/connectors/business/test-helpers.js";
import { createM365Tools } from "./index.js";
import { buildClient, readSettings, requestedScopes } from "./src/config.js";

const G = "https://graph.microsoft.com/v1.0";
const BASE_CONFIG = {
  tenantId: "11111111-2222-3333-4444-555555555555",
  clientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
};

afterEach(() => clearConnectorStatusForTest());

function setup(config: Record<string, unknown>, routes: Route[], grant?: string[]) {
  const settings = readSettings({ ...BASE_CONFIG, ...config });
  const client = buildClient(settings)!;
  const secrets = new MemorySecretStore();
  const fetch = mockFetch(routes);
  const audit: Parameters<ConnectorAuditSink>[0][] = [];
  const runtime = new ConnectorRuntime(
    { id: "microsoft-365", client },
    {
      secrets: () => secrets,
      fetch,
      sleep: noSleep,
      random: () => 0,
      audit: (r) => void audit.push(r),
    },
  );
  runtime.tokens.save({
    accessToken: "graph-at",
    refreshToken: "rt",
    expiresAt: Date.now() + 3_600_000,
    scopes: grant ?? client.scopes,
    tokenType: "Bearer",
    obtainedAt: 0,
  });
  const tools = createM365Tools(settings, runtime, { agentId: "main", sessionKey: "agent:main:t" });
  const run = (params: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === "m365_security_alerts");
    if (!t) {
      throw new Error("no m365_security_alerts");
    }
    return t.execute("call-1", params) as Promise<{
      content: Array<{ text: string }>;
      details?: Record<string, unknown>;
    }>;
  };
  return { tools, run, fetch, audit };
}

const ALERT = {
  id: "da637551227677560813_-961444813",
  title: "Suspicious execution of hidden file",
  description: "A hidden file has been launched. SECRET-DESCRIPTION",
  recommendedActions: "Collect artifacts",
  severity: "high",
  status: "new",
  category: "DefenseEvasion",
  createdDateTime: "2026-10-29T08:00:00Z",
  serviceSource: "microsoftDefenderForEndpoint",
  alertWebUrl: "https://security.microsoft.com/alerts/da637551227677560813_-961444813",
  evidence: [
    {
      "@odata.type": "#microsoft.graph.security.deviceEvidence",
      deviceDnsName: "pc-0042.contoso.local",
      vmMetadata: { blob: "EVIDENCE-BLOB" },
    },
    {
      "@odata.type": "#microsoft.graph.security.userEvidence",
      userAccount: { accountName: "jdoe", userPrincipalName: "jdoe@contoso.example" },
    },
    {
      "@odata.type": "#microsoft.graph.security.processEvidence",
      processCommandLine: "powershell -enc EVIDENCE-CMDLINE",
    },
  ],
};

describe("m365_security_alerts", () => {
  it("is off by default and requests SecurityAlert.Read.All only when opted in", () => {
    expect(requestedScopes(readSettings(BASE_CONFIG))).not.toContain("SecurityAlert.Read.All");
    expect(requestedScopes(readSettings({ ...BASE_CONFIG, security: { alerts: true } }))).toContain(
      "SecurityAlert.Read.All",
    );
    expect(setup({}, []).tools.map((t) => t.name)).not.toContain("m365_security_alerts");
  });

  it("is a declared autopilot read tool of the microsoft-365 plugin", () => {
    expect(readToolDef("m365_security_alerts")).toEqual({
      name: "m365_security_alerts",
      provider: "microsoft-365",
    });
  });

  it("lists summarised alerts with filters, never evidence or descriptions", async () => {
    const older = { ...ALERT, id: "a2", createdDateTime: "2026-10-28T00:00:00Z", evidence: [] };
    const s = setup({ security: { alerts: true } }, [
      on("GET", `${G}/security/alerts_v2`, () => jsonResponse({ value: [older, ALERT] })),
    ]);
    const res = await s.run({ severity: "HIGH", status: "new", since: "2026-10-01", top: 500 });
    const url = new URL(s.fetch.calls[0].url);
    expect(url.pathname).toBe("/v1.0/security/alerts_v2");
    expect(url.searchParams.get("$top")).toBe("50");
    expect(url.searchParams.get("$filter")).toBe(
      "severity eq 'high' and status eq 'new' and createdDateTime ge 2026-10-01T00:00:00.000Z",
    );
    expect(s.fetch.calls[0].headers.authorization).toBe("Bearer graph-at");

    const text = res.content[0].text;
    expect(text).toContain("1. id: da637551227677560813_-961444813");
    expect(text).toContain("severity: high  status: new  category: DefenseEvasion");
    expect(text).toContain("devices: pc-0042.contoso.local");
    expect(text).toContain("users: jdoe@contoso.example");
    expect(text).toContain("link: https://security.microsoft.com/alerts/");
    const all = JSON.stringify(res) + JSON.stringify(s.audit);
    for (const leaked of ["EVIDENCE-BLOB", "EVIDENCE-CMDLINE", "SECRET-DESCRIPTION", "artifacts"]) {
      expect(all).not.toContain(leaked);
    }
    expect(res.details?.count).toBe(2);
    expect(s.audit.at(-1)?.detail).toMatchObject({ ids: [ALERT.id, "a2"], count: 2 });
  });

  it("refuses an unknown severity before calling Graph", async () => {
    const s = setup({ security: { alerts: true } }, []);
    const res = await s.run({ severity: "severe' or 1 eq 1" });
    expect(res.content[0].text).toMatch(/^Error: bad_request/);
    expect(s.fetch.calls).toHaveLength(0);
  });

  it("refuses when the stored grant lacks SecurityAlert.Read.All", async () => {
    const s = setup({ security: { alerts: true } }, [], ["User.Read", "Mail.Read"]);
    const res = await s.run({});
    expect(res.content[0].text).toMatch(/^Error: scope_missing/);
    expect(s.fetch.calls).toHaveLength(0);
  });
});
