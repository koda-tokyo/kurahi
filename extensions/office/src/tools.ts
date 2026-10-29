import { Type } from "@sinclair/typebox";
// The three agent tools. Each one: resolve the Project and the target path (refusing outside a
// Project, outside 実行 Act mode, path escapes, symlinks and existing files), validate the spec,
// render, check the size, write, audit (kind, bytes, counts; never content or names).
import crypto from "node:crypto";
import type { AnyAgentTool } from "../../../src/agents/pi-tools.types.js";
import type { KoLoPluginAuditInput } from "../../../src/plugins/types.js";
import type { Project } from "../../../src/projects/types.js";
import { stringEnum } from "../../../src/agents/schema/typebox.js";
import { isObject, MAX_OUTPUT_BYTES, OfficeError } from "../../../src/office/common.js";
import { parseDocSpec, renderDocx } from "../../../src/office/docx.js";
import {
  projectForSession,
  resolveTarget,
  writeTarget,
  writeUniqueTarget,
} from "../../../src/office/target.js";
import { QuoteError } from "../../../src/quotes/calculate.js";
import { compareSupplierQuotes } from "../../../src/quotes/compare.js";
import { parseDeckSpec, PPTX_LIMITS, renderPptx } from "./pptx.js";
import { buildPurchaseOrder, parsePurchaseOrderRequest } from "./purchase-order.js";
import { COMPARE_LIMITS, describeComparison, parseCompareRequest } from "./quote-compare.js";
import {
  buildQuote,
  DEFAULT_PRICE_LIST,
  parseQuoteRequest,
  QUOTE_LIMITS,
  readSupplierQuoteFile,
} from "./quote.js";
import { parseWorkbookSpec, renderXlsx, XLSX_LIMITS } from "./xlsx.js";

export const OFFICE_TOOL_NAMES = [
  "office_pptx_create",
  "office_docx_create",
  "office_xlsx_create",
  "office_quote_create",
  "office_quote_compare",
  "office_po_create",
];

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

const quoteParams = Type.Object({
  quote: Type.Object({
    customer: Type.String({ description: "Customer company name (宛名)." }),
    honorific: Type.Optional(Type.String({ description: "御中 (default in Japanese) or 様." })),
    attention: Type.Optional(
      Type.String({
        description: "A named person at the customer, printed with 様 under the company.",
      }),
    ),
    subject: Type.String({ description: "件名, e.g. 部品A 10個の御見積." }),
    lines: Type.Array(
      Type.Object({
        code: Type.Optional(
          Type.String({ description: "Item code from the price list, when known." }),
        ),
        description: Type.String({ description: "Item as the customer asked for it." }),
        quantity: Type.Number({ description: "Quantity, up to 3 decimals." }),
      }),
      { maxItems: QUOTE_LIMITS.lines },
    ),
    number: Type.Optional(Type.String({ description: "Quotation number; default Q-YYYYMMDD." })),
    revision: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 99,
        description:
          "Revision of the quotation `number` (2 → <number>-R2, superseding <number>). Only when a person asks for a revised quotation.",
      }),
    ),
    excluded: Type.Optional(
      Type.Array(
        Type.Object({
          code: Type.Optional(Type.String()),
          description: Type.String(),
          quantity: Type.Optional(Type.Number()),
          reason: Type.String({
            description:
              "The person's reason for taking the item out of scope (at least 10 characters).",
          }),
        }),
        {
          maxItems: 50,
          description:
            "Items a PERSON decided to take out of scope, with their reason. Never decide this yourself.",
        },
      ),
    ),
    validity_days: Type.Optional(Type.Integer({ minimum: 1, maximum: QUOTE_LIMITS.validityDays })),
    delivery: Type.Optional(Type.String()),
    payment_terms: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    document_discount: Type.Optional(
      Type.Integer({
        minimum: 0,
        description: "Whole-document discount in yen, if a person agreed one.",
      }),
    ),
    language: Type.Optional(stringEnum(["ja", "en"] as const)),
    price_list: Type.Optional(
      Type.String({
        description: `Project-relative price list under quotes/, CSV or Excel .xlsx (default ${DEFAULT_PRICE_LIST}).`,
      }),
    ),
  }),
});

