// Business connectors: OpenID Connect ID token validation for Microsoft Entra ID sign-in.
//
// Checks, in order: compact JWS shape; `alg` is RS256 (never `none` or HMAC); `kid` names a key
// in the tenant's JWKS (cached, refetched at most once per cooldown on an unknown kid); RSA
// signature; `iss` equals the tenant's issuer; `tid` is an allowed tenant; `aud` is the app's
// client id; `exp`/`nbf`/`iat` within the clock skew; `nonce` when the caller expects one.
// Discovery and JWKS documents are fetched only from the Microsoft login host.
import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import { ConnectorError } from "./errors.js";
import { type FetchLike, readJson, requestWithRetry, type Sleep } from "./http.js";
import { isValidTenant, MICROSOFT_LOGIN_HOST } from "./microsoft.js";

export type OidcFailure =
  | "malformed"
  | "unsupported_alg"
  | "unknown_key"
  | "bad_signature"
  | "wrong_issuer"
  | "wrong_tenant"
  | "wrong_audience"
  | "expired"
  | "not_yet_valid"
  | "nonce_mismatch"
  | "discovery_failed";

export class OidcValidationError extends Error {
  constructor(public readonly reason: OidcFailure) {
    super(`ID token rejected: ${reason}`);
    this.name = "OidcValidationError";
  }
}

export type EntraIdClaims = {
  iss: string;
  aud: string;
  sub: string;
  tid: string;
  oid?: string;
  exp: number;
  iat?: number;
  nbf?: number;
  nonce?: string;
  name?: string;
  preferred_username?: string;
  email?: string;
};

export type EntraOidcOptions = {
  /** Tenant GUID (or verified domain) the app is registered in, or `organizations`. */
  tenantId: string;
  /** Application (client) id: the expected `aud`. */
  clientId: string;
  /** Tenant GUIDs allowed to sign in. Default: the configured tenant only. Required for `organizations`. */
  allowedTenants?: string[];
  fetch?: FetchLike;
  sleep?: Sleep;
  now?: () => number;
  clockSkewSec?: number;
  jwksTtlMs?: number;
  /** Minimum time between JWKS refetches triggered by an unknown kid. */
  jwksCooldownMs?: number;
};

type Jwks = { keys?: Array<{ kid?: string; use?: string; kty?: string; n?: string; e?: string }> };

function b64urlDecode(part: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) {
    throw new OidcValidationError("malformed");
  }
  return Buffer.from(part, "base64url");
}

