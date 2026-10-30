import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type CborValue, CborError, decodeCbor, decodeCborPrefix, encodeCbor } from "./cbor.js";
import {
  COSE_ALG_ES256,
  COSE_ALG_RS256,
  CoseError,
  keyFromSpki,
  parseCoseKey,
  verifyCoseSignature,
} from "./cose.js";
import { type TestAlg, TestAuthenticator } from "./test-authenticator.js";
import {
  type ExpectedCeremony,
  FLAG_BE,
  FLAG_ED,
  FLAG_UP,
  FLAG_UV,
  fromB64u,
  parseAuthenticatorData,
  passkeyAmr,
  verifyAssertion,
  verifyRegistration,
  WebAuthnError,
} from "./verify.js";

const hex = (s: string) => Uint8Array.from(Buffer.from(s.replace(/\s/g, ""), "hex"));
const ORIGIN = "https://kurahi.example.test";
const RP_ID = "kurahi.example.test";

describe("CBOR decoder", () => {
  it("decodes the RFC 8949 Appendix A examples it supports", () => {
    const cases: Array<[string, CborValue]> = [
      ["00", 0],
      ["17", 23],
      ["1818", 24],
      ["1903e8", 1000],
      ["1a000f4240", 1000000],
      ["1b000000e8d4a51000", 1000000000000],
      ["20", -1],
      ["3863", -100],
      ["3903e7", -1000],
      ["f4", false],
      ["f5", true],
      ["f6", null],
      ["f7", undefined],
      ["f93c00", 1],
      ["f97bff", 65504],
      ["fa47c35000", 100000],
      ["fb3ff199999999999a", 1.1],
      ["60", ""],
      ["6161", "a"],
      ["6449455446", "IETF"],
      ["62c3bc", "ü"],
      ["80", []],
      ["83010203", [1, 2, 3]],
      ["8301820203820405", [1, [2, 3], [4, 5]]],
    ];
    for (const [input, expected] of cases) {
      expect(decodeCbor(hex(input)), input).toEqual(expected);
    }
    expect(decodeCbor(hex("4401020304"))).toEqual(Uint8Array.from([1, 2, 3, 4]));
    const map = decodeCbor(hex("a201020304")) as Map<number, number>;
    expect([...map]).toEqual([
      [1, 2],
      [3, 4],
    ]);
    const nested = decodeCbor(hex("a26161016162820203")) as Map<string, CborValue>;
    expect(nested.get("a")).toBe(1);
    expect(nested.get("b")).toEqual([2, 3]);
  });

  it("refuses what WebAuthn never sends and hostile shapes", () => {
    const bad = [
      "", // empty
      "18", // truncated argument
      "1b0020000000000000", // above MAX_SAFE_INTEGER
      "5f42010243030405ff", // indefinite byte string
      "9fff", // indefinite array
      "c11a514b67b0", // tag
      "1c", // reserved additional info
      "f0", // unassigned simple value
      "62c328", // invalid UTF-8
      "a20102 0103", // duplicate map key
      "a1f601", // map key that is not int or text
      "9a7fffffff", // array count beyond the input
      "5a7fffffff00", // byte string longer than the input
      "0001", // trailing bytes
    ];
    for (const input of bad) {
      expect(() => decodeCbor(hex(input)), input).toThrow(CborError);
    }
    // Nesting is bounded.
    expect(() => decodeCbor(new Uint8Array(40).fill(0x81))).toThrow(CborError);
  });

  it("round-trips the encoder and reports where an item ends", () => {
    const value = new Map<number | string, CborValue>([
      [1, 2],
      [-3, Uint8Array.from([9, 8, 7])],
      ["fmt", "none"],
      ["list", [1, -500, 70000, "x", true, null]],
    ]);
    const enc = encodeCbor(value);
    expect(decodeCbor(enc)).toEqual(value);
    const withTail = Uint8Array.from([...enc, 0xde, 0xad]);
    expect(decodeCborPrefix(withTail).end).toBe(enc.length);
  });
});

