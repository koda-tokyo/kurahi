import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { checkAttachmentPolicy } from "./attachment-policy.js";

async function zip(
  files: Record<string, string | Buffer>,
  opts: { compression?: "STORE" | "DEFLATE" } = {},
): Promise<Buffer> {
  const z = new JSZip();
  for (const [name, data] of Object.entries(files)) {
    z.file(name, data);
  }
  return z.generateAsync({ type: "nodebuffer", compression: opts.compression ?? "DEFLATE" });
}

const DOCX_PARTS = {
  "[Content_Types].xml":
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  "word/document.xml":
    '<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Invoice 42</w:t></w:r></w:p></w:body></w:document>',
};
const docx = (extra: Record<string, string | Buffer> = {}) => zip({ ...DOCX_PARTS, ...extra });

/** Set the general-purpose flag bit 0 (encrypted) on every central directory entry. */
function markEncrypted(buf: Buffer): Buffer {
  const out = Buffer.from(buf);
  for (let i = 0; i + 4 <= out.length; i++) {
    if (out.readUInt32LE(i) === 0x02014b50) {
      out.writeUInt16LE(out.readUInt16LE(i + 8) | 1, i + 8);
    }
  }
  return out;
}

/** A minimal OLE compound file header followed by a directory entry name. */
function cfb(streamName: string): Buffer {
  return Buffer.concat([
    Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
    Buffer.alloc(504),
    Buffer.from(streamName, "utf16le"),
    Buffer.alloc(64),
  ]);
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

describe("attachment static policy", () => {
  it.each([
    ["invoice.pdf", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03]), "executable"],
    ["readme.txt", Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01]), "executable"],
    ["tool.pdf", Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x07]), "executable"],
    ["notes.txt", Buffer.from("#!/bin/sh\ncurl x | sh\n"), "script"],
  ])("refuses %s by its magic bytes", async (name, buf, code) => {
    expect(await checkAttachmentPolicy(name, buf)).toMatchObject({ ok: false, code });
  });

  it.each([
    "setup.exe",
    "invoice.pdf.exe",
    "run.js",
    "macro.vbs",
    "script.ps1",
    "go.bat",
    "go.cmd",
    "screen.scr",
    "shortcut.lnk",
    "app.hta",
    "lib.jar",
    "install.msi",
    "disk.iso",
    "disk.img",
  ])("refuses %s by its extension whatever the content", async (name) => {
    expect(await checkAttachmentPolicy(name, Buffer.from("plain text"))).toMatchObject({
      ok: false,
      code: "executable",
    });
  });

  it("refuses a docx carrying vbaProject.bin (renamed macro document)", async () => {
    const buf = await docx({ "word/vbaProject.bin": Buffer.from("VBA") });
    expect(await checkAttachmentPolicy("report.docx", buf)).toMatchObject({
      ok: false,
      code: "office_macro",
    });
  });

  it("refuses a macro-enabled content type and macro-enabled extensions", async () => {
    const buf = await zip({
      ...DOCX_PARTS,
      "[Content_Types].xml":
        '<Types><Default Extension="bin" ContentType="application/vnd.ms-office.vbaProject"/><Override ContentType="application/vnd.ms-word.document.macroEnabled.main+xml"/></Types>',
    });
    expect(await checkAttachmentPolicy("report.docx", buf)).toMatchObject({
      code: "office_macro",
    });
    for (const name of ["a.docm", "a.xlsm", "a.pptm"]) {
      expect(await checkAttachmentPolicy(name, await docx())).toMatchObject({
        code: "office_macro",
      });
    }
  });

  it("refuses VBA in an OLE file and encrypted OOXML", async () => {
    expect(await checkAttachmentPolicy("old.doc", cfb("_VBA_PROJECT"))).toMatchObject({
      code: "office_macro",
    });
    expect(await checkAttachmentPolicy("secret.docx", cfb("EncryptedPackage"))).toMatchObject({
      code: "encrypted_office",
    });
    expect(await checkAttachmentPolicy("old.xls", cfb("Workbook"))).toMatchObject({
      code: "unsupported_type",
    });
  });

  it("refuses a password-protected zip", async () => {
    const buf = markEncrypted(await zip({ "a.txt": "hello" }));
    expect(await checkAttachmentPolicy("files.zip", buf)).toMatchObject({
      code: "encrypted_archive",
    });
    const office = markEncrypted(await docx());
    expect(await checkAttachmentPolicy("report.docx", office)).toMatchObject({
      code: "encrypted_archive",
    });
  });

  it("refuses a zip bomb (compression ratio over the cap)", async () => {
    const buf = await docx({ "word/media/pad.xml": Buffer.alloc(30 * 1024 * 1024, 0x20) });
    expect(buf.length).toBeLessThan(1024 * 1024);
    expect(await checkAttachmentPolicy("big.docx", buf)).toMatchObject({ code: "zip_bomb" });
  });

  it("refuses an entry that inflates beyond its declared size", async () => {
    const buf = await docx({ "word/embeddings/x.bin": Buffer.alloc(4096, 0x41) });
    // Lower the declared uncompressed size of the embedded part in the central directory.
    const out = Buffer.from(buf);
    for (let i = 0; i + 46 <= out.length; i++) {
      if (out.readUInt32LE(i) === 0x02014b50) {
        const nameLen = out.readUInt16LE(i + 28);
        if (out.subarray(i + 46, i + 46 + nameLen).toString() === "word/embeddings/x.bin") {
          out.writeUInt32LE(16, i + 24);
        }
      }
    }
    expect(await checkAttachmentPolicy("lie.docx", out)).toMatchObject({ code: "zip_bomb" });
  });

  it("opens one nested level and refuses archives nested deeper", async () => {
    const xlsx = await zip({ "xl/workbook.xml": "<workbook/>" });
    const ok = await docx({ "word/embeddings/Sheet1.xlsx": xlsx });
    expect(await checkAttachmentPolicy("with-chart.docx", ok)).toMatchObject({
      ok: true,
      kind: "docx",
    });
    const inner = await zip({ "deep.zip": await zip({ "x.txt": "x" }) });
    const nested = await docx({ "word/embeddings/pack.zip": inner });
    expect(await checkAttachmentPolicy("nested.docx", nested)).toMatchObject({
      code: "nested_archive",
    });
  });

  it("refuses an executable hidden inside an Office file", async () => {
    const buf = await docx({ "word/embeddings/oleObject1.bin": Buffer.from([0x4d, 0x5a, 0, 0]) });
    expect(await checkAttachmentPolicy("x.docx", buf)).toMatchObject({ code: "executable" });
    const named = await zip({ "payload/run.exe": "x" });
    expect(await checkAttachmentPolicy("pack.zip", named)).toMatchObject({ code: "executable" });
  });

  it("refuses mismatched extensions and types outside the allow-list", async () => {
    expect(await checkAttachmentPolicy("invoice.docx", PDF)).toMatchObject({
      code: "type_mismatch",
    });
    expect(await checkAttachmentPolicy("report.pdf", Buffer.from("just text"))).toMatchObject({
      code: "type_mismatch",
    });
    expect(await checkAttachmentPolicy("photo.heic", Buffer.from("ftypheic"))).toMatchObject({
      code: "unsupported_type",
    });
    expect(await checkAttachmentPolicy("files.zip", await zip({ "a.txt": "a" }))).toMatchObject({
      code: "unsupported_type",
    });
  });

  it("refuses empty and oversize files", async () => {
    expect(await checkAttachmentPolicy("a.txt", Buffer.alloc(0))).toMatchObject({ code: "empty" });
    expect(
      await checkAttachmentPolicy("a.txt", Buffer.alloc(20 * 1024 * 1024 + 1, 0x41)),
    ).toMatchObject({ code: "too_large" });
  });

  it("accepts the document allow-list", async () => {
    expect(await checkAttachmentPolicy("invoice.pdf", PDF)).toEqual({ ok: true, kind: "pdf" });
    expect(await checkAttachmentPolicy("report.docx", await docx())).toEqual({
      ok: true,
      kind: "docx",
    });
    expect(await checkAttachmentPolicy("notes.txt", Buffer.from("見積書の件"))).toEqual({
      ok: true,
      kind: "txt",
    });
    expect(await checkAttachmentPolicy("data.csv", Buffer.from("a,b\n1,2\n"))).toEqual({
      ok: true,
      kind: "csv",
    });
  });
});
