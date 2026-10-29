import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { readXlsxRows } from "./price-list-xlsx.js";
import { readPriceList, readPriceListRows } from "./price-list.js";
import { testWorkbook } from "./test-helpers.js";

const s = (ref: string, i: number) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
const n = (ref: string, v: string) => `<c r="${ref}"><v>${v}</v></c>`;
const inline = (ref: string, v: string) => `<c r="${ref}" t="inlineStr"><is><t>${v}</t></is></c>`;

// Shared strings as Japanese Excel saves them: with the phonetic reading (ルビ) of each cell.
const SHARED = [
  "<t>品番</t>",
  '<t>品名</t><rPh sb="0" eb="2"><t>ヒンメイ</t></rPh><phoneticPr fontId="1"/>',
  "<t>単価</t>",
  "<t>税率</t>",
  '<t>部品A</t><rPh sb="0" eb="2"><t>ブヒン</t></rPh>',
  '<r><t>ボルト</t></r><r><t xml:space="preserve"> M8 &amp; ナット</t></r>',
];
const HEADER = `<row r="1">${s("A1", 0)}${s("B1", 1)}${s("C1", 2)}${s("D1", 3)}</row>`;

async function rows(xml: string, extra: Parameters<typeof testWorkbook>[0] = []) {
  return readXlsxRows(await testWorkbook([...extra, { name: "価格表", xml }], SHARED));
}

describe("readXlsxRows", () => {
  it("reads the first visible sheet into price list rows with spreadsheet row numbers", async () => {
    const sheet = await rows(
      HEADER +
        '<row r="2"/>' +
        `<row r="3">${inline("A3", "A-100")}${s("B3", 4)}${n("C3", "1200")}${n("D3", "0.1")}</row>` +
        `<row r="4"><c r="A4" s="1"/></row>` +
        `<row r="5">${inline("A5", "B-200")}${s("B5", 5)}${n("C5", "12.5")}</row>`,
      [{ name: "旧", xml: HEADER, hidden: true }],
    );
    expect(sheet).toEqual({
      sheet: "価格表",
      rows: [
        ["品番", "品名", "単価", "税率"],
        ["A-100", "部品A", "1200", "0.1"],
        ["B-200", "ボルト M8 & ナット", "12.5"],
      ],
      rowNumbers: [1, 3, 5],
    });
    const list = readPriceListRows(sheet.rows, 10, sheet.rowNumbers);
    expect(list.problems).toEqual([]);
    expect(list.byCode.get("A-100")).toMatchObject({
      name: "部品A",
      unitPrice: "1200",
      taxRate: 10,
    });
    expect(list.byName.get("ボルト m8 & ナット")?.code).toBe("B-200");
  });

  it("refuses a row whose value is unknown or an error, naming the spreadsheet row", async () => {
    const sheet = await rows(
      HEADER +
        `<row r="2">${inline("A2", "A-1")}${inline("B2", "a")}${n("C2", "100")}<c r="D2"><f>C2*0</f></c></row>` +
        `<row r="3">${inline("A3", "A-2")}${inline("B3", "b")}<c r="C3" t="e"><v>#N/A</v></c></row>` +
        `<row r="4">${inline("A4", "A-3")}${inline("B4", "c")}<c r="C4" t="b"><v>1</v></c></row>` +
        `<row r="5">${inline("A5", "A-4")}${inline("B5", "d")}${n("C5", "1499.9999999999998")}</row>` +
        `<row r="6">${inline("A6", "A-5")}${inline("B6", "e")}<c r="C6"><f>100*2</f><v>200</v></c></row>`,
    );
    const list = readPriceListRows(sheet.rows, 10, sheet.rowNumbers);
    expect(list.items.map((i) => i.code)).toEqual(["A-5"]);
    expect(list.byCode.get("A-5")?.unitPrice).toBe("200");
    expect(list.problems).toEqual([
      "row 2 (A-1): a formula has no saved value; open and save the list in Excel",
      "row 3 (A-2): a cell shows the error #N/A",
      expect.stringMatching(/^row 4 \(A-3\): /),
      expect.stringMatching(/^row 5 \(A-4\): /),
    ]);
  });

  it("refuses a file that is not a readable workbook", async () => {
    expect(() => readXlsxRows(new TextEncoder().encode("品番,品名,単価\nA,x,1"))).toThrow(
      "the workbook cannot be read",
    );
    const zip = new JSZip();
    zip.file("word/document.xml", "<w:document/>");
    const notWorkbook = await zip.generateAsync({ type: "uint8array" });
    expect(() => readXlsxRows(notWorkbook)).toThrow("not an Excel workbook");
    await expect(rows(HEADER, [])).resolves.toHaveProperty("rows.length", 1);
    await expect(rows(`<row r="1">${n("IW1", "1")}</row>`)).rejects.toThrow("beyond column 256");
    await expect(rows(`<row r="1">${s("A1", 99)}</row>`)).rejects.toThrow("missing shared string");
  });
});

/** A workbook built by testWorkbook, then one part rewritten. */
async function edited(
  sheets: Parameters<typeof testWorkbook>[0],
  part: string,
  edit: (xml: string) => string,
) {
  const zip = await JSZip.loadAsync(await testWorkbook(sheets, SHARED));
  zip.file(part, edit(await zip.file(part)!.async("string")));
  return readXlsxRows(await zip.generateAsync({ type: "uint8array" }));
}

