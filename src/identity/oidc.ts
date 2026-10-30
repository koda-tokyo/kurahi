// OpenID Connect relying party: authorization code flow with PKCE (S256), state and nonce.
// Works with any provider that publishes discovery (Entra ID, Google, Okta, Keycloak, …).
//
// begin():    a single-use `state` (10 minutes) carrying the nonce, PKCE verifier and return path.
// complete(): the state is consumed before anything else (a replayed callback finds nothing),
//             the code is exchanged with the verifier, and the ID token must pass: alg allowlist,
//             JWKS key by kid (one rate-limited refetch on an unknown kid), signature, issuer
//             (exact, or the configured multi-tenant template with an allowed tenant), audience
//             (and azp when several audiences), exp / nbf / iat within the skew, iat not older
//             than the flow, and the nonce of this flow. A nonce is accepted once.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { IdentityOidcProviderConfig } from "../config/types.identity.js";
import type { SignInClaims } from "./types.js";
import { type FetchLike, readCapped } from "../connectors/business/http.js";
import { decodeJws, importJwks, type Jwk, JwsError, verifyJwsSignature } from "./jose.js";

export type OidcFailure =
  | "state_unknown"
  | "browser_mismatch"
  | "provider_error"
  | "discovery_failed"
  | "token_exchange_failed"
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
  | "nonce_replayed"
  | "domain_not_allowed"
  | "too_many_pending"
  | "not_fresh";

export class OidcError extends Error {
  constructor(readonly reason: OidcFailure) {
    super(`sign-in refused: ${reason}`);
    this.name = "OidcError";
  }
}

type Discovery = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
};

type Pending = {
  providerId: string;
  /** Who started it (client address, "local"): per-source quota. */
  source: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  createdAt: number;
  binding: string | null;
  /** A step-up re-authentication for this live session (not a sign-in). */
  stepUp: { sessionId: string; personId: string } | null;
};

const STATE_TTL_MS = 10 * 60_000;
const MAX_PENDING = 2_000;
/** Open sign-ins per source; a source over it replaces its own oldest, never someone else's. */
export const MAX_PENDING_PER_SOURCE = 20;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_NONCES = 10_000;
const DISCOVERY_TTL_MS = 3600_000;
const JWKS_TTL_MS = 6 * 3600_000;
const JWKS_COOLDOWN_MS = 60_000;
const DEFAULT_ALGS = ["RS256", "PS256", "ES256"];

const rand = () => randomBytes(32).toString("base64url");

/**
 * The domain of an e-mail address: the part after its only "@". An address with no "@", more
 * than one, or an empty side has no domain (and is not used as an e-mail).
 */
export function emailDomain(email: string | null | undefined): string | null {
  if (!email) {
    return null;
  }
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1 || email.indexOf("@") !== at) {
    return null;
  }
  return email.slice(at + 1).toLowerCase();
}

/**
 * Bounded store of in-flight sign-ins (OIDC state, SAML request id). A flood from one source
 * replaces that source's own oldest entry; when the store is full, new sign-ins are refused
 * instead of evicting other people's live ones.
 */
export class PendingQuota<T extends { source: string; createdAt: number }> {
  private entries = new Map<string, T>();
  constructor(
    private readonly max: number,
    private readonly perSource: number,
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly onDrop: (key: string, entry: T) => void = () => {},
  ) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): T | undefined {
    return this.entries.get(key);
  }

  take(key: string): T | undefined {
    const e = this.entries.get(key);
    if (e) {
      this.entries.delete(key);
    }
    return e;
  }

  prune(): void {
    const now = this.now();
    for (const [k, v] of this.entries) {
      if (now - v.createdAt > this.ttlMs) {
        this.entries.delete(k);
        this.onDrop(k, v);
      }
    }
  }

  /** Add an entry; false when the store is full (the caller refuses the sign-in). */
  add(key: string, entry: T): boolean {
    this.prune();
    const mine = [...this.entries].filter(([, v]) => v.source === entry.source);
    if (mine.length >= this.perSource) {
      const [oldestKey, oldest] = mine[0];
      this.entries.delete(oldestKey);
      this.onDrop(oldestKey, oldest);
    } else if (this.entries.size >= this.max) {
      return false;
    }
    this.entries.set(key, entry);
    return true;
  }
}

