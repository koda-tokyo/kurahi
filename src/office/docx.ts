// DOCX renderer: title, subtitle, headings (levels 1-3), paragraphs, bullet lists and simple
// tables, with a footer line (text and optional "n / N" page numbers). A4 or Letter.
// Shared by the office plugin (its agent tools) and the legacy analyser (設計書 as Word): a pure
// renderer with no plugin API, so neither plugin depends on the other being enabled.
import {
  appPropsXml,
  bad,
  bool,
  contentTypesXml,
  corePropsXml,
  esc,
  isObject,
  list,
  packageRels,
  pickLang,
  REL,
  relsXml,
  reqStr,
  str,
  XML_HEAD,
  zipParts,
} from "./common.js";

export const DOCX_LIMITS = {
  blocks: 2000,
  titleChars: 200,
  headingChars: 300,
  paragraphChars: 10_000,
  bulletItems: 100,
  bulletChars: 2000,
  tableColumns: 12,
  tableRows: 500,
  cellChars: 1000,
  footerChars: 200,
};

const BLOCK_TYPES = ["heading", "paragraph", "bullets", "table"] as const;

export type DocBlock =
  | { type: "heading"; text: string; level: 1 | 2 | 3 }
  | { type: "paragraph"; text: string }
  | { type: "bullets"; items: Array<{ text: string; level: number }> }
  | { type: "table"; header: string[]; rows: string[][]; caption?: string }
  // Not in the tool spec (parseDocSpec never produces it): preformatted text such as a Mermaid
  // diagram's source, from a converted Markdown document (markdown.ts).
  | { type: "code"; text: string };

export type DocSpec = {
  title: string;
  subtitle?: string;
  footer?: string;
  pageNumbers: boolean;
  pageSize: "A4" | "Letter";
  lang: "ja" | "en";
  blocks: DocBlock[];
};

export function parseDocSpec(input: Record<string, unknown>): DocSpec {
  const blocks = list(input.blocks, "blocks", { max: DOCX_LIMITS.blocks }).map(
    (raw, i): DocBlock => {
      const w = `blocks[${i}]`;
      if (!isObject(raw)) {
        bad(`${w} must be an object`);
      }
      const type = raw.type;
      if (!BLOCK_TYPES.includes(type as (typeof BLOCK_TYPES)[number])) {
        bad(`${w}.type must be one of ${BLOCK_TYPES.join(", ")}`);
      }
      if (type === "heading") {
        const level = raw.level === undefined ? 1 : Number(raw.level);
        if (level !== 1 && level !== 2 && level !== 3) {
          bad(`${w}.level must be 1, 2 or 3`);
        }
        return { type, text: reqStr(raw.text, `${w}.text`, DOCX_LIMITS.headingChars), level };
      }
      if (type === "paragraph") {
        return { type, text: reqStr(raw.text, `${w}.text`, DOCX_LIMITS.paragraphChars) };
      }
      if (type === "bullets") {
        const items = list(raw.items, `${w}.items`, { max: DOCX_LIMITS.bulletItems, min: 1 }).map(
          (it, j) => {
            // An item is a string, or { text, level } for nested bullets (level 0-2).
            if (isObject(it)) {
              const level = it.level === undefined ? 0 : Number(it.level);
              if (![0, 1, 2].includes(level)) {
                bad(`${w}.items[${j}].level must be 0, 1 or 2`);
              }
              return {
                text: reqStr(it.text, `${w}.items[${j}].text`, DOCX_LIMITS.bulletChars),
                level,
              };
            }
            return { text: reqStr(it, `${w}.items[${j}]`, DOCX_LIMITS.bulletChars), level: 0 };
          },
        );
        return { type, items };
      }
      const header = list(raw.header, `${w}.header`, {
        max: DOCX_LIMITS.tableColumns,
        min: 1,
      }).map((h, j) => str(h, `${w}.header[${j}]`, { max: DOCX_LIMITS.cellChars }) ?? "");
      const rows = list(raw.rows, `${w}.rows`, { max: DOCX_LIMITS.tableRows }).map((r, ri) =>
        list(r, `${w}.rows[${ri}]`, { max: header.length }).map(
          (c, ci) => str(c, `${w}.rows[${ri}][${ci}]`, { max: DOCX_LIMITS.cellChars }) ?? "",
        ),
      );
      return {
        type: "table",
        header,
        rows,
        caption: str(raw.caption, `${w}.caption`, { max: DOCX_LIMITS.headingChars }),
      };
    },
  );
  const pageSize = input.page_size === "Letter" ? "Letter" : "A4";
  return {
    title: reqStr(input.title, "title", DOCX_LIMITS.titleChars),
    subtitle: str(input.subtitle, "subtitle", { max: DOCX_LIMITS.titleChars }),
    footer: str(input.footer, "footer", { max: DOCX_LIMITS.footerChars }),
    pageNumbers: bool(input.page_numbers, true),
    pageSize,
    lang: pickLang(input.language, JSON.stringify([input.title, input.subtitle, blocks])),
    blocks,
  };
}

