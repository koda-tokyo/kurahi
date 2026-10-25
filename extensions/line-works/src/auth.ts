// LINE WORKS service account authentication: a JWT (RS256) signed with the app's private key is
// exchanged at the token endpoint for an access token (grant urn:ietf:params:oauth:grant-type:
// jwt-bearer). The token is cached in the secret store and minted again shortly before it
// expires; no refresh token is used. One mint at a time per process.
import { createSign } from "node:crypto";
import {
  type ConnectorCredential,
  ConnectorError,
  codeForHttpStatus,
  parseTokenResponse,
  readJson,
  requestWithRetry,
  type ConnectorRuntimeDeps,
  type TokenSet,
} from "../../../src/connectors/business/index.js";
import { TOKEN_URL } from "./config.js";

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** The JWT assertion: iss = client id, sub = service account, exp 60 min after iat (the maximum). */
export function signAssertion(
  params: { clientId: string; serviceAccount: string; privateKey: string },
  nowMs: number,
): string {
  const iat = Math.floor(nowMs / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: params.clientId, sub: params.serviceAccount, iat, exp: iat + 3600 }),
  );
  let signature: Buffer;
  try {
    signature = createSign("RSA-SHA256").update(`${header}.${claims}`).sign(params.privateKey);
  } catch {
    throw new ConnectorError(
      "not_configured",
      "private key unusable",
      undefined,
      "the stored LINE WORKS private key could not sign (PEM PKCS#8 expected)",
    );
  }
  return `${header}.${claims}.${b64url(signature)}`;
}

export type ServiceAccountConfig = {
  clientId: string;
  serviceAccount: string;
  scopes: string[];
  privateKey: () => string | undefined;
  clientSecret: () => string | undefined;
};

export async function mintAccessToken(
  cfg: ServiceAccountConfig,
  deps: Pick<ConnectorRuntimeDeps, "fetch" | "now" | "sleep" | "random">,
): Promise<TokenSet> {
  const privateKey = cfg.privateKey();
  const clientSecret = cfg.clientSecret();
  if (!privateKey || !clientSecret) {
    throw new ConnectorError("not_configured", "service account credentials missing");
  }
  const now = (deps.now ?? Date.now)();
  const form = new URLSearchParams({
    assertion: signAssertion({ ...cfg, privateKey }, now),
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: cfg.clientId,
    client_secret: clientSecret,
    scope: cfg.scopes.join(" "),
  });
  const res = await requestWithRetry(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    },
    { fetch: deps.fetch, now: deps.now, sleep: deps.sleep, random: deps.random, maxRetries: 2 },
  );
  let body: Record<string, unknown> = {};
  try {
    body = await readJson<Record<string, unknown>>(res, 64 * 1024);
  } catch {
    body = {};
  }
  if (!res.ok) {
    const code = typeof body.error === "string" ? body.error : undefined;
    throw new ConnectorError(
      codeForHttpStatus(res.status, code),
      `token endpoint: ${code ?? res.status}`,
    );
  }
  const token = parseTokenResponse(body, now, cfg.scopes);
  // A refresh token is never used (a new assertion is cheaper and needs nothing stored).
  return { ...token, refreshToken: undefined };
}

const inflight = new Map<string, Promise<TokenSet>>();

export function serviceAccountCredential(cfg: ServiceAccountConfig): ConnectorCredential {
  return {
    token: async (store, deps) => {
      const now = (deps.now ?? Date.now)();
      const current = store.load();
      if (!current) {
        throw new ConnectorError("not_authenticated", "not signed in; run kurahi lineworks login");
      }
      if (current.expiresAt - 120_000 > now) {
        return current;
      }
      const pending = inflight.get(store.connectorId);
      if (pending) {
        return pending;
      }
      const run = (async () => {
        try {
          const next = await mintAccessToken(cfg, deps);
          store.save(next);
          return next;
        } finally {
          inflight.delete(store.connectorId);
        }
      })();
      inflight.set(store.connectorId, run);
      return run;
    },
  };
}
