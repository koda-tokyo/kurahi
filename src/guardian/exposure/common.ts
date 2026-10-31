// Guardian exposure check (docs/security/guardian.md, "Exposure check"): what an attacker finds
// first about the organisation's OWN external footprint. Shared pieces: the declared-assets model,
// ownership verification, masking, the bounded HTTP client and the DNS resolver seam.
//
// Guardrails (non-negotiable): targets are only the apex domains the organisation declares
// (`guardian.exposure.domains`), each verified by a DNS TXT record or an admin attestation in the
// audit log before anything is fetched. Read-only, public sources only, rate limited, bounded in
// time and size, a clear User-Agent. A secret found is never stored or emitted in full: URL,
// line, detector, a masked preview (first 2 + last 2 characters) and its SHA-256.

import { createHash, randomBytes } from "node:crypto";
import dns from "node:dns";
import fs from "node:fs";
import path from "node:path";
import type { GuardianExposureConfig } from "../../config/types.guardian.js";
import { fetchWithSsrFGuard } from "../../infra/net/fetch-guard.js";

export const EXPOSURE_USER_AGENT = "Kurahi-Guardian-Exposure/2.6 (+https://kurahi.com/security/)";
export const VERIFY_TXT_PREFIX = "kurahi-exposure-verify=";

/** Secret store names for the optional keys (`kurahi secrets set <name>`). Never logged. */
export const HIBP_SECRET_NAME = "guardian.exposure.hibpApiKey";
export const GITHUB_SECRET_NAME = "guardian.exposure.githubToken";

export const DEFAULT_CRAWL_MAX_PAGES = 200;
export const DEFAULT_CRAWL_MAX_BYTES = 50 * 1024 ** 2;
export const DEFAULT_CRAWL_MAX_DEPTH = 3;
export const DEFAULT_LOOKALIKES_MAX = 300;
export const MAX_DOMAINS = 20;

