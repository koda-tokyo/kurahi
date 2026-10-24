import { describe, expect, it, vi } from "vitest";
import type { TerminalBroker } from "../../console/terminal/broker.js";
import type { GatewayWsClient } from "../server/ws-types.js";
import type { GatewayClient, GatewayRequestContext } from "./types.js";
import { TerminalError } from "../../console/terminal/broker.js";
import { wsMethodMinScope } from "../scopes.js";
import { handleGatewayRequest } from "../server-methods.js";
import { mayReceiveTerminalEvent } from "../terminal-broker.js";
import { createTerminalHandlers, TERMINAL_METHODS } from "./terminal.js";

const client = (scopes: string[], role = "operator"): GatewayClient =>
  ({ connect: { role, scopes } }) as unknown as GatewayClient;

async function call(
  method: string,
  params: unknown,
  c: GatewayClient | null,
  broker: Partial<TerminalBroker>,
) {
  const respond = vi.fn();
  await handleGatewayRequest({
    req: { type: "req", id: "1", method, params } as never,
    respond,
    client: c,
    isWebchatConnect: () => false,
    context: {} as GatewayRequestContext,
    extraHandlers: createTerminalHandlers(broker as TerminalBroker),
  });
  return respond.mock.calls[0] as [
    boolean,
    unknown,
    { message?: string; details?: unknown } | undefined,
  ];
}

describe("terminal gateway methods", () => {
  it("every terminal method needs operator.admin", async () => {
    const broker = { open: vi.fn(async () => ({ sessionId: "s" })) };
    for (const method of TERMINAL_METHODS) {
      // Paired credentials: the WS scope matrix defaults to admin for these methods.
      expect(wsMethodMinScope(method)).toBe("admin");
      for (const scopes of [["operator.read"], ["operator.write"], ["operator.approvals"]]) {
        const [ok, , err] = await call(method, {}, client(scopes), broker);
        expect(ok, `${method} ${scopes.join()}`).toBe(false);
        expect(err?.message).toBe("missing scope: operator.admin");
      }
      const [ok, , err] = await call(method, {}, client(["operator.admin"], "node"), broker);
      expect(ok).toBe(false);
      expect(err?.message).toMatch(/unauthorized role/);
    }
    expect(broker.open).not.toHaveBeenCalled();
  });

  it("an admin operator reaches the broker; params are validated first", async () => {
    const broker = { open: vi.fn(async () => ({ sessionId: "s1" })) };
    const admin = client(["operator.admin"]);
    const bad = await call("terminal.open", { projectId: "p" }, admin, broker);
    expect(bad[0]).toBe(false);
    expect(bad[2]?.message).toMatch(/invalid terminal.open params/);
    const good = await call(
      "terminal.open",
      { projectId: "pabcdefghij", name: "tab" },
      admin,
      broker,
    );
    expect(good).toEqual([true, { sessionId: "s1" }, undefined]);
    expect(broker.open).toHaveBeenCalledWith({
      projectId: "pabcdefghij",
      name: "tab",
      actor: "owner",
    });
  });

  it("broker refusals keep their stable code", async () => {
    const broker = {
      open: vi.fn(async () => {
        throw new TerminalError("read-mode", "the project is in read mode");
      }),
    };
    const [ok, , err] = await call(
      "terminal.open",
      { projectId: "pabcdefghij", name: "tab" },
      client(["operator.admin"]),
      broker,
    );
    expect(ok).toBe(false);
    expect(err?.details).toEqual({ code: "read-mode" });
  });

  it("terminal events go only to admin connections of the owner", () => {
    const ws = (scopes: string[], extra: Partial<GatewayWsClient> = {}) =>
      ({
        connect: { role: "operator", scopes },
        connId: "c",
        ...extra,
      }) as unknown as GatewayWsClient;
    expect(mayReceiveTerminalEvent(ws(["operator.admin"]), "owner")).toBe(true);
    expect(mayReceiveTerminalEvent(ws(["operator.write"]), "owner")).toBe(false);
    expect(mayReceiveTerminalEvent(ws(["operator.admin"]), "device:abc")).toBe(false);
    const paired = ws(["operator.admin"], {
      pairing: { scope: "attach", fingerprint: "f".repeat(64) } as GatewayWsClient["pairing"],
    });
    expect(mayReceiveTerminalEvent(paired, `pair:${"f".repeat(12)}`)).toBe(false);
  });
});
