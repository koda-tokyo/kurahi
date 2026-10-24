// Business connectors: OAuth 2.0 for public clients.
//
// Authorization code with PKCE (S256) for a loopback redirect, and the device authorization
// grant (RFC 8628) for desktops and servers without a browser on the same machine. No client
// secret is required for Microsoft public clients; Google desktop clients send theirs (Google
// documents it as not confidential for installed apps) and it is read from the secret store.
import { createHash, randomBytes } from "node:crypto";
import { ConnectorError, codeForHttpStatus } from "./errors.js";
import {
  defaultSleep,
  type FetchLike,
  readJson,
  requestWithRetry,
  type RetryOptions,
  type Sleep,
} from "./http.js";

export type OAuthEndpoints = {
  authorizeUrl: string;
  tokenUrl: string;
  deviceCodeUrl?: string;
  revokeUrl?: string;
};

export type OAuthClientConfig = {
  clientId: string;
  /** Only for providers that require one for installed apps (Google). Never logged. */
  clientSecret?: string;
  endpoints: OAuthEndpoints;
  scopes: string[];
  /** Extra authorize parameters (e.g. Google `access_type=offline`, `prompt=consent`). */
  authorizeParams?: Record<string, string>;
};

export type TokenSet = {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  scopes: string[];
  tokenType: string;
  obtainedAt: number;
  /** Returned when `openid` was requested. Never persisted by the token store. */
  idToken?: string;
};

export type OAuthDeps = Pick<RetryOptions, "fetch" | "now" | "sleep" | "random"> & {
  fetch?: FetchLike;
};

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type PkcePair = { verifier: string; challenge: string; method: "S256" };

/** RFC 7636: 32 random bytes -> 43-char verifier; challenge = BASE64URL(SHA256(verifier)). */
export function createPkcePair(): PkcePair {
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: pkceChallenge(verifier), method: "S256" };
}

export function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "ascii").digest());
}

export function randomState(): string {
  return base64url(randomBytes(24));
}

export function buildAuthorizeUrl(
  client: OAuthClientConfig,
  params: { redirectUri: string; state: string; challenge: string; nonce?: string },
): string {
  const url = new URL(client.endpoints.authorizeUrl);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", client.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (params.nonce) {
    url.searchParams.set("nonce", params.nonce);
  }
  for (const [k, v] of Object.entries(client.authorizeParams ?? {})) {
    url.searchParams.set(k, v);
  }
  return url.toString();
}

type RawToken = {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  token_type?: unknown;
  id_token?: unknown;
  error?: unknown;
};

export function parseTokenResponse(
  raw: RawToken,
  now: number,
  requestedScopes: string[],
  previousRefreshToken?: string,
): TokenSet {
  if (typeof raw.access_token !== "string" || !raw.access_token) {
    throw new ConnectorError("invalid_response", "token response has no access token");
  }
  const expiresIn = Number(raw.expires_in);
  const scopes =
    typeof raw.scope === "string" && raw.scope.trim()
      ? raw.scope.trim().split(/\s+/)
      : [...requestedScopes];
  return {
    accessToken: raw.access_token,
    refreshToken:
      typeof raw.refresh_token === "string" && raw.refresh_token
        ? raw.refresh_token
        : previousRefreshToken,
    expiresAt: now + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
    scopes,
    tokenType: typeof raw.token_type === "string" ? raw.token_type : "Bearer",
    obtainedAt: now,
    ...(typeof raw.id_token === "string" ? { idToken: raw.id_token } : {}),
  };
}

async function postForm(
  url: string,
  form: Record<string, string>,
  deps: OAuthDeps,
): Promise<{ status: number; body: RawToken }> {
  const res = await requestWithRetry(
    url,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(form).toString(),
    },
    { ...deps, maxRetries: 2 },
  );
  let body: RawToken = {};
  try {
    body = await readJson<RawToken>(res, 256 * 1024);
  } catch {
    body = {};
  }
  return { status: res.status, body };
}

function tokenError(status: number, body: RawToken): ConnectorError {
  const code = typeof body.error === "string" ? body.error : undefined;
  // The provider's error_description can echo request details; only the code is kept.
  return new ConnectorError(codeForHttpStatus(status, code), `token endpoint: ${code ?? status}`);
}

