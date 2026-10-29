import {
  attr,
  childElements,
  decodeUtf8Strict,
  onlyChild,
  parseXml,
  textOf,
  type XmlElement,
} from "../identity/saml/xml.js";
// An Excel price list (.xlsx) read into the same rows as a CSV one (price-list.ts), so every
// row check is shared. Only values are read: the first visible sheet, the values Excel saved
// (a formula's last result), never a macro or a link. The zip is read with the attachment
// policy's caps (src/security/attachment-policy.ts); each part with the strict XML parser
// (src/identity/saml/xml.ts), so a comment, DTD or CDATA is refused rather than read as cells.
import {
  DEFAULT_ZIP_LIMITS,
  readZipDirectory,
  readZipEntry,
} from "../security/attachment-policy.js";
import { FORMULA_WITHOUT_VALUE, PRICE_LIST_LIMITS } from "./price-list.js";

/** Columns read per row; a list needs a handful, and a far-off cell must not grow a huge row. */
const MAX_COLUMNS = 256;
/** Bytes the reader may inflate (workbook, shared strings, one sheet). */
const MAX_INFLATED = 64 * 1024 * 1024;

export type SheetRows = {
  /** The sheet the list was read from. */
  sheet: string;
  /** Non-empty rows, the first being the header. */
  rows: string[][];
  /** The spreadsheet row number of each row. */
  rowNumbers: number[];
};

const SML = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";
/** Parser limits for a workbook part: the inflate budget bounds the size, a list fits the nodes. */
const XML_LIMITS = { maxBytes: MAX_INFLATED, maxNodes: 4_000_000, maxAttrs: 64 };

/** OOXML escapes a character XML cannot hold as _xHHHH_ (ST_Xstring). */
const unescapeOoxml = (s: string) =>
  s.replace(/_x([0-9A-Fa-f]{4})_/g, (_, n: string) => String.fromCharCode(Number.parseInt(n, 16)));

/** The text of a string item (<si>, <is>): its runs, without the phonetic reading (ルビ). */
function stringItem(item: XmlElement): string {
  let text = "";
  for (const part of childElements(item, SML)) {
    if (part.local === "t") {
      text += textOf(part);
    } else if (part.local === "r") {
      text += childElements(part, SML, "t").map(textOf).join("");
    }
  }
  return unescapeOoxml(text);
}

/** Column index of an A1 reference in the given row; null when it is malformed or names another row. */
function columnIndex(ref: string, row: number): number | null {
  const m = /^([A-Z]{1,3})([1-9][0-9]*)$/.exec(ref);
  if (!m || Number(m[2]) !== row) {
    return null;
  }
  let n = 0;
  for (const c of m[1]) {
    n = n * 26 + (c.charCodeAt(0) - 64);
  }
  return n - 1;
}