const W_NS =
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const FONT = "Yu Gothic";
const ACCENT = "1F5AA6";

/** Runs for a text with line breaks. */
function runs(text: string, rPr = ""): string {
  return text
    .split(/\r?\n/)
    .map(
      (line, i) =>
        `<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}${i > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${esc(line)}</w:t></w:r>`,
    )
    .join("");
}

function para(text: string, pPr = "", rPr = ""): string {
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}${runs(text, rPr)}</w:p>`;
}

function tableXml(t: Extract<DocBlock, { type: "table" }>, textWidth: number): string {
  const cols = t.header.length;
  const colW = Math.floor(textWidth / cols);
  const border = (side: string) =>
    `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="C5CED9"/>`;
  const cellXml = (text: string, header: boolean) =>
    `<w:tc><w:tcPr><w:tcW w:w="${colW}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="EAF0F8"/>' : ""}</w:tcPr>` +
    para(text, '<w:pStyle w:val="TableText"/>', header ? "<w:b/>" : "") +
    "</w:tc>";
  const rowXml = (cells: string[], header: boolean) =>
    `<w:tr>${header ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}` +
    Array.from({ length: cols }, (_, i) => cellXml(cells[i] ?? "", header)).join("") +
    "</w:tr>";
  return (
    (t.caption ? para(t.caption, '<w:pStyle w:val="Caption"/><w:keepNext/>') : "") +
    "<w:tbl><w:tblPr>" +
    '<w:tblW w:w="5000" w:type="pct"/>' +
    `<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders>` +
    '<w:tblLayout w:type="fixed"/>' +
    '<w:tblCellMar><w:top w:w="40" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar>' +
    '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>' +
    "</w:tblPr><w:tblGrid>" +
    Array.from({ length: cols }, () => `<w:gridCol w:w="${colW}"/>`).join("") +
    "</w:tblGrid>" +
    rowXml(t.header, true) +
    t.rows.map((r) => rowXml(r, false)).join("") +
    "</w:tbl>" +
    "<w:p/>"
  );
}

const PAGE = {
  A4: { w: 11906, h: 16838 },
  Letter: { w: 12240, h: 15840 },
};
const MARGIN = 1304; // 23 mm

function documentXml(spec: DocSpec): string {
  const page = PAGE[spec.pageSize];
  const textWidth = page.w - 2 * MARGIN;
  const body: string[] = [para(spec.title, '<w:pStyle w:val="Title"/>')];
  if (spec.subtitle) {
    body.push(para(spec.subtitle, '<w:pStyle w:val="Subtitle"/>'));
  }
  for (const b of spec.blocks) {
    if (b.type === "heading") {
      body.push(para(b.text, `<w:pStyle w:val="Heading${b.level}"/>`));
    } else if (b.type === "paragraph") {
      body.push(para(b.text));
    } else if (b.type === "code") {
      body.push(para(b.text, '<w:pStyle w:val="Code"/>'));
    } else if (b.type === "bullets") {
      for (const it of b.items) {
        body.push(
          para(
            it.text,
            `<w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="${it.level}"/><w:numId w:val="1"/></w:numPr>`,
          ),
        );
      }
    } else {
      body.push(tableXml(b, textWidth));
    }
  }
  const footerRef = '<w:footerReference w:type="default" r:id="rId4"/>';
  return (
    XML_HEAD +
    `<w:document ${W_NS}><w:body>` +
    body.join("") +
    `<w:sectPr>${footerRef}<w:pgSz w:w="${page.w}" w:h="${page.h}"/>` +
    `<w:pgMar w:top="1418" w:right="${MARGIN}" w:bottom="1418" w:left="${MARGIN}" w:header="709" w:footer="567" w:gutter="0"/>` +
    '<w:cols w:space="425"/><w:docGrid w:type="lines" w:linePitch="360"/></w:sectPr>' +
    "</w:body></w:document>"
  );
}

