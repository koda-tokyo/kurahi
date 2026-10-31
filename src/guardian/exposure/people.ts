// Personal exposure (with consent): executive and employee digital-risk protection. Purpose:
// protect enrolled people from phishing, impersonation and account takeover. It is NOT a people
// search: nothing runs for anyone who has not enrolled and consented, and only identifiers the
// person proved (or confirmed under their own verified email) are checked.
//
// Consent model:
//   - Enrolment is by the person, or by an admin naming a person who must confirm consent
//     themselves by entering a one-time code sent to (or relayed for) their email address.
//   - Each identifier is proven: email by that code; handles are declared by the person under
//     their verified email when they confirm; phone has no SMS path, so it is attestation-only,
//     marked unverified, and never checked.
//   - The consent record keeps who, which identifiers, which checks, when, and the consent text
//     version. Consent is revocable at any time: checks stop at once and everything stored about
//     the person is deleted after `retentionDays` (default 30). Every step is in the audit log.
//
// Never: searching anyone who has not enrolled, free-text name searches, people-search or data
// broker lookups, dossiers, face or photo search, family members or other third parties. Facts
// name the person by enrolment id only and never carry an email address or phone number.

import { randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import path from "node:path";
import {
  type ExposureDeps,
  type ExposureFinding,
  type ExposureResult,
  exposureDir,
  maskValue,
  rateLimiter,
  readJsonFile,
  sha256Hex,
  writeJsonFile,
} from "./common.js";
import { type CrawlLimits, type Needle, crawlSites } from "./crawl.js";

export const CONSENT_TEXT_VERSION = "2026-10-31.1";

export const PERSON_CHECKS = ["breaches", "handles", "impersonation", "web"] as const;
export type PersonCheck = (typeof PERSON_CHECKS)[number];

export type IdentifierKind = "email" | "phone" | "handle";

export type Identifier = {
  id: string;
  kind: IdentifierKind;
  value: string;
  verified: boolean;
  verifiedAt?: string;
  method?:
    | "email-code"
    | "relayed-email-code"
    | "declared-under-verified-email"
    | "attested-unverified";
  code?: { hash: string; salt: string; expiresAt: string; attempts: number; relayed: boolean };
};

export type Enrolment = {
  id: string;
  /** The person's Kurahi principal (device:/pair:/user id) when they have an account. */
  principal: string | null;
  enrolledBy: string;
  selfEnrolled: boolean;
  createdAt: string;
  consent: {
    state: "pending" | "given" | "revoked";
    textVersion: string;
    checks: PersonCheck[];
    givenAt?: string;
    givenBy?: string;
    revokedAt?: string;
    revokedBy?: string;
  };
  identifiers: Identifier[];
  /** Deleted with the record at purge. Restricted file (0600); never in facts. */
  results?: {
    at: string;
    facts: Record<string, string | number | boolean>;
    findings: ExposureFinding[];
  };
  purgeAfter?: string;
};

type PeopleState = { version: 1; people: Enrolment[] };

const CODE_TTL_MS = 30 * 60_000;
const CODE_MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@<>",;]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const HANDLE_RE = /^[a-z0-9][a-z0-9._-]{0,38}$/;
const PHONE_RE = /^\+?[\d\s().-]{8,24}$/;

export function peopleFile(home: string): string {
  return path.join(exposureDir(home), "people.json");
}

function load(home: string): PeopleState {
  const s = readJsonFile<PeopleState>(peopleFile(home));
  return s && Array.isArray(s.people) ? s : { version: 1, people: [] };
}

function save(home: string, s: PeopleState): void {
  writeJsonFile(peopleFile(home), s);
}

export function listEnrolments(home: string): Enrolment[] {
  return load(home).people;
}

export function getEnrolment(home: string, id: string): Enrolment | null {
  return load(home).people.find((p) => p.id === id) ?? null;
}

/** An enrolment as safe to show an admin: identifiers masked, codes never. */
export function redactedEnrolment(e: Enrolment) {
  return {
    id: e.id,
    principal: e.principal,
    selfEnrolled: e.selfEnrolled,
    enrolledBy: e.enrolledBy,
    createdAt: e.createdAt,
    consent: e.consent,
    identifiers: e.identifiers.map((i) => ({
      id: i.id,
      kind: i.kind,
      value: maskValue(i.value),
      verified: i.verified,
      method: i.method ?? null,
    })),
    purgeAfter: e.purgeAfter ?? null,
  };
}

export function normaliseIdentifier(kind: IdentifierKind, raw: string): string {
  const v = raw.trim();
  if (kind === "email") {
    const e = v.toLowerCase();
    if (!EMAIL_RE.test(e)) {
      throw new Error("not a plain email address");
    }
    return e;
  }
  if (kind === "phone") {
    if (!PHONE_RE.test(v) || v.replace(/\D/g, "").length < 8) {
      throw new Error("not a phone number");
    }
    return v.replace(/[^\d+]/g, "");
  }
  const h = v.replace(/^@/, "").toLowerCase();
  if (!HANDLE_RE.test(h)) {
    throw new Error("not a handle (letters, digits, . _ -)");
  }
  return h;
}

function newCode(
  now: Date,
  relayed: boolean,
): { code: string; record: NonNullable<Identifier["code"]> } {
  const code = String(randomInt(0, 100_000_000)).padStart(8, "0");
  const salt = randomBytes(16).toString("hex");
  return {
    code,
    record: {
      hash: sha256Hex(`${salt}:${code}`),
      salt,
      expiresAt: new Date(now.getTime() + CODE_TTL_MS).toISOString(),
      attempts: 0,
      relayed,
    },
  };
}

/** Delivers a one-time code to the address itself (e.g. through a mail connector). */
export type CodeSender = (to: string, code: string, enrolmentId: string) => Promise<void>;

export type EnrolResult = {
  enrolment: Enrolment;
  /**
   * Codes to relay when no sender delivered them: shown to the enrolling admin, who passes each
   * to the person; only the person may enter it (documented limitation of relay mode).
   */
  relayCodes: { identifierId: string; code: string }[];
};

/**
 * A pending enrolment. Nothing is checked until the person confirms with the code sent for their
 * email. At least one email is required: it is how the person proves who they are.
 */
export async function enrolPerson(params: {
  home: string;
  enrolledBy: string;
  selfEnrolled: boolean;
  principal?: string | null;
  identifiers: { kind: IdentifierKind; value: string }[];
  checks?: PersonCheck[];
  sender?: CodeSender;
  now?: Date;
}): Promise<EnrolResult> {
  const now = params.now ?? new Date();
  if (!params.enrolledBy.trim()) {
    throw new Error("enrolment needs the enrolling identity");
  }
  const ids: Identifier[] = [];
  const seen = new Set<string>();
  for (const raw of params.identifiers.slice(0, 20)) {
    const value = normaliseIdentifier(raw.kind, raw.value);
    const key = `${raw.kind}:${value}`;
    if (!seen.has(key)) {
      seen.add(key);
      ids.push({ id: `i${ids.length + 1}`, kind: raw.kind, value, verified: false });
    }
  }
  if (!ids.some((i) => i.kind === "email")) {
    throw new Error("enrolment needs the person's email address to confirm consent");
  }
  const checks = (params.checks?.length ? params.checks : [...PERSON_CHECKS]).filter((c) =>
    (PERSON_CHECKS as readonly string[]).includes(c),
  );
  const enrolment: Enrolment = {
    id: `pe-${randomBytes(6).toString("hex")}`,
    principal: params.principal ?? null,
    enrolledBy: params.enrolledBy.trim(),
    selfEnrolled: params.selfEnrolled,
    createdAt: now.toISOString(),
    consent: { state: "pending", textVersion: CONSENT_TEXT_VERSION, checks },
    identifiers: ids,
  };
  const relayCodes: EnrolResult["relayCodes"] = [];
  for (const i of ids.filter((x) => x.kind === "email")) {
    let delivered = false;
    const { code, record } = newCode(now, !params.sender);
    if (params.sender) {
      try {
        await params.sender(i.value, code, enrolment.id);
        delivered = true;
      } catch {
        delivered = false;
      }
    }
    i.code = { ...record, relayed: !delivered };
    if (!delivered) {
      relayCodes.push({ identifierId: i.id, code });
    }
  }
  const s = load(params.home);
  s.people.push(enrolment);
  save(params.home, s);
  return { enrolment, relayCodes };
}

function codeMatches(rec: NonNullable<Identifier["code"]>, code: string): boolean {
  const a = Buffer.from(sha256Hex(`${rec.salt}:${code.trim()}`), "hex");
  const b = Buffer.from(rec.hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The person confirms consent by entering the code for their email. That proves the email, and
 * handles they declared become checkable under it; a phone stays unverified (no SMS path).
 */
export function confirmConsent(params: {
  home: string;
  id: string;
  code: string;
  by: string;
  textVersion: string;
  now?: Date;
}): Enrolment {
  const now = params.now ?? new Date();
  const s = load(params.home);
  const e = s.people.find((p) => p.id === params.id);
  if (!e) {
    throw new Error("no such enrolment");
  }
  if (e.consent.state === "revoked") {
    throw new Error("consent was revoked; enrol again");
  }
  if (params.textVersion !== CONSENT_TEXT_VERSION) {
    throw new Error(`consent text version ${CONSENT_TEXT_VERSION} must be shown and accepted`);
  }
  const email = e.identifiers.find((i) => i.kind === "email" && i.code && !i.verified);
  if (!email?.code) {
    throw new Error("no pending email code");
  }
  if (
    Date.parse(email.code.expiresAt) < now.getTime() ||
    email.code.attempts >= CODE_MAX_ATTEMPTS
  ) {
    save(params.home, s);
    throw new Error("code expired or too many attempts; enrol again");
  }
  if (!codeMatches(email.code, params.code)) {
    email.code.attempts += 1;
    save(params.home, s);
    throw new Error("wrong code");
  }
  const relayed = email.code.relayed;
  delete email.code;
  email.verified = true;
  email.verifiedAt = now.toISOString();
  email.method = relayed ? "relayed-email-code" : "email-code";
  for (const i of e.identifiers) {
    if (i.kind === "handle") {
      i.verified = true;
      i.verifiedAt = now.toISOString();
      i.method = "declared-under-verified-email";
    } else if (i.kind === "phone") {
      i.verified = false;
      i.method = "attested-unverified";
    }
  }
  e.consent = {
    ...e.consent,
    state: "given",
    givenAt: now.toISOString(),
    givenBy: params.by,
  };
  save(params.home, s);
  return e;
}

/** Revocation stops checks at once; the record and its results are purged after retention. */
export function revokeConsent(params: {
  home: string;
  id: string;
  by: string;
  retentionDays: number;
  now?: Date;
}): Enrolment {
  const now = params.now ?? new Date();
  const s = load(params.home);
  const e = s.people.find((p) => p.id === params.id);
  if (!e) {
    throw new Error("no such enrolment");
  }
  e.consent = {
    ...e.consent,
    state: "revoked",
    revokedAt: now.toISOString(),
    revokedBy: params.by,
  };
  for (const i of e.identifiers) {
    delete i.code;
  }
  e.purgeAfter = new Date(
    now.getTime() + Math.max(0, params.retentionDays) * 86_400_000,
  ).toISOString();
  save(params.home, s);
  return e;
}

/** Deletes revoked enrolments past retention, and pending ones never confirmed in that time. */
export function purgeExpired(home: string, retentionDays: number, now = new Date()): string[] {
  const s = load(home);
  const keep: Enrolment[] = [];
  const purged: string[] = [];
  const pendingCutoff = now.getTime() - Math.max(1, retentionDays) * 86_400_000;
  for (const e of s.people) {
    const revokedDue = e.purgeAfter && Date.parse(e.purgeAfter) <= now.getTime();
    const pendingDue = e.consent.state === "pending" && Date.parse(e.createdAt) <= pendingCutoff;
    if (revokedDue || pendingDue) {
      purged.push(e.id);
    } else {
      keep.push(e);
    }
  }
  if (purged.length > 0) {
    save(home, { ...s, people: keep });
  }
  return purged;
}

/** The person's own latest results, for them (by principal) or the security role. */
export function resultsForPrincipal(home: string, principal: string) {
  return load(home)
    .people.filter((e) => e.principal === principal && e.consent.state === "given")
    .map((e) => ({ id: e.id, results: e.results ?? null }));
}

// ---- platforms ----------------------------------------------------------------------------------

export type Platform = {
  id: string;
  label: string;
  /** Public profile URL; existence is read from the status only (200 yes, 404 no). */
  profile: (handle: string) => string;
  handle: RegExp;
};

/**
 * Curated: public profile pages that answer 200/404 without a login. X, Instagram, Facebook,
 * LinkedIn and TikTok need a login or script to tell, so they are not checked.
 */
export const PLATFORMS: Platform[] = [
  {
    id: "github",
    label: "GitHub",
    profile: (h) => `https://github.com/${h}`,
    handle: /^[a-z0-9](?:[a-z0-9-]{0,38})$/,
  },
  {
    id: "gitlab",
    label: "GitLab",
    profile: (h) => `https://gitlab.com/${h}`,
    handle: /^[a-z0-9._-]{2,39}$/,
  },
  {
    id: "npm",
    label: "npm",
    profile: (h) => `https://www.npmjs.com/~${h}`,
    handle: /^[a-z0-9._-]{1,39}$/,
  },
  {
    id: "pypi",
    label: "PyPI",
    profile: (h) => `https://pypi.org/user/${h}/`,
    handle: /^[a-z0-9._-]{1,39}$/,
  },
  {
    id: "dockerhub",
    label: "Docker Hub",
    profile: (h) => `https://hub.docker.com/v2/users/${h}/`,
    handle: /^[a-z0-9]{4,30}$/,
  },
  {
    id: "keybase",
    label: "Keybase",
    profile: (h) => `https://keybase.io/${h}`,
    handle: /^[a-z0-9_]{2,16}$/,
  },
  { id: "devto", label: "DEV", profile: (h) => `https://dev.to/${h}`, handle: /^[a-z0-9_]{2,30}$/ },
  {
    id: "qiita",
    label: "Qiita",
    profile: (h) => `https://qiita.com/${h}`,
    handle: /^[a-z0-9_-]{3,32}$/,
  },
  {
    id: "zenn",
    label: "Zenn",
    profile: (h) => `https://zenn.dev/${h}`,
    handle: /^[a-z0-9_]{2,15}$/,
  },
  {
    id: "note",
    label: "note",
    profile: (h) => `https://note.com/${h}`,
    handle: /^[a-z0-9_]{3,16}$/,
  },
  {
    id: "hatena",
    label: "Hatena",
    profile: (h) => `https://profile.hatena.ne.jp/${h}/`,
    handle: /^[a-z][a-z0-9_-]{2,31}$/,
  },
];

export const DEFAULT_PLATFORM_IDS = PLATFORMS.map((p) => p.id);

/** Lookalike handles an impersonator might register; bounded, no change of the platform. */
export function handleVariants(handle: string): string[] {
  const out = new Set<string>();
  out.add(`${handle}_`);
  out.add(`${handle}1`);
  out.add(`${handle}-official`);
  out.add(`${handle}official`);
  out.add(`real${handle}`);
  const glyph =
    handle.replace(/o/, "0") !== handle ? handle.replace(/o/, "0") : handle.replace(/l|i/, "1");
  if (glyph !== handle) {
    out.add(glyph);
  }
  out.delete(handle);
  return [...out].slice(0, 6);
}

type Presence = "present" | "absent" | "unknown";

async function profilePresence(url: string, deps: ExposureDeps): Promise<Presence> {
  try {
    const res = await deps.http(url, { maxBytes: 64 * 1024, timeoutMs: 10_000 });
    return res.status === 200
      ? "present"
      : res.status === 404 || res.status === 410
        ? "absent"
        : "unknown";
  } catch {
    return "unknown";
  }
}

// ---- the check ----------------------------------------------------------------------------------

const HIBP_ACCOUNT = "https://haveibeenpwned.com/api/v3/breachedaccount";

export type PeopleCheckOptions = {
  platforms: readonly string[];
  retentionDays: number;
  hibpKey?: string;
  /** The organisation's verified sites, for the web check (reuses the crawler). */
  siteHosts: readonly string[];
  crawl: CrawlLimits;
};

/**
 * Runs the consented checks for every enrolment whose consent is given, on verified identifiers
 * only. Facts carry counts and platform names keyed by enrolment id; full results are stored in
 * the restricted people file for the person and the security role.
 */
export async function checkPeople(
  deps: ExposureDeps,
  opts: PeopleCheckOptions,
): Promise<ExposureResult> {
  const now = deps.now();
  const purged = purgeExpired(deps.home, opts.retentionDays, now);
  const state = load(deps.home);
  const active = state.people.filter((e) => e.consent.state === "given");
  const findings: ExposureFinding[] = [];
  const facts: ExposureResult["facts"] = {
    enrolled: state.people.length,
    consented: active.length,
    pending: state.people.filter((e) => e.consent.state === "pending").length,
    revoked: state.people.filter((e) => e.consent.state === "revoked").length,
    purged: purged.length,
    breachesCheck: opts.hibpKey ? "on" : "off",
  };
  if (active.length === 0) {
    findings.push({
      subject: "people",
      detail: "no consent: nobody has enrolled and confirmed, nothing checked",
    });
    return { facts, findings };
  }
  const platforms = PLATFORMS.filter((p) => opts.platforms.includes(p.id));
  const perHost = rateLimiter(2000, deps.sleep);
  const needles: Needle[] = [];

  for (const e of active) {
    const pf: ExposureFinding[] = [];
    const pFacts: Record<string, string | number | boolean> = {};
    const verified = e.identifiers.filter((i) => i.verified);
    const has = (c: PersonCheck) => e.consent.checks.includes(c);
    pFacts.verifiedIdentifiers = verified.length;
    pFacts.unverifiedIdentifiers = e.identifiers.length - verified.length;

    if (has("breaches") && opts.hibpKey) {
      let breaches = 0;
      for (const i of verified.filter((x) => x.kind === "email")) {
        await perHost("haveibeenpwned.com");
        try {
          const res = await deps.http(
            `${HIBP_ACCOUNT}/${encodeURIComponent(i.value)}?truncateResponse=true`,
            {
              headers: { "hibp-api-key": opts.hibpKey, accept: "application/json" },
              maxBytes: 1024 ** 2,
            },
          );
          if (res.status === 404) {
            continue;
          }
          if (res.status !== 200) {
            throw new Error(`HTTP ${res.status}`);
          }
          const list = JSON.parse(res.body) as { Name?: string }[];
          const names = Array.isArray(list)
            ? list.map((b) => String(b?.Name ?? "")).filter(Boolean)
            : [];
          breaches += names.length;
          if (names.length > 0) {
            pf.push({
              subject: e.id,
              detail: `${i.id} (email) in ${names.length} breach(es): ${names.slice(0, 10).join(", ")}`,
            });
          }
        } catch (err) {
          pf.push({
            subject: e.id,
            detail: `breach lookup failed (${String((err as Error).message ?? err).slice(0, 80)})`,
          });
        }
      }
      pFacts.breaches = breaches;
    }

    const handles = verified.filter((x) => x.kind === "handle");
    if (has("handles") || has("impersonation")) {
      const presentOn: string[] = [];
      let unknown = 0;
      for (const h of handles) {
        for (const p of platforms) {
          if (!p.handle.test(h.value)) {
            continue;
          }
          if (has("handles")) {
            await perHost(new URL(p.profile(h.value)).hostname);
            const r = await profilePresence(p.profile(h.value), deps);
            if (r === "present") {
              presentOn.push(p.label);
            } else if (r === "unknown") {
              unknown += 1;
            }
          }
          if (has("impersonation")) {
            for (const v of handleVariants(h.value).filter((x) => p.handle.test(x))) {
              await perHost(new URL(p.profile(v)).hostname);
              const r = await profilePresence(p.profile(v), deps);
              if (r === "present") {
                pf.push({
                  subject: e.id,
                  detail: `possible impersonation: a variant (${maskValue(v)}) of ${h.id} exists on ${p.label}`,
                });
              } else if (r === "unknown") {
                unknown += 1;
              }
            }
          }
        }
      }
      pFacts.handlesOn = [...new Set(presentOn)].join(",");
      pFacts.platformsInconclusive = unknown;
      if (unknown > 0) {
        pf.push({
          subject: e.id,
          detail: `${unknown} platform lookup(s) inconclusive (blocked or error)`,
        });
      }
    }

    if (has("web")) {
      for (const i of verified.filter((x) => x.kind === "email" || x.kind === "phone")) {
        needles.push({
          id: `${e.id}/${i.id}/${i.kind}`,
          kind: i.kind as "email" | "phone",
          value: i.value,
        });
      }
    }
    e.results = { at: now.toISOString(), facts: pFacts, findings: pf };
    findings.push(...pf);
  }

  if (needles.length > 0 && opts.siteHosts.length > 0) {
    const r = await crawlSites({
      hosts: opts.siteHosts,
      http: deps.http,
      sleep: deps.sleep,
      limits: opts.crawl,
      detectSecrets: false,
      needles,
    });
    const byNeedle = new Map<string, Set<string>>();
    for (const n of r.needles) {
      byNeedle.set(n.needle, (byNeedle.get(n.needle) ?? new Set()).add(n.url));
    }
    for (const [needle, urls] of byNeedle) {
      const [pid, iid, kind] = needle.split("/");
      const f = {
        subject: pid,
        detail: `${iid} (${kind}) published on ${urls.size} page(s) of the organisation's sites, e.g. ${[...urls][0]}`,
      };
      findings.push(f);
      active.find((e) => e.id === pid)?.results?.findings.push(f);
    }
    if (r.errors.length > 0 || r.truncatedBy) {
      findings.push({
        subject: "people-web",
        detail: `site scan incomplete (${r.errors.length} error(s)${r.truncatedBy ? `, stopped at ${r.truncatedBy}` : ""})`,
      });
    }
    facts.pagesScanned = r.pages;
  }
  save(deps.home, state);
  for (const e of active) {
    facts[`${e.id}`] =
      `findings=${e.results?.findings.length ?? 0} handlesOn=${e.results?.facts.handlesOn ?? ""}`;
  }
  return { facts, findings };
}
