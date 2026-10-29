// Retention sweeper (docs/security/data-governance.md#retention). Deterministic: no model, no
// network; the same state and clock give the same result. For every record of every class it
// applies the effective rule of the record's Project (organisation default otherwise):
//
//   keepDays null          kept (indefinite)
//   younger than keepDays  kept
//   under an active hold   kept, counted as held
//   not eligible           kept (an open work item, a running job)
//   otherwise              deleted or anonymized (rule.mode)
//
// Evidence is replaced by signed tombstones, never removed without one; the audit log loses
// whole months from its oldest end behind a signed anchor (src/audit/anchor.ts). Each run that
// changes anything writes a signed deletion manifest as an evidence bundle
// (`<KOLO_HOME>/evidence/gov-retention-<stamp>/`: class, mode, counts, SHA-256 of every record
// id, time range; never content) and an audit row. Deletion manifests are never expired.
import path from "node:path";
import type { KoLoConfig } from "../config/config.js";
import type { GovernanceDataClass } from "../config/types.governance.js";
import { pruneAuditMonths } from "../audit/anchor.js";
import { auditSafe, monthKey } from "../audit/audit-log.js";
import { sha256Hex } from "../continuity-suite/manifest.js";
import { writeSealedBundle, type SealedEventBody } from "../evidence/sealed-bundle.js";
import { activeHolds, holdsCovering, type LegalHold } from "./holds.js";
import {
  DATA_CLASSES,
  DEFAULT_SWEEP_HOUR_UTC,
  effectiveRetention,
  governanceConfigOf,
  orgRetention,
  type RetentionPolicy,
} from "./policy.js";
import { collectRecords, pseudonymizer, type ApplyContext, type GovRecord } from "./records.js";
import {
  auditDirOf,
  evidenceRootOf,
  governanceDir,
  readJsonFile,
  writeJsonAtomic,
} from "./store.js";

export type ClassTally = {
  deleted: number;
  anonymized: number;
  held: number;
  failed: number;
  /** SHA-256 of each changed record id (sorted). */
  idHashes: string[];
  oldest: string | null;
  newest: string | null;
};

export type SweepResult = {
  at: string;
  dryRun: boolean;
  manifestId: string | null;
  classes: Record<GovernanceDataClass, ClassTally>;
  audit: { months: string[]; entries: number };
  holds: number;
};

const MAX_HASHES_IN_MANIFEST = 5000;

function emptyTally(): ClassTally {
  return {
    deleted: 0,
    anonymized: 0,
    held: 0,
    failed: 0,
    idHashes: [],
    oldest: null,
    newest: null,
  };
}

function stampOf(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\..+$/, "");
}

export function expired(
  rec: Pick<GovRecord, "at">,
  policy: RetentionPolicy,
  cls: GovernanceDataClass,
  now: Date,
) {
  const rule = policy[cls];
  if (rule.keepDays === null) {
    return false;
  }
  return Date.parse(rec.at) < now.getTime() - rule.keepDays * 86_400_000;
}

export async function runRetentionSweep(opts: {
  home: string;
  config?: KoLoConfig;
  now?: Date;
  dryRun?: boolean;
  /** Who started it (`scheduler`, a person principal). */
  by?: string;
  classes?: GovernanceDataClass[];
}): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  const cfg = governanceConfigOf(opts.config);
  const home = opts.home;
  const holds: LegalHold[] = activeHolds(home);
  const classes = Object.fromEntries(DATA_CLASSES.map((c) => [c, emptyTally()])) as Record<
    GovernanceDataClass,
    ClassTally
  >;
  const manifestId = opts.dryRun ? null : `gov-retention-${stampOf(now)}-${process.pid}`;
  const ctx: ApplyContext = {
    home,
    now,
    manifestId,
    cause: "retention",
    pseudonym: pseudonymizer(home),
  };
  const wanted = opts.classes ? new Set(opts.classes) : undefined;
  const policies = new Map<string, RetentionPolicy>();
  const policyFor = (projectId: string | null | undefined) => {
    const key = projectId ?? "";
    let p = policies.get(key);
    if (!p) {
      p = effectiveRetention(cfg, home, projectId ?? null);
      policies.set(key, p);
    }
    return p;
  };

  const records = collectRecords({ home, classes: wanted });
  for (const rec of records) {
    const policy = policyFor(rec.projectId);
    if (!rec.apply || !expired(rec, policy, rec.class, now)) {
      continue;
    }
    const tally = classes[rec.class];
    if (holdsCovering(holds, rec).length > 0) {
      tally.held += 1;
      continue;
    }
    const mode = policy[rec.class].mode;
    if (!opts.dryRun) {
      try {
        await rec.apply(mode, ctx);
      } catch {
        tally.failed += 1;
        continue;
      }
    }
    if (mode === "anonymize") {
      tally.anonymized += 1;
    } else {
      tally.deleted += 1;
    }
    tally.idHashes.push(sha256Hex(`${rec.class}:${rec.id}`));
    tally.oldest = !tally.oldest || rec.at < tally.oldest ? rec.at : tally.oldest;
    tally.newest = !tally.newest || rec.at > tally.newest ? rec.at : tally.newest;
  }

  // Audit: whole months from the oldest end, behind a signed anchor.
  const audit = { months: [] as string[], entries: 0 };
  const auditRule = orgRetention(cfg).audit;
  if ((!wanted || wanted.has("audit")) && auditRule.keepDays !== null) {
    const cutoff = new Date(now.getTime() - auditRule.keepDays * 86_400_000);
    const pruned = pruneAuditMonths({
      dir: auditDirOf(home),
      stateDir: home,
      beforeMonth: monthKey(cutoff),
      dryRun: opts.dryRun,
      now,
      keep: (month) => {
        const from = `${month}-01T00:00:00.000Z`;
        const end = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1) - 1);
        const held =
          holdsCovering(holds, {
            class: "audit",
            id: `audit-${month}`,
            projectId: undefined,
            workItemId: undefined,
            from,
            to: end.toISOString(),
          }).length > 0;
        if (held) {
          classes.audit.held += 1;
        }
        return held;
      },
    });
    audit.months = pruned.months;
    audit.entries = pruned.entries;
    classes.audit.deleted = pruned.entries;
    for (const m of pruned.months) {
      classes.audit.idHashes.push(sha256Hex(`audit:${m}`));
    }
    if (pruned.months.length > 0) {
      classes.audit.oldest = `${pruned.months[0]}-01T00:00:00.000Z`;
      classes.audit.newest = `${pruned.months.at(-1)}-28T00:00:00.000Z`;
    }
  }

  for (const t of Object.values(classes)) {
    t.idHashes.sort();
  }
  const changed = Object.values(classes).some((t) => t.deleted + t.anonymized > 0);
  const result: SweepResult = {
    at: now.toISOString(),
    dryRun: Boolean(opts.dryRun),
    manifestId: changed ? manifestId : null,
    classes,
    audit,
    holds: holds.length,
  };
  if (!opts.dryRun && changed && manifestId) {
    writeDeletionManifest(home, manifestId, result, {
      kind: "governance.retention",
      by: opts.by ?? "scheduler",
      now,
    });
  }
  if (!opts.dryRun) {
    void auditSafe(
      {
        identity: opts.by ?? "scheduler",
        action: "governance.retention.sweep",
        outcome: "ok",
        source: "governance",
        detail: {
          manifestId: result.manifestId,
          holds: holds.length,
          counts: Object.fromEntries(
            Object.entries(classes).map(([c, t]) => [
              c,
              { deleted: t.deleted, anonymized: t.anonymized, held: t.held, failed: t.failed },
            ]),
          ),
          auditMonths: audit.months,
        },
      },
      { dir: auditDirOf(home) },
    );
  }
  return result;
}

