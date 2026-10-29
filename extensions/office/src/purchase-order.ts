// 発注書 (purchase order) draft from a supplier comparison, laid out as a Word document and an
// Excel workbook. preparePurchaseOrder recomputes the comparison from the request and the quotes,
// so the draft carries only figures Kurahi computed. The person who chose the supplier is named
// on it; choosing other than the lowest complete quote prints the written reason. A draft is
// never issued or sent: a person reviews it and issues it.
import type { DocBlock, DocSpec } from "../../../src/office/docx.js";
import type { Project } from "../../../src/projects/types.js";
import type { WorkbookSpec } from "./xlsx.js";
import { bad, isObject, str } from "../../../src/office/common.js";
import {
  MAX_SELECTION_TEXT,
  preparePurchaseOrder,
  type PurchaseOrderDraft,
} from "../../../src/quotes/purchase-order.js";
import { parseCompareRequest, type QuoteFileUsed } from "./quote-compare.js";
import { jstDate, readCompany, readSupplierQuoteFile } from "./quote.js";

export type PurchaseOrderRequest = {
  comparison: unknown;
  supplier: string;
  selectedBy: string;
  reason?: string;
  number?: string;
  delivery?: string;
  notes?: string;
  lang: "ja" | "en";
};

export type BuiltPurchaseOrder = {
  number: string;
  issued: string;
  draft: PurchaseOrderDraft;
  doc: DocSpec;
  workbook: WorkbookSpec;
  /** Supplier quotes read from sheets under quotes/, with their sha256. */
  quoteFiles: QuoteFileUsed[];
};

export function parsePurchaseOrderRequest(v: unknown): PurchaseOrderRequest {
  if (!isObject(v)) {
    bad("order must be an object");
  }
  const number = str(v.number, "number", { max: 40 });
  if (number && !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(number)) {
    bad("number may contain only letters, digits and hyphens");
  }
  const reason = str(v.reason, "reason", { max: MAX_SELECTION_TEXT });
  const delivery = str(v.delivery, "delivery", { max: 200 });
  const notes = str(v.notes, "notes", { max: 2000 });
  return {
    comparison: v.comparison,
    supplier: str(v.supplier, "supplier", { max: 200, required: true }) as string,
    selectedBy: str(v.selected_by, "selected_by", {
      max: MAX_SELECTION_TEXT,
      required: true,
    }) as string,
    ...(reason ? { reason } : {}),
    ...(number ? { number } : {}),
    ...(delivery ? { delivery } : {}),
    ...(notes ? { notes } : {}),
    lang: v.language === "en" ? "en" : "ja",
  };
}

const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;

