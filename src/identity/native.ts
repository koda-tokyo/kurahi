// Command-line and native app sign-in: the gateway is the authorization server for its own
// sessions. Both flows end in a NEW `kss_` session for the person who signed in through the
// normal SSO in a browser; no app ever sees an IdP secret or the browser's own session token.
//
// - Command line: OAuth 2.0 Device Authorization Grant (RFC 8628). The CLI gets a device code
//   (kept here only as a SHA-256 hash) and a short user code; the person opens the verification
//   page, signs in, checks the client and the requesting address and approves or denies; the CLI
//   polls the token endpoint. Codes live 10 minutes and redeem once.
// - Native apps: authorization code with PKCE (S256) for public clients and loopback or
//   private-use scheme redirects (RFC 8252). The code goes to the app's redirect URI after the
//   person confirms in the system browser; the token only ever travels in the token response.
//
// User codes are 8 letters from a 20-letter alphabet without vowels or look-alikes (RFC 8628
// 6.1), about 2^34 possibilities. Guessing needs a signed-in person, and every failed guess
// counts against that person and the source address (USER_CODE_FAILURES per window, see
// native-http.ts). A miss never affects other people's pending codes, so nobody can lock
// someone else's sign-in by guessing wrong.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { IdentityNativeClientConfig } from "../config/types.identity.js";
import type { SessionGrant } from "./types.js";

/** How long a device code and its user code stay valid (RFC 8628 suggests at most 30 min). */
export const DEVICE_CODE_TTL_MS = 600_000;
/** Minimum seconds between token polls; a faster poll gets slow_down and 5 s more. */
export const DEVICE_POLL_INTERVAL_SEC = 5;
/** RFC 8628 6.1: consonants only (no vowels, so no words), no look-alikes. */
export const USER_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const USER_CODE_LENGTH = 8;
export const MAX_PENDING_DEVICE = 500;
export const MAX_PENDING_DEVICE_PER_SOURCE = 10;
/** A native sign-in request waits this long for the browser sign-in. */
export const NATIVE_REQUEST_TTL_MS = 600_000;
export const MAX_PENDING_NATIVE = 500;
export const MAX_PENDING_NATIVE_PER_SOURCE = 20;
/** An authorization code for a native app works once, within this time. */
export const AUTH_CODE_TTL_MS = 60_000;
const MAX_AUTH_CODES = 1_000;

/** Pages that finish a browser sign-in for the command line or a native app. */
export const DEVICE_VERIFY_PATH = "/api/identity/device";
export const NATIVE_CONTINUE_PATH = "/api/identity/oauth/continue";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Upper-case, drop separators; null unless 8 letters of the alphabet. */
export function normalizeUserCode(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 32) {
    return null;
  }
  const v = raw.toUpperCase().replace(/[\s-]/g, "");
  if (v.length !== USER_CODE_LENGTH) {
    return null;
  }
  for (const ch of v) {
    if (!USER_CODE_ALPHABET.includes(ch)) {
      return null;
    }
  }
  return v;
}

/** `BCDF-GHJK`. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function newUserCode(): string {
  let out = "";
  for (let i = 0; i < USER_CODE_LENGTH; i += 1) {
    out += USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * A sign-in return target for the command-line or native pages (they finish the browser
 * sign-in themselves), else null. Exactly the page path with its one known parameter.
 */
export function signInPageReturnTo(raw: string | null | undefined): string | null {
  const v = (raw ?? "").trim();
  if (v === DEVICE_VERIFY_PATH) {
    return v;
  }
  const device = /^\/api\/identity\/device\?user_code=([A-Za-z-]{8,9})$/.exec(v);
  if (device) {
    const code = normalizeUserCode(device[1]);
    return code ? `${DEVICE_VERIFY_PATH}?user_code=${formatUserCode(code)}` : null;
  }
  return /^\/api\/identity\/oauth\/continue\?request=[A-Za-z0-9_-]{43}$/.test(v) ? v : null;
}

// ---------------------------------------------------------------------------------------------
// Device authorization grant (RFC 8628)

export type DeviceRequestView = {
  userCode: string;
  clientId: string;
  clientName: string;
  /** What the device says it is (user@host): not verified. */
  deviceName: string | null;
  /** The address the request came from (as the gateway sees it). */
  ip: string | null;
  requestedAt: string;
  expiresAt: string;
};

