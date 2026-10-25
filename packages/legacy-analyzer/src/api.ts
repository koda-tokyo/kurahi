// Tool-facing API: the read-only operations an agent calls. Each loads the cached index for
// the path (rebuilding it when a source file changed) and answers from facts only. The design
// document and the wave plan are also saved in the analyser's cache folder, its only writes.

import type { LegacyIndex } from "./types.js";
import { cacheFileFor, loadFreshIndex, resolveCacheDir, saveIndex, writeInCache } from "./cache.js";
import {
  buildSnapshot,
  compareSnapshots,
  readSnapshot,
  type Snapshot,
  writeSnapshot,
} from "./changes.js";
import { type DesignDocOptions, designDoc } from "./design-doc.js";
import { dictionary } from "./dictionary.js";
import { type DocLang } from "./doc-i18n.js";
import { GRAPH_QUERY_KINDS, runGraphQuery } from "./graph-query.js";
import { buildGraph } from "./graph.js";
import { impact } from "./impact.js";
import { buildIndex } from "./indexer.js";
import { analyseProject } from "./modernise/project.js";
import { QUERY_KINDS, runQuery, summary } from "./query.js";
import { rules } from "./rules.js";
import { renderWavePlan } from "./wave-plan-md.js";
import { wavePlan } from "./wave-plan.js";

/** Every kind `legacyQuery` answers: index queries and knowledge-graph queries. */
export const ALL_QUERY_KINDS: string[] = [...QUERY_KINDS, ...GRAPH_QUERY_KINDS];

export type LegacyEnv = { stateDir: string };

export function getIndex(
  root: string,
  env: LegacyEnv,
  opts: { rebuild?: boolean } = {},
): { index: LegacyIndex; cacheFile: string; cached: boolean } {
  const cacheDir = resolveCacheDir(root, env.stateDir);
  if (!opts.rebuild) {
    const hit = loadFreshIndex(root, cacheDir);
    if (hit) {
      return { index: hit, cacheFile: cacheFileFor(cacheDir, root), cached: true };
    }
  }
  const index = buildIndex(root);
  const cacheFile = saveIndex(index, cacheDir);
  return { index, cacheFile, cached: false };
}

export function legacyIndex(root: string, env: LegacyEnv) {
  const { index, cacheFile } = getIndex(root, env, { rebuild: true });
  return { cacheFile, ...summary(index) };
}

export function legacyQuery(
  root: string,
  kind: string,
  args: Record<string, unknown>,
  env: LegacyEnv,
) {
  const index = getIndex(root, env).index;
  if ((GRAPH_QUERY_KINDS as readonly string[]).includes(kind)) {
    return runGraphQuery(buildGraph(index), kind, args);
  }
  if (!(QUERY_KINDS as readonly string[]).includes(kind)) {
    throw new Error(`Unknown query kind "${kind}". Known kinds: ${ALL_QUERY_KINDS.join(", ")}.`);
  }
  return runQuery(index, kind, args);
}

function docName(base: string, parts: Array<string | undefined>): string {
  const tag = parts
    .filter((p): p is string => Boolean(p))
    .map((p) => p.replace(/[^A-Za-z0-9-]/g, "_"))
    .join("-");
  return `${base}${tag ? `-${tag}` : ""}.md`;
}

export function legacyDesignDoc(root: string, opts: DesignDocOptions, env: LegacyEnv) {
  const index = getIndex(root, env).index;
  const doc = designDoc(index, { ...opts, poly: opts.poly ?? analyseProject(index) });
  const all = !opts.sections || opts.sections.length === 0;
  const savedTo = writeInCache(
    resolveCacheDir(root, env.stateDir),
    docName(`design-doc-${doc.lang}`, [
      opts.program?.toUpperCase(),
      all ? undefined : doc.sections.join("_"),
    ]),
    doc.markdown,
  );
  return {
    lang: doc.lang,
    sections: doc.sections,
    stats: doc.stats,
    savedTo,
    markdown: doc.markdown,
  };
}

export function legacyWavePlan(root: string, lang: DocLang | undefined, env: LegacyEnv) {
  const index = getIndex(root, env).index;
  const l = lang ?? "ja";
  const markdown = renderWavePlan(index, l);
  const plan = wavePlan(index);
  const savedTo = writeInCache(resolveCacheDir(root, env.stateDir), `wave-plan-${l}.md`, markdown);
  return {
    note: "Proposal for human review: computed from code dependencies and metrics only.",
    lang: l,
    savedTo,
    waves: plan.waves.map((w) => ({
      wave: w.number,
      groups: w.groups.map((g) => ({
        programs: g.programs,
        cycle: g.cycle,
        risk: g.band,
        score: g.score,
      })),
    })),
    markdown,
  };
}

