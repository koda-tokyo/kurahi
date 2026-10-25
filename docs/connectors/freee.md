---
summary: "freee 会計 business connector: read companies, deals, partners, account items and receipt metadata through the freee API; read-only (the deals API has no draft state, so there is no write tool)"
read_when:
  - You are connecting Kurahi to freee 会計
  - You need the freee app setup and permissions
  - You want to know why the connector cannot create deals
title: "freee 会計"
---

# freee 会計 connector

日本語: [freee 会計 コネクター](/ja/connectors/freee)

The freee connector lets Kurahi agents read accounting data of the freee companies (事業所) an
administrator lists, through the freee API with a freee app the customer owns.

| Property      | Value                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| Plugin id     | `freee` (bundled, **off by default**)                                                  |
| Access        | **Read-only, always.** No write tool exists                                            |
| Sign-in       | OAuth 2.0 authorization code on a loopback redirect; client secret in the secret store |
| Token storage | Kurahi secret store (`connector.freee.token`)                                          |
| Status        | Built and tested against recorded freee API responses; **not yet verified live**       |

## Why there is no write tool

The task for this connector allowed creating a deal **only as a draft**. freee's `POST /deals`
has no draft or approval field: `status` (`unsettled` / `settled`) is the payment state, so a
created deal always affects the books. Drafts exist only for 各種申請, 経費申請 and 支払依頼
(`draft: true` on `POST /approval_requests`, `/expense_applications`, `/payment_requests`), which
are workflow requests, not deals. So this release has no write tool at all.

## What it reads

| Tool                       | API                  | Returns                                                                                                                         |
| -------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `freee_companies_list`     | `GET /companies`     | id, name, role, only for the configured companies                                                                               |
| `freee_deals_list`         | `GET /deals`         | id, type, dates, amounts, payment status, partner id, line count; filters: type, status, partner, issue-date range; at most 100 |
| `freee_deal_get`           | `GET /deals/{id}`    | the deal and its lines (account item, tax code, amount, description)                                                            |
| `freee_partners_list`      | `GET /partners`      | id, code, name, long name; at most 100                                                                                          |
| `freee_account_items_list` | `GET /account_items` | id, name, category (up to 500 listed)                                                                                           |
| `freee_receipts_list`      | `GET /receipts`      | metadata: id, status, issue date, file type, description; at most 100                                                           |

**Never read:** companies that are not listed; receipt files (no download; the file URL is never
returned); partner bank accounts, addresses and contacts; users; payroll (freee 人事労務 is a
separate product and not covered).

## Set up

1. In the freee app store developer console, create an app. Give it **read** permissions only for
   the resources above (取引, 取引先, 勘定科目, 証憑/ファイルボックス, 事業所). Set the callback URL to
   `http://localhost:<port>/callback`.
2. Configure:

```bash
kurahi plugins enable freee
kurahi secrets set connector.freee.clientSecret
kurahi config set plugins.entries.freee.config '{
  "clientId": "<client id>", "companyIds": [1234567], "redirectPort": 8765
}' --json
kurahi freee status
kurahi freee login
kurahi freee probe
```

freee takes no `scope` parameter: permissions are chosen on the app and confirmed at consent; the
token reports them as `read` / `write`. Every tool needs `read`.

| Key                    | Default | Meaning                                          |
| ---------------------- | ------- | ------------------------------------------------ |
| `clientId`             | none    | freee app Client ID                              |
| `companyIds`           | none    | Companies the agent may read; others are refused |
| `redirectPort`         | none    | Port of the registered callback URL (required)   |
| `ratePerSecond`        | 3       | Client-side request limit                        |
| `probeIntervalMinutes` | 60      | Health probe interval                            |

## Data handling

- **Untrusted content.** Descriptions, names and other customer text reach the model only inside
  the untrusted-content boundary.
- **Audit.** One row per call (`connector.freee.<operation>`): ids, counts, duration, error code.
  Never amounts, descriptions or names.
- **Limits.** freee counts calls per company per app per day (3,000 to 10,000 by plan) and answers
  403 to bursts for about 10 minutes. The connector rate limits itself (3/s by default) and
  retries with backoff. Access tokens last 6 hours; refresh tokens are single use and rotated on
  every refresh.
- **Endpoints.** Only `accounts.secure.freee.co.jp` and `api.freee.co.jp`.

## Status and revocation

The gateway probes `GET /companies`. `kurahi freee logout` revokes the token at
`/public_api/revoke` and deletes it locally.

## Verified and not verified

Verified (2026-10-25): endpoints and client secret
([getting-access-token](https://developer.freee.co.jp/startguide/getting-access-token)), revoke
([reference](https://developer.freee.co.jp/reference/%e8%aa%8d%e5%8f%af%e3%82%b3%e3%83%bc%e3%83%89)),
token lifetimes ([token_lifetime](https://developer.freee.co.jp/reference/faq/token_lifetime)),
paths, parameters, limits and the absence of a draft field
([api-schema.json](https://raw.githubusercontent.com/freee/freee-api-schema/master/v2020_06_15/open-api-3/api-schema.json)).

Not documented by freee, implemented conservatively: PKCE (sent; ignored if unsupported), whether
a `http://localhost` callback URL is accepted (freee documents `urn:ietf:wg:oauth:2.0:oob` for
local testing and HTTPS URLs otherwise; if your app cannot register a localhost callback, sign-in
does not work in this release), whether revocation needs the client credentials (they are sent).