/** Seal a deletion manifest (retention run or data subject request) as an evidence bundle. */
export function writeDeletionManifest(
  home: string,
  manifestId: string,
  result: Pick<SweepResult, "classes" | "at">,
  meta: { kind: string; by: string; now: Date; extra?: Record<string, unknown> },
): { dir: string; root: string } {
  const ts = meta.now.toISOString();
  const bodies: SealedEventBody[] = [
    { type: "job.start", ts, data: { kind: meta.kind, by: meta.by, ...meta.extra } },
  ];
  for (const [cls, t] of Object.entries(result.classes)) {
    if (t.deleted + t.anonymized + t.held + t.failed === 0) {
      continue;
    }
    const all = t.idHashes;
    bodies.push({
      type: "audit",
      ts,
      data: {
        class: cls,
        deleted: t.deleted,
        anonymized: t.anonymized,
        held: t.held,
        failed: t.failed,
        range: { from: t.oldest, to: t.newest },
        idsDigest: sha256Hex(all.join("\n")),
        idHashes: all.slice(0, MAX_HASHES_IN_MANIFEST),
        idHashesTruncated: all.length > MAX_HASHES_IN_MANIFEST,
      },
    });
  }
  bodies.push({ type: "job.end", ts, data: { status: "done" } });
  const dir = path.join(evidenceRootOf(home), manifestId);
  const { root } = writeSealedBundle(
    dir,
    {
      jobId: manifestId,
      agent: meta.by,
      sessionKey: `governance:${meta.kind}`,
      kind: meta.kind,
      status: "done",
      startedAt: ts,
      endedAt: ts,
    },
    bodies,
    { env: { ...process.env, KOLO_HOME: home, KOLO_STATE_DIR: home } },
  );
  return { dir, root };
}

// ── schedule ────────────────────────────────────────────────────────────────────────────────

type SweepState = { lastDay?: string; lastRunAt?: string; lastManifestId?: string | null };
let running = false;

/**
 * Called from the gateway's minute tick. Runs the sweep once per UTC day after
 * `governance.sweep.hourUtc` (default 18 = 03:00 JST) unless `governance.sweep.enabled` is false.
 */
export function maybeRunScheduledSweep(opts: {
  home: string;
  config: KoLoConfig;
  now?: Date;
  onError?: (err: unknown) => void;
}): Promise<SweepResult | null> {
  const cfg = governanceConfigOf(opts.config);
  const now = opts.now ?? new Date();
  if (running || cfg.sweep?.enabled === false) {
    return Promise.resolve(null);
  }
  if (now.getUTCHours() < (cfg.sweep?.hourUtc ?? DEFAULT_SWEEP_HOUR_UTC)) {
    return Promise.resolve(null);
  }
  const file = path.join(governanceDir(opts.home), "sweep-state.json");
  const state = readJsonFile<SweepState>(file, {});
  const day = now.toISOString().slice(0, 10);
  if (state.lastDay === day) {
    return Promise.resolve(null);
  }
  running = true;
  // Recorded before the run: a sweep that throws is retried tomorrow, not every minute.
  writeJsonAtomic(file, { ...state, lastDay: day, lastRunAt: now.toISOString() });
  return runRetentionSweep({ home: opts.home, config: opts.config, now, by: "scheduler" })
    .then((r) => {
      writeJsonAtomic(file, {
        lastDay: day,
        lastRunAt: now.toISOString(),
        lastManifestId: r.manifestId,
      });
      return r;
    })
    .catch((err: unknown) => {
      opts.onError?.(err);
      return null;
    })
    .finally(() => {
      running = false;
    });
}
