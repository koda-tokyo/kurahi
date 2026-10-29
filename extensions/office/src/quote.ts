// 見積書 (quotation) from requested lines: priced from the Project's price list and computed by
// src/quotes (exact arithmetic, tax per rate under the qualified-invoice rule), then laid out as
// a Word document and an Excel workbook. The model supplies only what was asked for (item code
// or name, quantity); it never supplies a price or a total. A line the price list cannot price
// is shown as 【要確認】 with no amount and left out of the totals, for a person to price.
import fs from "node:fs";
import type { DocBlock, DocSpec } from "../../../src/office/docx.js";
import type { Project } from "../../../src/projects/types.js";
import type { WorkbookSpec } from "./xlsx.js";
import { isObject, OfficeError } from "../../../src/office/common.js";
import { resolveProjectFile } from "../../../src/projects/scope.js";
import {
  calculateQuote,
  QuoteError,
  ROUNDING_MODES,
  type QuoteLineInput,
  type QuoteTotals,
  type RoundingMode,
} from "../../../src/quotes/calculate.js";
import {
  priceRequest,
  readPriceListRows,
  type RequestedLine,
} from "../../../src/quotes/price-list.js";
import {
  readSheet,
  readSupplierQuoteFile as readSupplierQuoteFileOrThrow,
  sha256Hex,
  readTrustedQuotesFile as readTrustedQuotesFileOrThrow,
} from "../../../src/quotes/quotes-file.js";

export const QUOTE_LIMITS = {
  lines: 200,
  text: 500,
  notes: 2000,
  validityDays: 365,
  excluded: 50,
  revisions: 99,
  /** A person's reason for taking an item out of scope (as long as an override reason). */
  minExclusionReason: 10,
};

/** An item a person took out of the quotation's scope, with their reason. */
export type ExcludedLine = {
  code?: string;
  description: string;
  quantity?: string | number;
  reason: string;
};
export const DEFAULT_PRICE_LIST = "quotes/price-list.csv";
export const COMPANY_FILE = "quotes/company.json";
/** A price list not changed for longer than this many days is flagged for a person to confirm. */
export const DEFAULT_PRICE_LIST_MAX_AGE_DAYS = 180;

export type QuoteRequest = {
  customer: string;
  honorific: string;
  /** A named person at the customer (様), printed under the company (御中 then applies to none). */
  attention?: string;
  subject: string;
  lines: RequestedLine[];
  /** Items a person removed from scope (printed as 対象外 with the reason; not unpriced). */
  excluded: ExcludedLine[];
  number?: string;
  /** Revision of this quotation (1 = first). R2 and later name the version they supersede. */
  revision: number;
  validityDays: number;
  delivery?: string;
  paymentTerms?: string;
  notes?: string;
  documentDiscount?: number;
  lang: "ja" | "en";
  priceList: string;
};

export type Company = {
  name?: string;
  address?: string;
  phone?: string;
  /** Responsible department and contact person printed on the quotation. */
  department?: string;
  contact?: string;
  /** 適格請求書発行事業者登録番号, T + 13 digits. */
  registrationNumber?: string;
  lineRounding?: RoundingMode;
  taxRounding?: RoundingMode;
  /** Days after which the price list is flagged as possibly out of date (1–3650). */
  priceListMaxAgeDays?: number;
};

const text = (v: unknown, max: number): string =>
  typeof v === "string"
    ? v
        // oxlint-disable-next-line no-control-regex -- strips control characters on purpose
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
        .trim()
        .slice(0, max)
    : "";

