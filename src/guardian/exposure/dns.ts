// guardian_exposure_dns: email and DNS posture of each verified domain with node:dns only: SPF
// present and not `+all`, DMARC present and enforcing, MX present, CAA (info), and dangling
// CNAMEs among the known subdomains that point at a takeover-prone provider whose target no
// longer resolves ("possible subdomain takeover"). A lookup that fails (timeout, SERVFAIL) is a
// finding: the answer is unknown, never fine.

import {
  type ExposureFinding,
  type ExposureResolver,
  type ExposureResult,
  dnsCode,
  isNoData,
  mapLimit,
  records,
} from "./common.js";

/**
 * Hosting suffixes where a CNAME left behind after the resource was deleted can be claimed by
 * someone else (the "can-i-take-over-xyz" class).
 */
export const TAKEOVER_SUFFIXES = [
  ".azurewebsites.net",
  ".cloudapp.net",
  ".cloudapp.azure.com",
  ".trafficmanager.net",
  ".blob.core.windows.net",
  ".azureedge.net",
  ".herokudns.com",
  ".herokuapp.com",
  ".github.io",
  ".s3.amazonaws.com",
  ".s3-website-us-east-1.amazonaws.com",
  ".elasticbeanstalk.com",
  ".vercel.app",
  ".netlify.app",
  ".netlify.com",
  ".pantheonsite.io",
  ".ghost.io",
  ".myshopify.com",
  ".surge.sh",
  ".bitbucket.io",
  ".fly.dev",
];

/** Known subdomains whose CNAME is followed per run. */
const CNAME_CHECK_MAX = 500;

export function takeoverProne(target: string): boolean {
  const t = target.toLowerCase().replace(/\.$/, "");
  return TAKEOVER_SUFFIXES.some(
    (s) => t.endsWith(s) || /\.s3[.-][a-z0-9-]+\.amazonaws\.com$/.test(t),
  );
}

export type DomainPosture = {
  spf: string | null;
  dmarc: string | null;
  dmarcPolicy: "none" | "quarantine" | "reject" | null;
  mx: number;
  caa: number;
};

/** The `p=` tag of a DMARC record, or null. */
export function dmarcPolicy(record: string): DomainPosture["dmarcPolicy"] {
  const m = /(?:^|;)\s*p\s*=\s*(none|quarantine|reject)\s*(?:;|$)/i.exec(record);
  return m ? (m[1].toLowerCase() as DomainPosture["dmarcPolicy"]) : null;
}

/** Posture findings for one domain from its TXT, DMARC, MX and CAA answers. */
export function judgePosture(domain: string, p: DomainPosture): ExposureFinding[] {
  const out: ExposureFinding[] = [];
  if (!p.spf) {
    out.push({ subject: domain, detail: "no SPF record: anyone can send mail as this domain" });
  } else if (/(^|\s)\+all(\s|$)/i.test(p.spf)) {
    out.push({
      subject: domain,
      detail: "SPF ends in +all: every server on the internet may send",
    });
  } else if (!/(^|\s)[-~?]?all(\s|$)/i.test(p.spf) && !/\bredirect=/i.test(p.spf)) {
    out.push({ subject: domain, detail: "SPF has no all mechanism or redirect" });
  }
  if (!p.dmarc) {
    out.push({
      subject: `_dmarc.${domain}`,
      detail: "no DMARC record: spoofed mail is not rejected",
    });
  } else if (p.dmarcPolicy === null) {
    out.push({ subject: `_dmarc.${domain}`, detail: "DMARC record has no valid p= policy" });
  } else if (p.dmarcPolicy === "none") {
    out.push({ subject: `_dmarc.${domain}`, detail: "DMARC policy is p=none (monitor only)" });
  }
  if (p.mx === 0) {
    out.push({ subject: domain, detail: "no MX record" });
  }
  return out;
}

