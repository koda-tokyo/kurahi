---
summary: "Attachment intake: inbound mail attachments are quarantined, checked by a static policy, scanned for malware (ClamAV or Microsoft Defender, fail closed) and only then stored in the Project; text is extracted in a bounded child process"
read_when:
  - Letting an agent or an autopilot routine read mail attachments
  - Choosing or configuring a malware scanner for Kurahi
  - Answering a security review question about inbound files
title: "Attachment intake"
---

# Attachment intake

日本語版: [添付ファイルの取り込み](/ja/security/attachment-intake)

Mail attachments are the most common way malware reaches a company. Kurahi never hands an
attachment's bytes to a model, and never stores one in a Project before it has been checked.
Every inbound file goes through the same pipeline, whether an agent asked for it in a chat or an
[autopilot](/autopilot) routine gathered it.

## The pipeline

`m365_mail_attachment_fetch` (Microsoft 365 connector, mail read scope `Mail.Read`; Graph
`GET /me/messages/{id}/attachments/{id}` needs nothing more) takes one attachment of one message
and runs:

1. **Download** of one **file attachment** of at most 20 MB. Attached Outlook items
   (`item_attachment`) and links to cloud files (`reference_attachment`) are refused, and so is a
   declared size over 20 MB (`too_large`), before anything is downloaded.
2. **Quarantine**: the bytes are written to `<KOLO_HOME>/projects/<id>/quarantine/attachments/`
   (mode 0600, no file name, no extension), in the Project's data area, never the client folder.
   The quarantined copy is deleted when the intake ends, whatever the outcome.
