import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approvalRules,
  auditCsv,
  auditRecordsFromEvents,
  auditRecordsFromLogs,
  credentialPolicy,
  DEFAULT_ENTERPRISE_STATE,
  defaultModelSelection,
  filterAuditRecords,
  httpBaseFromGatewayUrl,
  installHostAuditFetcher,
  loadAuditEvents,
  locationOfBaseUrl,
  modelProviderRows,
  recordApprovalDecision,
  serviceStatus,
  todaysRuns,
} from "./enterprise";

describe("service status", () => {
  it("maps connection and health to running / stopped / needs attention", () => {
    expect(serviceStatus(false, { status: "healthy" }, null)).toBe("stopped");
    expect(serviceStatus(true, { status: "healthy" }, null)).toBe("running");
    expect(serviceStatus(true, { status: "degraded" }, null)).toBe("attention");
    expect(serviceStatus(true, null, "event gap")).toBe("attention");
    expect(serviceStatus(true, null, null)).toBe("running");
  });
});

describe("models", () => {
  it("reads only the host of a base URL", () => {
    expect(locationOfBaseUrl("http://127.0.0.1:11434/v1")).toEqual({ kind: "local" });
    expect(locationOfBaseUrl("http://localhost:8000")).toEqual({ kind: "local" });
    expect(locationOfBaseUrl("https://user:pw@api.example.com/v1?key=x")).toEqual({
      kind: "remote",
      host: "api.example.com",
    });
    expect(locationOfBaseUrl("")).toEqual({ kind: "unknown" });
    expect(locationOfBaseUrl("not a url")).toEqual({ kind: "unknown" });
  });

  it("lists providers exactly as configured, never keys", () => {
    const config = {
      models: {
        providers: {
          local: { baseUrl: "http://127.0.0.1:11434", apiKey: "sk-secret", models: [{ id: "m1" }] },
          cloud: { baseUrl: "https://llm.example.net", headers: { a: "b" }, models: [] },
        },
      },
      agents: { defaults: { model: { primary: "cloud/big", fallbacks: ["local/m1", "other/x"] } } },
    };
    const rows = modelProviderRows(config);
    expect(rows.map((r) => r.id)).toEqual(["cloud", "local", "other"]);
    expect(rows.find((r) => r.id === "cloud")?.models).toEqual(["big"]);
    expect(rows.find((r) => r.id === "local")?.where).toEqual({ kind: "local" });
    expect(rows.find((r) => r.id === "other")?.where).toEqual({ kind: "unknown" });
    expect(JSON.stringify(rows)).not.toContain("sk-secret");
    expect(defaultModelSelection(config)).toEqual({
      primary: "cloud/big",
      fallbacks: ["local/m1", "other/x"],
    });
    expect(defaultModelSelection({ agents: { defaults: { model: "a/b" } } })).toEqual({
      primary: "a/b",
      fallbacks: [],
    });
    expect(modelProviderRows(null)).toEqual([]);
  });
});

describe("policies", () => {
  it("reads auth.isolation and auth.grants only", () => {
    const p = credentialPolicy({
      auth: {
        isolation: "explicit",
        grants: { sales: ["crm"], ops: [] },
        profiles: { crm: { key: "x" } },
      },
    });
    expect(p).toEqual({
      isolation: "explicit",
      grants: [
        { agent: "ops", profiles: [] },
        { agent: "sales", profiles: ["crm"] },
      ],
    });
    expect(credentialPolicy(null)).toEqual({ isolation: null, grants: [] });
    expect(credentialPolicy({ auth: { isolation: "weird" } }).isolation).toBeNull();
  });

  it("summarises exec approval rules", () => {
    expect(approvalRules(null)).toEqual([]);
    expect(
      approvalRules({
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: { main: { ask: "always", allowlist: [{ pattern: "ls" }, { pattern: "git *" }] } },
      }),
    ).toEqual([
      { scope: "*", security: "allowlist", ask: "on-miss", allowlist: 0 },
      { scope: "main", security: "", ask: "always", allowlist: 2 },
    ]);
  });
});

describe("approvals history", () => {
  it("records a decision once, newest first, capped", () => {
    const queue = [
      { id: "a", request: { command: "rm x", agentId: "main" }, createdAtMs: 1, expiresAtMs: 2 },
    ];
    let h = recordApprovalDecision([], queue, { id: "a", decision: "deny", ts: 5 });
    expect(h).toEqual([
      { id: "a", command: "rm x", agentId: "main", decision: "deny", resolvedBy: null, ts: 5 },
    ]);
    h = recordApprovalDecision(h, queue, { id: "a", decision: "allow-once" });
    expect(h).toHaveLength(1);
    for (let i = 0; i < 30; i++) {
      h = recordApprovalDecision(h, [], { id: `x${i}`, decision: "allow-once", ts: i });
    }
    expect(h).toHaveLength(20);
    expect(h[0].id).toBe("x29");
  });
});

