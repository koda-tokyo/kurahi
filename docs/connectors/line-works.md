---
summary: "LINE WORKS business connector: one bot authenticated as the app's service account; channel information and members (no message history API exists); approval-gated text messages to configured channels and users"
read_when:
  - You are connecting Kurahi to LINE WORKS
  - You need the Developer Console setup (service account, private key, bot)
  - You want to know why the connector cannot read messages
title: "LINE WORKS"
---

# LINE WORKS connector

日本語: [LINE WORKS コネクター](/ja/connectors/line-works)

| Property       | Value                                                                                    |
| -------------- | ---------------------------------------------------------------------------------------- |
| Plugin id      | `line-works` (bundled, **off by default**), CLI `kurahi lineworks`                       |
| Default access | Read-only: information and members of the configured channels (`bot.read`)               |
| Opt-in access  | Send a text message to a configured channel or user (`bot.message`), every send approved |
| Sign-in        | Service account: a JWT (RS256) signed with the app's private key, exchanged for a token  |
| Secrets        | `connector.line-works.privateKey`, `connector.line-works.clientSecret`, cached token     |
| Status         | Built and tested against recorded responses; **not yet verified on a live domain**       |

## Reading messages is not possible

LINE WORKS API 2.0 has no endpoint that lists or reads message history. A bot receives messages
only as events posted to its callback URL (HTTPS, signed with the bot secret). This connector does
not host a callback endpoint, so it reads **no messages**. What it can read is channel
information (title, type) and channel members.

## Tools

| Tool                                    | Needs                    | What it does                                                                |
| --------------------------------------- | ------------------------ | --------------------------------------------------------------------------- |
| `lineworks_channel_get`                 | `bot.read`               | Title and type of one configured channel                                    |
| `lineworks_channel_members`             | `bot.read`               | Member user ids (at most 100 per call, cursor paging)                       |
| `lineworks_message_send` (`write.send`) | `bot.message` + approval | One text message (at most 2,000 characters) to a configured channel or user |

Only the channels in `channels` and the users in `users` can be addressed; others are refused
before any request. Every send asks a person (target, length, start of the text) and is refused
unless approved before the timeout; a grant without `bot.message` is refused before anyone is
asked. Standing (autopilot) approvals are **not** supported for this connector: the standing-send
path is built around mail recipients, so every LINE WORKS message needs a person.

## Set up

1. In the LINE WORKS Developer Console, create an app. Issue a **Service Account** and download
   its **Private Key**. Add the OAuth scopes `bot.read` (and `bot.message` for sending). Note the
   Client ID and Client Secret.
2. Register a bot, add it to the channels it should use, and note the Bot ID and channel ids.
3. Configure:

```bash
kurahi plugins enable line-works
kurahi secrets set connector.line-works.privateKey --stdin < private_key.key
kurahi secrets set connector.line-works.clientSecret
kurahi config set plugins.entries.line-works.config '{
  "clientId": "<client id>", "serviceAccount": "<id>.serviceaccount@<domain>",
  "botId": "<bot id>", "channels": ["<channel id>"], "users": []
}' --json
kurahi lineworks status
kurahi lineworks login      # mints one token with the stored key: proves key, secret and scopes
kurahi lineworks probe
```

| Key                      | Default | Meaning                                              |
| ------------------------ | ------- | ---------------------------------------------------- |
| `clientId`               | none    | App Client ID                                        |
| `serviceAccount`         | none    | Service account id                                   |
| `botId`                  | none    | The bot                                              |
| `channels`, `users`      | none    | The only targets the bot may read or message         |
| `write.send`             | `false` | `lineworks_message_send`                             |
| `ratePerSecond`          | 1       | Client-side request limit (Free plan: 60 per minute) |
| `approvalTimeoutSeconds` | 120     | How long a send waits for a person                   |

## Data handling

- **Untrusted content.** Channel titles and member ids reach the model only inside the
  untrusted-content boundary.
- **Audit.** One row per call (`connector.line-works.<operation>`): channel or user ids, counts,
  duration, error code. Never message text; ids that are e-mail addresses are dropped from the
  audit row.
- **Tokens.** The JWT is valid for at most 60 minutes and is used once; the access token (1 or 24
  hours, as set in the Developer Console) is cached in the secret store and minted again shortly
  before it expires. No refresh token is kept.
- **Limits.** 60 requests per minute per API on the Free plan, 240 on Standard and Advanced, at
  most 5 in parallel; the connector stays at 1 per second by default.
- **Endpoints.** Only `auth.worksmobile.com` and `www.worksapis.com`.

## Status and revocation

The gateway probes the first configured channel (or `GET /bots`). `kurahi lineworks logout`
deletes the cached token; to cut access, regenerate or delete the private key or client secret in
the Developer Console.

## Verified and not verified

Verified (2026-10-25): JWT claims, token endpoint, lifetimes and service-account scope limits
([auth-jwt](https://developers.worksmobile.com/jp/docs/auth-jwt)); send endpoints
([user](https://developers.worksmobile.com/jp/docs/bot-user-message-send),
[channel](https://developers.worksmobile.com/jp/docs/bot-channel-message-send)); text limit
([bot-send-text](https://developers.worksmobile.com/jp/docs/bot-send-text)); channel endpoints
([get](https://developers.worksmobile.com/jp/docs/bot-channel-get),
[members](https://developers.worksmobile.com/jp/docs/bot-channel-member-list)); no history API
([bot-api](https://developers.worksmobile.com/jp/docs/bot-api),
[callback](https://developers.worksmobile.com/jp/docs/bot-callback)); rate limits
([rate-limits](https://developers.worksmobile.com/jp/docs/rate-limits)).

Not verified: whether `bot.read` alone is enough for the channel endpoints (the docs list
`bot`, `bot.message` and `bot.read`); the error body shape other than for 429.
