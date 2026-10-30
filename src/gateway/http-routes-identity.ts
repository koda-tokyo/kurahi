// Enterprise identity HTTP routes (declarations): SSO sign-in, session, logout, SCIM 2.0.
// Bound in server-http.ts; see docs/security/identity.md.
import { Type, type TSchema } from "@sinclair/typebox";
import { defineRoute, type RouteDefinition } from "./http-registry.js";

const Loose = (properties: Record<string, TSchema>, description?: string) =>
  Type.Object(properties, { additionalProperties: true, ...(description ? { description } : {}) });

const tags = ["identity"];
const scimTags = ["scim"];
const ProviderParam = Type.Object({
  provider: Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$", description: "Provider id" }),
});
const IdParam = Type.Object({ id: Type.String({ description: "Resource id" }) });
const Redirect = (description: string) => ({
  description,
  headers: { Location: { description: "Where the browser goes next.", schema: Type.String() } },
});
const ScimJson = "application/scim+json";
const OAuthErr = Loose({
  error: Type.String(),
  error_description: Type.Optional(Type.String()),
  interval: Type.Optional(Type.Integer()),
});
const ApiErr = Loose({ error: Loose({ message: Type.String(), type: Type.String() }) });
const DeviceRequestView = Type.Object({
  userCode: Type.String(),
  clientId: Type.String(),
  clientName: Type.String(),
  deviceName: Type.Union([Type.String(), Type.Null()]),
  ip: Type.Union([Type.String(), Type.Null()]),
  requestedAt: Type.String(),
  expiresAt: Type.String(),
});
const ScimResource = Loose({ schemas: Type.Array(Type.String()), id: Type.String() });
const ScimList = Loose({
  schemas: Type.Array(Type.String()),
  totalResults: Type.Integer(),
  startIndex: Type.Integer(),
  itemsPerPage: Type.Integer(),
  Resources: Type.Array(Loose({})),
});
const ScimError = Loose({
  schemas: Type.Array(Type.String()),
  status: Type.String(),
  detail: Type.String(),
});
const scimErrors = {
  400: { description: "Invalid request or filter.", schema: ScimError, contentType: ScimJson },
  401: "Unauthorized" as const,
  404: { description: "Not found, or SCIM is off.", schema: ScimError, contentType: ScimJson },
  409: {
    description: "userName or displayName already in use.",
    schema: ScimError,
    contentType: ScimJson,
  },
};
const ListQuery = Type.Object({
  filter: Type.Optional(Type.String({ description: 'e.g. userName eq "alice@example.com"' })),
  startIndex: Type.Optional(Type.Integer({ minimum: 1 })),
  count: Type.Optional(Type.Integer({ minimum: 0, maximum: 200 })),
  excludedAttributes: Type.Optional(Type.String({ description: "Groups: `members`" })),
});
const RoleGrant = Loose({
  role: Type.String(),
  unit: Type.Union([Type.String(), Type.Null()]),
  via: Type.String(),
});

function scimRoute(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  operationId: string,
  summary: string,
  extra: Partial<RouteDefinition> = {},
): RouteDefinition {
  return defineRoute({
    method,
    path,
    operationId,
    summary,
    tags: scimTags,
    auth: "scim-token",
    responses: {
      ...(method === "DELETE"
        ? { 204: { description: "Deleted." } }
        : method === "POST"
          ? { 201: { description: "Created.", schema: ScimResource, contentType: ScimJson } }
          : {
              200: {
                description: "Resource or list.",
                schema: path.includes("{id}") ? ScimResource : ScimList,
                contentType: ScimJson,
              },
            }),
      ...scimErrors,
    },
    ...extra,
  });
}

