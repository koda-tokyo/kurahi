// Phone pairing link (KoLo 2.0, M16): `kolo connect web` prints a QR of
// `<dashboard>#pair=<invitation code>`. The code lives in the URL fragment, so it never reaches a
// server log or a Referer. On load the dashboard takes it out of the address bar, proves
// possession of the browser's device key (the same Ed25519 identity the gateway connection
// signs with) and redeems it for a scoped pairing credential (`kpa_…`), then keeps that
// credential fresh with the single-use refresh token.
//
// Browsers expose WebCrypto only on secure pages, so this works over HTTPS (gateway.tls) and on
// localhost; on plain HTTP the dashboard says so instead of failing silently.
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  type DeviceIdentity,
} from "./device-identity";
import { SECRET_STORAGE_KEYS, secretStorage } from "./secret-storage";

const STORAGE_KEY = SECRET_STORAGE_KEYS.pairCredential;
/** Refresh this long before the access token expires. */
const REFRESH_MARGIN_MS = 5 * 60_000;

export type PairCredential = {
  version: 1;
  fingerprint: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  scope: string;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The invitation code in `#pair=<code>` (other fragment parameters are kept), or null. */
export function readPairCode(hash: string): { code: string; rest: string } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) {
    return null;
  }
  const params = new URLSearchParams(raw);
  const code = params.get("pair")?.trim();
  if (!code || !/^kpi_[A-Za-z0-9_-]{8,}$/.test(code)) {
    return null;
  }
  params.delete("pair");
  const rest = params.toString();
  return { code, rest: rest ? `#${rest}` : "" };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** What the device signs on redeem/refresh: `kolo-pair-v1|<purpose>|<nonce>|<sha256(secret)>`. */
export async function pairProofPayload(
  purpose: "redeem" | "refresh",
  nonce: string,
  secret: string,
): Promise<string> {
  return `kolo-pair-v1|${purpose}|${nonce}|${await sha256Hex(secret)}`;
}

export function isSecurePage(): boolean {
  return typeof crypto !== "undefined" && Boolean(crypto.subtle);
}

async function fetchNonce(fetchImpl: FetchLike, origin: string): Promise<string> {
  const res = await fetchImpl(`${origin}/api/pair/nonce`, {
    headers: { accept: "application/json" },
  });
  const body = (await res.json().catch(() => ({}))) as { nonce?: unknown };
  if (!res.ok || typeof body.nonce !== "string") {
    throw new Error("pairing: the gateway did not issue a nonce");
  }
  return body.nonce;
}

function toCredential(body: Record<string, unknown>, fingerprint: string): PairCredential {
  const device = body.device as { scope?: string } | undefined;
  return {
    version: 1,
    fingerprint,
    accessToken: String(body.accessToken),
    accessExpiresAt: String(body.accessExpiresAt),
    refreshToken: String(body.refreshToken),
    refreshExpiresAt: String(body.refreshExpiresAt),
    scope: device?.scope ?? "attach",
  };
}

function errorOf(body: unknown, fallback: string): string {
  const e = (body as { error?: unknown } | undefined)?.error;
  return typeof e === "string" ? e : fallback;
}

