// In-process read tools for Core routines: the deterministic checks the dogfood ops jobs ran as
// probes (disk, memory, clock, policy, evidence signing), as gather tools. Each prints the probe
// protocol (`fact k=v` lines and one `verdict OK|ESCALATE reason` line). They read only.

import fs from "node:fs";
import os from "node:os";
import { resolveKoloHome } from "../config/kolo-home.js";
import { resolveEvidenceSigningKey } from "../evidence/store.js";
import { getPolicyEngine } from "../policy/engine.js";

type Check = (args: Record<string, unknown>) => string;

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
};

export function isEngineTool(name: string): boolean {
  return name in CHECKS;
}

export function runEngineTool(name: string, args: Record<string, unknown>): string {
  const check = CHECKS[name];
  if (!check) {
    throw new Error(`unknown engine check ${name}`);
  }
  try {
    return check(args);
  } catch (err) {
    return verdict({}, false, `${name} failed: ${String(err).slice(0, 200)}`);
  }
}
