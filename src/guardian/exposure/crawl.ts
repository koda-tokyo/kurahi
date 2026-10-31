// guardian_exposure_web_secrets: a polite crawl of the organisation's OWN public websites
// (https://<domain>, www.<domain> and verified subdomains), looking for keys, tokens and
// plaintext credentials an attacker would find first. The case that prompted it: a hospital page
// showing an insurer-portal login and password in plain text.
//
// Same-origin only (a link to another host is not followed; a redirect is followed only to a host
// in scope), robots.txt respected (unreachable robots.txt = nothing crawled on that site), HTML,
// JavaScript, JSON and text only, bounded pages, bytes and depth, one request per second per
// host. A value found is never kept: URL, line, detector, masked preview and SHA-256.

import { secretDetectors } from "../posture.js";
import {
  type ExposureFinding,
  type HttpGet,
  type Sleep,
  maskValue,
  rateLimiter,
  sha256Hex,
} from "./common.js";

// ---- robots.txt --------------------------------------------------------------------------------

type RobotsRule = { allow: boolean; path: string };

const ROBOTS_TOKEN = "kurahi-guardian-exposure";

/**
 * RFC 9309: the group naming our product token, else `*`; the longest matching rule wins, Allow
 * on a tie. `*` and `$` in paths are honoured.
 */
