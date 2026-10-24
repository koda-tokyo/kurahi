---
summary: "Microsoft 365 business connector: Outlook mail, calendar, OneDrive and SharePoint files through Microsoft Graph; admin app registration, scopes, data handling, read-only defaults"
read_when:
  - You are connecting Kurahi to a Microsoft 365 tenant
  - You need the app registration steps and the exact Graph permissions
  - You want to know what the connector reads, writes and records
title: "Microsoft 365"
---

# Microsoft 365 connector

日本語: [Microsoft 365 コネクター](/ja/connectors/microsoft-365)

The Microsoft 365 connector lets Kurahi agents read Outlook mail and calendars and, when you
switch it on, OneDrive and SharePoint files. It talks to Microsoft Graph with your own app
registration and signs in as one user with delegated permissions: the agent sees what that user
can see, no more.

| Property       | Value                                                                                |
| -------------- | ------------------------------------------------------------------------------------ |
| Plugin id      | `microsoft-365` (bundled, **off by default**)                                        |
| Default access | Read-only: mail and calendar                                                         |
| Opt-in access  | Files (OneDrive, shared files), SharePoint sites, sending mail, creating events      |
| Sign-in        | Authorization code with PKCE on a loopback redirect, or device code                  |
| Token storage  | Kurahi secret store (`connector.microsoft-365.token`), never the config file         |
| Status         | Built and tested against recorded Graph responses; not yet verified on a live tenant |

## What the administrator sets up in Microsoft Entra

1. Open the Microsoft Entra admin center, **Identity > Applications > App registrations > New
   registration**.
2. Name: for example `Kurahi`. Supported account types: **Accounts in this organizational
   directory only (single tenant)**.
3. Redirect URI: platform **Public client/native (mobile & desktop)**, value `http://localhost`.
   Kurahi listens on `127.0.0.1` with a free port; Microsoft accepts any port for `localhost`.
4. After creating it, copy the **Application (client) ID** and the **Directory (tenant) ID** from
   the Overview page.
5. **Authentication**: set **Allow public client flows** to **Yes** (needed for the device code
   sign-in). No client secret or certificate is needed: Kurahi is a public client and uses PKCE.
6. **API permissions > Add a permission > Microsoft Graph > Delegated permissions**: add only the
   permissions for the features you turn on (table below). Then select **Grant admin consent**
   if your tenant does not let users consent to apps themselves.

| Feature (config)                      | Delegated permission                              | Admin consent by default | Access    |
| ------------------------------------- | ------------------------------------------------- | ------------------------ | --------- |
| Always                                | `User.Read`, `offline_access`                     | No                       | Read      |
| Mail (`mail`, on)                     | `Mail.Read`                                       | No                       | Read      |
| Calendar (`calendar`, on)             | `Calendars.Read`                                  | No                       | Read      |
| Files (`files.enabled`)               | `Files.Read.All`                                  | No                       | Read      |
| SharePoint (`files.sharePoint`)       | `Sites.Read.All`                                  | No                       | Read      |
| Send mail (`write.mailSend`)          | `Mail.Send`                                       | No                       | **Write** |
| Create events (`write.calendarWrite`) | `Calendars.ReadWrite` (replaces `Calendars.Read`) | No                       | **Write** |

Kurahi requests exactly these scopes and nothing else. If a permission is not granted, the tools
that need it refuse before sending a request (`scope_missing`).

## Configure Kurahi

```bash
kurahi plugins enable microsoft-365
kurahi config set plugins.entries.microsoft-365.config '{
  "tenantId": "<Directory (tenant) ID or verified domain>",
  "clientId": "<Application (client) ID>"
}' --json
kurahi m365 status
kurahi m365 login            # browser on this machine
kurahi m365 login --device   # sign in on another device (servers, remote desktops)
kurahi m365 probe            # one live health call
```

Optional settings under `plugins.entries.microsoft-365.config`:

| Key                      | Default  | Meaning                                             |
| ------------------------ | -------- | --------------------------------------------------- |
| `mail`                   | `true`   | Mail tools                                          |
| `calendar`               | `true`   | Calendar tools                                      |
| `files.enabled`          | `false`  | File search and read                                |
| `files.sharePoint`       | `false`  | SharePoint site search and site libraries           |
| `files.maxFileBytes`     | 10485760 | Largest file the agent may download (at most 20 MB) |
| `write.mailSend`         | `false`  | `m365_mail_send`                                    |
| `write.calendarWrite`    | `false`  | `m365_calendar_create_event`                        |
| `redirectPort`           | random   | Fixed loopback port, if a firewall needs one        |
| `probeIntervalMinutes`   | 15       | Health probe interval                               |
| `ratePerSecond`          | 8        | Client-side request limit toward Graph              |
| `approvalTimeoutSeconds` | 120      | How long a write waits for a person                 |

