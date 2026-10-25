import { Type } from "@sinclair/typebox";
import path from "node:path";
import type { DocSection } from "../../packages/legacy-analyzer/src/index.js";
import type { KoLoPluginApi } from "../../src/plugins/types.js";
import {
  ALL_QUERY_KINDS,
  ALL_DOC_SECTIONS,
  legacyDesignDoc,
  legacyDictionary,
  legacyImpact,
  legacyIndex,
  legacyQuery,
  legacyRules,
  legacyWavePlan,
  parseLang,
} from "../../packages/legacy-analyzer/src/index.js";
import { optionalStringEnum } from "../../src/agents/schema/typebox.js";
import { changesTools } from "./changes-tools.js";
import { writeDesignDocx } from "./design-doc-docx.js";
import { moderniseTools } from "./modernise-tools.js";
import { failure, markdownResult, result, str } from "./results.js";

// Read-only tools over the legacy analyser. Each takes the folder to analyse as `path`; the
// permission guard classifies these calls as reads of that path, so a project session can only
// analyse its own folder. The only files written are the analyser's cache folder
// (output/.legacy-index/ of the project, or the state directory): the index, and the latest
// design document and wave plan, and the change-detection baseline (changes-tools.ts). The one
// write outside the cache is the 設計書 as Word (output_format docx), into the Project's
// output/design-docs/ under the office path guards (design-doc-docx.ts).

function langParam(v: unknown) {
  const s = str(v);
  const lang = s ? parseLang(s) : undefined;
  if (s && !lang) {
    throw new Error('lang must be "ja" or "en".');
  }
  return lang;
}