export async function redeemPairCode(opts: {
  origin: string;
  code: string;
  deviceName: string;
  identity?: DeviceIdentity;
  fetchImpl?: FetchLike;
}): Promise<PairCredential> {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const identity = opts.identity ?? (await loadOrCreateDeviceIdentity());
  const nonce = await fetchNonce(fetchImpl, opts.origin);
  const signature = await signDevicePayload(
    identity.privateKey,
    await pairProofPayload("redeem", nonce, opts.code),
  );
  const res = await fetchImpl(`${opts.origin}/api/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      code: opts.code,
      deviceKeyPub: identity.publicKey,
      deviceName: opts.deviceName,
      nonce,
      signature,
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok !== true) {
    throw new Error(`pairing: ${errorOf(body, `redeem failed (HTTP ${res.status})`)}`);
  }
  return toCredential(body, identity.deviceId);
}

export async function refreshPairCredential(opts: {
  origin: string;
  credential: PairCredential;
  identity?: DeviceIdentity;
  fetchImpl?: FetchLike;
}): Promise<PairCredential> {
  const fetchImpl = opts.fetchImpl ?? ((u, i) => fetch(u, i));
  const identity = opts.identity ?? (await loadOrCreateDeviceIdentity());
  const nonce = await fetchNonce(fetchImpl, opts.origin);
  const signature = await signDevicePayload(
    identity.privateKey,
    await pairProofPayload("refresh", nonce, opts.credential.refreshToken),
  );
  const res = await fetchImpl(`${opts.origin}/api/pair/refresh`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ refreshToken: opts.credential.refreshToken, nonce, signature }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.ok !== true) {
    throw new Error(`pairing: ${errorOf(body, `refresh failed (HTTP ${res.status})`)}`);
  }
  return toCredential(body, identity.deviceId);
}

export function loadPairCredential(): PairCredential | null {
  try {
    const parsed = JSON.parse(
      secretStorage().getItem(STORAGE_KEY) ?? "null",
    ) as PairCredential | null;
    return parsed?.version === 1 && typeof parsed.accessToken === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function savePairCredential(credential: PairCredential | null): void {
  try {
    if (credential) {
      secretStorage().setItem(STORAGE_KEY, JSON.stringify(credential));
    } else {
      secretStorage().removeItem(STORAGE_KEY);
    }
  } catch {
    // Private mode: the credential lives for this page only.
  }
}

/** Milliseconds until the credential should be refreshed (0: now). */
export function refreshDelayMs(credential: PairCredential, nowMs: number): number {
  const expires = Date.parse(credential.accessExpiresAt);
  if (!Number.isFinite(expires)) {
    return 0;
  }
  return Math.max(0, expires - REFRESH_MARGIN_MS - nowMs);
}

function defaultDeviceName(): string {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  if (/iPhone|iPad/.test(ua)) {
    return "phone browser (iOS)";
  }
  if (/Android/.test(ua)) {
    return "phone browser (Android)";
  }
  return "phone browser";
}

export type PairLinkHost = {
  /** Called with a fresh access token; the host stores it and reconnects. */
  useToken: (token: string) => void;
  /** A one-line notice for the person (errors, the HTTPS requirement). */
  notify: (message: string) => void;
};

let refreshTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefresh(host: PairLinkHost, origin: string, credential: PairCredential): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(
    () => {
      void refreshPairCredential({ origin, credential })
        .then((next) => {
          savePairCredential(next);
          host.useToken(next.accessToken);
          scheduleRefresh(host, origin, next);
        })
        .catch((err: unknown) => {
          savePairCredential(null);
          host.notify(
            `${err instanceof Error ? err.message : String(err)}. Ask for a new link with kurahi connect web.`,
          );
        });
    },
    refreshDelayMs(credential, Date.now()),
  );
}

/**
 * Run on dashboard start. Redeems a `#pair=` link when present, otherwise resumes a stored
 * credential. Returns true when it took over authentication (the caller connects after
 * `useToken`), false when the dashboard should connect as usual.
 */
export async function handlePairLink(host: PairLinkHost): Promise<boolean> {
  const origin = window.location.origin;
  const found = readPairCode(window.location.hash);
  if (found) {
    // Take the code out of the address bar and history before anything else.
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${found.rest}`,
    );
    if (!isSecurePage()) {
      host.notify(
        "This page is plain HTTP, so the browser cannot keep a device key. Enable gateway.tls on the gateway and scan a new code from kurahi connect web.",
      );
      return false;
    }
    try {
      const credential = await redeemPairCode({
        origin,
        code: found.code,
        deviceName: defaultDeviceName(),
      });
      savePairCredential(credential);
      host.useToken(credential.accessToken);
      scheduleRefresh(host, origin, credential);
      return true;
    } catch (err) {
      host.notify(
        `${err instanceof Error ? err.message : String(err)}. Ask for a new link with kurahi connect web.`,
      );
      return false;
    }
  }
  const stored = loadPairCredential();
  if (stored && isSecurePage()) {
    host.useToken(stored.accessToken);
    scheduleRefresh(host, origin, stored);
    return true;
  }
  return false;
}
