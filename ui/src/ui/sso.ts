// Organisation sign-in (enterprise identity). The gateway's SSO endpoints send the browser back
// to the console with a one-time code in the URL fragment (`#sso_code=…`), never the session
// token. On load the console takes it out of the address bar and exchanges it once (POST
// /api/identity/sso/exchange, with the sign-in's binding cookie) for the session token, which it
// keeps in sessionStorage only (it ends with the tab, never in localStorage), then connects.
// A refusal comes back as `#sso_error=<reason>`.

import { type MessageId, t } from "./i18n";

const STORAGE_KEY = "kolo-sso-session-v1";

export type SsoProvider = { id: string; kind: "oidc" | "saml"; label: string; loginPath: string };
export type SsoConfig = {
  enabled: boolean;
  required: boolean;
  providers: SsoProvider[];
  /** Built-in sign-in: passkeys, and one-time codes from an authenticator app as a fallback. */
  passkeys?: { enabled: boolean; totp: boolean };
};

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
  // A step-up popup back on the console: tell the window that opened it, then close.
  const stepUp = new URLSearchParams(window.location.hash.slice(1)).has("sso_stepup");
  const stepUpWindow = window.name === STEP_UP_WINDOW;
  if (stepUp || (stepUpWindow && readSsoFragment(window.location.hash)?.code === null)) {
    const outcome = readStepUpFragment(window.location.hash);
    if (window.opener && outcome) {
      try {
        (window.opener as Window).postMessage(
          { type: STEP_UP_MESSAGE, outcome },
          window.location.origin,
        );
      } catch {
        // the opener is gone: it notices the popup closing
      }
      window.close();
      return { stored: false, notice: null };
    }
  }
  if (stepUp) {
    // Same-window step-up: the session token is unchanged; the person repeats the decision.
    const params = new URLSearchParams(window.location.hash.slice(1));
    params.delete("sso_stepup");
    const rest = params.toString();
    history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}${rest ? `#${rest}` : ""}`,
    );
    return { stored: false, notice: "Identity confirmed. Repeat the decision to record it." };
  }
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

// ---- step-up ("Confirm it's you") ----
//
// A high-consequence gateway method (an approval, lifting the emergency stop, …) refuses with
// `error.details.code: "step_up_required"` when the person's last authentication is too old.
// The console re-authenticates at the IdP in a popup (POST /api/identity/sso/step-up returns the
// IdP URL; the gateway refreshes the session's authentication on return; the token does not
// change) and then repeats the request. The popup comes back to the console with
// `#sso_stepup=ok` or `#sso_error=<reason>`.

export type StepUpRequired = {
  why: string;
  maxAgeSeconds: number;
  requireMethods: string[];
  stepUpPath: string;
};

/** The step-up refusal in a gateway error, or null. */
export function stepUpRequired(error: unknown): StepUpRequired | null {
  const details =
    error && typeof error === "object" && "details" in error
      ? (error as { details?: unknown }).details
      : null;
  if (!details || typeof details !== "object") {
    return null;
  }
  const d = details as Record<string, unknown>;
  if (d.code !== "step_up_required") {
    return null;
  }
  return {
    why: typeof d.why === "string" ? d.why : "stale",
    maxAgeSeconds: typeof d.maxAgeSeconds === "number" ? d.maxAgeSeconds : 300,
    requireMethods: Array.isArray(d.requireMethods)
      ? d.requireMethods.filter((m): m is string => typeof m === "string")
      : [],
    // Always the gateway's own endpoint, whatever the error says.
    stepUpPath: "/api/identity/sso/step-up",
  };
}

/** `#sso_stepup=ok` / `#sso_error=` in a URL fragment: "ok", the error, or null. */
export function readStepUpFragment(hash: string): string | null {
  const params = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  if (params.get("sso_stepup") === "ok") {
    return "ok";
  }
  const error = params.get("sso_error");
  return error ? error.slice(0, 64) : null;
}

