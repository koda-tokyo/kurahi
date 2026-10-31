---
summary: "Kurahi Guardian: ransomware shield over company shares, scheduled share scans (ClamAV, Microsoft Defender, YARA; fail closed), nightly posture checks, security incident cases, SIEM export, JPCERT/CC and IPA advisories, Microsoft Defender alerts, and the exposure check of the organisation's own domains (plus consent-based personal exposure)"
read_when:
  - Protecting company file shares from ransomware with Kurahi
  - Setting up scheduled malware scans, backup and restore checks or posture checks
  - Sending Kurahi audit and security events to a SIEM
  - Answering a security review question about what Guardian does and does not do
  - Checking what an attacker can find about the organisation's own domains and websites
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
| `exposure`                | off                | Exposure check of the organisation's own verified domains (see [Exposure check](#exposure-check)) |

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

## Exposure check

The exposure check is defensive open-source intelligence on the organisation's **own** external
footprint: what an attacker finds first, found by us first. It looks only at assets the
organisation declares and has proven it owns, from public sources, read-only.

### Guardrails

- **Own assets only.** Targets are the apex domains in `exposure.domains`, their subdomains, the
  mail domains in `exposure.emailDomains` and the brand terms in `exposure.brandTerms`. There is no
  free-text person search, no username hunting across social networks, no people dossiers and no
  scraping behind logins. Findings are about the organisation's assets, never about individuals.
- **Ownership verified first.** Before anything beyond one DNS TXT lookup on the declared domain,
  each domain must be verified: either the TXT record `kurahi-exposure-verify=<token>` at the apex
  (the token is per installation; `kurahi guardian exposure verify` prints the record), or an
  admin attestation (`kurahi guardian exposure attest <domain> --by <admin>`), recorded in the audit
  log with the admin's identity. An unverified domain is `ESCALATE` "domain not verified" and
  nothing is fetched for it.
- **Read-only and polite.** Public sources only, rate limited, time and size limits on every
  request, HTTPS only, no redirects followed outside scope, robots.txt respected when crawling, and
  the User-Agent `Kurahi-Guardian-Exposure/2.6 (+https://kurahi.com/security/)`. No exploitation,
  no login attempts, no port scanning.
- **Secrets are never stored or emitted.** A credential found is reported as URL, line, detector
  name, a masked preview (first 2 and last 2 characters) and the SHA-256 of the value, so repeats
  can be matched. The value itself is not kept anywhere.
- **Fail closed.** Not enabled, no domain, unverified, a source that fails (crt.sh, DNS, HIBP,
  GitHub), a crawl that stops at a limit or a site whose robots.txt cannot be read is `ESCALATE`,
  never `OK`. `OK` means everything ran and nothing was found.

### Configuration

```json5
{
  guardian: {
    exposure: {
      enabled: true,
      domains: ["example.co.jp"], // lowercase apex domains, no wildcard, at most 20
      emailDomains: ["example.co.jp"], // optional; must be a verified domain or under one
      brandTerms: ["Example Corp"], // optional; for the code search
      crawl: { maxPages: 200, maxBytes: 52428800, maxDepth: 3 },
      lookalikes: { max: 300, ignore: ["examp1e.co.jp"] }, // ignore = lookalikes you hold yourself
      hibp: { enabled: false }, // key: kurahi secrets set guardian.exposure.hibpApiKey
      github: { enabled: false }, // token: kurahi secrets set guardian.exposure.githubToken
      people: { enabled: false, retentionDays: 30 }, // see "Personal exposure (with consent)"
    },
  },
}
```

### Checks

