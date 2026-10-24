---
summary: "Microsoft Entra ID business connector: OpenID Connect sign-in validation (issuer, tenant, audience, JWKS) for the gateway and desktop, and opt-in read-only directory lookup; app registration, scopes, data handling, what remains for gateway SSO"
read_when:
  - You want Kurahi sign-in tied to your organisation's Microsoft Entra ID
  - You want agents to look up people and groups in the directory
  - You need to know which parts of single sign-on are built and which are not
title: "Microsoft Entra ID"
---

# Microsoft Entra ID connector

日本語: [Microsoft Entra ID コネクター](/ja/connectors/entra)

The Entra connector does two things, in this order:

1. **Sign-in.** It validates OpenID Connect ID tokens issued by your tenant, so Kurahi can trust
   "this person signed in with the organisation's account".
2. **Directory read (opt-in).** Agents can look up users and, with the higher level, groups and
   memberships. Read-only.

| Property         | Value                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------- |
| Plugin id        | `entra` (bundled, **off by default**)                                                  |
| Sign-in scopes   | `openid`, `profile`, `email`, `offline_access`, `User.Read`                            |
| Directory scopes | `User.ReadBasic.All` (basic) or `Directory.Read.All` (full, admin consent)             |
| Writes           | None. The connector never changes the directory.                                       |
| Status           | Validator built and tested with a local signing key; not yet verified on a live tenant |

## What the administrator sets up in Microsoft Entra

1. **App registrations > New registration**, single tenant (or multi-tenant only if several
   tenants of your group must sign in; then list them in `allowedTenants`).
2. Redirect URI: **Public client/native (mobile & desktop)**, `http://localhost`.
3. **Authentication**: **Allow public client flows** = Yes (device code sign-in). Under
   **Token configuration** nothing is required; `email` is optional.
4. **API permissions > Microsoft Graph > Delegated**: `openid`, `profile`, `email`,
   `offline_access`, `User.Read`; for directory read add `User.ReadBasic.All` (basic) or
   `Directory.Read.All` (full). `Directory.Read.All` always needs **Grant admin consent**.
5. Copy the **Application (client) ID** and **Directory (tenant) ID**. No client secret.

You can reuse the Microsoft 365 connector's app registration if you add these permissions to it.

## Configure Kurahi

```bash
kurahi plugins enable entra
kurahi config set plugins.entries.entra.config '{
  "tenantId": "<Directory (tenant) ID>",
  "clientId": "<Application (client) ID>",
  "directory": "basic"
}' --json
kurahi entra login              # signs in and validates the ID token (with a nonce)
kurahi entra probe              # tenant signing keys reachable + sign-in still valid
kurahi entra verify-token < id_token.txt
```

| Key                    | Default    | Meaning                                                                    |
| ---------------------- | ---------- | -------------------------------------------------------------------------- |
| `tenantId`             | none       | Tenant GUID or verified domain; `organizations` only with `allowedTenants` |
| `clientId`             | none       | Application (client) ID; the expected `aud` of ID tokens                   |
| `allowedTenants`       | the tenant | Tenant GUIDs whose users may sign in                                       |
| `directory`            | `off`      | `off`, `basic` (users), `full` (users and groups)                          |
| `redirectPort`         | random     | Fixed loopback port                                                        |
| `probeIntervalMinutes` | 15         | Health probe interval                                                      |

## How an ID token is validated

`EntraOidcValidator` (`src/connectors/business/oidc.ts`) accepts a token only when every check
passes:

1. Compact JWS with three parts, at most 16 KB.
2. `alg` is `RS256`. `none` and HMAC algorithms are refused.
3. `kid` names a key in the tenant's JWKS. Keys come from the tenant's OpenID configuration
   (`https://login.microsoftonline.com/<tenant>/v2.0/.well-known/openid-configuration`), are
   cached for 6 hours, and an unknown `kid` (key rollover) triggers one refetch at most every
   5 minutes. Key documents are accepted only from `login.microsoftonline.com` over HTTPS.
4. RSA signature over header and payload.
5. `iss` equals the tenant's issuer (`https://login.microsoftonline.com/<tid>/v2.0`).
6. `tid` is in `allowedTenants` (default: the configured tenant only).
7. `aud` equals `clientId`.
8. `exp`, `nbf` and `iat` within a 2-minute clock skew.
9. `nonce` equals the one sent, when the caller sent one (the login command always does).

A rejected token reports one reason (`wrong_audience`, `expired`, `bad_signature`, …) and nothing
from the token.

## Gateway and desktop single sign-on: what is built and what remains

Built:

- The validator above, with tests for valid, expired, not-yet-valid, wrong audience, wrong issuer,
  wrong tenant, bad signature, `alg` confusion, key rollover and foreign key documents.
- `kurahi entra login`: a real interactive sign-in (PKCE, nonce) whose ID token must pass the
  validator before the sign-in is accepted.
- `kurahi entra verify-token`: validate any ID token from stdin.

Not built yet: the gateway's connection handshake accepts a gateway token, a password, a paired
device token or a verified Tailscale identity; it has no extension point for an external
identity provider. To make Entra the sign-in for the gateway and desktop, the remaining work is:

1. Add an `oidc` method to gateway auth (`src/gateway/auth.ts`, `authorizeGatewayConnect`) that
   calls the validator with the token from the `connect` frame.
2. Map validated identities (`tid` + `oid`) to Kurahi roles and scopes, with an admin-managed
   allowlist (group membership through the directory read is one option).
3. Desktop: run the PKCE sign-in in the system browser, keep the refresh token in the OS keyring,
   and renew the ID token before expiry.
4. Exchange a validated sign-in for a short-lived paired-device token, so existing session and
   revocation handling stays the single path.

## Directory tools

| Tool                  | Level | What it does                                                 |
| --------------------- | ----- | ------------------------------------------------------------ |
| `entra_users_search`  | basic | Users whose name, mail or sign-in name starts with the query |
| `entra_user_get`      | basic | One user by object id or user principal name                 |
| `entra_groups_search` | full  | Groups whose name starts with the query                      |
| `entra_group_members` | full  | Direct members of a group                                    |
| `entra_user_groups`   | full  | Groups a user is a direct member of                          |

With `basic`, only names, mail and sign-in names are returned (that is all `User.ReadBasic.All`
allows); `full` adds job title and department.

## Data handling

- Directory names are set by people in the tenant and are passed to the model inside the
  untrusted-content boundary.
- Audit rows (`connector.entra.<operation>`) carry object ids and counts, never names or
  addresses. A successful interactive sign-in records the tenant and object id.
- Tokens are kept in the Kurahi secret store; ID tokens are never stored.
- The connector calls only `login.microsoftonline.com` and `graph.microsoft.com`.

## Status and revocation

The probe loads the tenant's signing keys and calls `GET /me`; the desktop catalogue shows
**Active** only after a successful probe within 25 hours. `kurahi entra logout` deletes the
stored tokens; revoke consent or sessions in Microsoft Entra to cut access at the source.

## Limits of this release

- Only the global Microsoft cloud.
- Gateway and desktop sign-in are not wired to Entra yet (see above).
- Not yet verified against a live tenant: tests use a locally generated signing key and recorded
  responses.
