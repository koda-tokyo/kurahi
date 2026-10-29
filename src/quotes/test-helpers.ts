import JSZip from "jszip";

export type TestSheet = { name: string; xml: string; hidden?: boolean };

/** A minimal .xlsx: the given sheets (worksheet XML bodies inside <sheetData>) and shared strings. */
export async function testWorkbook(sheets: TestSheet[], shared: string[] = []): Promise<Buffer> {
  const zip = new JSZip();
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const rns = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  zip.file(
    "xl/workbook.xml",
    `<?xml version="1.0" encoding="UTF-8"?><workbook ${ns} ${rns}><sheets>${sheets
      .map(
        (s, i) =>
          `<sheet name="${s.name}" sheetId="${i + 1}"${s.hidden ? ' state="hidden"' : ""} r:id="rId${i + 1}"/>`,
      )
      .join("")}</sheets></workbook>`,
  );
  zip.file(
    "xl/_rels/workbook.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          // Sheet files numbered in reverse, so the reader must follow the relationship.
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${sheets.length - i}.xml"/>`,
      )
      .join("")}</Relationships>`,
  );
  sheets.forEach((s, i) =>
    zip.file(
      `xl/worksheets/sheet${sheets.length - i}.xml`,
      `<?xml version="1.0" encoding="UTF-8"?><worksheet ${ns}><sheetData>${s.xml}</sheetData></worksheet>`,
    ),
  );
  if (shared.length > 0) {
    zip.file(
      "xl/sharedStrings.xml",
      `<?xml version="1.0" encoding="UTF-8"?><sst ${ns} count="${shared.length}">${shared
        .map((x) => `<si>${x}</si>`)
        .join("")}</sst>`,
    );
  }
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}