export type StepUpOutcome = { ok: true } | { ok: false; reason: string };

/** postMessage type the step-up popup sends its opener ({ type, outcome: "ok" | reason }). */
export const STEP_UP_MESSAGE = "kurahi-stepup";
const STEP_UP_WINDOW = "kurahi-stepup";

type PopupLike = { closed: boolean; location: { href: string; hash: string }; close(): void };

/**
 * Re-authenticate the signed-in person. Call it straight from the click (the popup opens
 * before any await, so the browser does not block it). Without a popup it falls back to the
 * same window and resolves `{ ok: false, reason: "redirected" }` (the page then reloads with
 * `#sso_stepup=ok`).
 */
export async function runStepUp(opts: {
  origin: string;
  token: string;
  returnTo: string;
  fetchImpl?: FetchLike;
  open?: () => PopupLike | null;
  navigate?: (url: string) => void;
  pollMs?: number;
  timeoutMs?: number;
}): Promise<StepUpOutcome> {
  const popup = opts.open
    ? opts.open()
    : (window.open("", STEP_UP_WINDOW, "popup,width=520,height=680") as PopupLike | null);
  const fetchImpl = opts.fetchImpl ?? fetch;
  let url = "";
  try {
    const res = await fetchImpl(`${opts.origin}/api/identity/sso/step-up`, {
      method: "POST",
      headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ returnTo: opts.returnTo }),
      credentials: "same-origin",
    });
    const body = (await res.json().catch(() => null)) as {
      url?: unknown;
      error?: { type?: unknown };
    } | null;
    url = res.ok && typeof body?.url === "string" && /^https?:\/\//.test(body.url) ? body.url : "";
    if (!url) {
      popup?.close();
      const type = body?.error?.type;
      return { ok: false, reason: typeof type === "string" ? type.slice(0, 64) : "step_up_failed" };
    }
  } catch {
    popup?.close();
    return { ok: false, reason: "step_up_failed" };
  }
  if (!popup) {
    (opts.navigate ?? ((u: string) => window.location.assign(u)))(url);
    return { ok: false, reason: "redirected" };
  }
  popup.location.href = url;
  // The popup's console posts the outcome (same origin only); polling covers the rest.
  let posted: string | null = null;
  const onMessage = (event: MessageEvent) => {
    const data = event.data as { type?: unknown; outcome?: unknown } | null;
    if (
      event.origin === opts.origin &&
      data?.type === STEP_UP_MESSAGE &&
      typeof data.outcome === "string"
    ) {
      posted = data.outcome.slice(0, 64);
    }
  };
  const listening = typeof window !== "undefined" && typeof window.addEventListener === "function";
  if (listening) {
    window.addEventListener("message", onMessage);
  }
  try {
    return await waitForStepUp(popup, () => posted, opts.pollMs ?? 500, opts.timeoutMs);
  } finally {
    if (listening) {
      window.removeEventListener("message", onMessage);
    }
  }
}

async function waitForStepUp(
  popup: PopupLike,
  posted: () => string | null,
  pollMs: number,
  timeoutMs = 5 * 60_000,
): Promise<StepUpOutcome> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const message = posted();
    if (message) {
      popup.close();
      return message === "ok" ? { ok: true } : { ok: false, reason: message };
    }
    if (popup.closed) {
      // Closed by the person (or by the console it returned to): the gateway decides on retry.
      return { ok: false, reason: "closed" };
    }
    let found: string | null = null;
    try {
      // Readable only once the popup is back on this origin.
      found = readStepUpFragment(popup.location.hash);
    } catch {
      found = null;
    }
    if (found) {
      popup.close();
      return found === "ok" ? { ok: true } : { ok: false, reason: found };
    }
  }
  popup.close();
  return { ok: false, reason: "timeout" };
}