export function parseRobots(text: string): (pathAndQuery: string) => boolean {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let cur: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (cur && (key === "allow" || key === "disallow")) {
      if (key === "disallow" && value === "") {
        continue; // "Disallow:" allows everything
      }
      cur.rules.push({ allow: key === "allow", path: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && ROBOTS_TOKEN.startsWith(a)));
  const chosen = mine.length > 0 ? mine : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  const toRe = (p: string) =>
    new RegExp(
      `^${p
        .replace(/[.+?^{}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\\\$$|\$$/, "$")}`,
    );
  const compiled = rules.map((r) => ({ ...r, re: toRe(r.path), len: r.path.length }));
  return (p) => {
    let best: { allow: boolean; len: number } | null = null;
    for (const r of compiled) {
      if (r.re.test(p) && (!best || r.len > best.len || (r.len === best.len && r.allow))) {
        best = { allow: r.allow, len: r.len };
      }
    }
    return best ? best.allow : true;
  };
}

// ---- detection --------------------------------------------------------------------------------

export type SecretHit = {
  detector: string;
  /** 1-based line in the fetched body. */
  line: number;
  preview: string;
  sha256: string;
};

const LOGIN_LABEL = String.raw`(?:login|log-in|user\s?name|user\s?id|usu[aá]rio|usuario|e-?mail|ログイン\s?ID|ログインID|ユーザー\s?ID|ユーザーID|ユーザ名|ID)`;
const PASSWORD_LABEL = String.raw`(?:password|passwd|passcode|pwd|pass|senha|contrase[ñn]a|mot de passe|kennwort|パスワード|暗証番号|ﾊﾟｽﾜｰﾄﾞ)`;

/** Separator between a label and its value, after table cells were turned into ` : `. */
const SEP = String.raw`\s*(?:[:：=]|\s-\s|は)\s*`;

const PLAINTEXT_PASSWORD = new RegExp(
  `(?<![A-Za-z])${PASSWORD_LABEL}(?:\\s*\\([^)]{0,20}\\))?${SEP}([^\\s<>"'：:、。,;]{4,64})`,
  "giu",
);
const PLAINTEXT_LOGIN = new RegExp(
  `(?<![A-Za-z])${LOGIN_LABEL}${SEP}([^\\s<>"'：:、。,;]{3,64})`,
  "giu",
);
const PASSWORD_INPUT_VALUE =
  /<input\b(?=[^>]*\btype\s*=\s*["']?password\b)[^>]*\bvalue\s*=\s*["']([^"']{4,128})["']/gi;

/** Words that follow a password label in forms and help text, never a credential. */
const NOT_A_VALUE = new Set(
  [
    "required",
    "optional",
    "forgot",
    "forgotten",
    "reset",
    "change",
    "here",
    "field",
    "please",
    "enter",
    "input",
    "hidden",
    "your",
    "the",
    "and",
    "none",
    "null",
    "undefined",
    "true",
    "false",
    "type",
    "text",
    "password",
    "senha",
    "string",
    "example",
    "sample",
    "入力",
    "必須",
    "任意",
    "パスワード",
    "変更",
    "再設定",
    "忘れた方",
    "お忘れの方",
  ].map((w) => w.toLowerCase()),
);

const MATCHES_PER_LINE = 50;
/** Characters of one line searched (minified bundles are one long line). */
const LINE_MAX = 256 * 1024;

/** Redaction patterns that match any `key = value`; checked after the token formats. */
const GENERIC_DETECTORS = new Set(["env-assignment", "json-secret-field", "cli-secret-flag"]);

/**
 * A value a generic `key = value` pattern caught that looks like a credential, not code: minified
 * JavaScript gives `KEY:c,return` or `PASSWORD:e.password` on every page.
 */
export function tokenLike(value: string, inCode = false): boolean {
  if (!/^[A-Za-z0-9_\-+/=.~!@#$%^&*]{8,}$/.test(value)) {
    return false; // commas, brackets, quotes, semicolons: code
  }
  if (/^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/.test(value)) {
    return false; // a property chain
  }
  // In JavaScript and JSON every identifier, message and route sits next to some `key:`; there a
  // credential must look generated: long, letters and digits, not a path.
  return (
    !inCode ||
    (value.length >= 12 && /\d/.test(value) && /[A-Za-z]/.test(value) && !value.startsWith("/"))
  );
}

/** A value that plausibly is a real password, not a placeholder, label or template. */
export function plausibleCredential(value: string): boolean {
  const v = value.trim();
  if (v.length < 4 || NOT_A_VALUE.has(v.toLowerCase())) {
    return false;
  }
  if (/^([*•●xX.\-_])\1*$/u.test(v) || /^[$<{%[(]/.test(v) || /^\d{1,3}$/.test(v)) {
    return false;
  }
  // Japanese/Portuguese prose after the label ("パスワードを入力", "senha de acesso") is no value.
  if (/^[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}ー]+$/u.test(v)) {
    return false;
  }
  if (/^(de|do|da|para|of|for|is|was|を|は|が)$/i.test(v)) {
    return false;
  }
  // A real password mixes classes; a bare lowercase word is more likely prose.
  return /\d/.test(v) || /[^A-Za-z0-9]/.test(v) || (/[a-z]/.test(v) && /[A-Z]/.test(v));
}

/** Visible text of an HTML page with table cells joined as `label : value`, one line per block. */
export function htmlText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\/t[dh]>\s*<t[dh]\b[^>]*>/gi, " : ")
    .replace(/<\/dt>\s*<dd\b[^>]*>/gi, " : ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6]|dd|dt|section|article)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ");
}

function lineOf(body: string, value: string, fallbackIndex = -1): number {
  const at = body.indexOf(value);
  const idx = at >= 0 ? at : fallbackIndex;
  if (idx < 0) {
    return 0;
  }
  let line = 1;
  for (let i = 0; i < idx; i++) {
    if (body.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

function hit(body: string, detector: string, value: string, index = -1): SecretHit {
  return {
    detector,
    line: lineOf(body, value, index),
    preview: maskValue(value),
    sha256: sha256Hex(value),
  };
}

/**
 * Credentials in one fetched body: Kurahi's redaction patterns (keys, tokens, private keys) line
 * by line, a filled password input, and a password label next to a value in the visible text
 * (English, Portuguese, Spanish and Japanese labels), with a login next to it when there is one.
 */
export function detectSecrets(body: string, contentType: string): SecretHit[] {
  const hits: SecretHit[] = [];
  const seen = new Set<string>();
  // One finding per value: the most specific detector that saw it wins.
  const add = (h: SecretHit) => {
    if (!seen.has(h.sha256)) {
      seen.add(h.sha256);
      hits.push(h);
    }
  };
  const isHtml = /html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
  const isCode = !isHtml && /javascript|json/i.test(contentType);
  if (isHtml) {
    for (const m of body.matchAll(PASSWORD_INPUT_VALUE)) {
      if (plausibleCredential(m[1])) {
        add(hit(body, "password-input-value", m[1], m.index));
      }
    }
  }
  const text = isHtml ? htmlText(body) : /text\/plain/i.test(contentType) ? body : "";
  if (text) {
    for (const m of text.matchAll(PLAINTEXT_PASSWORD)) {
      const value = m[1];
      if (!plausibleCredential(value)) {
        continue;
      }
      // Look back a little for a login shown with it: the pair is the worse finding.
      const before = text.slice(Math.max(0, (m.index ?? 0) - 200), m.index);
      const login = [...before.matchAll(PLAINTEXT_LOGIN)].at(-1);
      add(hit(body, login ? "plaintext-login-password" : "plaintext-password", value));
    }
  }
  // Token formats before the generic assignment patterns, so a key is named by what it is.
  const detectors = secretDetectors().toSorted(
    (a, b) => Number(GENERIC_DETECTORS.has(a.name)) - Number(GENERIC_DETECTORS.has(b.name)),
  );
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].length > LINE_MAX ? lines[i].slice(0, LINE_MAX) : lines[i];
    for (const d of detectors) {
      // Minified code is one long line: look at every match, not only the first.
      const re = new RegExp(d.re.source, d.re.flags.includes("g") ? d.re.flags : `${d.re.flags}g`);
      let seenOnLine = 0;
      for (const m of line.matchAll(re)) {
        if (++seenOnLine > MATCHES_PER_LINE) {
          break;
        }
        const raw =
          d.name === "private-key"
            ? m[0]
            : (m.slice(1).findLast((g) => typeof g === "string" && g.length > 0) ?? m[0]);
        // In markup a value ends at the next tag (`Password: x</p>`).
        const value = d.name === "private-key" ? raw : raw.split("<")[0];
        if (d.name !== "private-key" && (value.length < 8 || !plausibleCredential(value))) {
          continue;
        }
        if (GENERIC_DETECTORS.has(d.name) && !tokenLike(value, isCode)) {
          continue;
        }
        add({ detector: d.name, line: i + 1, preview: maskValue(value), sha256: sha256Hex(value) });
      }
    }
  }
  return hits;
}

/** Exact occurrences of an enrolled person's verified identifier (personal exposure, consent). */
export type Needle = { id: string; kind: "email" | "phone"; value: string };

function needleFound(n: Needle, body: string, text: string): boolean {
  if (n.kind === "email") {
    return body.toLowerCase().includes(n.value.toLowerCase());
  }
  const digits = n.value.replace(/\D/g, "");
  if (digits.length < 8) {
    return false;
  }
  // Phone numbers are written with spaces, hyphens or brackets: compare digit runs.
  const runs = (text || body).match(/[+\d][\d\s().-]{6,24}\d/g) ?? [];
  return runs.some((r) => {
    const d = r.replace(/\D/g, "");
    return d === digits || (digits.length >= 10 && d.length >= 10 && d.endsWith(digits.slice(-10)));
  });
}

// ---- crawl --------------------------------------------------------------------------------------

export type CrawlLimits = {
  maxPages: number;
  maxBytes: number;
  maxDepth: number;
  /** Per response (default 2 MiB). */
  maxResponseBytes?: number;
  /** Minimum gap between requests to one host (default 1000 ms). */
  intervalMs?: number;
  /** Wall clock for the whole crawl (default 20 min). */
  deadlineMs?: number;
};

export type CrawlFinding = { url: string; hit: SecretHit };
export type NeedleFinding = { url: string; needle: string };

export type CrawlResult = {
  pages: number;
  bytes: number;
  sites: number;
  sitesUnreachable: number;
  robotsBlocked: number;
  skippedType: number;
  errors: { url: string; detail: string }[];
  truncatedBy: "maxPages" | "maxBytes" | "deadline" | null;
  secrets: CrawlFinding[];
  needles: NeedleFinding[];
};

const CRAWLABLE_TYPES =
  /^(text\/html|application\/xhtml\+xml|text\/plain|text\/javascript|application\/javascript|application\/x-javascript|application\/json|application\/ld\+json|text\/json)/i;
const SKIP_EXT =
  /\.(png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|pdf|zip|gz|tgz|rar|7z|exe|msi|dmg|iso|mp[34]|m4a|mov|avi|webm|ogg|wav|woff2?|ttf|otf|eot|css|docx?|xlsx?|pptx?)$/i;

/** Same-origin links and scripts of an HTML page, fragments removed. */
export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  const origin = new URL(base).origin;
  for (const m of html.matchAll(
    /<(?:a|link|script|iframe|frame|area)\b[^>]*?\s(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  )) {
    const raw = (m[1] ?? m[2] ?? m[3] ?? "").trim();
    if (!raw || /^(javascript|mailto|tel|data):/i.test(raw)) {
      continue;
    }
    try {
      const u = new URL(raw, base);
      u.hash = "";
      if (u.origin === origin && !SKIP_EXT.test(u.pathname)) {
        out.add(u.toString());
      }
    } catch {
      // not a URL
    }
  }
  return [...out];
}

function isHostUnreachable(err: unknown): boolean {
  const s =
    String((err as Error)?.message ?? err) + String((err as { cause?: unknown })?.cause ?? "");
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|certificate|CERT_|self.signed|Unable to resolve|private|blocked/i.test(
    s,
  );
}

/**
 * Crawl the sites at `hosts` (https only). Hosts outside `hosts` are never fetched, links are
 * followed only within the page's origin, and robots.txt is read first on each site.
 */
export async function crawlSites(params: {
  hosts: readonly string[];
  http: HttpGet;
  sleep: Sleep;
  limits: CrawlLimits;
  detectSecrets?: boolean;
  needles?: readonly Needle[];
  now?: () => number;
}): Promise<CrawlResult> {
  const { http, limits } = params;
  const now = params.now ?? Date.now;
  const started = now();
  const deadline = started + (limits.deadlineMs ?? 20 * 60_000);
  const perHost = rateLimiter(limits.intervalMs ?? 1000, params.sleep);
  const scope = new Set(params.hosts);
  const result: CrawlResult = {
    pages: 0,
    bytes: 0,
    sites: 0,
    sitesUnreachable: 0,
    robotsBlocked: 0,
    skippedType: 0,
    errors: [],
    truncatedBy: null,
    secrets: [],
    needles: [],
  };
  const robots = new Map<string, ((p: string) => boolean) | null>();
  const unreachable = new Set<string>();
  const seen = new Set<string>();
  const queue: { url: string; depth: number }[] = [];
  const enqueue = (url: string, depth: number) => {
    if (!seen.has(url) && depth <= limits.maxDepth) {
      seen.add(url);
      queue.push({ url, depth });
    }
  };
  for (const host of params.hosts) {
    enqueue(`https://${host}/`, 0);
  }

  const robotsFor = async (host: string) => {
    if (robots.has(host)) {
      return robots.get(host)!;
    }
    let rule: ((p: string) => boolean) | null;
    try {
      await perHost(host);
      const res = await http(`https://${host}/robots.txt`, { maxBytes: 512 * 1024 });
      if (res.status === 200) {
        rule = parseRobots(res.body);
      } else if (res.status >= 400 && res.status < 500) {
        rule = () => true; // RFC 9309: no robots.txt, everything allowed
      } else if (res.status >= 300 && res.status < 400) {
        // A redirected robots.txt: follow once within scope, else treat as absent.
        const loc = res.headers.location ? new URL(res.headers.location, `https://${host}/`) : null;
        if (loc && loc.protocol === "https:" && scope.has(loc.hostname)) {
          await perHost(loc.hostname);
          const r2 = await http(loc.toString(), { maxBytes: 512 * 1024 });
          rule = r2.status === 200 ? parseRobots(r2.body) : r2.status < 500 ? () => true : null;
        } else {
          rule = () => true;
        }
      } else {
        rule = null; // 5xx: RFC 9309 says assume complete disallow
      }
    } catch (err) {
      if (isHostUnreachable(err)) {
        unreachable.add(host);
      }
      rule = null;
    }
    if (!rule && !unreachable.has(host)) {
      // Unknown robots.txt means we may not crawl; the site is unread, which is not clean.
      result.errors.push({
        url: `https://${host}/robots.txt`,
        detail: "robots.txt unavailable; site not crawled",
      });
    }
    robots.set(host, rule);
    return rule;
  };

  const sitesSeen = new Set<string>();
  while (queue.length > 0) {
    if (result.pages >= limits.maxPages) {
      result.truncatedBy = "maxPages";
      break;
    }
    if (result.bytes >= limits.maxBytes) {
      result.truncatedBy = "maxBytes";
      break;
    }
    if (now() > deadline) {
      result.truncatedBy = "deadline";
      break;
    }
    const { url, depth } = queue.shift()!;
    const u = new URL(url);
    const host = u.hostname;
    if (!scope.has(host) || u.protocol !== "https:" || unreachable.has(host)) {
      continue;
    }
    const allow = await robotsFor(host);
    if (unreachable.has(host)) {
      continue;
    }
    sitesSeen.add(host);
    if (!allow) {
      result.robotsBlocked += 1;
      continue;
    }
    if (!allow(`${u.pathname}${u.search}`)) {
      result.robotsBlocked += 1;
      continue;
    }
    await perHost(host);
    let res: Awaited<ReturnType<HttpGet>>;
    try {
      res = await http(url, {
        maxBytes: Math.min(
          limits.maxResponseBytes ?? 2 * 1024 ** 2,
          limits.maxBytes - result.bytes,
        ),
        headers: {
          accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*;q=0.1",
        },
      });
    } catch (err) {
      if (depth === 0 && isHostUnreachable(err)) {
        unreachable.add(host);
        continue;
      }
      result.errors.push({ url, detail: String((err as Error)?.message ?? err).slice(0, 120) });
      continue;
    }
    if (res.status >= 300 && res.status < 400) {
      if (res.headers.location) {
        try {
          const next = new URL(res.headers.location, url);
          next.hash = "";
          if (next.protocol === "https:" && scope.has(next.hostname)) {
            enqueue(next.toString(), depth);
          }
        } catch {
          // a bad location is not followed
        }
      }
      continue;
    }
    if (res.status !== 200) {
      continue; // 404s and the like are not exposure
    }
    const type = res.headers["content-type"] ?? "";
    if (type && !CRAWLABLE_TYPES.test(type)) {
      result.skippedType += 1;
      continue;
    }
    result.pages += 1;
    result.bytes += Buffer.byteLength(res.body);
    if (params.detectSecrets !== false) {
      for (const h of detectSecrets(res.body, type)) {
        result.secrets.push({ url, hit: h });
      }
    }
    if (params.needles?.length) {
      const text = /html/i.test(type) ? htmlText(res.body) : res.body;
      for (const n of params.needles) {
        if (needleFound(n, res.body, text)) {
          result.needles.push({ url, needle: n.id });
        }
      }
    }
    if (/html/i.test(type) || (!type && /<html/i.test(res.body))) {
      for (const link of extractLinks(res.body, url)) {
        enqueue(link, depth + 1);
      }
    }
  }
  if (!result.truncatedBy && queue.length > 0 && result.pages >= limits.maxPages) {
    result.truncatedBy = "maxPages";
  }
  result.sites = sitesSeen.size;
  result.sitesUnreachable = unreachable.size;
  return result;
}

/** Crawl results as findings: `url:line detector preview sha256`; never a value. */
export function crawlFindings(r: CrawlResult): ExposureFinding[] {
  const findings: ExposureFinding[] = r.secrets.map((s) => ({
    subject: `${s.url}:${s.hit.line}`,
    detail: `possible ${s.hit.detector} preview=${s.hit.preview} sha256=${s.hit.sha256}`,
    rank: s.hit.detector.startsWith("plaintext-login") ? 0 : 1,
  }));
  findings.sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1));
  for (const e of r.errors.slice(0, 20)) {
    findings.push({ subject: e.url, detail: `fetch failed (${e.detail})`, rank: 2 });
  }
  if (r.errors.length > 20) {
    findings.push({
      subject: "crawl",
      detail: `${r.errors.length - 20} more fetch error(s)`,
      rank: 2,
    });
  }
  if (r.truncatedBy) {
    findings.push({
      subject: "crawl",
      detail: `crawl stopped at ${r.truncatedBy} after ${r.pages} page(s); the rest was not read`,
      rank: 3,
    });
  }
  return findings;
}