const compareParams = Type.Object({
  comparison: Type.Object({
    items: Type.Array(
      Type.Object({
        code: Type.String({ description: "Item code of the request (見積依頼)." }),
        description: Type.Optional(Type.String()),
        quantity: Type.Number({ description: "Requested quantity, up to 3 decimals." }),
      }),
      { maxItems: COMPARE_LIMITS.items, description: "What was asked for, once per item." },
    ),
    quotes: Type.Array(
      Type.Object({
        supplier: Type.String({ description: "Supplier company name." }),
        file: Type.Optional(
          Type.String({
            description:
              "Project-relative supplier quotation sheet under quotes/, CSV or Excel .xlsx (columns 品番, 数量, 単価, optional 品名 and 税率), read by Kurahi instead of lines. Give file or lines, not both.",
          }),
        ),
        lines: Type.Optional(
          Type.Array(
            Type.Object({
              code: Type.String({ description: "The requested item code this line answers." }),
              description: Type.Optional(Type.String()),
              quantity: Type.Number({ description: "Quantity the supplier quoted." }),
              unit_price: Type.Number({
                description: "Tax-exclusive unit price in yen as printed, up to 2 decimals.",
              }),
              tax_rate: Type.Integer({ description: "Consumption tax rate: 10, 8 or 0." }),
              discount_percent: Type.Optional(Type.Number()),
              discount_amount: Type.Optional(Type.Integer({ minimum: 0 })),
            }),
            { maxItems: COMPARE_LIMITS.items },
          ),
        ),
        document_discount: Type.Optional(Type.Integer({ minimum: 0 })),
        line_rounding: Type.Optional(stringEnum(["floor", "round", "ceil"] as const)),
        tax_rounding: Type.Optional(stringEnum(["floor", "round", "ceil"] as const)),
      }),
      { minItems: 2, maxItems: COMPARE_LIMITS.suppliers },
    ),
  }),
});

function runCompare(deps: OfficeToolDeps, params: Record<string, unknown>): ToolResult {
  const audit = (outcome: "ok" | "failed", detail: Record<string, unknown>) =>
    deps.audit?.({
      action: "office.quote.compare",
      outcome,
      ...(deps.agentId ? { identity: deps.agentId } : {}),
      ...(deps.sessionKey ? { scope: deps.sessionKey } : {}),
      detail,
    });
  try {
    if (!isObject(params)) {
      throw new OfficeError("bad_request", "parameters must be an object");
    }
    // Only a quote given as a file needs the Project; transcribed lines compare anywhere.
    const req = parseCompareRequest(params.comparison, (file) =>
      readSupplierQuoteFile(projectForSession(deps.sessionKey, deps.home, { anyMode: true }), file),
    );
    const c = compareSupplierQuotes(req.items, req.quotes);
    audit("ok", {
      items: c.items.length,
      suppliers: c.suppliers.length,
      lowest: c.lowest.length,
      files: req.files.length,
    });
    return result(describeComparison(c), {
      lowest: c.lowest,
      lowestNet: c.lowestNet,
      suppliers: c.suppliers.map((s) => ({
        supplier: s.supplier,
        net: s.totals.net,
        tax: s.totals.tax,
        total: s.totals.total,
        complete: s.complete,
        missing: s.missing,
        quantityMismatch: s.quantityMismatch,
      })),
      items: c.items.map((i) => ({ code: i.code, lowest: i.lowest, offers: i.offers })),
      files: req.files,
    });
  } catch (err) {
    if (err instanceof OfficeError || err instanceof QuoteError) {
      audit("failed", { code: "bad_request" });
      return result(`Error: ${err.message}`, { error: "bad_request" });
    }
    audit("failed", { code: "internal" });
    return result("Error: the quotations could not be compared", { error: "internal" });
  }
}