describe("COSE keys", () => {
  it("imports ES256, RS256 and EdDSA keys and verifies real signatures", () => {
    for (const alg of ["ES256", "RS256", "EdDSA"] as TestAlg[]) {
      const a = new TestAuthenticator(alg);
      const reg = a.register({ challenge: "c", rp: { id: RP_ID }, user: { id: "dQ" } }, ORIGIN);
      const v = verifyRegistration(reg, {
        challenge: "c",
        origins: [ORIGIN],
        rpId: RP_ID,
        requireUserVerification: true,
      });
      const key = keyFromSpki(v.publicKey);
      expect(key.asymmetricKeyType).toBe(
        alg === "ES256" ? "ec" : alg === "RS256" ? "rsa" : "ed25519",
      );
    }
  });

  it("refuses unsupported or malformed keys", () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    const x = Buffer.from(jwk.x, "base64url");
    const y = Buffer.from(jwk.y, "base64url");
    const ec = (patch: Array<[number, CborValue]>) =>
      new Map<number, CborValue>([
        [1, 2],
        [3, COSE_ALG_ES256],
        [-1, 1],
        [-2, x],
        [-3, y],
        ...patch,
      ]);
    expect(parseCoseKey(ec([])).alg).toBe(COSE_ALG_ES256);
    expect(() => parseCoseKey(ec([[3, -36]]))).toThrow(CoseError); // ES512
    expect(() => parseCoseKey(ec([[-1, 2]]))).toThrow(CoseError); // P-384 curve id
    expect(() => parseCoseKey(ec([[-2, x.subarray(1)]]))).toThrow(CoseError);
    // A point that is not on the curve.
    const off = Buffer.from(y);
    off[31] ^= 1;
    expect(() => parseCoseKey(ec([[-3, off]]))).toThrow(CoseError);
    expect(() => parseCoseKey([1, 2])).toThrow(CoseError);
    // RSA below 2048 bits.
    const small = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({
      format: "jwk",
    }) as { n: string; e: string };
    expect(() =>
      parseCoseKey(
        new Map<number, CborValue>([
          [1, 3],
          [3, COSE_ALG_RS256],
          [-1, Buffer.from(small.n, "base64url")],
          [-2, Buffer.from(small.e, "base64url")],
        ]),
      ),
    ).toThrow(CoseError);
    // RSA with an exponent other than 65537 (here 3, and 65537 with a leading zero is fine).
    const big = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({
      format: "jwk",
    }) as { n: string; e: string };
    const rsa = (e: Buffer) =>
      new Map<number, CborValue>([
        [1, 3],
        [3, COSE_ALG_RS256],
        [-1, Buffer.from(big.n, "base64url")],
        [-2, e],
      ]);
    expect(() => parseCoseKey(rsa(Buffer.from([3])))).toThrow(/65537/);
    expect(() => parseCoseKey(rsa(Buffer.from([1, 0, 0, 1])))).toThrow(/65537/);
    expect(parseCoseKey(rsa(Buffer.from([0, 1, 0, 1]))).alg).toBe(COSE_ALG_RS256);
  });

  it("never verifies a signature with a key of another type", () => {
    const { publicKey } = generateKeyPairSync("ed25519");
    expect(verifyCoseSignature(COSE_ALG_ES256, publicKey, Buffer.from("x"), Buffer.alloc(64))).toBe(
      false,
    );
  });
});

