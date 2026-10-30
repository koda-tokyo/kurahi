// Enterprise identity configuration (`gateway.identity`): SSO providers, sessions, SCIM and the
// "SSO required" switch. Secrets (OIDC client secret, SCIM bearer token) are `$secret`
// references resolved from the secrets store, never plain values in kolo.json.

export type IdentityOidcProviderConfig = {
  id: string;
  kind: "oidc";
  /** Button label in the console (e.g. "Company sign-in"). */
  label?: string;
  /** Issuer URL; discovery is `<issuer>/.well-known/openid-configuration` (https only). */
  issuer: string;
  clientId: string;
  /** Confidential client secret (`{"$secret": "identity.<id>.clientSecret"}`); omit for public clients. */
  clientSecret?: string;
  /** Requested scopes (default openid profile email). */
  scopes?: string[];
  /** Claim holding group values (default `groups`). */
  groupsClaim?: string;
  /**
   * Claim used as the e-mail (default `email`). It is used only when the token also carries
   * `email_verified: true`; `preferred_username` and `upn` are never taken as an e-mail.
   */
  emailClaim?: string;
  /** Accepted ID token algorithms (default RS256, PS256, ES256). */
  algorithms?: string[];
  /**
   * Multi-tenant Entra ID: issuer template with `{tenantid}` (for example
   * `https://login.microsoftonline.com/{tenantid}/v2.0`) and the tenant ids allowed to sign in.
   */
  allowedTenants?: string[];
  /** Only these e-mail domains may sign in (empty = any the IdP vouches for). */
  allowedDomains?: string[];
  /**
   * Link a first sign-in to an existing, unlinked person by verified e-mail, and let this
   * provider's verified e-mails match `email:` role assignments (default false). Without it a
   * sign-in links only by an admin link (`identity.persons.link`) or a SCIM `externalId` equal
   * to the subject. Enable only for an IdP that owns the e-mail domain.
   */
  trustEmailForLinking?: boolean;
  /**
   * `acr_values` sent with step-up re-authentication (for example a phishing-resistant MFA
   * class the IdP defines). Step-up always sends `max_age=0` and `prompt=login`.
   */
  stepUpAcrValues?: string[];
};

export type IdentitySamlProviderConfig = {
  id: string;
  kind: "saml";
  label?: string;
  /** IdP entity id: the expected assertion Issuer. */
  idpEntityId: string;
  /** IdP single sign-on URL (HTTP-Redirect binding). */
  idpSsoUrl: string;
  /** IdP signing certificate(s), PEM. Several allow a key rollover. */
  idpCertificates: string[];
  /** SP entity id (default `<publicUrl>/api/identity/sso/<id>/metadata`). */
  spEntityId?: string;
  /**
   * NameID formats accepted as the subject (default persistent and emailAddress). Transient and
   * unspecified NameIDs are not stable identifiers and would link a different person each time.
   */
  nameIdFormats?: string[];
  /** Attribute names (default: e-mail, display name and groups claim URIs used by Entra / Okta). */
  attributes?: {
    email?: string;
    displayName?: string;
    groups?: string;
    givenName?: string;
    familyName?: string;
  };
  allowedDomains?: string[];
  /** See the OIDC provider: link and match `email:` assignments by asserted e-mail (default false). */
  trustEmailForLinking?: boolean;
};

export type IdentityProviderConfig = IdentityOidcProviderConfig | IdentitySamlProviderConfig;

/**
 * Step-up for decisions: high-consequence actions need a recent authentication of the person
 * (re-authentication at the IdP, or a passkey assertion). Applies to SSO person sessions only;
 * break-glass and other non-person paths are unchanged.
 */
export type IdentityStepUpConfig = {
  /** Default: on when identity is configured (providers, SCIM or ssoRequired). */
  enabled?: boolean;
  /** How recent the authentication must be, in seconds (default 300, 30 to 3600). */
  maxAgeSeconds?: number;
  /** RFC 8176 `amr` values, any of which the authentication must carry (e.g. ["hwk"], ["mfa"]). */
  requireMethods?: string[];
  actions?: {
    /**
     * Work item approvals (default true: every approval). `{ amountAtLeast }` limits it to items
     * whose amount field (default `amount`) is at least that value.
     */
    approvals?: boolean | { amountAtLeast?: number; amountField?: string };
    /** Accepting an autopilot promotion (a higher routine level). Default true. */
    autopilotLevel?: boolean;
    /** Lifting the emergency stop (autopilot.startAll, policy.release). Default true. */
    emergencyStopRelease?: boolean;
    /** Identity administration changes (roles, units, mappings, links). Default true. */
    identityAdmin?: boolean;
    /**
     * Adding a passkey or enrolling / replacing an authenticator app while signed in (a stolen
     * session must not add its own authenticator). Default true.
     */
    authenticatorChange?: boolean;
    /**
     * Data governance decisions: releasing a legal hold, eDiscovery exports, executing a data
     * subject request, retention runs (not previews) and policy changes. Default true.
     */
    governance?: boolean;
  };
};

