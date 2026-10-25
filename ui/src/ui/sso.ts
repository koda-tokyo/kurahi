// Organisation sign-in (enterprise identity). The gateway's SSO endpoints send the browser back
// to the console with a one-time code in the URL fragment (`#sso_code=…`), never the session
// token. On load the console takes it out of the address bar and exchanges it once (POST
// /api/identity/sso/exchange, with the sign-in's binding cookie) for the session token, which it
// keeps in sessionStorage only (it ends with the tab, never in localStorage), then connects.
// A refusal comes back as `#sso_error=<reason>`.

const STORAGE_KEY = "kolo-sso-session-v1";

export type SsoProvider = { id: string; kind: "oidc" | "saml"; label: string; loginPath: string };
export type SsoConfig = { enabled: boolean; required: boolean; providers: SsoProvider[] };

export type WhoAmI = {
  kind: "person" | "owner" | "pairing" | "device" | "agent";
  principal: string;
  person: {
    id: string;
    email: string | null;
    displayName: string | null;
    providerId: string;
  } | null;
  roles: Array<{ role: string; unit: string | null; via: string }>;
  units: string[];
  scope: string;
  approvals: boolean;
  breakGlass: boolean;
  session: { id: string; expiresAt: string } | null;
};

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The one-time code or error in the fragment (other fragment parameters are kept), or null. */
export function readSsoFragment(
  hash: string,
): { code: string | null; error: string | null; rest: string } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!raw) {
    return null;
  }
  const params = new URLSearchParams(raw);
  const code = params.get("sso_code")?.trim() ?? "";
  const error = params.get("sso_error")?.trim() ?? "";
  if (!code && !error) {
    return null;
  }
  params.delete("sso_code");
  params.delete("sso_error");
  const rest = params.toString();
  const valid = /^[A-Za-z0-9_-]{20,128}$/.test(code);
  return {
    code: valid ? code : null,
    error: error ? error.slice(0, 64) : code && !valid ? "malformed" : null,
    rest: rest ? `#${rest}` : "",
  };
}

/** Trade the one-time code for the session token (once; the binding cookie goes along). */
export async function exchangeSsoCode(
  origin: string,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ token: string } | { error: string }> {
  try {
    const res = await fetchImpl(`${origin}/api/identity/sso/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      credentials: "same-origin",
    });
    const body = (await res.json().catch(() => null)) as {
      token?: unknown;
      error?: { type?: unknown };
    } | null;
    const token = typeof body?.token === "string" ? body.token : "";
    if (res.ok && /^kss_[A-Za-z0-9_-]{20,}$/.test(token)) {
      return { token };
    }
    const type = body?.error?.type;
    return { error: typeof type === "string" ? type.slice(0, 64) : "exchange_failed" };
  } catch {
    return { error: "exchange_failed" };
  }
}

export function loadSsoToken(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveSsoToken(token: string): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // storage unavailable: the token lives only for this page load
  }
}

export function clearSsoToken(): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // nothing stored
  }
}

/** Plain-language text for a refusal reason from the gateway. */
export function describeSsoError(reason: string): string {
  switch (reason) {
    case "no_role":
      return "Sign-in worked, but no role is assigned to your account. Ask an administrator.";
    case "not_provisioned":
      return "Your account is not provisioned for this gateway. Ask an administrator.";
    case "inactive":
      return "Your account is deactivated.";
    case "state_unknown":
    case "request_unknown":
    case "code_unknown":
    case "code_expired":
      return "The sign-in expired or was already used. Start again.";
    default:
      return `Sign-in was refused (${reason}).`;
  }
}

export async function fetchSsoConfig(
  origin: string,
  fetchImpl: FetchLike = fetch,
): Promise<SsoConfig | null> {
  try {
    const res = await fetchImpl(`${origin}/api/identity/sso`, { credentials: "omit" });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as SsoConfig;
    return Array.isArray(body?.providers) ? body : null;
  } catch {
    return null;
  }
}

/** Where the sign-in button goes: the provider's login path, returning to this page. */
export function ssoLoginHref(origin: string, provider: SsoProvider, returnTo: string): string {
  const path = provider.loginPath.startsWith("/") ? provider.loginPath : `/${provider.loginPath}`;
  return `${origin}${path}?returnTo=${encodeURIComponent(returnTo)}`;
}

/** End the session at the gateway; returns the IdP logout URL when the provider has one. */
export async function ssoLogout(
  origin: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${origin}/api/identity/logout`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      credentials: "omit",
    });
    if (!res.ok) {
      return null;
    }
    const body = (await res.json()) as { endSessionUrl?: string | null };
    return typeof body.endSessionUrl === "string" && body.endSessionUrl.startsWith("https://")
      ? body.endSessionUrl
      : null;
  } catch {
    return null;
  }
}

/**
 * Run on dashboard start: takes `#sso_code=` / `#sso_error=` out of the address bar at once and
 * exchanges the code for the session token. Resolves to the notice to show (or null) and
 * whether a fresh token was stored.
 */
export async function takeSsoFragment(
  fetchImpl: FetchLike = fetch,
): Promise<{ stored: boolean; notice: string | null }> {
  const found = readSsoFragment(window.location.hash);
  if (!found) {
    return { stored: false, notice: null };
  }
  history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${found.rest}`,
  );
  if (found.code) {
    const exchanged = await exchangeSsoCode(window.location.origin, found.code, fetchImpl);
    if ("token" in exchanged) {
      saveSsoToken(exchanged.token);
      return { stored: true, notice: null };
    }
    return { stored: false, notice: describeSsoError(exchanged.error) };
  }
  return { stored: false, notice: describeSsoError(found.error ?? "malformed") };
}
