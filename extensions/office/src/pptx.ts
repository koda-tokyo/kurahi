import {
  appPropsXml,
  bad,
  bool,
  contentTypesXml,
  corePropsXml,
  emWidth,
  esc,
  isObject,
  list,
  num,
  packageRels,
  pickLang,
  REL,
  relsXml,
  reqStr,
  str,
  XML_HEAD,
  zipParts,
} from "../../../src/office/common.js";
// PPTX renderer: a 16:9 deck with a title slide and content slides (heading, bullets, KPI
// cards, an optional native chart, a note line, speaker notes), an optional badge on every
// slide, footer text and "n / N" page numbers. Layout is computed here (font sizes are fitted to
// their boxes from an estimate of the text width), so the same spec always renders the same way.
import { type ChartSpec, type ChartType, chartWorkbook, chartXml } from "./chart.js";
import {
  FONT,
  GRP_SP_PR,
  NOTES_SIZE,
  notesMasterXml,
  notesSlideXml,
  NS,
  PALETTE,
  presPropsXml,
  slideLayoutXml,
  slideMasterXml,
  tableStylesXml,
  themeXml,
  viewPropsXml,
} from "./pptx-parts.js";

export const PPTX_LIMITS = {
  slides: 40,
  titleChars: 200,
  headingChars: 160,
  bullets: 4,
  bulletChars: 300,
  kpis: 3,
  kpiLabelChars: 60,
  kpiValueChars: 32,
  noteChars: 300,
  speakerNotesChars: 5000,
  badgeChars: 40,
  footerChars: 120,
  series: 4,
  categories: 24,
  categoryChars: 60,
  formatChars: 32,
};

const CHART_TYPES: ChartType[] = ["column", "bar", "line"];

export type SlideSpec = {
  heading: string;
  bullets: string[];
  kpis: Array<{ label: string; value: string }>;
  chart?: ChartSpec;
  note?: string;
  speakerNotes?: string;
};

export type DeckSpec = {
  title: string;
  subtitle?: string;
  badge?: string;
  footer?: string;
  pageNumbers: boolean;
  lang: "ja" | "en";
  titleNotes?: string;
  slides: SlideSpec[];
};

function parseChart(raw: unknown, w: string): ChartSpec | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  if (!isObject(raw)) {
    bad(`${w} must be an object or null`);
  }
  const type = raw.type ?? "column";
  if (!CHART_TYPES.includes(type as ChartType)) {
    bad(`${w}.type must be one of ${CHART_TYPES.join(", ")}`);
  }
  const categories = list(raw.categories, `${w}.categories`, {
    max: PPTX_LIMITS.categories,
    min: 1,
  }).map((c, i) => str(c, `${w}.categories[${i}]`, { max: PPTX_LIMITS.categoryChars }) ?? "");
  const series = list(raw.series, `${w}.series`, { max: PPTX_LIMITS.series, min: 1 }).map(
    (s, i) => {
      if (!isObject(s)) {
        bad(`${w}.series[${i}] must be an object`);
      }
      const values = list(s.values, `${w}.series[${i}].values`, {
        max: categories.length,
        min: categories.length,
      }).map((v, j) => num(v, `${w}.series[${i}].values[${j}]`));
      return {
        name: reqStr(s.name, `${w}.series[${i}].name`, PPTX_LIMITS.categoryChars),
        values,
      };
    },
  );
  return {
    type: type as ChartType,
    title: str(raw.title, `${w}.title`, { max: PPTX_LIMITS.headingChars }),
    categories,
    series,
    numberFormat: str(raw.number_format, `${w}.number_format`, { max: PPTX_LIMITS.formatChars }),
    dataLabels: bool(raw.data_labels, false),
  };
}

