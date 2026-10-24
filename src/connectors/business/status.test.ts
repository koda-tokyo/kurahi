import { afterEach, describe, expect, it } from "vitest";
import { ConnectorError } from "./errors.js";
import {
  clearConnectorStatusForTest,
  listConnectorStatus,
  reportConnectorStatus,
  runConnectorProbe,
  sanitizeStatusEntry,
} from "./status.js";

afterEach(() => clearConnectorStatusForTest());

describe("status sanitization", () => {
  it("keeps only the contract fields and safe values", () => {
    const clean = sanitizeStatusEntry({
      id: "gmail",
      configured: true,
      authenticated: true,
      lastProbeOk: false,
      lastProbeAt: "2026-10-23T09:00:00.000Z",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly", "https://evil/<script>"],
      error: "invalid_grant: refresh token rt-abc123 for alice@example.com",
      accessToken: "ya29.secret",
      email: "alice@example.com",
    });
    expect(clean).toEqual({
      id: "gmail",
      configured: true,
      authenticated: true,
      lastProbeOk: false,
      lastProbeAt: "2026-10-23T09:00:00.000Z",
      scopes: ["gmail.readonly"],
      error: "unknown",
    });
    expect(JSON.stringify(clean)).not.toMatch(/secret|alice|rt-abc/);
  });

  it("never claims a successful probe without sign-in or a probe time", () => {
    expect(
      sanitizeStatusEntry({
        id: "entra",
        configured: true,
        authenticated: false,
        lastProbeOk: true,
        lastProbeAt: "2026-10-23T09:00:00Z",
      })?.lastProbeOk,
    ).toBeNull();
    expect(
      sanitizeStatusEntry({
        id: "entra",
        configured: true,
        authenticated: true,
        lastProbeOk: true,
        lastProbeAt: "yesterday",
      })?.lastProbeOk,
    ).toBeNull();
    expect(
      sanitizeStatusEntry({ id: "entra", configured: false, authenticated: true })?.authenticated,
    ).toBe(false);
    expect(sanitizeStatusEntry({ id: "../etc", configured: true })).toBeNull();
  });

  it("lists sorted entries", () => {
    reportConnectorStatus({
      id: "microsoft-365",
      configured: false,
      authenticated: false,
      lastProbeOk: null,
      lastProbeAt: null,
      scopes: [],
      error: "not_configured",
    });
    reportConnectorStatus({
      id: "gmail",
      configured: false,
      authenticated: false,
      lastProbeOk: null,
      lastProbeAt: null,
      scopes: [],
      error: "not_configured",
    });
    expect(listConnectorStatus().map((e) => e.id)).toEqual(["gmail", "microsoft-365"]);
  });
});

describe("probe", () => {
  const now = () => Date.parse("2026-10-23T09:00:00.000Z");

  it("does not call the provider when not configured or not signed in", async () => {
    let calls = 0;
    const probe = async () => {
      calls++;
    };
    expect(
      await runConnectorProbe({
        id: "gmail",
        configured: false,
        grantedScopes: undefined,
        probe,
        now,
      }),
    ).toMatchObject({
      error: "not_configured",
      lastProbeOk: null,
    });
    expect(
      await runConnectorProbe({
        id: "gmail",
        configured: true,
        grantedScopes: undefined,
        probe,
        now,
      }),
    ).toMatchObject({
      authenticated: false,
      error: "not_authenticated",
    });
    expect(calls).toBe(0);
  });

  it("records success and failure with a code only", async () => {
    const ok = await runConnectorProbe({
      id: "microsoft-365",
      configured: true,
      grantedScopes: ["User.Read", "Mail.Read"],
      probe: async () => {},
      now,
    });
    expect(ok).toEqual({
      id: "microsoft-365",
      configured: true,
      authenticated: true,
      lastProbeOk: true,
      lastProbeAt: "2026-10-23T09:00:00.000Z",
      scopes: ["Mail.Read", "User.Read"],
      error: null,
    });
    const bad = await runConnectorProbe({
      id: "microsoft-365",
      configured: true,
      grantedScopes: ["User.Read"],
      probe: async () => {
        throw new ConnectorError("reauth_required", "AADSTS70008 token for bob@contoso.com");
      },
      now,
    });
    expect(bad).toMatchObject({
      authenticated: false,
      lastProbeOk: false,
      error: "reauth_required",
    });
    expect(listConnectorStatus()[0].error).toBe("reauth_required");
  });
});
