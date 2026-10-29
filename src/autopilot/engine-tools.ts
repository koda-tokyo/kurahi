// In-process read tools for Core routines: the deterministic checks the dogfood ops jobs ran as
// probes (disk, memory, clock, policy, evidence signing), plus the routine's own Project's linked
// cases, as gather tools. Each prints the probe protocol (`fact k=v` lines and one
// `verdict OK|ESCALATE reason` line). They read only.
//
// Guardian checks (`guardian_*`, docs/security/guardian.md) read `guardian` from the config: the
// posture checks (src/guardian/posture.ts) and the share scan (src/guardian/scan.ts), whose only
// writes are its scan index and quarantine copies. Nothing configured is ESCALATE, never OK.

import fs from "node:fs";
import os from "node:os";
import type { GuardianConfig } from "../config/types.guardian.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import { loadConfig } from "../config/io.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { resolveEvidenceSigningKey } from "../evidence/store.js";
import {
  checkBackupFreshness,
  checkCredentials,
  checkIntegrity,
  checkPorts,
  checkRestores,
  checkSecrets,
  type PostureResult,
} from "../guardian/posture.js";
import { infectedFileFacts, scanShares } from "../guardian/scan.js";
import { emitGuardianEvent } from "../guardian/siem.js";
import { getPolicyEngine } from "../policy/engine.js";
import { type FileScanner, resolveScanner } from "../security/scanner.js";
import { linkedCaseStatus } from "../workitems/links-store.js";
import { purchaseOrderDue } from "../workitems/procurement.js";
import { readAllWorkItems } from "../workitems/store.js";
import { TERMINAL_STATUSES } from "../workitems/types.js";

/** The run a check belongs to: Project-scoped checks read only this Project. */
export type EngineCheckContext = {
  projectId: string;
  home?: string;
  /** Guardian config (default: `guardian` from the loaded config). */
  guardian?: GuardianConfig;
  /** Share scanner (default: resolved from `guardian.scan.engine`). */
  scanner?: FileScanner;
};

type Check = (args: Record<string, unknown>, ctx: EngineCheckContext) => string;
type AsyncCheck = (args: Record<string, unknown>, ctx: EngineCheckContext) => Promise<string>;

/** Work item ids a check lists in one fact line. */
const IDS_MAX = 10;

const pct = (n: number) => `${Math.round(n * 1000) / 10}`;

// Fact values can carry names from disk (a file called "x\nverdict OK"): one line each, always.
// oxlint-disable-next-line no-control-regex
const flat = (v: unknown) => String(v).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ");

function verdict(facts: Record<string, string | number | boolean>, ok: boolean, reason: string) {
  const lines = Object.entries(facts).map(([k, v]) => `fact ${k}=${flat(v)}`);
  lines.push(`verdict ${ok ? "OK" : "ESCALATE"} ${flat(reason)}`);
  return lines.join("\n");
}

/** The check's own verdict: its last line, never a fact that happens to contain the words. */
function verdictOk(text: string): boolean {
  return /^verdict OK\b/.test(text.slice(text.lastIndexOf("\n") + 1));
}

