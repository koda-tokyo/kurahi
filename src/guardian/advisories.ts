// Guardian advisories (Kurahi Guardian, Phase 2): JPCERT/CC and IPA security advisories for the
// morning brief, with the customer's products (`guardian.advisories.products`) named when an
// advisory mentions them.
//
// Read-only and allow-listed: only the official feed URLs below are fetched, never a URL from a
// caller, and a redirect elsewhere is refused. Each fetch is bounded in time and size. Feeds are
// RSS 1.0 (RDF), RSS 2.0 or Atom; a small extractor reads title, link and date from each item and
// refuses DTDs and entity declarations (no entity expansion), so nothing in a feed is interpreted
// beyond text. A feed that cannot be read is reported as unavailable, never as "no advisories".

import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../agents/tools/common.js";
import type { KoLoConfig } from "../config/config.js";
import { jsonResult } from "../agents/tools/common.js";
import { fetchWithSsrFGuard } from "../infra/net/fetch-guard.js";
import { wrapExternalContent } from "../security/external-content.js";

export type AdvisoryFeedId = "jpcert" | "ipa";

/**
 * The only URLs Guardian fetches. Checked 2026-10-30: both answer 200 application/rdf+xml with
 * an RSS 1.0 channel whose rdf:about is the URL itself.
 */
export const ADVISORY_FEEDS: Record<AdvisoryFeedId, { url: string; label: string }> = {
  // 注意喚起と緊急報告、Weekly Report の新着情報
  jpcert: { url: "https://www.jpcert.or.jp/rss/jpcert.rdf", label: "JPCERT/CC" },
  // 緊急対策情報・注意喚起（重要なセキュリティ情報）
  ipa: { url: "https://www.ipa.go.jp/security/alert-rss.rdf", label: "IPA" },
};

export type AdvisoryItem = {
  title: string;
  link: string;
  /** ISO 8601, or null when the feed gives no parseable date. */
  published: string | null;
  source: AdvisoryFeedId;
  /** Configured products the title names (as configured). */
  matches: string[];
};

export type AdvisoryFeedResult =
  | { source: AdvisoryFeedId; ok: true; items: AdvisoryItem[] }
  | { source: AdvisoryFeedId; ok: false; error: string };

const MAX_FEED_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_ITEMS = 200;
const TITLE_MAX = 300;
const LINK_MAX = 2048;

// ---- parsing ----

const PREDEFINED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Character data: CDATA unwrapped, the five predefined and numeric references decoded. */
function decodeText(raw: string): string {
  let out = "";
  let rest = raw;
  for (;;) {
    const start = rest.indexOf("<![CDATA[");
    const plain = start < 0 ? rest : rest.slice(0, start);
    out += plain
      .replace(/<[^<>]*>/g, " ")
      .replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, ref: string) => {
        if (ref.startsWith("#")) {
          const cp =
            ref[1] === "x" || ref[1] === "X"
              ? Number.parseInt(ref.slice(2), 16)
              : Number.parseInt(ref.slice(1), 10);
          return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
            ? String.fromCodePoint(cp)
            : "";
        }
        return PREDEFINED[ref] ?? m;
      });
    if (start < 0) {
      break;
    }
    const end = rest.indexOf("]]>", start + 9);
    // Markup inside CDATA (an HTML description) is text to us; tags are dropped all the same.
    out += (end < 0 ? rest.slice(start + 9) : rest.slice(start + 9, end)).replace(/<[^<>]*>/g, " ");
    if (end < 0) {
      break;
    }
    rest = rest.slice(end + 3);
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Content of the first `<name>` … `</name>` with indexOf scans (linear in the block). A
 * self-closing or unclosed element yields nothing.
 */
function element(block: string, names: string[]): string | null {
  for (const name of names) {
    const open = `<${name}`;
    let at = block.indexOf(open);
    while (at >= 0) {
      const next = block[at + open.length];
      if (next !== ">" && next !== " " && next !== "\t" && next !== "\n" && next !== "\r") {
        at = block.indexOf(open, at + 1);
        continue;
      }
      const gt = block.indexOf(">", at);
      if (gt < 0) {
        break;
      }
      if (block[gt - 1] === "/") {
        // Self-closing: resume after it, so no stretch of the block is scanned twice.
        at = block.indexOf(open, gt + 1);
        continue;
      }
      const end = block.indexOf(`</${name}`, gt + 1);
      if (end >= 0) {
        return block.slice(gt + 1, end);
      }
      break;
    }
  }
  return null;
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(tag);
  return m ? (m[2] ?? m[3] ?? "") : null;
}

function safeLink(raw: string | null): string {
  if (!raw) {
    return "";
  }
  const text = decodeText(raw);
  try {
    const u = new URL(text);
    return (u.protocol === "https:" || u.protocol === "http:") && text.length <= LINK_MAX
      ? u.toString()
      : "";
  } catch {
    return "";
  }
}

