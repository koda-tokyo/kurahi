// A supplier's quotation (相見積) read from its spreadsheet, CSV or .xlsx, into the lines
// compareSupplierQuotes prices. The same row checks as a price list (price-list.ts): an error
// cell, a formula without a saved value or a bad number refuses the row. Unlike a price list, a
// supplier quote is read whole or not at all: a skipped row would make the supplier look as if
// it had not quoted that item, and a duplicated code would make it unclear which price stands.
import { QuoteError, toScaled, type QuoteLineInput, type TaxRate } from "./calculate.js";
import { COMPARISON_LIMITS } from "./compare.js";
import {
  EXCEL_ERRORS,
  FORMULA_WITHOUT_VALUE,
  HEADERS,
  norm,
  parseTaxRate,
  priceText,
  quantityText,
} from "./price-list.js";

const QUOTE_HEADERS = {
  code: HEADERS.code,
  name: HEADERS.name,
  quantity: ["quantity", "qty", "数量"],
  unitPrice: [...HEADERS.unitPrice, "見積単価", "見積単価(税抜)", "見積単価（税抜）"],
  taxRate: HEADERS.taxRate,
};

/** Thrown with every problem found, so a person fixes the sheet in one pass. */
export class SupplierQuoteFileError extends Error {
  constructor(readonly problems: string[]) {
    super(`the supplier quote cannot be read: ${problems.join("; ")}`);
    this.name = "SupplierQuoteFileError";
  }
}

/**
 * Read a supplier quote from rows of cells, the first being the header. Each row names a
 * requested item code, the quoted quantity and the tax-exclusive unit price. Throws
 * SupplierQuoteFileError when any row has a problem.
 */
export function readSupplierQuoteRows(
  rows: string[][],
  rowNumbers?: number[],
  defaultTaxRate: TaxRate = 10,
): QuoteLineInput[] {
  if (rows.length < 2) {
    throw new SupplierQuoteFileError(["the sheet has no quoted lines"]);
  }
  const header = rows[0].map(norm);
  const col = (k: keyof typeof QUOTE_HEADERS) =>
    header.findIndex((h) => QUOTE_HEADERS[k].includes(h));
  const at = {
    code: col("code"),
    name: col("name"),
    quantity: col("quantity"),
    unitPrice: col("unitPrice"),
    taxRate: col("taxRate"),
  };
  const missing = (["code", "quantity", "unitPrice"] as const).filter((k) => at[k] < 0);
  if (missing.length > 0) {
    throw new SupplierQuoteFileError([
      `the sheet needs columns for ${missing.join(", ")} (e.g. 品番, 数量, 単価)`,
    ]);
  }
  if (rows.length - 1 > COMPARISON_LIMITS.items) {
    throw new SupplierQuoteFileError([
      `the sheet has more than ${COMPARISON_LIMITS.items} quoted lines`,
    ]);
  }
  const lines: QuoteLineInput[] = [];
  const seen = new Set<string>();
  const problems: string[] = [];
  rows.slice(1).forEach((r, idx) => {
    const line = rowNumbers?.[idx + 1] ?? idx + 2;
    const cell = (i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
    // Excel saves trailing empty rows into a CSV as ",,,"; they quote nothing.
    if (r.every((c) => c.trim() === "")) {
      return;
    }
    const code = cell(at.code).normalize("NFKC");
    const which = code ? ` (${code})` : "";
    if (r.includes(FORMULA_WITHOUT_VALUE)) {
      problems.push(
        `row ${line}${which}: a formula has no saved value; open and save the sheet in Excel`,
      );
      return;
    }
    const error = r.find((c) => EXCEL_ERRORS.has(c.trim().toUpperCase()));
    if (error) {
      problems.push(`row ${line}${which}: a cell shows the error ${error.trim()}`);
      return;
    }
    if (!code) {
      problems.push(`row ${line}: the item code is required`);
      return;
    }
    if (code.length > COMPARISON_LIMITS.code) {
      problems.push(`row ${line}: the item code is longer than ${COMPARISON_LIMITS.code}`);
      return;
    }
    if (seen.has(code)) {
      problems.push(`row ${line}: item code ${code} appears more than once`);
      return;
    }
    seen.add(code);
    const quantity = quantityText(cell(at.quantity));
    const unitPrice = priceText(cell(at.unitPrice));
    try {
      toScaled(quantity, 3, "quantity");
      toScaled(unitPrice, 2, "unit price");
    } catch (e) {
      if (!(e instanceof QuoteError)) {
        throw e;
      }
      problems.push(`row ${line}${which}: ${e.message}`);
      return;
    }
    const rawRate = cell(at.taxRate);
    const taxRate = rawRate ? parseTaxRate(rawRate) : defaultTaxRate;
    if (taxRate === null) {
      problems.push(`row ${line}${which}: tax rate must be 10, 8 or 0`);
      return;
    }
    // Refused, never cut, like every other cell.
    const name = cell(at.name);
    if (name.length > COMPARISON_LIMITS.description) {
      problems.push(
        `row ${line}${which}: the item name is longer than ${COMPARISON_LIMITS.description}`,
      );
      return;
    }
    lines.push({ code, description: name || code, quantity, unitPrice, taxRate });
  });
  if (problems.length > 0) {
    throw new SupplierQuoteFileError(problems);
  }
  if (lines.length === 0) {
    throw new SupplierQuoteFileError(["the sheet has no quoted lines"]);
  }
  return lines;
}