function footerXml(spec: DocSpec): string {
  const tabPos = PAGE[spec.pageSize].w - 2 * MARGIN;
  const field = (instr: string) =>
    `<w:fldSimple w:instr=" ${instr} "><w:r><w:t>1</w:t></w:r></w:fldSimple>`;
  const pages = spec.pageNumbers
    ? `<w:r><w:tab/></w:r>${field("PAGE")}<w:r><w:t xml:space="preserve"> / </w:t></w:r>${field("NUMPAGES")}`
    : "";
  return (
    XML_HEAD +
    `<w:ftr ${W_NS}><w:p><w:pPr><w:pStyle w:val="Footer"/><w:tabs><w:tab w:val="right" w:pos="${tabPos}"/></w:tabs></w:pPr>` +
    (spec.footer ? runs(spec.footer) : "") +
    pages +
    "</w:p></w:ftr>"
  );
}

function stylesXml(spec: DocSpec): string {
  const fonts = `<w:rFonts w:ascii="${FONT}" w:eastAsia="${FONT}" w:hAnsi="${FONT}" w:cs="${FONT}"/>`;
  const lang =
    spec.lang === "ja" ? 'w:val="ja-JP" w:eastAsia="ja-JP"' : 'w:val="en-US" w:eastAsia="ja-JP"';
  const style = (id: string, name: string, pPr: string, rPr: string, extra = "") =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/>${extra}<w:qFormat/>` +
    `<w:pPr>${pPr}</w:pPr><w:rPr>${rPr}</w:rPr></w:style>`;
  return (
    XML_HEAD +
    `<w:styles ${W_NS}>` +
    `<w:docDefaults><w:rPrDefault><w:rPr>${fonts}<w:color w:val="1F2933"/><w:kern w:val="2"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang ${lang} w:bidi="ar-SA"/></w:rPr></w:rPrDefault>` +
    '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
    style(
      "Title",
      "Title",
      `<w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="${ACCENT}"/></w:pBdr><w:spacing w:after="120"/>`,
      '<w:b/><w:sz w:val="40"/><w:szCs w:val="40"/>',
    ) +
    style(
      "Subtitle",
      "Subtitle",
      '<w:spacing w:after="360"/>',
      '<w:color w:val="5B6770"/><w:sz w:val="26"/>',
    ) +
    [1, 2, 3]
      .map((l) =>
        style(
          `Heading${l}`,
          `heading ${l}`,
          `<w:keepNext/><w:spacing w:before="${l === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${l - 1}"/>`,
          `<w:b/>${l === 1 ? `<w:color w:val="${ACCENT}"/>` : l === 3 ? '<w:color w:val="5B6770"/>' : ""}<w:sz w:val="${[32, 26, 23][l - 1]}"/>`,
        ),
      )
      .join("") +
    style("ListParagraph", "List Paragraph", '<w:spacing w:after="60"/><w:ind w:left="420"/>', "") +
    style(
      "Caption",
      "caption",
      '<w:spacing w:before="120" w:after="60"/>',
      '<w:b/><w:color w:val="5B6770"/><w:sz w:val="19"/>',
    ) +
    style(
      "TableText",
      "Table Text",
      '<w:spacing w:after="0" w:line="260" w:lineRule="auto"/>',
      '<w:sz w:val="19"/>',
    ) +
    style(
      "Code",
      "Code",
      '<w:shd w:val="clear" w:color="auto" w:fill="F3F5F8"/><w:spacing w:after="120" w:line="240" w:lineRule="auto"/>',
      '<w:rFonts w:ascii="Consolas" w:eastAsia="MS Gothic" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="17"/>',
    ) +
    style(
      "Footer",
      "footer",
      '<w:spacing w:after="0"/>',
      '<w:color w:val="5B6770"/><w:sz w:val="16"/>',
    ) +
    "</w:styles>"
  );
}

function numberingXml(): string {
  const chars = ["•", "◦", "▪"];
  const lvls = chars
    .map(
      (c, i) =>
        `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="${c}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="${420 * (i + 1)}" w:hanging="420"/></w:pPr><w:rPr><w:rFonts w:ascii="${FONT}" w:hAnsi="${FONT}"/><w:color w:val="${ACCENT}"/></w:rPr></w:lvl>`,
    )
    .join("");
  return (
    XML_HEAD +
    `<w:numbering ${W_NS}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${lvls}</w:abstractNum>` +
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>'
  );
}

