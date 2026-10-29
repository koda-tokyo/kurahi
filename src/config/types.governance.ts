/**
 * Data governance (docs/security/data-governance.md): retention per data class, legal holds,
 * eDiscovery export and the personal data (APPI / マイナンバー) guard. The organisation default
 * lives here; per-Project overrides are set with `governance.policy.set` and kept in
 * `<KOLO_HOME>/governance/policy.json`.
 */
export type GovernanceDataClass =
  | "transcripts"
  | "workitems"
  | "evidence"
  | "audit"
  | "attachments"
  | "outputs"
  | "memory"
  | "connectorCaches";

export type GovernanceRetentionRule = {
  /** Days a record is kept after its last change; omitted or null = indefinite. */
  keepDays?: number | null;
  /**
   * What the sweeper does once a record expires. `anonymize` keeps the structure (counts, dates,
   * statuses) and replaces personal and free-text content; classes that cannot be anonymized
   * (evidence, audit, attachments, outputs, connector caches) are deleted.
   */
  mode?: "delete" | "anonymize";
};

export type GovernancePersonalDataAction = "block" | "warn" | "off";

export type GovernancePersonalDataConfig = {
  /** マイナンバー (個人番号) in outbound tool arguments (default block). */
  myNumber?: GovernancePersonalDataAction;
  /** Passport, 在留カード, bank account, phone, email (default warn: audited, not blocked). */
  otherIdentifiers?: GovernancePersonalDataAction;
  /** Redact detected identifiers in eDiscovery exports by default (default false). */
  redactExports?: boolean;
  /** Redact every detected identifier in audit rows and evidence events (default false; マイナンバー always). */
  redactLogs?: boolean;
};

export type GovernanceConfig = {
  /** Organisation default retention per data class (default: indefinite for every class). */
  retention?: Partial<Record<GovernanceDataClass, GovernanceRetentionRule>>;
  /**
   * Floor for evidence and audit retention (audit integrity). Neither the organisation default
   * nor a Project override may keep them for fewer days. Default 365 each.
   */
  minimumRetentionDays?: { audit?: number; evidence?: number };
  /** The retention sweeper (deterministic, no model). */
  sweep?: {
    /** Default true; the sweeper only deletes what a retention rule names. */
    enabled?: boolean;
    /** UTC hour of the daily run (default 18 = 03:00 JST). */
    hourUtc?: number;
  };
  personalData?: GovernancePersonalDataConfig;
};
