// One-time codes from an authenticator app: TOTP (RFC 6238) over HOTP (RFC 4226). Kurahi uses
// SHA-1, 6 digits and 30-second steps (what every authenticator app supports), accepts the
// previous, current and next step for clock drift, and refuses a step at or before the last
// one used by that person (a code works once). The other hashes and lengths exist for the
// RFC 6238 test vectors.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted on either side of the current one. */
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;

export type TotpHash = "sha1" | "sha256" | "sha512";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** RFC 4648 base32 without padding (how otpauth:// URIs carry the secret). */
export function base32Encode(data: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Base32 → bytes; spaces, dashes, padding and lower case are tolerated. Null when invalid. */
export function base32Decode(text: string): Buffer | null {
  const clean = text.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) {
      return null;
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): Buffer {
  return randomBytes(TOTP_SECRET_BYTES);
}

/** RFC 4226 HOTP with dynamic truncation. */
export function hotp(
  secret: Uint8Array,
  counter: number,
  digits = TOTP_DIGITS,
  hash: TotpHash = "sha1",
): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(hash, secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(unixSeconds: number, stepSeconds = TOTP_STEP_SECONDS): number {
  return Math.floor(unixSeconds / stepSeconds);
}

/** The code for a moment (RFC 6238). */
export function totp(
  secret: Uint8Array,
  unixSeconds: number,
  opts: { digits?: number; hash?: TotpHash; stepSeconds?: number } = {},
): string {
  return hotp(secret, totpStep(unixSeconds, opts.stepSeconds), opts.digits, opts.hash);
}

/**
 * Check a 6-digit code at `unixSeconds` (±TOTP_WINDOW steps). Returns the matched step, or null.
 * Steps at or before `lastStep` are never accepted (replay of a used code, or of an older one).
 */
export function verifyTotp(
  secret: Uint8Array,
  code: string,
  unixSeconds: number,
  lastStep: number | null,
): number | null {
  if (!/^\d{6}$/.test(code)) {
    return null;
  }
  const now = totpStep(unixSeconds);
  let matched: number | null = null;
  // Check every step in the window (no early exit) so timing does not tell which one matched.
  for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step += 1) {
    const ok = timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code));
    if (ok && matched === null && (lastStep === null || step > lastStep)) {
      matched = step;
    }
  }
  return matched;
}

/** otpauth:// URI for authenticator apps (QR code or manual entry). */
export function otpauthUri(opts: { secret: Uint8Array; issuer: string; account: string }): string {
  const label = `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`;
  const q = new URLSearchParams({
    secret: base32Encode(opts.secret),
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
