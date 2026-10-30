// WebAuthn Level 2/3 relying-party checks for registration (§7.1) and authentication (§7.2),
// as pure functions: the caller supplies the expected challenge, origins, RP id and the stored
// credential, and keeps the state (one-time challenges, sign counters).
//
// Attestation: Kurahi asks for `attestation: "none"` and does not decide trust from the
// authenticator model. A "none" statement must be empty; other formats some authenticators
// still send are accepted without verifying the statement (the key is trusted because the
// enrolling person proved who they are, not because of the attestation).
import { createHash, timingSafeEqual } from "node:crypto";
import { CborError, decodeCbor, decodeCborPrefix, isCborBytes, isCborMap } from "./cbor.js";
import {
  CoseError,
  type CoseAlg,
  keyFromSpki,
  parseCoseKey,
  SUPPORTED_COSE_ALGS,
  verifyCoseSignature,
} from "./cose.js";

export type WebAuthnFailure =
  | "malformed"
  | "wrong_type"
  | "challenge_mismatch"
  | "origin_mismatch"
  | "cross_origin"
  | "rp_id_mismatch"
  | "user_not_present"
  | "user_not_verified"
  | "unsupported_algorithm"
  | "attestation_invalid"
  | "credential_mismatch"
  | "user_handle_mismatch"
  | "bad_signature"
  | "sign_count_regression";

export class WebAuthnError extends Error {
  constructor(readonly reason: WebAuthnFailure) {
    super(`webauthn: ${reason}`);
    this.name = "WebAuthnError";
  }
}

export const FLAG_UP = 0x01;
export const FLAG_UV = 0x04;
export const FLAG_BE = 0x08;
export const FLAG_BS = 0x10;
export const FLAG_AT = 0x40;
export const FLAG_ED = 0x80;

/** WebAuthn caps credential ids at 1023 bytes. */
const MAX_CREDENTIAL_ID = 1023;

export type AuthenticatorData = {
  rpIdHash: Buffer;
  flags: number;
  signCount: number;
  attested: { aaguid: Buffer; credentialId: Buffer; publicKey: Uint8Array } | null;
};

/** Parse authenticatorData (§6.1); every byte must be accounted for. */
export function parseAuthenticatorData(data: Uint8Array): AuthenticatorData {
  if (data.length < 37) {
    throw new WebAuthnError("malformed");
  }
  const buf = Buffer.from(data);
  const flags = buf[32];
  const signCount = buf.readUInt32BE(33);
  let pos = 37;
  let attested: AuthenticatorData["attested"] = null;
  try {
    if (flags & FLAG_AT) {
      if (buf.length < pos + 18) {
        throw new WebAuthnError("malformed");
      }
      const aaguid = buf.subarray(pos, pos + 16);
      const idLen = buf.readUInt16BE(pos + 16);
      pos += 18;
      if (idLen === 0 || idLen > MAX_CREDENTIAL_ID || buf.length < pos + idLen) {
        throw new WebAuthnError("malformed");
      }
      const credentialId = buf.subarray(pos, pos + idLen);
      pos += idLen;
      const key = decodeCborPrefix(buf, pos);
      const publicKey = buf.subarray(pos, key.end);
      pos = key.end;
      attested = {
        aaguid: Buffer.from(aaguid),
        credentialId: Buffer.from(credentialId),
        publicKey,
      };
    }
    if (flags & FLAG_ED) {
      const ext = decodeCborPrefix(buf, pos);
      if (!isCborMap(ext.value)) {
        throw new WebAuthnError("malformed");
      }
      pos = ext.end;
    }
  } catch (err) {
    if (err instanceof CborError) {
      throw new WebAuthnError("malformed");
    }
    throw err;
  }
  if (pos !== buf.length) {
    throw new WebAuthnError("malformed");
  }
  return { rpIdHash: Buffer.from(buf.subarray(0, 32)), flags, signCount, attested };
}

/** Browser JSON (PublicKeyCredential.toJSON()): every binary field is base64url. */
export type RegistrationResponseJSON = {
  id: string;
  rawId: string;
  type: string;
  response: { clientDataJSON: string; attestationObject: string; transports?: string[] };
};

export type AuthenticationResponseJSON = {
  id: string;
  rawId: string;
  type: string;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string | null;
  };
};

const B64U_RE = /^[A-Za-z0-9_-]*$/;

