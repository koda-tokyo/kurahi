// Company price list for quotations (Kurahi Business, 見積管理). A CSV file in the Project:
// UTF-8 (with or without BOM) or Shift_JIS, the two encodings Excel writes in Japan; or an Excel
// workbook, read into the same rows by price-list-xlsx.ts. Headers may be Japanese or English. Prices are tax-exclusive (税抜) unit prices in yen.
//
// Matching is exact and deterministic: by item code, or by the exact item name. Nothing is
// guessed; a requested item that does not match stays unpriced and must be priced by a person.
import { TAX_RATES, toScaled, type QuoteLineInput, type TaxRate } from "./calculate.js";

export type PriceItem = {
  code: string;
  name: string;
  unit?: string;
  /** Decimal string, up to 2 places. */
  unitPrice: string;
  taxRate: TaxRate;
  /** Unit cost for margin checks, when the list has one. */
  cost?: string;
};

export type PriceList = {
  items: PriceItem[];
  byCode: Map<string, PriceItem>;
  byName: Map<string, PriceItem>;
  /** Row-level problems; rows with a problem are left out. */
  problems: string[];
};

export const PRICE_LIST_LIMITS = { bytes: 5_000_000, rows: 20_000, cellChars: 500 };

export const HEADERS: Record<keyof PriceItem, string[]> = {
  code: ["code", "item code", "sku", "品番", "商品コード", "品目コード", "コード"],
  name: ["name", "item", "description", "品名", "商品名", "品目", "名称"],
  unit: ["unit", "単位"],
  unitPrice: ["unit price", "price", "unitprice", "単価", "販売単価", "単価(税抜)", "単価（税抜）"],
  taxRate: ["tax rate", "tax", "taxrate", "税率", "消費税率"],
  cost: ["cost", "unit cost", "原価", "仕入単価"],
};

/** Decode CSV bytes: UTF-8 when valid (BOM stripped), otherwise Shift_JIS. */
export function decodeCsv(bytes: Uint8Array): string {
  if (bytes.byteLength > PRICE_LIST_LIMITS.bytes) {
    throw new Error(`the price list is larger than ${PRICE_LIST_LIMITS.bytes} bytes`);
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    text = new TextDecoder("shift_jis").decode(bytes);
  }
  return text.replace(/^﻿/, "");
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. Blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let i = 0;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== "") {
      rows.push(row);
    }
    row = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      endField();
    } else if (ch === "\n" || ch === "\r") {
      endRow();
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
    } else {
      field += ch;
    }
    i += 1;
    if (rows.length > PRICE_LIST_LIMITS.rows + 1) {
      throw new Error(`the price list has more than ${PRICE_LIST_LIMITS.rows} rows`);
    }
  }
  if (quoted) {
    throw new Error("the price list has an unterminated quoted field");
  }
  if (field !== "" || row.length > 0) {
    endRow();
  }
  return rows;
}

export const norm = (s: string) => s.normalize("NFKC").trim().toLowerCase().replace(/\s+/g, " ");

/** "10", "10%", "0.1", "８％" → 10; anything else → null. */
export function parseTaxRate(raw: string): TaxRate | null {
  const s = raw.normalize("NFKC").trim().replace(/%$/, "");
  const n = s === "0.1" ? 10 : s === "0.08" ? 8 : Number(s);
  return (TAX_RATES as readonly number[]).includes(n) ? (n as TaxRate) : null;
}

/** Normalise a price cell: full-width digits, thousands separators, a leading ¥ and a trailing 円 are accepted. */
export function priceText(raw: string): string {
  return ungroup(
    raw
      .normalize("NFKC")
      .trim()
      .replace(/^[¥￥]/, "")
      .replace(/円$/, ""),
  );
}

/** Normalise a quantity cell: full-width digits and thousands separators, but no currency mark. */
export function quantityText(raw: string): string {
  return ungroup(raw.normalize("NFKC").trim());
}

// Drop thousands separators only where they group by three ("1,200"); "1,2" may mean 1.2 in the
// sender's locale, so it keeps its comma and the decimal check refuses it rather than reading 12.
function ungroup(s: string): string {
  return /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s) ? s.replace(/,/g, "") : s;
}

/** Excel's error values, as a cell shows them and as Excel writes them into a CSV. */
export const EXCEL_ERRORS = new Set([
  "#N/A",
  "#REF!",
  "#VALUE!",
  "#DIV/0!",
  "#NAME?",
  "#NUM!",
  "#NULL!",
  "#SPILL!",
  "#CALC!",
  "#GETTING_DATA",
]);

/** A spreadsheet formula cell with no saved result: its value is unknown, so its row is refused. */
export const FORMULA_WITHOUT_VALUE = "\u0000formula";

/** Read a price list from CSV text. Throws when the header row lacks a required column. */
export function readPriceList(text: string, defaultTaxRate: TaxRate = 10): PriceList {
  return readPriceListRows(parseCsv(text), defaultTaxRate);
}

/**
 * Read a price list from rows of cells, the first being the header. `rowNumbers[i]` is the
 * number a person sees for rows[i] (a spreadsheet row); by default rows count from 1.
 */