type DeviceRequest = DeviceRequestView & {
  deviceCodeHash: string;
  source: string;
  expiresAtMs: number;
  interval: number;
  lastPollMs: number | null;
  status: "pending" | "approved" | "denied" | "locked";
  grant: SessionGrant | null;
  decidedBy: string | null;
};

export type DevicePoll =
  | { kind: "authorization_pending" }
  | { kind: "slow_down"; interval: number }
  | { kind: "access_denied"; reason: "denied" | "locked" }
  | { kind: "expired_token" }
  | { kind: "invalid_grant" }
  | { kind: "approved"; grant: SessionGrant; request: DeviceRequestView };

export class DeviceAuthorizations {
  private readonly now: () => number;
  /** By device code hash. */
  private readonly requests = new Map<string, DeviceRequest>();
  /** User code → device code hash. */
  private readonly byUserCode = new Map<string, string>();

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  /** Forget requests that ended a while ago (an expired one still answers expired_token). */
  private prune(): void {
    const t = this.now();
    for (const [hash, r] of this.requests) {
      if (r.expiresAtMs + DEVICE_CODE_TTL_MS <= t) {
        this.drop(hash, r);
      }
    }
  }

  private drop(hash: string, r: DeviceRequest): void {
    this.requests.delete(hash);
    if (this.byUserCode.get(r.userCode) === hash) {
      this.byUserCode.delete(r.userCode);
    }
  }

  private live(r: DeviceRequest): boolean {
    return r.expiresAtMs > this.now();
  }

  get size(): number {
    return this.requests.size;
  }

  start(input: {
    clientId: string;
    clientName: string;
    deviceName: string | null;
    ip: string | null;
    source: string;
  }):
    | { ok: true; deviceCode: string; userCode: string; expiresIn: number; interval: number }
    | { ok: false; reason: "capacity" | "source_quota" } {
    this.prune();
    let live = 0;
    let fromSource = 0;
    for (const r of this.requests.values()) {
      if (this.live(r)) {
        live += 1;
        fromSource += r.source === input.source ? 1 : 0;
      }
    }
    if (fromSource >= MAX_PENDING_DEVICE_PER_SOURCE) {
      return { ok: false, reason: "source_quota" };
    }
    if (live >= MAX_PENDING_DEVICE || this.requests.size >= MAX_PENDING_DEVICE * 2) {
      return { ok: false, reason: "capacity" };
    }
    let userCode = newUserCode();
    while (this.byUserCode.has(userCode)) {
      userCode = newUserCode();
    }
    const deviceCode = randomBytes(32).toString("base64url");
    const t = this.now();
    const hash = sha256(deviceCode);
    this.requests.set(hash, {
      userCode: formatUserCode(userCode),
      clientId: input.clientId,
      clientName: input.clientName,
      deviceName: input.deviceName,
      ip: input.ip,
      requestedAt: new Date(t).toISOString(),
      expiresAt: new Date(t + DEVICE_CODE_TTL_MS).toISOString(),
      deviceCodeHash: hash,
      source: input.source,
      expiresAtMs: t + DEVICE_CODE_TTL_MS,
      interval: DEVICE_POLL_INTERVAL_SEC,
      lastPollMs: null,
      status: "pending",
      grant: null,
      decidedBy: null,
    });
    this.byUserCode.set(userCode, hash);
    return {
      ok: true,
      deviceCode,
      userCode: formatUserCode(userCode),
      expiresIn: DEVICE_CODE_TTL_MS / 1000,
      interval: DEVICE_POLL_INTERVAL_SEC,
    };
  }

  /**
   * The pending request a person typed the user code of, or null. A miss never touches other
   * people's pending codes: wrong guesses are limited per approving person and per source
   * address by the caller (native-http.ts), so nobody can lock someone else's sign-in by
   * guessing. The code space (8 characters of 20) keeps blind guessing hopeless within those
   * limits.
   */
  find(rawUserCode: unknown): DeviceRequestView | null {
    const code = normalizeUserCode(rawUserCode);
    const hash = code ? this.byUserCode.get(code) : undefined;
    const r = hash ? this.requests.get(hash) : undefined;
    return r && r.status === "pending" && this.live(r) ? this.view(r) : null;
  }