3. **Static policy** (always, whatever the scanner; see below).
4. **Malware scan** of the quarantined file (see [Scanners](#scanners)). Only `clean` passes;
   `unscanned` passes only when `security.attachments.requireScan` is `false`.
5. **Store**: a copy goes to `inbox-attachments/` in the Project folder, named
   `<date>-<hash>-<sanitised name>`. The folder must be writable in the Project's current mode
   (add `inbox-attachments` to the Project's writable folders; 実行 Act mode), is never written
   through a symbolic link, never onto a file the integrity registry protects, and never over a
   different file. Open-access papers fetched by the
   [scholar sources](/connectors/scholar-sources) go to `corpus-inbox/` instead, under the same
   rules; the folder is one of two fixed names, never a path a tool argument chooses.
6. **Extract** the text of the stored file in a separate child process (below).

The tool returns the project-relative path, the kind, size, SHA-256, the verdict and the
extracted text inside the untrusted-content boundary (`EXTERNAL_UNTRUSTED_CONTENT`). A path is
returned only after a clean verdict; the file bytes are never returned.

`m365_mail_read` lists a message's attachments as metadata only, one line each:
`attachment: <messageId>|<attachmentId> | name: … | size: … | contentType: …`. The first field is
the `ref` the fetch tool takes.

## Static policy

Decided from the bytes; the file name only adds refusals, it never makes a file acceptable.

| Code                 | Refused                                                                                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `executable`         | PE (`MZ`), ELF, Mach-O and universal binaries, Java class files, disk images; executable and script extensions (`.exe .js .vbs .ps1 .bat .cmd .scr .lnk .hta .jar .msi .iso .img` and more), also inside an archive |
| `script`             | a `#!` script                                                                                                                                                                                                       |
| `office_macro`       | `vbaProject.bin` in an Office zip, a macro-enabled content type, a macro-enabled extension (`.docm .xlsm .pptm …`), VBA in an OLE file                                                                              |
| `encrypted_archive`  | a zip entry with the encryption flag or the AES method                                                                                                                                                              |
| `encrypted_office`   | an OLE compound file holding `EncryptedPackage` (password-protected Word, Excel, PowerPoint)                                                                                                                        |
| `nested_archive`     | an archive inside an archive inside the file (one nested level, such as a chart workbook embedded in a document, is opened and checked; deeper is refused)                                                          |
| `zip_bomb`           | more than 5,000 entries, more than 200 MB declared, a compression ratio over 200 for an entry over 1 MB, or an entry that inflates beyond its declared size                                                         |
| `archive_unreadable` | a damaged zip directory, ZIP64, an unknown compression method                                                                                                                                                       |
| `unsupported_type`   | anything outside the document allow-list (PDF, DOCX, XLSX, PPTX, CSV, TXT, MD, PNG, JPEG, GIF, WebP), including plain zip files and legacy Office files                                                             |
| `type_mismatch`      | content that does not match the extension                                                                                                                                                                           |

## Scanners

`security.attachments.scanner` in `kolo.json`:

| Value      | Engine                                                                                                                                                                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto`     | default: ClamAV when installed, else Microsoft Defender when reachable, else `none`                                                                                                                                                                                                             |
| `clamav`   | `clamdscan --fdpass` when the daemon client is installed, else `clamscan --no-summary`; exit 0 clean, 1 infected, anything else an error                                                                                                                                                        |
| `defender` | `MpCmdRun.exe -Scan -ScanType 3 -File <path> -DisableRemediation`; on Windows from `Program Files\Windows Defender`, from WSL through the Windows binary on the C: drive mount with the path translated by `wslpath -w`; exit 0 with "found no threats" clean, 2 threat, anything else an error |
| `none`     | no engine: every file is `unscanned`                                                                                                                                                                                                                                                            |

Every scan runs with a minimal environment and a bounded wall clock
(`security.attachments.scanTimeoutSeconds`, default 120). It **fails closed**: a timeout, a crash,
an unknown exit code or output without a verdict is `scan_failed`, never clean. A scanner named
explicitly but not installed fails every scan; it never falls back to `none`.

`security.attachments.requireScan` (default `true`) refuses `unscanned` files. Set it to `false`
only where no engine can be installed and the static policy is accepted as the only check.

```json5
{
  security: {
    attachments: {
      scanner: "auto", // auto | clamav | defender | none
      requireScan: true,
      scanTimeoutSeconds: 120,
      extractTimeoutSeconds: 30,
      extractMaxOldSpaceMb: 256,
    },
  },
}
```

## Isolated text extraction

The document parsers (zip, XML, PDF) never run in the gateway process. Each accepted file is
read by a fresh Node child process with a small V8 heap (`--max-old-space-size`, default 256 MB),
an empty environment (no tokens, proxies or `NODE_OPTIONS`), one request on stdin, capped output,
and a wall clock (default 30 s) after which it is killed. The child code makes no network calls,
writes no files and starts nothing. A parser bug or a hostile document can only crash or stall
the child; the file stays stored (it passed the scan) and the tool says the text is not
available.

## Audit and evidence

Every intake is audited (`attachment.intake`, source `security.attachments`) with the Project,
connector, message and attachment ids, the SHA-256, size, kind, verdict, scanner and refusal code,
never the file name or content. Every refusal is also sealed as a signed evidence bundle under
`<KOLO_HOME>/projects/<id>/security/attachments/<intakeId>/evidence/` in the standard evidence
format (`kolo evidence verify` checks it).

## In autopilot runs

`m365_mail_attachment_fetch` is a read tool for gather steps. A routine fans out over the
attachment lines of the messages it read:

```yaml
gather:
  - { id: inbox, tool: m365_mail_list, args: { top: 25 } }
  - id: mail
    tool: m365_mail_read
    each: { from: inbox, match: "id: (\\S+)", arg: id, max: 10 }
  - id: files
    tool: m365_mail_attachment_fetch
    each: { from: mail, match: "attachment: (\\S+)", arg: ref, max: 10 }
```

A refused attachment does not fail the run. The engine flags the item about that message
`malicious_attachment` (a blocking flag: no action runs for the item), and when no item of the
plan is about the message it files one for a person itself. Only a person clears the flag
(`workitems.clearFlag`, with a written reason).

## Threat model

| Threat                                           | Control                                                                     | Residual                                                                   |
| ------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Executable or script disguised as a document     | magic bytes and extension policy before the scanner                         | formats the policy does not know are refused by the allow-list             |
| Macro document (renamed `.docm` as `.docx`)      | `vbaProject.bin`, content type and OLE VBA checks                           | macros in formats outside the allow-list are refused as unsupported        |
| Encrypted payload the scanner cannot read        | encrypted zip and encrypted Office refused                                  | none: such files never reach the Project                                   |
| Zip bomb or parser exhaustion                    | entry, size and ratio caps; inflation bounded; extraction in a killed child | a parser bug can stall the child for at most the extraction timeout        |
| Known malware in an allowed format (PDF, DOCX …) | ClamAV or Defender scan, fail closed, `requireScan` on                      | unknown (zero-day) malware: a person opens stored files with normal care   |
| A model fetching arbitrary files                 | one attachment of the signed-in mailbox per call, into the Project only     | the mailbox owner's own mail is in scope by design                         |
| Leaking file names or content through logs       | audit and evidence carry ids, hashes and codes only                         | the stored file is in the Project folder, under the Project's access rules |