export function parseDeckSpec(input: Record<string, unknown>): DeckSpec {
  const slidesIn = list(input.slides, "slides", { max: PPTX_LIMITS.slides - 1 });
  // Top-level speaker_notes: a string is the title slide's notes; an array gives the content
  // slides' notes by position (a slide's own speaker_notes wins).
  const topNotes = input.speaker_notes;
  const notesList = Array.isArray(topNotes)
    ? list(topNotes, "speaker_notes", { max: PPTX_LIMITS.slides })
    : [];
  const slides = slidesIn.map((raw, i): SlideSpec => {
    const w = `slides[${i}]`;
    if (!isObject(raw)) {
      bad(`${w} must be an object`);
    }
    const kpis = list(raw.kpis, `${w}.kpis`, { max: PPTX_LIMITS.kpis }).map((k, j) => {
      if (!isObject(k)) {
        bad(`${w}.kpis[${j}] must be an object`);
      }
      return {
        label: reqStr(k.label, `${w}.kpis[${j}].label`, PPTX_LIMITS.kpiLabelChars),
        value: reqStr(k.value, `${w}.kpis[${j}].value`, PPTX_LIMITS.kpiValueChars),
      };
    });
    return {
      heading: reqStr(raw.heading, `${w}.heading`, PPTX_LIMITS.headingChars),
      bullets: list(raw.bullets, `${w}.bullets`, { max: PPTX_LIMITS.bullets }).map((b, j) =>
        reqStr(b, `${w}.bullets[${j}]`, PPTX_LIMITS.bulletChars),
      ),
      kpis,
      chart: parseChart(raw.chart, `${w}.chart`),
      note: str(raw.note, `${w}.note`, { max: PPTX_LIMITS.noteChars }),
      speakerNotes:
        str(raw.speaker_notes, `${w}.speaker_notes`, { max: PPTX_LIMITS.speakerNotesChars }) ??
        str(notesList[i], `speaker_notes[${i}]`, { max: PPTX_LIMITS.speakerNotesChars }),
    };
  });
  return {
    title: reqStr(input.title, "title", PPTX_LIMITS.titleChars),
    subtitle: str(input.subtitle, "subtitle", { max: PPTX_LIMITS.titleChars }),
    badge: str(input.badge, "badge", { max: PPTX_LIMITS.badgeChars }),
    footer: str(input.footer, "footer", { max: PPTX_LIMITS.footerChars }),
    pageNumbers: bool(input.page_numbers, true),
    lang: pickLang(input.language, JSON.stringify([input.title, input.subtitle, slides])),
    titleNotes:
      typeof topNotes === "string"
        ? str(topNotes, "speaker_notes", { max: PPTX_LIMITS.speakerNotesChars })
        : undefined,
    slides,
  };
}

// ---- geometry --------------------------------------------------------------------------------

const EMU = 914400;
const SLIDE = { w: 13.333, h: 7.5 };
const SLIDE_EMU = { cx: 12192000, cy: 6858000 };
const MX = 0.6;
const CW = SLIDE.w - 2 * MX;

const emu = (inches: number) => Math.round(inches * EMU);

type Box = { x: number; y: number; w: number; h: number };

/** Largest size in `sizes` at which the paragraphs fit the box (estimated). */
export function fitFont(
  paragraphs: string[],
  box: { w: number; h: number },
  sizes: number[],
  opts: { indent?: number; lineFactor?: number; paraGap?: number } = {},
): number {
  const lf = opts.lineFactor ?? 1.25;
  for (const pt of sizes) {
    const usable = box.w - (opts.indent ?? 0) - 0.2;
    const perLine = usable / (pt / 72);
    let height = 0;
    for (const p of paragraphs) {
      const lines = p
        .split("\n")
        .reduce((a, l) => a + Math.max(1, Math.ceil(emWidth(l) / perLine)), 0);
      height += (lines * pt * lf) / 72 + (opts.paraGap ?? 0) / 72;
    }
    if (height <= box.h - 0.1) {
      return pt;
    }
  }
  return sizes[sizes.length - 1];
}

// ---- shapes ----------------------------------------------------------------------------------

type RunOpts = { sz: number; color?: string; bold?: boolean; lang: string };

function rPr(o: RunOpts, tag = "a:rPr"): string {
  return (
    `<${tag} lang="${o.lang}" altLang="en-US" sz="${Math.round(o.sz * 100)}"${o.bold ? ' b="1"' : ""} dirty="0">` +
    `<a:solidFill><a:srgbClr val="${o.color ?? PALETTE.text}"/></a:solidFill>` +
    `<a:latin typeface="${FONT}" pitchFamily="34" charset="-128"/><a:ea typeface="${FONT}" pitchFamily="34" charset="-128"/></${tag}>`
  );
}

