---
summary: "Gmail business connector: list, search and read Google Workspace mail through the Gmail API; Google Cloud OAuth client setup, scopes, data handling, read-only default"
read_when:
  - You are connecting Kurahi to Gmail in a Google Workspace domain
  - You need the Google Cloud console steps and the exact scopes
  - You want to know what the connector reads, writes and records
title: "Gmail"
---

# Gmail connector

日本語: [Gmail コネクター](/ja/connectors/gmail)

The Gmail connector lets Kurahi agents list, search and read one mailbox through the Gmail API,
with an OAuth client the customer owns. It is separate from the Gmail Pub/Sub hook
(`kurahi webhooks gmail`), which pushes new-mail events into a session.

| Property       | Value                                                                |
| -------------- | -------------------------------------------------------------------- |
| Plugin id      | `gmail` (bundled, **off by default**)                                |
| Default access | Read-only: `gmail.readonly`                                          |
| Opt-in access  | Sending mail: `gmail.send`, every send approved by a person          |
| Sign-in        | Authorization code with PKCE on a loopback redirect (`127.0.0.1`)    |
| Token storage  | Kurahi secret store (`connector.gmail.token`), never the config file |
| Status         | Preview                                                              |

## What the administrator sets up in Google Cloud

1. In the Google Cloud console, create or pick a project owned by your organisation.
2. **APIs & Services > Library**: enable the **Gmail API**.
3. **APIs & Services > OAuth consent screen** (Google Auth Platform > Branding / Audience):
   user type **Internal**, so only accounts in your Workspace can sign in. Add the scopes below
   under **Data access**.
4. **APIs & Services > Credentials > Create credentials > OAuth client ID**: application type
   **Desktop app**. Copy the client ID and the client secret. Google issues a secret for desktop
   clients but documents it as not confidential; Kurahi still keeps it in the secret store.
5. Optional, for a Workspace-wide rollout: in the Google Admin console, **Security > Access and
   data control > API controls**, mark the app as trusted.

| Feature (config)    | Scope                                            | Access    |
| ------------------- | ------------------------------------------------ | --------- |
| Always              | `https://www.googleapis.com/auth/gmail.readonly` | Read      |
| Send (`write.send`) | `https://www.googleapis.com/auth/gmail.send`     | **Write** |

`gmail.readonly` is a restricted scope. An **Internal** app used only inside your own Workspace
does not need Google's app verification; an external app does.

## Configure Kurahi

```bash
kurahi plugins enable gmail
kurahi secrets set connector.gmail.clientSecret        # paste the client secret
kurahi config set plugins.entries.gmail.config '{
  "clientId": "<number>-<id>.apps.googleusercontent.com",
  "allowedDomain": "example.co.jp"
}' --json
kurahi gmail status
kurahi gmail login
kurahi gmail probe
```

Google's device code flow does not allow Gmail scopes, so sign-in needs a browser that can reach
the machine running Kurahi. On a server, fix the port and forward it: set `redirectPort` (for
example 8765), run `ssh -L 8765:127.0.0.1:8765 <server>`, then `kurahi gmail login` on the server
and open the printed address on your own computer.

| Key                      | Default | Meaning                                                                 |
| ------------------------ | ------- | ----------------------------------------------------------------------- |
| `clientId`               | none    | OAuth client ID (Desktop app)                                           |
| `allowedDomain`          | none    | Workspace domain the mailbox must belong to; other sign-ins are refused |
| `write.send`             | `false` | `gmail_send`                                                            |
| `redirectPort`           | random  | Fixed loopback port                                                     |
| `probeIntervalMinutes`   | 15      | Health probe interval                                                   |
| `ratePerSecond`          | 8       | Client-side request limit toward the Gmail API                          |
| `approvalTimeoutSeconds` | 120     | How long a send waits for a person                                      |

`allowedDomain` is checked after sign-in against the mailbox's own address, not only hinted to
the account picker.

## Tools

| Tool                  | Needs                   | What it does                                                       |
| --------------------- | ----------------------- | ------------------------------------------------------------------ |
| `gmail_list`          | `gmail.readonly`        | Recent messages with a label (default `INBOX`)                     |
| `gmail_search`        | `gmail.readonly`        | Gmail search syntax, e.g. `from:billing@example.com newer_than:7d` |
| `gmail_read`          | `gmail.readonly`        | One message as plain text (HTML-only mail is converted)            |
| `gmail_send` (opt-in) | `gmail.send` + approval | Send a plain-text message                                          |

## Writes always need a person

`gmail_send` exists only with `write.send` and a sign-in that granted `gmail.send`. Every call
sends an approval request (recipients, subject, start of the body) and is refused unless a person
approves it before the timeout. Subjects and addresses are sanitised so no extra header can be
injected.

## Data handling

- **Untrusted content.** Bodies, subjects, senders and snippets reach the model only inside the
  untrusted-content boundary; boundary markers inside the mail are neutralised.
- **Audit.** One row per call (`connector.gmail.<operation>`): agent, session, message ids,
  counts, sizes, duration, error code. Never subjects, bodies, addresses or search text.
- **Tokens.** Stored in the Kurahi secret store; refreshed before expiry.
- **Limits.** Client-side rate limit, retries with backoff, `Retry-After` honoured (longer than
  60 seconds fails with `rate_limited`). Lists fetch at most 25 messages.
- **Endpoints.** Only `accounts.google.com`, `oauth2.googleapis.com` and `gmail.googleapis.com`.

## Status and revocation

The gateway probes `users/me/profile` at start and every `probeIntervalMinutes`; the desktop
catalogue shows **Active** only after a successful probe within 25 hours.
`kurahi gmail logout` revokes the refresh token at Google and deletes the stored tokens. An
administrator can also remove the app's access in the Google Admin console.

## Limits of this release

- One mailbox per gateway; no domain-wide delegation (service account) mode.
- Attachments are counted but not downloaded.