  private view(r: DeviceRequest): DeviceRequestView {
    return {
      userCode: r.userCode,
      clientId: r.clientId,
      clientName: r.clientName,
      deviceName: r.deviceName,
      ip: r.ip,
      requestedAt: r.requestedAt,
      expiresAt: r.expiresAt,
    };
  }

  /** Approve (with the approving sign-in) or deny a pending request found by `find`. */
  decide(
    rawUserCode: unknown,
    decision: { approve: true; grant: SessionGrant; by: string } | { approve: false; by: string },
  ): DeviceRequestView | null {
    const code = normalizeUserCode(rawUserCode);
    const hash = code ? this.byUserCode.get(code) : undefined;
    const r = hash ? this.requests.get(hash) : undefined;
    if (!r || r.status !== "pending" || !this.live(r)) {
      return null;
    }
    r.status = decision.approve ? "approved" : "denied";
    r.grant = decision.approve ? decision.grant : null;
    r.decidedBy = decision.by;
    return this.view(r);
  }

  /** One token poll by the device (RFC 8628 3.4 / 3.5). */
  poll(deviceCode: string, clientId: string): DevicePoll {
    if (!deviceCode || deviceCode.length > 128) {
      return { kind: "invalid_grant" };
    }
    const hash = sha256(deviceCode);
    const r = this.requests.get(hash);
    if (!r || r.clientId !== clientId) {
      return { kind: "invalid_grant" };
    }
    const t = this.now();
    if (!this.live(r)) {
      this.drop(hash, r);
      return { kind: "expired_token" };
    }
    if (r.status === "denied" || r.status === "locked") {
      this.drop(hash, r);
      return { kind: "access_denied", reason: r.status };
    }
    if (r.status === "approved" && r.grant) {
      // One-time: the device code is spent whatever the session issue then decides.
      this.drop(hash, r);
      return { kind: "approved", grant: r.grant, request: this.view(r) };
    }
    const tooFast = r.lastPollMs !== null && t - r.lastPollMs < r.interval * 1000;
    r.lastPollMs = t;
    if (tooFast) {
      r.interval += 5;
      return { kind: "slow_down", interval: r.interval };
    }
    return { kind: "authorization_pending" };
  }
}

// ---------------------------------------------------------------------------------------------
// Native apps: authorization code + PKCE, loopback or private-use scheme redirect (RFC 8252)

