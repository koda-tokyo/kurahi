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

export type GuardianConfig = {
  enabled?: boolean;
  /** Company file shares (absolute paths) watched by the ransomware shield and scanned. */
  shares?: string[];
  scan?: GuardianScanConfig;
  posture?: GuardianPostureConfig;
  siem?: GuardianSiemConfig;
  advisories?: { feeds?: ("jpcert" | "ipa")[]; products?: string[] };
};
