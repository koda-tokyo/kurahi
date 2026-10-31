---
summary: "Microsoft 365 business connector: Outlook mail, calendar, OneDrive and SharePoint files through Microsoft Graph; admin app registration, scopes, data handling, read-only defaults"
read_when:
  - You are connecting Kurahi to a Microsoft 365 tenant
  - You need the app registration steps and the exact Graph permissions
  - You want to know what the connector reads, writes and records
title: "Microsoft 365"
---

# Microsoft 365 connector

Also available in [Japanese](/ja/connectors/microsoft-365).

The Microsoft 365 connector lets Kurahi agents read Outlook mail and calendars and, when you
switch it on, OneDrive and SharePoint files. It talks to Microsoft Graph with your own app
registration and signs in as one user with delegated permissions: the agent sees what that user
can see, no more.

| Property       | Value                                                                            |
| -------------- | -------------------------------------------------------------------------------- |
| Plugin id      | `microsoft-365` (bundled, **off by default**)                                    |
| Default access | Read-only: mail and calendar                                                     |
| Opt-in access  | Files, SharePoint sites, sending mail, drafts, events, uploads to the app folder |
| Sign-in        | Authorization code with PKCE on a loopback redirect, or device code              |
| Token storage  | Kurahi secret store (`connector.microsoft-365.token`), never the config file     |
| Status         | Available                                                                        |

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

| Feature (config)                      | Delegated permission                              | Admin consent by default | Access                                       |
| ------------------------------------- | ------------------------------------------------- | ------------------------ | -------------------------------------------- |
| Always                                | `User.Read`, `offline_access`                     | No                       | Read                                         |
| Mail (`mail`, on)                     | `Mail.Read`                                       | No                       | Read                                         |
| Calendar (`calendar`, on)             | `Calendars.Read`                                  | No                       | Read                                         |
| Files (`files.enabled`)               | `Files.Read.All`                                  | No                       | Read                                         |
| SharePoint (`files.sharePoint`)       | `Sites.Read.All`                                  | No                       | Read                                         |
| Send mail (`write.mailSend`)          | `Mail.Send`                                       | No                       | **Write**                                    |
| Draft mail (`write.mailDraft`)        | `Mail.ReadWrite` (replaces `Mail.Read`)           | No                       | **Write** (creates drafts only, never sends) |
| Attach to draft (`write.mailDraft`)   | `Mail.ReadWrite` (the same grant as drafts)       | No                       | **Write** (drafts only)                      |
| Create events (`write.calendarWrite`) | `Calendars.ReadWrite` (replaces `Calendars.Read`) | No                       | **Write**                                    |
| Upload to app folder (`write.files`)  | `Files.ReadWrite.AppFolder`                       | No                       | **Write** (the app folder only)              |

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

| Key                       | Default  | Meaning                                                |
| ------------------------- | -------- | ------------------------------------------------------ |
| `mail`                    | `true`   | Mail tools                                             |
| `calendar`                | `true`   | Calendar tools                                         |
| `files.enabled`           | `false`  | File search and read                                   |
| `files.sharePoint`        | `false`  | SharePoint site search and site libraries              |
| `files.maxFileBytes`      | 10485760 | Largest file the agent may download (at most 20 MB)    |
| `write.mailSend`          | `false`  | `m365_mail_send`                                       |
| `write.mailDraft`         | `false`  | `m365_mail_create_draft`, `m365_mail_attach_to_draft`  |
| `write.calendarWrite`     | `false`  | `m365_calendar_create_event`                           |
| `write.files`             | `false`  | `m365_files_upload`                                    |
| `redirectPort`            | random   | Fixed loopback port, if a firewall needs one           |
| `probeIntervalMinutes`    | 15       | Health probe interval                                  |
| `ratePerSecond`           | 8        | Client-side request limit toward Graph                 |
| `approvalTimeoutSeconds`  | 120      | How long a write waits for a person                    |
| `mailWatch.pollSeconds`   | 60       | Autopilot mail trigger delta poll (30 to 600 seconds)  |
| `notifications.publicUrl` | none     | Optional https base URL for Graph change notifications |

Changing a feature changes the requested scopes: run `kurahi m365 login` again afterwards.

## Tools