function parseJsonPart(part: string): Record<string, unknown> {
  try {
    const v = JSON.parse(b64urlDecode(part).toString("utf8")) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) {
      throw new Error("not an object");
    }
    return v as Record<string, unknown>;
  } catch (err) {
    if (err instanceof OidcValidationError) {
      throw err;
    }
    throw new OidcValidationError("malformed");
  }
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class EntraOidcValidator {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private lastForcedFetch = 0;
  private issuerTemplate: string | undefined;
  private jwksUri: string | undefined;
  private readonly allowed: Set<string>;

  constructor(private readonly opts: EntraOidcOptions) {
    if (!isValidTenant(opts.tenantId)) {
      throw new ConnectorError("not_configured", "invalid tenantId");
    }
    if (!GUID.test(opts.clientId)) {
      throw new ConnectorError("not_configured", "invalid clientId");
    }
    const list = (opts.allowedTenants ?? []).map((t) => t.toLowerCase());
    if (opts.tenantId === "organizations" && list.length === 0) {
      throw new ConnectorError(
        "not_configured",
        "allowedTenants is required for multi-tenant sign-in",
      );
    }
    this.allowed = new Set(
      list.length > 0 ? list : GUID.test(opts.tenantId) ? [opts.tenantId.toLowerCase()] : [],
    );
  }

  /** Explicit list; else the configured tenant GUID; else the GUID in the discovered issuer. */
  private allowedTenants(): Set<string> {
    if (this.allowed.size > 0) {
      return this.allowed;
    }
    const m = /\/([0-9a-f-]{36})\/v2\.0$/i.exec(this.issuerTemplate ?? "");
    return new Set(m ? [m[1].toLowerCase()] : []);
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private async getJson(url: string): Promise<Record<string, unknown>> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== MICROSOFT_LOGIN_HOST) {
      throw new OidcValidationError("discovery_failed");
    }
    try {
      const res = await requestWithRetry(
        url,
        { method: "GET", redirect: "error" },
        {
          fetch: this.opts.fetch,
          sleep: this.opts.sleep,
          maxRetries: 2,
        },
      );
      if (!res.ok) {
        throw new Error(String(res.status));
      }
      return await readJson<Record<string, unknown>>(res, 512 * 1024);
    } catch {
      throw new OidcValidationError("discovery_failed");
    }
  }

  /** Fetch discovery + JWKS. Exposed for the health probe. */
  async refreshKeys(): Promise<number> {
    const discoveryUrl = `https://${MICROSOFT_LOGIN_HOST}/${encodeURIComponent(this.opts.tenantId)}/v2.0/.well-known/openid-configuration`;
    const doc = await this.getJson(discoveryUrl);
    if (typeof doc.issuer !== "string" || typeof doc.jwks_uri !== "string") {
      throw new OidcValidationError("discovery_failed");
    }
    this.issuerTemplate = doc.issuer;
    this.jwksUri = doc.jwks_uri;
    const jwks = (await this.getJson(this.jwksUri)) as Jwks;
    const next = new Map<string, KeyObject>();
    for (const jwk of jwks.keys ?? []) {
      if (jwk.kty !== "RSA" || typeof jwk.kid !== "string" || (jwk.use && jwk.use !== "sig")) {
        continue;
      }
      try {
        next.set(
          jwk.kid,
          createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }),
        );
      } catch {
        // Skip malformed keys; others may still be valid.
      }
    }
    if (next.size === 0) {
      throw new OidcValidationError("discovery_failed");
    }
    this.keys = next;
    this.fetchedAt = this.now();
    return next.size;
  }

  private async keyFor(kid: string): Promise<KeyObject> {
    const ttl = this.opts.jwksTtlMs ?? 6 * 3600_000;
    if (this.keys.size === 0 || this.now() - this.fetchedAt > ttl) {
      await this.refreshKeys();
    }
    let key = this.keys.get(kid);
    const cooldown = this.opts.jwksCooldownMs ?? 5 * 60_000;
    if (!key && this.now() - this.lastForcedFetch > cooldown) {
      // Keys roll over; an unknown kid triggers one refetch, rate limited.
      this.lastForcedFetch = this.now();
      await this.refreshKeys();
      key = this.keys.get(kid);
    }
    if (!key) {
      throw new OidcValidationError("unknown_key");
    }
    return key;
  }

  async validate(idToken: string, expect: { nonce?: string } = {}): Promise<EntraIdClaims> {
    const parts = typeof idToken === "string" ? idToken.split(".") : [];
    if (parts.length !== 3 || idToken.length > 16_384) {
      throw new OidcValidationError("malformed");
    }
    const header = parseJsonPart(parts[0]);
    const payload = parseJsonPart(parts[1]);
    if (header.alg !== "RS256") {
      throw new OidcValidationError("unsupported_alg");
    }
    if (typeof header.kid !== "string" || !header.kid) {
      throw new OidcValidationError("unknown_key");
    }
    const key = await this.keyFor(header.kid);
    const ok = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
      key,
      b64urlDecode(parts[2]),
    );
    if (!ok) {
      throw new OidcValidationError("bad_signature");
    }

    const tid = typeof payload.tid === "string" ? payload.tid.toLowerCase() : "";
    if (!GUID.test(tid)) {
      throw new OidcValidationError("wrong_tenant");
    }
    const expectedIssuer = (this.issuerTemplate ?? "").replace("{tenantid}", tid);
    if (!expectedIssuer || payload.iss !== expectedIssuer) {
      throw new OidcValidationError("wrong_issuer");
    }
    if (!this.allowedTenants().has(tid)) {
      throw new OidcValidationError("wrong_tenant");
    }
    const aud = payload.aud;
    if (aud !== this.opts.clientId) {
      throw new OidcValidationError("wrong_audience");
    }
    const nowSec = Math.floor(this.now() / 1000);
    const skew = this.opts.clockSkewSec ?? 120;
    if (typeof payload.exp !== "number" || payload.exp + skew <= nowSec) {
      throw new OidcValidationError("expired");
    }
    if (typeof payload.nbf === "number" && payload.nbf - skew > nowSec) {
      throw new OidcValidationError("not_yet_valid");
    }
    if (typeof payload.iat === "number" && payload.iat - skew > nowSec) {
      throw new OidcValidationError("not_yet_valid");
    }
    if (expect.nonce !== undefined && payload.nonce !== expect.nonce) {
      throw new OidcValidationError("nonce_mismatch");
    }
    if (typeof payload.sub !== "string" || !payload.sub) {
      throw new OidcValidationError("malformed");
    }
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    return {
      iss: payload.iss,
      aud,
      sub: payload.sub,
      tid,
      oid: str(payload.oid),
      exp: payload.exp,
      iat: typeof payload.iat === "number" ? payload.iat : undefined,
      nbf: typeof payload.nbf === "number" ? payload.nbf : undefined,
      nonce: str(payload.nonce),
      name: str(payload.name),
      preferred_username: str(payload.preferred_username),
      email: str(payload.email),
    };
  }
}
