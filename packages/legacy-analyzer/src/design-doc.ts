// Design document generated from code (設計書). Every fact line (table row or list item) cites
// the source as `path:line`; what code cannot tell (business purpose, the meaning of a rule) is
// an explicit placeholder. The same index and options always give byte-identical Markdown: no
// dates, no absolute paths, deterministic ordering.

import type { DocLang } from "./doc-i18n.js";
import type { Polyglot } from "./modernise/project.js";
import type { LegacyIndex } from "./types.js";
import { gapCount } from "./coverage.js";
import { type DocCtx, docContext, rootName, sourceFingerprint } from "./design-doc-context.js";
import { renderCoverage } from "./design-doc-coverage.js";
import { renderCrud, renderDictionary } from "./design-doc-data.js";
import { renderJobFlow } from "./design-doc-jobs.js";
import { renderPrograms } from "./design-doc-programs.js";
import { cite, cites, mermaidIds, mermaidLabel, table } from "./md.js";
import { renderFortran } from "./modernise/design-doc-fortran.js";
import { renderJava } from "./modernise/design-doc-java.js";
import { renderPli } from "./modernise/design-doc-pli.js";
import { renderTables } from "./modernise/design-doc-sql.js";
import { sciStrings } from "./modernise/doc-i18n-sci.js";
import { modernStrings } from "./modernise/doc-i18n.js";
import { polyglotFiles } from "./modernise/plan.js";

export const DOC_SECTIONS = [
  "overview",
  "jobs",
  "programs",
  "dictionary",
  "crud",
  "coverage",
] as const;
/** Sections of the Java, FORTRAN, PL/I and SQL DDL engines (by default when the project has them). */
export const MODERN_DOC_SECTIONS = ["java", "fortran", "pli", "tables"] as const;
/** Every section, in document order. */
export const ALL_DOC_SECTIONS = [
  "overview",
  "jobs",
  "programs",
  "java",
  "fortran",
  "pli",
  "dictionary",
  "tables",
  "crud",
  "coverage",
] as const;
export type DocSection = (typeof ALL_DOC_SECTIONS)[number];

export type DesignDocOptions = {
  lang?: DocLang;
  /** Sections to include, in document order (default: all). */
  sections?: DocSection[];
  /** Limit the program specifications to one program. */
  program?: string;
  /** Java, SQL DDL, FORTRAN and PL/I facts of the project: adds their sections, joins CRUD. */
  poly?: Polyglot;
};

export type DesignDoc = {
  lang: DocLang;
  sections: DocSection[];
  markdown: string;
  stats: {
    programs: number;
    copybooks: number;
    jobs: number;
    factLines: number;
    placeholders: number;
    gaps: number;
  };
};

function overview(ctx: DocCtx, n: number): string[] {
  const { index, s, view } = ctx;
  const out = [`## ${n}. ${s.overview}`, "", `### ${n}.1 ${s.inventory}`, ""];
  const lines = new Map(index.files.map((f) => [f.path, f.lines]));
  const rows: string[][] = [];
  for (const p of index.programs) {
    rows.push([s.kindProgram, p.name, p.file, String(lines.get(p.file) ?? ""), cite(p)]);
  }
  for (const c of index.copybooks) {
    rows.push([
      s.kindCopybook,
      c.name,
      c.file,
      String(lines.get(c.file) ?? ""),
      cite({ file: c.file, line: 1 }),
    ]);
  }
  for (const j of index.jobs) {
    rows.push([
      j.kind === "JOB" ? s.kindJob : s.kindProc,
      j.name,
      j.file,
      String(lines.get(j.file) ?? ""),
      cite(j),
    ]);
  }
  const m = modernStrings(ctx.lang);
  for (const t of ctx.poly?.java.model.types.filter((x) => !x.outer) ?? []) {
    rows.push([m.kindJava, t.qualifiedName, t.file, "", cite(t)]);
  }
  const sm = sciStrings(ctx.lang);
  for (const u of ctx.poly?.fortran.units.filter((x) => !x.host) ?? []) {
    rows.push([sm.kindFortran(u.kind), u.id, u.file, "", cite(u)]);
  }
  for (const p of ctx.poly?.pli.procs.filter((x) => !x.parent) ?? []) {
    rows.push([sm.kindPli, p.name, p.file, "", cite(p)]);
  }
  for (const t of ctx.poly?.sql.tables ?? []) {
    rows.push([t.kind === "view" ? m.kindView : m.kindTable, t.name, t.file, "", cite(t)]);
  }
  out.push(...table([s.colKind, s.colName, s.colFile, s.colLines, s.colSource], rows), "");
  const steps = ctx.graph.nodes.filter((x) => x.kind === "step").length;
  const external = ctx.graph.nodes.filter((x) => x.kind === "external-program").length;
  out.push(
    s.totals({
      programs: index.programs.length,
      copybooks: index.copybooks.length,
      jobs: index.jobs.length,
      steps,
      paragraphs: index.programs.reduce((k, p) => k + p.paragraphs.length, 0),
      statements: index.programs.reduce(
        (k, p) => k + p.paragraphs.reduce((m, x) => m + x.statements.length, 0),
        0,
      ),
      external,
    }),
    "",
  );
  // Program relationship diagram: steps run programs, programs call programs.
  out.push(`### ${n}.2 ${s.callDiagram}`, "", "```mermaid", "flowchart LR");
  const ids = new Set<string>();
  const mermaidId = mermaidIds();
  const nodeLine = (id: string) => {
    const node = view.node.get(id);
    if (!node || ids.has(id)) {
      return;
    }
    ids.add(id);
    const mid = mermaidId(id);
    if (node.kind === "step") {
      out.push(`  ${mid}([${mermaidLabel(`${node.attrs?.job}.${node.name}`)}])`);
    } else if (node.kind === "program") {
      out.push(`  ${mid}[${mermaidLabel(node.name)}]`);
    } else {
      out.push(`  ${mid}[/${mermaidLabel(ctx.label(id))}/]`);
    }
  };
  const rel = ctx.graph.edges.filter((e) => e.kind === "EXEC" || e.kind === "CALL");
  for (const e of rel) {
    nodeLine(e.from);
    nodeLine(e.to);
  }
  for (const p of index.programs) {
    nodeLine(`program:${p.name}`);
  }
  const drawn = new Set<string>();
  for (const e of rel) {
    const dynamic = e.detail?.includes("dynamic");
    const k = `${e.from}|${e.to}|${e.kind}|${dynamic}`;
    if (drawn.has(k)) {
      continue;
    }
    drawn.add(k);
    const arrow = dynamic ? "-.->" : "-->";
    out.push(
      `  ${mermaidId(e.from)} ${arrow}|${e.kind === "EXEC" ? "EXEC" : (e.detail ?? "CALL").replace(/ dynamic$/, "")}| ${mermaidId(e.to)}`,
    );
  }
  out.push("```", "", `> ${s.diagramNote}`, "");
  // The same relationships as a table, with the facts behind them.
  out.push(`### ${n}.3 ${s.relations}`, "");
  const grouped = new Map<string, typeof rel>();
  for (const e of rel) {
    const k = `${e.from}|${e.kind}|${e.to}`;
    grouped.set(k, [...(grouped.get(k) ?? []), e]);
  }
  const relRows = [...grouped.values()].map((es) => {
    const e = es[0];
    return [
      ctx.label(e.from),
      e.kind === "EXEC" ? s.relExec : `${s.relCall} (${e.detail ?? ""})`,
      ctx.label(e.to),
      String(es.length),
      cites(es.map((x) => x.loc)),
    ];
  });
  if (relRows.length > 0) {
    out.push(...table([s.colFrom, s.colRelation, s.colTo, s.colCount, s.colSource], relRows));
  } else {
    out.push(s.none);
  }
  return out;
}