describe("today's runs", () => {
  it("counts enabled jobs due before midnight and finds the next", () => {
    const now = new Date(2026, 9, 20, 10, 0, 0).getTime();
    const at = (h: number, d = 20) => new Date(2026, 9, d, h, 0, 0).getTime();
    const jobs = [
      { id: "1", enabled: true, state: { nextRunAtMs: at(12) } },
      { id: "2", enabled: true, state: { nextRunAtMs: at(23) } },
      { id: "3", enabled: true, state: { nextRunAtMs: at(9, 21) } },
      { id: "4", enabled: false, state: { nextRunAtMs: at(11) } },
      { id: "5", enabled: true, state: {} },
    ] as never[];
    expect(todaysRuns(jobs, now)).toEqual({ remaining: 2, nextAtMs: at(12) });
    expect(todaysRuns([], now)).toEqual({ remaining: 0, nextAtMs: null });
  });
});

describe("audit log", () => {
  const rows = auditRecordsFromLogs([
    {
      raw: "r1",
      time: "2026-10-20T01:00:00Z",
      level: "info",
      subsystem: "gateway",
      message: "started",
    },
    {
      raw: "r2",
      time: "2026-10-20T01:01:00Z",
      level: "error",
      subsystem: "cron",
      message: "job failed",
    },
  ]);

  it("filters by text and level", () => {
    expect(filterAuditRecords(rows, "", "")).toHaveLength(2);
    expect(filterAuditRecords(rows, "FAILED", "")).toHaveLength(1);
    expect(filterAuditRecords(rows, "", "info")[0].message).toBe("started");
    expect(filterAuditRecords(rows, "cron", "info")).toHaveLength(0);
  });

  it("maps audit events", () => {
    const ev = auditRecordsFromEvents([
      {
        id: "1",
        timestamp: "t",
        action: "config.write",
        targetType: "config",
        targetId: "kolo.json",
        userId: "u1",
      },
    ]);
    expect(ev[0]).toMatchObject({ action: "config.write", target: "config:kolo.json", user: "u1" });
    expect(auditRecordsFromEvents("nope")).toEqual([]);
  });

  it("exports CSV with a BOM, quoting and formula neutralisation", () => {
    const csv = auditCsv([
      {
        time: "t",
        level: "info",
        source: "s",
        action: "",
        target: "",
        user: "",
        message: 'a,"b"\nc',
      },
      {
        time: "t",
        level: "",
        source: "",
        action: "=HYPERLINK(1)",
        target: "+x",
        user: "@u",
        message: "-1",
      },
      { time: "t", level: "", source: "", action: "", target: "", user: "", message: "日本語" },
    ]);
    expect(csv.startsWith("﻿time,level,source,action,target,user,message\r\n")).toBe(true);
    expect(csv).toContain('"a,""b""\nc"');
    expect(csv).toContain("'=HYPERLINK(1),'+x,'@u,'-1");
    expect(csv).toContain("日本語");
  });

  it("derives the HTTP base from the gateway URL", () => {
    expect(httpBaseFromGatewayUrl("ws://127.0.0.1:18789")).toBe("http://127.0.0.1:18789");
    expect(httpBaseFromGatewayUrl("wss://host.example/ws")).toBe("https://host.example");
    expect(httpBaseFromGatewayUrl("nonsense")).toBeNull();
  });

  it("loads audit events with the bearer token and reports failures honestly", async () => {
    const host = {
      client: null,
      connected: true,
      enterprise: { ...DEFAULT_ENTERPRISE_STATE },
      settings: { gatewayUrl: "ws://127.0.0.1:18789", token: "tok" },
    };
    const ok = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        events: [{ id: "1", timestamp: "t", action: "a", targetType: "x" }],
      }),
    }));
    await loadAuditEvents(host, ok as never);
    expect(ok).toHaveBeenCalledWith("http://127.0.0.1:18789/api/admin/audit?limit=100", {
      headers: { accept: "application/json", authorization: "Bearer tok" },
    });
    expect(host.enterprise.auditEvents).toHaveLength(1);
    expect(host.enterprise.auditError).toBeNull();

    const fail = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await loadAuditEvents(host, fail as never);
    expect(host.enterprise.auditEvents).toEqual([]);
    expect(host.enterprise.auditError).toBe("Failed to fetch");
  });

  describe("host audit fetcher (Kurahi Desktop)", () => {
    afterEach(() => installHostAuditFetcher(null));

    it("uses the host fetcher instead of page fetch", async () => {
      const host = {
        client: null,
        connected: true,
        enterprise: { ...DEFAULT_ENTERPRISE_STATE },
        settings: { gatewayUrl: "ws://127.0.0.1:18789", token: "tok" },
      };
      const hostFetch = vi.fn(async () => ({
        ok: true,
        events: [{ id: "1", timestamp: "t", action: "x", targetType: "y" }],
      }));
      const pageFetch = vi.fn();
      installHostAuditFetcher(hostFetch);
      await loadAuditEvents(host, pageFetch as never);
      expect(pageFetch).not.toHaveBeenCalled();
      expect(hostFetch).toHaveBeenCalledWith({ limit: 100 });
      expect(host.enterprise.auditEvents).toHaveLength(1);

      installHostAuditFetcher(async () => {
        throw "gateway not reachable";
      });
      await loadAuditEvents(host, pageFetch as never);
      expect(host.enterprise.auditError).toBe("gateway not reachable");
      expect(host.enterprise.auditEvents).toEqual([]);
    });
  });
});