/** Strict base64url (no padding, no other characters); bounded. */
export function fromB64u(value: unknown, maxBytes = 64 * 1024): Buffer {
  if (typeof value !== "string" || !B64U_RE.test(value) || value.length > (maxBytes * 4) / 3 + 4) {
    throw new WebAuthnError("malformed");
  }
  const out = Buffer.from(value, "base64url");
  // Reject non-canonical encodings (trailing bits) so one credential has one id string.
  if (out.toString("base64url") !== value) {
    throw new WebAuthnError("malformed");
  }
  return out;
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export type ExpectedCeremony = {
  /** The one-time challenge sent to the browser (base64url). */
  challenge: string;
  /** Origins the client data may name (scheme://host[:port]). */
  origins: readonly string[];
  rpId: string;
  requireUserVerification: boolean;
};

type ClientData = { type: string; challenge: string; origin: string; crossOrigin?: unknown };

function checkClientData(raw: Buffer, type: string, expected: ExpectedCeremony): void {
  let parsed: ClientData;
  try {
    parsed = JSON.parse(raw.toString("utf8")) as ClientData;
  } catch {
    throw new WebAuthnError("malformed");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new WebAuthnError("malformed");
  }
  if (parsed.type !== type) {
    throw new WebAuthnError("wrong_type");
  }
  const got =
    typeof parsed.challenge === "string" ? Buffer.from(parsed.challenge) : Buffer.alloc(0);
  if (!sameBytes(got, Buffer.from(expected.challenge))) {
    throw new WebAuthnError("challenge_mismatch");
  }
  if (typeof parsed.origin !== "string" || !expected.origins.includes(parsed.origin)) {
    throw new WebAuthnError("origin_mismatch");
  }
  // Kurahi is never embedded in another site's frame for sign-in.
  if (parsed.crossOrigin === true) {
    throw new WebAuthnError("cross_origin");
  }
}

function checkFlags(auth: AuthenticatorData, expected: ExpectedCeremony): void {
  if (!sameBytes(auth.rpIdHash, sha256(expected.rpId))) {
    throw new WebAuthnError("rp_id_mismatch");
  }
  if (!(auth.flags & FLAG_UP)) {
    throw new WebAuthnError("user_not_present");
  }
  if (expected.requireUserVerification && !(auth.flags & FLAG_UV)) {
    throw new WebAuthnError("user_not_verified");
  }
}

export type VerifiedRegistration = {
  credentialId: string;
  /** SPKI DER, base64url. */
  publicKey: string;
  alg: CoseAlg;
  signCount: number;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  aaguid: string;
  attestationFormat: string;
  transports: string[];
};

const TRANSPORTS = new Set(["usb", "nfc", "ble", "smart-card", "hybrid", "internal"]);

/** §7.1: verify a registration response against the ceremony it answers. */
export function verifyRegistration(
  response: unknown,
  expected: ExpectedCeremony,
): VerifiedRegistration {
  const r = response as RegistrationResponseJSON;
  if (!r || typeof r !== "object" || r.type !== "public-key" || !r.response) {
    throw new WebAuthnError("malformed");
  }
  const rawId = fromB64u(r.rawId, MAX_CREDENTIAL_ID);
  const clientData = fromB64u(r.response.clientDataJSON, 8 * 1024);
  checkClientData(clientData, "webauthn.create", expected);
  let att;
  try {
    att = decodeCbor(fromB64u(r.response.attestationObject));
  } catch (err) {
    throw err instanceof WebAuthnError ? err : new WebAuthnError("malformed");
  }
  if (!isCborMap(att)) {
    throw new WebAuthnError("malformed");
  }
  const fmt = att.get("fmt");
  const attStmt = att.get("attStmt");
  const authDataRaw = att.get("authData");
  if (typeof fmt !== "string" || !isCborMap(attStmt) || !isCborBytes(authDataRaw)) {
    throw new WebAuthnError("malformed");
  }
  if (fmt === "none" && attStmt.size !== 0) {
    throw new WebAuthnError("attestation_invalid");
  }
  const auth = parseAuthenticatorData(authDataRaw);
  checkFlags(auth, expected);
  if (!auth.attested) {
    throw new WebAuthnError("malformed");
  }
  if (!sameBytes(auth.attested.credentialId, rawId) || r.id !== r.rawId) {
    throw new WebAuthnError("credential_mismatch");
  }
  let key;
  try {
    key = parseCoseKey(decodeCbor(auth.attested.publicKey));
  } catch (err) {
    if (err instanceof CoseError || err instanceof CborError) {
      throw new WebAuthnError("unsupported_algorithm");
    }
    throw err;
  }
  if (!(SUPPORTED_COSE_ALGS as readonly number[]).includes(key.alg)) {
    throw new WebAuthnError("unsupported_algorithm");
  }
  const transports = Array.isArray(r.response.transports)
    ? [
        ...new Set(
          r.response.transports.filter(
            (t): t is string => typeof t === "string" && TRANSPORTS.has(t),
          ),
        ),
      ]
    : [];
  return {
    credentialId: rawId.toString("base64url"),
    publicKey: key.spki.toString("base64url"),
    alg: key.alg,
    signCount: auth.signCount,
    userVerified: Boolean(auth.flags & FLAG_UV),
    backupEligible: Boolean(auth.flags & FLAG_BE),
    backedUp: Boolean(auth.flags & FLAG_BS),
    aaguid: auth.attested.aaguid.toString("hex"),
    attestationFormat: fmt.slice(0, 32),
    transports,
  };
}

export type StoredCredentialKey = {
  credentialId: string;
  publicKey: string;
  alg: number;
  signCount: number;
  /** The WebAuthn user handle the credential was created for (base64url). */
  userHandle: string;
};

export type VerifiedAssertion = {
  credentialId: string;
  signCount: number;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
};

/** The credential id an assertion names (to look the stored key up), or a WebAuthnError. */
export function assertionCredentialId(response: unknown): string {
  const r = response as AuthenticationResponseJSON;
  if (!r || typeof r !== "object" || r.type !== "public-key" || !r.response) {
    throw new WebAuthnError("malformed");
  }
  const rawId = fromB64u(r.rawId, MAX_CREDENTIAL_ID);
  if (rawId.length === 0 || r.id !== r.rawId) {
    throw new WebAuthnError("malformed");
  }
  return rawId.toString("base64url");
}

/**
 * §7.2: verify an assertion with the stored credential. A signature counter that does not move
 * forward (unless both are zero: authenticators without a counter) means a cloned
 * authenticator, and the assertion is refused.
 */
export function verifyAssertion(
  response: unknown,
  expected: ExpectedCeremony,
  stored: StoredCredentialKey,
): VerifiedAssertion {
  const id = assertionCredentialId(response);
  if (id !== stored.credentialId) {
    throw new WebAuthnError("credential_mismatch");
  }
  const r = (response as AuthenticationResponseJSON).response;
  const clientData = fromB64u(r.clientDataJSON, 8 * 1024);
  checkClientData(clientData, "webauthn.get", expected);
  const authRaw = fromB64u(r.authenticatorData, 16 * 1024);
  const auth = parseAuthenticatorData(authRaw);
  checkFlags(auth, expected);
  if (r.userHandle !== undefined && r.userHandle !== null && r.userHandle !== "") {
    const handle = fromB64u(r.userHandle, 64);
    if (!sameBytes(handle, Buffer.from(stored.userHandle, "base64url"))) {
      throw new WebAuthnError("user_handle_mismatch");
    }
  }
  const signature = fromB64u(r.signature, 2048);
  let key;
  try {
    key = keyFromSpki(stored.publicKey);
  } catch {
    throw new WebAuthnError("bad_signature");
  }
  const signed = Buffer.concat([authRaw, sha256(clientData)]);
  if (!verifyCoseSignature(stored.alg, key, signed, signature)) {
    throw new WebAuthnError("bad_signature");
  }
  if ((auth.signCount !== 0 || stored.signCount !== 0) && auth.signCount <= stored.signCount) {
    throw new WebAuthnError("sign_count_regression");
  }
  return {
    credentialId: id,
    signCount: auth.signCount,
    userVerified: Boolean(auth.flags & FLAG_UV),
    backupEligible: Boolean(auth.flags & FLAG_BE),
    backedUp: Boolean(auth.flags & FLAG_BS),
  };
}

/**
 * RFC 8176 `amr` values for a passkey: `hwk` for a device-bound key, `swk` for a synced
 * (backup-eligible) one, and `user` when the authenticator verified the person.
 */
export function passkeyAmr(a: { backupEligible: boolean; userVerified: boolean }): string[] {
  return [a.backupEligible ? "swk" : "hwk", ...(a.userVerified ? ["user"] : [])];
}