// Built-in sign-in (provider `passkey`): JSON POSTs from the console page only.
const PasskeyError = Loose({
  error: Loose({ message: Type.String(), type: Type.String({ description: "Refusal reason." }) }),
});
const passkeyErrors = {
  400: { description: "Refused (reason in error.type).", schema: PasskeyError },
  401: { description: "No valid enrollment code or session.", schema: PasskeyError },
  403: { description: "Origin is not a passkey origin.", schema: PasskeyError },
  404: { description: "Passkeys (or one-time codes) are off.", schema: PasskeyError },
  415: { description: "Not application/json.", schema: PasskeyError },
  429: "TooManyRequests" as const,
};
const Ceremony = (description: string) =>
  Loose({ ceremonyId: Type.String(), publicKey: Loose({ challenge: Type.String() }) }, description);
const Credential = Loose(
  { id: Type.String(), rawId: Type.String(), type: Type.String(), response: Loose({}) },
  "PublicKeyCredential.toJSON() (binary fields base64url).",
);
const SignedIn = Type.Object({
  token: Type.String({ description: "The SSO session token (`kss_…`)." }),
  principal: Type.String(),
  session: Type.Object({ id: Type.String(), expiresAt: Type.String() }),
  methods: Type.Array(Type.String(), { description: "RFC 8176 amr values." }),
});
const StepUpResult = Type.Object({
  ok: Type.Literal(true),
  auth: Type.Object({
    at: Type.String(),
    methods: Type.Array(Type.String()),
    context: Type.Union([Type.String(), Type.Null()]),
  }),
});
const EnrollBody = Type.Object({
  enrollmentCode: Type.Optional(
    Type.String({
      maxLength: 64,
      description: "One-time code from an identity admin; omit when signed in (Bearer).",
    }),
  ),
});

function passkeyRoute(
  path: string,
  operationId: string,
  summary: string,
  body: TSchema,
  ok: { description: string; schema: TSchema },
  opts: { session?: boolean; description?: string } = {},
): RouteDefinition {
  return defineRoute({
    method: "POST",
    path,
    operationId,
    summary,
    ...(opts.description ? { description: opts.description } : {}),
    tags,
    auth: opts.session ? "sso-session" : "none",
    ...(opts.session ? { minScope: "observe" as const } : {}),
    request: { body, bodyRequired: true },
    responses: { 200: ok, ...passkeyErrors },
  });
}