const DOMAIN_RE =
  /^(?=.{1,253}$)(?:(?!-)[a-z0-9-]{1,63}(?<!-)\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Lowercase apex or host name: letters, digits and hyphens in dot-separated labels, no wildcard. */
export function isValidDomain(d: string): boolean {
  return DOMAIN_RE.test(d);
}

// ---- findings ---------------------------------------------------------------------------------

export type ExposureFinding = {
  /** What it is about: a domain, host, URL (`url:line`) or enrolment id. Never a secret value. */
  subject: string;
  detail: string;
  /** Sort key: lower first (e.g. lookalikes with MX before those without). */
  rank?: number;
};

export type ExposureResult = {
  facts: Record<string, string | number | boolean>;
  findings: ExposureFinding[];
};

// ---- masking ----------------------------------------------------------------------------------

/** First 2 + last 2 characters; short values show nothing. Never the value itself. */
export function maskValue(value: string): string {
  const chars = [...value];
  return chars.length < 8 ? "***" : `${chars.slice(0, 2).join("")}…${chars.slice(-2).join("")}`;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// ---- state ------------------------------------------------------------------------------------

export function exposureDir(home: string): string {
  return path.join(home, "guardian", "exposure");
}

export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

/** Atomic write, owner-only (0600): exposure state names the organisation's weak spots. */
export function writeJsonFile(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows: mode bits are advisory.
  }
}

// ---- ownership verification -------------------------------------------------------------------

export type DomainAttestation = { domain: string; by: string; at: string };

type VerifyState = { token: string; attestations: DomainAttestation[] };

function verifyFile(home: string): string {
  return path.join(exposureDir(home), "verify.json");
}

function readVerifyState(home: string): VerifyState | null {
  const s = readJsonFile<VerifyState>(verifyFile(home));
  return s && typeof s.token === "string" && /^[a-f0-9]{32}$/.test(s.token)
    ? { token: s.token, attestations: Array.isArray(s.attestations) ? s.attestations : [] }
    : null;
}

/** This installation's verification token (created on first use). */
export function exposureVerifyToken(home: string): string {
  const cur = readVerifyState(home);
  if (cur) {
    return cur.token;
  }
  const next: VerifyState = { token: randomBytes(16).toString("hex"), attestations: [] };
  writeJsonFile(verifyFile(home), next);
  return next.token;
}

/** The TXT record an organisation adds to prove a domain is its own. */
export function verifyTxtRecord(home: string): string {
  return `${VERIFY_TXT_PREFIX}${exposureVerifyToken(home)}`;
}

/**
 * Records an admin's attestation that the organisation owns `domain`. The caller writes the audit
 * entry with the admin's identity (the CLI does); this only keeps the local record.
 */
export function recordAttestation(home: string, domain: string, by: string, now = new Date()) {
  if (!isValidDomain(domain)) {
    throw new Error("not a valid lowercase domain");
  }
  if (!by.trim()) {
    throw new Error("an attestation needs the admin's identity");
  }
  exposureVerifyToken(home);
  const s = readVerifyState(home)!;
  const rest = s.attestations.filter((a) => a.domain !== domain);
  const entry = { domain, by: by.trim(), at: now.toISOString() };
  writeJsonFile(verifyFile(home), { ...s, attestations: [...rest, entry] });
  return entry;
}

export function revokeAttestation(home: string, domain: string): boolean {
  const s = readVerifyState(home);
  if (!s || !s.attestations.some((a) => a.domain === domain)) {
    return false;
  }
  writeJsonFile(verifyFile(home), {
    ...s,
    attestations: s.attestations.filter((a) => a.domain !== domain),
  });
  return true;
}

export type DomainVerification = {
  domain: string;
  verified: boolean;
  method: "dns-txt" | "attestation" | null;
  /** Why not verified (lookup error), when known. */
  error?: string;
};

/**
 * Verified when the domain publishes `kurahi-exposure-verify=<token>` in TXT, or an admin attested
 * it. Only a TXT lookup on the declared domain happens before verification.
 */
export async function verifyDomains(
  domains: readonly string[],
  opts: { home: string; resolver: ExposureResolver; attested?: readonly string[] },
): Promise<DomainVerification[]> {
  const state = readVerifyState(opts.home);
  const attested = new Set([
    ...(state?.attestations ?? []).map((a) => a.domain),
    ...(opts.attested ?? []),
  ]);
  const want = state ? `${VERIFY_TXT_PREFIX}${state.token}` : null;
  const out: DomainVerification[] = [];
  for (const domain of domains) {
    if (attested.has(domain)) {
      out.push({ domain, verified: true, method: "attestation" });
      continue;
    }
    if (!want) {
      out.push({ domain, verified: false, method: null, error: "no verification token yet" });
      continue;
    }
    try {
      const txt = (await opts.resolver.resolveTxt(domain)).map((parts) => parts.join(""));
      const ok = txt.some((t) => t.trim() === want);
      out.push({ domain, verified: ok, method: ok ? "dns-txt" : null });
    } catch (err) {
      out.push({ domain, verified: false, method: null, error: dnsCode(err) });
    }
  }
  return out;
}

// ---- DNS ----------------------------------------------------------------------------------------

/** The subset of node:dns/promises Resolver the checks use (a stub in tests). */
export type ExposureResolver = {
  resolveTxt(host: string): Promise<string[][]>;
  resolveMx(host: string): Promise<{ exchange: string; priority: number }[]>;
  resolveCaa(host: string): Promise<unknown[]>;
  resolveCname(host: string): Promise<string[]>;
  resolveNs(host: string): Promise<string[]>;
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
};

export function defaultResolver(): ExposureResolver {
  const r = new dns.promises.Resolver({ timeout: 4000, tries: 2 });
  return {
    resolveTxt: (h) => r.resolveTxt(h),
    resolveMx: (h) => r.resolveMx(h),
    resolveCaa: (h) => r.resolveCaa(h),
    resolveCname: (h) => r.resolveCname(h),
    resolveNs: (h) => r.resolveNs(h),
    resolve4: (h) => r.resolve4(h),
    resolve6: (h) => r.resolve6(h),
  };
}

export const dnsCode = (err: unknown) => (err as NodeJS.ErrnoException)?.code ?? "error";

/** NXDOMAIN / no records of that type: an answer, not a failure. */
export function isNoData(err: unknown): boolean {
  const c = dnsCode(err);
  return c === "ENOTFOUND" || c === "ENODATA" || c === dns.NOTFOUND || c === dns.NODATA;
}

/** Records of one type: [] when the name has none, throws on a lookup failure. */
export async function records<T>(fn: () => Promise<T[]>): Promise<T[]> {
  try {
    return await fn();
  } catch (err) {
    if (isNoData(err)) {
      return [];
    }
    throw err;
  }
}

// ---- HTTP -----------------------------------------------------------------------------------------

export type HttpResponse = {
  status: number;
  /** Lowercased header names. */
  headers: Record<string, string>;
  body: string;
  /** True when the body was cut at `maxBytes`. */
  truncated: boolean;
};

export type HttpGet = (
  url: string,
  opts?: { headers?: Record<string, string>; maxBytes?: number; timeoutMs?: number },
) => Promise<HttpResponse>;

const DEFAULT_RESPONSE_MAX = 2 * 1024 ** 2;
const DEFAULT_TIMEOUT_MS = 15_000;

async function readBody(res: Response, max: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) {
    return { text: "", truncated: false };
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    const room = max - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated };
}

