// Guardian exposure checks (docs/security/guardian.md, "Exposure check"), as the engine runs them:
// configuration and ownership verification first, then the check on verified domains only.
// Unconfigured, disabled, unverified, failed or incomplete is a finding (ESCALATE), never OK.

import type { GuardianConfig } from "../../config/types.guardian.js";
import { auditSafe } from "../../audit/audit-log.js";
import { resolveSecretStore } from "../../secrets/index.js";
import { checkDomainBreaches } from "./breaches.js";
import { checkCode } from "./code.js";
import {
  type ExposureDeps,
  type ExposureFinding,
  type ExposureResult,
  GITHUB_SECRET_NAME,
  HIBP_SECRET_NAME,
  VERIFY_TXT_PREFIX,
  defaultResolver,
  httpGet,
  realSleep,
  resolveExposureConfig,
  verifyDomains,
} from "./common.js";
import { crawlFindings, crawlSites } from "./crawl.js";
import { checkDnsPosture } from "./dns.js";
import { checkLookalikes } from "./lookalikes.js";
import { DEFAULT_PLATFORM_IDS, checkPeople } from "./people.js";
import { checkSubdomains, readInventory } from "./subdomains.js";

export const EXPOSURE_CHECK_NAMES = [
  "guardian_exposure_subdomains",
  "guardian_exposure_dns",
  "guardian_exposure_web_secrets",
  "guardian_exposure_lookalikes",
  "guardian_exposure_breaches",
  "guardian_exposure_code",
  "guardian_exposure_people",
] as const;

export type ExposureCheckName = (typeof EXPOSURE_CHECK_NAMES)[number];

/** Sites crawled per run besides each domain and its www host. */
const CRAWL_SUBDOMAIN_HOSTS_MAX = 50;

export function defaultExposureDeps(home: string): ExposureDeps {
  return {
    home,
    resolver: defaultResolver(),
    http: httpGet,
    sleep: realSleep,
    secret: (name) => {
      try {
        return resolveSecretStore({ home }).get(name) || undefined;
      } catch {
        return undefined;
      }
    },
    now: () => new Date(),
  };
}

const fail = (
  subject: string,
  detail: string,
  facts: ExposureResult["facts"] = {},
): ExposureResult => ({
  facts,
  findings: [{ subject, detail }],
});

/** Sites of the verified domains: apex, www and the CT inventory's hosts (bounded). */
export function siteHosts(verified: readonly string[], home: string): string[] {
  const inv = readInventory(home);
  const hosts = new Set<string>();
  for (const d of verified) {
    hosts.add(d);
    hosts.add(`www.${d}`);
  }
  const extra = verified
    .flatMap((d) => inv?.domains?.[d] ?? [])
    .filter((h) => !hosts.has(h))
    .slice(0, CRAWL_SUBDOMAIN_HOSTS_MAX);
  for (const h of extra) {
    hosts.add(h);
  }
  return [...hosts];
}

