import { describe, expect, it } from "vitest";
import { getPairedDevice, requestDevicePairing } from "../../infra/device-pairing.js";
import { deviceHandlers } from "./devices.js";

type Res = { ok: boolean; payload?: unknown; error?: { message?: string; details?: unknown } };

async function call(method: string, params: Record<string, unknown>, scopes: string[]) {
  let out: Res = { ok: false };
  await deviceHandlers[method]?.({
    req: { type: "req", id: "1", method, params },
    params,
    client: { connect: { role: "operator", scopes } },
    isWebchatConnect: () => false,
    respond: (ok: boolean, payload?: unknown, error?: Res["error"]) => {
      out = { ok, payload, error };
    },
    context: {
      logGateway: { info: () => undefined },
      broadcast: () => undefined,
    },
  } as unknown as Parameters<NonNullable<(typeof deviceHandlers)[string]>>[0]);
  return out;
}

const code = (r: Res) => (r.error?.details as { code?: string } | undefined)?.code;

describe("device pairing scope ceiling", () => {
  it("an operator.pairing holder cannot approve a request for operator.admin", async () => {
    const pending = await requestDevicePairing({
      deviceId: "ceiling-device-1",
      publicKey: "public-key-ceiling-1",
      role: "operator",
      scopes: ["operator.admin"],
    });
    const pairingOnly = ["operator.pairing", "operator.read"];
    const refused = await call(
      "device.pair.approve",
      { requestId: pending.request.requestId },
      pairingOnly,
    );
    expect(refused.ok).toBe(false);
    expect(code(refused)).toBe("scope_ceiling");
    expect(await getPairedDevice("ceiling-device-1")).toBeNull();
    // The owner (operator.admin) may approve it.
    const approved = await call("device.pair.approve", { requestId: pending.request.requestId }, [
      "operator.admin",
    ]);
    expect(approved.ok).toBe(true);
  });

  it("device.token.rotate never mints scopes the caller lacks, nor returns such a token", async () => {
    const pending = await requestDevicePairing({
      deviceId: "ceiling-device-2",
      publicKey: "public-key-ceiling-2",
      role: "operator",
      scopes: ["operator.read"],
    });
    const pairing = ["operator.pairing", "operator.read", "operator.write"];
    expect(
      (await call("device.pair.approve", { requestId: pending.request.requestId }, pairing)).ok,
    ).toBe(true);
    for (const scopes of [["operator.admin"], ["operator.config"], ["operator.approvals"]]) {
      const res = await call(
        "device.token.rotate",
        { deviceId: "ceiling-device-2", role: "operator", scopes },
        pairing,
      );
      expect(res.ok, scopes[0]).toBe(false);
      expect(code(res), scopes[0]).toBe("scope_ceiling");
      expect(JSON.stringify(res)).not.toMatch(/"token"/);
    }
    const paired = await getPairedDevice("ceiling-device-2");
    expect(paired?.tokens?.operator?.scopes).toEqual(["operator.read"]);
    // Within the ceiling: fine (operator.write also covers operator.read).
    const ok = await call(
      "device.token.rotate",
      {
        deviceId: "ceiling-device-2",
        role: "operator",
        scopes: ["operator.read", "operator.write"],
      },
      ["operator.pairing", "operator.write"],
    );
    expect(ok.ok).toBe(true);
    expect((ok.payload as { scopes?: string[] }).scopes).toEqual([
      "operator.read",
      "operator.write",
    ]);
  });
});