/**
 * Default GET: https only, SSRF-guarded (no private addresses), never follows a redirect (a 3xx is
 * returned with its `location` header for the caller to judge), bounded in time and size, with
 * the exposure User-Agent.
 */
export const httpGet: HttpGet = async (url, opts = {}) => {
  if (!url.startsWith("https://")) {
    throw new Error("only https URLs are fetched");
  }
  // fetchWithSsrFGuard refuses redirects with maxRedirects 0 but loses the location; this wrapper
  // hands the 3xx back as a marked non-redirect response instead.
  const passThrough = async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await fetch(input, init);
    if (res.status >= 300 && res.status < 400) {
      void res.body?.cancel();
      return new Response(null, {
        status: 200,
        headers: {
          "x-kurahi-status": String(res.status),
          "x-kurahi-location": res.headers.get("location") ?? "",
        },
      });
    }
    return res;
  };
  const { response, release } = await fetchWithSsrFGuard({
    url,
    fetchImpl: passThrough,
    maxRedirects: 0,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    init: { headers: { "user-agent": EXPOSURE_USER_AGENT, ...opts.headers } },
  });
  try {
    const marked = response.headers.get("x-kurahi-status");
    if (marked) {
      const loc = response.headers.get("x-kurahi-location");
      return {
        status: Number(marked),
        headers: loc ? { location: loc } : {},
        body: "",
        truncated: false,
      };
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const { text, truncated } = await readBody(response, opts.maxBytes ?? DEFAULT_RESPONSE_MAX);
    return { status: response.status, headers, body: text, truncated };
  } finally {
    await release();
  }
};

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Spaces calls per key (host) at least `intervalMs` apart. */
export function rateLimiter(intervalMs: number, sleep: Sleep) {
  const last = new Map<string, number>();
  return async (key: string) => {
    const prev = last.get(key);
    const now = Date.now();
    if (prev !== undefined && now - prev < intervalMs) {
      await sleep(intervalMs - (now - prev));
    }
    last.set(key, Date.now());
  };
}

/** Run `fn` over `items` with at most `n` in flight; results keep input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  n: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = Array.from<R>({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

// ---- dependencies ---------------------------------------------------------------------------------

/** Everything an exposure check touches outside the process; all injectable for tests. */
export type ExposureDeps = {
  home: string;
  resolver: ExposureResolver;
  http: HttpGet;
  sleep: Sleep;
  /** A named secret from the secrets store, or undefined. */
  secret: (name: string) => string | undefined;
  now: () => Date;
};

export type ResolvedExposureConfig = {
  enabled: boolean;
  domains: string[];
  emailDomains: string[];
  brandTerms: string[];
  crawl: { maxPages: number; maxBytes: number; maxDepth: number };
  lookalikes: { max: number; ignore: string[] };
  hibp: boolean;
  github: boolean;
};

export function resolveExposureConfig(
  cfg: GuardianExposureConfig | undefined,
): ResolvedExposureConfig {
  return {
    enabled: cfg?.enabled === true,
    domains: [...new Set(cfg?.domains ?? [])],
    emailDomains: [...new Set(cfg?.emailDomains ?? [])],
    brandTerms: [...new Set(cfg?.brandTerms ?? [])],
    crawl: {
      maxPages: cfg?.crawl?.maxPages ?? DEFAULT_CRAWL_MAX_PAGES,
      maxBytes: cfg?.crawl?.maxBytes ?? DEFAULT_CRAWL_MAX_BYTES,
      maxDepth: cfg?.crawl?.maxDepth ?? DEFAULT_CRAWL_MAX_DEPTH,
    },
    lookalikes: {
      max: cfg?.lookalikes?.max ?? DEFAULT_LOOKALIKES_MAX,
      ignore: cfg?.lookalikes?.ignore ?? [],
    },
    hibp: cfg?.hibp?.enabled === true,
    github: cfg?.github?.enabled === true,
  };
}