| Tool                                  | Needs                               | What it does                                                                                                                                      |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `m365_mail_list`                      | `Mail.Read`                         | Recent messages in a folder: id, time, sender, subject, preview                                                                                   |
| `m365_mail_search`                    | `Mail.Read`                         | Graph search over the mailbox                                                                                                                     |
| `m365_mail_read`                      | `Mail.Read`                         | One message as plain text; attachments as id, name, size and type only                                                                            |
| `m365_mail_attachment_fetch`          | `Mail.Read`                         | One file attachment (at most 20 MB) into the Project after quarantine, policy and malware scan ([Attachment intake](/security/attachment-intake)) |
| `m365_calendar_list`                  | `Calendars.Read`                    | Events in a window of at most 62 days (UTC)                                                                                                       |
| `m365_calendar_read`                  | `Calendars.Read`                    | One event with attendees and description                                                                                                          |
| `m365_files_search`                   | `Files.Read.All` / `Sites.Read.All` | Files in OneDrive or a SharePoint site library                                                                                                    |
| `m365_files_read`                     | `Files.Read.All`                    | Text of a PDF, DOCX, XLSX, CSV, TXT or MD file                                                                                                    |
| `m365_sites_search`                   | `Sites.Read.All`                    | SharePoint sites by name                                                                                                                          |
| `m365_mail_send` (opt-in)             | `Mail.Send` + approval              | Send a plain-text message                                                                                                                         |
| `m365_mail_create_draft` (opt-in)     | `Mail.ReadWrite`                    | Create a plain-text draft or draft reply in Drafts; never sends                                                                                   |
| `m365_mail_attach_to_draft` (opt-in)  | `Mail.ReadWrite`                    | Attach a Project file (at most 3 MB) to a draft; never sends                                                                                      |
| `m365_calendar_create_event` (opt-in) | `Calendars.ReadWrite` + approval    | Create an event and invite attendees                                                                                                              |
| `m365_files_upload` (opt-in)          | `Files.ReadWrite.AppFolder`         | Upload a Project file (at most 4 MB) to the OneDrive app folder                                                                                   |

If your agents use a tool allowlist, add the tools you want them to have (for example with
`tools.alsoAllow`).

## Writes always need a person

A write tool exists only when its opt-in is set and the granted sign-in includes the write
scope. Even then, every call first sends an approval request (recipients, subject, time) through
the same path as command approvals, and the call is refused unless a person approves it before
the timeout. A policy file can add its own rules on top; it cannot remove this step. The one
exception is below.

## Sending under a standing approval