async function domainPosture(domain: string, r: ExposureResolver): Promise<DomainPosture> {
  const txt = (await records(() => r.resolveTxt(domain))).map((p) => p.join(""));
  const spfs = txt.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  const dmarcTxt = (await records(() => r.resolveTxt(`_dmarc.${domain}`))).map((p) => p.join(""));
  const dmarc = dmarcTxt.find((t) => /^v=DMARC1\s*(;|$)/i.test(t.trim())) ?? null;
  const mx = await records(() => r.resolveMx(domain));
  const caa = await records(() => r.resolveCaa(domain));
  return {
    // Two SPF records are as bad as none (permerror); flag through the "no SPF" rule.
    spf: spfs.length === 1 ? spfs[0] : null,
    dmarc,
    dmarcPolicy: dmarc ? dmarcPolicy(dmarc) : null,
    mx: mx.length,
    caa: caa.length,
  };
}

/** Does `host` resolve to any address? null when the lookup itself failed. */
async function resolves(host: string, r: ExposureResolver): Promise<boolean | null> {
  let failed = false;
  for (const fn of [() => r.resolve4(host), () => r.resolve6(host)]) {
    try {
      if ((await fn()).length > 0) {
        return true;
      }
    } catch (err) {
      if (!isNoData(err)) {
        failed = true;
      }
    }
  }
  return failed ? null : false;
}

export type DanglingCname = { host: string; target: string };

/** Subdomains whose CNAME points at a takeover-prone provider and whose target does not resolve. */
export async function findDanglingCnames(
  hosts: readonly string[],
  r: ExposureResolver,
): Promise<{ dangling: DanglingCname[]; checked: number; errors: number }> {
  const list = hosts.slice(0, CNAME_CHECK_MAX);
  let errors = 0;
  const results = await mapLimit(list, 8, async (host): Promise<DanglingCname | null> => {
    let cnames: string[];
    try {
      cnames = await records(() => r.resolveCname(host));
    } catch {
      errors += 1;
      return null;
    }
    const target = cnames.find(takeoverProne);
    if (!target) {
      return null;
    }
    const ok = await resolves(target, r);
    if (ok === null) {
      errors += 1;
      return null;
    }
    return ok ? null : { host, target: target.toLowerCase().replace(/\.$/, "") };
  });
  return {
    dangling: results.filter((d): d is DanglingCname => d !== null),
    checked: list.length,
    errors,
  };
}

export async function checkDnsPosture(
  domains: readonly string[],
  subdomains: Record<string, readonly string[]>,
  r: ExposureResolver,
): Promise<ExposureResult> {
  const findings: ExposureFinding[] = [];
  let caa = 0;
  let lookupErrors = 0;
  for (const domain of domains) {
    try {
      const p = await domainPosture(domain, r);
      caa += p.caa > 0 ? 1 : 0;
      findings.push(...judgePosture(domain, p));
    } catch (err) {
      lookupErrors += 1;
      findings.push({
        subject: domain,
        detail: `DNS lookup failed (${dnsCode(err)}); posture unknown`,
      });
    }
  }
  const hosts = [...new Set(domains.flatMap((d) => subdomains[d] ?? []))].filter(
    (h) => !domains.includes(h),
  );
  const d = await findDanglingCnames(hosts, r);
  for (const x of d.dangling) {
    findings.push({
      subject: x.host,
      detail: `possible subdomain takeover: CNAME to ${x.target}, which does not resolve`,
      rank: 0,
    });
  }
  if (d.errors > 0) {
    lookupErrors += d.errors;
    findings.push({
      subject: "cname",
      detail: `${d.errors} CNAME lookup(s) failed; dangling records among them unknown`,
    });
  }
  findings.sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1));
  return {
    facts: {
      domains: domains.length,
      withCaa: caa,
      subdomainsChecked: d.checked,
      dangling: d.dangling.length,
      lookupErrors,
      inventory: hosts.length > 0,
    },
    findings,
  };
}
