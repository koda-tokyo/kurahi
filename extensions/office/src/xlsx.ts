// XLSX renderer: sheets with a bold frozen header row, string/number/boolean/ISO-date cells,
// estimated column widths and optional number formats per column. Strings are always written as
// text (never as formulas), so a cell starting with "=" stays a string.
import {
  appPropsXml,
  bad,
  contentTypesXml,
  corePropsXml,
  esc,
  isObject,
  isWide,
  list,
  packageRels,
  REL,
  relsXml,
  reqStr,
  str,
  XML_HEAD,
  zipParts,
} from "../../../src/office/common.js";

export const XLSX_LIMITS = {
  sheets: 20,
  columns: 200,
  rows: 50_000,
  cells: 1_000_000,
  cellChars: 32_767,
  headerChars: 255,
  formatChars: 64,
};

export type Cell = string | number | boolean | Date | null;
export type SheetSpec = { name: string; header: string[]; rows: Cell[][]; formats: string[] };
export type WorkbookSpec = { title?: string; sheets: SheetSpec[] };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z?)?$/;
const SHEET_NAME_BAD = /[[\]:*?/\\]/;

/** "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM[:SS]" (treated as wall-clock time) to a Date in UTC. */
export function parseIsoDate(s: string): Date | null {
  const m = ISO_DATE.exec(s);
  if (!m) {
    return null;
  }
  const [y, mo, d, h, mi, se] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x)));
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi, se));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== mo - 1 ||
    date.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    se > 59 ||
    y < 1900
  ) {
    return null;
  }
  return date;
}

function cell(v: unknown, where: string): Cell {
  if (v === null || v === undefined || v === "") {
    return null;
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) {
      bad(`${where} must be a finite number`);
    }
    return v;
  }
  if (typeof v === "boolean") {
    return v;
  }
  if (typeof v === "string") {
    if (v.length > XLSX_LIMITS.cellChars) {
      bad(`${where} is too long (at most ${XLSX_LIMITS.cellChars} characters)`);
    }
    return parseIsoDate(v.trim()) ?? v;
  }
  return bad(`${where} must be a string, number, boolean or null`);
}

export function parseWorkbookSpec(input: Record<string, unknown>): WorkbookSpec {
  const sheetsIn = list(input.sheets, "sheets", { max: XLSX_LIMITS.sheets, min: 1 });
  const names = new Set<string>();
  let totalRows = 0;
  let totalCells = 0;
  const sheets = sheetsIn.map((raw, si) => {
    const w = `sheets[${si}]`;
    if (!isObject(raw)) {
      bad(`${w} must be an object`);
    }
    const name = reqStr(raw.name, `${w}.name`, 31);
    if (SHEET_NAME_BAD.test(name) || name.startsWith("'") || name.endsWith("'")) {
      bad(`${w}.name may not contain [ ] : * ? / \\ or start/end with '`);
    }
    if (names.has(name.toLowerCase())) {
      bad(`${w}.name "${name}" is used twice`);
    }
    names.add(name.toLowerCase());
    const header = list(raw.header, `${w}.header`, { max: XLSX_LIMITS.columns, min: 1 }).map(
      (h, i) => str(h, `${w}.header[${i}]`, { max: XLSX_LIMITS.headerChars }) ?? "",
    );
    const rowsIn = list(raw.rows, `${w}.rows`, { max: XLSX_LIMITS.rows });
    totalRows += rowsIn.length;
    if (totalRows > XLSX_LIMITS.rows) {
      bad(`the workbook has more than ${XLSX_LIMITS.rows} rows`);
    }
    const rows = rowsIn.map((r, ri) => {
      const cells = list(r, `${w}.rows[${ri}]`, { max: header.length });
      totalCells += cells.length;
      return cells.map((c, ci) => cell(c, `${w}.rows[${ri}][${ci}]`));
    });
    if (totalCells > XLSX_LIMITS.cells) {
      bad(`the workbook has more than ${XLSX_LIMITS.cells} cells`);
    }
    const formats = list(raw.column_formats, `${w}.column_formats`, { max: header.length }).map(
      (f, i) => str(f, `${w}.column_formats[${i}]`, { max: XLSX_LIMITS.formatChars }) ?? "",
    );
    return { name, header, rows, formats };
  });
  return { title: str(input.title, "title", { max: 200 }), sheets };
}

