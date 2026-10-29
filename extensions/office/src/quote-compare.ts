import { bad, isObject, list, reqStr, str } from "../../../src/office/common.js";
import {
  ROUNDING_MODES,
  TAX_RATES,
  type QuoteLineInput,
  type RoundingMode,
  type TaxRate,
} from "../../../src/quotes/calculate.js";
// Supplier quotation comparison (相見積) as an agent tool's input. The model transcribes what each
// supplier quoted, or names the supplier's sheet under quotes/ for Kurahi to read; compareSupplierQuotes prices every quote and says which complete quotes are
// lowest. Nothing is written and nothing is awarded: a person decides.
import {
  COMPARISON_LIMITS,
  type ComparisonItem,
  type QuoteComparison,
  type SupplierQuoteInput,
} from "../../../src/quotes/compare.js";

// The same limits as a stored procurement case, so po.prepare can draft from any recorded case.
export const COMPARE_LIMITS = COMPARISON_LIMITS;

/** Reads quotes[i].file into lines; only given where a Project's quotes/ folder can be read. */
export type QuoteFileReader = (file: string) => { lines: QuoteLineInput[]; sha256: string };

/** A supplier quote read from a file, so a person can tell which sheet was priced. */
export type QuoteFileUsed = { supplier: string; file: string; sha256: string };

export type CompareRequest = {
  items: ComparisonItem[];
  quotes: SupplierQuoteInput[];
  files: QuoteFileUsed[];
};

function num(v: unknown, where: string): string | number | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if ((typeof v === "number" && Number.isFinite(v)) || typeof v === "string") {
    return v;
  }
  return bad(`${where} must be a number`);
}

function rounding(v: unknown, where: string): RoundingMode | undefined {
  if (v === undefined || v === null) {
    return undefined;
  }
  if (!(ROUNDING_MODES as readonly unknown[]).includes(v)) {
    bad(`${where} must be one of ${ROUNDING_MODES.join(", ")}`);
  }
  return v as RoundingMode;
}

export function parseCompareRequest(v: unknown, readFile?: QuoteFileReader): CompareRequest {
  if (!isObject(v)) {
    bad("comparison must be an object");
  }
  const items = list(v.items, "items", { max: COMPARE_LIMITS.items, min: 1 }).map((raw, i) => {
    const where = `items[${i}]`;
    if (!isObject(raw)) {
      bad(`${where} must be an object`);
    }
    return {
      code: reqStr(raw.code, `${where}.code`, COMPARE_LIMITS.code),
      description: str(raw.description, `${where}.description`, {
        max: COMPARE_LIMITS.description,
      }),
      quantity: num(raw.quantity, `${where}.quantity`) ?? bad(`${where}.quantity is required`),
    };
  });
  const files: QuoteFileUsed[] = [];
  const quotes = list(v.quotes, "quotes", { max: COMPARE_LIMITS.suppliers, min: 2 }).map(
    (raw, i) => {
      const where = `quotes[${i}]`;
      if (!isObject(raw)) {
        bad(`${where} must be an object`);
      }
      const supplier = reqStr(raw.supplier, `${where}.supplier`, COMPARE_LIMITS.supplier);
      // A supplier's sheet is read by Kurahi rather than transcribed by the model.
      const file = str(raw.file, `${where}.file`, { max: 256 });
      if (file !== undefined) {
        if (raw.lines !== undefined && raw.lines !== null) {
          bad(`${where}: give lines or file, not both`);
        }
        if (!readFile) {
          bad(`${where}.file can only be read in a Project chat`);
        }
        const read = readFile(file);
        files.push({ supplier, file, sha256: read.sha256 });
        return { supplier, lines: read.lines, options: quoteOptions(raw, where) };
      }
      const lines = list(raw.lines, `${where}.lines`, {
        max: COMPARE_LIMITS.items,
        min: 1,
      }).map((l, j): QuoteLineInput => {
        const at = `${where}.lines[${j}]`;
        if (!isObject(l)) {
          bad(`${at} must be an object`);
        }
        // Number(null | "" | false | []) is 0, a valid rate: a missing rate must not become tax-free.
        const rate =
          typeof l.tax_rate === "number" ||
          (typeof l.tax_rate === "string" && /^\d+$/.test(l.tax_rate))
            ? Number(l.tax_rate)
            : Number.NaN;
        if (!(TAX_RATES as readonly number[]).includes(rate)) {
          bad(`${at}.tax_rate must be one of ${TAX_RATES.join(", ")}`);
        }
        const discountAmount = num(l.discount_amount, `${at}.discount_amount`);
        const code = reqStr(l.code, `${at}.code`, COMPARE_LIMITS.code);
        return {
          code,
          // A supplier's line is identified by the requested code; its own wording is optional.
          description:
            str(l.description, `${at}.description`, {
              max: COMPARE_LIMITS.description,
            }) ?? code,
          quantity: num(l.quantity, `${at}.quantity`) ?? bad(`${at}.quantity is required`),
          unitPrice: num(l.unit_price, `${at}.unit_price`) ?? bad(`${at}.unit_price is required`),
          taxRate: rate as TaxRate,
          discountPercent: num(l.discount_percent, `${at}.discount_percent`),
          ...(discountAmount === undefined ? {} : { discountAmount: Number(discountAmount) }),
        };
      });
      return { supplier, lines, options: quoteOptions(raw, where) };
    },
  );
  return { items, quotes, files };
}

function quoteOptions(raw: Record<string, unknown>, where: string): SupplierQuoteInput["options"] {
  const documentDiscount = num(raw.document_discount, `${where}.document_discount`);
  return {
    lineRounding: rounding(raw.line_rounding, `${where}.line_rounding`),
    taxRounding: rounding(raw.tax_rounding, `${where}.tax_rounding`),
    ...(documentDiscount === undefined ? {} : { documentDiscount: Number(documentDiscount) }),
  };
}

const yen = (n: number) => `¥${n.toLocaleString("en-US")}`;

/** A plain-language summary for the model; the numbers are the calculator's, never the model's. */
export function describeComparison(c: QuoteComparison): string {
  const lines = c.suppliers.map((s) => {
    const gaps = [
      ...(s.missing.length > 0 ? [`missing ${s.missing.join(", ")}`] : []),
      ...(s.quantityMismatch.length > 0
        ? [`different quantity for ${s.quantityMismatch.join(", ")}`]
        : []),
    ];
    return `- ${s.supplier}: net ${yen(s.totals.net)} (税抜), total ${yen(s.totals.total)} (税込)${
      s.complete ? "" : `; incomplete, not comparable: ${gaps.join("; ")}`
    }`;
  });
  const verdict =
    c.lowest.length === 0
      ? "No quote is complete, so none can be named lowest. Ask the suppliers to quote every item at the requested quantity."
      : c.lowest.length === 1
        ? `Lowest complete quote on the tax-exclusive net: ${c.lowest[0]} (${yen(c.lowestNet ?? 0)}).`
        : `Tie for the lowest complete quote on the tax-exclusive net (${yen(c.lowestNet ?? 0)}): ${c.lowest.join(", ")}.`;
  return [
    `Compared ${c.suppliers.length} supplier quotes for ${c.items.length} item(s); every amount was computed by Kurahi.`,
    ...lines,
    verdict,
    "This is not an award: price is one factor; a person checks delivery, terms and quality and decides. Nothing was written or sent.",
  ].join("\n");
}
