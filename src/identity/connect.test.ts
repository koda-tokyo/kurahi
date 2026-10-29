import { describe, expect, it, vi } from "vitest";

vi.mock("./evidence.js", () => ({ recordIdentityChange: vi.fn(() => null) }));
vi.mock("../security/audit-log.js", () => ({ recordAuditEvent: vi.fn() }));

const { nonDeciderReason, nonPersonReason, SSO_PERSON_DECISIONS, ssoRequiredGate } =
  await import("./connect.js");
const { resolveIdentitySettings } = await import("./config.js");
const { recordAuditEvent } = await import("../security/audit-log.js");
const { recordIdentityChange } = await import("./evidence.js");

const required = resolveIdentitySettings({ ssoRequired: true });
const ui = { id: "kolo-control-ui", mode: "webchat" };
const base = {
  settings: required,
  authMethod: "token",
  person: null,
  role: "operator",
  client: ui,
  localDirect: false,
  breakGlass: null,
  ip: "203.0.113.5",
};

describe("SSO required gate", () => {
  it("is open when SSO is not required", () => {
    expect(ssoRequiredGate({ ...base, settings: resolveIdentitySettings({}) }).ok).toBe(true);
  });

  it("refuses token, password, pairing, device-token and Tailscale logins of people", () => {
    for (const authMethod of [
      "token",
      "password",
      "pair-credential",
      "device-token",
      "tailscale",
    ]) {
      const r = ssoRequiredGate({ ...base, authMethod });
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.message).toContain("SSO is required");
    }
    expect(ssoRequiredGate({ ...base, localDirect: true }).ok).toBe(false);
  });

  it("admits SSO persons and nodes", () => {
    expect(ssoRequiredGate({ ...base, authMethod: "sso", person: {} as never }).ok).toBe(true);
    expect(ssoRequiredGate({ ...base, role: "node", authMethod: "device-token" }).ok).toBe(true);
  });

  it("a node needs a paired device: the shared secret alone is refused", () => {
    const node = { ...base, role: "node", localDirect: true };
    const bare = ssoRequiredGate({ ...node, authMethod: "token" });
    expect(bare.ok).toBe(false);
    expect(bare.ok ? "" : bare.reason).toBe("sso_required_node_device");
    expect(ssoRequiredGate({ ...node, authMethod: "password" }).ok).toBe(false);
    // With a device identity the connection goes through device pairing (approval).
    expect(ssoRequiredGate({ ...node, authMethod: "token", hasDevice: true }).ok).toBe(true);
    // Without ssoRequired nodes connect as before.
    const open = resolveIdentitySettings({});
    expect(ssoRequiredGate({ ...node, settings: open, authMethod: "token" }).ok).toBe(true);
  });

  it("admits agent connections only on the gateway host", () => {
    const agent = { id: "gateway-client", mode: "backend" };
    expect(ssoRequiredGate({ ...base, client: agent, localDirect: true }).ok).toBe(true);
    expect(ssoRequiredGate({ ...base, client: agent, localDirect: false }).ok).toBe(false);
  });

  it("break-glass: owner secret + reason, local only by default, audited and sealed", () => {
    vi.mocked(recordAuditEvent).mockClear();
    const remote = ssoRequiredGate({ ...base, breakGlass: "IdP outage" });
    expect(remote.ok).toBe(false);
    expect(remote.ok ? "" : remote.message).toContain("only on the gateway host");
    const local = ssoRequiredGate({ ...base, breakGlass: "IdP outage", localDirect: true });
    expect(local).toEqual({ ok: true, breakGlass: true });
    expect(
      vi
        .mocked(recordAuditEvent)
        .mock.calls.some(([e]) => e.action === "identity.breakglass.login"),
    ).toBe(true);
    expect(vi.mocked(recordIdentityChange)).toHaveBeenCalled();
    // A pairing credential cannot be a break-glass login.
    expect(
      ssoRequiredGate({
        ...base,
        authMethod: "pair-credential",
        breakGlass: "x",
        localDirect: true,
      }).ok,
    ).toBe(false);
    // With localOnly off, a remote break-glass is allowed (still audited).
    const open = resolveIdentitySettings({ ssoRequired: true, breakGlass: { localOnly: false } });
    expect(ssoRequiredGate({ ...base, settings: open, breakGlass: "IdP outage" }).ok).toBe(true);
  });
});

