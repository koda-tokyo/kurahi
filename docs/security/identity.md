---
summary: "Enterprise identity: OIDC and SAML single sign-on for people, SCIM 2.0 provisioning, the organisation model (departments, teams), roles and group mappings, SSO required with break-glass, and how roles map to gateway scopes and Project approvers"
read_when:
  - Connecting Kurahi to Microsoft Entra ID, Okta, Google or Keycloak
  - Provisioning and deprovisioning people with SCIM
  - Deciding who may approve, administer or audit
  - Answering a security review question about sign-in, sessions or break-glass access
title: "Enterprise identity"
---

# Enterprise identity

日本語版: [エンタープライズ ID](/ja/security/identity)

People sign in to the gateway and the Work Console with the organisation's identity provider
(IdP). A signed-in person is a **person principal** (`person:<id>`), distinct from devices
(pairing credentials, device keys) and from agents (backend tool connections). Roles decide what
a person may do; the person-only gates (work item decisions, autopilot approvals, the global
stop) still refuse every agent connection, whatever roles it carries.

| Piece            | What it does                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------- |
| OIDC sign-in     | Authorization code with PKCE (S256), `state` and `nonce`; any provider with discovery              |
| SAML 2.0 sign-in | SP-initiated; signed assertions required; audience, recipient, time window and replay checked      |
| SSO sessions     | Opaque `kss_…` tokens, absolute lifetime and idle timeout, logout (RP-initiated for OIDC)          |
| SCIM 2.0         | Users and Groups for Entra ID and Okta provisioning; deactivation ends sessions at once            |
| Organisation     | Departments and teams you define, roles, IdP group → role mappings, all changes audited and sealed |
| SSO required     | People must use SSO; the gateway token only works as an audited break-glass login                  |

## Configuration

Everything lives under `gateway.identity`. Secrets (OIDC client secret, SCIM token) are
references to the secrets store, never plain values in `kolo.json`:

```bash
kurahi secrets set identity.entra.clientSecret      # paste the value when asked
kurahi secrets set identity.scim.token              # at least 32 random characters
```

```json5
{
  gateway: {
    identity: {
      // The gateway's external https address: redirect URIs, SAML ACS and metadata use it.
      publicUrl: "https://kurahi.example.com",
      providers: [
        {
          id: "entra",
          kind: "oidc",
          label: "Company account",
          issuer: "https://login.microsoftonline.com/<tenant-id>/v2.0",
          clientId: "<application-client-id>",
          clientSecret: { $secret: "identity.entra.clientSecret" },
          groupsClaim: "groups",
        },
      ],
      session: { lifetimeMinutes: 480, idleMinutes: 60 },
      scim: { enabled: true, token: { $secret: "identity.scim.token" }, rateLimitPerMinute: 600 },
      ssoRequired: false,
    },
  },
}
```