function sectionsParam(v: unknown): DocSection[] | undefined {
  const list = (Array.isArray(v) ? v.map(String) : str(v).split(","))
    .map((x) => x.trim())
    .filter(Boolean);
  const unknown = list.filter((x) => !(ALL_DOC_SECTIONS as readonly string[]).includes(x));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown section: ${unknown.join(", ")}. Known: ${ALL_DOC_SECTIONS.join(", ")}.`,
    );
  }
  return list.length > 0 ? (list as DocSection[]) : undefined;
}

export default function register(api: KoLoPluginApi) {
  const env = { stateDir: path.join(api.paths.stateDir) };
  api.registerTool((ctx) => {
    const base = ctx.workspaceDir ?? process.cwd();
    const root = (params: Record<string, unknown>) => {
      const p = str(params.path);
      if (!p) {
        throw new Error(
          "path is required: the folder holding the legacy sources (COBOL, copybooks, JCL, Java, SQL DDL, FORTRAN, PL/I).",
        );
      }
      return path.resolve(base, p);
    };
    const pathParam = Type.String({
      description:
        "Folder with the legacy sources (COBOL, copybooks, JCL, Java, SQL DDL, FORTRAN, PL/I).",
    });
    return [
      {
        name: "legacy_index",
        label: "Legacy index",
        description:
          "Parse COBOL programs, copybooks and JCL under a folder and build the fact index (programs, " +
          "paragraphs, CALL/PERFORM graphs, files, data items, job steps). Returns a summary with counts " +
          "and diagnostics. Read-only; caches the index under the project's output/.legacy-index/.",
        parameters: Type.Object({ path: pathParam }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            return result(legacyIndex(root(params), env));
          } catch (err) {
            return failure(err);
          }
        },
      },
      {
        name: "legacy_query",
        label: "Legacy query",
        description:
          "Answer a structural question from the index, with file:line for every fact. Kinds: " +
          `${ALL_QUERY_KINDS.join(", ")}. Arguments: callers/callees {name: program or paragraph, or PROGRAM.PARAGRAPH}; ` +
          "file-access {file: FD/SELECT name, DD name or data set, op?: READ|WRITE|OPEN|CLOSE|REWRITE}; " +
          "data-refs and data-item {name, program?}; job-steps {program}; paragraphs and perform-graph {program}; datasets {dsn?}; " +
          "knowledge graph: graph-neighbours {node: program, data set, table, copybook, job or step; direction?: in|out}, " +
          "call-chains {program, direction?: down|up}, lineage {dataset: data set, SQL table or CICS file}.",
        parameters: Type.Object({
          path: pathParam,
          kind: Type.String({ description: `One of: ${ALL_QUERY_KINDS.join(", ")}` }),
          args: Type.Optional(Type.Record(Type.String(), Type.String())),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const args = (
              params.args && typeof params.args === "object" ? params.args : {}
            ) as Record<string, unknown>;
            return result(legacyQuery(root(params), str(params.kind), args, env));
          } catch (err) {
            return failure(err);
          }
        },
      },
      {
        name: "legacy_rules",
        label: "Legacy rule candidates",
        description:
          "List rule candidates for a program (or all): IF/EVALUATE/UNTIL conditions with their literals, " +
          "arithmetic with constants, ROUNDED, 88-level values, numeric VALUE constants and literal assignments. " +
          "Each is exact source text at file:line with the declared values of named constants. Business meaning " +
          "is not inferred; interpret and cite.",
        parameters: Type.Object({ path: pathParam, program: Type.Optional(Type.String()) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            return result(legacyRules(root(params), str(params.program) || undefined, env));
          } catch (err) {
            return failure(err);
          }
        },
      },
      {
        name: "legacy_dictionary",
        label: "Legacy data dictionary",
        description:
          "Data dictionary of a copybook (or all copybooks): level, name, PIC, USAGE, byte length, offset, " +
          "start/end position, OCCURS, REDEFINES, VALUE, 88 values and the description from comments.",
        parameters: Type.Object({ path: pathParam, copybook: Type.Optional(Type.String()) }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            return result(legacyDictionary(root(params), str(params.copybook) || undefined, env));
          } catch (err) {
            return failure(err);
          }
        },
      },
      {
        name: "legacy_impact",
        label: "Legacy impact",
        description:
          "Impact of changing a data item: items sharing its storage, items it flows into, the same copybook " +
          "field in other programs, CALL USING parameters, records passed through data sets, and the paragraphs, " +
          "programs and job steps that touch them. Every entry carries the fact (file:line) that links it.",
        parameters: Type.Object({
          path: pathParam,
          item: Type.String(),
          program: Type.Optional(Type.String()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            return result(
              legacyImpact(root(params), str(params.item), str(params.program) || undefined, env),
            );
          } catch (err) {
            return failure(err);
          }
        },
      },
      {
        name: "legacy_design_doc",
        label: "Legacy design document",
        description:
          "Generate a design document (設計書) from the code as Markdown, in Japanese (lang ja, default) or English " +
          "(en): system overview with inventory and Mermaid diagrams, JCL job flow and data set lineage, program " +
          "specifications (inputs/outputs, calls, PERFORM structure, business-rule candidates), data dictionary " +
          "from copybooks, CRUD matrix, and a coverage report of what was not analysed and what needs confirmation. " +
          "Every fact line cites path:line; business purpose and rule meaning are explicit placeholders. " +
          "Java class specifications, FORTRAN program units (with the COMMON block map), PL/I procedure specifications " +
          "(structures, files, ON-units) and table definitions are added when the folder has them. " +
          `Optional section (comma list of ${ALL_DOC_SECTIONS.join(", ")}) and program narrow it. ` +
          "Read-only on the sources; the document is also saved in the analyser cache folder. output_format docx " +
          "also writes it as a Word file into the Project's output/design-docs/ (never over an existing file).",
        parameters: Type.Object({
          path: pathParam,
          lang: Type.Optional(Type.String({ description: "ja (default) or en" })),
          section: Type.Optional(
            Type.String({ description: `Comma list of: ${ALL_DOC_SECTIONS.join(", ")}` }),
          ),
          program: Type.Optional(Type.String({ description: "Only this program's specification" })),
          output_format: optionalStringEnum(["md", "docx"] as const, {
            description:
              "md (default): Markdown only. docx: also a Word file in the Project's output/design-docs/ " +
              "(設計書_YYYYMMDD.docx, EN design-doc_YYYYMMDD.docx; never overwritten: -2, -3 …).",
          }),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            // `format` is accepted as an alias (tool schemas avoid that property name).
            const fmt = str(params.output_format) || str(params.format) || "md";
            if (fmt !== "md" && fmt !== "docx") {
              throw new Error('output_format must be "md" or "docx".');
            }
            const doc = legacyDesignDoc(
              root(params),
              {
                lang: langParam(params.lang),
                sections: sectionsParam(params.section),
                program: str(params.program) || undefined,
              },
              env,
            );
            const word =
              fmt === "docx"
                ? await writeDesignDocx({
                    markdown: doc.markdown,
                    lang: doc.lang,
                    sessionKey: ctx.sessionKey,
                    now: new Date(),
                  })
                : null;
            const res = markdownResult(
              [
                `Design document (${doc.lang}), sections: ${doc.sections.join(", ")}.`,
                `Fact lines: ${doc.stats.factLines}; placeholders: ${doc.stats.placeholders}; open questions: ${doc.stats.gaps}.`,
                `Saved: ${doc.savedTo}`,
                ...(word ? [`Word document: ${word.path} (${word.bytes} bytes)`] : []),
              ],
              doc.markdown,
              doc.savedTo,
            );
            return word
              ? {
                  ...res,
                  details: {
                    ...res.details,
                    output_format: "docx",
                    path: word.path,
                    bytes: word.bytes,
                  },
                }
              : res;
          } catch (err) {
            return failure(err);
          }
        },
      },
      {
        name: "legacy_wave_plan",
        label: "Legacy wave plan",
        description:
          "Propose modernisation waves from the code (a proposal for human review): CALL and data-set dependencies " +
          "between programs, cycles (strongly connected components) that must move together, clusters, coupling " +
          "through shared data sets and copybooks, size and complexity metrics and a documented risk score; waves " +
          "ordered by dependency, then risk, each with its reasons and path:line evidence. Markdown in ja (default) or en. " +
          "Read-only on the sources; the plan is also saved in the analyser cache folder.",
        parameters: Type.Object({
          path: pathParam,
          lang: Type.Optional(Type.String({ description: "ja (default) or en" })),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          try {
            const plan = legacyWavePlan(root(params), langParam(params.lang), env);
            const waves = plan.waves
              .map((w) => `wave ${w.wave}: ${w.groups.map((g) => g.programs.join("+")).join(", ")}`)
              .join("; ");
            return markdownResult(
              [
                `Wave plan (${plan.lang}). ${plan.note}`,
                `Waves: ${waves || "none"}.`,
                `Saved: ${plan.savedTo}`,
              ],
              plan.markdown,
              plan.savedTo,
            );
          } catch (err) {
            return failure(err);
          }
        },
      },
      ...changesTools({ root, pathParam, env }),
      ...moderniseTools({ root, pathParam, env }),
    ];
  });
}