/** Validate the tool's `quote` object. Throws OfficeError("bad_request") on bad input. */
export function parseQuoteRequest(raw: unknown): QuoteRequest {
  if (!isObject(raw)) {
    throw new OfficeError("bad_request", "quote must be an object");
  }
  const customer = text(raw.customer, QUOTE_LIMITS.text);
  const subject = text(raw.subject, QUOTE_LIMITS.text);
  if (!customer) {
    throw new OfficeError("bad_request", "quote.customer is required");
  }
  if (!subject) {
    throw new OfficeError("bad_request", "quote.subject is required");
  }
  if (!Array.isArray(raw.lines) || raw.lines.length === 0) {
    throw new OfficeError("bad_request", "quote.lines needs at least one line");
  }
  if (raw.lines.length > QUOTE_LIMITS.lines) {
    throw new OfficeError("bad_request", `quote.lines has more than ${QUOTE_LIMITS.lines} lines`);
  }
  const lines = raw.lines.map((l, i): RequestedLine => {
    if (!isObject(l)) {
      throw new OfficeError("bad_request", `quote.lines[${i}] must be an object`);
    }
    const description = text(l.description, QUOTE_LIMITS.text);
    // A code is refused when too long, never cut: a shortened code could name a different item.
    const code = text(l.code, Number.MAX_SAFE_INTEGER);
    if (code.length > 64) {
      throw new OfficeError("bad_request", `quote.lines[${i}].code is longer than 64 characters`);
    }
    const q = l.quantity;
    if (!description && !code) {
      throw new OfficeError("bad_request", `quote.lines[${i}] needs a code or a description`);
    }
    if (typeof q !== "number" && typeof q !== "string") {
      throw new OfficeError("bad_request", `quote.lines[${i}].quantity is required`);
    }
    // Prices from the model are ignored by design; reject them so nobody thinks they apply.
    if ("unit_price" in l || "unitPrice" in l || "price" in l || "amount" in l) {
      throw new OfficeError(
        "bad_request",
        `quote.lines[${i}]: prices come from the price list, not from the request`,
      );
    }
    return { ...(code ? { code } : {}), description: description || code, quantity: q };
  });
  const days = raw.validity_days === undefined ? 30 : raw.validity_days;
  if (
    typeof days !== "number" ||
    !Number.isInteger(days) ||
    days < 1 ||
    days > QUOTE_LIMITS.validityDays
  ) {
    throw new OfficeError(
      "bad_request",
      `quote.validity_days must be a whole number from 1 to ${QUOTE_LIMITS.validityDays}`,
    );
  }
  const lang = raw.language === "en" ? "en" : "ja";
  const discount = raw.document_discount;
  if (
    discount !== undefined &&
    (typeof discount !== "number" || !Number.isSafeInteger(discount) || discount < 0)
  ) {
    throw new OfficeError("bad_request", "quote.document_discount must be a whole number of yen");
  }
  const number = text(raw.number, 40);
  if (number && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(number)) {
    throw new OfficeError("bad_request", "quote.number may use letters, digits, '.', '_' and '-'");
  }
  const revision = raw.revision === undefined ? 1 : raw.revision;
  if (
    typeof revision !== "number" ||
    !Number.isInteger(revision) ||
    revision < 1 ||
    revision > QUOTE_LIMITS.revisions
  ) {
    throw new OfficeError(
      "bad_request",
      `quote.revision must be a whole number from 1 to ${QUOTE_LIMITS.revisions}`,
    );
  }
  if (revision > 1 && !number) {
    throw new OfficeError(
      "bad_request",
      "a revision needs quote.number: the number of the quotation it revises",
    );
  }
  if (revision > 1 && /-R\d+$/i.test(number)) {
    throw new OfficeError(
      "bad_request",
      "quote.number for a revision is the original number, without -R…: the revision adds it",
    );
  }
  const rawExcluded = raw.excluded === undefined ? [] : raw.excluded;
  if (!Array.isArray(rawExcluded) || rawExcluded.length > QUOTE_LIMITS.excluded) {
    throw new OfficeError(
      "bad_request",
      `quote.excluded must be a list of at most ${QUOTE_LIMITS.excluded} items`,
    );
  }
  const excluded = rawExcluded.map((e, i): ExcludedLine => {
    if (!isObject(e)) {
      throw new OfficeError("bad_request", `quote.excluded[${i}] must be an object`);
    }
    const description = text(e.description, QUOTE_LIMITS.text);
    const code = text(e.code, 64);
    const reason = text(e.reason, QUOTE_LIMITS.text);
    if (!description && !code) {
      throw new OfficeError("bad_request", `quote.excluded[${i}] needs a code or a description`);
    }
    if (reason.length < QUOTE_LIMITS.minExclusionReason) {
      throw new OfficeError(
        "bad_request",
        `quote.excluded[${i}].reason must say why the item is out of scope (at least ${QUOTE_LIMITS.minExclusionReason} characters)`,
      );
    }
    const q = e.quantity;
    return {
      ...(code ? { code } : {}),
      description: description || code,
      ...(typeof q === "number" || typeof q === "string" ? { quantity: q } : {}),
      reason,
    };
  });
  // An item is either quoted or out of scope, never both.
  const same = (a: string) => a.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");
  for (const [i, e] of excluded.entries()) {
    const clash = lines.find((l) =>
      e.code && l.code
        ? same(e.code) === same(l.code)
        : same(e.description) === same(l.description),
    );
    if (clash) {
      throw new OfficeError(
        "bad_request",
        `quote.excluded[${i}] is also a quoted line (${clash.code ?? clash.description}); an item is either quoted or out of scope`,
      );
    }
  }
  return {
    customer,
    honorific:
      text(raw.honorific, 10) || (lang === "ja" ? (text(raw.attention, 100) ? "" : "御中") : ""),
    ...(text(raw.attention, 100) ? { attention: text(raw.attention, 100) } : {}),
    subject,
    lines,
    excluded,
    ...(number ? { number } : {}),
    revision,
    validityDays: days,
    ...(text(raw.delivery, QUOTE_LIMITS.text)
      ? { delivery: text(raw.delivery, QUOTE_LIMITS.text) }
      : {}),
    ...(text(raw.payment_terms, QUOTE_LIMITS.text)
      ? { paymentTerms: text(raw.payment_terms, QUOTE_LIMITS.text) }
      : {}),
    ...(text(raw.notes, QUOTE_LIMITS.notes) ? { notes: text(raw.notes, QUOTE_LIMITS.notes) } : {}),
    ...(discount !== undefined ? { documentDiscount: discount } : {}),
    lang,
    priceList: text(raw.price_list, 256) || DEFAULT_PRICE_LIST,
  };
}