/** Default sections: the six COBOL/JCL ones, plus each other engine's when the project has it. */
export function docSectionsFor(poly?: Polyglot): DocSection[] {
  const hasJava = (poly?.java.model.types.length ?? 0) > 0;
  const hasTables =
    (poly?.sql.tables.length ?? 0) > 0 ||
    (poly?.java.tableUses.length ?? 0) > 0 ||
    (poly?.pli.tableUses.length ?? 0) > 0;
  const wanted: DocSection[] = [...DOC_SECTIONS];
  if (hasJava) {
    wanted.push("java");
  }
  if ((poly?.fortran.units.length ?? 0) > 0) {
    wanted.push("fortran");
  }
  if ((poly?.pli.procs.length ?? 0) > 0) {
    wanted.push("pli");
  }
  if (hasTables) {
    wanted.push("tables");
  }
  return ALL_DOC_SECTIONS.filter((x) => wanted.includes(x));
}

export function designDoc(index: LegacyIndex, opts: DesignDocOptions = {}): DesignDoc {
  const lang = opts.lang ?? "ja";
  const poly = opts.poly;
  const ctx = docContext(index, lang, poly ? polyglotFiles(poly) : undefined, poly);
  const { s } = ctx;
  const m = modernStrings(lang);
  const wanted: DocSection[] =
    opts.sections && opts.sections.length > 0 ? opts.sections : docSectionsFor(poly);
  const sections = ALL_DOC_SECTIONS.filter((x) => wanted.includes(x));
  const program = opts.program?.trim().toUpperCase();
  if (program && !index.programs.some((p) => p.name === program)) {
    throw new Error(`No program named ${opts.program} in the index.`);
  }
  const titles: Record<DocSection, string> = {
    overview: s.overview,
    jobs: s.jobFlow,
    programs: s.programSpecs,
    java: m.java,
    fortran: sciStrings(lang).fortran,
    pli: sciStrings(lang).pli,
    dictionary: s.dictionary,
    tables: m.tables,
    crud: s.crud,
    coverage: s.coverage,
  };
  const out: string[] = [
    `# ${s.title(rootName(index))}`,
    "",
    `> ${s.preamble}`,
    `>`,
    `> ${s.provenance(index.files.length, sourceFingerprint(index))}`,
    "",
    `## ${s.toc}`,
    "",
    ...sections.map((x, k) => `${k + 1}. ${titles[x]}`),
    "",
  ];
  sections.forEach((sec, k) => {
    const n = k + 1;
    const body =
      sec === "overview"
        ? overview(ctx, n)
        : sec === "jobs"
          ? renderJobFlow(ctx, n)
          : sec === "programs"
            ? renderPrograms(ctx, n, program)
            : sec === "java"
              ? renderJava(ctx, n)
              : sec === "fortran"
                ? renderFortran(ctx, n)
                : sec === "pli"
                  ? renderPli(ctx, n)
                  : sec === "tables"
                    ? renderTables(ctx, n)
                    : sec === "dictionary"
                      ? renderDictionary(ctx, n)
                      : sec === "crud"
                        ? renderCrud(ctx, n)
                        : renderCoverage(ctx, n);
    out.push(...body, "");
  });
  const markdown = `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
  const lines = markdown.split("\n");
  return {
    lang,
    sections,
    markdown,
    stats: {
      programs: index.programs.length,
      copybooks: index.copybooks.length,
      jobs: index.jobs.length,
      factLines: lines.filter((l) => /^\s*(- |\| )/.test(l) && !/^\|\s*---/.test(l)).length,
      placeholders: lines.filter((l) => l.includes(s.tbc)).length,
      gaps: gapCount(ctx.cov),
    },
  };
}
