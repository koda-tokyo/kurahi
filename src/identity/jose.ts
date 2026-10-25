// Compact JWS verification for OIDC ID tokens with node:crypto (no JOSE dependency).
//
// Accepted algorithms are an explicit allowlist per provider (RS256, PS256, ES256); `none` and
// every HMAC algorithm are refused, so a public key can never be used as an HMAC secret. Keys
// come only from the provider's JWKS and are matched by `kid` and key type.
import {
  createPublicKey,
  type KeyObject,
  constants as cryptoConstants,
  verify as cryptoVerify,
} from "node:crypto";

export const SUPPORTED_ALGS = ["RS256", "PS256", "ES256"] as const;
export type JwsAlg = (typeof SUPPORTED_ALGS)[number];

export type Jwk = {
  kty?: string;
  kid?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
};

export class JwsError extends Error {
  constructor(readonly reason: "malformed" | "unsupported_alg" | "unknown_key" | "bad_signature") {
    super(`token rejected: ${reason}`);
    this.name = "JwsError";
  }
}

export type DecodedJws = {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  signingInput: Buffer;
  signature: Buffer;
};

function b64url(part: string): Buffer {
  if (!/^[A-Za-z0-9_-]*$/.test(part)) {
    throw new JwsError("malformed");
  }
  return Buffer.from(part, "base64url");
}

function jsonPart(part: string): Record<string, unknown> {
  let v: unknown;
  try {
    v = JSON.parse(b64url(part).toString("utf8"));
  } catch {
    throw new JwsError("malformed");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw new JwsError("malformed");
  }
  return v as Record<string, unknown>;
}

export function decodeJws(token: string, maxLength = 16_384): DecodedJws {
  if (typeof token !== "string" || token.length > maxLength) {
    throw new JwsError("malformed");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new JwsError("malformed");
  }
  return {
    header: jsonPart(parts[0]),
    payload: jsonPart(parts[1]),
    signingInput: Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"),
    signature: b64url(parts[2]),
  };
}

/** Public keys usable for signatures, keyed by kid. Malformed or encryption keys are skipped. */
export function importJwks(jwks: { keys?: Jwk[] }): Map<string, { key: KeyObject; jwk: Jwk }> {
  const out = new Map<string, { key: KeyObject; jwk: Jwk }>();
  for (const jwk of Array.isArray(jwks?.keys) ? jwks.keys : []) {
    if (typeof jwk?.kid !== "string" || (jwk.use && jwk.use !== "sig")) {
      continue;
    }
    try {
      if (jwk.kty === "RSA" && jwk.n && jwk.e) {
        out.set(jwk.kid, {
          key: createPublicKey({ key: { kty: "RSA", n: jwk.n, e: jwk.e }, format: "jwk" }),
          jwk,
        });
      } else if (jwk.kty === "EC" && jwk.crv === "P-256" && jwk.x && jwk.y) {
        out.set(jwk.kid, {
          key: createPublicKey({
            key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y },
            format: "jwk",
          }),
          jwk,
        });
      }
    } catch {
      // skip a malformed key; others may still be valid
    }
  }
  return out;
}

/** Verify the signature of a decoded JWS with one key. Throws JwsError. */
export function verifyJwsSignature(
  decoded: DecodedJws,
  entry: { key: KeyObject; jwk: Jwk },
  allowed: readonly string[],
): JwsAlg {
  const alg = decoded.header.alg;
  if (
    typeof alg !== "string" ||
    !(SUPPORTED_ALGS as readonly string[]).includes(alg) ||
    !allowed.includes(alg)
  ) {
    throw new JwsError("unsupported_alg");
  }
  if (entry.jwk.alg && entry.jwk.alg !== alg) {
    throw new JwsError("unknown_key");
  }
  let ok = false;
  if (alg === "RS256" || alg === "PS256") {
    if (entry.jwk.kty !== "RSA") {
      throw new JwsError("unknown_key");
    }
    ok = cryptoVerify(
      "sha256",
      decoded.signingInput,
      alg === "PS256"
        ? {
            key: entry.key,
            padding: cryptoConstants.RSA_PKCS1_PSS_PADDING,
            saltLength: 32,
          }
        : entry.key,
      decoded.signature,
    );
  } else {
    if (entry.jwk.kty !== "EC" || decoded.signature.length !== 64) {
      throw entry.jwk.kty !== "EC" ? new JwsError("unknown_key") : new JwsError("bad_signature");
    }
    ok = cryptoVerify(
      "sha256",
      decoded.signingInput,
      { key: entry.key, dsaEncoding: "ieee-p1363" },
      decoded.signature,
    );
  }
  if (!ok) {
    throw new JwsError("bad_signature");
  }
  return alg as JwsAlg;
}
