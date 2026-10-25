// The three agent tools. Each one: resolve the Project and the target path (refusing outside a
// Project, outside 実行 Act mode, path escapes, symlinks and existing files), validate the spec,
// render, check the size, write, audit (kind, bytes, counts; never content or names).
import { Type } from "@sinclair/typebox";
import type { AnyAgentTool } from "../../../src/agents/pi-tools.types.js";
import type { KoLoPluginAuditInput } from "../../../src/plugins/types.js";
import { stringEnum } from "../../../src/agents/schema/typebox.js";
import { isObject, MAX_OUTPUT_BYTES, OfficeError } from "../../../src/office/common.js";
import { parseDocSpec, renderDocx } from "../../../src/office/docx.js";
import { projectForSession, resolveTarget, writeTarget } from "../../../src/office/target.js";
import { parseDeckSpec, PPTX_LIMITS, renderPptx } from "./pptx.js";
import { parseWorkbookSpec, renderXlsx, XLSX_LIMITS } from "./xlsx.js";

export const OFFICE_TOOL_NAMES = ["office_pptx_create", "office_docx_create", "office_xlsx_create"];

export type OfficeToolDeps = {
  agentId?: string;
  sessionKey?: string;
  audit?: (input: KoLoPluginAuditInput) => void;
  home?: string;
  now?: () => Date;
  maxBytes?: number;
};

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details?: Record<string, unknown>;
};

type Kind = "pptx" | "docx" | "xlsx";
type Rendered = { buffer: Buffer; counts: Record<string, number> };

const result = (text: string, details?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(details ? { details } : {}),
});

function kb(n: number): string {
  return n < 1024 ? `${n} B` : `${Math.round(n / 1024)} KB`;
}

async function run(
  deps: OfficeToolDeps,
  kind: Kind,
  params: Record<string, unknown>,
  render: (p: Record<string, unknown>, now: Date) => Promise<Rendered>,
): Promise<ToolResult> {
  const audit = (outcome: "ok" | "denied" | "failed", detail: Record<string, unknown>) =>
    deps.audit?.({
      action: `office.${kind}.create`,
      outcome,
      ...(deps.agentId ? { identity: deps.agentId } : {}),
      ...(deps.sessionKey ? { scope: deps.sessionKey } : {}),
      detail: { kind, ...detail },
    });
  try {
    if (!isObject(params)) {
      throw new OfficeError("bad_request", "parameters must be an object");
    }
    const project = projectForSession(deps.sessionKey, deps.home);
    // Render (and validate) before resolving the path: resolving creates missing folders.
    const out = await render(params, deps.now?.() ?? new Date());
    const max = deps.maxBytes ?? MAX_OUTPUT_BYTES;
    if (out.buffer.length > max) {
      throw new OfficeError(
        "too_large",
        `the ${kind} file would be ${kb(out.buffer.length)}, over the ${kb(max)} limit; split it`,
      );
    }
    const target = resolveTarget({
      project,
      path: params.path,
      ext: kind,
      overwrite: params.overwrite === true,
    });
    writeTarget(target, out.buffer);
    audit("ok", { bytes: out.buffer.length, ...out.counts });
    const counts = Object.entries(out.counts)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ");
    return result(
      `Wrote ${target.rel} (${counts}; ${kb(out.buffer.length)}) in the Project folder of "${project.name}". The file stays on this machine; nothing was sent anywhere.`,
      { path: target.rel, bytes: out.buffer.length, ...out.counts },
    );
  } catch (err) {
    if (err instanceof OfficeError) {
      audit(err.code === "bad_request" || err.code === "too_large" ? "failed" : "denied", {
        code: err.code,
      });
      return result(`Error: ${err.message}`, { error: err.code });
    }
    audit("failed", { code: "internal" });
    return result("Error: the file could not be written", { error: "internal" });
  }
}

// ---- schemas (flat objects, string enums; no unions, see the tool schema guardrails) ----------

const pathParam = Type.String({
  description:
    "Relative file path inside the current Project folder, e.g. \"output/report.pptx\". A bare file name goes into output/ (or the Project's first writable folder). Must end in the tool's extension.",
});
const overwriteParam = Type.Optional(
  Type.Boolean({ description: "Replace the file if it already exists (default false)." }),
);
const languageParam = Type.Optional(
  stringEnum(["ja", "en"] as const, {
    description: "Main language of the text, for proofing and line breaking (default ja).",
  }),
);

const chartSchema = Type.Object({
  type: stringEnum(["column", "bar", "line"] as const, {
    description: "column = vertical bars, bar = horizontal bars (both clustered), line.",
  }),
  title: Type.Optional(Type.String()),
  categories: Type.Array(Type.String(), { maxItems: PPTX_LIMITS.categories }),
  series: Type.Array(
    Type.Object({
      name: Type.String(),
      values: Type.Array(Type.Number(), { description: "One value per category." }),
    }),
    { maxItems: PPTX_LIMITS.series },
  ),
  number_format: Type.Optional(Type.String({ description: 'Excel number format, e.g. "#,##0".' })),
  data_labels: Type.Optional(Type.Boolean()),
});