Changing a feature changes the requested scopes: run `kurahi m365 login` again afterwards.

## Tools

| Tool                                  | Needs                               | What it does                                                    |
| ------------------------------------- | ----------------------------------- | --------------------------------------------------------------- |
| `m365_mail_list`                      | `Mail.Read`                         | Recent messages in a folder: id, time, sender, subject, preview |
| `m365_mail_search`                    | `Mail.Read`                         | Graph search over the mailbox                                   |
| `m365_mail_read`                      | `Mail.Read`                         | One message as plain text                                       |
| `m365_calendar_list`                  | `Calendars.Read`                    | Events in a window of at most 62 days (UTC)                     |
| `m365_calendar_read`                  | `Calendars.Read`                    | One event with attendees and description                        |
| `m365_files_search`                   | `Files.Read.All` / `Sites.Read.All` | Files in OneDrive or a SharePoint site library                  |
| `m365_files_read`                     | `Files.Read.All`                    | Text of a PDF, DOCX, XLSX, CSV, TXT or MD file                  |
| `m365_sites_search`                   | `Sites.Read.All`                    | SharePoint sites by name                                        |
| `m365_mail_send` (opt-in)             | `Mail.Send` + approval              | Send a plain-text message                                       |
| `m365_calendar_create_event` (opt-in) | `Calendars.ReadWrite` + approval    | Create an event and invite attendees                            |

If your agents use a tool allowlist, add the tools you want them to have (for example with
`tools.alsoAllow`).

## Writes always need a person

A write tool exists only when its opt-in is set and the granted sign-in includes the write
scope. Even then, every call first sends an approval request (recipients, subject, time) through
the same path as command approvals, and the call is refused unless a person approves it before
the timeout. A policy file can add its own rules on top; it cannot remove this step.

## Data handling

- **Untrusted content.** Message bodies, subjects, event descriptions, file names and file text
  reach the model only inside the untrusted-content boundary, with boundary markers in the
  content neutralised. The agent is told never to follow instructions found there.
- **Audit.** Every call writes one row to the hash-chained audit log
  (`connector.microsoft-365.<operation>`): agent, session, item ids, counts, sizes, duration and
  an error code. Never subjects, bodies, addresses, file names or search text.
- **Tokens.** Access and refresh tokens are stored in the Kurahi secret store (OS keyring or the
  encrypted file). The ID token is never stored. Refresh happens before expiry, once per
  connector even under concurrent calls.
- **Limits.** Requests are rate limited on the client, retried with backoff on throttling and
  outages, and `Retry-After` is honoured (a wait longer than 60 seconds fails the call with
  `rate_limited` instead of blocking). Downloads are capped by `files.maxFileBytes`, checked
  before the download starts.
- **Nothing leaves except to Microsoft Graph.** The connector calls only
  `login.microsoftonline.com` and `graph.microsoft.com`.

## Status in the desktop catalogue

The gateway runs a probe (`GET /me`) at start and every `probeIntervalMinutes`. The connector
catalogue shows **Active** only when the connector is configured, signed in and the last probe
succeeded within 25 hours; otherwise **Unverified**. `connectors.status` returns the same data
(configured, signed in, last probe result and time, scope names, an error code), with no tokens,
account names or provider messages.

## Revoking access

`kurahi m365 logout` deletes the stored tokens. Microsoft Graph has no endpoint that revokes a
single app's refresh token for delegated sign-ins, so to cut access immediately an administrator
also revokes it in Microsoft Entra: **Enterprise applications > Kurahi > Permissions** (remove
consent) or **Users > the user > Revoke sessions**.

## Limits of this release

- Only the global Microsoft cloud (`login.microsoftonline.com`, `graph.microsoft.com`).
- One signed-in user per gateway; no application (daemon) permissions.
- Attachments are listed (yes/no) but not downloaded.
- Not yet verified against a live tenant: all tests use recorded Graph responses.