/** The Project's optional quotes/company.json (issuer details, rounding). Missing = none. */
export function readCompany(project: Project): Company {
  let file: string;
  try {
    file = resolveProjectFile(project.folder, COMPANY_FILE);
  } catch {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    throw new OfficeError("bad_request", `${COMPANY_FILE} is not valid JSON`);
  }
  if (!isObject(raw)) {
    return {};
  }
  const mode = (v: unknown) =>
    (ROUNDING_MODES as readonly unknown[]).includes(v) ? (v as RoundingMode) : undefined;
  // Not cut to length first: a 14-digit typo must be refused, not shortened into a valid shape.
  const reg = text(raw.registrationNumber, Number.MAX_SAFE_INTEGER).normalize("NFKC");
  if (reg && !/^T\d{13}$/.test(reg)) {
    throw new OfficeError(
      "bad_request",
      `${COMPANY_FILE}: registrationNumber must be T and 13 digits`,
    );
  }
  // Refused, never defaulted: a mistyped threshold must not silently hide a stale-list warning.
  const maxAge = raw.priceListMaxAgeDays;
  if (
    maxAge !== undefined &&
    !(typeof maxAge === "number" && Number.isSafeInteger(maxAge) && maxAge >= 1 && maxAge <= 3650)
  ) {
    throw new OfficeError(
      "bad_request",
      `${COMPANY_FILE}: priceListMaxAgeDays must be a whole number of days from 1 to 3650`,
    );
  }
  return {
    ...(text(raw.name, 200) ? { name: text(raw.name, 200) } : {}),
    ...(text(raw.address, 300) ? { address: text(raw.address, 300) } : {}),
    ...(text(raw.phone, 40) ? { phone: text(raw.phone, 40) } : {}),
    ...(text(raw.department, 100) ? { department: text(raw.department, 100) } : {}),
    ...(text(raw.contact, 100) ? { contact: text(raw.contact, 100) } : {}),
    ...(reg ? { registrationNumber: reg } : {}),
    ...(mode(raw.lineRounding) ? { lineRounding: mode(raw.lineRounding) } : {}),
    ...(mode(raw.taxRounding) ? { taxRounding: mode(raw.taxRounding) } : {}),
    ...(maxAge !== undefined ? { priceListMaxAgeDays: maxAge } : {}),
  };
}

