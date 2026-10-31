// guardian_exposure_lookalikes: typo, homoglyph, TLD-swap and hyphenation permutations of each
// verified domain (bounded), resolved with DNS only. Registered lookalikes with MX records come
// first: they can receive replies to phishing mail. Nothing beyond DNS is asked of a lookalike;
// its website is never fetched.

import {
  type ExposureFinding,
  type ExposureResolver,
  type ExposureResult,
  isValidDomain,
  mapLimit,
  records,
} from "./common.js";

/** Two-label public suffixes common for our customers (a full PSL is not needed for this). */
const TWO_LABEL_SUFFIXES = new Set([
  "co.jp",
  "ne.jp",
  "or.jp",
  "ac.jp",
  "go.jp",
  "ed.jp",
  "lg.jp",
  "gr.jp",
  "ad.jp",
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "co.uk",
  "org.uk",
  "com.au",
  "co.nz",
  "co.za",
  "com.sg",
  "com.cn",
  "com.tw",
  "co.kr",
  "com.mx",
]);

const TLD_SWAPS = [
  "com",
  "net",
  "org",
  "jp",
  "co.jp",
  "co",
  "io",
  "info",
  "biz",
  "xyz",
  "app",
  "online",
  "site",
  "shop",
  "top",
  "com.br",
  "cc",
  "me",
];

const HOMOGLYPHS: Record<string, string[]> = {
  a: ["4"],
  b: ["d", "6"],
  d: ["b", "cl"],
  e: ["3"],
  g: ["q", "9"],
  i: ["1", "l", "j"],
  l: ["1", "i"],
  m: ["rn", "nn"],
  n: ["m", "r"],
  o: ["0"],
  q: ["g"],
  s: ["5"],
  t: ["7"],
  u: ["v"],
  v: ["u"],
  w: ["vv"],
  z: ["2"],
};

const QWERTY_ROWS = ["1234567890", "qwertyuiop", "asdfghjkl", "zxcvbnm"];

function adjacentKeys(c: string): string[] {
  const out: string[] = [];
  QWERTY_ROWS.forEach((row, r) => {
    const i = row.indexOf(c);
    if (i < 0) {
      return;
    }
    for (const [dr, di] of [
      [0, -1],
      [0, 1],
      [-1, 0],
      [1, 0],
    ]) {
      const ch = QWERTY_ROWS[r + dr]?.[i + di];
      if (ch) {
        out.push(ch);
      }
    }
  });
  return out;
}

/** `name` + `suffix` of a registrable domain: `kodasoken` + `com`, `example` + `co.jp`. */
export function splitDomain(domain: string): { name: string; suffix: string } | null {
  const labels = domain.split(".");
  if (labels.length < 2) {
    return null;
  }
  const two = labels.slice(-2).join(".");
  if (labels.length >= 3 && TWO_LABEL_SUFFIXES.has(two)) {
    return { name: labels[labels.length - 3], suffix: two };
  }
  return { name: labels[labels.length - 2], suffix: labels[labels.length - 1] };
}

/**
 * Lookalike domains of `domain`, deterministic and at most `max`, most dangerous kinds first:
 * TLD swaps, homoglyphs, omissions, hyphenation, repetitions, transpositions, adjacent keys.
 */
export function lookalikeDomains(domain: string, max: number): string[] {
  const parts = splitDomain(domain);
  if (!parts) {
    return [];
  }
  const { name, suffix } = parts;
  const out = new Set<string>();
  const add = (n: string, s = suffix) => {
    const d = `${n}.${s}`;
    if (out.size < max && n !== "" && d !== domain && isValidDomain(d)) {
      out.add(d);
    }
  };
  const names: string[][] = [[], [], [], [], [], [], [], []];
  for (const tld of TLD_SWAPS) {
    add(name, tld);
  }
  for (let i = 0; i < name.length; i++) {
    for (const g of HOMOGLYPHS[name[i]] ?? []) {
      names[0].push(name.slice(0, i) + g + name.slice(i + 1));
    }
    names[1].push(name.slice(0, i) + name.slice(i + 1)); // omission
    if (i > 0 && name[i] !== "-" && name[i - 1] !== "-") {
      names[2].push(`${name.slice(0, i)}-${name.slice(i)}`); // hyphenation
    }
    names[3].push(name.slice(0, i) + name[i] + name.slice(i)); // repetition
    if (i + 1 < name.length && name[i] !== name[i + 1]) {
      names[4].push(name.slice(0, i) + name[i + 1] + name[i] + name.slice(i + 2)); // swap
    }
    for (const k of adjacentKeys(name[i])) {
      names[5].push(name.slice(0, i) + k + name.slice(i + 1)); // adjacent key
    }
  }
  names[6].push(`www${name}`, `${name}-jp`, `${name}jp`, `${name}-login`, `secure-${name}`);
  if (name.includes("-")) {
    names[7].push(name.replace(/-/g, ""));
  }
  for (const group of names) {
    for (const n of group) {
      add(n);
    }
  }
  return [...out];
}

export type Lookalike = { domain: string; mx: number; a: boolean; ns: boolean };

/** Registered = any NS, A/AAAA or MX answer. A failed lookup is counted, never "not registered". */
export async function resolveLookalikes(
  candidates: readonly string[],
  r: ExposureResolver,
): Promise<{ registered: Lookalike[]; errors: number }> {
  let errors = 0;
  const results = await mapLimit(candidates, 8, async (domain): Promise<Lookalike | null> => {
    try {
      const [ns, mx, a4] = await Promise.all([
        records(() => r.resolveNs(domain)),
        records(() => r.resolveMx(domain)),
        records(() => r.resolve4(domain)),
      ]);
      const realMx = mx.filter((m) => m.exchange && m.exchange !== "."); // RFC 7505 null MX
      if (ns.length === 0 && realMx.length === 0 && a4.length === 0) {
        return null;
      }
      return { domain, mx: realMx.length, a: a4.length > 0, ns: ns.length > 0 };
    } catch {
      errors += 1;
      return null;
    }
  });
  const registered = results.filter((x): x is Lookalike => x !== null);
  registered.sort((x, y) => (y.mx > 0 ? 1 : 0) - (x.mx > 0 ? 1 : 0));
  return { registered, errors };
}

export async function checkLookalikes(
  domains: readonly string[],
  r: ExposureResolver,
  opts: { max: number; ignore?: readonly string[] },
): Promise<ExposureResult> {
  const ignore = new Set([...(opts.ignore ?? []), ...domains]);
  const candidates = [...new Set(domains.flatMap((d) => lookalikeDomains(d, opts.max)))].filter(
    (d) => !ignore.has(d),
  );
  const { registered, errors } = await resolveLookalikes(candidates, r);
  const findings: ExposureFinding[] = registered.map((l) => ({
    subject: l.domain,
    detail:
      l.mx > 0
        ? `registered lookalike WITH MX (${l.mx}): can send and receive phishing mail`
        : `registered lookalike (${l.a ? "has address" : "no address"}, no MX)`,
    rank: l.mx > 0 ? 0 : 1,
  }));
  if (errors > 0) {
    findings.push({
      subject: "lookalikes",
      detail: `${errors} lookup(s) failed; those lookalikes are unknown`,
      rank: 2,
    });
  }
  return {
    facts: {
      domains: domains.length,
      candidates: candidates.length,
      registered: registered.length,
      withMx: registered.filter((l) => l.mx > 0).length,
      lookupErrors: errors,
    },
    findings,
  };
}