function paragraph(
  text: string,
  o: RunOpts & { algn?: "l" | "ctr" | "r"; bullet?: boolean; spcBef?: number },
): string {
  const pPr =
    `<a:pPr algn="${o.algn ?? "l"}"${o.bullet ? ' marL="285750" indent="-285750"' : ""}>` +
    '<a:lnSpc><a:spcPct val="110000"/></a:lnSpc>' +
    (o.spcBef ? `<a:spcBef><a:spcPts val="${o.spcBef * 100}"/></a:spcBef>` : "") +
    (o.bullet
      ? `<a:buClr><a:srgbClr val="${PALETTE.accent}"/></a:buClr><a:buFont typeface="Arial"/><a:buChar char="•"/>`
      : "<a:buNone/>") +
    "</a:pPr>";
  const lines = text.split("\n");
  const body = lines
    .map(
      (l, i) => `${i > 0 ? `<a:br>${rPr(o)}</a:br>` : ""}<a:r>${rPr(o)}<a:t>${esc(l)}</a:t></a:r>`,
    )
    .join("");
  return `<a:p>${pPr}${body}${rPr(o, "a:endParaRPr")}</a:p>`;
}

class SpTree {
  private nextId = 2;
  readonly parts: string[] = [];

  private spPr(b: Box, geom: string, fill?: string, line?: string): string {
    return (
      `<p:spPr><a:xfrm><a:off x="${emu(b.x)}" y="${emu(b.y)}"/><a:ext cx="${emu(b.w)}" cy="${emu(b.h)}"/></a:xfrm>` +
      `<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>` +
      (fill ? `<a:solidFill><a:srgbClr val="${fill}"/></a:solidFill>` : "<a:noFill/>") +
      (line
        ? `<a:ln w="9525"><a:solidFill><a:srgbClr val="${line}"/></a:solidFill></a:ln>`
        : "<a:ln><a:noFill/></a:ln>") +
      "</p:spPr>"
    );
  }

  text(
    name: string,
    b: Box,
    paragraphs: string,
    opts: {
      anchor?: "t" | "ctr" | "b";
      fill?: string;
      line?: string;
      geom?: string;
      inset?: number;
    } = {},
  ): void {
    const id = this.nextId++;
    const ins = emu(opts.inset ?? 0.08);
    this.parts.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)} ${id}"/><p:cNvSpPr${opts.geom ? "" : ' txBox="1"'}/><p:nvPr/></p:nvSpPr>` +
        this.spPr(b, opts.geom ?? "rect", opts.fill, opts.line) +
        `<p:txBody><a:bodyPr wrap="square" lIns="${ins}" tIns="${ins}" rIns="${ins}" bIns="${ins}" anchor="${opts.anchor ?? "t"}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`,
    );
  }

  rect(name: string, b: Box, fill: string): void {
    const id = this.nextId++;
    this.parts.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${esc(name)} ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>${this.spPr(b, "rect", fill)}</p:sp>`,
    );
  }

  chart(b: Box, rId: string): void {
    const id = this.nextId++;
    this.parts.push(
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>` +
        `<p:xfrm><a:off x="${emu(b.x)}" y="${emu(b.y)}"/><a:ext cx="${emu(b.w)}" cy="${emu(b.h)}"/></p:xfrm>` +
        '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart">' +
        `<c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rId}"/></a:graphicData></a:graphic></p:graphicFrame>`,
    );
  }

  xml(): string {
    return (
      XML_HEAD +
      `<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${PALETTE.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
      `<p:spTree>${GRP_SP_PR}${this.parts.join("")}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
    );
  }
}

type Chrome = { deck: DeckSpec; index: number; total: number; lang: string };

