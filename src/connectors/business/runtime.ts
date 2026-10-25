// Business connectors: the per-connector runtime a plugin builds once.
//
// Holds the OAuth client, the token store, the rate limiter and the audit sink, and makes the
// one authorized request path every tool uses: scope check, token (refreshed when due), rate
// limit, retry, status check, capped body.
import type { SecretStore } from "../../secrets/types.js";
import type { OAuthClientConfig, TokenSet } from "./oauth.js";
import { ConnectorError } from "./errors.js";
import { type ConnectorAuditSink } from "./guardrails.js";
import {
  ensureOk,
  type FetchLike,
  RateLimiter,
  readCapped,
  readJson,
  requestWithRetry,
  type Sleep,
} from "./http.js";
import { assertScopes } from "./scopes.js";
import { ConnectorTokenStore, getValidToken } from "./token-store.js";

/**
 * A credential that is not an interactive OAuth sign-in: a static API token pasted by an
 * administrator (kintone, SmartHR) or a token minted from a signed assertion (LINE WORKS
 * service account). It replaces the OAuth client for `configured`, `token()` and the headers.
 */
export type ConnectorCredential = {
  /** A usable token; static credentials return the stored one, grants mint and store one. */
  token: (store: ConnectorTokenStore, deps: ConnectorRuntimeDeps) => Promise<TokenSet>;
  /** Headers that carry the token. Default `authorization: Bearer <token>`. */
  headers?: (token: TokenSet, req: AuthorizedRequest) => Record<string, string>;
};

/** A static API token kept in the token store (`expiresAt` far in the future, never refreshed). */
export function staticTokenCredential(
  headers?: ConnectorCredential["headers"],
): ConnectorCredential {
  return {
    token: async (store) => {
      const t = store.load();
      if (!t) {
        throw new ConnectorError("not_authenticated", "no stored API token");
      }
      return t;
    },
    ...(headers ? { headers } : {}),
  };
}

export type ConnectorRuntimeDeps = {
  fetch?: FetchLike;
  sleep?: Sleep;
  now?: () => number;
  random?: () => number;
  secrets: () => SecretStore;
  audit?: ConnectorAuditSink;
};

export type ConnectorRuntimeOptions = {
  id: string;
  /** Undefined when the admin has not configured the connector. */
  client?: OAuthClientConfig;
  /** Non-OAuth credential (API token, assertion grant); used instead of `client`. */
  credential?: ConnectorCredential;
  /** Requests per second toward the provider. Default 8. */
  ratePerSecond?: number;
  maxRetries?: number;
};

export type AuthorizedRequest = {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** JSON or text, or raw bytes for a file upload. */
  body?: string | Uint8Array<ArrayBuffer>;
  /** Scopes the operation needs; checked against the stored grant before any request. */
  scopes: readonly string[];
  /** For a credential holding several tokens (kintone: one per app): which one to send. */
  credentialKey?: string;
};

export class ConnectorRuntime {
  readonly tokens: ConnectorTokenStore;
  readonly limiter: RateLimiter;

  constructor(
    readonly options: ConnectorRuntimeOptions,
    readonly deps: ConnectorRuntimeDeps,
  ) {
    this.tokens = new ConnectorTokenStore(options.id, deps.secrets);
    const rate = Math.min(Math.max(options.ratePerSecond ?? 8, 1), 50);
    this.limiter = new RateLimiter(rate, 1000, deps.now, deps.sleep);
  }

  get id(): string {
    return this.options.id;
  }

  get configured(): boolean {
    return Boolean(this.options.client || this.options.credential);
  }

  get audit(): ConnectorAuditSink | undefined {
    return this.deps.audit;
  }

  requireClient(): OAuthClientConfig {
    if (!this.options.client) {
      throw new ConnectorError("not_configured", "connector is not configured");
    }
    return this.options.client;
  }

  /** Granted scopes of the stored sign-in (no network). */
  grantedScopes(): string[] | undefined {
    return this.tokens.load()?.scopes;
  }

  async token(): Promise<TokenSet> {
    if (this.options.credential) {
      return this.options.credential.token(this.tokens, this.deps);
    }
    return getValidToken(this.tokens, this.requireClient(), {
      fetch: this.deps.fetch,
      now: this.deps.now,
      sleep: this.deps.sleep,
      random: this.deps.random,
    });
  }

  async request(req: AuthorizedRequest): Promise<Response> {
    if (!this.configured) {
      throw new ConnectorError("not_configured", "connector is not configured");
    }
    const stored = this.tokens.load();
    if (!stored) {
      throw new ConnectorError("not_authenticated", "no stored sign-in");
    }
    assertScopes(stored.scopes, req.scopes);
    const token = await this.token();
    const res = await requestWithRetry(
      req.url,
      {
        method: req.method ?? "GET",
        headers: {
          accept: "application/json",
          ...req.headers,
          ...(this.options.credential?.headers?.(token, req) ?? {
            authorization: `Bearer ${token.accessToken}`,
          }),
        },
        ...(req.body !== undefined ? { body: req.body } : {}),
      },
      {
        fetch: this.deps.fetch,
        sleep: this.deps.sleep,
        now: this.deps.now,
        random: this.deps.random,
        limiter: this.limiter,
        maxRetries: this.options.maxRetries,
      },
    );
    return ensureOk(res);
  }

  async json<T>(req: AuthorizedRequest, maxBytes?: number): Promise<T> {
    return readJson<T>(await this.request(req), maxBytes);
  }

  async bytes(req: AuthorizedRequest, maxBytes: number): Promise<Buffer> {
    return readCapped(await this.request(req), maxBytes);
  }
}