function itemLink(block: string): string {
  const text = element(block, ["link"]);
  if (text !== null && text.trim()) {
    return safeLink(text);
  }
  // Atom: <link href="…"/>, the alternate one when several are given.
  const tags = block.match(/<link\b[^<>]*>/gi) ?? [];
  const alt = tags.find((t) => (attr(t, "rel") ?? "alternate") === "alternate") ?? tags[0];
  return alt ? safeLink(attr(alt, "href")) : "";
}

function isoDate(raw: string | null): string | null {
  if (!raw) {
    return null;
  }
  const ms = Date.parse(decodeText(raw));
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Comments removed with indexOf scans; an unclosed comment drops the rest of the document. */
function stripComments(xml: string): string {
  let out = "";
  let from = 0;
  for (let at = xml.indexOf("<!--"); at >= 0; at = xml.indexOf("<!--", from)) {
    out += xml.slice(from, at);
    const end = xml.indexOf("-->", at + 4);
    if (end < 0) {
      return out;
    }
    from = end + 3;
  }
  return out + xml.slice(from);
}

/**
 * Bodies of `<item>` / `<entry>` elements, at most `max`, found with forward-only indexOf scans
 * (linear in the document, also on many unclosed tags). Items do not nest in RSS or Atom.
 */
export function itemBlocks(xml: string, max: number): string[] {
  const out: string[] = [];
  let pos = 0;
  while (out.length < max) {
    const lt = xml.indexOf("<", pos);
    if (lt < 0) {
      break;
    }
    const m = /^<(item|entry)[\s>]/.exec(xml.slice(lt, lt + 7));
    if (!m) {
      pos = lt + 1;
      continue;
    }
    const gt = xml.indexOf(">", lt);
    if (gt < 0) {
      break;
    }
    if (xml[gt - 1] === "/") {
      pos = gt + 1;
      continue;
    }
    const end = xml.indexOf(`</${m[1]}`, gt + 1);
    if (end < 0) {
      // Unclosed: every later item would end at the same missing tag; stop here.
      break;
    }
    out.push(xml.slice(gt + 1, end));
    const endGt = xml.indexOf(">", end);
    pos = endGt < 0 ? xml.length : endGt + 1;
  }
  return out;
}

/** Items of an RSS 1.0 / RSS 2.0 / Atom document. Throws on a DTD or a document that is no feed. */
export function parseAdvisoryFeed(xml: string, source: AdvisoryFeedId): AdvisoryItem[] {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("feed declares a DTD or entities");
  }
  const body = stripComments(xml);
  if (!/<(rdf:RDF|rss|feed)\b/.test(body)) {
    throw new Error("not an RSS or Atom feed");
  }
  const items: AdvisoryItem[] = [];
  for (const block of itemBlocks(body, MAX_ITEMS * 2)) {
    if (items.length >= MAX_ITEMS) {
      break;
    }
    const title = clip(decodeText(element(block, ["title"]) ?? ""), TITLE_MAX);
    if (!title) {
      continue;
    }
    items.push({
      title,
      link: itemLink(block),
      published: isoDate(element(block, ["dc:date", "pubDate", "published", "updated"])),
      source,
      matches: [],
    });
  }
  return items;
}

// ---- product matching ----

function norm(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * Products named in `text`, case-insensitively (full-width letters fold to ASCII). An ASCII
 * letter or digit next to the match means another word: `PHP` does not match `PHPMailer`.
 */
export function matchProducts(text: string, products: readonly string[]): string[] {
  const hay = norm(text);
  const out: string[] = [];
  for (const product of products) {
    const needle = norm(product.trim());
    if (!needle) {
      continue;
    }
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(hay)) {
      out.push(product);
    }
  }
  return out;
}

// ---- fetching ----

export type FetchFeedText = (url: string) => Promise<string>;

