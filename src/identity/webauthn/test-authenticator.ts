// Tests only: a software WebAuthn authenticator with real keys (ES256, RS256, EdDSA) that
// answers registration and authentication ceremonies the way a browser would hand them over
// (PublicKeyCredential.toJSON()). Never imported by runtime code.
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { type CborValue, encodeCbor } from "./cbor.js";
import { COSE_ALG_EDDSA, COSE_ALG_ES256, COSE_ALG_RS256 } from "./cose.js";
import { FLAG_AT, FLAG_BE, FLAG_UP, FLAG_UV } from "./verify.js";

export type TestAlg = "ES256" | "RS256" | "EdDSA";

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest();
const b64u = (b: Uint8Array) => Buffer.from(b).toString("base64url");

function coseKey(alg: TestAlg, publicKey: KeyObject): Map<number, CborValue> {
  const jwk = publicKey.export({ format: "jwk" }) as Record<string, string>;
  const b = (s: string) => Buffer.from(s, "base64url");
  if (alg === "ES256") {
    return new Map<number, CborValue>([
      [1, 2],
      [3, COSE_ALG_ES256],
      [-1, 1],
      [-2, b(jwk.x)],
      [-3, b(jwk.y)],
    ]);
  }
  if (alg === "RS256") {
    return new Map<number, CborValue>([
      [1, 3],
      [3, COSE_ALG_RS256],
      [-1, b(jwk.n)],
      [-2, b(jwk.e)],
    ]);
  }
  return new Map<number, CborValue>([
    [1, 1],
    [3, COSE_ALG_EDDSA],
    [-1, 6],
    [-2, b(jwk.x)],
  ]);
}

function keyPair(alg: TestAlg) {
  if (alg === "ES256") {
    return generateKeyPairSync("ec", { namedCurve: "P-256" });
  }
  if (alg === "RS256") {
    return generateKeyPairSync("rsa", { modulusLength: 2048 });
  }
  return generateKeyPairSync("ed25519");
}

export type CeremonyOverrides = {
  origin?: string;
  rpId?: string;
  type?: string;
  challenge?: string;
  crossOrigin?: boolean;
  flags?: number;
  signCount?: number;
  userHandle?: string | null;
  /** Sign with another key (bad signature). */
  wrongKey?: boolean;
};

export class TestAuthenticator {
  readonly credentialId: Buffer;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  signCount: number;
  userHandle: string | null = null;
  backupEligible: boolean;

  constructor(
    readonly alg: TestAlg = "ES256",
    opts: { signCount?: number; backupEligible?: boolean } = {},
  ) {
    this.credentialId = randomBytes(32);
    const kp = keyPair(alg);
    this.privateKey = kp.privateKey;
    this.publicKey = kp.publicKey;
    this.signCount = opts.signCount ?? 1;
    this.backupEligible = opts.backupEligible ?? false;
  }

  private authData(rpId: string, flags: number, signCount: number, attested: boolean): Buffer {
    const head = Buffer.alloc(37);
    sha256(rpId).copy(head, 0);
    head[32] = flags;
    head.writeUInt32BE(signCount >>> 0, 33);
    if (!attested) {
      return head;
    }
    const idLen = Buffer.alloc(2);
    idLen.writeUInt16BE(this.credentialId.length);
    return Buffer.concat([
      head,
      Buffer.alloc(16),
      idLen,
      this.credentialId,
      Buffer.from(encodeCbor(coseKey(this.alg, this.publicKey))),
    ]);
  }

  private clientData(type: string, challenge: string, o: CeremonyOverrides, origin: string) {
    return Buffer.from(
      JSON.stringify({
        type: o.type ?? type,
        challenge: o.challenge ?? challenge,
        origin: o.origin ?? origin,
        ...(o.crossOrigin === undefined ? {} : { crossOrigin: o.crossOrigin }),
      }),
    );
  }

  private defaultFlags(): number {
    return FLAG_UP | FLAG_UV | (this.backupEligible ? FLAG_BE : 0);
  }

  /** navigator.credentials.create() → toJSON(). */
  register(
    options: { challenge: string; rp: { id: string }; user: { id: string } },
    origin: string,
    o: CeremonyOverrides & { fmt?: string; attStmt?: Map<string, CborValue> } = {},
  ) {
    this.userHandle = options.user.id;
    const authData = this.authData(
      o.rpId ?? options.rp.id,
      (o.flags ?? this.defaultFlags()) | FLAG_AT,
      o.signCount ?? 0,
      true,
    );
    const attestationObject = encodeCbor(
      new Map<string, CborValue>([
        ["fmt", o.fmt ?? "none"],
        ["attStmt", o.attStmt ?? new Map()],
        ["authData", authData],
      ]),
    );
    const id = b64u(this.credentialId);
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(this.clientData("webauthn.create", options.challenge, o, origin)),
        attestationObject: b64u(attestationObject),
        transports: ["internal", "hybrid"],
      },
    };
  }

  /** navigator.credentials.get() → toJSON(). Advances the sign counter unless overridden. */
  assert(options: { challenge: string; rpId: string }, origin: string, o: CeremonyOverrides = {}) {
    if (o.signCount === undefined && this.signCount > 0) {
      this.signCount += 1;
    }
    const authData = this.authData(
      o.rpId ?? options.rpId,
      o.flags ?? this.defaultFlags(),
      o.signCount ?? this.signCount,
      false,
    );
    const clientData = this.clientData("webauthn.get", options.challenge, o, origin);
    const signed = Buffer.concat([authData, sha256(clientData)]);
    const key = o.wrongKey ? keyPair(this.alg).privateKey : this.privateKey;
    const signature =
      this.alg === "EdDSA"
        ? sign(null, signed, key)
        : sign("sha256", signed, this.alg === "ES256" ? { key, dsaEncoding: "der" } : key);
    const id = b64u(this.credentialId);
    const handle = o.userHandle === undefined ? this.userHandle : o.userHandle;
    return {
      id,
      rawId: id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientData),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(handle ? { userHandle: handle } : {}),
      },
    };
  }
}
