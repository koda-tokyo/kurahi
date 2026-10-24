// Business connectors: tokens in the encrypted secret store (src/secrets).
//
// One secret per connector, `connector.<id>.token`, holding the access token, refresh token,
// expiry and granted scopes as JSON. ID tokens are never stored. Refresh is single-flight per
// connector, so concurrent tool calls share one refresh (and one rotated refresh token).
import type { SecretStore } from "../../secrets/types.js";
import { ConnectorError } from "./errors.js";
import {
  type OAuthClientConfig,
  type OAuthDeps,
  refreshAccessToken,
  type TokenSet,
} from "./oauth.js";

export function tokenSecretName(connectorId: string): string {
  return `connector.${connectorId}.token`;
}

export class ConnectorTokenStore {
  constructor(
    readonly connectorId: string,
    private readonly secrets: () => SecretStore,
  ) {}

  load(): TokenSet | undefined {
    let raw: string | undefined;
    try {
      raw = this.secrets().get(tokenSecretName(this.connectorId));
    } catch {
      return undefined;
    }
    if (!raw) {
      return undefined;
    }
    try {
      const t = JSON.parse(raw) as Partial<TokenSet>;
      if (typeof t.accessToken !== "string" || typeof t.expiresAt !== "number") {
        return undefined;
      }
      return {
        accessToken: t.accessToken,
        refreshToken: typeof t.refreshToken === "string" ? t.refreshToken : undefined,
        expiresAt: t.expiresAt,
        scopes: Array.isArray(t.scopes) ? t.scopes.filter((s) => typeof s === "string") : [],
        tokenType: typeof t.tokenType === "string" ? t.tokenType : "Bearer",
        obtainedAt: typeof t.obtainedAt === "number" ? t.obtainedAt : 0,
      };
    } catch {
      return undefined;
    }
  }

  save(token: TokenSet): void {
    const { idToken: _drop, ...persisted } = token;
    this.secrets().set(tokenSecretName(this.connectorId), JSON.stringify(persisted));
  }

  clear(): boolean {
    return this.secrets().delete(tokenSecretName(this.connectorId));
  }
}

const inflight = new Map<string, Promise<TokenSet>>();

export type AccessTokenOptions = OAuthDeps & {
  /** Refresh this long before expiry. Default 2 minutes. */
  skewMs?: number;
};

/** A valid token, refreshed when it is about to expire. */
export async function getValidToken(
  store: ConnectorTokenStore,
  client: OAuthClientConfig,
  opts: AccessTokenOptions = {},
): Promise<TokenSet> {
  const now = opts.now ?? Date.now;
  const current = store.load();
  if (!current) {
    throw new ConnectorError("not_authenticated", "no stored sign-in");
  }
  if (current.expiresAt - (opts.skewMs ?? 120_000) > now()) {
    return current;
  }
  if (!current.refreshToken) {
    throw new ConnectorError("reauth_required", "the sign-in expired and cannot be refreshed");
  }
  const key = store.connectorId;
  const pending = inflight.get(key);
  if (pending) {
    return pending;
  }
  const run = (async () => {
    try {
      const next = await refreshAccessToken(client, current.refreshToken!, opts);
      store.save(next);
      return next;
    } catch (err) {
      if (err instanceof ConnectorError && err.code === "not_authenticated") {
        throw new ConnectorError("reauth_required", "the refresh token was rejected");
      }
      throw err;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}
