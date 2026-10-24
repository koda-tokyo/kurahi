import { afterEach, describe, expect, it } from "vitest";
import {
  clearConnectorStatusForTest,
  reportConnectorStatus,
} from "../../connectors/business/status.js";
import { resolveMethodSchemaNames } from "../protocol/json-schema.js";
import { wsMethodMinScope } from "../scopes.js";
import { BASE_GATEWAY_METHODS } from "../server-methods-list.js";
import { connectorsHandlers } from "./connectors.js";

afterEach(() => clearConnectorStatusForTest());

async function call(params: unknown) {
  let out: { ok: boolean; payload?: unknown; error?: unknown } | undefined;
  await connectorsHandlers["connectors.status"]({
    params,
    respond: (ok: boolean, payload?: unknown, error?: unknown) => {
      out = { ok, payload, error };
    },
  } as unknown as Parameters<(typeof connectorsHandlers)["connectors.status"]>[0]);
  return out!;
}

describe("connectors.status", () => {
  it("is a typed, observe-scope core method", () => {
    expect(BASE_GATEWAY_METHODS).toContain("connectors.status");
    expect(wsMethodMinScope("connectors.status")).toBe("observe");
    expect(resolveMethodSchemaNames("connectors.status")).toEqual({
      params: "ConnectorsStatusParams",
      result: "ConnectorsStatusResult",
    });
  });

  it("returns sanitized entries only", async () => {
    reportConnectorStatus({
      id: "microsoft-365",
      configured: true,
      authenticated: true,
      lastProbeOk: false,
      lastProbeAt: "2026-10-23T09:00:00.000Z",
      scopes: ["User.Read", "https://graph.microsoft.com/Mail.Read"],
      // A plugin bug that passes provider text is reduced to a code.
      error: "AADSTS50173 for alice@contoso.com" as never,
    });
    const res = await call({});
    expect(res.ok).toBe(true);
    expect(res.payload).toEqual({
      connectors: [
        {
          id: "microsoft-365",
          configured: true,
          authenticated: true,
          lastProbeOk: false,
          lastProbeAt: "2026-10-23T09:00:00.000Z",
          scopes: ["Mail.Read", "User.Read"],
          error: "unknown",
        },
      ],
    });
    expect(JSON.stringify(res.payload)).not.toContain("contoso");
  });

  it("rejects unknown params", async () => {
    const res = await call({ include: "tokens" });
    expect(res.ok).toBe(false);
  });
});