function clientForm(client: OAuthClientConfig): Record<string, string> {
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
  };
}

export async function exchangeAuthorizationCode(
  client: OAuthClientConfig,
  params: { code: string; redirectUri: string; verifier: string },
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  const now = (deps.now ?? Date.now)();
  const { status, body } = await postForm(
    client.endpoints.tokenUrl,
    {
      ...clientForm(client),
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.verifier,
      scope: client.scopes.join(" "),
    },
    deps,
  );
  if (status < 200 || status >= 300) {
    throw tokenError(status, body);
  }
  return parseTokenResponse(body, now, client.scopes);
}

export async function refreshAccessToken(
  client: OAuthClientConfig,
  refreshToken: string,
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  const now = (deps.now ?? Date.now)();
  const { status, body } = await postForm(
    client.endpoints.tokenUrl,
    {
      ...clientForm(client),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: client.scopes.join(" "),
    },
    deps,
  );
  if (status < 200 || status >= 300) {
    throw tokenError(status, body);
  }
  return parseTokenResponse(body, now, client.scopes, refreshToken);
}

export type DeviceAuthorization = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
};

export async function startDeviceAuthorization(
  client: OAuthClientConfig,
  deps: OAuthDeps = {},
): Promise<DeviceAuthorization> {
  if (!client.endpoints.deviceCodeUrl) {
    throw new ConnectorError(
      "unsupported",
      "this provider has no device code flow for these scopes",
    );
  }
  const { status, body } = await postForm(
    client.endpoints.deviceCodeUrl,
    { ...clientForm(client), scope: client.scopes.join(" ") },
    deps,
  );
  const b = body as Record<string, unknown>;
  if (status < 200 || status >= 300) {
    throw tokenError(status, body);
  }
  const verificationUri = b.verification_uri ?? b.verification_url;
  if (
    typeof b.device_code !== "string" ||
    typeof b.user_code !== "string" ||
    typeof verificationUri !== "string"
  ) {
    throw new ConnectorError("invalid_response", "device code response is incomplete");
  }
  return {
    deviceCode: b.device_code,
    userCode: b.user_code,
    verificationUri,
    expiresIn: Math.min(Math.max(Number(b.expires_in) || 900, 60), 1800),
    interval: Math.min(Math.max(Number(b.interval) || 5, 1), 60),
  };
}

/**
 * Poll the token endpoint until the user finishes, declines, or the code expires. Bounded by the
 * code's lifetime (at most 30 minutes) and by a hard cap on polls.
 */
export async function pollDeviceToken(
  client: OAuthClientConfig,
  device: DeviceAuthorization,
  deps: OAuthDeps = {},
): Promise<TokenSet> {
  const now = deps.now ?? Date.now;
  const sleep: Sleep = deps.sleep ?? defaultSleep;
  const deadline = now() + device.expiresIn * 1000;
  let interval = device.interval;
  for (let poll = 0; poll < 720 && now() < deadline; poll++) {
    await sleep(interval * 1000);
    const { status, body } = await postForm(
      client.endpoints.tokenUrl,
      {
        ...clientForm(client),
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.deviceCode,
      },
      deps,
    );
    if (status >= 200 && status < 300) {
      return parseTokenResponse(body, now(), client.scopes);
    }
    const code = typeof body.error === "string" ? body.error : "";
    if (code === "authorization_pending") {
      continue;
    }
    if (code === "slow_down") {
      interval = Math.min(interval + 5, 60);
      continue;
    }
    if (code === "access_denied" || code === "authorization_declined") {
      throw new ConnectorError("approval_denied", "the sign-in was declined");
    }
    if (code === "expired_token" || code === "bad_verification_code") {
      throw new ConnectorError("timeout", "the device code expired before sign-in finished");
    }
    throw tokenError(status, body);
  }
  throw new ConnectorError("timeout", "the device code expired before sign-in finished");
}

/** RFC 7009 revocation where the provider supports it (Google). Best effort. */
export async function revokeToken(
  client: OAuthClientConfig,
  token: string,
  deps: OAuthDeps = {},
): Promise<boolean> {
  if (!client.endpoints.revokeUrl) {
    return false;
  }
  const { status } = await postForm(client.endpoints.revokeUrl, { token }, deps);
  return status >= 200 && status < 300;
}
