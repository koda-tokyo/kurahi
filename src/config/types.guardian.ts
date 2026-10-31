// Kurahi Guardian config (docs/security/guardian.md). Mirrors zod-schema.guardian.ts.

export type GuardianScanEngine = "auto" | "clamav" | "defender" | "yara" | "none";

export type GuardianScanConfig = {
  /** Scanner for share scans; `auto` picks ClamAV, then Defender. YARA only when named. */
  engine?: GuardianScanEngine;
  /** Upper bounds per scan run. */
  maxFiles?: number;
  maxBytes?: number;
  /** Folder of YARA rules (.yar/.yara) for the `yara` engine. */
  yaraRules?: string;
  /** Quarantine: `copy` (default) keeps the original and stores a hashed copy; `move` also moves it. */
  quarantine?: { dir?: string; mode?: "copy" | "move" };
};

export type GuardianBackupCheck = {
  /** A backup folder or archive whose freshness is checked. */
  path: string;
  /** Older than this is a finding (default 26 h). */
  maxAgeHours?: number;
  /** Restore one sample file into a temporary folder and compare its hash. */
  restoreTest?: boolean;
};

export type GuardianPostureConfig = {
  backups?: GuardianBackupCheck[];
  /** Folders searched for secrets left in files (keys, tokens, passwords). */
  secretScanRoots?: string[];
  /** TCP ports expected to listen on this host; any other listener is a finding. */
  allowedPorts?: number[];
  /** Credentials expiring within this many days are a finding (default 14). */
  credentialWarnDays?: number;
};

export type GuardianSiemConfig = {
  host: string;
  port: number;
  protocol?: "tcp" | "tls" | "udp";
  format?: "rfc5424" | "cef";
  /** CA bundle for `tls` (PEM path). */
  ca?: string;
};

export type GuardianExposureCrawlConfig = {
  /** Pages fetched per run across all sites (default 200). */
  maxPages?: number;
  /** Bytes read per run across all sites (default 50 MiB). */
  maxBytes?: number;
  /** Link depth from each site's home page (default 3). */
  maxDepth?: number;
};

export type GuardianExposurePeopleConfig = {
  /** Personal exposure checks for enrolled, consenting people (default false). */
  enabled?: boolean;
  /** Days results are kept after consent is revoked (default 30). */
  retentionDays?: number;
  /** Platform ids from the curated list (default: all of them). */
  platforms?: string[];
  /** Breaches per verified email via HIBP `breachedaccount` (needs the HIBP key). */
  hibp?: { enabled?: boolean };
};

/**
 * Exposure check: defensive OSINT on the organisation's OWN declared assets. Domains must be
 * verified (DNS TXT or admin attestation) before anything is fetched.
 */
export type GuardianExposureConfig = {
  enabled?: boolean;
  /** Apex domains the organisation owns (lowercase, no wildcard, at most 20). */
  domains?: string[];
  /** Mail domains for the breach check (each must also be a verified domain or under one). */
  emailDomains?: string[];
  /** Brand terms for the code search. */
  brandTerms?: string[];
  crawl?: GuardianExposureCrawlConfig;
  /** Lookalike permutations per domain (default 300); `ignore` = lookalikes the org holds itself. */
  lookalikes?: { max?: number; ignore?: string[] };
  /** Have I Been Pwned domain search (needs the key `guardian.exposure.hibpApiKey`). */
  hibp?: { enabled?: boolean };
  /** GitHub code search (needs the token `guardian.exposure.githubToken`). */
  github?: { enabled?: boolean };
  people?: GuardianExposurePeopleConfig;
};

export type GuardianConfig = {
  enabled?: boolean;
  /** Company file shares (absolute paths) watched by the ransomware shield and scanned. */
  shares?: string[];
  scan?: GuardianScanConfig;
  posture?: GuardianPostureConfig;
  siem?: GuardianSiemConfig;
  advisories?: { feeds?: ("jpcert" | "ipa")[]; products?: string[] };
  exposure?: GuardianExposureConfig;
};
