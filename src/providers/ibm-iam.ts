// IBM Cloud IAM: exchange an API key for a short-lived bearer token, cache it per key and refresh
// it before it expires. Used by the watsonx.ai model adapter and the watsonx Orchestrate plugin.
//
// Exchange (IBM Cloud docs, "Generating an API key and bearer token"):
//   POST https://iam.cloud.ibm.com/identity/token
//   Content-Type: application/x-www-form-urlencoded
//   grant_type=urn:ibm:params:oauth:grant-type:apikey&apikey=<key>
// The answer carries `access_token` and, from the IAM token API, `expires_in` (seconds) and
// `expiration` (epoch seconds). Keys and tokens are never logged or put in error messages.
import { createHash } from "node:crypto";

export const IBM_IAM_TOKEN_URL = "https://iam.cloud.ibm.com/identity/token";
const GRANT_TYPE = "urn:ibm:params:oauth:grant-type:apikey";
/** Refresh this long before the token's stated expiry. */
const REFRESH_MARGIN_MS = 5 * 60_000;
/** Used when the answer states no lifetime (IAM tokens normally last an hour). */
const FALLBACK_LIFETIME_MS = 20 * 60_000;
const MAX_CACHE = 64;

export class IbmIamError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "IbmIamError";
  }
}

export type IbmIamToken = { token: string; expiresAt: number };

export type IbmIamOptions = {
  apiKey: string;
  /** Token endpoint; https only. Defaults to IBM Cloud IAM. */
  tokenUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
};

export function assertIamTokenUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IbmIamError("IAM token URL is not a URL");
  }
  if (url.protocol !== "https:") {
    throw new IbmIamError("IAM token URL must use https");
  }
  return url.toString();
}

/** One exchange, no cache. */
export async function exchangeIbmIamToken(opts: IbmIamOptions): Promise<IbmIamToken> {
  const apiKey = opts.apiKey.trim();
  if (!apiKey) {
    throw new IbmIamError("IBM Cloud API key is empty");
  }
  const tokenUrl = assertIamTokenUrl(opts.tokenUrl ?? IBM_IAM_TOKEN_URL);
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now;
  const body = new URLSearchParams({ grant_type: GRANT_TYPE, apikey: apiKey }).toString();
  let res: Response;
  try {
    res = await fetchFn(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new IbmIamError(
      `IAM token request failed (${err instanceof Error ? err.name : "error"})`,
    );
  }
  if (!res.ok) {
    throw new IbmIamError(
      `IAM token request was refused (HTTP ${res.status}${res.status === 400 || res.status === 401 ? ", check the API key" : ""})`,
      res.status,
    );
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new IbmIamError("IAM token answer is not JSON");
  }
  const rec = (json ?? {}) as Record<string, unknown>;
  const token = typeof rec.access_token === "string" ? rec.access_token.trim() : "";
  if (!token) {
    throw new IbmIamError("IAM token answer has no access_token");
  }
  const issuedAt = now();
  let expiresAt = issuedAt + FALLBACK_LIFETIME_MS;
  if (typeof rec.expiration === "number" && rec.expiration * 1000 > issuedAt) {
    expiresAt = rec.expiration * 1000;
  } else if (typeof rec.expires_in === "number" && rec.expires_in > 0) {
    expiresAt = issuedAt + rec.expires_in * 1000;
  }
  return { token, expiresAt };
}

const keyId = (apiKey: string, tokenUrl: string) =>
  createHash("sha256").update(`${tokenUrl}\n${apiKey}`).digest("hex");

/**
 * Cached token source: one exchange per key and token URL, shared by concurrent callers, refreshed
 * when less than five minutes remain. The cache key is a hash; the key itself is not retained.
 */
export function createIbmIamTokenCache(defaults: Omit<IbmIamOptions, "apiKey"> = {}) {
  const entries = new Map<string, { value?: IbmIamToken; pending?: Promise<IbmIamToken> }>();
  const now = defaults.now ?? Date.now;
  return {
    async get(apiKey: string, tokenUrl = defaults.tokenUrl ?? IBM_IAM_TOKEN_URL): Promise<string> {
      const id = keyId(apiKey.trim(), tokenUrl);
      let entry = entries.get(id);
      if (entry?.value && entry.value.expiresAt - REFRESH_MARGIN_MS > now()) {
        return entry.value.token;
      }
      if (!entry) {
        if (entries.size >= MAX_CACHE) {
          entries.delete(entries.keys().next().value as string);
        }
        entry = {};
        entries.set(id, entry);
      }
      const current = entry;
      current.pending ??= exchangeIbmIamToken({ ...defaults, apiKey, tokenUrl })
        .then((value) => {
          current.value = value;
          return value;
        })
        .finally(() => {
          current.pending = undefined;
        });
      return (await current.pending).token;
    },
    /** Drop a cached token (after the service refused it). */
    invalidate(apiKey: string, tokenUrl = defaults.tokenUrl ?? IBM_IAM_TOKEN_URL) {
      entries.delete(keyId(apiKey.trim(), tokenUrl));
    },
    get size() {
      return entries.size;
    },
  };
}

export type IbmIamTokenCache = ReturnType<typeof createIbmIamTokenCache>;