export function columnName(i: number): string {
  let n = i + 1;
  let s = "";
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

export function dateSerial(d: Date): number {
  return (d.getTime() - EXCEL_EPOCH) / 86_400_000;
}

function displayWidth(v: Cell): number {
  if (v === null) {
    return 0;
  }
  if (v instanceof Date) {
    return v.getUTCHours() || v.getUTCMinutes() ? 16 : 10;
  }
  const s = typeof v === "number" ? v.toLocaleString("en-US") : String(v);
  let w = 0;
  for (const ch of s.split("\n")[0] ?? "") {
    w += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return w;
}

/** Column widths in Excel character units from the header and the first 2000 rows. */
export function estimateWidths(sheet: SheetSpec): number[] {
  return sheet.header.map((h, c) => {
    let w = displayWidth(h) + 2; // room for the filter/bold header
    for (const row of sheet.rows.slice(0, 2000)) {
      w = Math.max(w, displayWidth(row[c] ?? null));
    }
    return Math.min(60, Math.max(8, w + 2));
  });
}

type StyleTable = { xml: string; date: number; dateTime: number; formats: Map<string, number> };

function buildStyles(sheets: SheetSpec[]): StyleTable {
  const custom = new Map<string, number>(); // format code -> numFmtId
  const add = (code: string) => {
    if (!custom.has(code)) {
      custom.set(code, 164 + custom.size);
    }
  };
  add("yyyy-mm-dd");
  add("yyyy-mm-dd hh:mm");
  for (const s of sheets) {
    for (const f of s.formats) {
      if (f && f.toLowerCase() !== "general") {
        add(f);
      }
    }
  }
  // cellXfs: 0 default, 1 header, then one xf per custom format in insertion order.
  const xfIndex = new Map<string, number>();
  const xfs = [
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>',
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>',
  ];
  for (const [code, id] of custom) {
    xfIndex.set(code, xfs.length);
    xfs.push(
      `<xf numFmtId="${id}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`,
    );
  }
  const font = (bold: boolean) =>
    `<font>${bold ? "<b/>" : ""}<sz val="11"/><color theme="1"/><name val="Yu Gothic"/><family val="2"/><charset val="128"/><scheme val="minor"/></font>`;
  const xml =
    XML_HEAD +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<numFmts count="${custom.size}">` +
    [...custom]
      .map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`)
      .join("") +
    "</numFmts>" +
    `<fonts count="2">${font(false)}${font(true)}</fonts>` +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FFEAF0F8"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
    '<border><left/><right/><top/><bottom style="thin"><color rgb="FF9AA5B1"/></bottom><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    `<cellXfs count="${xfs.length}">${xfs.join("")}</cellXfs>` +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>";
  return {
    xml,
    date: xfIndex.get("yyyy-mm-dd") ?? 0,
    dateTime: xfIndex.get("yyyy-mm-dd hh:mm") ?? 0,
    formats: xfIndex,
  };
}

class SharedStrings {
  private readonly index = new Map<string, number>();
  readonly list: string[] = [];
  count = 0;
  id(s: string): number {
    this.count++;
    let i = this.index.get(s);
    if (i === undefined) {
      i = this.list.length;
      this.list.push(s);
      this.index.set(s, i);
    }
    return i;
  }
  xml(): string {
    return (
      XML_HEAD +
      `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${this.count}" uniqueCount="${this.list.length}">` +
      this.list.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("") +
      "</sst>"
    );
  }
}

function sheetXml(sheet: SheetSpec, first: boolean, styles: StyleTable, sst: SharedStrings) {
  const widths = estimateWidths(sheet);
  const colXf = sheet.formats.map((f) => (f ? (styles.formats.get(f) ?? 0) : 0));
  const out: string[] = [];
  const lastCol = columnName(sheet.header.length - 1);
  out.push(
    XML_HEAD +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      `<dimension ref="A1:${lastCol}${sheet.rows.length + 1}"/>` +
      `<sheetViews><sheetView${first ? ' tabSelected="1"' : ""} workbookViewId="0">` +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '<selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="18"/>' +
      "<cols>" +
      widths
        .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
        .join("") +
      "</cols><sheetData>",
  );
  const headerCells = sheet.header
    .map((h, c) => `<c r="${columnName(c)}1" s="1" t="s"><v>${sst.id(h)}</v></c>`)
    .join("");
  out.push(`<row r="1">${headerCells}</row>`);
  for (const [ri, row] of sheet.rows.entries()) {
    const r = ri + 2;
    const cells: string[] = [];
    for (const [c, v] of row.entries()) {
      if (v === null) {
        continue;
      }
      const ref = `${columnName(c)}${r}`;
      const fmt = colXf[c] ?? 0;
      if (typeof v === "number") {
        cells.push(`<c r="${ref}"${fmt ? ` s="${fmt}"` : ""}><v>${v}</v></c>`);
      } else if (typeof v === "boolean") {
        cells.push(`<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`);
      } else if (v instanceof Date) {
        const s = fmt || (v.getUTCHours() || v.getUTCMinutes() ? styles.dateTime : styles.date);
        cells.push(`<c r="${ref}" s="${s}"><v>${dateSerial(v)}</v></c>`);
      } else {
        cells.push(`<c r="${ref}" t="s"><v>${sst.id(v)}</v></c>`);
      }
    }
    out.push(`<row r="${r}">${cells.join("")}</row>`);
  }
  out.push(
    "</sheetData>" +
      '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
      "</worksheet>",
  );
  return out.join("");
}

export type XlsxResult = { buffer: Buffer; sheets: number; rows: number };

export async function renderXlsx(spec: WorkbookSpec, now: Date): Promise<XlsxResult> {
  const styles = buildStyles(spec.sheets);
  const sst = new SharedStrings();
  const sheetParts = spec.sheets.map((s, i) => sheetXml(s, i === 0, styles, sst));
  const ns = "application/vnd.openxmlformats-officedocument.spreadsheetml";
  const overrides: Record<string, string> = {
    "/xl/workbook.xml": `${ns}.sheet.main+xml`,
    "/xl/styles.xml": `${ns}.styles+xml`,
    "/xl/sharedStrings.xml": `${ns}.sharedStrings+xml`,
  };
  spec.sheets.forEach((_, i) => {
    overrides[`/xl/worksheets/sheet${i + 1}.xml`] = `${ns}.worksheet+xml`;
  });
  const workbook =
    XML_HEAD +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
    spec.sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join("") +
    "</sheets></workbook>";
  const n = spec.sheets.length;
  const wbRels = relsXml([
    ...spec.sheets.map((_, i) => ({
      id: `rId${i + 1}`,
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
      target: `worksheets/sheet${i + 1}.xml`,
    })),
    { id: `rId${n + 1}`, type: REL.styles, target: "styles.xml" },
    {
      id: `rId${n + 2}`,
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings",
      target: "sharedStrings.xml",
    },
  ]);
  const parts: Array<[string, string]> = [
    ["[Content_Types].xml", contentTypesXml({}, overrides)],
    ["_rels/.rels", packageRels("xl/workbook.xml")],
    ["docProps/core.xml", corePropsXml(spec.title ?? spec.sheets[0]?.name ?? "", now)],
    ["docProps/app.xml", appPropsXml()],
    ["xl/workbook.xml", workbook],
    ["xl/_rels/workbook.xml.rels", wbRels],
    ["xl/styles.xml", styles.xml],
    ...sheetParts.map((x, i): [string, string] => [`xl/worksheets/sheet${i + 1}.xml`, x]),
    ["xl/sharedStrings.xml", sst.xml()],
  ];
  return {
    buffer: await zipParts(parts, now),
    sheets: n,
    rows: spec.sheets.reduce((a, s) => a + s.rows.length, 0),
  };
}
