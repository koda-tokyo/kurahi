// COSE public keys (RFC 9052 / 9053) as WebAuthn authenticators send them, turned into node:crypto
// keys. Accepted: ES256 (EC2, P-256), RS256 (RSA, at least 2048 bits) and EdDSA (OKP, Ed25519).
// A key is stored as its SPKI DER (base64url) with the COSE algorithm, and signatures are
// verified against that stored form only.
import { createPublicKey, type KeyObject, verify as cryptoVerify } from "node:crypto";
import { type CborValue, isCborBytes, isCborMap } from "./cbor.js";

export const COSE_ALG_ES256 = -7;
export const COSE_ALG_EDDSA = -8;
export const COSE_ALG_RS256 = -257;

/** Algorithms offered to authenticators, in order of preference. */
export const SUPPORTED_COSE_ALGS = [COSE_ALG_ES256, COSE_ALG_EDDSA, COSE_ALG_RS256] as const;
export type CoseAlg = (typeof SUPPORTED_COSE_ALGS)[number];

const KTY_OKP = 1;
const KTY_EC2 = 2;
const KTY_RSA = 3;
const CRV_P256 = 1;
const CRV_ED25519 = 6;
const MIN_RSA_BITS = 2048;

export class CoseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoseError";
  }
}

export type ParsedCoseKey = { alg: CoseAlg; key: KeyObject; spki: Buffer };

const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function bytes(m: Map<number | string, CborValue>, label: number, len?: number): Uint8Array {
  const v = m.get(label);
  if (!isCborBytes(v) || (len !== undefined && v.length !== len)) {
    throw new CoseError(`COSE key parameter ${label} is missing or malformed`);
  }
  return v;
}

/** COSE_Key → public key. Throws CoseError for anything outside the accepted set. */
export function parseCoseKey(value: CborValue): ParsedCoseKey {
  if (!isCborMap(value)) {
    throw new CoseError("COSE key is not a map");
  }
  const kty = value.get(1);
  const alg = value.get(3);
  let jwk: Record<string, string>;
  if (alg === COSE_ALG_ES256) {
    if (kty !== KTY_EC2 || value.get(-1) !== CRV_P256) {
      throw new CoseError("ES256 needs an EC2 P-256 key");
    }
    jwk = { kty: "EC", crv: "P-256", x: b64u(bytes(value, -2, 32)), y: b64u(bytes(value, -3, 32)) };
  } else if (alg === COSE_ALG_RS256) {
    if (kty !== KTY_RSA) {
      throw new CoseError("RS256 needs an RSA key");
    }
    const n = bytes(value, -1);
    const e = bytes(value, -2);
    // Leading zero bytes do not count towards the modulus size.
    let start = 0;
    while (start < n.length && n[start] === 0) {
      start += 1;
    }
    if ((n.length - start) * 8 < MIN_RSA_BITS || e.length === 0 || e.length > 8) {
      throw new CoseError("RSA key too small or malformed");
    }
    // Only the standard public exponent 65537 (0x010001; leading zero bytes allowed): a small
    // or unusual exponent is a sign of a broken or hostile key generator.
    let e0 = 0;
    while (e0 < e.length - 1 && e[e0] === 0) {
      e0 += 1;
    }
    if (Buffer.from(e.subarray(e0)).toString("hex") !== "010001") {
      throw new CoseError("RSA public exponent must be 65537");
    }
    jwk = { kty: "RSA", n: b64u(n.subarray(start)), e: b64u(e) };
  } else if (alg === COSE_ALG_EDDSA) {
    if (kty !== KTY_OKP || value.get(-1) !== CRV_ED25519) {
      throw new CoseError("EdDSA needs an OKP Ed25519 key");
    }
    jwk = { kty: "OKP", crv: "Ed25519", x: b64u(bytes(value, -2, 32)) };
  } else {
    throw new CoseError("unsupported COSE algorithm");
  }
  let key: KeyObject;
  try {
    // The JWK import checks the point is on the curve.
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    throw new CoseError("COSE key is not a valid public key");
  }
  return { alg, key, spki: key.export({ format: "der", type: "spki" }) };
}

/** A stored key (SPKI DER, base64url) back into a KeyObject. */
export function keyFromSpki(spki: string): KeyObject {
  return createPublicKey({ key: Buffer.from(spki, "base64url"), format: "der", type: "spki" });
}

/**
 * Verify a WebAuthn signature. ES256 signatures are ASN.1 DER (as authenticators send them),
 * RS256 is RSASSA-PKCS1-v1_5 with SHA-256, EdDSA is pure Ed25519.
 */
export function verifyCoseSignature(
  alg: number,
  key: KeyObject,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  try {
    if (alg === COSE_ALG_ES256) {
      return (
        key.asymmetricKeyType === "ec" &&
        cryptoVerify("sha256", data, { key, dsaEncoding: "der" }, signature)
      );
    }
    if (alg === COSE_ALG_RS256) {
      return key.asymmetricKeyType === "rsa" && cryptoVerify("sha256", data, key, signature);
    }
    if (alg === COSE_ALG_EDDSA) {
      return key.asymmetricKeyType === "ed25519" && cryptoVerify(null, data, key, signature);
    }
  } catch {
    return false;
  }
  return false;
}