describe("authenticator data", () => {
  it("parses flags, counter and attested data, and accounts for every byte", () => {
    const a = new TestAuthenticator("ES256", { signCount: 7 });
    const reg = a.register({ challenge: "c", rp: { id: RP_ID }, user: { id: "dQ" } }, ORIGIN, {
      signCount: 7,
    });
    const att = decodeCbor(fromB64u(reg.response.attestationObject)) as Map<string, CborValue>;
    const raw = att.get("authData") as Uint8Array;
    const parsed = parseAuthenticatorData(raw);
    expect(parsed.signCount).toBe(7);
    expect(parsed.attested?.credentialId.equals(a.credentialId)).toBe(true);
    expect(parsed.rpIdHash.equals(createHash("sha256").update(RP_ID).digest())).toBe(true);
    // Trailing garbage, a truncated buffer, or an ED flag with no extensions are refused.
    expect(() => parseAuthenticatorData(Uint8Array.from([...raw, 0]))).toThrow(WebAuthnError);
    expect(() => parseAuthenticatorData(raw.subarray(0, 50))).toThrow(WebAuthnError);
    const noExt = Buffer.from(raw);
    noExt[32] |= FLAG_ED;
    expect(() => parseAuthenticatorData(noExt)).toThrow(WebAuthnError);
    expect(() => parseAuthenticatorData(new Uint8Array(36))).toThrow(WebAuthnError);
  });
});