/** Constant-time comparison of two short secrets. */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}
export const pkceChallenge = (verifier: string) =>
  createHash("sha256").update(verifier, "ascii").digest("base64url");

function isHttps(url: unknown): url is string {
  if (typeof url !== "string") {
    return false;
  }
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export type OidcClientOptions = {
  fetch?: FetchLike;
  now?: () => number;
  clockSkewSec?: number;
  /** Timeout of each IdP request (discovery, JWKS, token endpoint); default 10 s. */
  fetchTimeoutMs?: number;
};

export class OidcClient {
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;
  private readonly skewSec: number;
  private readonly fetchTimeoutMs: number;
  private pending: PendingQuota<Pending>;
  private usedNonces = new Map<string, number>();
  private discovery = new Map<string, { doc: Discovery; at: number }>();
  private keys = new Map<
    string,
    { keys: ReturnType<typeof importJwks>; at: number; forcedAt: number }
  >();

  constructor(opts: OidcClientOptions = {}) {
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.skewSec = opts.clockSkewSec ?? 120;
    this.fetchTimeoutMs = opts.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    this.pending = new PendingQuota(MAX_PENDING, MAX_PENDING_PER_SOURCE, STATE_TTL_MS, this.now);
  }

  private async getJson(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    if (!isHttps(url)) {
      throw new OidcError("discovery_failed");
    }
    // A hung IdP must not hold a sign-in (or the request handling it) open indefinitely.
    const res = await this.fetchFn(url, {
      redirect: "error",
      signal: AbortSignal.timeout(this.fetchTimeoutMs),
      ...init,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const body = JSON.parse((await readCapped(res, 512 * 1024)).toString("utf8")) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body as Record<string, unknown>;
  }

  async discover(p: IdentityOidcProviderConfig): Promise<Discovery> {
    const cached = this.discovery.get(p.id);
    if (cached && this.now() - cached.at < DISCOVERY_TTL_MS) {
      return cached.doc;
    }
    const issuer = p.issuer.replace(/\/+$/, "");
    let doc: Record<string, unknown>;
    try {
      doc = await this.getJson(`${issuer}/.well-known/openid-configuration`);
    } catch {
      throw new OidcError("discovery_failed");
    }
    // The discovered issuer must be the configured one (template for multi-tenant Entra ID).
    const discovered = typeof doc.issuer === "string" ? doc.issuer.replace(/\/+$/, "") : "";
    const multiTenant =
      discovered.includes("{tenantid}") &&
      Boolean(p.allowedTenants?.length) &&
      isHttps(discovered.replace("{tenantid}", "t")) &&
      new URL(discovered.replace("{tenantid}", "t")).origin === new URL(issuer).origin;
    if (discovered !== issuer && !multiTenant) {
      throw new OidcError("discovery_failed");
    }
    for (const k of ["authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      if (!isHttps(doc[k])) {
        throw new OidcError("discovery_failed");
      }
    }
    const out: Discovery = {
      issuer: discovered,
      authorization_endpoint: doc.authorization_endpoint as string,
      token_endpoint: doc.token_endpoint as string,
      jwks_uri: doc.jwks_uri as string,
      end_session_endpoint: isHttps(doc.end_session_endpoint)
        ? doc.end_session_endpoint
        : undefined,
    };
    this.discovery.set(p.id, { doc: out, at: this.now() });
    return out;
  }

  private async keyFor(p: IdentityOidcProviderConfig, d: Discovery, kid: string) {
    let entry = this.keys.get(p.id);
    const load = async (forced: boolean) => {
      let jwks: Record<string, unknown>;
      try {
        jwks = await this.getJson(d.jwks_uri);
      } catch {
        throw new OidcError("discovery_failed");
      }
      entry = {
        keys: importJwks(jwks as { keys?: Jwk[] }),
        at: this.now(),
        forcedAt: forced ? this.now() : (entry?.forcedAt ?? 0),
      };
      this.keys.set(p.id, entry);
    };
    if (!entry || this.now() - entry.at > JWKS_TTL_MS) {
      await load(false);
    }
    let key = entry?.keys.get(kid);
    if (!key && entry && this.now() - entry.forcedAt > JWKS_COOLDOWN_MS) {
      // Keys roll over: an unknown kid triggers one refetch, at most once per cooldown.
      await load(true);
      key = entry?.keys.get(kid);
    }
    if (!key) {
      throw new OidcError("unknown_key");
    }
    return key;
  }

  private prune(): void {
    const now = this.now();
    this.pending.prune();
    for (const [k, exp] of this.usedNonces) {
      if (exp < now) {
        this.usedNonces.delete(k);
      }
    }
  }

  /** Start a sign-in; returns the IdP authorization URL. */
  async begin(
    p: IdentityOidcProviderConfig,
    opts: {
      redirectUri: string;
      returnTo: string;
      binding?: string | null;
      /** Client address (or "local") for the per-source quota. */
      source?: string | null;
      /**
       * Step-up for a live session: forces a fresh authentication (`max_age=0`,
       * `prompt=login`, the provider's `stepUpAcrValues`); complete() hands the flow back.
       */
      stepUp?: { sessionId: string; personId: string } | null;
    },
  ): Promise<{ url: string; state: string }> {
    const d = await this.discover(p);
    this.prune();
    const state = rand();
    const pending: Pending = {
      providerId: p.id,
      source: opts.source ?? "local",
      nonce: rand(),
      verifier: rand(),
      returnTo: opts.returnTo,
      binding: opts.binding ?? null,
      createdAt: this.now(),
      stepUp: opts.stepUp ?? null,
    };
    if (!this.pending.add(state, pending)) {
      throw new OidcError("too_many_pending");
    }
    const url = new URL(d.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", p.clientId);
    url.searchParams.set("redirect_uri", opts.redirectUri);
    url.searchParams.set(
      "scope",
      (p.scopes?.length ? p.scopes : ["openid", "profile", "email"]).join(" "),
    );
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", pending.nonce);
    url.searchParams.set("code_challenge", pkceChallenge(pending.verifier));
    url.searchParams.set("code_challenge_method", "S256");
    if (pending.stepUp) {
      url.searchParams.set("max_age", "0");
      url.searchParams.set("prompt", "login");
      if (p.stepUpAcrValues?.length) {
        url.searchParams.set("acr_values", p.stepUpAcrValues.join(" "));
      }
    }
    return { url: url.toString(), state };
  }

  /** Finish a sign-in from the callback query. Throws OidcError; the state is spent either way. */
  async complete(
    p: IdentityOidcProviderConfig,
    query: { code?: string | null; state?: string | null; error?: string | null },
    opts: { redirectUri: string; binding?: string | null },
  ): Promise<{
    claims: SignInClaims;
    returnTo: string;
    stepUp: { sessionId: string; personId: string; startedAt: number } | null;
  }> {
    const state = typeof query.state === "string" ? query.state : "";
    const pending = state ? this.pending.take(state) : undefined;
    if (!pending || pending.providerId !== p.id || this.now() - pending.createdAt > STATE_TTL_MS) {
      throw new OidcError("state_unknown");
    }
    // Login CSRF: the callback must come back to the browser that started the sign-in.
    if (pending.binding !== null && !sameSecret(pending.binding, opts.binding ?? "")) {
      throw new OidcError("browser_mismatch");
    }
    if (query.error || !query.code) {
      throw new OidcError("provider_error");
    }
    const d = await this.discover(p);
    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: query.code,
      redirect_uri: opts.redirectUri,
      client_id: p.clientId,
      code_verifier: pending.verifier,
    });
    const headers: Record<string, string> = {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    };
    if (p.clientSecret) {
      const enc = (v: string) => encodeURIComponent(v);
      headers.Authorization = `Basic ${Buffer.from(`${enc(p.clientId)}:${enc(p.clientSecret)}`).toString("base64")}`;
    }
    let tokens: Record<string, unknown>;
    try {
      tokens = await this.getJson(d.token_endpoint, {
        method: "POST",
        headers,
        body: form.toString(),
      });
    } catch {
      throw new OidcError("token_exchange_failed");
    }
    if (typeof tokens.id_token !== "string") {
      throw new OidcError("token_exchange_failed");
    }
    const claims = await this.validateIdToken(p, tokens.id_token, {
      nonce: pending.nonce,
      flowStartedAt: pending.createdAt,
      // Step-up: the IdP must say when it authenticated (max_age=0 asks for auth_time); the
      // token's issue time would let a cached IdP session pass as a fresh login.
      requireAuthTime: pending.stepUp !== null,
    });
    return {
      claims,
      returnTo: pending.returnTo,
      stepUp: pending.stepUp ? { ...pending.stepUp, startedAt: pending.createdAt } : null,
    };
  }

  /** ID token checks (exported for tests and for providers that post the token directly). */
  async validateIdToken(
    p: IdentityOidcProviderConfig,
    idToken: string,
    expect: { nonce: string; flowStartedAt: number; requireAuthTime?: boolean },
  ): Promise<SignInClaims> {
    const d = await this.discover(p);
    let decoded: ReturnType<typeof decodeJws>;
    try {
      decoded = decodeJws(idToken);
      const kid = decoded.header.kid;
      if (typeof kid !== "string" || !kid) {
        throw new JwsError("unknown_key");
      }
      verifyJwsSignature(decoded, await this.keyFor(p, d, kid), p.algorithms ?? DEFAULT_ALGS);
    } catch (err) {
      if (err instanceof JwsError) {
        throw new OidcError(err.reason);
      }
      throw err;
    }
    const c = decoded.payload;
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    // Issuer: exact, or the multi-tenant template filled with an allowed tenant id.
    const iss = str(c.iss);
    // Compared without a trailing slash (some providers publish `https://idp.example/`).
    let issNorm = iss?.replace(/\/+$/, "") ?? null;
    // Google documents both forms of its issuer in ID tokens.
    if (issNorm === "accounts.google.com" && d.issuer === "https://accounts.google.com") {
      issNorm = d.issuer;
    }
    if (d.issuer.includes("{tenantid}")) {
      const tid = str(c.tid)?.toLowerCase() ?? "";
      if (!tid || issNorm !== d.issuer.replace("{tenantid}", tid)) {
        throw new OidcError("wrong_issuer");
      }
      const allowed = (p.allowedTenants ?? []).map((t) => t.toLowerCase());
      if (!allowed.includes(tid)) {
        throw new OidcError("wrong_tenant");
      }
    } else if (issNorm !== d.issuer) {
      throw new OidcError("wrong_issuer");
    } else if (p.allowedTenants?.length) {
      const tid = str(c.tid)?.toLowerCase() ?? "";
      if (!p.allowedTenants.map((t) => t.toLowerCase()).includes(tid)) {
        throw new OidcError("wrong_tenant");
      }
    }
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(p.clientId) || (aud.length > 1 && c.azp !== p.clientId)) {
      throw new OidcError("wrong_audience");
    }
    const nowSec = Math.floor(this.now() / 1000);
    if (typeof c.exp !== "number" || c.exp + this.skewSec <= nowSec) {
      throw new OidcError("expired");
    }
    if (typeof c.nbf === "number" && c.nbf - this.skewSec > nowSec) {
      throw new OidcError("not_yet_valid");
    }
    if (typeof c.iat !== "number" || c.iat - this.skewSec > nowSec) {
      throw new OidcError("not_yet_valid");
    }
    // A token minted before this flow started cannot belong to it.
    if (c.iat + this.skewSec < Math.floor(expect.flowStartedAt / 1000)) {
      throw new OidcError("expired");
    }
    if (typeof c.nonce !== "string" || c.nonce !== expect.nonce) {
      throw new OidcError("nonce_mismatch");
    }
    const nonceKey = `${p.id}:${c.nonce}`;
    if (this.usedNonces.has(nonceKey)) {
      throw new OidcError("nonce_replayed");
    }
    if (this.usedNonces.size >= MAX_NONCES) {
      this.prune();
    }
    this.usedNonces.set(nonceKey, (c.exp + this.skewSec) * 1000);
    const sub = str(c.sub);
    if (!sub || !iss) {
      throw new OidcError("malformed");
    }
    if (
      expect.requireAuthTime &&
      (typeof c.auth_time !== "number" || c.auth_time > nowSec + this.skewSec)
    ) {
      throw new OidcError("not_fresh");
    }
    // An e-mail is used only when the IdP says it verified it. `preferred_username` and `upn`
    // are login names the user or tenant may choose: never an e-mail.
    const emailRaw = c.email_verified === true ? str(c[p.emailClaim ?? "email"]) : null;
    const email = emailRaw && emailDomain(emailRaw) ? emailRaw.toLowerCase() : null;
    if (p.allowedDomains?.length) {
      const domain = emailDomain(email) ?? "";
      if (!p.allowedDomains.map((x) => x.toLowerCase()).includes(domain)) {
        throw new OidcError("domain_not_allowed");
      }
    }
    const groupsRaw = c[p.groupsClaim ?? "groups"];
    const groups = (
      Array.isArray(groupsRaw) ? groupsRaw : typeof groupsRaw === "string" ? [groupsRaw] : []
    )
      .filter((g): g is string => typeof g === "string" && g.length > 0 && g.length <= 256)
      .slice(0, 500);
    return {
      providerId: p.id,
      protocol: "oidc",
      issuer: iss,
      subject: sub,
      email,
      emailVerified: email !== null,
      displayName: str(c.name),
      givenName: str(c.given_name),
      familyName: str(c.family_name),
      groups,
      idTokenHint: idToken,
      auth: {
        // auth_time when the IdP sends it (requested via max_age), else the token's issue time.
        at: new Date(
          (typeof c.auth_time === "number" && c.auth_time <= nowSec + this.skewSec
            ? c.auth_time
            : c.iat) * 1000,
        ).toISOString(),
        methods: (Array.isArray(c.amr) ? c.amr : [])
          .filter((m): m is string => typeof m === "string" && m.length > 0 && m.length <= 64)
          .slice(0, 16),
        context: typeof c.acr === "string" && c.acr.length <= 256 ? c.acr : null,
      },
    };
  }

  /** RP-initiated logout URL, when the provider publishes an end_session_endpoint. */
  async endSessionUrl(
    p: IdentityOidcProviderConfig,
    opts: { idTokenHint: string | null; postLogoutRedirectUri: string },
  ): Promise<string | null> {
    let d: Discovery;
    try {
      d = await this.discover(p);
    } catch {
      return null;
    }
    if (!d.end_session_endpoint) {
      return null;
    }
    const url = new URL(d.end_session_endpoint);
    if (opts.idTokenHint) {
      url.searchParams.set("id_token_hint", opts.idTokenHint);
    }
    url.searchParams.set("client_id", p.clientId);
    url.searchParams.set("post_logout_redirect_uri", opts.postLogoutRedirectUri);
    return url.toString();
  }
}