/** Read the first visible sheet of an .xlsx workbook. Throws when it is not a readable one. */
export function readXlsxRows(bytes: Uint8Array): SheetRows {
  if (bytes.byteLength > PRICE_LIST_LIMITS.bytes) {
    throw new Error(`the price list is larger than ${PRICE_LIST_LIMITS.bytes} bytes`);
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const budget = { left: MAX_INFLATED };
  let entries: ReturnType<typeof readZipDirectory>;
  try {
    entries = readZipDirectory(buf, DEFAULT_ZIP_LIMITS);
  } catch (err) {
    throw new Error(`the workbook cannot be read: ${(err as Error).message}`, { cause: err });
  }
  /** A part parsed strictly (no comments, DTD or CDATA), its root checked; null when absent. */
  const read = (name: string, ns: string, root: string): XmlElement | null => {
    let doc: XmlElement;
    try {
      const data = readZipEntry(buf, entries, name, budget);
      if (data === null) {
        return null;
      }
      doc = parseXml(decodeUtf8Strict(data), XML_LIMITS);
    } catch (err) {
      throw new Error(`the workbook cannot be read: ${name}: ${(err as Error).message}`, {
        cause: err,
      });
    }
    if (doc.ns !== ns || doc.local !== root) {
      // Strict Open XML and other dialects use other namespaces; refuse rather than guess.
      throw new Error(`the workbook cannot be read: ${name} is not in a supported format`);
    }
    return doc;
  };

  const workbook = read("xl/workbook.xml", SML, "workbook");
  if (workbook === null) {
    throw new Error("the file is not an Excel workbook (.xlsx)");
  }
  const sheetTag = childElements(workbook, SML, "sheets")
    .flatMap((s) => childElements(s, SML, "sheet"))
    .find((s) => !["hidden", "veryHidden"].includes(attr(s, "state") ?? "visible"));
  const relId = sheetTag?.attrs.find((a) => a.ns === DOC_REL && a.local === "id")?.value;
  if (!sheetTag || !relId) {
    throw new Error("the workbook has no visible sheet");
  }
  const sheet = attr(sheetTag, "name") ?? "";
  const rels = read("xl/_rels/workbook.xml.rels", PKG_REL, "Relationships");
  const rel =
    rels && childElements(rels, PKG_REL, "Relationship").find((r) => attr(r, "Id") === relId);
  const target = rel ? attr(rel, "Target") : null;
  if (!rel || !target || target.includes("..") || /^[a-z]+:/i.test(target)) {
    throw new Error(`the workbook's sheet ${sheet} cannot be found`);
  }
  if (attr(rel, "Type") !== `${DOC_REL}/worksheet` || attr(rel, "TargetMode") === "External") {
    throw new Error(`the workbook's sheet ${sheet} is not a worksheet`);
  }
  const sheetXml = read(
    target.startsWith("/") ? target.slice(1) : `xl/${target}`,
    SML,
    "worksheet",
  );
  if (sheetXml === null) {
    throw new Error(`the workbook's sheet ${sheet} cannot be found`);
  }

  const sst = read("xl/sharedStrings.xml", SML, "sst");
  const shared = sst ? childElements(sst, SML, "si").map(stringItem) : [];

  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  let rowNumber = 0;
  for (const row of childElements(sheetXml, SML, "sheetData").flatMap((d) =>
    childElements(d, SML, "row"),
  )) {
    const r = attr(row, "r");
    const number = r === null ? rowNumber + 1 : Number(r);
    // Excel writes rows and cells in order; a repeated or backward one would overwrite a value.
    if (!Number.isInteger(number) || number <= rowNumber) {
      throw new Error(`the workbook's row ${r ?? "?"} is out of order`);
    }
    rowNumber = number;
    const cells: string[] = [];
    let next = 0;
    for (const c of childElements(row, SML, "c")) {
      const ref = attr(c, "r");
      const col = ref === null ? next : columnIndex(ref, rowNumber);
      // A cell naming another row would land its value in the wrong row.
      if (col === null) {
        throw new Error(`the workbook's cell ${ref} is not in row ${rowNumber}`);
      }
      if (col < next) {
        throw new Error(`the workbook's cell ${ref ?? "?"} is out of order`);
      }
      next = col + 1;
      const v = onlyChild(c, SML, "v");
      const type = attr(c, "t") ?? "n";
      let value: string;
      if (type === "inlineStr") {
        const is = onlyChild(c, SML, "is");
        value = is ? stringItem(is) : "";
      } else if (v === null) {
        value = onlyChild(c, SML, "f") ? FORMULA_WITHOUT_VALUE : "";
      } else if (type === "s") {
        const s = shared[Number(textOf(v))];
        if (s === undefined) {
          throw new Error(`the workbook's cell ${ref ?? "?"} names a missing shared string`);
        }
        value = s;
      } else if (type === "b") {
        value = textOf(v) === "1" ? "TRUE" : "FALSE";
      } else {
        value = unescapeOoxml(textOf(v));
      }
      if (value === "") {
        continue;
      }
      if (col < 0 || col >= MAX_COLUMNS) {
        throw new Error(`the price list has a value beyond column ${MAX_COLUMNS} (${ref})`);
      }
      cells[col] = value;
    }
    const filled = Array.from(cells, (x) => x ?? "");
    if (filled.every((x) => x.trim() === "")) {
      continue;
    }
    rows.push(filled);
    rowNumbers.push(rowNumber);
    if (rows.length > PRICE_LIST_LIMITS.rows + 1) {
      throw new Error(`the price list has more than ${PRICE_LIST_LIMITS.rows} rows`);
    }
  }
  return { sheet, rows, rowNumbers };
}
