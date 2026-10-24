// Tool registry of the kurahi-legacy MCP server: one entry per tool. The server adds the common
// arguments (`path`, `offset`, `limit`), resolves `path` inside the project root, shapes and caps
// the result, writes the audit line and builds the text summary from `summarize`.
//
// To add a tool, append one `defineTool({...})` to LEGACY_TOOLS. `run` gets the context (the
// fresh index of the requested scope) and the validated arguments, and returns plain JSON.
// Tools here are reads: they never write and never run code from the repository.

import { z } from "zod";
import type { IndexHandle } from "./index-cache.js";
import {
  ALL_DOC_SECTIONS,
  QUERY_KINDS,
  analyseProject,
  docSectionsFor,
  designDoc,
  dictionary,
  impact,
  rules,
  renderWavePlan,
  runQuery,
  summary,
  wavePlan,
} from "../../../packages/legacy-analyzer/src/index.js";
import { MODERNISE_TOOLS } from "./tools-modernise.js";

export type LegacyToolContext = {
  /** Fresh index of the scope `path` (default: the project root), built when missing or stale. */
  index(): IndexHandle;
  /** The cached index of the scope when still fresh; never builds. */
  peek(): IndexHandle | null;
  /** Rebuild the index of the scope now. */
  rebuild(): IndexHandle;
  /** Root-relative form of the scope (`.` for the root). */
  scope: string;
};

export type LegacyToolDef = {
  name: string;
  title: string;
  description: string;
  /** Tool-specific arguments; `path`, `offset` and `limit` are added for every tool. */
  input: z.ZodRawShape;
  run(ctx: LegacyToolContext, args: Record<string, unknown>): unknown;
  /** One or two sentences for the text block; the page line is appended by the server. */
  summarize(result: unknown, args: Record<string, unknown>): string;
};

export function defineTool<S extends z.ZodRawShape>(def: {
  name: string;
  title: string;
  description: string;
  input: S;
  run(ctx: LegacyToolContext, args: z.infer<z.ZodObject<S>>): unknown;
  summarize(result: unknown, args: z.infer<z.ZodObject<S>>): string;
}): LegacyToolDef {
  return def as unknown as LegacyToolDef;
}

const opt = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/** The index summary without the absolute root (served paths are project-relative). */
function indexSummary(h: IndexHandle, scope: string) {
  const { root: _root, ...rest } = summary(h.index);
  return { scope, source: h.source, builtAt: h.builtAt, buildMs: h.buildMs, ...rest };
}

