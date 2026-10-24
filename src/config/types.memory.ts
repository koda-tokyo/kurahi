export type StmWriteAckConfig = {
  /** Enable the post-turn STM write acknowledgement turn (default: true). */
  enabled?: boolean;
};

/** Trust level of the input that triggered the turn which wrote a memory entry. */
export type MemoryTrustLevel = "operator" | "channel" | "cron" | "external";

/**
 * Memory provenance and quarantine (OWASP ASI06). Unset `mode` falls back to "warn" (existing
 * installs); new installations get "enforce" from `applySecureDefaults`.
 */
export type MemoryProvenanceConfig = {
  /** off: no tagging; warn: tag + flag, write lands; enforce: flagged writes go to quarantine. */
  mode?: "off" | "warn" | "enforce";
  /** Trust levels whose writes are quarantined (default: ["external"]). */
  quarantineTrust?: Array<"channel" | "cron" | "external">;
};

export type MemoryConfig = {
  /** Post-turn STM write acknowledgement behavior. */
  stmWriteAck?: StmWriteAckConfig;
  /** Provenance tags, quarantine and retrieval marking for memory writes. */
  provenance?: MemoryProvenanceConfig;
};
