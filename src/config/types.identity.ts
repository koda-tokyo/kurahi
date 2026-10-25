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
};