/** Badge, footer and page number: the same on every slide. */
function addChrome(tree: SpTree, c: Chrome, showNumber: boolean): void {
  const { deck, lang } = c;
  if (deck.badge) {
    const w = Math.min(4.5, Math.max(1.4, (emWidth(deck.badge) * 10) / 72 + 0.45));
    tree.text(
      "Badge",
      { x: SLIDE.w - MX - w, y: 0.2, w, h: 0.36 },
      paragraph(deck.badge, { sz: 10, color: PALETTE.badgeText, bold: true, lang, algn: "ctr" }),
      {
        anchor: "ctr",
        fill: PALETTE.badgeFill,
        line: PALETTE.badgeLine,
        geom: "roundRect",
        inset: 0.04,
      },
    );
  }
  if (deck.footer) {
    tree.text(
      "Footer",
      { x: MX, y: 7.0, w: CW - 1.6, h: 0.32 },
      paragraph(deck.footer, { sz: 9, color: PALETTE.muted, lang }),
      { anchor: "ctr" },
    );
  }
  if (deck.pageNumbers && showNumber) {
    tree.text(
      "Page number",
      { x: SLIDE.w - MX - 1.5, y: 7.0, w: 1.5, h: 0.32 },
      paragraph(`${c.index} / ${c.total}`, { sz: 9, color: PALETTE.muted, lang, algn: "r" }),
      { anchor: "ctr" },
    );
  }
}

function titleSlide(deck: DeckSpec, total: number): string {
  const lang = deck.lang === "ja" ? "ja-JP" : "en-US";
  const tree = new SpTree();
  tree.rect("Accent bar", { x: 0, y: 0, w: 0.16, h: SLIDE.h }, PALETTE.accent);
  const titleBox = { x: 0.95, y: 1.9, w: 11.4, h: 1.95 };
  const tsz = fitFont([deck.title], titleBox, [40, 36, 32, 28, 24]);
  tree.text("Title", titleBox, paragraph(deck.title, { sz: tsz, bold: true, lang }), {
    anchor: "b",
  });
  tree.rect("Rule", { x: 1.03, y: 4.0, w: 1.6, h: 0.05 }, PALETTE.accent);
  if (deck.subtitle) {
    const subBox = { x: 0.95, y: 4.2, w: 11.4, h: 1.4 };
    const ssz = fitFont([deck.subtitle], subBox, [20, 18, 16, 14]);
    tree.text(
      "Subtitle",
      subBox,
      paragraph(deck.subtitle, { sz: ssz, color: PALETTE.muted, lang }),
    );
  }
  addChrome(tree, { deck, index: 1, total, lang }, false);
  return tree.xml();
}

function contentSlide(
  deck: DeckSpec,
  slide: SlideSpec,
  index: number,
  total: number,
  chartRId: string | null,
): string {
  const lang = deck.lang === "ja" ? "ja-JP" : "en-US";
  const tree = new SpTree();
  // Heading, leaving room on the right for the badge row above it.
  const headBox = { x: MX, y: 0.62, w: CW, h: 0.8 };
  const hsz = fitFont([slide.heading], headBox, [28, 26, 24, 22, 20, 18]);
  tree.text("Heading", headBox, paragraph(slide.heading, { sz: hsz, bold: true, lang }), {
    anchor: "b",
  });
  tree.rect("Rule", { x: MX + 0.08, y: 1.5, w: 1.2, h: 0.045 }, PALETTE.accent);

  let top = 1.78;
  const bottom = slide.note ? 6.35 : 6.85;
  if (slide.kpis.length > 0) {
    const gap = 0.3;
    const n = slide.kpis.length;
    const cardW = Math.min(3.8, (CW - gap * (n - 1)) / n);
    const cardH = 1.2;
    for (const [i, k] of slide.kpis.entries()) {
      const box = { x: MX + i * (cardW + gap), y: top, w: cardW, h: cardH };
      const vsz = fitFont([k.value], { w: cardW, h: 0.7 }, [30, 26, 22, 18, 16]);
      tree.text(
        "KPI",
        box,
        paragraph(k.value, { sz: vsz, bold: true, color: PALETTE.accent, lang, algn: "ctr" }) +
          paragraph(k.label, { sz: 12, color: PALETTE.muted, lang, algn: "ctr" }),
        { anchor: "ctr", fill: PALETTE.accentSoft, geom: "roundRect", inset: 0.1 },
      );
    }
    top += cardH + 0.3;
  }

  const area = { x: MX, y: top, w: CW, h: bottom - top };
  const hasBullets = slide.bullets.length > 0;
  if (slide.chart && chartRId) {
    const chartBox = hasBullets
      ? { x: MX + CW * 0.42 + 0.2, y: area.y, w: CW * 0.58 - 0.2, h: area.h }
      : area;
    tree.chart(chartBox, chartRId);
  }
  if (hasBullets) {
    const box = slide.chart ? { ...area, w: CW * 0.42 } : area;
    const sizes = slide.chart ? [18, 16, 15, 14, 13, 12] : [22, 20, 18, 16, 15, 14, 13, 12];
    const sz = fitFont(slide.bullets, box, sizes, { indent: 0.32, lineFactor: 1.32, paraGap: 10 });
    tree.text(
      "Bullets",
      box,
      slide.bullets.map((b) => paragraph(b, { sz, lang, bullet: true, spcBef: 10 })).join(""),
    );
  }
  if (slide.note) {
    const box = { x: MX, y: 6.4, w: CW, h: 0.5 };
    const nsz = fitFont([slide.note], box, [12, 11, 10, 9]);
    tree.text("Note", box, paragraph(slide.note, { sz: nsz, color: PALETTE.muted, lang }), {
      anchor: "ctr",
    });
  }
  addChrome(tree, { deck, index, total, lang }, true);
  return tree.xml();
}