/**
 * A native app (public client: no secret) that may sign people in through the system browser
 * (RFC 8252). `redirect: "loopback"` accepts `http://127.0.0.1:<any port>/…` and
 * `http://[::1]:<any port>/…`; otherwise a private-use URI scheme in reverse-domain form
 * (`com.example.app`), whose redirect URIs are `<scheme>:/…`.
 */
export type IdentityNativeClientConfig = {
  id: string;
  /** Shown to the person when they confirm the sign-in, and on the session. */
  name: string;
  redirect: "loopback" | string;
};

export type GatewayIdentityConfig = {
  /** External https URL of this gateway (redirect URIs, SAML ACS and metadata). Required for SSO. */
  publicUrl?: string;
  providers?: IdentityProviderConfig[];
  /**
   * People must sign in through SSO. Token, password, pairing and device-token logins of people
   * are refused; the gateway token works only as an audited break-glass admin login.
   */
  ssoRequired?: boolean;
  /**
   * Local person mode: the gateway token, password, Tailscale login, device tokens and pairing
   * credentials count as a person for person-only methods (work item decisions, autopilot
   * approvals, the global stop). Default: on when no providers, SCIM or ssoRequired are
   * configured (single-user installs), off otherwise. Ignored with ssoRequired.
   */
  localPersons?: boolean;
  breakGlass?: {
    /** Break-glass logins only from the gateway host itself (default true). */
    localOnly?: boolean;
  };
  session?: {
    /** Absolute session lifetime in minutes (default 480, at most 1440). */
    lifetimeMinutes?: number;
    /** Idle timeout in minutes (default 60). */
    idleMinutes?: number;
  };
  /** Role given to a person with no assignment and no mapped group (default: none, sign-in refused). */
  defaultRole?: string;
  /**
   * Roles that may also use host-level methods (config.*, cron edits, skills install, updates,
   * …) through the `operator.config` scope. Default: none; identity admin roles never get them
   * implicitly.
   */
  configRoles?: string[];
  /** Allowed clock skew for tokens and assertions in seconds (default 120, at most 300). */
  clockSkewSeconds?: number;
  scim?: {
    enabled?: boolean;
    /** Bearer token the IdP presents (`{"$secret": "identity.scim.token"}`). */
    token?: string;
    /** Requests per minute per token (default 600). */
    rateLimitPerMinute?: number;
    /**
     * The SSO provider whose subject equals a SCIM person's externalId. Only sign-ins from
     * this provider attach to an unlinked SCIM person by externalId. Default: the only
     * provider when exactly one is configured; otherwise none (an admin links persons).
     */
    providerId?: string;
  };
  /**
   * Only persons provisioned by SCIM (and active) may sign in. Default: true when SCIM is
   * enabled, false otherwise.
   */
  requireProvisioned?: boolean;
  stepUp?: IdentityStepUpConfig;
  /**
   * Native apps allowed to sign people in with the authorization code flow and PKCE. Default:
   * Kurahi Desktop (`kurahi-desktop`, loopback). A list replaces the default (`[]` turns native
   * sign-in off).
   */
  nativeClients?: IdentityNativeClientConfig[];
  /**
   * Command-line sign-in with the device authorization grant (RFC 8628, `kurahi login`).
   * Default true.
   */
  deviceSignIn?: boolean;
  /**
   * Built-in sign-in without an external IdP: passkeys (WebAuthn) and, as a fallback, one-time
   * codes from an authenticator app (TOTP). Kurahi is then its own identity provider (provider
   * id `passkey`). Persons enrol with a one-time enrollment link an identity admin issues, or
   * add another passkey while signed in; there is no open self-registration.
   */
  passkeys?: {
    enabled?: boolean;
    /** WebAuthn relying party id (a domain); default: the host of publicUrl. */
    rpId?: string;
    /** Name authenticators show (default "Kurahi"). */
    rpName?: string;
    /** Require user verification (PIN, biometrics) (default) or only prefer it. */
    userVerification?: "required" | "preferred";
    /** Origins the browser may sign in from (default: the origin of publicUrl). */
    allowedOrigins?: string[];
    /** Offer one-time codes (TOTP) as a fallback (default true). */
    totp?: boolean;
  };
};
