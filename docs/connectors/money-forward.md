---
summary: "マネーフォワード クラウド business connector: read billings, quotes and partners of クラウド請求書 through its public API v3; which Money Forward products have public APIs"
read_when:
  - You are connecting Kurahi to マネーフォワード クラウド
  - You need the app setup, scopes and client authentication method
  - You want to know which Money Forward products are covered
title: "マネーフォワード クラウド"
---

# マネーフォワード クラウド connector

日本語: [マネーフォワード クラウド コネクター](/ja/connectors/money-forward)

| Property      | Value                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| Plugin id     | `money-forward` (bundled, **off by default**), CLI `kurahi moneyforward`               |
| Product       | マネーフォワード クラウド請求書 (invoicing), API v3                                    |
| Access        | **Read-only, always.** Only `mfc/invoice/data.read` is requested                       |
| Sign-in       | OAuth 2.0 authorization code on a loopback redirect; client secret in the secret store |
| Token storage | Kurahi secret store (`connector.money-forward.token`)                                  |
| Status        | Built and tested against recorded API responses; **not yet verified live**             |

## Which products have a public API

Checked on the [developer portal](https://developers.biz.moneyforward.com/) (2026-10-25):

| Product            | Public API                                                                                          | This connector          |
| ------------------ | --------------------------------------------------------------------------------------------------- | ----------------------- |
| クラウド請求書     | Yes, API v3 (OAuth 2.0)                                                                             | **Covered (read-only)** |
| クラウド会計       | Yes, API v3 at `api-accounting.moneyforward.com` (OAuth 2.0 or API key; access by 会計 permissions) | Not in this release     |
| クラウド経費       | Yes ([expense API](https://expense.moneyforward.com/api/index.html))                                | Not in this release     |
| クラウド債務支払   | Yes ([payable API](https://payable.moneyforward.com/api/index.html))                                | Not in this release     |
| クラウド連結会計   | Listed under partner APIs (likely partner-only)                                                     | No                      |
| クラウド給与, 勤怠 | No public API found                                                                                 | No                      |

## What it reads

| Tool                       | API                  | Returns                                                                                                                                                                        |
| -------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mf_invoice_billings_list` | `GET /billings`      | id, number, title, partner, dates, total, payment and posting status; optional partner and date range (`range_key` billing_date, due_date, sales_date, created_at, updated_at) |
| `mf_invoice_billing_get`   | `GET /billings/{id}` | the billing, its items (name, quantity, unit, price) and memo                                                                                                                  |
| `mf_invoice_quotes_list`   | `GET /quotes`        | id, number, title, partner, dates, total                                                                                                                                       |
| `mf_invoice_partners_list` | `GET /partners`      | id, name, code; optional name or code filter                                                                                                                                   |

Paging: `per_page` at most 100 (the API's maximum), `page` at most 50. **Never read:** PDF
download URLs (`pdf_url` is never returned), the office's address and phone, partner departments
and contacts, sent-mail history. No write scope is requested, so no billing can be created,
changed or sent.

## Set up

1. On the developer portal, create an app with the redirect URI
   `http://localhost:<port>/callback` and the scope `mfc/invoice/data.read`. Note the client
   authentication method shown on the app's detail screen (`CLIENT_SECRET_BASIC` or
   `CLIENT_SECRET_POST`).
2. Configure:

```bash
kurahi plugins enable money-forward
kurahi secrets set connector.money-forward.clientSecret
kurahi config set plugins.entries.money-forward.config '{
  "clientId": "<client id>", "clientAuth": "basic", "redirectPort": 12345
}' --json
kurahi moneyforward status
kurahi moneyforward login
kurahi moneyforward probe
```

| Key             | Default | Meaning                                                      |
| --------------- | ------- | ------------------------------------------------------------ |
| `clientId`      | none    | App Client ID                                                |
| `clientAuth`    | `basic` | `basic` (CLIENT_SECRET_BASIC) or `post` (CLIENT_SECRET_POST) |
| `redirectPort`  | none    | Port of the registered redirect URI (required)               |
| `ratePerSecond` | 3       | Client-side request limit                                    |

## Data handling

- **Untrusted content.** Titles, item names, memo and partner names reach the model only inside
  the untrusted-content boundary.
- **Audit.** One row per call (`connector.money-forward.<operation>`): ids, counts, duration,
  error code. Never amounts, titles or names.
- **Tokens.** Access tokens last 1 hour; refresh tokens 540 days, single use (rotated on every
  refresh). The connector refreshes only when a token is about to expire (the token endpoint is
  rate limited).
- **Endpoints.** Only `api.biz.moneyforward.com` and `invoice.moneyforward.com`.

## Status and revocation

The gateway probes `GET /office`. `kurahi moneyforward logout` revokes the token at `/revoke`
(access and refresh token) and deletes it locally.

## Verified and not verified

Verified (2026-10-25): OAuth endpoints and lifetimes
([oauth overview](https://developers.biz.moneyforward.com/docs/common/oauth/overview)), client
authentication methods
([create-token](https://developers.biz.moneyforward.com/docs/api/auth/create-token)), revocation
([revoke-token](https://developers.biz.moneyforward.com/docs/api/auth/revoke-token)), scopes
([api guide](https://biz.moneyforward.com/support/invoice/guide/api-guide/a03.html)), paths,
parameters and response shapes
([iv_web_api.yaml](https://invoice.moneyforward.com/docs/api/v3/reference/iv_web_api.yaml)).

Not documented, implemented conservatively: PKCE (sent; ignored if unsupported), the exact
revocation parameter names (`token` plus client credentials, RFC 7009), read-endpoint rate limits
(only six write endpoints are documented at 3 requests per second; the connector stays at 3 per
second for everything).