`m365_mail_send` skips the person approval for exactly one kind of call: an autopilot **engine**
call for an L3 routine (see [Autopilot](/autopilot#l3-sends)). The connector checks, at send
time and by itself:

- the call runs under the engine's invocation context, which only the engine sets; it is not a
  tool argument, so no model or agent session can ask for it (an `approvalId` or similar argument
  is simply not part of the tool);
- the context is for `m365_mail_send` and the routine's own Project session, and has not sent yet
  (one send per engine call);
- the standing approval it names verifies from the autopilot store: active (not expired, not
  revoked), for this routine and `mail.send`, the routine enabled, L3 and listing `mail.send`;
  every recipient in `to` and `cc` covered by the scope's addresses or domains; the template in
  the scope; and a use left in `maxPerDay`, taken atomically.

Then it sends without the interactive ask; the result and the audit row name the approval id,
and the use is audited as `autopilot.approval.use`. Anything else (an agent session, a mismatch,
an expired, revoked or out-of-scope approval, the daily maximum reached) falls back to asking a
person exactly as above, and is refused when nobody approves.

## Drafts stay in the mailbox

`write.mailDraft` adds `m365_mail_create_draft`. It creates a draft only; a person reviews and
sends it from Outlook. With `replyToMessageId` it calls `createReply` on that message and then
sets the plain-text body, recipients and subject on the new draft (this replaces the quoted
original); otherwise it creates a new message in Drafts. The body is always plain text (at most
64 KiB) and recipients are checked like `m365_mail_send` (1 to 20 in `to`, up to 20 in `cc`).
Because nothing leaves the mailbox there is no approval step. The tool never calls `send`; to
send, an administrator still has to opt in to `write.mailSend`, which keeps its approval. The
audit row records the draft id, the replied-to message id, the recipient count and the body
size, never the subject, body or addresses.

`Mail.ReadWrite` replaces `Mail.Read` in the sign-in request; the read tools accept either. It
also allows changing and deleting messages, so only grant it when drafts are wanted: Kurahi uses
it only to create and edit its own drafts.

The same opt-in adds `m365_mail_attach_to_draft`: it attaches one file from the current Project
folder to a draft. It reads the message first and refuses anything that is not a draft, so a sent
or received message is never changed. Files go in one request (at most 3 MB; larger files are
refused, there are no upload sessions in this release). There is no approval step, for the same
reason as drafts.

## Files stay in the app folder; sharing is a person's action

`write.files` adds `m365_files_upload`. It uploads one file from the current Project folder to the
signed-in user's OneDrive **app folder** (Graph `special/approot`, shown in OneDrive as
**Apps > (your app registration name)**), in one request of at most 4 MB. A file with the same
name is not overwritten: OneDrive gives the upload a new name. It returns the item id and its
OneDrive link (`https` only).

The permission is `Files.ReadWrite.AppFolder`, the least privilege Graph offers for writing: it
reaches that one folder and nothing else in the user's OneDrive, and gives no access to other
users' files or to SharePoint. The tool never creates sharing links or invitations. Sharing a file
with anyone is a person's action in OneDrive.

Both file tools (attach and upload) send only files inside the current Project folder, and only
in a Project chat. They refuse paths that leave the folder (`../`, an absolute path elsewhere, a
symbolic link pointing outside), excluded folders such as `_answer-keys`, and anything that is not
a regular file. Accepted types are the ones Projects accept for upload (PDF, DOCX, XLSX, CSV, TXT,
MD and common images) plus PPTX; the content must match the extension. The audit row records the
item ids, the byte count and the document kind (for example `pdf`), never the file name, path or
content.

## Autopilot mail triggers

A routine with `trigger.event: [{ source: m365.mail, folder: inbox }]`
([Triggers](/autopilot#triggers)) runs within seconds of new mail. An on-premise gateway usually
cannot receive webhooks, so the default is **Graph delta queries**:

- **One watcher per sign-in.** The connector runs one watcher for its sign-in and polls every
  subscribed Project folder every `mailWatch.pollSeconds` (default 60 s) with
  `GET /me/mailFolders/{folder}/messages/delta?$select=id,receivedDateTime`, through the same
  rate limiter, retries and token refresh as every tool. It needs only `Mail.Read` (or
  `Mail.ReadWrite`), which the mail tools already request. Nothing polls while no routine
  subscribes.
- **Only a signal.** The watcher tells the routine "new mail arrived" (a count). Ids, senders,
  subjects and bodies are not passed on or stored; the routine's own gather reads the mail
  through `m365_mail_list` / `m365_mail_read` as on any run.
- **What is stored.** Only the delta link (the Graph URL with its `$deltatoken`), per Project
  folder, in `<KOLO_HOME>/projects/<id>/autopilot/triggers/` (mode 0600). A stored link that is
  not a `graph.microsoft.com` URL is discarded, so the access token is only ever sent to Graph.
- **First sync.** The first poll of a folder records the delta link without signalling: mail
  already in the folder is not new.
- **Resync.** When Graph answers `410 Gone` (the delta token expired), the link is dropped, the
  folder is synced afresh and the routine is signalled once so it checks the folder itself.
- **Throttling.** A short `Retry-After` is waited out by the connector; a longer one, or repeated
  failures, back the watcher off exponentially (up to 15 minutes). The trigger shows `degraded`
  with `rate_limited` meanwhile.
- **Sign-in expired.** `reauth_required` (or a missing sign-in or permission) marks the trigger
  `degraded` in `autopilot.routines.list`; the watcher does not retry until the stored sign-in
  changes (`kurahi m365 login`). The routine's safety schedule keeps running meanwhile.

### Optional change notifications

When the gateway is reachable from the internet over https, set
`notifications.publicUrl` (for example `https://kurahi.example.com`). The watcher then also
creates a Graph subscription per folder (`changeType: created`, notification URL
`<publicUrl>/plugins/microsoft-365/notifications`, a random `clientState` held in memory only) and
renews it before it expires. The route answers Graph's validation handshake by echoing
`validationToken` as `text/plain`, and accepts a notification only for a known subscription id
with its exact `clientState`; a notification only makes the watcher run a delta query for that
folder now, its content is not used. Delta polling stays on as the default and the fallback: a
subscription that cannot be created or renewed changes nothing else. The value must be an https
URL without credentials or query; otherwise notifications stay off and a warning is logged.

## Data handling

- **Untrusted content.** Message bodies, subjects, event descriptions, file names and file text
  reach the model only inside the untrusted-content boundary, with boundary markers in the
  content neutralised. The agent is told never to follow instructions found there.
- **Audit.** Every call writes one row to the hash-chained audit log
  (`connector.microsoft-365.<operation>`): agent, session, item ids, counts, sizes, the document
  kind of a file sent, duration and an error code. Never subjects, bodies, addresses, file names or search text.
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
- No upload sessions: attachments are limited to 3 MB and uploads to 4 MB.