export async function runExposureCheck(
  name: ExposureCheckName,
  guardian: GuardianConfig,
  deps: ExposureDeps,
): Promise<ExposureResult> {
  const cfg = resolveExposureConfig(guardian.exposure);
  if (!cfg.enabled) {
    return fail("guardian.exposure", "exposure check is not enabled (guardian.exposure.enabled)", {
      enabled: false,
    });
  }
  const peopleCfg = guardian.exposure?.people;
  if (name === "guardian_exposure_people" && peopleCfg?.enabled !== true) {
    return fail(
      "guardian.exposure.people",
      "personal exposure is not enabled (guardian.exposure.people.enabled)",
      {
        enabled: false,
      },
    );
  }
  if (cfg.domains.length === 0 && name !== "guardian_exposure_people") {
    return fail("guardian.exposure.domains", "no domains are declared");
  }

  const checks = await verifyDomains(cfg.domains, { home: deps.home, resolver: deps.resolver });
  const verified = checks.filter((c) => c.verified).map((c) => c.domain);
  const notVerified: ExposureFinding[] = checks
    .filter((c) => !c.verified)
    .map((c) => ({
      subject: c.domain,
      detail: `domain not verified (TXT ${VERIFY_TXT_PREFIX}… or admin attestation)${c.error ? `; lookup ${c.error}` : ""}; nothing fetched`,
      rank: -1,
    }));
  const vFacts = { domainsVerified: verified.length, domainsUnverified: notVerified.length };
  const merge = (r: ExposureResult): ExposureResult => ({
    facts: { ...vFacts, ...r.facts },
    findings: [...notVerified, ...r.findings],
  });
  if (verified.length === 0 && name !== "guardian_exposure_people") {
    return { facts: vFacts, findings: notVerified };
  }

  switch (name) {
    case "guardian_exposure_subdomains":
      return merge(await checkSubdomains(verified, deps));
    case "guardian_exposure_dns": {
      const inv = readInventory(deps.home);
      const r = await checkDnsPosture(verified, inv?.domains ?? {}, deps.resolver);
      return merge(r);
    }
    case "guardian_exposure_web_secrets": {
      const r = await crawlSites({
        hosts: siteHosts(verified, deps.home),
        http: deps.http,
        sleep: deps.sleep,
        limits: cfg.crawl,
      });
      return merge({
        facts: {
          sites: r.sites,
          sitesUnreachable: r.sitesUnreachable,
          pages: r.pages,
          bytes: r.bytes,
          robotsBlocked: r.robotsBlocked,
          skippedType: r.skippedType,
          secrets: r.secrets.length,
          errors: r.errors.length,
          truncated: r.truncatedBy ?? false,
        },
        findings: crawlFindings(r),
      });
    }
    case "guardian_exposure_lookalikes":
      return merge(await checkLookalikes(verified, deps.resolver, cfg.lookalikes));
    case "guardian_exposure_breaches": {
      if (!cfg.hibp) {
        return fail(
          "guardian.exposure.hibp",
          "breach check is off (optional; enable hibp and set the HIBP key)",
          {
            enabled: false,
          },
        );
      }
      const key = deps.secret(HIBP_SECRET_NAME);
      if (!key) {
        return fail(
          "guardian.exposure.hibp",
          `no HIBP key in the secrets store (${HIBP_SECRET_NAME})`,
        );
      }
      const inScope = (d: string) => verified.some((v) => d === v || d.endsWith(`.${v}`));
      const emailDomains = (cfg.emailDomains.length ? cfg.emailDomains : verified).filter(inScope);
      const outOfScope = cfg.emailDomains.filter((d) => !inScope(d));
      const r = await checkDomainBreaches(emailDomains, deps, key);
      return merge({
        facts: r.facts,
        findings: [
          ...outOfScope.map((d) => ({
            subject: d,
            detail: "mail domain not under a verified domain; not searched",
          })),
          ...r.findings,
        ],
      });
    }
    case "guardian_exposure_code": {
      if (!cfg.github) {
        return fail(
          "guardian.exposure.github",
          "code search is off (optional; enable github and set the token)",
          {
            enabled: false,
          },
        );
      }
      const token = deps.secret(GITHUB_SECRET_NAME);
      if (!token) {
        return fail(
          "guardian.exposure.github",
          `no GitHub token in the secrets store (${GITHUB_SECRET_NAME})`,
        );
      }
      return merge(await checkCode(verified, cfg.brandTerms, deps, token));
    }
    case "guardian_exposure_people": {
      const hibpKey = peopleCfg?.hibp?.enabled ? deps.secret(HIBP_SECRET_NAME) : undefined;
      const r = await checkPeople(deps, {
        platforms: peopleCfg?.platforms?.length ? peopleCfg.platforms : DEFAULT_PLATFORM_IDS,
        retentionDays: peopleCfg?.retentionDays ?? 30,
        hibpKey,
        siteHosts: verified.length ? siteHosts(verified, deps.home) : [],
        crawl: cfg.crawl,
      });
      if (Number(r.facts.purged) > 0) {
        void auditSafe({
          action: "guardian.exposure.people.purge",
          outcome: "ok",
          source: "guardian.check",
          detail: { purged: r.facts.purged },
        });
      }
      const extra: ExposureFinding[] =
        peopleCfg?.hibp?.enabled && !hibpKey
          ? [
              {
                subject: "guardian.exposure.people.hibp",
                detail: `no HIBP key in the secrets store (${HIBP_SECRET_NAME})`,
              },
            ]
          : [];
      // Unverified domains only limit the web part; they are reported, never searched.
      return {
        facts: { ...vFacts, ...r.facts },
        findings: [...r.findings, ...extra, ...notVerified],
      };
    }
  }
  return fail(name, "unknown exposure check");
}
