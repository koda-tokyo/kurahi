#!/usr/bin/env node
// Family-internal check: fails when the product build would ship identifiers that belong to one
// private deployment (its body/biology state files, its private MCP tool names, its per-agent
// workspace folders, its agents' names used as ids) instead of to the Kurahi product.
//
// What is scanned is what ships:
//   - src/**/*.ts minus tests and test helpers (the tsconfig.json `exclude` list), and
//   - the dist file list: dist/ itself when it exists (paths + text of .js/.d.ts/.json/.md),
//     otherwise the list tsc would emit from those sources (paths only).
//
// Names of people and agents are matched through scripts/privacy-check.mjs (`scanText`), which
// keeps that list as digests so this repository never spells it out. This script adds the
// structural identifiers below.
//
// Deliberately NOT blocked: the bare word "sibling". `siblings[]` in the config, the
// `sibling.*` gateway methods and the TUI peer chat are product features (peer agents on one
// host), and "sibling" is also ordinary vocabulary (sibling files, DOM siblings).
//
// Exceptions live in `.family-internal-allow` at the repository root, one per line:
//   <src path> | <substring the flagged line must contain, or *> | <reason>
// A rule written for src/x/y.ts also covers dist/x/y.js and dist/x/y.d.ts.
//
// Usage:
//   node scripts/family-internal-check.mjs                scan this repository
//   node scripts/family-internal-check.mjs --root <dir>   scan another tree (tests)
// Exit codes: 0 clean, 1 findings, 2 usage error.

import fs from "node:fs";
import path from "node:path";
import { scanText as scanNames } from "./privacy-check.mjs";

export const PATTERNS = [
  { id: "body-state-file", re: /hormones\.json/i },
  { id: "body-state", re: /\bproprioception\b/i },
  { id: "body-state-dir", re: /["'`/\\]autonomic["'`/\\]/i },
  {
    id: "private-mcp-tool",
    re: /\bkolo_(?:biology_status|gateway_health|inbox_read|sibling_message|memory_recall)\b/,
  },
  { id: "private-mcp-module", re: /\breadBiologyStatus\b|kolo-server/ },
  // The removed gateway biology layer: its boot supervisor, signal type and /metrics gauges.
  {
    id: "body-state-runtime",
    re: /\bBiology(?:Signals|BootSupervisor|Manager)\b|\bbootV3Biology\b|\bbiology_(?:organ_health|pain_score|pain_level|hormones)\b/,
  },
];

const PATH_PATTERNS = [
  { id: "private-mcp-module", re: /^dist\/mcp\/(?:kolo-server|tools)\.(?:js|d\.ts|js\.map)$/ },
  { id: "body-state", re: /proprioception|hormones/i },
  { id: "body-state-runtime", re: /^dist\/gateway-v3\/biology\// },
];

const ALLOW_FILE = ".family-internal-allow";
const TEXT_EXT = /\.(?:js|mjs|cjs|d\.ts|json|md)$/;
const MAX_BYTES = 8 * 1024 * 1024;

function parseArgs(argv) {
  const opts = { root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") {
      opts.root = argv[++i];
    } else {
      console.error(`family-internal-check: unknown argument ${argv[i]}`);
      process.exit(2);
    }
  }
  return opts;
}

export function loadAllow(root) {
  const file = path.join(root, ALLOW_FILE);
  if (!fs.existsSync(file)) {
    return [];
  }
  const rules = [];
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const parts = line.split(" | ");
    const reason = parts.slice(2).join(" | ").trim();
    if (parts.length < 3 || !parts[0].trim() || !parts[1].trim() || reason.length < 10) {
      throw new Error(`bad ${ALLOW_FILE} line (want "path | match | reason"): ${line}`);
    }
    rules.push({ path: parts[0].trim(), match: parts[1].trim() });
  }
  return rules;
}

/** dist/a/b.js, dist/a/b.d.ts, dist/a/b.js.map → src/a/b.ts (allow rules are written for src). */
export function sourcePathOf(file) {
  const m = /^dist\/(.+?)(?:\.d\.ts|\.js\.map|\.js)$/.exec(file);
  return m ? `src/${m[1]}.ts` : file;
}

function isAllowed(rules, file, text) {
  const src = sourcePathOf(file);
  return rules.some(
    (r) => (r.path === file || r.path === src) && (r.match === "*" || text.includes(r.match)),
  );
}

/** Findings in one file's text: `{ line, id, text }`. */
export function scanSource(text) {
  const hits = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    for (const p of PATTERNS) {
      if (p.re.test(line)) {
        hits.push({ line: n + 1, id: p.id, text: line });
      }
    }
  }
  for (const h of scanNames(text)) {
    if (h.kind === "error") {
      hits.push({ line: h.line, id: "private-name", text: h.text });
    }
  }
  return hits;
}

