import { describe, expect, it } from "vitest";
import {
  base32Decode,
  base32Encode,
  hotp,
  otpauthUri,
  totp,
  type TotpHash,
  totpStep,
  verifyTotp,
} from "./totp.js";

const SEED: Record<TotpHash, Buffer> = {
  sha1: Buffer.from("12345678901234567890"),
  sha256: Buffer.from("12345678901234567890123456789012"),
  sha512: Buffer.from("1234567890".repeat(6) + "1234"),
};

describe("TOTP (RFC 6238)", () => {
  it("matches the RFC 4226 Appendix D HOTP values", () => {
    const expected = [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ];
    expected.forEach((code, counter) => expect(hotp(SEED.sha1, counter)).toBe(code));
  });

  it("matches the RFC 6238 Appendix B test vectors", () => {
    const vectors: Array<[number, Record<TotpHash, string>]> = [
      [59, { sha1: "94287082", sha256: "46119246", sha512: "90693936" }],
      [1111111109, { sha1: "07081804", sha256: "68084774", sha512: "25091201" }],
      [1111111111, { sha1: "14050471", sha256: "67062674", sha512: "99943326" }],
      [1234567890, { sha1: "89005924", sha256: "91819424", sha512: "93441116" }],
      [2000000000, { sha1: "69279037", sha256: "90698825", sha512: "38618901" }],
      [20000000000, { sha1: "65353130", sha256: "77737706", sha512: "47863826" }],
    ];
    for (const [t, codes] of vectors) {
      for (const hash of ["sha1", "sha256", "sha512"] as TotpHash[]) {
        expect(totp(SEED[hash], t, { digits: 8, hash }), `${hash}@${t}`).toBe(codes[hash]);
      }
    }
  });

  it("accepts ±1 step, never a step at or before the last one used", () => {
    const t = 1111111111;
    const step = totpStep(t);
    const code = totp(SEED.sha1, t);
    expect(verifyTotp(SEED.sha1, code, t, null)).toBe(step);
    // Clock drift: the previous and next step still count, two steps away does not.
    expect(verifyTotp(SEED.sha1, code, t + 30, null)).toBe(step);
    expect(verifyTotp(SEED.sha1, code, t - 30, null)).toBe(step);
    expect(verifyTotp(SEED.sha1, code, t + 60, null)).toBeNull();
    // Replay: the same step again, or an older one, is refused.
    expect(verifyTotp(SEED.sha1, code, t, step)).toBeNull();
    expect(verifyTotp(SEED.sha1, totp(SEED.sha1, t - 30), t, step)).toBeNull();
    expect(verifyTotp(SEED.sha1, totp(SEED.sha1, t + 30), t, step)).toBe(step + 1);
    // Malformed codes.
    for (const bad of ["", "12345", "1234567", "12345a", " 123456"]) {
      expect(verifyTotp(SEED.sha1, bad, t, null)).toBeNull();
    }
  });

  it("base32 round-trips (RFC 4648 vectors) and builds otpauth URIs", () => {
    expect(base32Encode(Buffer.from("foobar"))).toBe("MZXW6YTBOI");
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Decode("mzxw 6ytb-oi======")?.toString()).toBe("foobar");
    expect(base32Decode("MZ1")).toBeNull();
    expect(base32Decode(base32Encode(SEED.sha1))?.equals(SEED.sha1)).toBe(true);
    const uri = otpauthUri({ secret: SEED.sha1, issuer: "Kurahi", account: "alice@example.com" });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Kurahi:alice%40example\.com\?/);
    const q = new URL(uri).searchParams;
    expect(q.get("secret")).toBe(base32Encode(SEED.sha1));
    expect(q.get("digits")).toBe("6");
    expect(q.get("period")).toBe("30");
    expect(q.get("algorithm")).toBe("SHA1");
  });
});