export type BuiltQuote = {
  number: string;
  issued: string;
  validUntil: string;
  totals: QuoteTotals | null;
  unpriced: Array<RequestedLine & { reason: string }>;
  priceListProblems: number;
  /** Lines at 0% (a final quotation needs their classification; provisional until supported). */
  zeroRateLines: number;
  revision: number;
  supersedes?: string;
  excluded: number;
  provisional: boolean;
  /** SHA-256 of the price list bytes the quotation was priced from (the frozen version). */
  priceListSha256: string;
  /** The list file's last change (JST date) and its age in days on the issue date. */
  priceListUpdated: string;
  priceListAgeDays: number;
  /** The company's limit in days, and how many days the list is past it (0 when within it). */
  priceListMaxAgeDays: number;
  priceListOverdueDays: number;
  /**
   * Older than the company's limit: a person confirms the prices are current. A warning, not a
   * gate, since a copied or checked-out file looks new; a fresh date proves nothing.
   */
  priceListStale: boolean;
  doc: DocSpec;
  workbook: WorkbookSpec;
};

/** Date in Japan time as YYYY-MM-DD. */
export function jstDate(d: Date): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;

export { priceListDistrust } from "../../../src/quotes/quotes-file.js";

/** The shared quotes/ readers, with their refusals as an office bad request. */
function asBadRequest<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    if (err instanceof QuoteError) {
      throw new OfficeError("bad_request", err.message);
    }
    throw err;
  }
}

function readTrustedQuotesFile(project: Project, rel: string, label: string) {
  return asBadRequest(() => readTrustedQuotesFileOrThrow(project, rel, label));
}

/** A supplier's quotation sheet (相見積) under quotes/; see src/quotes/quotes-file.ts. */
export function readSupplierQuoteFile(
  project: Project,
  rel: string,
): { lines: QuoteLineInput[]; sha256: string } {
  return asBadRequest(() => readSupplierQuoteFileOrThrow(project, rel));
}

