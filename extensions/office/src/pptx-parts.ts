// Fixed PresentationML parts: theme, slide master, blank layout, notes master and the small
// presentation-level property parts. Colours and fonts come from the Kurahi office palette.
import { esc, XML_HEAD } from "../../../src/office/common.js";

export const NS =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';

export const PALETTE = {
  background: "FFFFFF",
  text: "1F2933",
  muted: "5B6770",
  accent: "1F5AA6",
  accentSoft: "EEF3FA",
  rule: "D5DCE5",
  badgeFill: "FFF4E5",
  badgeLine: "D97706",
  badgeText: "92400E",
  series: ["1F5AA6", "E07B39", "4F8A5B", "8A6FB0"],
};

/** Latin and East Asian typeface; where it is missing, Office substitutes by the sans-serif
 * pitch family, and LibreOffice by its font replacement table. */
export const FONT = "Yu Gothic";

export const GRP_SP_PR =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const CLR_MAP =
  'bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"';

export function themeXml(name: string): string {
  const srgb = (v: string) => `<a:srgbClr val="${v}"/>`;
  const fontSet = `<a:latin typeface="${FONT}" panose="020B0400000000000000"/><a:ea typeface="${FONT}"/><a:cs typeface=""/><a:font script="Jpan" typeface="${FONT}"/>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const line = (w: number) =>
    `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr">${solid}<a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return (
    XML_HEAD +
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${esc(name)}"><a:themeElements>` +
    '<a:clrScheme name="Kurahi">' +
    `<a:dk1>${srgb("1F2933")}</a:dk1><a:lt1>${srgb("FFFFFF")}</a:lt1><a:dk2>${srgb("2E3A46")}</a:dk2><a:lt2>${srgb("EEF3FA")}</a:lt2>` +
    PALETTE.series.map((c, i) => `<a:accent${i + 1}>${srgb(c)}</a:accent${i + 1}>`).join("") +
    `<a:accent5>${srgb("5B6770")}</a:accent5><a:accent6>${srgb("9AA5B1")}</a:accent6>` +
    `<a:hlink>${srgb("1F5AA6")}</a:hlink><a:folHlink>${srgb("6B4FA0")}</a:folHlink></a:clrScheme>` +
    `<a:fontScheme name="Kurahi"><a:majorFont>${fontSet}</a:majorFont><a:minorFont>${fontSet}</a:minorFont></a:fontScheme>` +
    '<a:fmtScheme name="Kurahi"><a:fillStyleLst>' +
    `${solid}${solid}${solid}</a:fillStyleLst>` +
    `<a:lnStyleLst>${line(6350)}${line(12700)}${line(19050)}</a:lnStyleLst>` +
    "<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>" +
    `<a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst>` +
    "</a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>"
  );
}

function lvlStyle(sz: number): string {
  return `<a:lvl1pPr><a:defRPr sz="${sz}" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>`;
}

export function slideMasterXml(): string {
  return (
    XML_HEAD +
    `<p:sldMaster ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${PALETTE.background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` +
    `<p:spTree>${GRP_SP_PR}</p:spTree></p:cSld>` +
    `<p:clrMap ${CLR_MAP}/>` +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    `<p:txStyles><p:titleStyle>${lvlStyle(3200)}</p:titleStyle><p:bodyStyle>${lvlStyle(1800)}</p:bodyStyle><p:otherStyle>${lvlStyle(1800)}</p:otherStyle></p:txStyles>` +
    "</p:sldMaster>"
  );
}

export function slideLayoutXml(): string {
  return (
    XML_HEAD +
    `<p:sldLayout ${NS} type="blank" preserve="1"><p:cSld name="Blank"><p:spTree>${GRP_SP_PR}</p:spTree></p:cSld>` +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
  );
}

export const NOTES_SIZE = { cx: 6858000, cy: 9144000 };

const NOTES_IMG =
  '<p:spPr><a:xfrm><a:off x="381000" y="685800"/><a:ext cx="6096000" cy="3429000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr>';
const NOTES_BODY_XFRM =
  '<a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>';

export function notesMasterXml(): string {
  return (
    XML_HEAD +
    `<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP_SP_PR}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr>' +
    `${NOTES_IMG}</p:sp>` +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr>${NOTES_BODY_XFRM}</p:spPr><p:txBody><a:bodyPr vert="horz" lIns="91440" tIns="45720" rIns="91440" bIns="45720" rtlCol="0"/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>` +
    `</p:spTree></p:cSld><p:clrMap ${CLR_MAP}/><p:notesStyle>${lvlStyle(1200)}</p:notesStyle></p:notesMaster>`
  );
}

export function notesSlideXml(paragraphs: string): string {
  return (
    XML_HEAD +
    `<p:notes ${NS}><p:cSld><p:spTree>${GRP_SP_PR}` +
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp>' +
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr>' +
    `<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</p:txBody></p:sp>` +
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>"
  );
}

export function presPropsXml(): string {
  return XML_HEAD + `<p:presentationPr ${NS}/>`;
}

export function viewPropsXml(): string {
  return (
    XML_HEAD +
    `<p:viewPr ${NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`
  );
}

export function tableStylesXml(): string {
  return (
    XML_HEAD +
    '<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>'
  );
}