/** Font table: Yu Gothic, with a sans-serif Japanese family/charset so Word substitutes sensibly
 * (Meiryo, then any Japanese sans-serif) where Yu Gothic is not installed. */
function fontTableXml(): string {
  const f = (name: string, alt: string) =>
    `<w:font w:name="${name}"><w:altName w:val="${alt}"/><w:charset w:val="80"/><w:family w:val="swiss"/><w:pitch w:val="variable"/></w:font>`;
  return XML_HEAD + `<w:fonts ${W_NS}>${f(FONT, "游ゴシック")}${f("Meiryo", "メイリオ")}</w:fonts>`;
}

function settingsXml(): string {
  return (
    XML_HEAD +
    `<w:settings ${W_NS}><w:defaultTabStop w:val="840"/><w:characterSpacingControl w:val="compressPunctuation"/>` +
    '<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>'
  );
}

export type DocxResult = { buffer: Buffer; blocks: number; tables: number };

export async function renderDocx(spec: DocSpec, now: Date): Promise<DocxResult> {
  const ns = "application/vnd.openxmlformats-officedocument.wordprocessingml";
  const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const parts: Array<[string, string]> = [
    [
      "[Content_Types].xml",
      contentTypesXml(
        {},
        {
          "/word/document.xml": `${ns}.document.main+xml`,
          "/word/styles.xml": `${ns}.styles+xml`,
          "/word/numbering.xml": `${ns}.numbering+xml`,
          "/word/settings.xml": `${ns}.settings+xml`,
          "/word/fontTable.xml": `${ns}.fontTable+xml`,
          "/word/footer1.xml": `${ns}.footer+xml`,
        },
      ),
    ],
    ["_rels/.rels", packageRels("word/document.xml")],
    ["docProps/core.xml", corePropsXml(spec.title, now)],
    ["docProps/app.xml", appPropsXml()],
    ["word/document.xml", documentXml(spec)],
    [
      "word/_rels/document.xml.rels",
      relsXml([
        { id: "rId1", type: REL.styles, target: "styles.xml" },
        { id: "rId2", type: `${R}/numbering`, target: "numbering.xml" },
        { id: "rId3", type: `${R}/settings`, target: "settings.xml" },
        { id: "rId4", type: `${R}/footer`, target: "footer1.xml" },
        { id: "rId5", type: `${R}/fontTable`, target: "fontTable.xml" },
      ]),
    ],
    ["word/styles.xml", stylesXml(spec)],
    ["word/numbering.xml", numberingXml()],
    ["word/settings.xml", settingsXml()],
    ["word/fontTable.xml", fontTableXml()],
    ["word/footer1.xml", footerXml(spec)],
  ];
  return {
    buffer: await zipParts(parts, now),
    blocks: spec.blocks.length,
    tables: spec.blocks.filter((b) => b.type === "table").length,
  };
}