export function scanPath(file) {
  return PATH_PATTERNS.filter((p) => p.re.test(file)).map((p) => p.id);
}

function walk(dir, rel, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      walk(path.join(dir, e.name), r, out);
    } else if (e.isFile()) {
      out.push(r);
    }
  }
}

function isShippedSource(rel) {
  return (
    rel.endsWith(".ts") &&
    !rel.endsWith(".test.ts") &&
    !rel.endsWith(".test.tsx") &&
    !rel.endsWith("/test-helpers.ts")
  );
}

/** Everything the release would contain, as repo-relative paths, plus whether dist is real. */
export function collectTargets(root) {
  const src = [];
  walk(path.join(root, "src"), "src", src);
  const sources = src.filter(isShippedSource);
  const distDir = path.join(root, "dist");
  if (fs.existsSync(distDir)) {
    const dist = [];
    walk(distDir, "dist", dist);
    const shipped = dist.filter(
      (f) =>
        !/\.test\.(?:js|d\.ts|js\.map)$/.test(f) &&
        !f.startsWith("dist/test-helpers/") &&
        !f.startsWith("dist/test-utils/"),
    );
    return { sources, dist: shipped, distBuilt: true };
  }
  const expected = sources.flatMap((f) => {
    const base = `dist/${f.slice(4, -3)}`;
    return [`${base}.js`, `${base}.d.ts`];
  });
  return { sources, dist: expected, distBuilt: false };
}

export function runCheck(root) {
  const rules = loadAllow(root);
  const { sources, dist, distBuilt } = collectTargets(root);
  const findings = [];
  const scanFile = (file) => {
    const abs = path.join(root, file);
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return;
    }
    if (st.size > MAX_BYTES) {
      return;
    }
    const text = fs.readFileSync(abs, "utf8");
    for (const h of scanSource(text)) {
      if (!isAllowed(rules, file, h.text)) {
        findings.push(`${file}:${h.line}: ${h.id}: ${h.text.trim().slice(0, 160)}`);
      }
    }
  };
  for (const file of sources) {
    scanFile(file);
  }
  for (const file of dist) {
    for (const id of scanPath(file)) {
      if (!isAllowed(rules, file, "*")) {
        findings.push(`${file}: ${id}: file would ship`);
      }
    }
    if (distBuilt && TEXT_EXT.test(file) && !file.endsWith(".js.map")) {
      scanFile(file);
    }
  }
  return { findings, scanned: sources.length + dist.length, distBuilt };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  let result;
  try {
    result = runCheck(path.resolve(opts.root));
  } catch (err) {
    console.error(`family-internal-check: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  const { findings, scanned, distBuilt } = result;
  const scope = distBuilt ? "src + built dist" : "src + expected dist list";
  if (findings.length > 0) {
    for (const f of findings.slice(0, 80)) {
      console.error(`  ${f}`);
    }
    if (findings.length > 80) {
      console.error(`  … and ${findings.length - 80} more`);
    }
    console.error(
      `family-internal-check: ${findings.length} finding(s) in ${scope}. Remove the private ` +
        `code from the product tree, or add "path | match | reason" to ${ALLOW_FILE}.`,
    );
    process.exit(1);
  }
  console.log(`family-internal-check: clean (${scanned} path(s), ${scope}).`);
}

if (process.argv[1]?.endsWith("family-internal-check.mjs")) {
  main();
}