const PASSKEY_ROUTES: readonly RouteDefinition[] = [
  passkeyRoute(
    "/api/identity/passkey/register/begin",
    "beginPasskeyRegistration",
    "Start registering a passkey (enrollment code, or signed in)",
    EnrollBody,
    { description: "Creation options for navigator.credentials.create().", schema: Ceremony("") },
    {
      description:
        "Who may register: the holder of a one-time enrollment code an identity admin issued, " +
        "or a signed-in person (Bearer `kss_…`) adding another passkey. No self-registration.",
    },
  ),
  passkeyRoute(
    "/api/identity/passkey/register/finish",
    "finishPasskeyRegistration",
    "Finish registering a passkey",
    Type.Object({
      ceremonyId: Type.String({ maxLength: 64 }),
      credential: Credential,
      label: Type.Optional(Type.String({ maxLength: 64 })),
    }),
    {
      description: "Registered.",
      schema: Type.Object({ ok: Type.Literal(true), passkey: Loose({ id: Type.String() }) }),
    },
  ),
  passkeyRoute(
    "/api/identity/passkey/login/begin",
    "beginPasskeyLogin",
    "Start a passkey sign-in (usernameless)",
    Type.Object({}),
    { description: "Request options for navigator.credentials.get().", schema: Ceremony("") },
  ),
  passkeyRoute(
    "/api/identity/passkey/login/finish",
    "finishPasskeyLogin",
    "Finish a passkey sign-in; returns the session token",
    Type.Object({ ceremonyId: Type.String({ maxLength: 64 }), credential: Credential }),
    { description: "Signed in (protocol passkey).", schema: SignedIn },
  ),
  passkeyRoute(
    "/api/identity/passkey/stepup/begin",
    "beginPasskeyStepUp",
    "Start a passkey step-up of the current session",
    Type.Object({}),
    { description: "Request options limited to the person's passkeys.", schema: Ceremony("") },
    { session: true },
  ),
  passkeyRoute(
    "/api/identity/passkey/stepup/finish",
    "finishPasskeyStepUp",
    "Finish a passkey step-up (records a fresh authentication on the session)",
    Type.Object({ ceremonyId: Type.String({ maxLength: 64 }), credential: Credential }),
    { description: "Stepped up.", schema: StepUpResult },
    { session: true },
  ),
  passkeyRoute(
    "/api/identity/passkey/totp/enroll/begin",
    "beginTotpEnrollment",
    "Start setting up an authenticator app (enrollment code, or signed in)",
    EnrollBody,
    {
      description: "The new secret (base32) and otpauth:// URI.",
      schema: Type.Object({
        ceremonyId: Type.String(),
        secret: Type.String(),
        otpauthUri: Type.String(),
      }),
    },
  ),
  passkeyRoute(
    "/api/identity/passkey/totp/enroll/finish",
    "finishTotpEnrollment",
    "Confirm the authenticator app with a first code",
    Type.Object({
      ceremonyId: Type.String({ maxLength: 64 }),
      code: Type.String({ maxLength: 16 }),
      label: Type.Optional(Type.String({ maxLength: 64 })),
    }),
    {
      description: "Enrolled.",
      schema: Type.Object({ ok: Type.Literal(true), label: Type.String() }),
    },
  ),
  passkeyRoute(
    "/api/identity/passkey/totp/verify",
    "verifyTotp",
    "Sign in with a user name and a one-time code; returns the session token",
    Type.Object({
      userName: Type.String({ maxLength: 256 }),
      code: Type.String({ maxLength: 16 }),
    }),
    { description: "Signed in (amr otp).", schema: SignedIn },
  ),
  passkeyRoute(
    "/api/identity/passkey/totp/stepup",
    "stepUpTotp",
    "Step up the current session with a one-time code",
    Type.Object({ code: Type.String({ maxLength: 16 }) }),
    { description: "Stepped up (amr otp).", schema: StepUpResult },
    { session: true },
  ),
  defineRoute({
    method: "GET",
    path: "/api/identity/passkey/credentials",
    operationId: "listOwnAuthenticators",
    summary: "The signed-in person's passkeys and authenticator app",
    tags,
    auth: "sso-session",
    minScope: "observe",
    responses: {
      200: {
        description: "No public keys or secrets.",
        schema: Type.Object({
          passkeys: Type.Array(Loose({ id: Type.String(), label: Type.String() })),
          totp: Type.Union([Loose({ label: Type.String() }), Type.Null()]),
        }),
      },
      401: "Unauthorized",
    },
  }),
];