// ── Built-in sign-in: passkeys (WebAuthn) and one-time codes ────────────────────────────────
//
// The gateway sends WebAuthn options as JSON with base64url binary fields and takes the
// credential back the same way (PublicKeyCredential.toJSON()). A sign-in answers with the
// session token in the response body of the page's own request (no redirect, no code in the
// URL); it is stored like an SSO token. An identity admin's enrollment link carries a one-time
// code in the fragment (`#kurahi_enroll=…`), taken out of the address bar at once.

type Json = Record<string, unknown>;

const PASSKEY_ERRORS: Record<string, MessageId> = {
  cancelled: "identity.error.cancelled",
  unsupported: "identity.error.unsupported",
  unknown_credential: "identity.error.unknown_credential",
  code_refused: "identity.error.code_refused",
  locked: "identity.error.locked",
  rate_limited: "identity.error.locked",
  enrollment_invalid: "identity.error.enrollment_invalid",
  not_signed_in: "identity.error.enrollment_invalid",
  user_not_verified: "identity.error.user_not_verified",
  ceremony_unknown: "identity.error.ceremony_unknown",
  inactive: "identity.error.inactive",
  person_inactive: "identity.error.inactive",
  no_role: "identity.error.no_role",
  step_up_required: "identity.error.step_up_required",
  has_authenticators: "identity.error.has_authenticators",
};

/** Plain-language, localised text for a passkey or one-time code refusal. */
export function describePasskeyError(reason: string): string {
  const id = PASSKEY_ERRORS[reason];
  return id ? t(id) : t("identity.error.other", { reason: reason.slice(0, 64) });
}
type CredentialsLike = Pick<CredentialsContainer, "create" | "get">;

const ENROLL_RE = /^kpe_[A-Za-z0-9_-]{20,60}$/;

function fromB64u(value: string): ArrayBuffer {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out.buffer;
}

function toB64u(buf: ArrayBuffer | ArrayBufferView | null | undefined): string {
  if (!buf) {
    return "";
  }
  const bytes =
    buf instanceof ArrayBuffer
      ? new Uint8Array(buf)
      : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type DescriptorJson = { type: "public-key"; id: string; transports?: string[] };

/** Creation options JSON (base64url) → the shape navigator.credentials.create() takes. */
export function creationOptionsFromJson(o: Json): PublicKeyCredentialCreationOptions {
  const user = o.user as { id: string; name: string; displayName: string };
  return {
    ...(o as unknown as PublicKeyCredentialCreationOptions),
    challenge: fromB64u(o.challenge as string),
    user: { ...user, id: fromB64u(user.id) },
    excludeCredentials: ((o.excludeCredentials as DescriptorJson[] | undefined) ?? []).map((c) => ({
      ...c,
      id: fromB64u(c.id),
    })) as PublicKeyCredentialDescriptor[],
  };
}

/** Request options JSON (base64url) → the shape navigator.credentials.get() takes. */
export function requestOptionsFromJson(o: Json): PublicKeyCredentialRequestOptions {
  return {
    ...(o as unknown as PublicKeyCredentialRequestOptions),
    challenge: fromB64u(o.challenge as string),
    allowCredentials: ((o.allowCredentials as DescriptorJson[] | undefined) ?? []).map((c) => ({
      ...c,
      id: fromB64u(c.id),
    })) as PublicKeyCredentialDescriptor[],
  };
}

/** A created or asserted credential as JSON (toJSON() where the browser has it). */
export function credentialToJson(cred: PublicKeyCredential): Json {
  const withJson = cred as PublicKeyCredential & { toJSON?: () => Json };
  if (typeof withJson.toJSON === "function") {
    return withJson.toJSON();
  }
  const r = cred.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  const id = toB64u(cred.rawId);
  const response: Json = { clientDataJSON: toB64u(r.clientDataJSON) };
  if ("attestationObject" in r && r.attestationObject) {
    response.attestationObject = toB64u(r.attestationObject);
    response.transports = typeof r.getTransports === "function" ? r.getTransports() : [];
  } else {
    response.authenticatorData = toB64u(r.authenticatorData);
    response.signature = toB64u(r.signature);
    if (r.userHandle) {
      response.userHandle = toB64u(r.userHandle);
    }
  }
  return { id, rawId: id, type: cred.type, response };
}

/** Browsers that can run a passkey ceremony at all. */
export function passkeysSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof navigator?.credentials?.get === "function"
  );
}