const poParams = Type.Object({
  order: Type.Object({
    comparison: compareParams.properties.comparison,
    supplier: Type.String({
      description: "The supplier a PERSON chose, as named in the comparison.",
    }),
    selected_by: Type.String({ description: "The person who chose the supplier." }),
    reason: Type.Optional(
      Type.String({
        description:
          "The person's reason, required when the chosen supplier is not the lowest complete quote.",
      }),
    ),
    number: Type.Optional(Type.String({ description: "Order number; default PO-YYYYMMDD." })),
    delivery: Type.Optional(Type.String()),
    notes: Type.Optional(Type.String()),
    language: Type.Optional(stringEnum(["ja", "en"] as const)),
  }),
});

async function runPurchaseOrder(
  deps: OfficeToolDeps,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const audit = (outcome: "ok" | "denied" | "failed", detail: Record<string, unknown>) =>
    deps.audit?.({
      action: "office.po.create",
      outcome,
      ...(deps.agentId ? { identity: deps.agentId } : {}),
      ...(deps.sessionKey ? { scope: deps.sessionKey } : {}),
      detail,
    });
  try {
    if (!isObject(params)) {
      throw new OfficeError("bad_request", "parameters must be an object");
    }
    const project = projectForSession(deps.sessionKey, deps.home);
    const req = parsePurchaseOrderRequest(params.order);
    const now = deps.now?.() ?? new Date();
    const po = buildPurchaseOrder(project, req, now);
    const docx = await renderDocx(po.doc, now);
    const xlsx = await renderXlsx(po.workbook, now);
    const max = deps.maxBytes ?? MAX_OUTPUT_BYTES;
    if (docx.buffer.length > max || xlsx.buffer.length > max) {
      throw new OfficeError("too_large", "the purchase order would be over the size limit");
    }
    const stem = `${req.lang === "ja" ? "発注書" : "purchase-order"}_${po.number}`;
    const target = { project, dir: "output/purchase-orders", stem };
    const word = writeUniqueTarget({ ...target, ext: "docx", buf: docx.buffer });
    const book = writeUniqueTarget({ ...target, ext: "xlsx", buf: xlsx.buffer });
    const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
    const d = po.draft;
    audit("ok", {
      lines: d.lines.length,
      suppliers: d.compared.length,
      deviatesFromLowest: d.deviatesFromLowest,
      bytes: docx.buffer.length + xlsx.buffer.length,
    });
    return result(
      [
        `Wrote purchase order draft ${po.number} to ${d.supplier} as ${word.rel} and ${book.rel} in the Project folder of "${project.name}". Nothing was issued or sent.`,
        `${d.lines.length} line(s): net ¥${d.totals.net.toLocaleString("en-US")}, tax ¥${d.totals.tax.toLocaleString("en-US")}, total ¥${d.totals.total.toLocaleString("en-US")} (computed from the quotes).`,
        d.deviatesFromLowest
          ? `${d.supplier} is not the lowest complete quote (${d.lowest.join(", ")}); the reason is printed on the draft for approval.`
          : `${d.supplier} is the lowest complete quote.`,
        "A person reviews and issues it.",
      ].join("\n"),
      {
        path: word.rel,
        workbook: book.rel,
        number: po.number,
        supplier: d.supplier,
        lines: d.lines.length,
        net: d.totals.net,
        tax: d.totals.tax,
        total: d.totals.total,
        lowest: d.lowest,
        deviatesFromLowest: d.deviatesFromLowest,
        documentSha256: sha(docx.buffer),
        workbookSha256: sha(xlsx.buffer),
        quoteFiles: po.quoteFiles,
      },
    );
  } catch (err) {
    if (err instanceof OfficeError || err instanceof QuoteError) {
      const code = err instanceof OfficeError ? err.code : "bad_request";
      audit(code === "bad_request" || code === "too_large" ? "failed" : "denied", { code });
      return result(`Error: ${err.message}`, { error: code });
    }
    audit("failed", { code: "internal" });
    return result("Error: the purchase order could not be written", { error: "internal" });
  }
}