/** Price, compute and lay out a quotation. Reads only the price list and company file. */
export function buildQuote(project: Project, req: QuoteRequest, now: Date): BuiltQuote {
  const {
    file: listFile,
    bytes,
    mtime: listChanged,
  } = readTrustedQuotesFile(project, req.priceList, "price list");
  let list;
  let priceListSha256: string;
  try {
    priceListSha256 = sha256Hex(bytes);
    const sheet = readSheet(listFile, bytes);
    list = readPriceListRows(sheet.rows, undefined, sheet.rowNumbers);
  } catch (err) {
    throw new OfficeError("bad_request", `price list ${req.priceList}: ${(err as Error).message}`);
  }
  const company = readCompany(project);
  const { priced, unpriced } = priceRequest(req.lines, list);
  let totals: QuoteTotals | null = null;
  if (priced.length > 0) {
    try {
      totals = calculateQuote(priced, {
        lineRounding: company.lineRounding,
        taxRounding: company.taxRounding,
        documentDiscount: req.documentDiscount,
      });
    } catch (err) {
      if (err instanceof QuoteError) {
        throw new OfficeError("bad_request", err.message);
      }
      throw err;
    }
  } else if (req.documentDiscount) {
    throw new OfficeError("bad_request", "a document discount needs at least one priced line");
  }
  const issued = jstDate(now);
  const priceListUpdated = jstDate(listChanged);
  // Whole JST calendar days; a file dated after the issue date (clock skew) counts as 0.
  const priceListAgeDays = Math.max(
    0,
    Math.round((Date.parse(issued) - Date.parse(priceListUpdated)) / 86_400_000),
  );
  const priceListMaxAgeDays = company.priceListMaxAgeDays ?? DEFAULT_PRICE_LIST_MAX_AGE_DAYS;
  // Measured against the company's own limit, so a pack rule (max 0) never disagrees with it.
  const priceListOverdueDays = Math.max(0, priceListAgeDays - priceListMaxAgeDays);
  const priceListStale = priceListOverdueDays > 0;
  const validUntil = jstDate(new Date(now.getTime() + req.validityDays * 86_400_000));
  const base = req.number ?? `Q-${issued.replaceAll("-", "")}`;
  // Revisions: R2 supersedes the base number, R3 supersedes R2, and so on.
  const number = req.revision > 1 ? `${base}-R${req.revision}` : base;
  const supersedes =
    req.revision > 2 ? `${base}-R${req.revision - 1}` : req.revision === 2 ? base : undefined;
  const ja = req.lang === "ja";
  const L = ja
    ? {
        title: "御見積書",
        provisionalTitle: "御見積書（暫定）",
        provisional:
          "暫定合計—未確定項目あり。暫定見積として発行する場合は、未確定の項目を明示したまま、発行を承認した人が記録されます。正式な見積書にはなりません。",
        unpricedReason: "価格表で価格を確定できない品目があります",
        zeroRateReason:
          "税率 0% の品目があります（非課税・不課税・輸出免税の区分はまだ扱えないため、確認が必要です）",
        priceList: "価格表",
        department: "担当部署",
        contact: "担当者",
        no: "No.",
        code: "品番",
        item: "品名",
        qty: "数量",
        unit: "単位",
        price: "単価",
        amount: "金額",
        rate: "税率",
        number: "見積番号",
        issued: "発行日",
        valid: "有効期限",
        subject: "件名",
        delivery: "納期",
        payment: "支払条件",
        issuer: "発行者",
        reg: "登録番号",
        revision: "改訂",
        supersedes: "前版",
        excludedTitle: "対象外の品目",
        excludedNote: "次の品目は、担当者が理由を記録して見積の対象から外しました。",
        reasonCol: "理由",
        subtotal: "小計（税抜）",
        discount: "値引き",
        taxable: (r: number) => `${r}%対象（税抜）`,
        tax: (r: number) => `消費税（${r}%）`,
        total: "合計（税込）",
        unpricedTitle: "【要確認】価格未設定の品目",
        unpricedNote:
          "次の品目は価格表で価格を確定できませんでした。担当者が価格を確認するまで、合計には含まれていません。",
        intro: "下記のとおり御見積申し上げます。",
        notes: "備考",
        footer: "本見積書は承認前の下書きです。送付前に担当者が内容を確認してください。",
        sheet: "見積書",
        info: "概要",
        reduced: "※ 8% は軽減税率対象",
      }
    : {
        title: "Quotation",
        provisionalTitle: "Quotation (provisional)",
        provisional:
          "Provisional total — open items remain. If released as a provisional estimate, the open items stay visible and the person who authorised the release is recorded. It is not a final quotation.",
        unpricedReason: "Some items could not be priced from the price list",
        zeroRateReason:
          "Some items are at 0% (非課税, 不課税 and export exemption are not distinguished yet; confirm the classification)",
        priceList: "Price list",
        department: "Department",
        contact: "Contact",
        no: "No.",
        code: "Code",
        item: "Item",
        qty: "Qty",
        unit: "Unit",
        price: "Unit price",
        amount: "Amount",
        rate: "Tax",
        number: "Quotation no.",
        issued: "Issued",
        valid: "Valid until",
        subject: "Subject",
        delivery: "Delivery",
        payment: "Payment terms",
        issuer: "Issued by",
        reg: "Registration no.",
        revision: "Revision",
        supersedes: "Supersedes",
        excludedTitle: "Items out of scope",
        excludedNote: "A person took these items out of the quotation's scope and recorded why.",
        reasonCol: "Reason",
        subtotal: "Subtotal (excl. tax)",
        discount: "Discount",
        taxable: (r: number) => `Taxable at ${r}% (excl. tax)`,
        tax: (r: number) => `Consumption tax (${r}%)`,
        total: "Total (incl. tax)",
        unpricedTitle: "【要確認】Items without a price",
        unpricedNote:
          "The price list could not price these items. They are not in the totals until a person prices them.",
        intro: "We are pleased to quote as follows.",
        notes: "Notes",
        footer: "Draft quotation awaiting approval. A person reviews it before it is sent.",
        sheet: "Quotation",
        info: "Summary",
        reduced: "8% is the reduced rate",
      };

  const info: [string, string][] = [
    [L.number, number],
    ...(req.revision > 1 ? ([[L.revision, String(req.revision)]] as [string, string][]) : []),
    ...(supersedes ? ([[L.supersedes, supersedes]] as [string, string][]) : []),
    [L.issued, issued],
    [L.valid, validUntil],
    [L.subject, req.subject],
    ...(req.delivery ? ([[L.delivery, req.delivery]] as [string, string][]) : []),
    ...(req.paymentTerms ? ([[L.payment, req.paymentTerms]] as [string, string][]) : []),
    ...(company.name ? ([[L.issuer, company.name]] as [string, string][]) : []),
    ...(company.department ? ([[L.department, company.department]] as [string, string][]) : []),
    ...(company.contact ? ([[L.contact, company.contact]] as [string, string][]) : []),
    ...(company.registrationNumber
      ? ([[L.reg, company.registrationNumber]] as [string, string][])
      : []),
    // The frozen price-list version: the file and the first 12 hex digits of its SHA-256.
    [L.priceList, `${req.priceList} · sha256 ${priceListSha256.slice(0, 12)}`],
  ];
  // Final quotations need every item priced and every tax classification supported; until 非課税,
  // 不課税 and 免税 are distinguished, a 0% line makes the quotation provisional.
  const zeroRateLines = (totals?.lines ?? []).filter((l) => l.taxRate === 0).length;
  const provisionalReasons = [
    ...(unpriced.length > 0 ? [L.unpricedReason] : []),
    ...(zeroRateLines > 0 ? [L.zeroRateReason] : []),
  ];
  const provisional = provisionalReasons.length > 0;
  const recipient = `${req.customer}${req.honorific ? ` ${req.honorific}` : ""}${
    req.attention ? `\n${req.attention} ${ja ? "様" : ""}`.trimEnd() : ""
  }`;

  const lineRows = (totals?.lines ?? []).map((l, i) => [
    String(i + 1),
    l.code ?? "",
    l.description,
    l.quantity,
    l.unit ?? "",
    yen(Number(l.unitPrice)),
    l.discount > 0 ? `${yen(l.amount)} (−${yen(l.discount)})` : yen(l.amount),
    `${l.taxRate}%`,
  ]);
  // Totals as numbers (a discount is negative); formatted for Word, numeric in Excel.
  const sums: [string, number][] = [];
  if (totals) {
    sums.push([L.subtotal, totals.subtotal]);
    if (totals.documentDiscount > 0) {
      sums.push([L.discount, -totals.documentDiscount]);
    }
    for (const b of totals.buckets) {
      sums.push([L.taxable(b.rate), b.taxable]);
      if (b.rate > 0) {
        sums.push([L.tax(b.rate), b.tax]);
      }
    }
    sums.push([L.total, totals.total]);
  }
  const sumRows = sums.map(([label, n]) => [label, n < 0 ? `−${yen(-n)}` : yen(n)]);

  const blocks: DocBlock[] = [
    { type: "paragraph", text: `${req.customer}${req.honorific ? ` ${req.honorific}` : ""}` },
    ...(req.attention
      ? ([{ type: "paragraph", text: `${req.attention}${ja ? " 様" : ""}` }] as DocBlock[])
      : []),
    ...(provisional
      ? ([
          { type: "heading", level: 2, text: L.provisional },
          { type: "bullets", items: provisionalReasons.map((t) => ({ text: t, level: 0 })) },
        ] as DocBlock[])
      : []),
    { type: "paragraph", text: L.intro },
    { type: "table", header: [ja ? "項目" : "Field", ja ? "内容" : "Value"], rows: info },
  ];
  if (totals) {
    blocks.push({
      type: "paragraph",
      text: provisional
        ? `${L.total}: ${yen(totals.total)} (${ja ? "暫定" : "provisional"})`
        : `${L.total}: ${yen(totals.total)}`,
    });
    blocks.push({
      type: "table",
      header: [L.no, L.code, L.item, L.qty, L.unit, L.price, L.amount, L.rate],
      rows: lineRows,
    });
    blocks.push({ type: "table", header: ["", ""], rows: sumRows });
    if (totals.buckets.some((b) => b.rate === 8)) {
      blocks.push({ type: "paragraph", text: L.reduced });
    }
  }
  if (unpriced.length > 0) {
    blocks.push({ type: "heading", level: 2, text: L.unpricedTitle });
    blocks.push({ type: "paragraph", text: L.unpricedNote });
    blocks.push({
      type: "table",
      header: [L.code, L.item, L.qty],
      rows: unpriced.map((u) => [u.code ?? "", u.description, String(u.quantity)]),
    });
  }
  if (req.excluded.length > 0) {
    blocks.push({ type: "heading", level: 2, text: L.excludedTitle });
    blocks.push({ type: "paragraph", text: L.excludedNote });
    blocks.push({
      type: "table",
      header: [L.code, L.item, L.qty, L.reasonCol],
      rows: req.excluded.map((e) => [
        e.code ?? "",
        e.description,
        e.quantity === undefined ? "" : String(e.quantity),
        e.reason,
      ]),
    });
  }
  if (req.notes) {
    blocks.push({ type: "heading", level: 2, text: L.notes });
    blocks.push({ type: "paragraph", text: req.notes });
  }
  if (company.address || company.phone) {
    blocks.push({
      type: "paragraph",
      text: [company.name, company.address, company.phone].filter(Boolean).join("  "),
    });
  }

  const doc: DocSpec = {
    title: provisional ? L.provisionalTitle : L.title,
    subtitle: `${number} · ${issued}`,
    footer: L.footer,
    pageNumbers: true,
    pageSize: "A4",
    lang: req.lang,
    blocks,
  };

  const lineSheetRows: (string | number | null)[][] = (totals?.lines ?? []).map((l, i) => [
    i + 1,
    l.code ?? "",
    l.description,
    Number(l.quantity),
    l.unit ?? "",
    Number(l.unitPrice),
    l.discount,
    l.amount,
    l.taxRate / 100,
  ]);
  for (const e of req.excluded) {
    lineSheetRows.push([
      null,
      e.code ?? "",
      `${e.description} (${L.excludedTitle}: ${e.reason})`,
      Number(e.quantity) || null,
      "",
      null,
      null,
      null,
      null,
    ]);
  }
  for (const u of unpriced) {
    lineSheetRows.push([
      null,
      u.code ?? "",
      `${u.description} 【要確認】`,
      Number(u.quantity) || null,
      "",
      null,
      null,
      null,
      null,
    ]);
  }
  if (totals) {
    lineSheetRows.push([null, "", "", null, "", null, null, null, null]);
    for (const [label, n] of sums) {
      lineSheetRows.push([null, "", label, null, "", null, null, n, null]);
    }
  }
  const workbook: WorkbookSpec = {
    title: `${provisional ? L.provisionalTitle : L.title} ${number}`,
    sheets: [
      {
        name: L.sheet,
        header: [L.no, L.code, L.item, L.qty, L.unit, L.price, L.discount, L.amount, L.rate],
        rows: lineSheetRows,
        formats: ["", "", "", "#,##0.###", "", "#,##0.##", "#,##0", "#,##0", "0%"],
      },
      {
        name: L.info,
        header: [ja ? "項目" : "Field", ja ? "内容" : "Value"],
        rows: [[ja ? "宛先" : "Customer", recipient.replace("\n", " ")], ...info],
        formats: ["", ""],
      },
    ],
  };
  return {
    number,
    issued,
    validUntil,
    totals,
    unpriced,
    priceListProblems: list.problems.length,
    zeroRateLines,
    revision: req.revision,
    ...(supersedes ? { supersedes } : {}),
    excluded: req.excluded.length,
    provisional,
    priceListSha256,
    priceListUpdated,
    priceListAgeDays,
    priceListMaxAgeDays,
    priceListOverdueDays,
    priceListStale,
    doc,
    workbook,
  };
}