const LOOPBACK_RE = /^http:\/\/(127\.0\.0\.1|\[::1\])(?::(\d{1,5}))?(\/[^#\s\\]*)?$/;

/**
 * The redirect URI if `client` may use it, else null. Loopback clients: `http://127.0.0.1` or
 * `http://[::1]` with any port (RFC 8252 7.3), never `localhost` (8.3). Scheme clients:
 * `<scheme>:/…` with their own reverse-domain scheme. Never a fragment.
 */
export function checkRedirectUri(
  client: IdentityNativeClientConfig,
  raw: string | null | undefined,
): string | null {
  const v = raw ?? "";
  if (!v || v.length > 512 || /[\s#]/.test(v)) {
    return null;
  }
  for (let i = 0; i < v.length; i += 1) {
    const c = v.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      return null;
    }
  }
  if (client.redirect === "loopback") {
    const m = LOOPBACK_RE.exec(v);
    if (!m || (m[2] !== undefined && (Number(m[2]) < 1 || Number(m[2]) > 65535))) {
      return null;
    }
  } else if (!v.startsWith(`${client.redirect}:/`) || v.startsWith(`${client.redirect}://`)) {
    // RFC 8252 7.1: `com.example.app:/path`, a single slash (no authority).
    return null;
  }
  try {
    new URL(v);
  } catch {
    return null;
  }
  return v;
}

/** PKCE S256 challenge: base64url(SHA-256(verifier)), 43 characters. */
export function isS256Challenge(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/** RFC 7636 4.1: 43–128 unreserved characters. */
export function isCodeVerifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._~-]{43,128}$/.test(value);
}

export function s256(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export type NativeRequest = {
  id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  source: string;
  bindingHash: string;
  expiresAtMs: number;
};

type AuthCode = {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  grant: SessionGrant;
  expiresAtMs: number;
};

export type NativeRedeem =
  | { ok: true; grant: SessionGrant; clientId: string; clientName: string }
  | { ok: false; reason: "code_unknown" | "code_expired" | "client_mismatch" | "pkce_mismatch" };

export class NativeAuthorizations {
  private readonly now: () => number;
  private readonly requests = new Map<string, NativeRequest>();
  /** By code hash. */
  private readonly codes = new Map<string, AuthCode>();

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  private prune(): void {
    const t = this.now();
    for (const [id, r] of this.requests) {
      if (r.expiresAtMs <= t) {
        this.requests.delete(id);
      }
    }
    for (const [hash, c] of this.codes) {
      if (c.expiresAtMs <= t) {
        this.codes.delete(hash);
      }
    }
  }

  /** Hold a request until the browser sign-in returns; `binding` goes into the browser cookie. */
  begin(
    input: Omit<NativeRequest, "id" | "bindingHash" | "expiresAtMs">,
  ):
    | { ok: true; id: string; binding: string }
    | { ok: false; reason: "capacity" | "source_quota" } {
    this.prune();
    let fromSource = 0;
    for (const r of this.requests.values()) {
      fromSource += r.source === input.source ? 1 : 0;
    }
    if (fromSource >= MAX_PENDING_NATIVE_PER_SOURCE) {
      return { ok: false, reason: "source_quota" };
    }
    if (this.requests.size >= MAX_PENDING_NATIVE) {
      return { ok: false, reason: "capacity" };
    }
    const id = randomBytes(32).toString("base64url");
    const binding = randomBytes(24).toString("base64url");
    this.requests.set(id, {
      ...input,
      id,
      bindingHash: sha256(binding),
      expiresAtMs: this.now() + NATIVE_REQUEST_TTL_MS,
    });
    return { ok: true, id, binding };
  }

  /** The request, if it is live and `binding` is the starting browser's; used once. */
  take(id: string, binding: string | null): NativeRequest | null {
    const r = this.requests.get(id);
    if (!r || !binding || !sameText(sha256(binding), r.bindingHash)) {
      return null;
    }
    this.requests.delete(id);
    return r.expiresAtMs > this.now() ? r : null;
  }

  /** Peek (no use) for showing the confirmation page. */
  peek(id: string, binding: string | null): NativeRequest | null {
    const r = this.requests.get(id);
    if (
      !r ||
      !binding ||
      !sameText(sha256(binding), r.bindingHash) ||
      r.expiresAtMs <= this.now()
    ) {
      return null;
    }
    return r;
  }

  issueCode(r: NativeRequest, grant: SessionGrant): string {
    this.prune();
    while (this.codes.size >= MAX_AUTH_CODES) {
      const [oldest] = this.codes.keys();
      if (oldest === undefined) {
        break;
      }
      this.codes.delete(oldest);
    }
    const code = randomBytes(32).toString("base64url");
    this.codes.set(sha256(code), {
      clientId: r.clientId,
      clientName: r.clientName,
      redirectUri: r.redirectUri,
      codeChallenge: r.codeChallenge,
      grant,
      expiresAtMs: this.now() + AUTH_CODE_TTL_MS,
    });
    return code;
  }

  /** Exchange a code (single use, whatever the outcome) for the grant it carries. */
  redeem(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
  }): NativeRedeem {
    if (!input.code || input.code.length > 128) {
      return { ok: false, reason: "code_unknown" };
    }
    const hash = sha256(input.code);
    const c = this.codes.get(hash);
    if (!c) {
      return { ok: false, reason: "code_unknown" };
    }
    this.codes.delete(hash);
    if (c.expiresAtMs <= this.now()) {
      return { ok: false, reason: "code_expired" };
    }
    if (c.clientId !== input.clientId || c.redirectUri !== input.redirectUri) {
      return { ok: false, reason: "client_mismatch" };
    }
    if (
      !isCodeVerifier(input.codeVerifier) ||
      !sameText(s256(input.codeVerifier), c.codeChallenge)
    ) {
      return { ok: false, reason: "pkce_mismatch" };
    }
    return { ok: true, grant: c.grant, clientId: c.clientId, clientName: c.clientName };
  }
}
