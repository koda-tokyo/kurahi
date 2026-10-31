---
summary: "Kurahi Guardian: ransomware shield over company shares, scheduled share scans (ClamAV, Microsoft Defender, YARA; fail closed), nightly posture checks, security incident cases, SIEM export, JPCERT/CC and IPA advisories and Microsoft Defender alerts"
read_when:
  - Protecting company file shares from ransomware with Kurahi
  - Setting up scheduled malware scans, backup and restore checks or posture checks
  - Sending Kurahi audit and security events to a SIEM
  - Answering a security review question about what Guardian does and does not do
title: "Kurahi Guardian"
---

# Kurahi Guardian

Also available in [Japanese](/ja/security/guardian).

Guardian is the security capability of Kurahi Core, so every edition has it. Proven engines and
deterministic checks find problems; an agent explains them in Japanese or English; every finding
becomes an incident case with signed evidence; people decide what to do.

Guardian **complements** an EDR (Microsoft Defender for Endpoint, CrowdStrike and others). It is not
an EDR and not a certified antivirus, and it makes no detection-rate promises.

## Principles

1. **Detectors decide, the model explains.** No model decides whether a file is malware or a check
   passed. Checks end in `verdict OK` or `verdict ESCALATE`, computed by code.
2. **Proven engines.** Scans run through ClamAV, Microsoft Defender or YARA.
3. **Fail closed.** A timeout, crash, unreadable result, missing configuration or `enabled: false`
   is `ESCALATE`, never `OK`.
4. **Bounded containment.** Automatic actions stay inside Kurahi: the ransomware shield stops all
   agents, and the share scan stores a hashed quarantine copy. Isolating machines, restoring
   backups, and moving or deleting company files are decided by people. Kurahi never deletes files.
5. **Evidence for everything.** Scans, checks, shield trips and decisions are in the hash-chained
   audit trail.

## Configuration

Everything lives under `guardian` in the gateway configuration.

```json5
{
  guardian: {
    shares: ["/srv/shares/accounting", "/srv/shares/sales"],
    scan: {
      engine: "auto", // auto (ClamAV, then Defender) | clamav | defender | yara | none
      yaraRules: "/etc/kurahi/yara", // only for engine: "yara"
      quarantine: { mode: "copy" }, // "move" also moves the original (same drive only)
    },
    posture: {
      backups: [{ path: "/backup/nightly", maxAgeHours: 26, restoreTest: true }],
      secretScanRoots: ["/srv/shares"],
      allowedPorts: [22, 443, 18790],
      credentialWarnDays: 14,
    },
    siem: { host: "siem.example.co.jp", port: 6514, protocol: "tls", format: "rfc5424", ca: "/etc/kurahi/siem-ca.pem" },
    advisories: { feeds: ["jpcert", "ipa"], products: ["FortiOS", "Windows Server", "Apache"] },
  },
}
```

| Key                       | Default            | Meaning                                                                                     |
| ------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| `enabled`                 | `true`             | `false` turns every Guardian check into `ESCALATE` and removes the shares from the shield   |
| `shares[]`                | none               | Company folders (absolute paths) watched by the ransomware shield and scanned               |
| `scan.engine`             | `auto`             | Scanner for share scans; YARA runs only when named                                          |
| `scan.maxFiles`/`maxBytes`| bounded            | Upper bounds per scan run; a run that hits one reports `truncated`                          |
| `scan.quarantine.mode`    | `copy`             | `copy` keeps the original; `move` also moves it into the quarantine folder                  |
| `posture.backups[]`       | none               | Backup folders or archives: freshness (`maxAgeHours`, default 26) and optional test restore |
| `posture.secretScanRoots` | none               | Folders searched for keys, tokens and passwords left in files                               |
| `posture.allowedPorts`    | none               | TCP ports expected to listen; any other non-loopback listener is a finding                  |
| `posture.credentialWarnDays` | 14              | Kurahi's stored sign-ins expiring within this many days are a finding                       |
| `siem`                    | off                | Export audit entries and Guardian events as syslog                                          |
| `advisories`              | off                | JPCERT/CC and IPA advisory feeds, and the products to match                                 |

## Ransomware shield over company shares

The shield (decoy files, entropy spikes, ransom notes) has guarded Kurahi's own folders since 2.0.
With `guardian.shares` it also guards company shares. When it trips, Kurahi stops all agents and
records the trip; it does not touch other programs on the server.

## Checks

Guardian adds engine checks that autopilot routines gather. Each returns `fact` lines and a verdict.

| Check                   | What it checks                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| `guardian_backup`       | Each configured backup is newer than its `maxAgeHours`                                          |
| `guardian_restore_test` | One sample file restored from each backup with `restoreTest` matches by hash (tar and zip)      |
| `guardian_secrets`      | Keys, tokens and passwords left in files under `secretScanRoots` (Kurahi's redaction patterns)  |
| `guardian_ports`        | Listening TCP ports against `allowedPorts` (loopback only when asked)                           |
| `guardian_integrity`    | Kurahi's own files against its integrity record                                                 |
| `guardian_credentials`  | Expiry of Kurahi's stored sign-ins; API keys and self-refreshing sign-ins carry no expiry        |
| `guardian_scan`         | Incremental scan of the shares; infected files listed by SHA-256 and signature                 |

The share scan only rescans new or changed files. One scan runs at a time per Kurahi home. A
quarantine copy is stored with a sidecar holding the original path, hash, engine and signatures.

## Incident cases: the core-guardian pack

Create a Project from **Security — Kurahi Guardian** (`core-guardian`). It brings:

- **Security incidents** queue (department IT, 24-hour target).
- Checks: a case needs a summary and its evidence; claims that a threat was removed, a system
  restored or that there is no risk are refused until a person confirms them.
- Route: IT security reviews within 4 hours (escalating to a director after 8); cases with priority
  `high` or `urgent` also go to management.
- A check that escalates always becomes a case: when the model leaves one out, Kurahi files it
  itself with the check's facts. A clean share scan ends without a model call.
- Routines at L1 (prepare only): **guardian-posture** nightly at 02:15 (backup, restore test,
  secrets, ports, integrity, credentials) and **guardian-shares** nightly at 01:30 (share scan).

## SIEM export

With `guardian.siem`, the gateway sends every audit entry it appends, and every Guardian check
result, to the customer's SIEM as syslog in RFC 5424 (structured data `kurahi@32473`) or CEF, over
TCP, TLS (with `ca`) or UDP. Export never blocks the gateway; values are redacted before sending.
Audit entries written by separate CLI processes are not exported.

## Advisories

`guardian_advisories` reads the JPCERT/CC and IPA advisory feeds (allow-listed URLs only, no
redirects) and flags advisories that name a product in `advisories.products`. Arguments: `feeds`,
`sinceDays` (1–90, default 14), `limit` (up to 100), `matchesOnly`. A feed that cannot be read is
reported as unavailable.

## Microsoft Defender alerts

The Microsoft 365 connector offers `m365_security_alerts` (Microsoft Graph Security `alerts_v2`,
read only) when its option `security.alerts` is `true`, which requests `SecurityAlert.Read.All`.
Arguments: `severity`, `status`, `since`, `top` (up to 50).

## What Guardian does not do

- It does not replace an EDR or antivirus on endpoints.
- It does not delete, clean or restore files, and it does not isolate machines.
- It does not refresh or rewrite credentials; it only reads expiry data Kurahi holds.