export const IDENTITY_ROUTES: readonly RouteDefinition[] = [
  defineRoute({
    method: "GET",
    path: "/api/identity/sso",
    operationId: "getSsoConfig",
    summary: "SSO providers the console offers, and whether SSO is required",
    tags,
    auth: "none",
    responses: {
      200: {
        description: "Sign-in options (no secrets).",
        schema: Type.Object({
          enabled: Type.Boolean(),
          required: Type.Boolean(),
          providers: Type.Array(
            Type.Object({
              id: Type.String(),
              kind: Type.Union([Type.Literal("oidc"), Type.Literal("saml")]),
              label: Type.String(),
              loginPath: Type.String(),
            }),
          ),
          passkeys: Type.Object({
            enabled: Type.Boolean({ description: "Built-in passkey sign-in is on." }),
            totp: Type.Boolean({ description: "One-time codes (TOTP) are offered as a fallback." }),
          }),
        }),
      },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/sso/{provider}/login",
    operationId: "startSsoLogin",
    summary: "Start a sign-in (redirect to the identity provider)",
    description:
      "OIDC: authorization code + PKCE (S256) with state and nonce. SAML: HTTP-Redirect " +
      "AuthnRequest. `returnTo` must be a console path (under the control UI base path), else " +
      "the console root. A one-time code comes back to it in the fragment (`#sso_code=…`), " +
      "for exchangeSsoCode; a refusal as `#sso_error=<reason>`.",
    tags,
    auth: "none",
    request: {
      params: ProviderParam,
      query: Type.Object({ returnTo: Type.Optional(Type.String({ maxLength: 512 })) }),
    },
    responses: { 302: Redirect("To the identity provider."), 404: "NotFound" },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/sso/{provider}/callback",
    operationId: "ssoCallback",
    summary: "OIDC redirect URI (authorization code callback)",
    tags,
    auth: "none",
    request: {
      params: ProviderParam,
      query: Type.Object({
        code: Type.Optional(Type.String()),
        state: Type.Optional(Type.String()),
        error: Type.Optional(Type.String()),
      }),
    },
    responses: {
      302: Redirect("Back to the console with `#sso_code=` or `#sso_error=`."),
      404: "NotFound",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/sso/{provider}/acs",
    operationId: "samlAcs",
    summary: "SAML assertion consumer service (HTTP-POST binding)",
    description:
      "Accepts a SAMLResponse answering a request this gateway sent. The assertion must be " +
      "signed by a configured IdP certificate; audience, recipient, time window and replay are " +
      "checked. IdP-initiated sign-in is not accepted.",
    tags,
    auth: "none",
    request: {
      params: ProviderParam,
      body: Type.Object({ SAMLResponse: Type.String(), RelayState: Type.Optional(Type.String()) }),
      bodyContentType: "application/x-www-form-urlencoded",
      bodyRequired: true,
    },
    responses: {
      303: Redirect("Back to the console with `#sso_code=` or `#sso_error=`."),
      404: "NotFound",
      413: "PayloadTooLarge",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/sso/{provider}/metadata",
    operationId: "getSamlMetadata",
    summary: "SAML service provider metadata (entity id, ACS URL)",
    tags,
    auth: "none",
    request: { params: ProviderParam },
    responses: {
      200: {
        description: "SP metadata XML.",
        schema: Type.String(),
        contentType: "application/samlmetadata+xml",
      },
      404: "NotFound",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/sso/exchange",
    operationId: "exchangeSsoCode",
    summary: "Exchange the sign-in's one-time code for the session token",
    description:
      "The console posts the code from `#sso_code=`. A code works once, for 60 seconds, and " +
      "only with the binding cookie of the browser that started the sign-in; a refused or " +
      "expired code ends its session.",
    tags,
    auth: "none",
    request: {
      body: Type.Object({ code: Type.String({ maxLength: 128 }) }),
      bodyRequired: true,
    },
    responses: {
      200: {
        description: "The SSO session token (`kss_…`).",
        schema: Type.Object({ token: Type.String() }),
      },
      400: {
        description: "Unknown, used or expired code, or another browser.",
        schema: Loose({ error: Loose({ message: Type.String(), type: Type.String() }) }),
      },
      429: "TooManyRequests",
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/session",
    operationId: "getIdentitySession",
    summary: "The signed-in person, roles and session expiry",
    tags,
    auth: "sso-session",
    minScope: "observe",
    responses: {
      200: {
        description: "Person session.",
        schema: Type.Object({
          ok: Type.Literal(true),
          principal: Type.String(),
          person: Loose({ id: Type.String() }),
          roles: Type.Array(RoleGrant),
          units: Type.Array(Type.String()),
          scope: Type.String(),
          approvals: Type.Boolean(),
          session: Type.Object({ id: Type.String(), expiresAt: Type.String() }),
          auth: Type.Union(
            [
              Type.Object({
                at: Type.String(),
                methods: Type.Array(Type.String()),
                context: Type.Union([Type.String(), Type.Null()]),
              }),
              Type.Null(),
            ],
            { description: "The last authentication (sign-in or step-up); null for old sessions." },
          ),
        }),
      },
      401: "Unauthorized",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/sso/step-up",
    operationId: "startIdentityStepUp",
    summary: "Start a step-up re-authentication for the current session",
    description:
      "Returns the IdP URL that re-authenticates the signed-in person (OIDC max_age=0 and prompt=login, SAML ForceAuthn). On return the session's authentication time is refreshed; no new session is opened and the person cannot change. The browser lands on `returnTo` with `#sso_stepup=ok` or `#sso_error=<reason>`.",
    tags,
    auth: "sso-session",
    minScope: "observe",
    request: {
      body: Type.Object({
        returnTo: Type.Optional(Type.String({ maxLength: 512 })),
        provider: Type.Optional(
          Type.String({ pattern: "^[a-z0-9][a-z0-9-]{0,31}$", description: "Provider id" }),
        ),
      }),
    },
    responses: {
      200: {
        description: "Open `url` (popup or same window) to re-authenticate.",
        schema: Type.Object({
          ok: Type.Literal(true),
          url: Type.String(),
          provider: Type.String(),
        }),
      },
      400: {
        description: "No provider linked to this person for a step-up.",
        schema: Loose({ error: Loose({ message: Type.String(), type: Type.String() }) }),
      },
      401: "Unauthorized",
      429: "TooManyRequests",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/logout",
    operationId: "logoutIdentity",
    summary: "End the SSO session (and get the IdP logout URL for OIDC)",
    tags,
    auth: "sso-session",
    minScope: "observe",
    responses: {
      200: {
        description: "Session ended; open connections of the session close.",
        schema: Type.Object({
          ok: Type.Literal(true),
          endSessionUrl: Type.Union([Type.String(), Type.Null()], {
            description:
              "RP-initiated logout at the IdP (OIDC end_session_endpoint), when published.",
          }),
        }),
      },
      401: "Unauthorized",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/oauth/device",
    operationId: "startDeviceAuthorization",
    summary: "Command-line sign-in: device authorization request (RFC 8628)",
    description:
      "Public client `kurahi-cli` (or a registered native client). Returns a device code for " +
      "the token endpoint and a user code the person confirms at `verification_uri` after " +
      "signing in. Codes live 10 minutes; poll no faster than `interval` seconds.",
    tags,
    auth: "none",
    request: {
      body: Type.Object({
        client_id: Type.String({ maxLength: 64 }),
        device_name: Type.Optional(
          Type.String({ maxLength: 200, description: "Shown to the approver (not verified)" }),
        ),
      }),
      bodyContentType: "application/x-www-form-urlencoded",
      bodyRequired: true,
    },
    responses: {
      200: {
        description: "Device and user codes.",
        schema: Type.Object({
          device_code: Type.String(),
          user_code: Type.String({ description: "XXXX-XXXX" }),
          verification_uri: Type.String(),
          verification_uri_complete: Type.String(),
          expires_in: Type.Integer(),
          interval: Type.Integer(),
        }),
      },
      400: { description: "OAuth error (invalid_client, unauthorized_client).", schema: OAuthErr },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/device",
    operationId: "getDeviceVerificationPage",
    summary: "Command-line sign-in: the verification page",
    description:
      "The person signs in (any provider), enters or confirms the user code, sees the client, " +
      "what the device says it is and the address it asked from, and approves or denies.",
    tags,
    auth: "none",
    request: {
      query: Type.Object({ user_code: Type.Optional(Type.String({ maxLength: 16 })) }),
    },
    responses: {
      200: { description: "HTML page.", schema: Type.String(), contentType: "text/html" },
      404: {
        description: "Command-line sign-in is off.",
        schema: Type.String(),
        contentType: "text/html",
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/device/lookup",
    operationId: "lookupDeviceCode",
    summary: "Command-line sign-in: what a user code asks for",
    description:
      "Wrong codes count per person and per source (5 per 10 minutes, then 429), and every " +
      "wrong code counts against all pending codes (a code locks after 20).",
    tags,
    auth: "sso-session",
    minScope: "observe",
    request: {
      body: Type.Object({ user_code: Type.String({ maxLength: 32 }) }),
      bodyRequired: true,
    },
    responses: {
      200: {
        description: "The pending request.",
        schema: Type.Object({ request: DeviceRequestView }),
      },
      401: "Unauthorized",
      404: { description: "Unknown, used or expired code.", schema: ApiErr },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/device/decision",
    operationId: "decideDeviceCode",
    summary: "Command-line sign-in: approve or deny (audited)",
    tags,
    auth: "sso-session",
    minScope: "observe",
    request: {
      body: Type.Object({ user_code: Type.String({ maxLength: 32 }), approve: Type.Boolean() }),
      bodyRequired: true,
    },
    responses: {
      200: {
        description: "Decision recorded.",
        schema: Type.Object({ ok: Type.Literal(true), approved: Type.Boolean() }),
      },
      400: { description: "approve missing.", schema: ApiErr },
      401: "Unauthorized",
      404: { description: "Unknown, used or expired code.", schema: ApiErr },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/oauth/authorize",
    operationId: "authorizeNativeApp",
    summary: "Native app sign-in: authorization request (RFC 8252, PKCE S256)",
    description:
      "For a registered native client (`gateway.identity.nativeClients`). Loopback clients may " +
      "use `http://127.0.0.1:<any port>/…` or `http://[::1]:<any port>/…`; scheme clients " +
      "`<scheme>:/…`. `state` and PKCE S256 are required. An unknown client or redirect URI " +
      "gets an error page, never a redirect; other errors go back to the redirect URI.",
    tags,
    auth: "none",
    request: {
      query: Type.Object({
        client_id: Type.String(),
        redirect_uri: Type.String({ maxLength: 512 }),
        response_type: Type.Literal("code"),
        code_challenge: Type.String({ minLength: 43, maxLength: 43 }),
        code_challenge_method: Type.Literal("S256"),
        state: Type.String({ maxLength: 512 }),
      }),
    },
    responses: {
      302: Redirect("Back to the app with an OAuth error."),
      303: Redirect("To the sign-in and confirmation page."),
      400: { description: "Error page.", schema: Type.String(), contentType: "text/html" },
    },
  }),
  defineRoute({
    method: "GET",
    path: "/api/identity/oauth/continue",
    operationId: "getNativeSignInPage",
    summary: "Native app sign-in: sign-in and confirmation page",
    tags,
    auth: "none",
    request: { query: Type.Object({ request: Type.String({ maxLength: 64 }) }) },
    responses: {
      200: { description: "HTML page.", schema: Type.String(), contentType: "text/html" },
      400: {
        description: "Unknown or expired request, or another browser.",
        schema: Type.String(),
        contentType: "text/html",
      },
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/oauth/authorize/complete",
    operationId: "completeNativeAuthorization",
    summary: "Native app sign-in: confirm or cancel; returns the redirect to the app",
    description:
      "Needs the request's browser cookie. The redirect carries a one-time code (60 seconds), " +
      "`state` and `iss`, or `error=access_denied` when the person cancels.",
    tags,
    auth: "sso-session",
    minScope: "observe",
    request: {
      body: Type.Object({ request: Type.String({ maxLength: 64 }), approve: Type.Boolean() }),
      bodyRequired: true,
    },
    responses: {
      200: {
        description: "Where the browser goes.",
        schema: Type.Object({ redirect: Type.String() }),
      },
      400: { description: "Unknown or expired request.", schema: ApiErr },
      401: "Unauthorized",
    },
  }),
  defineRoute({
    method: "POST",
    path: "/api/identity/oauth/token",
    operationId: "issueSignInToken",
    summary: "Token endpoint for command-line and native app sign-in",
    description:
      "`grant_type=urn:ietf:params:oauth:grant-type:device_code` (client_id, device_code): " +
      "authorization_pending, slow_down, access_denied, expired_token or the session. " +
      "`grant_type=authorization_code` (client_id, code, redirect_uri, code_verifier). Every " +
      "code works once. The result is a new `kss_` session of the person, separate from the " +
      "browser's, listed with its client and revoked like any other.",
    tags,
    auth: "none",
    request: {
      body: Type.Object({
        grant_type: Type.String(),
        client_id: Type.String(),
        device_code: Type.Optional(Type.String()),
        code: Type.Optional(Type.String()),
        redirect_uri: Type.Optional(Type.String()),
        code_verifier: Type.Optional(Type.String()),
      }),
      bodyContentType: "application/x-www-form-urlencoded",
      bodyRequired: true,
    },
    responses: {
      200: {
        description: "The session token (`kss_…`).",
        schema: Type.Object({
          access_token: Type.String(),
          token_type: Type.Literal("Bearer"),
          expires_in: Type.Integer(),
          session_id: Type.String(),
        }),
      },
      400: { description: "OAuth error.", schema: OAuthErr },
    },
  }),
  ...PASSKEY_ROUTES,
  scimRoute(
    "GET",
    "/scim/v2/ServiceProviderConfig",
    "getScimServiceProviderConfig",
    "SCIM service provider configuration",
  ),
  scimRoute("GET", "/scim/v2/ResourceTypes", "listScimResourceTypes", "SCIM resource types"),
  scimRoute("GET", "/scim/v2/Schemas", "listScimSchemas", "SCIM schemas"),
  scimRoute(
    "GET",
    "/scim/v2/Users",
    "listScimUsers",
    "List users (filter userName eq / externalId eq)",
    {
      request: { query: ListQuery },
    },
  ),
  scimRoute("POST", "/scim/v2/Users", "createScimUser", "Provision a user", {
    request: {
      body: Loose({ userName: Type.String() }),
      bodyContentType: ScimJson,
      bodyRequired: true,
    },
  }),
  scimRoute("GET", "/scim/v2/Users/{id}", "getScimUser", "Read a user", {
    request: { params: IdParam },
  }),
  scimRoute("PUT", "/scim/v2/Users/{id}", "replaceScimUser", "Replace a user", {
    request: { params: IdParam, body: Loose({}), bodyContentType: ScimJson, bodyRequired: true },
  }),
  scimRoute(
    "PATCH",
    "/scim/v2/Users/{id}",
    "patchScimUser",
    "Patch a user (active: false deprovisions)",
    {
      request: {
        params: IdParam,
        body: Loose({ Operations: Type.Array(Loose({})) }),
        bodyContentType: ScimJson,
        bodyRequired: true,
      },
    },
  ),
  scimRoute("DELETE", "/scim/v2/Users/{id}", "deleteScimUser", "Delete a user (ends sessions)", {
    request: { params: IdParam },
  }),
  scimRoute(
    "GET",
    "/scim/v2/Groups",
    "listScimGroups",
    "List groups (filter displayName eq / externalId eq)",
    {
      request: { query: ListQuery },
    },
  ),
  scimRoute("POST", "/scim/v2/Groups", "createScimGroup", "Provision a group", {
    request: {
      body: Loose({ displayName: Type.String() }),
      bodyContentType: ScimJson,
      bodyRequired: true,
    },
  }),
  scimRoute("GET", "/scim/v2/Groups/{id}", "getScimGroup", "Read a group", {
    request: { params: IdParam },
  }),
  scimRoute("PUT", "/scim/v2/Groups/{id}", "replaceScimGroup", "Replace a group", {
    request: { params: IdParam, body: Loose({}), bodyContentType: ScimJson, bodyRequired: true },
  }),
  scimRoute(
    "PATCH",
    "/scim/v2/Groups/{id}",
    "patchScimGroup",
    "Patch a group (members add / remove)",
    {
      request: {
        params: IdParam,
        body: Loose({ Operations: Type.Array(Loose({})) }),
        bodyContentType: ScimJson,
        bodyRequired: true,
      },
    },
  ),
  scimRoute("DELETE", "/scim/v2/Groups/{id}", "deleteScimGroup", "Delete a group", {
    request: { params: IdParam },
  }),
];

export const SCIM_OPERATION_IDS = IDENTITY_ROUTES.filter((r) => r.auth === "scim-token").map(
  (r) => r.operationId,
);
