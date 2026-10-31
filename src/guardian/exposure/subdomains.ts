// guardian_exposure_subdomains: subdomain inventory from Certificate Transparency (crt.sh), for
// verified domains only. The last inventory is kept under the Kurahi state dir so each run reports
// what is NEW since the previous one. crt.sh failing is ESCALATE, never an empty inventory.

import path from "node:path";
import {
  type ExposureDeps,
  type ExposureFinding,
  type ExposureResult,
  exposureDir,
  isValidDomain,
  readJsonFile,
  writeJsonFile,
} from "./common.js";

/** crt.sh answers can be large for busy domains; bounded. */
const CT_MAX_BYTES = 20 * 1024 ** 2;
const CT_TIMEOUT_MS = 60_000;
/** Names kept per domain (inventory, diff and dangling-CNAME candidates). */
export const SUBDOMAINS_MAX = 5000;
/** Seconds between crt.sh queries (a shared public service). */
const CT_INTERVAL_MS = 3000;

export function crtShUrl(domain: string): string {
  return `https://crt.sh/?q=${encodeURIComponent(`%.${domain}`)}&output=json`;
}

/**
 * Host names under `domain` from a crt.sh JSON answer: `name_value` (newline-separated SANs) and
 * `common_name`; wildcards reduced to their base, lowercased, deduplicated and sorted. Throws when
 * the answer is not a JSON array (crt.sh returns an HTML error page under load).
 */
export function parseCrtSh(json: string, domain: string, max = SUBDOMAINS_MAX): string[] {
  let rows: unknown;
  try {
    rows = JSON.parse(json);
  } catch {
    throw new Error("crt.sh answer is not JSON");
  }
  if (!Array.isArray(rows)) {
    throw new Error("crt.sh answer is not a list");
  }
  const out = new Set<string>();
  const suffix = `.${domain}`;
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const r = row as Record<string, unknown>;
    const names = [r.name_value, r.common_name]
      .filter((v): v is string => typeof v === "string")
      .flatMap((v) => v.split(/\s+/));
    for (const raw of names) {
      const name = raw.trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
      if ((name === domain || name.endsWith(suffix)) && isValidDomain(name)) {
        out.add(name);
      }
    }
  }
  return [...out].toSorted().slice(0, max);
}

export type SubdomainInventory = {
  updatedAt: string;
  domains: Record<string, string[]>;
};

export function inventoryFile(home: string): string {
  return path.join(exposureDir(home), "subdomains.json");
}

export function readInventory(home: string): SubdomainInventory | null {
  const inv = readJsonFile<SubdomainInventory>(inventoryFile(home));
  return inv && inv.domains && typeof inv.domains === "object" ? inv : null;
}

/** Names in `next` that were not in `prev`; everything is new on a first run. */
export function diffSubdomains(
  prev: readonly string[] | undefined,
  next: readonly string[],
): string[] {
  const before = new Set(prev ?? []);
  return next.filter((n) => !before.has(n));
}

export async function checkSubdomains(
  domains: readonly string[],
  deps: ExposureDeps,
  opts: { persist?: boolean } = {},
): Promise<ExposureResult> {
  const findings: ExposureFinding[] = [];
  const prev = readInventory(deps.home);
  const next: Record<string, string[]> = { ...prev?.domains };
  let total = 0;
  let fresh = 0;
  let failed = 0;
  const newNames: string[] = [];
  for (const [i, domain] of domains.entries()) {
    if (i > 0) {
      await deps.sleep(CT_INTERVAL_MS);
    }
    try {
      const res = await deps.http(crtShUrl(domain), {
        maxBytes: CT_MAX_BYTES,
        timeoutMs: CT_TIMEOUT_MS,
        headers: { accept: "application/json" },
      });
      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (res.truncated) {
        throw new Error(`answer larger than ${CT_MAX_BYTES} bytes`);
      }
      const names = parseCrtSh(res.body, domain);
      const added = diffSubdomains(prev?.domains?.[domain], names);
      next[domain] = names;
      total += names.length;
      // The first run of a domain is the baseline, not a list of new names.
      if (prev?.domains?.[domain]) {
        fresh += added.length;
        newNames.push(...added);
      }
    } catch (err) {
      failed += 1;
      findings.push({
        subject: domain,
        detail: `certificate transparency unavailable (${String((err as Error).message ?? err).slice(0, 120)}); inventory unknown`,
      });
    }
  }
  for (const n of newNames) {
    findings.push({
      subject: n,
      detail: "new subdomain in certificate transparency since last run",
    });
  }
  if (opts.persist !== false && failed < domains.length) {
    writeJsonFile(inventoryFile(deps.home), {
      updatedAt: deps.now().toISOString(),
      domains: next,
    } satisfies SubdomainInventory);
  }
  return {
    facts: {
      domains: domains.length,
      subdomains: total,
      newSubdomains: fresh,
      baseline: !prev,
      ctFailed: failed,
    },
    findings,
  };
}
