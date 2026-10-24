import { generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EntraOidcValidator, OidcValidationError } from "./oidc.js";
import { jsonResponse, mockFetch, on } from "./test-helpers.js";

// A local test key stands in for the tenant's signing key; nothing is fetched from Microsoft.
const TENANT = "11111111-2222-3333-4444-555555555555";
const OTHER_TENANT = "99999999-8888-7777-6666-555555555555";
const CLIENT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NOW = Date.parse("2026-10-23T09:00:00Z");
const nowSec = Math.floor(NOW / 1000);

const signing = generateKeyPairSync("rsa", { modulusLength: 2048 });
const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });

function jwk(key: KeyObject, kid: string) {
  const j = key.export({ format: "jwk" }) as { n: string; e: string };
  return { kty: "RSA", use: "sig", kid, n: j.n, e: j.e };
}

function b64(obj: unknown) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function token(
  claims: Record<string, unknown>,
  opts: { kid?: string; alg?: string; key?: KeyObject } = {},
): string {
  const header = b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1", typ: "JWT" });
  const payload = b64(claims);
  const sig = sign(
    "RSA-SHA256",
    Buffer.from(`${header}.${payload}`),
    opts.key ?? signing.privateKey,
  );
  return `${header}.${payload}.${sig.toString("base64url")}`;
}

function claims(over: Record<string, unknown> = {}) {
  return {
    iss: `https://login.microsoftonline.com/${TENANT}/v2.0`,
    aud: CLIENT_ID,
    sub: "subject-1",
    tid: TENANT,
    oid: "00000000-0000-0000-0000-000000000001",
    iat: nowSec - 60,
    nbf: nowSec - 60,
    exp: nowSec + 3600,
    name: "Test User",
    ...over,
  };
}

function setup(
  opts: { tenant?: string; allowed?: string[]; jwksUri?: string; keys?: unknown[] } = {},
) {
  const tenant = opts.tenant ?? TENANT;
  const fetch = mockFetch([
    on(
      "GET",
      `https://login.microsoftonline.com/${tenant}/v2.0/.well-known/openid-configuration`,
      () =>
        jsonResponse({
          issuer:
            tenant === "organizations"
              ? "https://login.microsoftonline.com/{tenantid}/v2.0"
              : `https://login.microsoftonline.com/${TENANT}/v2.0`,
          jwks_uri:
            opts.jwksUri ?? `https://login.microsoftonline.com/${tenant}/discovery/v2.0/keys`,
        }),
    ),
    on("GET", /\/discovery\/v2\.0\/keys$/, () =>
      jsonResponse({ keys: opts.keys ?? [jwk(signing.publicKey, "k1")] }),
    ),
  ]);
  const validator = new EntraOidcValidator({
    tenantId: tenant,
    clientId: CLIENT_ID,
    allowedTenants: opts.allowed,
    fetch,
    now: () => NOW,
  });
  return { validator, fetch };
}

async function reason(p: Promise<unknown>) {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OidcValidationError);
  return (err as OidcValidationError).reason;
}

describe("Entra ID token validation", () => {
  it("accepts a valid token and returns its identity claims", async () => {
    const { validator } = setup();
    const c = await validator.validate(token(claims({ nonce: "n1" })), { nonce: "n1" });
    expect(c).toMatchObject({ sub: "subject-1", tid: TENANT, aud: CLIENT_ID, name: "Test User" });
  });

  it("rejects expired, not-yet-valid and nonce mismatch", async () => {
    const { validator } = setup();
    expect(await reason(validator.validate(token(claims({ exp: nowSec - 600 }))))).toBe("expired");
    expect(await reason(validator.validate(token(claims({ nbf: nowSec + 600 }))))).toBe(
      "not_yet_valid",
    );
    expect(
      await reason(validator.validate(token(claims({ nonce: "other" })), { nonce: "n1" })),
    ).toBe("nonce_mismatch");
  });

  it("rejects the wrong audience and the wrong issuer", async () => {
    const { validator } = setup();
    expect(
      await reason(
        validator.validate(token(claims({ aud: "ffffffff-0000-0000-0000-000000000000" }))),
      ),
    ).toBe("wrong_audience");
    expect(
      await reason(validator.validate(token(claims({ iss: "https://sts.windows.net/x/" })))),
    ).toBe("wrong_issuer");
  });

  it("rejects a bad signature, alg none/HS256 and garbage", async () => {
    const { validator } = setup();
    expect(await reason(validator.validate(token(claims(), { key: attacker.privateKey })))).toBe(
      "bad_signature",
    );
    const parts = token(claims()).split(".");
    const tampered = `${parts[0]}.${b64(claims({ sub: "admin" }))}.${parts[2]}`;
    expect(await reason(validator.validate(tampered))).toBe("bad_signature");
    const none = `${b64({ alg: "none", kid: "k1" })}.${b64(claims())}.`;
    expect(await reason(validator.validate(none))).toBe("unsupported_alg");
    const hs = `${b64({ alg: "HS256", kid: "k1" })}.${b64(claims())}.${parts[2]}`;
    expect(await reason(validator.validate(hs))).toBe("unsupported_alg");
    expect(await reason(validator.validate("not.a.jwt!"))).toBe("malformed");
  });

  it("restricts multi-tenant sign-in to the allowlist", async () => {
    const { validator } = setup({ tenant: "organizations", allowed: [TENANT] });
    await expect(validator.validate(token(claims()))).resolves.toMatchObject({ tid: TENANT });
    const foreign = token(
      claims({ tid: OTHER_TENANT, iss: `https://login.microsoftonline.com/${OTHER_TENANT}/v2.0` }),
    );
    expect(await reason(validator.validate(foreign))).toBe("wrong_tenant");
    expect(
      () => new EntraOidcValidator({ tenantId: "organizations", clientId: CLIENT_ID }),
    ).toThrow(/allowedTenants/);
  });

  it("caches the JWKS and refetches an unknown kid at most once per cooldown", async () => {
    const { validator, fetch } = setup();
    await validator.validate(token(claims()));
    await validator.validate(token(claims()));
    expect(fetch.calls).toHaveLength(2); // discovery + keys, once
    expect(await reason(validator.validate(token(claims(), { kid: "rolled" })))).toBe(
      "unknown_key",
    );
    expect(await reason(validator.validate(token(claims(), { kid: "rolled" })))).toBe(
      "unknown_key",
    );
    expect(fetch.calls).toHaveLength(4); // one forced refetch, then the cooldown holds
  });

  it("refuses key documents from outside the Microsoft login host", async () => {
    const { validator } = setup({ jwksUri: "https://attacker.example/keys" });
    expect(await reason(validator.validate(token(claims())))).toBe("discovery_failed");
  });
});