const pptxParams = Type.Object({
  path: pathParam,
  overwrite: overwriteParam,
  title: Type.String({ description: "Title slide heading." }),
  subtitle: Type.Optional(Type.String()),
  badge: Type.Optional(
    Type.String({
      description: "Short label shown top-right on every slide, e.g. 架空データ・テスト資料.",
    }),
  ),
  footer: Type.Optional(Type.String({ description: "Footer text on every slide." })),
  page_numbers: Type.Optional(Type.Boolean({ description: 'Show "n / N" (default true).' })),
  language: languageParam,
  slides: Type.Array(
    Type.Object({
      heading: Type.String(),
      bullets: Type.Optional(Type.Array(Type.String(), { maxItems: PPTX_LIMITS.bullets })),
      kpis: Type.Optional(
        Type.Array(Type.Object({ label: Type.String(), value: Type.String() }), {
          maxItems: PPTX_LIMITS.kpis,
        }),
      ),
      chart: Type.Optional(chartSchema),
      note: Type.Optional(
        Type.String({ description: "One short line at the bottom (source, caveat)." }),
      ),
      speaker_notes: Type.Optional(Type.String()),
    }),
    { maxItems: PPTX_LIMITS.slides - 1, description: "Content slides after the title slide." },
  ),
  speaker_notes: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Speaker notes per content slide, by position (a slide's own speaker_notes wins).",
    }),
  ),
});

const docxParams = Type.Object({
  path: pathParam,
  overwrite: overwriteParam,
  title: Type.String(),
  subtitle: Type.Optional(Type.String()),
  footer: Type.Optional(Type.String({ description: "Footer text on every page." })),
  page_numbers: Type.Optional(
    Type.Boolean({ description: 'Show "n / N" in the footer (default true).' }),
  ),
  page_size: Type.Optional(stringEnum(["A4", "Letter"] as const)),
  language: languageParam,
  blocks: Type.Array(
    Type.Object({
      type: stringEnum(["heading", "paragraph", "bullets", "table"] as const),
      text: Type.Optional(Type.String({ description: "heading and paragraph" })),
      level: Type.Optional(Type.Integer({ minimum: 1, maximum: 3, description: "heading level" })),
      items: Type.Optional(Type.Array(Type.String(), { description: "bullets" })),
      header: Type.Optional(Type.Array(Type.String(), { maxItems: 12, description: "table" })),
      rows: Type.Optional(Type.Array(Type.Array(Type.String()), { description: "table" })),
      caption: Type.Optional(Type.String({ description: "table" })),
    }),
  ),
});

const xlsxParams = Type.Object({
  path: pathParam,
  overwrite: overwriteParam,
  title: Type.Optional(Type.String()),
  sheets: Type.Array(
    Type.Object({
      name: Type.String({ description: "At most 31 characters, no [ ] : * ? / \\" }),
      header: Type.Array(Type.String()),
      rows: Type.Array(Type.Array(Type.Unknown()), {
        description:
          'Rows of cells: string, number, boolean, null, or an ISO date string ("2026-04-01", "2026-04-01T09:30").',
      }),
      column_formats: Type.Optional(
        Type.Array(Type.String(), {
          description: 'Number format per column, "" for none, e.g. ["", "#,##0", "0.0%"].',
        }),
      ),
    }),
    { maxItems: XLSX_LIMITS.sheets },
  ),
});

export function createOfficeTools(deps: OfficeToolDeps): AnyAgentTool[] {
  const tools = [
    {
      name: "office_pptx_create",
      label: "Office: create PowerPoint",
      description:
        "Write a 16:9 PowerPoint deck into the current Project folder from a structured spec: a title slide, then content slides with a heading, up to 4 bullets, up to 3 KPI cards, an optional native editable chart (column, bar or line; up to 4 series and 24 categories), a note line and speaker notes. At most 40 slides. You supply the content; the layout is fixed. Needs a Project in 実行 Act mode. Nothing leaves the machine.",
      parameters: pptxParams,
      execute: (_id: string, params: Record<string, unknown>) =>
        run(deps, "pptx", params, async (p, now) => {
          const out = await renderPptx(parseDeckSpec(p), now);
          return { buffer: out.buffer, counts: { slides: out.slides, charts: out.charts } };
        }),
    },
    {
      name: "office_docx_create",
      label: "Office: create Word document",
      description:
        "Write a Word document into the current Project folder from a structured spec: title, optional subtitle, then blocks (heading level 1-3, paragraph, bullets, table with up to 12 columns), footer text and page numbers. Needs a Project in 実行 Act mode. Nothing leaves the machine.",
      parameters: docxParams,
      execute: (_id: string, params: Record<string, unknown>) =>
        run(deps, "docx", params, async (p, now) => {
          const out = await renderDocx(parseDocSpec(p), now);
          return { buffer: out.buffer, counts: { blocks: out.blocks, tables: out.tables } };
        }),
    },
    {
      name: "office_xlsx_create",
      label: "Office: create Excel workbook",
      description:
        "Write an Excel workbook into the current Project folder: sheets with a bold frozen header row, rows of string/number/boolean/ISO-date cells (at most 50,000 rows in total), estimated column widths and optional number formats per column. Text is never turned into formulas. Needs a Project in 実行 Act mode. Nothing leaves the machine.",
      parameters: xlsxParams,
      execute: (_id: string, params: Record<string, unknown>) =>
        run(deps, "xlsx", params, async (p, now) => {
          const out = await renderXlsx(parseWorkbookSpec(p), now);
          return { buffer: out.buffer, counts: { sheets: out.sheets, rows: out.rows } };
        }),
    },
  ];
  return tools as unknown as AnyAgentTool[];
}