| Key                                | Default                    | Meaning                                                                                                         |
| ---------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `publicUrl`                        | none                       | Required for SSO; `https://` (plain `http://` only on loopback for tests)                                       |
| `providers[]`                      | none                       | Up to 10 OIDC or SAML providers; `id` appears in URLs (`a-z`, `0-9`, `-`; `scim` and `legacy` are reserved)     |
| `session.lifetimeMinutes`          | 480 (max 1440)             | Absolute session length; a SAML `SessionNotOnOrAfter` shortens it                                               |
| `session.idleMinutes`              | 60                         | A session without requests for this long ends                                                                   |
| `clockSkewSeconds`                 | 120 (max 300)              | Allowed clock difference for tokens and assertions                                                              |
| `defaultRole`                      | none                       | Role for a person with no assignment or mapped group; none = sign-in refused                                    |
| `requireProvisioned`               | true with SCIM, else false | Only active SCIM-provisioned persons may sign in                                                                |
| `scim.enabled` / `scim.token`      | off                        | SCIM endpoints answer only when both are set                                                                    |
| `ssoRequired`                      | false                      | See [SSO required and break-glass](#sso-required-and-break-glass)                                               |
| `breakGlass.localOnly`             | true                       | Break-glass logins only from the gateway host                                                                   |
| `providers[].trustEmailForLinking` | false                      | See [Account linking](#account-linking)                                                                         |
| `localPersons`                     | see below                  | See [Who counts as a person](#who-counts-as-a-person)                                                           |
| `configRoles`                      | none                       | Roles that also get `operator.config` (host-level methods); see [roles](#organisation-roles-and-group-mappings) |

The gateway logs `identity: …` at startup for any provider it cannot use (for example a missing
`publicUrl`).

The gateway refuses to start with an invalid config. If `kolo.json` later becomes unreadable or
invalid while the gateway runs, the identity settings fail closed: the last settings that loaded
stay in force (SSO required stays required, local persons stay off) until the file loads again,
and the first such load is audited as `identity.config.load_failed`. Each HTTP request decides by
the config snapshot it loaded itself.

## Provider setup

Each provider has these addresses (replace `<id>` with the provider id):

| Purpose                     | URL                                                  |
| --------------------------- | ---------------------------------------------------- |
| OIDC redirect URI           | `<publicUrl>/api/identity/sso/<id>/callback`         |
| SAML ACS (HTTP-POST)        | `<publicUrl>/api/identity/sso/<id>/acs`              |
| SAML SP entity id, metadata | `<publicUrl>/api/identity/sso/<id>/metadata`         |
| Sign-in start               | `<publicUrl>/api/identity/sso/<id>/login?returnTo=/` |
| SCIM base URL               | `<publicUrl>/scim/v2`                                |

### Microsoft Entra ID (OIDC)

1. In Entra ID, register an application (single tenant). Add a **Web** redirect URI
   `<publicUrl>/api/identity/sso/entra/callback`.
2. Create a client secret and store it with `kurahi secrets set identity.entra.clientSecret`.
3. Under **Token configuration**, add the **groups** claim (security groups, as group ids). For
   users in many groups, assign groups to the application and emit only those, or use SCIM.
4. Configure the provider with `issuer: "https://login.microsoftonline.com/<tenant-id>/v2.0"`.

Multi-tenant applications use `issuer: "https://login.microsoftonline.com/organizations/v2.0"`
with `allowedTenants: ["<tenant-id>", …]`; the token's `tid` must be listed.

For SCIM provisioning, add the same application as an **Enterprise application → Provisioning →
Automatic**: Tenant URL `<publicUrl>/scim/v2`, Secret token = the SCIM token. Entra ID matches
users on `userName` (the UPN) and sends `active: "False"` to deprovision.

### Okta (OIDC or SAML)

OIDC: create an **OIDC Web Application**, sign-in redirect URI
`<publicUrl>/api/identity/sso/okta/callback`, and set `issuer` to your authorization server
(`https://<org>.okta.com/oauth2/default`). Add a **groups** claim to the ID token (filter, for
example `Matches regex .*`).

SAML: create a **SAML 2.0** application. Single sign-on URL = the ACS URL, Audience URI = the SP
entity id (`<publicUrl>/api/identity/sso/okta/metadata`), Name ID format EmailAddress, sign the
assertion with SHA-256, add a group attribute statement named `groups`. Then:

```json5
{
  id: "okta",
  kind: "saml",
  label: "Okta",
  idpEntityId: "http://www.okta.com/<app-id>",
  idpSsoUrl: "https://<org>.okta.com/app/<app>/<app-id>/sso/saml",
  idpCertificates: ["-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"],
}
```

Okta SCIM: enable **SCIM provisioning**, base URL `<publicUrl>/scim/v2`, unique identifier field
`userName`, authentication **HTTP Header** with the SCIM token as Bearer; enable Create, Update
and Deactivate users and Push Groups.

### Google Workspace (OIDC)

Create an OAuth client (Web application) in Google Cloud, redirect URI
`<publicUrl>/api/identity/sso/google/callback`, `issuer: "https://accounts.google.com"`, and
`allowedDomains: ["example.com"]` so only your Workspace domain signs in. Google ID tokens carry
no groups: give roles with e-mail assignments (`email:alice@example.com`, with
`trustEmailForLinking: true` on the Google provider) or `defaultRole`.

### Keycloak (OIDC or SAML)

OIDC: a confidential client with the redirect URI above, `issuer:
"https://keycloak.example.com/realms/<realm>"`, and a **Group Membership** mapper named `groups`
(full group path off). SAML: a SAML client with the ACS URL, "Sign assertions" on, signature
algorithm RSA_SHA256, and a group list mapper named `groups`.

## Account linking

A sign-in becomes a person in this order:

1. An existing link of this provider, issuer and subject (from an earlier sign-in, or made by an
   admin with `identity.persons.link`).
2. A SCIM-provisioned person whose `externalId` equals the IdP subject (OIDC `sub`, SAML NameID),
   if that person has no link yet and the sign-in comes from `scim.providerId` (default: the only
   provider when exactly one is configured; with several and none set, an admin links persons).
3. Only for a provider with `trustEmailForLinking: true` and an e-mail the IdP verified: an
   existing person with that e-mail (`userName` or primary e-mail) who has no link yet.
4. Otherwise a new person (just-in-time), unless `requireProvisioned` is on.

A sign-in that matches an existing person by e-mail without step 3 applying, or that would
attach to a person already linked (to another subject, or to another provider), is refused with
`link_conflict` and audited (`identity.sso.link`). An identity is attached to a person linked to
a different provider only by an admin link (`identity.persons.link`; `identity.persons.unlink`
removes one and ends the sessions opened through it).

What counts as a verified e-mail: for OIDC, the `email` claim (or `emailClaim`) only when the ID
token carries `email_verified: true`; `preferred_username` and `upn` are never used as an
e-mail. For SAML, an e-mail attribute of the signed assertion, or the NameID when its Format is
`emailAddress`. Enable `trustEmailForLinking` only for an IdP that owns the e-mail domain (your
Workspace or Entra tenant, not a consumer provider). Microsoft Entra ID does not send
`email_verified` by default: link Entra users with SCIM (`externalId` = the subject) or admin
links, and give roles by group mapping.

`email:` role assignments match only an e-mail vouched for by SCIM or by a provider with
`trustEmailForLinking`; an unverified or untrusted e-mail matches nothing.

## What the gateway checks

**OIDC.** Discovery only over https and only when the document's `issuer` is the configured one.
The `state` is single use and expires after 10 minutes; the PKCE verifier goes to the token
endpoint. The ID token must be signed by a key from the provider's JWKS (`RS256`, `PS256`,
`ES256`; `none` and HMAC are refused; an unknown `kid` triggers one rate-limited key refresh),
and must have the configured issuer (or an allowed tenant), our client id as audience (`azp` when
there are several), `exp` / `nbf` / `iat` within the clock skew and not issued before the sign-in
started, and the nonce of this sign-in. A nonce is accepted once. Every request to the IdP
(discovery, JWKS, token endpoint) times out after 10 seconds.

**SAML.** The response must answer a request this gateway sent (IdP-initiated sign-in is not
accepted) and is spent on first use. The assertion itself must be signed by a configured IdP
certificate (a signed response around an unsigned assertion is refused); signature algorithms
RSA-SHA256/512 and ECDSA-SHA256, digests SHA-256/512 (SHA-1 is refused); the key is never taken
from the message. Audience must be our SP entity id; the bearer subject confirmation must name our
ACS URL as recipient, this request as `InResponseTo` and a future `NotOnOrAfter`; conditions must
hold within the clock skew, and a condition other than `AudienceRestriction`, `OneTimeUse` or
`ProxyRestriction` is refused (`unsupported_condition`); the assertion must carry an
`AuthnStatement` (`no_authn_statement`); an assertion id is accepted once. The NameID is the
subject a person is linked by, so its Format must be stable: `persistent` or `emailAddress` by
default, or the formats listed in the provider's `nameIdFormats`; transient, unspecified or
missing formats are refused (`nameid_format`). Encrypted assertions are not supported.

**Both.** `allowedDomains` compares the part after the only `@`: an address with several `@`
(`someone@example.com@other.test`) has no domain and is refused.

Signature wrapping is closed by construction: exactly one assertion in the whole message, as a
direct child of the response; duplicate `ID` attributes anywhere are refused; the signature must
be a direct child of the element it signs and reference that element's own ID; every value
(subject, e-mail, groups) is read from the verified element only. Messages are parsed by a strict
parser that refuses DOCTYPE, entities, comments, CDATA and processing instructions.

Why no SAML library: the trust path uses `node:crypto` and a small strict parser and exclusive
canonicaliser in `src/identity/saml/` instead of a general XML stack, so no new dependency enters
the sign-in path and nothing outside the accepted grammar is interpreted. The canonicaliser is
tested against an independently signed fixture produced with libxml2 (lxml).

## Sessions

A successful sign-in returns the browser to the console path it came from with a one-time code
in the URL fragment (`#sso_code=…`), never the session token. The console takes it out of the
address bar and exchanges it at once (`POST /api/identity/sso/exchange`) for the session token,
which it keeps in session storage. The code works once, for 60 seconds, and only together with
the binding cookie of the browser that started the sign-in; a refused, replayed or expired code
is burnt and its session ends (audited as `identity.sso.exchange`). Refusals return as
`#sso_error=<reason>` (`no_role`, `not_provisioned`, `deprovisioned`, `link_conflict`,
`inactive`, `state_unknown`, …).

The return path (`returnTo`) must be a console route: a local path (one leading `/`, no dot
segments, also percent-encoded such as `%2e%2e`, no backslashes, encoded slashes or control
characters, still local after normalisation) under the control UI base path
(`gateway.controlUi.basePath`), made of plain route segments (no file names), and not a path the
gateway serves itself (API routes, canvas and A2UI, avatars, plugin and channel webhooks, hooks).
Anything else returns to the console root. So the code never lands on a page whose script is not
the console's. The final `Location` header is checked again.

- Starting a sign-in sets an HttpOnly cookie (`kurahi_sso_bind`, path `/api/identity/sso`, 10
  minutes, `SameSite=None; Secure`); the OIDC callback and the SAML ACS refuse a sign-in that comes
  back without it (`browser_mismatch`), so a sign-in cannot be completed in another browser. After
  a successful sign-in the cookie stays for the code exchange (60 seconds) and is cleared by it.
- The session is checked on connect and again on every request. An open WebSocket connection is
  also re-checked every 30 seconds and at once whenever the directory changes (persons, groups,
  units, role assignments, group mappings), so a role change applies to it immediately, including
  which events it receives, even if it sends no requests. Receiving events is not activity: a
  connection that sends no requests still reaches the idle timeout.
- It ends at its lifetime, after the idle timeout, on logout, when SCIM deactivates or deletes
  the person, when an admin revokes it (`identity.sessions.revoke`), or at its next check once
  its provider is no longer configured or usable (`provider_removed`). Open connections of the
  session close with WebSocket close code 4001: at once on revocation and directory changes,
  within 30 seconds at expiry and idle timeout. The groups a removed provider asserted at sign-in
  stop counting for group mappings and Project access at once.
- `POST /api/identity/logout` ends the session; for OIDC providers that publish an
  `end_session_endpoint` the response carries `endSessionUrl` (RP-initiated logout). SAML
  logout is local only.
- No device token is issued to a person: a stored device token would outlive the SSO session.
- Only SHA-256 hashes of session tokens are stored (`<KOLO_HOME>/identity/sessions.json`, 0600).
  The OIDC ID token kept for RP-initiated logout stays in memory only; after a gateway restart
  the logout URL carries `client_id` without `id_token_hint`.
- Sign-in starts are limited to 30 per minute per source and 300 per minute for the whole
  gateway (429 with `Retry-After`), and each source holds at most 20
  sign-ins in progress (a new one replaces that source's oldest). When the gateway-wide store of
  sign-ins in progress is full, new starts are refused (`too_many_pending`) rather than evicting
  other people's sign-ins.

## SCIM 2.0

Bearer token `gateway.identity.scim.token`; requests beyond `scim.rateLimitPerMinute` get 429.
Without `scim.enabled` and a token the endpoints answer 401. `scim.providerId` names the provider
whose subjects the directory's `externalId` values are; another provider's subject never matches
them.

| Endpoint                                                     | Operations                                             |
| ------------------------------------------------------------ | ------------------------------------------------------ |
| `/scim/v2/Users`                                             | GET (filter `userName eq`, `externalId eq`), POST      |
| `/scim/v2/Users/{id}`                                        | GET, PUT, PATCH (`active: false` deprovisions), DELETE |
| `/scim/v2/Groups`                                            | GET (filter `displayName eq`, `externalId eq`), POST   |
| `/scim/v2/Groups/{id}`                                       | GET, PUT, PATCH (members add / remove), DELETE         |
| `/scim/v2/ServiceProviderConfig`, `ResourceTypes`, `Schemas` | GET                                                    |

Pagination uses `startIndex` and `count` (at most 200). Attributes outside this subset (the
enterprise extension, phone numbers, addresses, title, …) are accepted and ignored.

Deprovisioning fails closed:

- PATCH paths may carry the schema URN (`urn:ietf:params:scim:schemas:core:2.0:User:active`);
  it is stripped. A path or operation outside the supported and ignored attributes is a 400
  (`invalidPath`, `invalidSyntax`, `mutability`), never a silent success, and the whole request
  is not applied. Group PATCH supports `members` (add, remove, replace, `members[value eq
"…"]`), `displayName` and `externalId`.
- PUT without `active` keeps the current state: a replace never reactivates a person.
- Attribute names are case-insensitive (RFC 7643): `Active: false` in a PUT deactivates like
  `active: false`, in User and Group bodies, PatchOp messages and multi-valued entries. The same
  attribute twice in different case is a 400. A member removal whose entries do not each name a
  member (`{"value": "<id>"}`) is a 400 instead of a silent no-op.
- With `scim.enabled`, `requireProvisioned` defaults to true (also while the SCIM token is still
  missing): a person the directory does not know cannot sign in just in time. Set
  `requireProvisioned: false` to allow it.
- DELETE removes the person, their group memberships and their role assignments (by
  `person:<id>`, and `email:` assignments for their e-mail or userName), ends their sessions and
  leaves a **tombstone**. A later sign-in that matches the tombstone (same link, subject = old
  `externalId`, or same e-mail) is refused with `deprovisioned` instead of creating the person
  again. An org-admin lifts it with `identity.persons.restore` (tombstones are listed in
  `identity.org.get`); SCIM creating the same `userName` or `externalId` again also clears it.
  A restored person starts without the old grants. Tombstones are capped at 50,000; the oldest
  is dropped at the cap only while `requireProvisioned` is on (sign-in refuses unknown persons
  anyway). With `requireProvisioned: false` no tombstone is dropped: when the store is full, a
  SCIM DELETE deactivates the person instead, so the deletion still locks them out.

The SCIM token is admin-equivalent for the directory: whoever holds it can create persons, set
their e-mail (which SCIM vouches for) and change group memberships, and so their mapped roles.
Store it in the secrets store, give it only to the IdP's provisioning connector, and rotate it if
it leaks.

A provisioned person is linked
to their first sign-in by `externalId` = subject (through `scim.providerId` only), or by e-mail
for a provider with
`trustEmailForLinking` (see [Account linking](#account-linking)). Deactivation and deletion
revoke every session of the person at once.

## Organisation, roles and group mappings

The organisation has **org units** you define: departments (optionally linked to a Business
department id such as `finance` for work queues) and teams under a department. Roles:

| Role                 | Gateway scope | Approvals | Typical holder                                         |
| -------------------- | ------------- | --------- | ------------------------------------------------------ |
| `org-admin`          | attach        | yes       | + identity admin: org units, roles, mappings, sessions |
| `security-admin`     | attach        | yes       | + sessions, pairing, policy kill switch                |
| `auditor`            | observe       | no        | Read-only, plus audit chain and evidence (HTTP)        |
| `department-manager` | attach        | yes       | Head of a department (unit-scoped)                     |
| `approver`           | attach        | yes       | Approves in work queues (eligibility only)             |
| `operator`           | attach        | yes       | Runs agents and routines                               |
| `member`             | attach        | no        | Works with agents and Projects                         |
| `viewer`             | observe       | no        | Reads                                                  |

A person's scope is the highest of their roles. "Approvals" means eligibility for approval-type
methods (`operator.approvals`); it never decides a work item stage by itself.

No role gives the gateway `admin` scope or `operator.admin`. The two admin roles open narrow
**admin areas** instead (shown as `adminAreas` in `identity.whoami`):

| Area       | Scope               | Methods                                                                                                                                               | Roles                       |
| ---------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `identity` | `operator.identity` | `identity.*` admin methods (the handler checks org-admin)                                                                                             | org-admin                   |
| `sessions` | `operator.identity` | `identity.sessions.list` / `.revoke`                                                                                                                  | org-admin, security-admin   |
| `pairing`  | `operator.pairing`  | `device.pair.*`, `node.pair.*`, `device.token.*`, `node.rename`                                                                                       | security-admin              |
| `policy`   | `operator.policy`   | `policy.kill` / `policy.release` (as admin for `kill.mayFlip`)                                                                                        | security-admin              |
| `config`   | `operator.config`   | Host-level methods: `config.*`, `wizard.*`, `update.*`, cron edits, `skills.install` / `.update`, `sessions.patch` / `.delete`, `exec.approvals.*`, … | only roles in `configRoles` |

The `pairing` area has a scope ceiling: `device.pair.approve` and `device.token.rotate` mint a
device token only for scopes the caller holds itself (`operator.write` covers `operator.read`),
so a security-admin can never hand out `operator.admin` or `operator.config`. A request beyond
the caller's scopes is refused with `scope_ceiling` (audited), and no token is returned.

Host-level methods otherwise need the owner (the gateway token on the gateway host).
`gateway.identity.configRoles` (default empty) is the explicit opt-in for people to change
the host configuration.

Roles come from **assignments** (to `person:<id>`, or to `email:<address>` before the first
sign-in, matched only against trusted e-mails, optionally scoped to a unit) and from **group mappings** (see below). Admin methods, org-admin only (sessions: org-admin or
security-admin), each one audited and sealed as an evidence bundle under
`<KOLO_HOME>/identity/evidence/`:

| Method                                   | Purpose                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------- |
| `identity.whoami`                        | Person, roles, units, scope and session                                         |
| `identity.org.get`                       | Units; assignments, mappings and persons for org-admin, security-admin, auditor |
| `identity.org.update`                    | Organisation name                                                               |
| `identity.units.upsert` / `.remove`      | Departments and teams                                                           |
| `identity.roles.assign` / `.revoke`      | Role assignments                                                                |
| `identity.groupMappings.set` / `.remove` | IdP group → roles and units                                                     |
| `identity.sessions.list` / `.revoke`     | SSO sessions                                                                    |
| `identity.persons.link` / `.unlink`      | Link an IdP identity to a person (admin approval) or remove a link              |
| `identity.persons.restore`               | Lift the tombstone of a SCIM-deleted person                                     |

Until the first org-admin exists, the owner (gateway token) may make these changes as a
bootstrap admin; after that only org-admins, or a break-glass login. Agents never administer
identity.

### Group mappings

A group mapping names its **source** and an **immutable group id**:

| `source`      | `group`                                                       | Matches                                                     |
| ------------- | ------------------------------------------------------------- | ----------------------------------------------------------- |
| `scim`        | the SCIM group `id` or `externalId`                           | persons SCIM made members of that group                     |
| a provider id | the value that provider asserts (`groups` claim or attribute) | persons whose last sign-in through that provider carried it |

```json5
// identity.groupMappings.set
{ source: "scim", group: "6f1c…-group-id", roles: ["approver"], units: ["finance"] }
{ source: "entra", group: "<Entra group object id>", roles: ["org-admin"] }
```

A value asserted by one provider never satisfies another provider's mapping, and a provider
claim never satisfies a `scim` mapping. SCIM display names are not matched (a group can be
renamed by anyone who can rename it in the IdP), unless the mapping sets `matchDisplayName:
true`, an explicit opt-in for SCIM mappings only. Prefer group object ids in the token too
(Entra ID emits ids by default); for providers that only send names, the name is what the
mapping matches, so restrict who can create or rename groups there. Mappings written before this
scoping load with `source: "legacy"` and match nothing until they are set again.

### Project access and approvers

Work item stages keep deciding who approves. A Project's access policy can name person principals
directly (`access.members[].principal: person:<id>`) or grant its roles to the groups a person
exports:

| Group id                   | Who carries it                                                      |
| -------------------------- | ------------------------------------------------------------------- |
| `role:<role>`              | Everyone with that role                                             |
| `role:<role>@<unit>`       | That role assigned on the unit or a unit above it                   |
| `unit:<unit>`              | Members of the unit and of every unit below it                      |
| `group:scim:<id>`          | Members of the SCIM group (id or externalId)                        |
| `group:<provider>:<value>` | Persons whose last sign-in through that provider asserted the value |

```yaml
access:
  groups:
    "role:approver": { roles: [approver] }
    "role:department-manager@sales": { roles: [approver], departments: [sales] }
```

An org `approver` role therefore makes a person eligible only where a Project maps it, and a stage
with a department field still requires that department.

## Who counts as a person

The person-only methods (`workitems.decide`, `.delegate`, `.clearFlag`, autopilot approvals,
`pause` / `resume`, `stopAll` / `startAll`, `autonomy.accept` / `.decline`, `reportError`, the
morning brief) decide personhood from the credential the connection authenticated with, never
from what the client says about itself (`client.mode`, `client.id`, `displayName`):

| Connection                                                      | Identity not configured | Identity configured |
| --------------------------------------------------------------- | ----------------------- | ------------------- |
| SSO session (`kss_…`)                                           | person                  | person              |
| Gateway token or password with a break-glass reason (audited)   | person                  | person              |
| Gateway token, password, Tailscale login, device token, pairing | person (local person)   | not a person        |
| Agent runtimes: `mode: "backend"`, `gateway-client`, `agent`    | never                   | never               |

"Identity configured" means `gateway.identity` lists providers, enables SCIM or sets
`ssoRequired`. Single-user installs without any of these keep working as before: the owner is
the local person. `localPersons: true` keeps that behaviour with identity configured (for
example while SSO is being rolled out); it is ignored with `ssoRequired`. A declared agent field
only ever takes personhood away.

With identity configured but SSO not required, the owner can still act as a person by stating a
reason: the CLI's `KOLO_BREAK_GLASS` or `connect.auth.breakGlass`, gateway token or password,
from the gateway host unless `breakGlass.localOnly: false`. It is audited and sealed like the
break-glass below.

Break-glass and `localPersons` prove that the caller holds the gateway token or password, not
that a human is present: an agent with shell access on the gateway host can read the token and
run the CLI with `KOLO_BREAK_GLASS`. With identity configured, the highest-impact decisions
therefore need an SSO session: `workitems.decide`, `workitems.clearFlag`,
`autopilot.approvals.create` / `.revoke`, `autopilot.autonomy.accept` and `autopilot.startAll`.
A break-glass owner keeps the admin and recovery powers (identity administration, `pause`,
`autopilot.stopAll`, and the other person-only methods). `stopAll` stays available on purpose:
the emergency stop must work during an IdP outage. Single-user installs without identity config
are unchanged: the owner decides as before.

## SSO required and break-glass

With `ssoRequired: true`, people must sign in through SSO. Refused: gateway token, password,
pairing-credential, device-token and Tailscale logins of people. Still accepted: SSO sessions,
node connections of a paired device (the node's device token, or a device identity that then
goes through device pairing; the gateway token alone does not connect a node, audited as
`identity.sso_required.node`), agent connections from the gateway host itself (each one audited
as `identity.sso_required.agent`; they are never persons). Over HTTP, the
gateway token and pairing credentials work only from the gateway host, and the gateway token
there is break-glass too: every request must carry `X-KoLo-Break-Glass: <reason>`
(percent-encoded for non-ASCII text) and is audited as `identity.breakglass.http`; without it
the request is refused (401). The CLI's HTTP commands send `KOLO_BREAK_GLASS` as this header.
The same check applies to every HTTP path that takes the shared secret: the declared routes,
`/api/admin/*` and `/metrics`, and the canvas, A2UI and avatar routes. From another host the
gateway token is refused there (with or without a reason; refusals of a valid token are audited
as `identity.sso_required`); the canvas, A2UI and avatar routes accept an SSO session instead.
A legacy admin session (`kolo_session`) on `/api/admin/*` is accepted from the gateway host only.

**Break-glass** is the gateway token or password with a stated reason, from the gateway host
(unless `breakGlass.localOnly: false`). Every break-glass login writes an
`identity.breakglass.login` audit entry and an evidence bundle with the reason. The CLI sends the
reason from the environment:

```bash
KOLO_BREAK_GLASS="IdP outage, change ticket 4711" kurahi status
```

In the WebSocket handshake the reason is `connect.auth.breakGlass`. A break-glass owner may use
the identity admin methods.

**What "the gateway host" means.** A request counts as coming from the gateway host when the
socket peer is loopback, its `Host` is `localhost`, `127.0.0.1`, `::1` or a `*.ts.net` name, and
either it carries no forwarding headers (`X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Host`) or
the socket peer is listed in `gateway.trustedProxies` and the client address it forwarded is
loopback too. A trusted proxy that sends forwarding headers but names no client address
(`X-Forwarded-Host` only) does not make a request local.

**Client address behind a proxy.** One resolver decides the client address everywhere (the
gateway host test, the auth-attempt limiter, the HTTP and WebSocket throttles, device
auto-approval and audit records). The socket peer is the client unless it is in
`gateway.trustedProxies`. Then `X-Forwarded-For` is read from the right: every entry that is a
trusted proxy is skipped and the first one that is not is the client, so a value the client wrote
into the header itself (for example `X-Forwarded-For: 127.0.0.1`) is never believed. Without
`X-Forwarded-For`, `X-Real-IP` is used. Addresses are compared normalized (`::ffff:127.0.0.1` is
`127.0.0.1`, ports and brackets are ignored), in `gateway.trustedProxies` as well. List every
proxy hop in `gateway.trustedProxies`, and configure the proxy to:

- overwrite `X-Forwarded-For` with the address it accepted the connection from (or append it, so
  it is the rightmost entry), and overwrite `X-Real-IP` and `X-Forwarded-Host`;
- set `Host` itself instead of passing the client's `Host` through.

Caveat: a reverse proxy on the same host that connects over loopback and does not add
`X-Forwarded-For` (or rewrites `Host` to `localhost`) makes every proxied request look local, so
break-glass "from the gateway host only", the local agent exemption and the local HTTP rules
would apply to remote users. Behind a same-host proxy, make it send `X-Forwarded-For` and list it
in `gateway.trustedProxies`.

## HTTP endpoints

| Method and path                             | Auth        | Purpose                                     |
| ------------------------------------------- | ----------- | ------------------------------------------- |
| `GET /api/identity/sso`                     | none        | Providers to offer, whether SSO is required |
| `GET /api/identity/sso/{provider}/login`    | none        | Start a sign-in                             |
| `GET /api/identity/sso/{provider}/callback` | none        | OIDC redirect URI                           |
| `POST /api/identity/sso/{provider}/acs`     | none        | SAML ACS                                    |
| `GET /api/identity/sso/{provider}/metadata` | none        | SAML SP metadata                            |
| `POST /api/identity/sso/exchange`           | none        | One-time code for the session token, once   |
| `GET /api/identity/session`                 | SSO session | The signed-in person                        |
| `POST /api/identity/logout`                 | SSO session | End the session                             |

SSO session tokens are also accepted as `Authorization: Bearer` on the evidence and audit-chain
routes; auditors may read those regardless of their observe scope. A person reads the evidence of
a job (`/api/jobs/{id}/evidence…`, `/evidence/{id}`) only when:

- they hold `org-admin` or `auditor` without a unit (every job);
- the job ran in a Project session and the Project's access policy lists them, in
  `access.members` or through an exported group in `access.groups` (`role:<role>`,
  `role:<role>@<unit>`, `unit:<unit>`, `group:<IdP group>`), which covers Project members, unit
  members and the approvers and managers the Project names;
- they hold `auditor` or `org-admin` for a unit, and the Project's `access.groups` names that unit
  or one below it (`unit:<unit>` or `role:<role>@<unit>`).

Any other job (no Project, or a Project that does not name them) answers 404. Pairing
credentials and the gateway token keep their own rules. Failed sign-ins count toward
the per-source authentication attempt limit. The full schemas are in the
[OpenAPI document](/gateway/protocol).

## Console

When the gateway has SSO providers, the Overview page shows **Sign in with …** buttons; after
sign-in it shows the person, roles and session end, and **Sign out**. The console must be served
by the gateway (the default) for the sign-in redirect to return to it.