describe("personhood comes from the credential, not from client fields", () => {
  const configured = resolveIdentitySettings({
    publicUrl: "https://gateway.example.test",
    providers: [{ id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" }],
  });
  const conn = (client: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    connect: { role: "operator", client },
    ...extra,
  });
  const cli = { id: "cli", mode: "cli", displayName: "Alice" };

  it("single-user installs: the owner token is the local person", () => {
    const local = resolveIdentitySettings({});
    expect(local.localPersons).toBe(true);
    expect(nonPersonReason(conn(cli, { authMethod: "token" }), local)).toBeNull();
    expect(nonPersonReason(conn(cli, { authMethod: "device-token" }), local)).toBeNull();
  });

  it("with identity configured, owner token, device token and pairing are not persons", () => {
    expect(configured.localPersons).toBe(false);
    for (const authMethod of [
      "token",
      "password",
      "tailscale",
      "device-token",
      "pair-credential",
    ]) {
      expect(nonPersonReason(conn(cli, { authMethod }), configured), authMethod).toMatch(
        /not a person/,
      );
    }
    expect(nonPersonReason(conn(cli, { authMethod: "sso", person: {} }), configured)).toBeNull();
    expect(
      nonPersonReason(conn(cli, { authMethod: "token", breakGlass: true }), configured),
    ).toBeNull();
    // An explicit local-person mode restores the old behaviour, but never with ssoRequired.
    const explicit = resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      providers: [{ id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" }],
      localPersons: true,
    });
    expect(nonPersonReason(conn(cli, { authMethod: "token" }), explicit)).toBeNull();
    const sso = resolveIdentitySettings({ ssoRequired: true, localPersons: true });
    expect(sso.localPersons).toBe(false);
    expect(sso.problems.join(" ")).toContain("localPersons is ignored");
  });

  it("with identity configured, the highest-impact decisions need an SSO person", () => {
    const sso = conn(cli, { authMethod: "sso", person: {} });
    const glass = conn(cli, { authMethod: "token", breakGlass: true });
    expect(nonDeciderReason(sso, configured)).toBeNull();
    // Break-glass is a person for admin and recovery, not for these decisions.
    expect(nonPersonReason(glass, configured)).toBeNull();
    expect(nonDeciderReason(glass, configured)).toMatch(/needs an SSO sign-in/);
    const explicit = resolveIdentitySettings({
      publicUrl: "https://gateway.example.test",
      providers: [{ id: "corp", kind: "oidc", issuer: "https://idp.example.test", clientId: "k" }],
      localPersons: true,
    });
    expect(nonDeciderReason(conn(cli, { authMethod: "token" }), explicit)).toMatch(
      /needs an SSO sign-in/,
    );
    // Single-user installs without identity config: the owner still decides.
    expect(
      nonDeciderReason(conn(cli, { authMethod: "token" }), resolveIdentitySettings({})),
    ).toBeNull();
    expect([...SSO_PERSON_DECISIONS].toSorted()).toEqual([
      "autopilot.approvals.create",
      "autopilot.approvals.revoke",
      "autopilot.autonomy.accept",
      "autopilot.startAll",
      "governance.dsr.execute",
      "governance.dsr.find",
      "governance.export.create",
      "governance.holds.create",
      "governance.holds.release",
      "governance.policy.set",
      "governance.retention.run",
      "workitems.clearFlag",
      "workitems.decide",
      "workitems.selectSupplier",
    ]);
  });

  it("agent runtimes and gateway-client connections are never persons", () => {
    const local = resolveIdentitySettings({});
    for (const client of [
      { id: "gateway-client", mode: "cli" },
      { id: "x", mode: "backend" },
      { id: "x", mode: "cli", displayName: "agent" },
    ]) {
      for (const s of [local, configured]) {
        expect(
          nonPersonReason(conn(client, { authMethod: "sso", person: {}, breakGlass: true }), s),
        ).toMatch(/agent/);
      }
    }
    expect(nonPersonReason(conn(cli, { authMethod: "token" }), configured)).not.toBeNull();
    expect(nonPersonReason({ connect: { role: "node", client: cli } }, local)).toBe("role node");
  });

  it("identity configured without ssoRequired: break-glass needs a reason and is audited", () => {
    vi.mocked(recordAuditEvent).mockClear();
    const input = { ...base, settings: configured, localDirect: true };
    expect(ssoRequiredGate({ ...input, breakGlass: null })).toEqual({
      ok: true,
      breakGlass: false,
    });
    expect(ssoRequiredGate({ ...input, breakGlass: "   " })).toEqual({
      ok: true,
      breakGlass: false,
    });
    expect(vi.mocked(recordAuditEvent)).not.toHaveBeenCalled();
    expect(ssoRequiredGate({ ...input, breakGlass: "IdP outage" })).toEqual({
      ok: true,
      breakGlass: true,
    });
    expect(
      vi
        .mocked(recordAuditEvent)
        .mock.calls.some(
          ([e]) => e.action === "identity.breakglass.login" && e.detail?.reason === "IdP outage",
        ),
    ).toBe(true);
    // Not from elsewhere, not for agents, not with a device token.
    expect(ssoRequiredGate({ ...input, localDirect: false, breakGlass: "x" })).toEqual({
      ok: true,
      breakGlass: false,
    });
    expect(
      ssoRequiredGate({ ...input, client: { id: "x", mode: "backend" }, breakGlass: "x" }),
    ).toEqual({ ok: true, breakGlass: false });
    expect(ssoRequiredGate({ ...input, authMethod: "device-token", breakGlass: "x" })).toEqual({
      ok: true,
      breakGlass: false,
    });
  });

  it("under ssoRequired every agent-exemption connect is audited", () => {
    vi.mocked(recordAuditEvent).mockClear();
    const agent = { id: "gateway-client", mode: "backend" };
    expect(ssoRequiredGate({ ...base, client: agent, localDirect: true }).ok).toBe(true);
    expect(ssoRequiredGate({ ...base, client: agent, localDirect: false }).ok).toBe(false);
    const calls = vi
      .mocked(recordAuditEvent)
      .mock.calls.filter(([e]) => e.action === "identity.sso_required.agent");
    expect(calls.map(([e]) => e.outcome)).toEqual(["allowed", "denied"]);
  });
});