async function postJson(
  origin: string,
  path: string,
  body: Json,
  fetchImpl: FetchLike,
  token?: string | null,
): Promise<{ ok: true; body: Json } | { ok: false; error: string }> {
  try {
    const res = await fetchImpl(`${origin}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
      credentials: "omit",
    });
    const parsed = (await res.json().catch(() => null)) as Json | null;
    if (res.ok && parsed) {
      return { ok: true, body: parsed };
    }
    const type = (parsed?.error as { type?: unknown } | undefined)?.type;
    return { ok: false, error: typeof type === "string" ? type.slice(0, 64) : "request_failed" };
  } catch {
    return { ok: false, error: "request_failed" };
  }
}

/** The browser said no (cancelled, timed out, no matching passkey). */
function ceremonyError(err: unknown): string {
  const name = (err as { name?: unknown })?.name;
  return name === "NotAllowedError" || name === "AbortError" ? "cancelled" : "unsupported";
}

function sessionToken(body: Json): { token: string } | { error: string } {
  const token = typeof body.token === "string" ? body.token : "";
  return /^kss_[A-Za-z0-9_-]{20,}$/.test(token) ? { token } : { error: "request_failed" };
}

/** Usernameless passkey sign-in; resolves to the session token. */
export async function passkeySignIn(
  origin: string,
  deps: { fetch?: FetchLike; credentials?: CredentialsLike } = {},
): Promise<{ token: string } | { error: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  const begin = await postJson(origin, "/api/identity/passkey/login/begin", {}, fetchImpl);
  if (!begin.ok) {
    return { error: begin.error };
  }
  let cred: PublicKeyCredential;
  try {
    cred = (await (deps.credentials ?? navigator.credentials).get({
      publicKey: requestOptionsFromJson(begin.body.publicKey as Json),
    })) as PublicKeyCredential;
  } catch (err) {
    return { error: ceremonyError(err) };
  }
  const finish = await postJson(
    origin,
    "/api/identity/passkey/login/finish",
    { ceremonyId: begin.body.ceremonyId, credential: credentialToJson(cred) },
    fetchImpl,
  );
  return finish.ok ? sessionToken(finish.body) : { error: finish.error };
}

/** Step the signed-in session up with one of the person's passkeys (the token does not change). */
export async function passkeyStepUp(
  origin: string,
  token: string,
  deps: { fetch?: FetchLike; credentials?: CredentialsLike } = {},
): Promise<{ ok: true } | { error: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  const begin = await postJson(origin, "/api/identity/passkey/stepup/begin", {}, fetchImpl, token);
  if (!begin.ok) {
    return { error: begin.error };
  }
  let cred: PublicKeyCredential;
  try {
    cred = (await (deps.credentials ?? navigator.credentials).get({
      publicKey: requestOptionsFromJson(begin.body.publicKey as Json),
    })) as PublicKeyCredential;
  } catch (err) {
    return { error: ceremonyError(err) };
  }
  const finish = await postJson(
    origin,
    "/api/identity/passkey/stepup/finish",
    { ceremonyId: begin.body.ceremonyId, credential: credentialToJson(cred) },
    fetchImpl,
    token,
  );
  return finish.ok ? { ok: true } : { error: finish.error };
}

/** Sign in with a user name and a one-time code from the authenticator app. */
export async function totpSignIn(
  origin: string,
  userName: string,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ token: string } | { error: string }> {
  const out = await postJson(
    origin,
    "/api/identity/passkey/totp/verify",
    { userName: userName.trim(), code: code.replace(/\s/g, "") },
    fetchImpl,
  );
  return out.ok ? sessionToken(out.body) : { error: out.error };
}

/** Who enrols: an enrollment code from an admin's link, or the signed-in session. */
export type EnrollAs = { enrollmentCode: string } | { token: string };

const enrollBody = (as: EnrollAs): Json =>
  "enrollmentCode" in as ? { enrollmentCode: as.enrollmentCode } : {};
const enrollToken = (as: EnrollAs) => ("token" in as ? as.token : null);

/** Register a passkey on this device. */
export async function passkeyEnroll(
  origin: string,
  as: EnrollAs,
  label: string,
  deps: { fetch?: FetchLike; credentials?: CredentialsLike } = {},
): Promise<{ ok: true } | { error: string }> {
  const fetchImpl = deps.fetch ?? fetch;
  const begin = await postJson(
    origin,
    "/api/identity/passkey/register/begin",
    enrollBody(as),
    fetchImpl,
    enrollToken(as),
  );
  if (!begin.ok) {
    return { error: begin.error };
  }
  let cred: PublicKeyCredential;
  try {
    cred = (await (deps.credentials ?? navigator.credentials).create({
      publicKey: creationOptionsFromJson(begin.body.publicKey as Json),
    })) as PublicKeyCredential;
  } catch (err) {
    return { error: ceremonyError(err) };
  }
  const finish = await postJson(
    origin,
    "/api/identity/passkey/register/finish",
    { ceremonyId: begin.body.ceremonyId, credential: credentialToJson(cred), label },
    fetchImpl,
  );
  return finish.ok ? { ok: true } : { error: finish.error };
}

export type TotpSetup = { ceremonyId: string; secret: string; otpauthUri: string };

/** Start setting up an authenticator app: the secret to scan or type in. */
export async function totpEnrollBegin(
  origin: string,
  as: EnrollAs,
  fetchImpl: FetchLike = fetch,
): Promise<TotpSetup | { error: string }> {
  const out = await postJson(
    origin,
    "/api/identity/passkey/totp/enroll/begin",
    enrollBody(as),
    fetchImpl,
    enrollToken(as),
  );
  if (!out.ok) {
    return { error: out.error };
  }
  const b = out.body as Partial<TotpSetup>;
  return typeof b.ceremonyId === "string" &&
    typeof b.secret === "string" &&
    typeof b.otpauthUri === "string"
    ? { ceremonyId: b.ceremonyId, secret: b.secret, otpauthUri: b.otpauthUri }
    : { error: "request_failed" };
}

/** Confirm the authenticator app with its first code. */
export async function totpEnrollFinish(
  origin: string,
  ceremonyId: string,
  code: string,
  fetchImpl: FetchLike = fetch,
): Promise<{ ok: true } | { error: string }> {
  const out = await postJson(
    origin,
    "/api/identity/passkey/totp/enroll/finish",
    { ceremonyId, code: code.replace(/\s/g, "") },
    fetchImpl,
  );
  return out.ok ? { ok: true } : { error: out.error };
}

/** The enrollment code in `#kurahi_enroll=…` (other fragment parameters kept), or null. */
export function readEnrollFragment(hash: string): { code: string | null; rest: string } | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  const params = new URLSearchParams(raw);
  const code = params.get("kurahi_enroll")?.trim();
  if (code === undefined) {
    return null;
  }
  params.delete("kurahi_enroll");
  const rest = params.toString();
  return { code: ENROLL_RE.test(code) ? code : null, rest: rest ? `#${rest}` : "" };
}

/**
 * Take the enrollment code out of the address bar (it is a one-time credential). Undefined when
 * no enrollment link was opened, null when the link was malformed.
 */
export function takeEnrollFragment(): string | null | undefined {
  const found = readEnrollFragment(window.location.hash);
  if (!found) {
    return undefined;
  }
  history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${found.rest}`,
  );
  return found.code;
}