export const LEGACY_TOOLS: LegacyToolDef[] = [
  defineTool({
    name: "legacy_index_status",
    title: "Legacy index status",
    description:
      "Whether a fresh fact index exists for the project (or a sub-folder given as path), with its " +
      "counts. Never parses sources; use legacy_index_build to (re)build. Other tools build the index " +
      "on first use.",
    input: {},
    run(ctx) {
      const h = ctx.peek();
      if (!h) {
        return { scope: ctx.scope, indexed: false };
      }
      const s = indexSummary(h, ctx.scope);
      return {
        scope: ctx.scope,
        indexed: true,
        source: s.source,
        builtAt: s.builtAt,
        files: s.files,
        counts: s.counts,
        diagnostics: s.diagnostics.length,
      };
    },
    summarize: (r: { indexed: boolean; scope: string; files?: number }) =>
      r.indexed
        ? `Fresh index for ${r.scope}: ${r.files} source files.`
        : `No fresh index for ${r.scope}; legacy_index_build builds it.`,
  }),
  defineTool({
    name: "legacy_index_build",
    title: "Legacy index build",
    description:
      "Parse the COBOL programs, copybooks and JCL under the project (or path) and build the fact " +
      "index: programs, paragraphs, CALL/PERFORM graphs, files, data items, job steps. Returns counts, " +
      "the program/copybook/job lists and diagnostics. Writes only the cache in the project's .kurahi folder.",
    input: {},
    run: (ctx) => indexSummary(ctx.rebuild(), ctx.scope),
    summarize: (r: ReturnType<typeof indexSummary>) =>
      `Indexed ${r.files} source files under ${r.scope} in ${r.buildMs} ms: ${r.counts.programs} programs, ` +
      `${r.copybooks.length} copybooks, ${r.jobs.length} jobs, ${r.diagnostics.length} diagnostics.`,
  }),
  defineTool({
    name: "legacy_query",
    title: "Legacy query",
    description:
      "Answer a structural question from the index, with path:line for every fact. Kinds: " +
      `${QUERY_KINDS.join(", ")}. Arguments: callers/callees {name: program or paragraph, or ` +
      "PROGRAM.PARAGRAPH}; file-access {file: FD/SELECT name, DD name or data set, op?: " +
      "READ|WRITE|OPEN|CLOSE|REWRITE}; data-refs and data-item {name, program?}; job-steps {program}; " +
      "paragraphs and perform-graph {program}; datasets {dsn?}.",
    input: {
      kind: z.enum(QUERY_KINDS as unknown as [string, ...string[]]).describe("Query kind."),
      args: z
        .record(z.string(), z.string().max(512))
        .optional()
        .describe('Arguments of the query kind, e.g. {"name": "ORDTAX"}.'),
    },
    run: (ctx, a) => runQuery(ctx.index().index, a.kind, a.args ?? {}),
    summarize: (r: unknown, a) => {
      if (Array.isArray(r)) {
        return `Query ${a.kind}: ${r.length} entries.`;
      }
      const lists =
        r && typeof r === "object"
          ? Object.entries(r as Record<string, unknown>)
              .filter(([, v]) => Array.isArray(v))
              .map(([k, v]) => `${k} ${len(v)}`)
          : [];
      return `Query ${a.kind}${lists.length ? `: ${lists.join(", ")}` : ""}.`;
    },
  }),
  defineTool({
    name: "legacy_rules",
    title: "Legacy rule candidates",
    description:
      "Rule candidates for a program (or all): IF/EVALUATE/UNTIL conditions with their literals, " +
      "arithmetic with constants, ROUNDED, 88-level values, numeric VALUE constants and literal " +
      "assignments. Exact source text at path:line. Business meaning is not inferred.",
    input: { program: z.string().max(64).optional().describe("Program name (PROGRAM-ID).") },
    run(ctx, a) {
      const candidates = rules(ctx.index().index, opt(a.program));
      return {
        note: "Candidates only: exact source text and literal values. Their business meaning is not inferred.",
        count: candidates.length,
        candidates,
      };
    },
    summarize: (r: { count: number }, a) =>
      `${r.count} rule candidates${opt(a.program) ? ` in ${opt(a.program)}` : ""}.`,
  }),
  defineTool({
    name: "legacy_dictionary",
    title: "Legacy data dictionary",
    description:
      "Data dictionary of one copybook (member name or path), or the list of every copybook's " +
      "dictionary: level, name, PIC, USAGE, byte length, offset, start/end position, OCCURS, " +
      "REDEFINES, VALUE, 88 values and the description from comments.",
    input: { copybook: z.string().max(256).optional().describe("Copybook member name or path.") },
    run(ctx, a) {
      const books = dictionary(ctx.index().index, opt(a.copybook));
      // One copybook: page its entries; all copybooks: page the list of copybooks.
      return opt(a.copybook) ? books[0] : { copybooks: books };
    },
    summarize: (r: { copybook?: string; entries?: unknown[]; copybooks?: unknown[] }) =>
      r.copybook
        ? `Copybook ${r.copybook}: ${len(r.entries)} entries.`
        : `${len(r.copybooks)} copybooks.`,
  }),
  defineTool({
    name: "legacy_impact",
    title: "Legacy impact",
    description:
      "Impact of changing a data item: items sharing its storage, items it flows into, the same " +
      "copybook field in other programs, CALL USING parameters, records passed through data sets, and " +
      "the paragraphs, programs and job steps that touch them, each with the linking fact's path:line.",
    input: {
      item: z.string().min(1).max(64).describe("Data item name, e.g. ORD-QTY."),
      program: z.string().max(64).optional().describe("Program the item is declared in."),
    },
    run: (ctx, a) => impact(ctx.index().index, a.item.trim(), opt(a.program)),
    summarize: (r: {
      item: string;
      found: boolean;
      affectedItems: unknown[];
      paragraphs: unknown[];
      programs: unknown[];
      jobSteps: unknown[];
    }) =>
      r.found
        ? `Impact of ${r.item}: ${len(r.affectedItems)} items, ${len(r.paragraphs)} paragraphs, ` +
          `${len(r.programs)} programs, ${len(r.jobSteps)} job steps.`
        : `${r.item}: not found in the index.`,
  }),
  defineTool({
    name: "legacy_design_doc",
    title: "Legacy design document",
    description:
      "Design document (設計書) generated from the code, in Japanese or English: system overview, " +
      "job flow, program specifications, Java class specifications, FORTRAN program units with the COMMON " +
      "block map, PL/I procedures with structures and files, and table definitions (when the project has " +
      "them), data dictionary, CRUD matrix across languages and coverage. Every fact cites " +
      "path:line; business intent is marked 要確認 / needs confirmation. Returned one section per entry.",
    input: {
      lang: z.enum(["ja", "en"]).optional().describe("Document language (default ja)."),
      section: z.enum(ALL_DOC_SECTIONS).optional().describe("Only this section."),
      program: z
        .string()
        .max(64)
        .optional()
        .describe("Limit program specifications to one program."),
    },
    run(ctx, a) {
      const index = ctx.index().index;
      const poly = analyseProject(index);
      const wanted = a.section ? [a.section] : docSectionsFor(poly);
      const parts = wanted.map((section) => {
        const doc = designDoc(index, {
          lang: a.lang,
          sections: [section],
          program: opt(a.program),
          poly,
        });
        return { section, markdown: doc.markdown };
      });
      return { lang: a.lang ?? "ja", parts };
    },
    summarize: (r: { lang: string; parts: unknown[] }) =>
      `Design document (${r.lang}): ${len(r.parts)} sections.`,
  }),
  defineTool({
    name: "legacy_wave_plan",
    title: "Legacy modernisation wave plan",
    description:
      "Proposed migration waves for human review, ordered by dependencies (CALLs and shared data " +
      "sets) and risk, with clusters, coupling, metrics and open questions, each backed by path:line.",
    input: {
      lang: z
        .enum(["ja", "en"])
        .optional()
        .describe("Language of the Markdown rendering (default ja)."),
    },
    run(ctx, a) {
      const index = ctx.index().index;
      return { plan: wavePlan(index), markdown: renderWavePlan(index, a.lang ?? "ja") };
    },
    summarize: (r: { plan: { waves?: unknown[] } }) =>
      `Wave plan proposal: ${len(r.plan.waves)} waves (for human review).`,
  }),
  ...MODERNISE_TOOLS,
];