export const CHANGES_LIMIT = { default: 40, max: 200 };

/**
 * What changed since the baseline. First run (no baseline): the baseline is created from the
 * current sources and nothing is reported as a change. Every run also stores the snapshot it
 * compared as the candidate that legacyBaselineAdvance promotes.
 */
export function legacyChanges(
  root: string,
  opts: { limit?: number },
  env: LegacyEnv & { now?: () => Date },
) {
  const index = getIndex(root, env).index;
  const cacheDir = resolveCacheDir(root, env.stateDir);
  const now = env.now?.() ?? new Date();
  const current = buildSnapshot(index, analyseProject(index), now);
  const limit = Math.max(
    1,
    Math.min(CHANGES_LIMIT.max, Math.floor(opts.limit ?? CHANGES_LIMIT.default)),
  );
  const baseline = readSnapshot(cacheDir, root, "baseline");
  writeSnapshot(cacheDir, root, "candidate", current);
  if (!baseline) {
    const savedTo = writeSnapshot(cacheDir, root, "baseline", current);
    return {
      status: "baseline_created" as const,
      note: "No baseline existed: it was created from the current sources. Nothing is reported as a change; the next run compares against it.",
      baseline: { digest: current.digest, createdAt: current.createdAt, savedTo },
      current: { digest: current.digest },
      totals: current.totals,
    };
  }
  const report = compareSnapshots(baseline, current, limit);
  return {
    status: report.total === 0 ? ("unchanged" as const) : ("changed" as const),
    note:
      report.total === 0
        ? "No change since the baseline."
        : "Changes since the baseline, from the fact index. Counts are complete; the lists are bounded (see omitted).",
    baseline: { digest: baseline.digest, createdAt: baseline.createdAt },
    current: { digest: current.digest },
    totals: current.totals,
    ...report,
  };
}

/**
 * Move the baseline forward. By default to the candidate the last legacyChanges compared (when
 * `snapshot` is given it must be that candidate's digest); with `rebuild` to the current sources
 * (a person resetting the baseline).
 */
export function legacyBaselineAdvance(
  root: string,
  opts: { snapshot?: string; rebuild?: boolean },
  env: LegacyEnv & { now?: () => Date },
) {
  const cacheDir = resolveCacheDir(root, env.stateDir);
  const previous = readSnapshot(cacheDir, root, "baseline");
  let next: Snapshot;
  if (opts.rebuild) {
    const index = getIndex(root, env).index;
    next = buildSnapshot(index, analyseProject(index), env.now?.() ?? new Date());
  } else {
    const candidate = readSnapshot(cacheDir, root, "candidate");
    if (!candidate) {
      throw new Error(
        "No compared snapshot to advance to: run legacy_changes first (or pass rebuild: true to set the baseline from the current sources).",
      );
    }
    if (opts.snapshot && opts.snapshot !== candidate.digest) {
      throw new Error(
        `The last compared snapshot is ${candidate.digest}, not ${opts.snapshot}: legacy_changes ran again since. Run it again and advance to what it reports.`,
      );
    }
    next = candidate;
  }
  const unchanged = previous?.digest === next.digest;
  const savedTo = writeSnapshot(cacheDir, root, "baseline", next);
  return {
    status: unchanged ? ("unchanged" as const) : ("advanced" as const),
    previous: previous ? { digest: previous.digest, createdAt: previous.createdAt } : null,
    baseline: { digest: next.digest, createdAt: next.createdAt, savedTo },
    totals: next.totals,
  };
}

export function legacyRules(root: string, program: string | undefined, env: LegacyEnv) {
  const candidates = rules(getIndex(root, env).index, program);
  return {
    note: "Candidates only: exact source text and literal values. Their business meaning is not inferred.",
    count: candidates.length,
    candidates,
  };
}

export function legacyDictionary(root: string, copybook: string | undefined, env: LegacyEnv) {
  return dictionary(getIndex(root, env).index, copybook);
}

export function legacyImpact(
  root: string,
  item: string,
  program: string | undefined,
  env: LegacyEnv,
) {
  return impact(getIndex(root, env).index, item, program);
}