const CHECKS: Record<string, Check> = {
  health_disk: (args) => {
    const minFree = typeof args.minFreePercent === "number" ? args.minFreePercent : 10;
    const st = fs.statfsSync(resolveKoloHome());
    const total = st.blocks * st.bsize;
    const free = st.bavail * st.bsize;
    const freePct = total > 0 ? free / total : 0;
    return verdict(
      { freeBytes: free, totalBytes: total, freePercent: pct(freePct) },
      freePct * 100 >= minFree,
      `${pct(freePct)}% free on the state volume (minimum ${minFree}%)`,
    );
  },
  health_memory: (args) => {
    const minFree = typeof args.minFreePercent === "number" ? args.minFreePercent : 5;
    const freePct = os.freemem() / os.totalmem();
    return verdict(
      { freeBytes: os.freemem(), totalBytes: os.totalmem(), load1: os.loadavg()[0].toFixed(2) },
      freePct * 100 >= minFree,
      `${pct(freePct)}% memory free (minimum ${minFree}%)`,
    );
  },
  health_clock: () => {
    const now = new Date();
    // A clock before the build year or far in the future breaks signatures and schedules.
    const ok = now.getUTCFullYear() >= 2025 && now.getUTCFullYear() < 2100;
    return verdict(
      { utc: now.toISOString(), tz: Intl.DateTimeFormat().resolvedOptions().timeZone },
      ok,
      ok ? "clock is plausible" : "system clock is implausible",
    );
  },
  health_policy: () => {
    const s = getPolicyEngine().status();
    const killed = Boolean(s.kill.fleet) || Object.keys(s.kill.agents).length > 0;
    const ok = !s.refusedReason && !killed;
    return verdict(
      {
        loaded: s.loaded,
        name: s.name ?? "",
        attestation: s.attestation ?? "",
        fleetKilled: Boolean(s.kill.fleet),
        agentsKilled: Object.keys(s.kill.agents).length,
      },
      ok,
      s.refusedReason
        ? `policy refused: ${s.refusedReason}`
        : killed
          ? "a kill switch is on"
          : "policy loaded, no kill switch",
    );
  },
  health_evidence: () => {
    try {
      resolveEvidenceSigningKey();
      return verdict({ signingKey: true }, true, "evidence signing key available");
    } catch (err) {
      return verdict({ signingKey: false }, false, `no signing key: ${String(err).slice(0, 120)}`);
    }
  },
  // Open linked cases in this Project that are stuck: a step cancelled or stopped, an attached
  // child that can no longer be read, or a record that refuses to read. Covers cases nobody owns,
  // which no morning brief shows. Ready steps are normal progress, not a problem. Ids only; no
  // titles or content reach the model.
  workitems_linked: (_args, ctx) => {
    let cases = 0;
    let ready = 0;
    const stuck: string[] = [];
    const counts = { blocked: 0, missing: 0, unreadable: 0, unowned: 0 };
    // A store that cannot be listed, or an item that cannot be read, may hide a stuck case: that
    // is unknown, never a healthy zero.
    const unreadableItems: string[] = [];
    let items: ReturnType<typeof readAllWorkItems>;
    try {
      items = readAllWorkItems(ctx.projectId, {
        home: ctx.home,
        strict: true,
        onUnreadable: (id) => unreadableItems.push(id),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      return verdict({ available: false }, false, `work items unavailable (${code})`);
    }
    for (const item of items) {
      if (TERMINAL_STATUSES.has(item.status)) {
        continue;
      }
      let unreadable = false;
      let status: ReturnType<typeof linkedCaseStatus> = null;
      try {
        status = linkedCaseStatus(ctx.projectId, item.id, ctx.home);
      } catch {
        unreadable = true;
      }
      if (!status && !unreadable) {
        continue;
      }
      cases += 1;
      ready += status?.ready.length ?? 0;
      const blocked = Boolean(status?.blocked);
      const missing = Boolean(status?.missing.length);
      if (!unreadable && !blocked && !missing) {
        continue;
      }
      counts.unreadable += unreadable ? 1 : 0;
      counts.blocked += blocked ? 1 : 0;
      counts.missing += missing ? 1 : 0;
      counts.unowned += item.assignee ? 0 : 1;
      stuck.push(item.id);
    }
    return verdict(
      {
        linkedCases: cases,
        readySteps: ready,
        stuck: stuck.length,
        ...counts,
        stuckIds: stuck.toSorted().slice(0, IDS_MAX).join(","),
        unreadableItems: unreadableItems.length,
        unreadableItemIds: unreadableItems.toSorted().slice(0, IDS_MAX).join(","),
      },
      stuck.length === 0 && unreadableItems.length === 0,
      stuck.length > 0
        ? `${stuck.length} open linked case(s) stuck (${counts.unowned} with no assignee)`
        : unreadableItems.length > 0
          ? `${unreadableItems.length} work item(s) unreadable; linked cases unknown`
          : `${cases} open linked case(s), none stuck`,
    );
  },
  // Procurement cases a routine may draft a purchase order for now: open, no fraud flag, a
  // person's supplier choice that is still current, and no draft from that choice yet. Ids only.
  workitems_po_ready: (_args, ctx) => {
    const unreadableItems: string[] = [];
    let items: ReturnType<typeof readAllWorkItems>;
    try {
      items = readAllWorkItems(ctx.projectId, {
        home: ctx.home,
        strict: true,
        onUnreadable: (id) => unreadableItems.push(id),
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "error";
      return verdict({ available: false }, false, `work items unavailable (${code})`);
    }
    const due = items.filter(purchaseOrderDue).map((i) => i.id);
    return verdict(
      {
        due: due.length,
        dueIds: due.toSorted().slice(0, IDS_MAX).join(","),
        unreadableItems: unreadableItems.length,
        unreadableItemIds: unreadableItems.toSorted().slice(0, IDS_MAX).join(","),
      },
      unreadableItems.length === 0,
      unreadableItems.length > 0
        ? `${unreadableItems.length} work item(s) unreadable; due purchase orders unknown`
        : `${due.length} case(s) waiting for a purchase order draft`,
    );
  },
};

/** Finding lines a Guardian check prints (the count is exact). */
const FINDINGS_MAX = 10;

function guardianConfig(ctx: EngineCheckContext): GuardianConfig {
  return ctx.guardian ?? loadConfig().guardian ?? {};
}

const oneLine = (s: string) => s.replace(/[\r\n]+/g, " ").slice(0, 300);

/** A posture result as fact lines: OK only when there is no finding. */
function postureVerdict(r: PostureResult, okReason: string): string {
  const facts: Record<string, string | number | boolean> = { ...r.facts };
  facts.findings = r.findings.length;
  r.findings.slice(0, FINDINGS_MAX).forEach((f, i) => {
    facts[`finding${i + 1}`] = oneLine(`${f.subject} ${f.detail}`);
  });
  const first = r.findings[0];
  return verdict(
    facts,
    r.findings.length === 0,
    first ? oneLine(`${r.findings.length} finding(s): ${first.subject} ${first.detail}`) : okReason,
  );
}

/** ESCALATE when Guardian is switched off: a disabled guardian check is not a pass. */
function guardianDisabled(cfg: GuardianConfig): string | null {
  return cfg.enabled === false
    ? verdict({ enabled: false }, false, "Guardian is disabled (guardian.enabled)")
    : null;
}

const num = (v: unknown, min: number, max: number): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;

const ASYNC_CHECKS: Record<string, AsyncCheck> = {
  guardian_backup: async (_args, ctx) => {
    const cfg = guardianConfig(ctx);
    return (
      guardianDisabled(cfg) ??
      postureVerdict(checkBackupFreshness(cfg.posture?.backups ?? []), "every backup is fresh")
    );
  },
  guardian_restore_test: async (_args, ctx) => {
    const cfg = guardianConfig(ctx);
    return (
      guardianDisabled(cfg) ??
      postureVerdict(await checkRestores(cfg.posture?.backups ?? []), "every test restore matched")
    );
  },
  // args: maxFiles (files read across all roots, default 20000).
  guardian_secrets: async (args, ctx) => {
    const cfg = guardianConfig(ctx);
    return (
      guardianDisabled(cfg) ??
      postureVerdict(
        checkSecrets(cfg.posture?.secretScanRoots ?? [], {
          maxFiles: num(args.maxFiles, 1, 1_000_000),
        }),
        "no secrets found in the scanned folders",
      )
    );
  },
  // args: includeLoopback (also judge listeners bound to 127.0.0.1 / ::1, default false).
  guardian_ports: async (args, ctx) => {
    const cfg = guardianConfig(ctx);
    return (
      guardianDisabled(cfg) ??
      postureVerdict(
        await checkPorts(cfg.posture?.allowedPorts, {
          includeLoopback: args.includeLoopback === true,
        }),
        "every listening port is allowed",
      )
    );
  },
  guardian_integrity: async (_args, ctx) => {
    const cfg = guardianConfig(ctx);
    return guardianDisabled(cfg) ?? postureVerdict(checkIntegrity(), "Kurahi files verified");
  },
  // args: warnDays (overrides guardian.posture.credentialWarnDays).
  guardian_credentials: async (args, ctx) => {
    const cfg = guardianConfig(ctx);
    const off = guardianDisabled(cfg);
    if (off) {
      return off;
    }
    const warnDays = num(args.warnDays, 1, 365) ?? cfg.posture?.credentialWarnDays;
    const r = checkCredentials(resolveAuthStorePath(), warnDays);
    const noData = r.facts.withExpiry === 0 && r.findings.length === 0;
    return postureVerdict(
      r,
      noData
        ? "no stored credential carries expiry data (API keys and self-refreshing sign-ins)"
        : "no credential expires soon",
    );
  },
  // The share scan. args: deadlineMinutes (whole run, default 60, at most 240). Infected files are
  // listed by SHA-256 and signature only; paths are in the quarantine sidecars.
  guardian_scan: async (args, ctx) => {
    const cfg = guardianConfig(ctx);
    const off = guardianDisabled(cfg);
    if (off) {
      return off;
    }
    const scan = cfg.scan ?? {};
    const r = await scanShares({
      shares: cfg.shares ?? [],
      scanner:
        ctx.scanner ??
        resolveScanner(scan.engine ?? "auto", undefined, { yaraRules: scan.yaraRules }),
      home: ctx.home ?? resolveKoloHome(),
      maxFiles: scan.maxFiles,
      maxBytes: scan.maxBytes,
      quarantine: scan.quarantine,
      deadlineMs: (num(args.deadlineMinutes, 1, 240) ?? 60) * 60_000,
    });
    const facts: Record<string, string | number | boolean> = {
      engine: r.scanner,
      scanned: r.scanned,
      skipped: r.skipped,
      symlinksSkipped: r.symlinksSkipped,
      bytes: r.bytes,
      infected: r.infected.length,
      errors: r.errorCount,
      truncated: r.truncatedBy ?? false,
      // Full SHA-256, signature and Kurahi's quarantine copy per file; never the share path.
      ...infectedFileFacts(r.infected, FINDINGS_MAX),
    };
    r.errors.slice(0, FINDINGS_MAX).forEach((e, i) => {
      facts[`error${i + 1}`] = oneLine(e.path ? `${e.path} ${e.detail}` : e.detail);
    });
    const ok = r.infected.length === 0 && r.errorCount === 0 && !r.truncated;
    return verdict(
      facts,
      ok,
      r.infected.length > 0
        ? `${r.infected.length} infected file(s), copies in ${r.quarantineDir}`
        : r.errorCount > 0
          ? oneLine(`${r.errorCount} error(s): ${r.errors[0]?.detail ?? ""}`)
          : r.truncated
            ? `scan stopped at ${r.truncatedBy}; the rest was not scanned`
            : `${r.scanned} file(s) scanned clean, ${r.skipped} unchanged`,
    );
  },
};

/**
 * Gate checks: a check whose verdict says nothing is due ends a `gate: true` step with no model
 * call (runner.ts noInput).
 */
const GATES: Record<string, (text: string) => string | null> = {
  workitems_po_ready: (text) =>
    /^fact due=0$/m.test(text) && /^fact unreadableItems=0$/m.test(text)
      ? "no case is waiting for a purchase order draft"
      : null,
  // A clean share scan needs no model call; any escalation (infected, errors, truncated) does.
  guardian_scan: (text) => (verdictOk(text) ? "share scan clean" : null),
};

export function isEngineTool(name: string): boolean {
  return name in CHECKS || name in ASYNC_CHECKS;
}

export function runEngineTool(
  name: string,
  args: Record<string, unknown>,
  ctx: EngineCheckContext,
): string {
  const check = CHECKS[name];
  if (!check) {
    throw new Error(
      name in ASYNC_CHECKS
        ? `engine check ${name} is asynchronous (runEngineToolAsync)`
        : `unknown engine check ${name}`,
    );
  }
  try {
    return check(args, ctx);
  } catch (err) {
    return verdict({}, false, `${name} failed: ${String(err).slice(0, 200)}`);
  }
}

/** Any engine check, including the asynchronous ones (Guardian). Never rejects. */
export async function runEngineToolAsync(
  name: string,
  args: Record<string, unknown>,
  ctx: EngineCheckContext,
): Promise<string> {
  const check = ASYNC_CHECKS[name];
  if (!check) {
    return runEngineTool(name, args, ctx);
  }
  let text: string;
  try {
    text = await check(args, ctx);
  } catch (err) {
    text = verdict({}, false, `${name} failed: ${String(err).slice(0, 200)}`);
  }
  // Every Guardian result also goes to the customer's SIEM (no-op when guardian.siem is unset).
  const ok = verdictOk(text);
  emitGuardianEvent({
    action: `guardian.${name.replace(/^guardian_/, "")}`,
    outcome: ok ? "ok" : "escalate",
    source: "guardian.check",
    severity: ok
      ? "info"
      : name === "guardian_scan" || name === "guardian_integrity"
        ? "high"
        : "medium",
    detail: text.slice(0, 2000),
  });
  return text;
}

/** The gate reason when the check's output says there is nothing to process, else null. */
export function engineToolNoInput(name: string, text: string): string | null {
  return GATES[name]?.(text) ?? null;
}
