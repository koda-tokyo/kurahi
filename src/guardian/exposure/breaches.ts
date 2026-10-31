// guardian_exposure_breaches (optional): Have I Been Pwned domain search for the organisation's
// verified mail domains. Off unless `guardian.exposure.hibp.enabled` and the key
// `guardian.exposure.hibpApiKey` is in the secrets store; the key is never logged. Facts carry
// counts per breach only; the affected addresses go to a restricted evidence file (0600) under
// the state dir, referenced by path.

import path from "node:path";
import { type ExposureDeps, type ExposureResult, exposureDir, writeJsonFile } from "./common.js";

const HIBP_BASE = "https://haveibeenpwned.com/api/v3";
const HIBP_INTERVAL_MS = 6500;

export function hibpDomainUrl(domain: string): string {
  return `${HIBP_BASE}/breacheddomain/${encodeURIComponent(domain)}`;
}

/** `{ alias: [breach, …] }` → accounts per breach name. Throws on any other shape. */
export function parseHibpDomain(json: string): {
  perBreach: Record<string, number>;
  aliases: Record<string, string[]>;
} {
  const data = JSON.parse(json) as unknown;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("HIBP answer is not an object");
  }
  const perBreach: Record<string, number> = {};
  const aliases: Record<string, string[]> = {};
  for (const [alias, breaches] of Object.entries(data as Record<string, unknown>)) {
    if (!Array.isArray(breaches)) {
      continue;
    }
    const names = breaches.filter((b): b is string => typeof b === "string").slice(0, 500);
    aliases[alias] = names;
    for (const b of names) {
      perBreach[b] = (perBreach[b] ?? 0) + 1;
    }
  }
  return { perBreach, aliases };
}

export function breachEvidenceFile(home: string, now: Date): string {
  return path.join(
    exposureDir(home),
    "evidence",
    `hibp-domains-${now.toISOString().slice(0, 10)}.json`,
  );
}

export async function checkDomainBreaches(
  emailDomains: readonly string[],
  deps: ExposureDeps,
  apiKey: string,
): Promise<ExposureResult & { evidence: string | null }> {
  const findings: ExposureResult["findings"] = [];
  const perBreach: Record<string, number> = {};
  const evidence: Record<string, Record<string, string[]>> = {};
  let accounts = 0;
  let failed = 0;
  for (const [i, domain] of emailDomains.entries()) {
    if (i > 0) {
      await deps.sleep(HIBP_INTERVAL_MS);
    }
    try {
      const res = await deps.http(hibpDomainUrl(domain), {
        headers: { "hibp-api-key": apiKey, accept: "application/json" },
        maxBytes: 20 * 1024 ** 2,
      });
      if (res.status === 404) {
        continue; // no breached address on this domain
      }
      if (res.status !== 200) {
        throw new Error(
          res.status === 401 || res.status === 403
            ? `HTTP ${res.status} (key invalid or domain not verified with HIBP)`
            : `HTTP ${res.status}`,
        );
      }
      const r = parseHibpDomain(res.body);
      accounts += Object.keys(r.aliases).length;
      for (const [b, n] of Object.entries(r.perBreach)) {
        perBreach[b] = (perBreach[b] ?? 0) + n;
      }
      evidence[domain] = r.aliases;
    } catch (err) {
      failed += 1;
      findings.push({
        subject: domain,
        detail: `breach search failed (${String((err as Error).message ?? err).slice(0, 120)})`,
      });
    }
  }
  let file: string | null = null;
  if (accounts > 0) {
    file = breachEvidenceFile(deps.home, deps.now());
    writeJsonFile(file, {
      checkedAt: deps.now().toISOString(),
      source: "haveibeenpwned.com",
      domains: evidence,
    });
  }
  for (const [b, n] of Object.entries(perBreach).toSorted((x, y) => y[1] - x[1])) {
    findings.push({ subject: b, detail: `${n} account(s) of the organisation in this breach` });
  }
  return {
    facts: {
      emailDomains: emailDomains.length,
      breaches: Object.keys(perBreach).length,
      accounts,
      failed,
      evidence: file ?? "",
    },
    findings,
    evidence: file,
  };
}
