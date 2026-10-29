// Effective governance policy: built-in defaults < config `governance` (organisation default) <
// the Project override in <KOLO_HOME>/governance/policy.json. Evidence and audit retention are
// never shorter than the configured minimum (audit integrity): an override below it is refused
// when it is set, and clamped if a file was edited by hand.
import path from "node:path";
import type { KoLoConfig } from "../config/config.js";
import type {
  GovernanceConfig,
  GovernanceDataClass,
  GovernancePersonalDataAction,
  GovernanceRetentionRule,
} from "../config/types.governance.js";
import { governanceDir, readJsonFile, writeJsonAtomic } from "./store.js";

export const DATA_CLASSES: readonly GovernanceDataClass[] = [
  "transcripts",
  "workitems",
  "evidence",
  "audit",
  "attachments",
  "outputs",
  "memory",
  "connectorCaches",
];

/** Classes whose records keep their structure when anonymized; the rest are always deleted. */
export const ANONYMIZABLE: ReadonlySet<GovernanceDataClass> = new Set([
  "transcripts",
  "workitems",
  "memory",
]);

/** Organisation-wide classes: kept per installation, not per Project. */
export const ORG_ONLY: ReadonlySet<GovernanceDataClass> = new Set(["audit"]);

export const DEFAULT_MINIMUM_DAYS = { audit: 365, evidence: 365 } as const;
export const DEFAULT_SWEEP_HOUR_UTC = 18;

export type RetentionRule = { keepDays: number | null; mode: "delete" | "anonymize" };
export type RetentionPolicy = Record<GovernanceDataClass, RetentionRule>;

export type PersonalDataPolicy = {
  myNumber: GovernancePersonalDataAction;
  otherIdentifiers: GovernancePersonalDataAction;
  redactExports: boolean;
  redactLogs: boolean;
};

export type ProjectOverride = {
  retention?: Partial<Record<GovernanceDataClass, GovernanceRetentionRule>>;
  personalData?: Partial<PersonalDataPolicy>;
  updatedAt?: string;
  updatedBy?: string;
};

type PolicyFile = { version: 1; projects: Record<string, ProjectOverride> };

export class GovernanceRefused extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "GovernanceRefused";
  }
}

export function governanceConfigOf(cfg: KoLoConfig | undefined): GovernanceConfig {
  return cfg?.governance ?? {};
}

export function minimumDays(cfg: GovernanceConfig): { audit: number; evidence: number } {
  return {
    audit: cfg.minimumRetentionDays?.audit ?? DEFAULT_MINIMUM_DAYS.audit,
    evidence: cfg.minimumRetentionDays?.evidence ?? DEFAULT_MINIMUM_DAYS.evidence,
  };
}

function policyFile(home: string): string {
  return path.join(governanceDir(home), "policy.json");
}

export function readPolicyFile(home: string): PolicyFile {
  const raw = readJsonFile<PolicyFile>(policyFile(home), { version: 1, projects: {} });
  return { version: 1, projects: raw?.projects ?? {} };
}

export function projectOverride(home: string, projectId: string): ProjectOverride {
  return readPolicyFile(home).projects[projectId] ?? {};
}

function normalizeRule(
  cls: GovernanceDataClass,
  rule: GovernanceRetentionRule | undefined,
  base: RetentionRule,
): RetentionRule {
  const keepDays = rule && "keepDays" in rule ? (rule.keepDays ?? null) : base.keepDays;
  const mode = rule?.mode ?? base.mode;
  return { keepDays, mode: ANONYMIZABLE.has(cls) ? mode : "delete" };
}

function clampMinimum(policy: RetentionPolicy, min: { audit: number; evidence: number }) {
  for (const cls of ["audit", "evidence"] as const) {
    const r = policy[cls];
    if (r.keepDays !== null && r.keepDays < min[cls]) {
      r.keepDays = min[cls];
    }
  }
  return policy;
}

/** Organisation default retention (config), clamped to the minimums. */
export function orgRetention(cfg: GovernanceConfig): RetentionPolicy {
  const base: RetentionRule = { keepDays: null, mode: "delete" };
  const out = {} as RetentionPolicy;
  for (const cls of DATA_CLASSES) {
    out[cls] = normalizeRule(cls, cfg.retention?.[cls], base);
  }
  return clampMinimum(out, minimumDays(cfg));
}

/** Retention for one Project: the org default with the Project's override on top. */
export function effectiveRetention(
  cfg: GovernanceConfig,
  home: string,
  projectId: string | null,
): RetentionPolicy {
  const org = orgRetention(cfg);
  if (!projectId) {
    return org;
  }
  const override = projectOverride(home, projectId).retention ?? {};
  const out = {} as RetentionPolicy;
  for (const cls of DATA_CLASSES) {
    out[cls] = ORG_ONLY.has(cls) ? org[cls] : normalizeRule(cls, override[cls], org[cls]);
  }
  return clampMinimum(out, minimumDays(cfg));
}

export function effectivePersonalData(
  cfg: GovernanceConfig,
  home: string,
  projectId: string | null,
): PersonalDataPolicy {
  const org: PersonalDataPolicy = {
    myNumber: cfg.personalData?.myNumber ?? "block",
    otherIdentifiers: cfg.personalData?.otherIdentifiers ?? "warn",
    redactExports: cfg.personalData?.redactExports ?? false,
    redactLogs: cfg.personalData?.redactLogs ?? false,
  };
  if (!projectId) {
    return org;
  }
  const o = projectOverride(home, projectId).personalData ?? {};
  return {
    myNumber: o.myNumber ?? org.myNumber,
    otherIdentifiers: o.otherIdentifiers ?? org.otherIdentifiers,
    redactExports: o.redactExports ?? org.redactExports,
    redactLogs: o.redactLogs ?? org.redactLogs,
  };
}

/**
 * Replace a Project's override. Refuses evidence retention below the minimum and any audit rule
 * (the audit log is one chain for the installation; its retention is set in config only).
 */
export function setProjectOverride(
  cfg: GovernanceConfig,
  home: string,
  projectId: string,
  next: ProjectOverride,
  by: string,
  now: Date = new Date(),
): ProjectOverride {
  const min = minimumDays(cfg);
  const retention = next.retention ?? {};
  for (const [cls, rule] of Object.entries(retention)) {
    if (!DATA_CLASSES.includes(cls as GovernanceDataClass)) {
      throw new GovernanceRefused("unknown_class", `unknown data class: ${cls}`);
    }
    if (ORG_ONLY.has(cls as GovernanceDataClass)) {
      throw new GovernanceRefused(
        "org_only_class",
        "audit retention is organisation-wide (config governance.retention.audit)",
      );
    }
    if (
      cls === "evidence" &&
      rule?.keepDays !== undefined &&
      rule.keepDays !== null &&
      rule.keepDays < min.evidence
    ) {
      throw new GovernanceRefused(
        "retention_below_minimum",
        `evidence retention may not be shorter than ${min.evidence} days`,
        { class: cls, minimumDays: min.evidence },
      );
    }
    if (rule?.mode === "anonymize" && !ANONYMIZABLE.has(cls as GovernanceDataClass)) {
      throw new GovernanceRefused("anonymize_unsupported", `${cls} cannot be anonymized`, {
        class: cls,
      });
    }
  }
  const file = readPolicyFile(home);
  const stored: ProjectOverride = {
    retention,
    personalData: next.personalData ?? {},
    updatedAt: now.toISOString(),
    updatedBy: by,
  };
  file.projects[projectId] = stored;
  writeJsonAtomic(policyFile(home), file);
  return stored;
}