/** True when a quotation numbered `number` was written into this Project's output/quotes. */
function quoteWritten(project: Project, number: string): boolean {
  for (const prefix of ["見積書", "quotation"]) {
    for (const ext of ["docx", "xlsx"] as const) {
      try {
        resolveTarget({
          project,
          path: `output/quotes/${prefix}_${number}.${ext}`,
          ext,
          overwrite: false,
        });
      } catch (err) {
        if (err instanceof OfficeError && err.code === "exists") {
          return true;
        }
      }
    }
  }
  return false;
}

async function runQuote(
  deps: OfficeToolDeps,
  params: Record<string, unknown>,
): Promise<ToolResult> {
  const audit = (outcome: "ok" | "denied" | "failed", detail: Record<string, unknown>) =>
    deps.audit?.({
      action: "office.quote.create",
      outcome,
      ...(deps.agentId ? { identity: deps.agentId } : {}),
      ...(deps.sessionKey ? { scope: deps.sessionKey } : {}),
      detail,
    });
  try {
    if (!isObject(params)) {
      throw new OfficeError("bad_request", "parameters must be an object");
    }
    const project = projectForSession(deps.sessionKey, deps.home);
    const req = parseQuoteRequest(params.quote);
    const now = deps.now?.() ?? new Date();
    const q = buildQuote(project, req, now);
    // A revision supersedes a quotation written here; never one that was not.
    if (q.supersedes && !quoteWritten(project, q.supersedes)) {
      throw new OfficeError(
        "bad_request",
        `there is no quotation ${q.supersedes} in output/quotes of this Project to revise`,
      );
    }
    const docx = await renderDocx(q.doc, now);
    const xlsx = await renderXlsx(q.workbook, now);
    const max = deps.maxBytes ?? MAX_OUTPUT_BYTES;
    if (docx.buffer.length > max || xlsx.buffer.length > max) {
      throw new OfficeError("too_large", "the quotation would be over the size limit; split it");
    }
    const stem = `${req.lang === "ja" ? "見積書" : "quotation"}_${q.number}`;
    const word = writeUniqueTarget({
      project,
      dir: "output/quotes",
      stem,
      ext: "docx",
      buf: docx.buffer,
    });
    const book = writeUniqueTarget({
      project,
      dir: "output/quotes",
      stem,
      ext: "xlsx",
      buf: xlsx.buffer,
    });
    const priced = q.totals?.lines.length ?? 0;
    // The exact content a person approves: the item records both files' SHA-256.
    const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
    audit("ok", {
      lines: priced,
      unpriced: q.unpriced.length,
      bytes: docx.buffer.length + xlsx.buffer.length,
    });
    const lines = [
      `Wrote quotation ${q.number} as ${word.rel} and ${book.rel} in the Project folder of "${project.name}". Nothing was sent.`,
      q.totals
        ? `${priced} priced line(s): subtotal ¥${q.totals.subtotal.toLocaleString("en-US")}, tax ¥${q.totals.tax.toLocaleString("en-US")}, total ¥${q.totals.total.toLocaleString("en-US")} (computed from the price list).`
        : "No line could be priced from the price list.",
      ...(q.unpriced.length > 0
        ? [
            `${q.unpriced.length} line(s) need a price from a person (要確認), not in the totals: ${q.unpriced
              .map((u) => `${u.code ?? u.description} (${u.reason})`)
              .join("; ")
              .slice(0, 600)}.`,
          ]
        : []),
      ...(q.priceListProblems > 0
        ? [`The price list has ${q.priceListProblems} row(s) with problems that were skipped.`]
        : []),
      ...(q.priceListStale
        ? [
            `The price list was last changed ${q.priceListUpdated} (${q.priceListAgeDays} days ago): a person confirms its prices are current before this quotation is approved (価格表の更新日を要確認).`,
          ]
        : []),
      ...(q.provisional
        ? [
            "This is a provisional estimate (御見積書（暫定）): it cannot be approved as a final quotation until every item is priced and every 0% line is classified.",
          ]
        : []),
      `Valid until ${q.validUntil}. A person reviews and sends it.`,
    ];
    return result(lines.join("\n"), {
      path: word.rel,
      workbook: book.rel,
      number: q.number,
      lines: priced,
      unpriced: q.unpriced.length,
      ...(q.totals
        ? { subtotal: q.totals.subtotal, tax: q.totals.tax, total: q.totals.total }
        : {}),
      validUntil: q.validUntil,
      priceListSha256: q.priceListSha256,
      priceListUpdated: q.priceListUpdated,
      priceListAgeDays: q.priceListAgeDays,
      priceListMaxAgeDays: q.priceListMaxAgeDays,
      priceListOverdueDays: q.priceListOverdueDays,
      priceListStale: q.priceListStale,
      documentSha256: sha(docx.buffer),
      workbookSha256: sha(xlsx.buffer),
      zeroRateLines: q.zeroRateLines,
      provisional: q.provisional,
      revision: q.revision,
      ...(q.supersedes ? { supersedes: q.supersedes } : {}),
      excluded: q.excluded,
    });
  } catch (err) {
    if (err instanceof OfficeError) {
      audit(err.code === "bad_request" || err.code === "too_large" ? "failed" : "denied", {
        code: err.code,
      });
      return result(`Error: ${err.message}`, { error: err.code });
    }
    audit("failed", { code: "internal" });
    return result("Error: the quotation could not be written", { error: "internal" });
  }
}

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
    {
      name: "office_quote_create",
      label: "Office: create quotation (見積書)",
      description:
        "Write a quotation (見積書) into the current Project's output/quotes/ as Word and Excel. Give the customer, the subject and the requested lines (item code or name, and quantity) only: unit prices come from the Project's price list (default quotes/price-list.csv; columns 品番, 品名, 単価, optional 単位, 税率, 原価), and every amount, the consumption tax per rate and the totals are computed by Kurahi, never by you. A line the price list cannot match exactly is marked 【要確認】 for a person to price and is left out of the totals. Issuer details and rounding come from quotes/company.json when present. Nothing is sent; a person reviews and sends the quotation. Needs a Project in 実行 Act mode.",
      parameters: quoteParams,
      execute: (_id: string, params: Record<string, unknown>) => runQuote(deps, params),
    },
    {
      name: "office_quote_compare",
      label: "Office: compare supplier quotations (相見積)",
      description:
        "Compare quotations from two or more suppliers for the same request (相見積). Give the requested items (code and quantity) and, per supplier, the lines exactly as quoted (item code, quantity, tax-exclusive unit price, tax rate, discounts). Kurahi computes every amount, never you, and compares the tax-exclusive net. A quote that leaves out an item or quotes a different quantity is incomplete and is never named lowest. The result is not an award: a person decides. Read-only; nothing is written or sent.",
      parameters: compareParams,
      execute: async (_id: string, params: Record<string, unknown>) => runCompare(deps, params),
    },
    {
      name: "office_po_create",
      label: "Office: draft a purchase order (発注書)",
      description:
        "Write a purchase order draft (発注書) into the current Project's output/purchase-orders/ as Word and Excel, for the supplier a PERSON chose from a 相見積 comparison. Give the comparison exactly as for office_quote_compare, the chosen supplier, the person who chose it, and their reason when it is not the lowest complete quote. Kurahi recomputes the comparison and every amount; an incomplete quote is refused. Never choose the supplier yourself. Nothing is issued or sent; a person reviews and issues it. Needs a Project in 実行 Act mode.",
      parameters: poParams,
      execute: (_id: string, params: Record<string, unknown>) => runPurchaseOrder(deps, params),
    },
  ];
  return tools as unknown as AnyAgentTool[];
}
