---
summary: "Box business connector: search and file metadata, fetching a file into the Project through quarantine and malware scanning (never bytes to the model), approval-gated upload to one configured folder"
read_when:
  - You are connecting Kurahi to Box
  - You need the Box app (OAuth 2.0) setup and scopes
  - You want to know how downloaded files are checked before anything sees them
title: "Box"
---

# Box connector

Also available in [Japanese](/ja/connectors/box).

| Property       | Value                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------- |
| Plugin id      | `box` (bundled, **off by default**)                                                       |
| Default access | Read-only: `root_readonly`                                                                |
| Opt-in access  | Upload Project files into ONE configured folder (`root_readwrite`), every upload approved |
| Sign-in        | OAuth 2.0 authorization code on a loopback redirect; client secret in the secret store    |
| Token storage  | Kurahi secret store (`connector.box.token`)                                               |
| Status         | Available                                                                                 |

## Tools

| Tool                               | Needs                         | What it does                                                                                                       |
| ---------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `box_search`                       | `root_readonly`               | Search files (name and content); id, name, path, size, modified; at most 50; limited to `searchFolderIds` when set |
| `box_file_metadata`                | `root_readonly`               | Name, path, size, type, dates, version, SHA-1                                                                      |
| `box_file_fetch`                   | `root_readonly`, Project chat | Fetch one file into the Project (see below)                                                                        |
| `box_file_upload` (`write.upload`) | `root_readwrite` + approval   | Upload one Project file into `write.uploadFolderId`                                                                |

## Fetching a file: never bytes to the model

`box_file_fetch` works only in a Project chat. It reads the file's size first and refuses one over
20 MB without downloading. Otherwise it downloads the file (`GET /files/{id}/content`, which
redirects to a short-lived download URL) and hands the bytes to the core
[attachment intake](/security/attachment-intake): quarantine in the Project data area, a static
policy (executables, scripts, macros, encrypted files, nested archives and unknown types are
refused), a malware scan (fail closed), and only on a clean verdict a copy in the Project's
`inbox-attachments/` folder. The model gets the stored path and the extracted text inside the
untrusted-content boundary, never the bytes. A refusal is a normal result with a code, and is
audited and sealed as evidence. `box_file_fetch` is a declared autopilot gather tool, like
`m365_mail_attachment_fetch`.

## Uploads always need a person

`box_file_upload` exists only with `write.upload` and a `write.uploadFolderId` (never the root
folder `0`). It accepts a Project file of an accepted document type (PDF, DOCX, XLSX, PPTX, CSV,
TXT, MD or an image), at most 20 MB, sends an approval request (folder, file name, size, type) and
uploads only after a person approves. A name clash fails (Box answers 409); nothing is
overwritten, and no shared link is ever created. Box's only content write scope is
`root_readwrite`, which in Box would also allow other changes; the connector has no tool that uses
it for anything but this one upload.

## Set up

1. In the Box Developer Console, create a **Custom App** with **User Authentication (OAuth 2.0)**.
   Add the redirect URI `http://localhost/callback` (Box accepts any port on localhost). Under
   **Application Scopes** tick **Read all files and folders**, and **Write all files and folders**
   only if uploads are wanted. A Box admin may need to authorise the app.
2. Configure:

```bash
kurahi plugins enable box
kurahi secrets set connector.box.clientSecret
kurahi config set plugins.entries.box.config '{ "clientId": "<32-character client id>" }' --json
kurahi box status
kurahi box login
kurahi box probe
```

| Key                      | Default | Meaning                                             |
| ------------------------ | ------- | --------------------------------------------------- |
| `clientId`               | none    | Box app Client ID                                   |
| `searchFolderIds`        | none    | Limit searches to these folders                     |
| `write.upload`           | `false` | `box_file_upload`                                   |
| `write.uploadFolderId`   | none    | The one folder uploads go to                        |
| `redirectPort`           | random  | Fixed loopback port                                 |
| `ratePerSecond`          | 4       | Client-side request limit (searches: 50 per minute) |
| `approvalTimeoutSeconds` | 120     | How long an upload waits for a person               |

## Data handling

- **Untrusted content.** File names, paths and extracted text reach the model only inside the
  untrusted-content boundary.
- **Audit.** One row per call (`connector.box.<operation>`): file ids, counts, bytes, document kind,
  duration, error code. Never file names, paths, search text or content.
- **Tokens.** Access tokens last 60 minutes; refresh tokens 60 days and single use (rotated on
  every refresh, as the shared token store does).
- **Limits.** Box allows 1,000 requests per minute per user, 6 searches per second and 60 per
  minute, 240 uploads per minute; the connector rate limits itself and keeps searches at 50 per
  minute.
- **Endpoints.** `account.box.com`, `api.box.com`, `upload.box.com`, and the download URL Box
  redirects to.

## Status and revocation

The gateway probes `GET /users/me?fields=id`. `kurahi box logout` revokes the token at
`/oauth2/revoke` (with the client credentials) and deletes it locally.

## References

Official Box documentation: OAuth endpoints and errors
([without-sdk](https://developer.box.com/guides/authentication/oauth2/without-sdk/),
[token](https://developer.box.com/reference/post-oauth2-token/)), revoke
([revoke](https://developer.box.com/reference/post-oauth2-revoke/)), token lifetimes
([tokens](https://developer.box.com/guides/authentication/tokens/),
[refresh](https://developer.box.com/guides/authentication/tokens/refresh/)), localhost redirect
rules ([setup](https://developer.box.com/guides/authentication/oauth2/oauth2-setup)), scopes
([scopes](https://developer.box.com/guides/api-calls/permissions-and-errors/scopes/)), search,
file, download and upload APIs
([search](https://developer.box.com/reference/get-search/),
[file](https://developer.box.com/reference/get-files-id/),
[content](https://developer.box.com/reference/get-files-id-content/),
[upload](https://developer.box.com/reference/post-files-content/)), rate limits
([rate-limits](https://developer.box.com/guides/api-calls/permissions-and-errors/rate-limits/)).

Setup notes: sign-in sends PKCE (ignored where unsupported). The probe uses `GET /users/me`
([get-users-me](https://developer.box.com/reference/get-users-me/)). Sign-in uses OAuth 2.0;
JWT (server) authentication is not available in this release.
