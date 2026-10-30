// SPDX-License-Identifier: MIT
import { createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  KoloClient,
  KoloPairError,
  deviceConnectPayload,
  discover,
  generateDeviceKey,
  pair,
  pairProofPayload,
  readDeviceCredential,
  refresh,
  signWithDeviceKey,
} from "../src/index.js";

type Call = { url: string; init: RequestInit; body: Record<string, unknown> };

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

function verifyRaw(publicKeyB64url: string, payload: string, signatureB64url: string): boolean {
  const key = createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKeyB64url, "base64url")]),
    type: "spki",
    format: "der",
  });
  return verify(null, Buffer.from(payload, "utf8"), key, Buffer.from(signatureB64url, "base64url"));
}

/** A tiny fake gateway: nonces, redeem, refresh with reuse detection, /api/pair/me. */
function fakeGateway() {
  const calls: Call[] = [];
  const nonces = new Set<string>();
  const families = new Map<
    string,
    {
      refresh: string;
      retired: Set<string>;
      revoked: boolean;
      publicKey: string;
      generation: number;
    }
  >();
  const accessToFamily = new Map<string, string>();
  let counter = 0;
  const issue = (familyId: string) => {
    const fam = families.get(familyId)!;
    const accessToken = `kpa_access${++counter}`;
    fam.refresh = `kpr_refresh${counter}`;
    accessToFamily.set(accessToken, familyId);
    return {
      ok: true,
      device: { fingerprint: "fp", name: "dev", scope: "attach", status: "approved" },
      familyId,
      generation: fam.generation,
      accessToken,
      accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      refreshToken: fam.refresh,
      refreshExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
  };
  const fetch = async (url: string, init: RequestInit = {}) => {
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
    calls.push({ url, init, body });
    const { pathname } = new URL(url);
    if (pathname === "/api/pair/nonce") {
      const nonce = `n${++counter}`;
      nonces.add(nonce);
      return json(200, {
        ok: true,
        nonce,
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
    }
    if (pathname === "/api/pair/redeem") {
      if (!nonces.delete(String(body.nonce))) {
        return json(401, { ok: false, error: "invalid_nonce" });
      }
      const payload = await pairProofPayload("redeem", String(body.nonce), String(body.code));
      if (!verifyRaw(String(body.deviceKeyPub), payload, String(body.signature))) {
        return json(401, { ok: false, error: "invalid_signature" });
      }
      if (body.code !== "kpi_good") {
        return json(401, { ok: false, error: "invalid_code" });
      }
      const familyId = `fam${++counter}`;
      families.set(familyId, {
        refresh: "",
        retired: new Set(),
        revoked: false,
        publicKey: String(body.deviceKeyPub),
        generation: 0,
      });
      return json(200, issue(familyId));
    }
    if (pathname === "/api/pair/refresh") {
      if (!nonces.delete(String(body.nonce))) {
        return json(401, { ok: false, error: "invalid_nonce" });
      }
      const token = String(body.refreshToken);
      for (const [id, fam] of families) {
        if (fam.retired.has(token)) {
          fam.revoked = true;
          return json(401, { ok: false, error: "reuse_detected" });
        }
        if (fam.refresh === token) {
          if (fam.revoked) {
            return json(401, { ok: false, error: "family_revoked" });
          }
          const payload = await pairProofPayload("refresh", String(body.nonce), token);
          if (!verifyRaw(fam.publicKey, payload, String(body.signature))) {
            return json(401, { ok: false, error: "invalid_signature" });
          }
          fam.retired.add(token);
          fam.generation += 1;
          return json(200, issue(id));
        }
      }
      return json(401, { ok: false, error: "invalid_token" });
    }
    if (pathname === "/api/pair/me") {
      const auth = new Headers(init.headers).get("authorization") ?? "";
      const familyId = accessToFamily.get(auth.replace(/^Bearer /, ""));
      const fam = familyId ? families.get(familyId) : undefined;
      if (!fam || fam.revoked) {
        return json(401, { error: { message: "Unauthorized", type: "unauthorized" } });
      }
      return json(200, {
        ok: true,
        principal: {
          kind: "pair",
          scope: "attach",
          fingerprint: "fp",
          deviceName: "dev",
          familyId,
          accessExpiresAt: "x",
        },
      });
    }
    return json(404, { error: "nope" });
  };
  return { fetch, calls, families };
}

describe("@kodasoken/kurahi-client pairing helpers (M3a)", () => {
  let home: string;
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-client-pair-"));
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("generates an Ed25519 key whose fingerprint is sha256(raw public key) and signs payloads", async () => {
    const key = await generateDeviceKey();
    expect(key.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(key.publicKey, "base64url")).toHaveLength(32);
    const sig = await signWithDeviceKey(key.privateKeyPem, "hello");
    expect(verifyRaw(key.publicKey, "hello", sig)).toBe(true);
    expect(verifyRaw(key.publicKey, "hellO", sig)).toBe(false);
    expect(
      deviceConnectPayload({
        deviceId: "d",
        clientId: "c",
        clientMode: "m",
        role: "operator",
        scopes: ["a", "b"],
        signedAtMs: 5,
        token: "t",
        nonce: "n",
      }),
    ).toBe("v2|d|c|m|operator|a,b|5|t|n");
    expect(
      deviceConnectPayload({
        deviceId: "d",
        clientId: "c",
        clientMode: "m",
        role: "operator",
        scopes: [],
        signedAtMs: 5,
      }),
    ).toBe("v1|d|c|m|operator||5|");
  });

  it("pair() proves the key over a server nonce, stores the credential 0600 and discover() picks it up", async () => {
    const gw = fakeGateway();
    const result = await pair({
      code: "kpi_good",
      baseUrl: "http://127.0.0.1:4321",
      deviceName: "laptop",
      home,
      fetch: gw.fetch,
    });
    expect(result.file).toBe(
      path.join(home, "secrets", "devices", `${result.credential.fingerprint}.json`),
    );
    expect(result.credential).toMatchObject({
      scope: "attach",
      status: "approved",
      gateway: "http://127.0.0.1:4321",
    });
    expect(result.credential.accessToken).toMatch(/^kpa_/);
    if (process.platform !== "win32") {
      expect(fs.statSync(result.file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.dirname(result.file)).mode & 0o777).toBe(0o700);
    }
    expect(gw.calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/pair/nonce",
      "/api/pair/redeem",
    ]);
    expect(gw.calls[1].body).toMatchObject({ code: "kpi_good", deviceName: "laptop" });

    // No gateway token anywhere: discover() offers the device credential.
    const found = await discover({ home, env: { KOLO_GATEWAY_PORT: "4321" } });
    expect(found.tokenSource).toBe("device");
    expect(found.token).toBe(result.credential.accessToken);
    expect(found.device).toMatchObject({
      fingerprint: result.credential.fingerprint,
      scope: "attach",
      expired: false,
    });
    // A gateway token still wins.
    const withToken = await discover({
      home,
      env: { KOLO_GATEWAY_PORT: "4321", KOLO_GATEWAY_TOKEN: "owner" },
    });
    expect(withToken.tokenSource).toBe("env");
    expect(withToken.device?.fingerprint).toBe(result.credential.fingerprint);
    // Another gateway's URL does not match the stored credential.
    const elsewhere = await discover({ home, env: { KOLO_GATEWAY_PORT: "9999" } });
    expect(elsewhere.tokenSource).toBe("none");
    expect(elsewhere.device).toBeUndefined();
  });

  it("rejects a bad code without writing anything", async () => {
    const gw = fakeGateway();
    await expect(
      pair({ code: "kpi_bad", baseUrl: "http://127.0.0.1:4321", home, fetch: gw.fetch }),
    ).rejects.toMatchObject({ name: "KoloPairError", reason: "invalid_code", status: 401 });
    expect(fs.existsSync(path.join(home, "secrets", "devices"))).toBe(false);
  });

  it("refresh() rotates the file and surfaces reuse as a dead family", async () => {
    const gw = fakeGateway();
    const paired = await pair({
      code: "kpi_good",
      baseUrl: "http://127.0.0.1:4321",
      home,
      fetch: gw.fetch,
    });
    const before = paired.credential;
    const rotated = await refresh({ file: paired.file, fetch: gw.fetch });
    expect(rotated.credential.generation).toBe(1);
    expect(rotated.credential.accessToken).not.toBe(before.accessToken);
    expect(rotated.credential.refreshToken).not.toBe(before.refreshToken);
    expect(rotated.credential.privateKeyPem).toBe(before.privateKeyPem);
    expect((await readDeviceCredential(paired.file))?.accessToken).toBe(
      rotated.credential.accessToken,
    );

    // Replay the retired refresh token: the fake gateway revokes the family; the file drops its tokens.
    fs.writeFileSync(
      paired.file,
      JSON.stringify({ ...rotated.credential, refreshToken: before.refreshToken }),
    );
    await expect(refresh({ file: paired.file, fetch: gw.fetch })).rejects.toBeInstanceOf(
      KoloPairError,
    );
    const after = await readDeviceCredential(paired.file);
    expect(after?.accessToken).toBe("");
    expect(after?.refreshToken).toBe("");
    const found = await discover({ home, env: { KOLO_GATEWAY_PORT: "4321" } });
    expect(found.tokenSource).toBe("none");
  });

  it("KoloClient.local() refreshes an expired device credential and sends it as Bearer", async () => {
    const gw = fakeGateway();
    const paired = await pair({
      code: "kpi_good",
      baseUrl: "http://127.0.0.1:4321",
      home,
      fetch: gw.fetch,
    });
    fs.writeFileSync(
      paired.file,
      JSON.stringify({
        ...paired.credential,
        accessExpiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    const client = await KoloClient.local({
      discover: { home, env: { KOLO_GATEWAY_PORT: "4321" } },
      fetch: gw.fetch,
    });
    expect(client.discovered.tokenSource).toBe("device");
    expect(client.hasToken).toBe(true);
    const me = await client.getPairPrincipal();
    expect(me.principal).toMatchObject({ kind: "pair", scope: "attach" });
    const last = gw.calls.at(-1)!;
    expect(new Headers(last.init.headers).get("authorization")).toMatch(/^Bearer kpa_/);
    expect((await readDeviceCredential(paired.file))?.generation).toBe(1);
  });
});

describe("discover: kurahi login session", () => {
  it("offers a live person session for the gateway only as the last resort", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-sso-discover-"));
    try {
      const dir = path.join(home, "secrets", "sessions");
      fs.mkdirSync(dir, { recursive: true });
      const write = (name: string, over: Record<string, unknown>) =>
        fs.writeFileSync(
          path.join(dir, name),
          JSON.stringify({
            version: 1,
            gateway: "http://127.0.0.1:4321",
            token: "kss_person",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            ...over,
          }),
        );
      write("a.json", {});
      const env = { KOLO_GATEWAY_PORT: "4321" };
      const found = await discover({ home, env });
      expect(found.tokenSource).toBe("sso");
      expect(found.token).toBe("kss_person");
      expect(
        (await discover({ home, env: { ...env, KOLO_GATEWAY_TOKEN: "owner" } })).tokenSource,
      ).toBe("env");
      expect((await discover({ home, env: { KOLO_GATEWAY_PORT: "9999" } })).tokenSource).toBe(
        "none",
      );
      write("a.json", { expiresAt: new Date(Date.now() - 1000).toISOString() });
      expect((await discover({ home, env })).tokenSource).toBe("none");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
