---
summary: "kintone business connector: read records of the kintone apps an administrator lists, limited to allow-listed field codes; API token or OAuth; optional approval-gated comments and record creation"
read_when:
  - You are connecting Kurahi to kintone (cybozu.com)
  - You need the API token or OAuth client setup and the permissions
  - You want to know what the connector reads, writes and records
title: "kintone"
---

# kintone connector

Also available in [Japanese](/ja/connectors/kintone).

The kintone connector lets Kurahi agents read records of the kintone apps an administrator lists,
and only the field codes listed for each app.

| Property       | Value                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Plugin id      | `kintone` (bundled, **off by default**)                                                           |
| Default access | Read-only: listed apps, listed field codes                                                        |
| Opt-in access  | Add a record comment (`write.comment`), create a record (`write.createRecord`); each one approved |
| Sign-in        | One API token per app (default), or an OAuth client (`auth: "oauth"`)                             |
| Token storage  | Kurahi secret store (`connector.kintone.token`), never the config file                            |
| Status         | Available                                                                                         |

## What it reads

- **Apps.** Only the apps in `apps`, by id. `kintone_apps_list` shows each app's name (Get App,
  `GET /k/v1/app.json`) and its allowed field codes.
- **Records.** `kintone_records_query` and `kintone_record_get` request only the app's allowed
  field codes (`fields[]`) plus `$id` and `$revision`, and the response is filtered to those codes
  again. Filters and ordering are structured (field, operator, value) and may use only allowed
  field codes, so an agent cannot filter on a field it may not read. String values are escaped as
  kintone requires (backslash before `"` and `\`). At most 100 records per call; `offset` stops at
  10,000 (kintone's limit).
- **Never read.** Apps that are not listed; fields that are not listed; file attachments (a file
  field shows only a count, never names or contents); table (subtable) rows (only a row count);
  comments; app settings beyond the app name.

## Writes always need a person

| Tool (opt-in)                                  | Needs                                                      | What it does                                          |
| ---------------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| `kintone_record_comment_add` (`write.comment`) | token with record view permission, or `k:app_record:write` | Add one plain-text comment (at most 2,000 characters) |
| `kintone_record_create` (`write.createRecord`) | token with "add records", or `k:app_record:write`          | Create one record with allowed fields only            |

Every call sends an approval request (app, record, the start of the text or the values) and is
refused unless a person approves before the timeout. A grant without the write permission is
refused before anyone is asked. kintone posts comments made with an API token as
"Administrator".

## Set up: API tokens (default)

1. In each app: **App settings > API token > Generate**. Tick only what you need:
   **View records** for reading; **Add records** only if `write.createRecord` is on. Save, then
   **Update app**.
2. Configure and sign in:

```bash
kurahi plugins enable kintone
kurahi config set plugins.entries.kintone.config '{
  "subdomain": "example",
  "apps": [{ "id": 12, "fields": ["顧客名", "ステータス", "担当者"] }]
}' --json
kurahi kintone status
kurahi kintone login            # one hidden prompt per app; or: printf '%s' "$TOKEN" | kurahi kintone login --stdin (one app)
kurahi kintone probe
```

Each request carries only the token of the app it is for (`X-Cybozu-API-Token`).

## Set up: OAuth client

1. In **cybozu.com common settings > System administration > OAuth**, add a client. The redirect
   endpoint is `http://localhost:<port>/callback` with the port you set as `redirectPort`.
2. Store the client secret and configure:

```bash
kurahi secrets set connector.kintone.clientSecret
kurahi config set plugins.entries.kintone.config '{
  "subdomain": "example", "auth": "oauth", "clientId": "<client id>", "redirectPort": 8765,
  "apps": [{ "id": 12, "fields": ["顧客名"] }]
}' --json
kurahi kintone login
```

Scopes requested: `k:app_record:read` and `k:app_settings:read` (app name), plus
`k:app_record:write` only with a write opt-in. The client authenticates with HTTP Basic, as
kintone requires.

| Key                      | Default      | Meaning                                              |
| ------------------------ | ------------ | ---------------------------------------------------- |
| `subdomain`              | none         | `example` for `https://example.cybozu.com`           |
| `domain`                 | `cybozu.com` | or `kintone.com`                                     |
| `apps`                   | none         | `[{ id, fields }]`: the apps and field codes allowed |
| `auth`                   | `apiToken`   | or `oauth`                                           |
| `write.comment`          | `false`      | `kintone_record_comment_add`                         |
| `write.createRecord`     | `false`      | `kintone_record_create`                              |
| `dailyRequestsPerApp`    | 10000        | Requests per app per day before the connector stops  |
| `ratePerSecond`          | 5            | Client-side request limit                            |
| `approvalTimeoutSeconds` | 120          | How long a write waits for a person                  |

## Data handling

- **Untrusted content.** Record values reach the model only inside the untrusted-content
  boundary; boundary markers inside values are neutralised.
- **Audit.** One row per call (`connector.kintone.<operation>`): agent, session, app and record
  ids, counts, duration, error code. Never field values, comment text or filters.
- **Limits.** kintone allows 100 concurrent requests per domain and 10,000 requests per app per
  day (Standard course). The connector rate limits itself, retries with backoff, and stops an app
  at `dailyRequestsPerApp` for the day (counted in the gateway process; a restart resets the
  count, kintone's own limit still applies).
- **Endpoints.** Only `https://<subdomain>.cybozu.com` (or `kintone.com`).

## Status and revocation

The gateway probes one record id of the first app at start and every `probeIntervalMinutes`; the
desktop catalogue shows **Active** only after a successful probe. `kurahi kintone logout` deletes
the stored tokens. kintone has no token revocation endpoint: delete the API token in the app
settings, or the OAuth client in common settings.

## References

Official kintone documentation on cybozu.dev: API token header and app-scoped use
([authentication](https://cybozu.dev/ja/kintone/docs/rest-api/overview/authentication/)); Get App
accepts API tokens, Get Apps does not
([get-app](https://cybozu.dev/ja/kintone/docs/rest-api/apps/get-app/),
[get-apps](https://cybozu.dev/ja/kintone/docs/rest-api/apps/get-apps/)); records limits
([get-records](https://cybozu.dev/ja/kintone/docs/rest-api/records/get-records/)); query syntax and
escaping ([query](https://cybozu.dev/ja/kintone/docs/overview/query/)); comment and record bodies
([add-comment](https://cybozu.dev/ja/kintone/docs/rest-api/records/add-comment/),
[add-record](https://cybozu.dev/ja/kintone/docs/rest-api/records/add-record/)); request limits
([overview](https://cybozu.dev/ja/kintone/docs/rest-api/overview/kintone-rest-api-overview/));
OAuth endpoints and scopes
([add-client](https://cybozu.dev/ja/common/docs/oauth-client/add-client/),
[scopes](https://cybozu.dev/ja/common/docs/oauth-client/scope-kintone/)).

Setup notes: OAuth sign-in sends PKCE (ignored where unsupported) and uses a `http://localhost`
redirect endpoint; if your environment does not accept one, use API tokens (the default). Kurahi
keeps the current refresh token when kintone does not return a new one. Guest space apps
(`/k/guest/<id>/v1`) are not supported in this release.