describe("WebAuthn ceremonies", () => {
  const expected = (
    challenge: string,
    patch: Partial<ExpectedCeremony> = {},
  ): ExpectedCeremony => ({
    challenge,
    origins: [ORIGIN],
    rpId: RP_ID,
    requireUserVerification: true,
    ...patch,
  });
  const reasonOf = (fn: () => unknown) => {
    try {
      fn();
    } catch (err) {
      return err instanceof WebAuthnError ? err.reason : String(err);
    }
    return "accepted";
  };

  function enrolled(alg: TestAlg = "ES256", opts: { backupEligible?: boolean } = {}) {
    const a = new TestAuthenticator(alg, opts);
    const handle = randomBytes(32).toString("base64url");
    const reg = verifyRegistration(
      a.register({ challenge: "reg", rp: { id: RP_ID }, user: { id: handle } }, ORIGIN),
      expected("reg"),
    );
    return { a, stored: { ...reg, userHandle: handle } };
  }

  for (const alg of ["ES256", "RS256", "EdDSA"] as TestAlg[]) {
    it(`${alg}: registers and signs in`, () => {
      const { a, stored } = enrolled(alg);
      const out = verifyAssertion(
        a.assert({ challenge: "sign", rpId: RP_ID }, ORIGIN),
        expected("sign"),
        stored,
      );
      expect(out.credentialId).toBe(stored.credentialId);
      expect(out.userVerified).toBe(true);
      expect(out.signCount).toBe(2);
    });
  }

  it("registration failures: origin, RP id, challenge, type, UV, attestation", () => {
    const a = new TestAuthenticator();
    const opts = { challenge: "c", rp: { id: RP_ID }, user: { id: "dQ" } };
    const reg = (o: Parameters<TestAuthenticator["register"]>[2]) =>
      reasonOf(() => verifyRegistration(a.register(opts, ORIGIN, o), expected("c")));
    expect(reg({ origin: "https://evil.example" })).toBe("origin_mismatch");
    expect(reg({ rpId: "evil.example" })).toBe("rp_id_mismatch");
    expect(reg({ challenge: "other" })).toBe("challenge_mismatch");
    expect(reg({ type: "webauthn.get" })).toBe("wrong_type");
    expect(reg({ crossOrigin: true })).toBe("cross_origin");
    expect(reg({ flags: FLAG_UP })).toBe("user_not_verified");
    expect(reg({ flags: FLAG_UV })).toBe("user_not_present");
    expect(reg({ attStmt: new Map([["sig", Uint8Array.from([1])]]) })).toBe("attestation_invalid");
    // UV "preferred": a present but unverified user registers.
    expect(
      verifyRegistration(a.register(opts, ORIGIN, { flags: FLAG_UP }), {
        ...expected("c"),
        requireUserVerification: false,
      }).userVerified,
    ).toBe(false);
    // Other attestation formats are accepted without trusting the statement.
    expect(reg({ fmt: "packed", attStmt: new Map([["alg", -7]]) })).toBe("accepted");
    // The credential id in authenticator data must be the one the browser reports.
    const swapped = a.register(opts, ORIGIN);
    const other = randomBytes(32).toString("base64url");
    expect(
      reasonOf(() => verifyRegistration({ ...swapped, id: other, rawId: other }, expected("c"))),
    ).toBe("credential_mismatch");
    expect(reasonOf(() => verifyRegistration({ type: "public-key" }, expected("c")))).toBe(
      "malformed",
    );
    expect(
      reasonOf(() =>
        verifyRegistration(
          { ...swapped, response: { ...swapped.response, attestationObject: "!!" } },
          expected("c"),
        ),
      ),
    ).toBe("malformed");
  });

  it("assertion failures: origin, RP id, challenge, UV, signature, user handle, counter", () => {
    const { a, stored } = enrolled();
    const sign = (o: Parameters<TestAuthenticator["assert"]>[2], s = stored) =>
      reasonOf(() =>
        verifyAssertion(a.assert({ challenge: "s", rpId: RP_ID }, ORIGIN, o), expected("s"), s),
      );
    expect(sign({ origin: "https://kurahi.example.test.evil.example" })).toBe("origin_mismatch");
    expect(sign({ origin: "http://kurahi.example.test" })).toBe("origin_mismatch");
    expect(sign({ rpId: "example.test" })).toBe("rp_id_mismatch");
    expect(sign({ challenge: "replayed" })).toBe("challenge_mismatch");
    expect(sign({ type: "webauthn.create" })).toBe("wrong_type");
    expect(sign({ flags: FLAG_UP })).toBe("user_not_verified");
    expect(sign({ wrongKey: true })).toBe("bad_signature");
    expect(sign({ userHandle: randomBytes(32).toString("base64url") })).toBe(
      "user_handle_mismatch",
    );
    expect(sign({ signCount: 0 }, { ...stored, signCount: 5 })).toBe("sign_count_regression");
    expect(sign({ signCount: 5 }, { ...stored, signCount: 5 })).toBe("sign_count_regression");
    expect(sign({ signCount: 6 }, { ...stored, signCount: 5 })).toBe("accepted");
    // Authenticators without a counter (always 0) are fine.
    expect(sign({ signCount: 0 }, { ...stored, signCount: 0 })).toBe("accepted");
    // Another credential's assertion is not checked against this key.
    const other = new TestAuthenticator();
    other.userHandle = stored.userHandle;
    expect(
      reasonOf(() =>
        verifyAssertion(
          other.assert({ challenge: "s", rpId: RP_ID }, ORIGIN),
          expected("s"),
          stored,
        ),
      ),
    ).toBe("credential_mismatch");
  });

  it("amr: hwk for device-bound keys, swk for synced ones, user when verified", () => {
    expect(passkeyAmr({ backupEligible: false, userVerified: true })).toEqual(["hwk", "user"]);
    expect(passkeyAmr({ backupEligible: true, userVerified: false })).toEqual(["swk"]);
    const { a, stored } = enrolled("ES256", { backupEligible: true });
    expect(stored.backupEligible).toBe(true);
    const out = verifyAssertion(
      a.assert({ challenge: "x", rpId: RP_ID }, ORIGIN, { flags: FLAG_UP | FLAG_UV | FLAG_BE }),
      expected("x"),
      stored,
    );
    expect(passkeyAmr(out)).toEqual(["swk", "user"]);
  });

  it("base64url input is strict", () => {
    expect(() => fromB64u("ab+c")).toThrow(WebAuthnError);
    expect(() => fromB64u("abc=")).toThrow(WebAuthnError);
    expect(() => fromB64u(42)).toThrow(WebAuthnError);
    // Non-canonical trailing bits.
    expect(() => fromB64u("AB")).toThrow(WebAuthnError);
    expect(fromB64u("AA").equals(Buffer.from([0]))).toBe(true);
  });
});