describe("readXlsxRows XML interpretation", () => {
  const PRICE = `<row r="2">${inline("A2", "A-1")}${inline("B2", "a")}${n("C2", "100")}</row>`;
  const SHEET = "xl/worksheets/sheet1.xml";

  it("refuses comments instead of reading or skipping what they hold", async () => {
    // A commented-out cell or row must not become a price; nor may a comment be silently dropped.
    await expect(
      rows(HEADER + PRICE.replace("</row>", `<!--${n("C2", "1")}--></row>`)),
    ).rejects.toThrow("comments are not accepted");
    await expect(rows(`${HEADER}<!--${PRICE}-->`)).rejects.toThrow("comments are not accepted");
    await expect(
      edited([{ name: "P", xml: HEADER }], "xl/workbook.xml", (x) =>
        x.replace("<sheets>", "<sheets><!-- --> "),
      ),
    ).rejects.toThrow("comments are not accepted");
  });

  it("refuses a DTD, CDATA and an unknown entity", async () => {
    const sheets = [{ name: "P", xml: HEADER + PRICE }];
    await expect(
      edited(sheets, SHEET, (x) =>
        x.replace("<worksheet", '<!DOCTYPE w [<!ENTITY p "1">]><worksheet'),
      ),
    ).rejects.toThrow("cannot be read");
    await expect(
      edited(sheets, SHEET, (x) => x.replace("<v>100</v>", "<v><![CDATA[1]]></v>")),
    ).rejects.toThrow("cannot be read");
    await expect(
      edited(sheets, SHEET, (x) => x.replace("<v>100</v>", "<v>&#999999999;</v>")),
    ).rejects.toThrow("cannot be read");
  });

  it("reads hidden state and attributes in either quote style and a prefixed namespace", async () => {
    const sheets = [
      { name: "旧", xml: `<row r="2">${inline("A2", "A-1")}${n("C2", "1")}</row>`, hidden: true },
      { name: "現行", xml: HEADER + PRICE },
    ];
    const single = await edited(sheets, "xl/workbook.xml", (x) =>
      x.replace('state="hidden"', "state='hidden'"),
    );
    expect(single.sheet).toBe("現行");
    const veryHidden = await edited(sheets, "xl/workbook.xml", (x) =>
      x.replace('state="hidden"', 'state="veryHidden"'),
    );
    expect(veryHidden.sheet).toBe("現行");
    // Some tools write the spreadsheet namespace with a prefix (x:row, x:c).
    const prefixed = await edited([{ name: "P", xml: HEADER + PRICE }], SHEET, (x) =>
      x
        .replace(/<(\/?)(worksheet|sheetData|row|c|v|is|t)\b/g, "<$1x:$2")
        .replace('xmlns="', 'xmlns:x="'),
    );
    expect(prefixed.rows.at(-1)).toEqual(["A-1", "a", "100"]);
  });

  it("refuses another dialect, a sheet that is not a worksheet, and rows or cells out of order", async () => {
    const sheets = [{ name: "P", xml: HEADER + PRICE }];
    await expect(
      edited(sheets, SHEET, (x) =>
        x.replace(
          "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
          "http://purl.oclc.org/ooxml/spreadsheetml/main",
        ),
      ),
    ).rejects.toThrow("not in a supported format");
    await expect(
      edited(sheets, "xl/_rels/workbook.xml.rels", (x) => x.replace("/worksheet", "/chartsheet")),
    ).rejects.toThrow("is not a worksheet");
    await expect(rows(PRICE + HEADER)).rejects.toThrow("row 1 is out of order");
    await expect(
      rows(`<row r="2">${inline("A2", "A-1")}${n("C2", "100")}${n("C2", "1")}</row>`),
    ).rejects.toThrow("cell C2 is out of order");
    // A cell naming another row would move its value; a malformed reference has no place at all.
    await expect(
      rows(`<row r="2">${inline("A2", "A-1")}${inline("B2", "a")}${n("C5", "100")}</row>`),
    ).rejects.toThrow("cell C5 is not in row 2");
    await expect(rows(`<row r="2">${inline("A2", "A-1")}${n("C", "100")}</row>`)).rejects.toThrow(
      "cell C is not in row 2",
    );
    await expect(rows(`<row r="2">${inline("A2", "A-1")}${n("c2", "100")}</row>`)).rejects.toThrow(
      "cell c2 is not in row 2",
    );
    await expect(rows(`<row r="2">${inline("A2", "A-1")}${n("C02", "1")}</row>`)).rejects.toThrow(
      "cell C02 is not in row 2",
    );
  });
});

describe("Excel error values in a CSV list", () => {
  it("are refused instead of read as a value or a blank tax rate", () => {
    const list = readPriceList("品番,品名,単価,税率\nA,x,100,#N/A\nB,y,#REF!,10\nC,z,100,");
    expect(list.items.map((i) => i.code)).toEqual(["C"]);
    expect(list.problems).toEqual([
      "row 2 (A): a cell shows the error #N/A",
      "row 3 (B): a cell shows the error #REF!",
    ]);
  });
});
