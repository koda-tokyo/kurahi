// Private demo invite link: `kurahi demo invite create --url` prints `<dashboard>#invite=kdi_…`.
// The code lives in the URL fragment, so it never reaches a server log or a Referer. On load the
// dashboard takes it out of the address bar and connects with it as the gateway token; the
// gateway signs the visitor in to the invite's Project only (KURAHI_DEMO).

const INVITE_CODE = /^kdi_[A-Za-z0-9_-]{16,}$/;

/** Shown when the gateway refuses the visitor's invite (expired, revoked or unknown). */
export const INVITE_ENDED_NOTICE =
  "This demo invite link is no longer valid (it may have expired or been revoked). Ask the person who invited you for a new link.";

/** Shown while the gateway's invites file is briefly busy (close 1013); the dashboard keeps retrying. */
export const INVITE_BUSY_NOTICE = "The demo is busy for a moment. Reconnecting…";

/** Shown when the gateway rate-limits sign-ins from this network (close 1008 "rate limited"). */
export const SIGN_IN_RATE_LIMITED_NOTICE =
  "Too many sign-in attempts from this network. Retrying shortly…";

/** True when the gateway token is a demo invite code. */
export function isInviteToken(token: string | null | undefined): boolean {
  return typeof token === "string" && INVITE_CODE.test(token.trim());
}

/** The invite code in `#invite=<code>` (other fragment parameters are kept), or null. */
export function readInviteCode(hash: string): { code: string; rest: string } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) {
    return null;
  }
  const params = new URLSearchParams(raw);
  if (!params.has("invite")) {
    return null;
  }
  const code = params.get("invite")?.trim() ?? "";
  params.delete("invite");
  const rest = params.toString();
  // A malformed code is still removed from the address bar, but never used.
  return {
    code: INVITE_CODE.test(code) ? code : "",
    rest: rest ? `#${rest}` : "",
  };
}

/**
 * Takes `#invite=` out of the address bar (history entry replaced, not pushed) and returns the
 * code, or null when the link has none or it is malformed.
 */
export function takeInviteFragment(): string | null {
  const found = readInviteCode(window.location.hash);
  if (!found) {
    return null;
  }
  const url = new URL(window.location.href);
  url.hash = found.rest;
  window.history.replaceState(window.history.state, "", url.toString());
  return found.code || null;
}
