// In-process read tools for Core routines: the deterministic checks the dogfood ops jobs ran as
// probes (disk, memory, clock, policy, evidence signing), plus the routine's own Project's linked
// cases, as gather tools. Each prints the probe protocol (`fact k=v` lines and one
// `verdict OK|ESCALATE reason` line). They read only.

import fs from "node:fs";
import os from "node:os";
import { resolveKoloHome } from "../config/kolo-home.js";
import { resolveEvidenceSigningKey } from "../evidence/store.js";
import { getPolicyEngine } from "../policy/engine.js";
import { linkedCaseStatus } from "../workitems/links-store.js";
import { purchaseOrderDue } from "../workitems/procurement.js";
import { readAllWorkItems } from "../workitems/store.js";
import { TERMINAL_STATUSES } from "../workitems/types.js";

/** The run a check belongs to: Project-scoped checks read only this Project. */
export type EngineCheckContext = { projectId: string; home?: string };

type Check = (args: Record<string, unknown>, ctx: EngineCheckContext) => string;

/** Work item ids a check lists in one fact line. */
const IDS_MAX = 10;

const pct = (n: number) => `${Math.round(n * 1000) / 10}`;

function verdict(facts: Record<string, string | number | boolean>, ok: boolean, reason: string) {
  const lines = Object.entries(facts).map(([k, v]) => `fact ${k}=${v}`);
  lines.push(`verdict ${ok ? "OK" : "ESCALATE"} ${reason}`);
  return lines.join("\n");
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

/**
 * Gate checks: a check whose verdict says nothing is due ends a `gate: true` step with no model
 * call (runner.ts noInput).
 */
const GATES: Record<string, (text: string) => string | null> = {
  workitems_po_ready: (text) =>
    /^fact due=0$/m.test(text) && /^fact unreadableItems=0$/m.test(text)
      ? "no case is waiting for a purchase order draft"
      : null,
};

export function isEngineTool(name: string): boolean {
  return name in CHECKS;
}

export function runEngineTool(
  name: string,
  args: Record<string, unknown>,
  ctx: EngineCheckContext,
): string {
  const check = CHECKS[name];
  if (!check) {
    throw new Error(`unknown engine check ${name}`);
  }
  try {
    return check(args, ctx);
  } catch (err) {
    return verdict({}, false, `${name} failed: ${String(err).slice(0, 200)}`);
  }
}

/** The gate reason when the check's output says there is nothing to process, else null. */
export function engineToolNoInput(name: string, text: string): string | null {
  return GATES[name]?.(text) ?? null;
}
