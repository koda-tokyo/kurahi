// Tool-facing API: the read-only operations an agent calls. Each loads the cached index for
// the path (rebuilding it when a source file changed) and answers from facts only. The design
// document and the wave plan are also saved in the analyser's cache folder, its only writes.

import type { LegacyIndex } from "./types.js";
import { cacheFileFor, loadFreshIndex, resolveCacheDir, saveIndex, writeInCache } from "./cache.js";
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