async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    throw new Error(`feed larger than ${max} bytes`);
  }
  if (!res.body) {
    return "";
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`feed larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
}

/** Default fetch: SSRF-guarded, no redirects, bounded time and size. */
export const fetchFeedText: FetchFeedText = async (url) => {
  const { response, finalUrl, release } = await fetchWithSsrFGuard({
    url,
    maxRedirects: 0,
    timeoutMs: FETCH_TIMEOUT_MS,
    init: { headers: { accept: "application/rdf+xml, application/rss+xml, application/xml" } },
  });
  try {
    if (finalUrl !== url) {
      throw new Error("redirected away from the allow-listed feed");
    }
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await readCapped(response, MAX_FEED_BYTES);
  } finally {
    await release();
  }
};

export async function fetchAdvisories(params: {
  feeds: readonly AdvisoryFeedId[];
  products?: readonly string[];
  fetchText?: FetchFeedText;
}): Promise<AdvisoryFeedResult[]> {
  const fetchText = params.fetchText ?? fetchFeedText;
  const products = params.products ?? [];
  return Promise.all(
    [...new Set(params.feeds)].map(async (source): Promise<AdvisoryFeedResult> => {
      const feed = ADVISORY_FEEDS[source];
      if (!feed) {
        return { source, ok: false, error: "not an allow-listed feed" };
      }
      try {
        const items = parseAdvisoryFeed(await fetchText(feed.url), source);
        for (const item of items) {
          item.matches = matchProducts(item.title, products);
        }
        return { source, ok: true, items };
      } catch (err) {
        return { source, ok: false, error: clip(String((err as Error)?.message ?? err), 200) };
      }
    }),
  );
}

// ---- gather tool ----

export const GUARDIAN_ADVISORIES_TOOL = "guardian_advisories";

const FEED_IDS = Object.keys(ADVISORY_FEEDS) as AdvisoryFeedId[];
const DAY = 86_400_000;

function formatAdvisories(
  results: AdvisoryFeedResult[],
  items: AdvisoryItem[],
  products: readonly string[],
): string {
  const lines: string[] = [];
  for (const r of results) {
    const label = ADVISORY_FEEDS[r.source]?.label ?? r.source;
    lines.push(
      r.ok
        ? `feed ${label}: ok (${r.items.length} items)`
        : `feed ${label}: UNAVAILABLE (${r.error}); advisories from it are unknown`,
    );
  }
  lines.push(
    products.length > 0
      ? `products watched: ${products.join(", ")}`
      : "products watched: none configured (guardian.advisories.products)",
  );
  lines.push("");
  if (items.length === 0) {
    lines.push("No advisories in this window from the feeds that answered.");
  }
  items.forEach((it, i) => {
    const label = ADVISORY_FEEDS[it.source].label;
    const flag = it.matches.length > 0 ? ` [MATCH: ${it.matches.join(", ")}]` : "";
    lines.push(`${i + 1}. ${label} ${it.published ?? "(no date)"}${flag}`);
    lines.push(`   ${it.title}`);
    if (it.link) {
      lines.push(`   ${it.link}`);
    }
  });
  return lines.join("\n");
}

/** Read tool for routines and the brief; offered when `guardian.advisories` is configured. */
export function createGuardianAdvisoriesTool(options: {
  config?: KoLoConfig;
  fetchText?: FetchFeedText;
  now?: () => number;
}): AnyAgentTool | null {
  const guardian = options.config?.guardian;
  const cfg = guardian?.advisories;
  if (!cfg || guardian?.enabled === false) {
    return null;
  }
  const configured = (cfg.feeds?.length ? cfg.feeds : FEED_IDS).filter((f) => f in ADVISORY_FEEDS);
  const products = cfg.products ?? [];
  const now = options.now ?? Date.now;
  return {
    label: "Guardian: security advisories",
    name: GUARDIAN_ADVISORIES_TOOL,
    description:
      "Recent JPCERT/CC and IPA security advisories (official allow-listed feeds), newest first, with the organisation's configured products flagged when an advisory names them. A feed that cannot be read is reported as unavailable. Read-only.",
    parameters: Type.Object({
      feeds: Type.Optional(
        Type.Array(Type.Union([Type.Literal("jpcert"), Type.Literal("ipa")]), { maxItems: 2 }),
      ),
      sinceDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 90 })),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      matchesOnly: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, args) => {
      const params = (args ?? {}) as Record<string, unknown>;
      const asked = Array.isArray(params.feeds)
        ? params.feeds.filter((f): f is AdvisoryFeedId => configured.includes(f as AdvisoryFeedId))
        : configured;
      const feeds = asked.length > 0 ? asked : configured;
      const sinceDays =
        typeof params.sinceDays === "number" ? Math.min(90, Math.max(1, params.sinceDays)) : 14;
      const limit =
        typeof params.limit === "number" ? Math.min(100, Math.max(1, params.limit)) : 30;
      const matchesOnly = params.matchesOnly === true;

      const results = await fetchAdvisories({ feeds, products, fetchText: options.fetchText });
      if (results.every((r) => !r.ok)) {
        const why = results.map((r) => `${r.source}: ${r.ok ? "" : r.error}`).join("; ");
        throw new Error(`advisory feeds unavailable (${why})`);
      }
      const cutoff = now() - sinceDays * DAY;
      const seen = new Set<string>();
      const items = results
        .flatMap((r) => (r.ok ? r.items : []))
        // An undated item is kept: dropping it could hide a current advisory.
        .filter((it) => !it.published || Date.parse(it.published) >= cutoff)
        .filter((it) => !matchesOnly || it.matches.length > 0)
        .filter((it) => {
          const key = `${it.source}\n${it.link || it.title}`;
          if (seen.has(key)) {
            return false;
          }
          seen.add(key);
          return true;
        })
        .toSorted((a, b) => (b.published ?? "").localeCompare(a.published ?? ""))
        .slice(0, limit);
      const text = wrapExternalContent(formatAdvisories(results, items, products), {
        source: "api",
        includeWarning: false,
      });
      const result = jsonResult({
        feeds: results.map((r) => (r.ok ? { source: r.source, ok: true } : r)),
        count: items.length,
        matches: items.filter((it) => it.matches.length > 0).length,
        items,
      });
      return { ...result, content: [{ type: "text" as const, text }] };
    },
  };
}