export function readPriceListRows(
  rows: string[][],
  defaultTaxRate: TaxRate = 10,
  rowNumbers?: number[],
): PriceList {
  if (rows.length === 0) {
    throw new Error("the price list is empty");
  }
  const header = rows[0].map(norm);
  const col = (k: keyof PriceItem) => header.findIndex((h) => HEADERS[k].includes(h));
  const at = {
    code: col("code"),
    name: col("name"),
    unit: col("unit"),
    unitPrice: col("unitPrice"),
    taxRate: col("taxRate"),
    cost: col("cost"),
  };
  const missing = (["code", "name", "unitPrice"] as const).filter((k) => at[k] < 0);
  if (missing.length > 0) {
    throw new Error(
      `the price list needs columns for ${missing.join(", ")} (e.g. 品番, 品名, 単価)`,
    );
  }
  const items: PriceItem[] = [];
  const byCode = new Map<string, PriceItem>();
  const byName = new Map<string, PriceItem>();
  const dupNames = new Set<string>();
  const dupCodes = new Set<string>();
  // Every code a row named, valid or not: a broken row still makes its code ambiguous.
  const seenCodes = new Set<string>();
  const problems: string[] = [];
  rows.slice(1).forEach((r, idx) => {
    const line = rowNumbers?.[idx + 1] ?? idx + 2;
    const cell = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    const code = cell(at.code).normalize("NFKC");
    // The code is reserved before any other check, so a broken row still makes it ambiguous.
    if (code) {
      if (seenCodes.has(code)) {
        // Two rows for one code: neither is used, so no quote is priced from a guess.
        problems.push(
          `row ${line}: item code ${code} appears more than once; it is not priced until the list is fixed`,
        );
        dupCodes.add(code);
        return;
      }
      seenCodes.add(code);
    }
    // An oversized cell is refused, never cut: a shortened price or code would be a different one.
    if (r.some((c) => c.length > PRICE_LIST_LIMITS.cellChars)) {
      problems.push(`row ${line}: a cell is longer than ${PRICE_LIST_LIMITS.cellChars} characters`);
      return;
    }
    // An error cell (#N/A, #REF! …) is never read as a value; a blank tax rate would default.
    const which = code ? ` (${code})` : "";
    if (r.includes(FORMULA_WITHOUT_VALUE)) {
      problems.push(
        `row ${line}${which}: a formula has no saved value; open and save the list in Excel`,
      );
      return;
    }
    const error = r.find((c) => EXCEL_ERRORS.has(c.trim().toUpperCase()));
    if (error) {
      problems.push(`row ${line}${which}: a cell shows the error ${error.trim()}`);
      return;
    }
    const name = cell(at.name);
    if (!code || !name) {
      problems.push(`row ${line}: code and name are required`);
      return;
    }
    const unitPrice = priceText(cell(at.unitPrice));
    try {
      toScaled(unitPrice, 2, "unit price");
    } catch (e) {
      problems.push(`row ${line} (${code}): ${(e as Error).message}`);
      return;
    }
    const rawRate = cell(at.taxRate);
    const taxRate = rawRate ? parseTaxRate(rawRate) : defaultTaxRate;
    if (taxRate === null) {
      problems.push(`row ${line} (${code}): tax rate must be 10, 8 or 0`);
      return;
    }
    let cost: string | undefined;
    if (cell(at.cost)) {
      cost = priceText(cell(at.cost));
      try {
        toScaled(cost, 2, "cost");
      } catch (e) {
        problems.push(`row ${line} (${code}): ${(e as Error).message}`);
        return;
      }
    }
    const item: PriceItem = {
      code,
      name,
      ...(cell(at.unit) ? { unit: cell(at.unit) } : {}),
      unitPrice,
      taxRate,
      ...(cost !== undefined ? { cost } : {}),
    };
    items.push(item);
    byCode.set(code, item);
    const n = norm(name);
    if (byName.has(n)) {
      dupNames.add(n);
    } else {
      byName.set(n, item);
    }
  });
  // A duplicated code is removed with every row that used it, from both lookups.
  for (const code of dupCodes) {
    const first = byCode.get(code);
    byCode.delete(code);
    if (first) {
      items.splice(items.indexOf(first), 1);
      if (byName.get(norm(first.name)) === first) {
        byName.delete(norm(first.name));
      }
    }
  }
  // An ambiguous name never matches: the requester must give the item code.
  for (const n of dupNames) {
    byName.delete(n);
  }
  return { items, byCode, byName, problems };
}

export type RequestedLine = {
  code?: string;
  description: string;
  quantity: string | number;
};

export type PricedRequest = {
  /** Lines found in the price list, ready for calculateQuote. */
  priced: QuoteLineInput[];
  /** Requested lines with no exact match: a person prices them (要確認). */
  unpriced: (RequestedLine & { reason: string })[];
};

/** Price requested lines from the list: by exact code, else by exact (normalised) name. */
export function priceRequest(lines: RequestedLine[], list: PriceList): PricedRequest {
  const priced: QuoteLineInput[] = [];
  const unpriced: PricedRequest["unpriced"] = [];
  for (const l of lines) {
    const code = l.code?.normalize("NFKC").trim();
    const item = code ? list.byCode.get(code) : list.byName.get(norm(l.description));
    if (!item) {
      unpriced.push({
        ...l,
        reason: code
          ? `item code ${code} is not in the price list`
          : "no item code and no exact name match",
      });
      continue;
    }
    priced.push({
      code: item.code,
      description: item.name,
      quantity: l.quantity,
      ...(item.unit ? { unit: item.unit } : {}),
      unitPrice: item.unitPrice,
      taxRate: item.taxRate,
    });
  }
  return { priced, unpriced };
}