function notesParagraphs(text: string, lang: string): string {
  return text
    .split(/\r?\n/)
    .map(
      (l) =>
        `<a:p><a:r><a:rPr lang="${lang}" altLang="en-US" dirty="0"/><a:t>${esc(l)}</a:t></a:r></a:p>`,
    )
    .join("");
}

export type PptxResult = { buffer: Buffer; slides: number; charts: number };

const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PML = "application/vnd.openxmlformats-officedocument.presentationml";

export async function renderPptx(deck: DeckSpec, now: Date): Promise<PptxResult> {
  const total = deck.slides.length + 1;
  const lang = deck.lang === "ja" ? "ja-JP" : "en-US";
  const parts: Array<[string, string | Buffer]> = [];
  const overrides: Record<string, string> = {
    "/ppt/presentation.xml": `${PML}.presentation.main+xml`,
    "/ppt/slideMasters/slideMaster1.xml": `${PML}.slideMaster+xml`,
    "/ppt/slideLayouts/slideLayout1.xml": `${PML}.slideLayout+xml`,
    "/ppt/notesMasters/notesMaster1.xml": `${PML}.notesMaster+xml`,
    "/ppt/theme/theme1.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
    "/ppt/theme/theme2.xml": "application/vnd.openxmlformats-officedocument.theme+xml",
    "/ppt/presProps.xml": `${PML}.presProps+xml`,
    "/ppt/viewProps.xml": `${PML}.viewProps+xml`,
    "/ppt/tableStyles.xml": `${PML}.tableStyles+xml`,
  };
  const slideParts: Array<[string, string | Buffer]> = [];
  let charts = 0;
  const slides: Array<{ xml: string; notes?: string; chart?: ChartSpec }> = [
    { xml: titleSlide(deck, total), notes: deck.titleNotes },
  ];
  for (const [i, s] of deck.slides.entries()) {
    const chartRId = s.chart ? "rId3" : null;
    slides.push({
      xml: contentSlide(deck, s, i + 2, total, chartRId),
      notes: s.speakerNotes,
      chart: s.chart,
    });
  }
  for (const [i, s] of slides.entries()) {
    const n = i + 1;
    overrides[`/ppt/slides/slide${n}.xml`] = `${PML}.slide+xml`;
    slideParts.push([`ppt/slides/slide${n}.xml`, s.xml]);
    const rels = [
      { id: "rId1", type: `${R}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
    ];
    if (s.notes) {
      rels.push({
        id: "rId2",
        type: `${R}/notesSlide`,
        target: `../notesSlides/notesSlide${n}.xml`,
      });
      overrides[`/ppt/notesSlides/notesSlide${n}.xml`] = `${PML}.notesSlide+xml`;
      slideParts.push([
        `ppt/notesSlides/notesSlide${n}.xml`,
        notesSlideXml(notesParagraphs(s.notes, lang)),
      ]);
      slideParts.push([
        `ppt/notesSlides/_rels/notesSlide${n}.xml.rels`,
        relsXml([
          { id: "rId1", type: `${R}/notesMaster`, target: "../notesMasters/notesMaster1.xml" },
          { id: "rId2", type: `${R}/slide`, target: `../slides/slide${n}.xml` },
        ]),
      ]);
    }
    if (s.chart) {
      charts++;
      const c = charts;
      rels.push({ id: "rId3", type: `${R}/chart`, target: `../charts/chart${c}.xml` });
      overrides[`/ppt/charts/chart${c}.xml`] =
        "application/vnd.openxmlformats-officedocument.drawingml.chart+xml";
      slideParts.push([`ppt/charts/chart${c}.xml`, chartXml(s.chart)]);
      slideParts.push([
        `ppt/charts/_rels/chart${c}.xml.rels`,
        relsXml([
          {
            id: "rId1",
            type: `${R}/package`,
            target: `../embeddings/Microsoft_Excel_Worksheet${c}.xlsx`,
          },
        ]),
      ]);
      slideParts.push([
        `ppt/embeddings/Microsoft_Excel_Worksheet${c}.xlsx`,
        await chartWorkbook(s.chart, now),
      ]);
    }
    slideParts.push([`ppt/slides/_rels/slide${n}.xml.rels`, relsXml(rels)]);
  }

  const presentation =
    XML_HEAD +
    `<p:presentation ${NS} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:notesMasterIdLst><p:notesMasterId r:id="rId2"/></p:notesMasterIdLst>' +
    `<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${10 + i}"/>`).join("")}</p:sldIdLst>` +
    `<p:sldSz cx="${SLIDE_EMU.cx}" cy="${SLIDE_EMU.cy}"/><p:notesSz cx="${NOTES_SIZE.cx}" cy="${NOTES_SIZE.cy}"/>` +
    "</p:presentation>";
  const presRels = relsXml([
    { id: "rId1", type: `${R}/slideMaster`, target: "slideMasters/slideMaster1.xml" },
    { id: "rId2", type: `${R}/notesMaster`, target: "notesMasters/notesMaster1.xml" },
    { id: "rId3", type: `${R}/presProps`, target: "presProps.xml" },
    { id: "rId4", type: `${R}/viewProps`, target: "viewProps.xml" },
    { id: "rId5", type: REL.theme, target: "theme/theme1.xml" },
    { id: "rId6", type: `${R}/tableStyles`, target: "tableStyles.xml" },
    ...slides.map((_, i) => ({
      id: `rId${10 + i}`,
      type: `${R}/slide`,
      target: `slides/slide${i + 1}.xml`,
    })),
  ]);

  parts.push(
    [
      "[Content_Types].xml",
      contentTypesXml(
        { xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
        overrides,
      ),
    ],
    ["_rels/.rels", packageRels("ppt/presentation.xml")],
    ["docProps/core.xml", corePropsXml(deck.title, now)],
    [
      "docProps/app.xml",
      appPropsXml(
        `<Slides>${total}</Slides><Notes>${slides.filter((s) => s.notes).length}</Notes>`,
      ),
    ],
    ["ppt/presentation.xml", presentation],
    ["ppt/_rels/presentation.xml.rels", presRels],
    ["ppt/slideMasters/slideMaster1.xml", slideMasterXml()],
    [
      "ppt/slideMasters/_rels/slideMaster1.xml.rels",
      relsXml([
        { id: "rId1", type: `${R}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId2", type: REL.theme, target: "../theme/theme1.xml" },
      ]),
    ],
    ["ppt/slideLayouts/slideLayout1.xml", slideLayoutXml()],
    [
      "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
      relsXml([
        { id: "rId1", type: `${R}/slideMaster`, target: "../slideMasters/slideMaster1.xml" },
      ]),
    ],
    ["ppt/notesMasters/notesMaster1.xml", notesMasterXml()],
    [
      "ppt/notesMasters/_rels/notesMaster1.xml.rels",
      relsXml([{ id: "rId1", type: REL.theme, target: "../theme/theme2.xml" }]),
    ],
    ["ppt/theme/theme1.xml", themeXml("Kurahi")],
    ["ppt/theme/theme2.xml", themeXml("Kurahi Notes")],
    ["ppt/presProps.xml", presPropsXml()],
    ["ppt/viewProps.xml", viewPropsXml()],
    ["ppt/tableStyles.xml", tableStylesXml()],
    ...slideParts,
  );
  return { buffer: await zipParts(parts, now), slides: total, charts };
}