export function buildPurchaseOrder(
  project: Project,
  req: PurchaseOrderRequest,
  now: Date,
): BuiltPurchaseOrder {
  const cmp = parseCompareRequest(req.comparison, (file) => readSupplierQuoteFile(project, file));
  const draft = preparePurchaseOrder(cmp.items, cmp.quotes, {
    supplier: req.supplier,
    selectedBy: req.selectedBy,
    ...(req.reason ? { reason: req.reason } : {}),
  });
  const company = readCompany(project);
  const issued = jstDate(now);
  const number = req.number ?? `PO-${issued.replaceAll("-", "")}`;
  const ja = req.lang === "ja";
  const L = ja
    ? {
        title: "発注書（下書き）",
        to: `${draft.supplier} 御中`,
        intro: "下記のとおり発注いたします。",
        no: "No.",
        code: "品番",
        item: "品名",
        qty: "数量",
        price: "単価",
        amount: "金額",
        rate: "税率",
        subtotal: "小計（税抜）",
        tax: "消費税",
        total: "合計（税込）",
        selectedBy: "選定者",
        reason: "最安以外を選定した理由",
        compared: "相見積先",
        lowest: "最安（完全な見積）",
        delivery: "納期",
        notes: "備考",
        footer: "下書き: 担当者が確認のうえ発行します。",
        sheet: "明細",
        info: "発注情報",
      }
    : {
        title: "Purchase order (draft)",
        to: draft.supplier,
        intro: "We place the following order.",
        no: "No.",
        code: "Code",
        item: "Item",
        qty: "Qty",
        price: "Unit price",
        amount: "Amount",
        rate: "Tax",
        subtotal: "Subtotal (excl. tax)",
        tax: "Consumption tax",
        total: "Total (incl. tax)",
        selectedBy: "Selected by",
        reason: "Reason for not choosing the lowest",
        compared: "Suppliers compared",
        lowest: "Lowest complete quote",
        delivery: "Delivery",
        notes: "Notes",
        footer: "Draft: a person reviews and issues it.",
        sheet: "Lines",
        info: "Order",
      };

  const info: string[][] = [
    [ja ? "発注番号" : "Order number", number],
    [ja ? "作成日" : "Prepared", issued],
    [L.selectedBy, draft.selectedBy],
    [L.compared, draft.compared.join(", ")],
    [
      L.lowest,
      draft.lowest.length > 0 && draft.lowestNet !== null
        ? `${draft.lowest.join(", ")} (${yen(draft.lowestNet)})`
        : "—",
    ],
    ...(draft.deviatesFromLowest && draft.reason ? [[L.reason, draft.reason]] : []),
    ...(req.delivery ? [[L.delivery, req.delivery]] : []),
    ...(company.name ? [[ja ? "発注者" : "Ordered by", company.name]] : []),
  ];
  const lineRows = draft.lines.map((l, i) => [
    String(i + 1),
    l.code ?? "",
    l.description,
    l.quantity,
    yen(Number(l.unitPrice)),
    yen(l.amount),
    `${l.taxRate}%`,
  ]);
  const sums: Array<[string, number]> = [
    [L.subtotal, draft.totals.net],
    [L.tax, draft.totals.tax],
    [L.total, draft.totals.total],
  ];
  const blocks: DocBlock[] = [
    { type: "paragraph", text: L.to },
    { type: "paragraph", text: L.intro },
    { type: "table", header: [ja ? "項目" : "Field", ja ? "内容" : "Value"], rows: info },
    { type: "paragraph", text: `${L.total}: ${yen(draft.totals.total)}` },
    {
      type: "table",
      header: [L.no, L.code, L.item, L.qty, L.price, L.amount, L.rate],
      rows: lineRows,
    },
    { type: "table", header: ["", ""], rows: sums.map(([k, n]) => [k, yen(n)]) },
  ];
  if (req.notes) {
    blocks.push({ type: "heading", level: 2, text: L.notes });
    blocks.push({ type: "paragraph", text: req.notes });
  }
  const doc: DocSpec = {
    title: L.title,
    subtitle: `${number} · ${issued}`,
    footer: L.footer,
    pageNumbers: true,
    pageSize: "A4",
    lang: req.lang,
    blocks,
  };
  const sheetRows: (string | number | null)[][] = draft.lines.map((l, i) => [
    i + 1,
    l.code ?? "",
    l.description,
    Number(l.quantity),
    Number(l.unitPrice),
    l.amount,
    l.taxRate / 100,
  ]);
  sheetRows.push([null, "", "", null, null, null, null]);
  for (const [label, n] of sums) {
    sheetRows.push([null, "", label, null, null, n, null]);
  }
  const workbook: WorkbookSpec = {
    title: `${L.title} ${number}`,
    sheets: [
      {
        name: L.sheet,
        header: [L.no, L.code, L.item, L.qty, L.price, L.amount, L.rate],
        rows: sheetRows,
        formats: ["", "", "", "#,##0.###", "#,##0.##", "#,##0", "0%"],
      },
      {
        name: L.info,
        header: [ja ? "項目" : "Field", ja ? "内容" : "Value"],
        rows: [[ja ? "発注先" : "Supplier", draft.supplier], ...info],
        formats: ["", ""],
      },
    ],
  };
  return { number, issued, draft, doc, workbook, quoteFiles: cmp.files };
}
