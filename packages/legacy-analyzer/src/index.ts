// @kodasoken/legacy-analyzer: deterministic static analysis of COBOL, copybooks and JCL.

export type * from "./types.js";
export {
  ALL_QUERY_KINDS,
  CHANGES_LIMIT,
  legacyBaselineAdvance,
  legacyChanges,
  legacyDesignDoc,
  legacyDictionary,
  legacyImpact,
  legacyIndex,
  legacyQuery,
  legacyRules,
  legacyWavePlan,
  getIndex,
} from "./api.js";
export type { LegacyEnv } from "./api.js";
export { CACHE_DIR_NAME, resolveCacheDir, writeInCache } from "./cache.js";
export {
  BASELINE_DIR_NAME,
  EDGE_KINDS,
  ENTITY_KINDS,
  baselineDir,
  buildSnapshot,
  compareSnapshots,
  readSnapshot,
  snapshotFile,
} from "./changes.js";
export type { ChangeReport, EdgeChange, EntityChange, Snapshot } from "./changes.js";
export { dictionary } from "./dictionary.js";
export type { Dictionary, DictionaryEntry } from "./dictionary.js";
export { callGraphDot, performGraphDot } from "./graphs.js";
export { impact } from "./impact.js";
export { buildIndex, isSkippedPath, SKIPPED_DIRS } from "./indexer.js";
export { QUERY_KINDS, runQuery, summary } from "./query.js";
export { rules } from "./rules.js";
export type { RuleCandidate } from "./rules.js";
export { accesses, crudMatrix, viewOf } from "./crud.js";
export type { Access, CrudMatrix, CrudOp, GraphView } from "./crud.js";
export { coverage } from "./coverage.js";
export type { Coverage, Gap } from "./coverage.js";
export {
  ALL_DOC_SECTIONS,
  DOC_SECTIONS,
  MODERN_DOC_SECTIONS,
  designDoc,
  docSectionsFor,
} from "./design-doc.js";
export type { DesignDoc, DesignDocOptions, DocSection } from "./design-doc.js";
export { DOC_LANGS, parseLang } from "./doc-i18n.js";
export type { DocLang } from "./doc-i18n.js";
export { buildGraph, nodeId } from "./graph.js";
export type { EdgeKind, GraphEdge, GraphNode, KnowledgeGraph, NodeKind } from "./graph.js";
export {
  GRAPH_QUERY_KINDS,
  callChains,
  datasetLineage,
  neighbours,
  programDependencies,
  runGraphQuery,
} from "./graph-query.js";
export { renderWavePlan } from "./wave-plan-md.js";
export { wavePlan } from "./wave-plan.js";
export type { WavePlan } from "./wave-plan.js";

// Modernisation assistant: language registry, Java and SQL DDL engines, polyglot graph.
export {
  crossCrud,
  inventory,
  legacyCrossCrud,
  legacyCrossImpact,
  legacyInventory,
  legacyModernisePlan,
  modernisePlanFor,
  polyglotOf,
} from "./modernise/api.js";
export type { CrossCrudRow, InventoryKind } from "./modernise/api.js";
export { LANGUAGES, detectLanguages } from "./modernise/registry.js";
export type { Detection, LanguageDef, LanguageId } from "./modernise/registry.js";
export { parseJavaFile } from "./modernise/java-parser.js";
export { analyseJava } from "./modernise/java-resolve.js";
export type { JavaAnalysis, JavaTableUse } from "./modernise/java-resolve.js";
export { analyseSql, parseSqlFile } from "./modernise/sql-ddl.js";
export { sqlTables } from "./modernise/sql-text.js";
export { parseFortranFile } from "./modernise/fortran-parser.js";
export { analyseFortran } from "./modernise/fortran-resolve.js";
export type { FortranAnalysis, FortranCommonBlock } from "./modernise/fortran-resolve.js";
export type * from "./modernise/fortran-types.js";
export { parsePliFile } from "./modernise/pli-parser.js";
export { analysePli } from "./modernise/pli-resolve.js";
export type { PliAnalysis } from "./modernise/pli-resolve.js";
export type * from "./modernise/pli-types.js";
export { sciId } from "./modernise/sci-graph.js";
export { analyseProject } from "./modernise/project.js";
export type { Polyglot } from "./modernise/project.js";
export { buildPolyglotGraph, polyId } from "./modernise/poly-graph.js";
export { crossImpact } from "./modernise/poly-impact.js";
export type { CrossImpact } from "./modernise/poly-impact.js";
export { modernisePlan } from "./modernise/plan.js";
export type { ModernisePlan } from "./modernise/plan.js";
export type * from "./modernise/types.js";
