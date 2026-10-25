// Native DrawingML charts (clustered column / bar, line) with an embedded workbook holding the
// same data, so PowerPoint's "Edit Data" opens it and the chart stays editable.
import { esc, XML_HEAD } from "../../../src/office/common.js";
import { FONT, PALETTE } from "./pptx-parts.js";
import { columnName, renderXlsx } from "./xlsx.js";

export type ChartType = "column" | "bar" | "line";
export type ChartSpec = {
  type: ChartType;
  title?: string;
  categories: string[];
  series: Array<{ name: string; values: number[] }>;
  numberFormat?: string;
  dataLabels: boolean;
};

function txPr(sz: number, color: string = PALETTE.muted): string {
  return (
    "<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr>" +
    `<a:defRPr sz="${sz}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/></a:defRPr>` +
    '</a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>'
  );
}

function strCache(values: string[]): string {
  return (
    `<c:strCache><c:ptCount val="${values.length}"/>` +
    values.map((v, i) => `<c:pt idx="${i}"><c:v>${esc(v)}</c:v></c:pt>`).join("") +
    "</c:strCache>"
  );
}

function numCache(values: number[], formatCode: string): string {
  return (
    `<c:numCache><c:formatCode>${esc(formatCode)}</c:formatCode><c:ptCount val="${values.length}"/>` +
    values.map((v, i) => `<c:pt idx="${i}"><c:v>${v}</c:v></c:pt>`).join("") +
    "</c:numCache>"
  );
}

function seriesXml(spec: ChartSpec, si: number): string {
  const s = spec.series[si];
  const col = columnName(si + 1);
  const n = spec.categories.length;
  const color = PALETTE.series[si % PALETTE.series.length];
  const line = spec.type === "line";
  const spPr = line
    ? `<c:spPr><a:ln w="28575" cap="rnd"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:round/></a:ln></c:spPr>`
    : `<c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>`;
  const marker = line
    ? `<c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr></c:marker>`
    : '<c:invertIfNegative val="0"/>';
  const labels = spec.dataLabels
    ? `<c:dLbls>${spec.numberFormat ? `<c:numFmt formatCode="${esc(spec.numberFormat)}" sourceLinked="0"/>` : ""}<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>${txPr(1000, PALETTE.text)}` +
      `<c:dLblPos val="${line ? "t" : "outEnd"}"/><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`
    : "";
  return (
    `<c:ser><c:idx val="${si}"/><c:order val="${si}"/>` +
    `<c:tx><c:strRef><c:f>Sheet1!$${col}$1</c:f>${strCache([s.name])}</c:strRef></c:tx>` +
    spPr +
    marker +
    labels +
    `<c:cat><c:strRef><c:f>Sheet1!$A$2:$A$${n + 1}</c:f>${strCache(spec.categories)}</c:strRef></c:cat>` +
    `<c:val><c:numRef><c:f>Sheet1!$${col}$2:$${col}$${n + 1}</c:f>${numCache(s.values, spec.numberFormat ?? "General")}</c:numRef></c:val>` +
    (line ? '<c:smooth val="0"/>' : "") +
    "</c:ser>"
  );
}

export function chartXml(spec: ChartSpec): string {
  const line = spec.type === "line";
  const horizontal = spec.type === "bar";
  const series = spec.series.map((_, i) => seriesXml(spec, i)).join("");
  const group = line
    ? `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${series}<c:marker val="1"/><c:axId val="111"/><c:axId val="222"/></c:lineChart>`
    : `<c:barChart><c:barDir val="${horizontal ? "bar" : "col"}"/><c:grouping val="clustered"/><c:varyColors val="0"/>${series}` +
      '<c:gapWidth val="80"/><c:overlap val="-10"/><c:axId val="111"/><c:axId val="222"/></c:barChart>';
  const axisLine = `<c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="${PALETTE.rule}"/></a:solidFill></a:ln></c:spPr>`;
  const catAx =
    `<c:catAx><c:axId val="111"/><c:scaling><c:orientation val="${horizontal ? "maxMin" : "minMax"}"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${horizontal ? "l" : "b"}"/><c:numFmt formatCode="General" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/>` +
    `<c:tickLblPos val="nextTo"/>${axisLine}${txPr(1100)}<c:crossAx val="222"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx>`;
  const valAx =
    `<c:valAx><c:axId val="222"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${horizontal ? "t" : "l"}"/>` +
    `<c:majorGridlines><c:spPr><a:ln w="9525"><a:solidFill><a:srgbClr val="EDF1F5"/></a:solidFill></a:ln></c:spPr></c:majorGridlines>` +
    `<c:numFmt formatCode="${esc(spec.numberFormat ?? "General")}" sourceLinked="0"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/>` +
    `<c:spPr><a:ln><a:noFill/></a:ln></c:spPr>${txPr(1000)}<c:crossAx val="111"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  const title = spec.title
    ? "<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr>" +
      `<a:defRPr sz="1300" b="1"><a:solidFill><a:srgbClr val="${PALETTE.text}"/></a:solidFill><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/></a:defRPr></a:pPr>` +
      `<a:r><a:rPr lang="ja-JP" altLang="en-US" sz="1300" b="1"><a:solidFill><a:srgbClr val="${PALETTE.text}"/></a:solidFill><a:latin typeface="${FONT}"/><a:ea typeface="${FONT}"/></a:rPr><a:t>${esc(spec.title)}</a:t></a:r></a:p></c:rich></c:tx>` +
      '<c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>'
    : '<c:autoTitleDeleted val="1"/>';
  const legend =
    spec.series.length > 1
      ? `<c:legend><c:legendPos val="b"/><c:overlay val="0"/>${txPr(1100)}</c:legend>`
      : "";
  return (
    XML_HEAD +
    '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<c:date1904 val="0"/><c:roundedCorners val="0"/>' +
    `<c:chart>${title}<c:plotArea><c:layout/>${group}${catAx}${valAx}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    "<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>" +
    txPr(1100) +
    '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData>' +
    "</c:chartSpace>"
  );
}

/** The chart's data as a one-sheet workbook (categories in column A, one column per series). */
export async function chartWorkbook(spec: ChartSpec, now: Date): Promise<Buffer> {
  const rows = spec.categories.map((c, i) => [c, ...spec.series.map((s) => s.values[i] ?? null)]);
  const out = await renderXlsx(
    {
      title: spec.title,
      sheets: [
        {
          name: "Sheet1",
          header: ["", ...spec.series.map((s) => s.name)],
          rows,
          formats: ["", ...spec.series.map(() => spec.numberFormat ?? "")],
        },
      ],
    },
    now,
  );
  return out.buffer;
}