| Check                           | What it does                                                                                                                                                                          |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `guardian_exposure_subdomains`  | Certificate Transparency (crt.sh) inventory of subdomains; the last inventory is kept under the state dir and each run reports new subdomains and the total. The first run is the baseline |
| `guardian_exposure_dns`         | SPF present and not `+all`; DMARC present with `p=quarantine` or `reject` (`none` is a finding); MX present; CAA (info); CNAMEs of known subdomains that point at takeover-prone hosting (Azure, Heroku, GitHub Pages, S3, Vercel, Netlify and others) whose target no longer resolves: "possible subdomain takeover" |
| `guardian_exposure_web_secrets` | Crawls `https://<domain>`, `www` and the verified subdomains: same-origin only, robots.txt respected, HTML/JS/JSON/text only, bounded pages, bytes and depth. Finds keys and tokens (Kurahi's redaction patterns), filled password fields, and a password label next to a value (English, Portuguese, Spanish and Japanese labels such as `Senha:` or `パスワード：`), with the login shown next to it. Masked |
| `guardian_exposure_lookalikes`  | Up to `lookalikes.max` typo, homoglyph, TLD-swap and hyphenation permutations per domain, resolved by DNS only; registered lookalikes with MX records (able to receive replies to phishing mail) first. A lookalike's website is never fetched |
| `guardian_exposure_breaches`    | Optional. Have I Been Pwned domain search for the verified mail domains (the domains must also be verified with HIBP). Facts carry counts per breach; affected addresses go only to an evidence file (mode 0600) under the state dir, referenced by path |
| `guardian_exposure_code`        | Optional. GitHub code search for the domains and brand terms next to `password`, `secret`, `api_key` or `token`; reports repository and file URLs only, never file content |

The optional checks escalate as "off" until enabled and their key is in the secrets store; the
keys are never logged or printed. Run them on demand with `kurahi guardian exposure run --check
breaches` or add them to the routine.

The **guardian-exposure** routine (core-guardian pack, weekly on Monday 03:40, L1) gathers the
subdomain, DNS, web-secrets and lookalike checks and files incident cases in **Security
incidents** with the masked evidence. `kurahi guardian exposure run [--check <name>]` runs the
checks now and prints their facts.

## Personal exposure (with consent)

Purpose: protect employees and executives from phishing, impersonation and account takeover. It is
digital-risk protection for people who ask for it, not a people search.

### Consent model

- **Enrolment only with consent.** A person enrols themselves, or an admin enrols a named person
  who must then confirm consent themselves (`kurahi guardian exposure people enrol`, then
  `people confirm <id> --code <code> --accept <version>` after reading `people consent-text`).
  Nothing is checked while consent is pending.
- **Proven identifiers.** The email is proven by a one-time code (8 digits, 30 minutes, 5
  attempts, stored only as a salted hash). Kurahi has no mail path outside the agent connectors in
  2.6, so the CLI shows the code to the enrolling admin, who gives it to the person (relay mode).
  This is a documented limitation: relay mode trusts the admin to hand the code over, and the
  audit log names the admin. Handles are declared by the person and confirmed under their verified
  email. A phone number has no SMS path, so it is attestation-only, marked unverified, and never
  checked. Unverified identifiers are never checked.
- **Consent record.** Who enrolled, who confirmed, which identifiers and which checks, when, and
  the consent text version. Every step (enrol, confirm, revoke, purge) is in the audit log with
  identifiers masked.
- **Revocable at any time.** `people revoke <id>` stops all checks at once; the record and its
  results are deleted after `people.retentionDays` (default 30). Unconfirmed enrolments are
  deleted after the same period.

### Checks (`guardian_exposure_people`)

For each consenting person, only the checks they consented to, on verified identifiers only:

- **Breaches**: the verified email via HIBP `breachedaccount` (needs `people.hibp.enabled` and the
  HIBP key; off without it).
- **Handles**: whether the person's own handles exist on a short curated list of public platforms
  (`people.platforms`; default GitHub, GitLab, npm, PyPI, Docker Hub, Keybase, DEV, Qiita, Zenn,
  note, Hatena), read from the public profile URL's HTTP status only. No profile content is read
  and no link is followed.
- **Impersonation**: a few lookalike variants of each handle on the same platforms, by the same
  status-only check. Display-name lookalikes need a search behind a login on every major platform,
  so they are not checked. X, Instagram, Facebook, LinkedIn and TikTok cannot be checked without a
  login and are not on the list.
- **Web**: whether the person's verified email appears on the organisation's own verified websites
  (the same crawler; masked).

Facts name people only by enrolment id (`pe-…`) and carry counts and platform names, never an
email address or phone number. The full results are kept in an owner-only file (0600) under the
state dir for the person and the security team, and deleted on purge.

### Visibility

Cases go to the **sec-personal** queue (routine **guardian-exposure-people**, weekly, L1), never to
a general queue. Its only route stage is the `security` role with no escalation and no management
stage, so only the security role, the requester and privileged operators can read these cases. The
person's own results are linked to their Kurahi account (`--principal`); a console view for them
is not part of 2.6.

### Alignment with APPI and LGPD

- **Purpose limitation**: protection against phishing, impersonation and account takeover only.
- **Consent**: explicit, informed (versioned consent text), given by the person, revocable.
- **Data minimisation**: only identifiers the person proved; facts carry counts, platform names and
  enrolment ids; no profile content, no aggregation.
- **Deletion**: revocation stops processing; data is deleted after the retention period.

### What it deliberately does not do

- It never searches a person who has not enrolled and confirmed consent.
- No free-text name searches; no address or phone lookups through people-search or data-broker
  sites.
- No aggregation into a dossier; no face or photo search.
- No checks on family members or any third party.

## What Guardian does not do

- It does not replace an EDR or antivirus on endpoints.
- It does not delete, clean or restore files, and it does not isolate machines.
- It does not refresh or rewrite credentials; it only reads expiry data Kurahi holds.
- The exposure check does not probe, scan ports or log in anywhere, and never looks at domains the
  organisation has not verified or at people who have not consented.
