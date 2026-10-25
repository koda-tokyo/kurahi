// Static policy for inbound files, applied BEFORE any scanner and whatever the scanner is
// (docs/security/attachment-intake.md). It looks at bytes, never trusts the name alone, and
// refuses with a stable code:
//
//   executable         PE (MZ), ELF, Mach-O / universal binaries, Java class files, or an
//                      executable / script extension (.exe .js .vbs .ps1 .bat .cmd .scr .lnk
//                      .hta .jar .msi .iso .img …), also as an entry inside an archive
//   script             a `#!` script
//   office_macro       vbaProject.bin in an Office zip, a macro-enabled content type, a
//                      macro-enabled extension (.docm .xlsm .pptm …), or VBA in an OLE file
//   encrypted_archive  a zip entry with the encryption bit or AES method
//   encrypted_office   an OLE compound file holding an EncryptedPackage (encrypted OOXML)
//   nested_archive     an archive inside an archive inside the file (depth > 1)
//   zip_bomb           too many entries, too much declared or actual uncompressed data, or a
//                      compression ratio beyond the cap
//   archive_unreadable a zip whose directory cannot be read (or ZIP64, which no allowed
//                      document of at most 20 MB needs)
//   unsupported_type   anything not in the document allow-list (src/projects/documents.ts)
//   type_mismatch      content that does not match the extension
//   empty / too_large  0 bytes, or more than the intake maximum
//
// Allowed kinds are the document allow-list exactly (validateDocument).

import zlib from "node:zlib";
import { type DocumentKind, kindFromName, validateDocument } from "../projects/documents.js";

export const ATTACHMENT_MAX_BYTES = 20 * 1024 * 1024;

export const POLICY_REFUSAL_CODES = [
  "empty",
  "too_large",
  "executable",
  "script",
  "office_macro",
  "encrypted_archive",
  "encrypted_office",
  "nested_archive",
  "zip_bomb",
  "archive_unreadable",
  "unsupported_type",
  "type_mismatch",
] as const;
export type PolicyRefusalCode = (typeof POLICY_REFUSAL_CODES)[number];

export type PolicyResult =
  | { ok: true; kind: DocumentKind }
  | { ok: false; code: PolicyRefusalCode; reason: string };

export type ZipLimits = {
  maxEntries: number;
  /** Sum of declared uncompressed sizes. */
  maxTotalUncompressed: number;
  /** Uncompressed / compressed, checked for entries larger than `ratioMinBytes`. */
  maxRatio: number;
  ratioMinBytes: number;
  /** Bytes the policy itself may inflate while inspecting nested parts. */
  maxInflated: number;
};

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 5000,
  maxTotalUncompressed: 200 * 1024 * 1024,
  maxRatio: 200,
  ratioMinBytes: 1024 * 1024,
  maxInflated: 64 * 1024 * 1024,
};

const EXECUTABLE_EXTENSIONS = new Set([
  // Windows binaries and installers
  "exe",
  "dll",
  "com",
  "scr",
  "pif",
  "cpl",
  "sys",
  "drv",
  "ocx",
  "msi",
  "msp",
  "mst",
  "msix",
  "appx",
  "appxbundle",
  "xll",
  "application",
  "gadget",
  "msc",
  "inf",
  "reg",
  "chm",
  "hta",
  // scripts
  "js",
  "jse",
  "mjs",
  "vbs",
  "vbe",
  "wsf",
  "wsh",
  "wsc",
  "sct",
  "ps1",
  "psm1",
  "psd1",
  "ps1xml",
  "bat",
  "cmd",
  "sh",
  "bash",
  "zsh",
  "py",
  "pyw",
  "pl",
  "rb",
  "php",
  "applescript",
  "scpt",
  "command",
  "workflow",
  // shortcuts and shell objects
  "lnk",
  "url",
  "scf",
  "library-ms",
  "settingcontent-ms",
  "appref-ms",
  // archives of code, disk images, packages
  "jar",
  "iso",
  "img",
  "vhd",
  "vhdx",
  "dmg",
  "pkg",
  "apk",
  "app",
  "deb",
  "rpm",
]);

const MACRO_EXTENSIONS = new Set([
  "docm",
  "dotm",
  "xlsm",
  "xltm",
  "xlsb",
  "xlam",
  "pptm",
  "potm",
  "ppsm",
  "ppam",
  "sldm",
]);

const ARCHIVE_EXTENSIONS = new Set([
  "zip",
  "zipx",
  "7z",
  "rar",
  "gz",
  "tgz",
  "tar",
  "bz2",
  "xz",
  "cab",
  "lzh",
  "arj",
  "jar",
  "iso",
  "img",
  "docx",
  "xlsx",
  "pptx",
  "docm",
  "xlsm",
  "pptm",
  "dotx",
  "xltx",
  "potx",
  "odt",
  "ods",
  "odp",
  "epub",
]);

const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

function startsWith(buf: Uint8Array, bytes: number[], offset = 0): boolean {
  return buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);
}

/** Every extension of a name, last first (`a.pdf.exe` → exe, pdf). */
function extensionsOf(name: string): string[] {
  const base = name.trim().toLowerCase().replace(/\\/g, "/").split("/").pop() ?? "";
  const parts = base.split(".");
  return parts.length > 1 ? parts.slice(1).toReversed() : [];
}

const refuse = (code: PolicyRefusalCode, reason: string): PolicyResult => ({
  ok: false,
  code,
  reason,
});

/** What the first bytes say, when they say something that is always refused. */
function magicRefusal(buf: Uint8Array): PolicyResult | null {
  if (startsWith(buf, [0x4d, 0x5a])) {
    return refuse("executable", "a Windows executable (PE)");
  }
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) {
    return refuse("executable", "an ELF executable");
  }
  for (const m of [
    [0xfe, 0xed, 0xfa, 0xce],
    [0xfe, 0xed, 0xfa, 0xcf],
    [0xce, 0xfa, 0xed, 0xfe],
    [0xcf, 0xfa, 0xed, 0xfe],
    [0xca, 0xfe, 0xba, 0xbe],
  ]) {
    if (startsWith(buf, m)) {
      return refuse("executable", "a Mach-O / universal binary or Java class file");
    }
  }
  if (startsWith(buf, [0x23, 0x21])) {
    return refuse("script", "a script (#!)");
  }
  // ISO 9660 volume descriptor
  if (startsWith(buf, [0x43, 0x44, 0x30, 0x30, 0x31], 0x8001)) {
    return refuse("executable", "a disk image");
  }
  return null;
}

function utf16(s: string): Buffer {
  return Buffer.from(s, "utf16le");
}

/** OLE compound files: legacy Office, MSI, and the container of encrypted OOXML. */
function cfbRefusal(buf: Buffer): PolicyResult {
  if (buf.includes(utf16("EncryptedPackage")) || buf.includes(utf16("EncryptionInfo"))) {
    return refuse("encrypted_office", "an encrypted (password protected) Office file");
  }
  if (
    buf.includes(utf16("_VBA_PROJECT")) ||
    buf.includes(utf16("VBA")) ||
    buf.includes(utf16("Macros"))
  ) {
    return refuse("office_macro", "an Office file with macros");
  }
  return refuse("unsupported_type", "a legacy Office or OLE file (not in the allow-list)");
}

type ZipEntry = {
  name: string;
  flags: number;
  method: number;
  compressed: number;
  uncompressed: number;
  localOffset: number;
};

class ZipRefused extends Error {
  constructor(
    readonly code: PolicyRefusalCode,
    reason: string,
  ) {
    super(reason);
  }
}

/** The central directory of a zip (no decompression). */
export function readZipDirectory(buf: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipEntry[] {
  const minEocd = 22;
  let eocd = -1;
  for (let i = buf.length - minEocd; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new ZipRefused("archive_unreadable", "the archive directory is missing");
  }
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff || cdSize === 0xffffffff) {
    throw new ZipRefused("archive_unreadable", "ZIP64 archives are not accepted");
  }
  if (count > limits.maxEntries) {
    throw new ZipRefused("zip_bomb", `more than ${limits.maxEntries} entries`);
  }
  if (cdOffset + cdSize > buf.length) {
    throw new ZipRefused("archive_unreadable", "the archive directory is out of bounds");
  }
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new ZipRefused("archive_unreadable", "a damaged archive directory");
    }
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const entry: ZipEntry = {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      compressed: buf.readUInt32LE(p + 20),
      uncompressed: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
      name: buf.subarray(p + 46, p + 46 + nameLen).toString("utf8"),
    };
    if (entry.compressed === 0xffffffff || entry.uncompressed === 0xffffffff) {
      throw new ZipRefused("archive_unreadable", "ZIP64 archives are not accepted");
    }
    out.push(entry);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** The bytes of one entry, inflated with a hard cap at its declared size. */
function entryData(buf: Buffer, e: ZipEntry, budget: { left: number }): Buffer {
  const lh = e.localOffset;
  if (lh + 30 > buf.length || buf.readUInt32LE(lh) !== 0x04034b50) {
    throw new ZipRefused("archive_unreadable", "a damaged archive entry");
  }
  const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
  const data = buf.subarray(start, start + e.compressed);
  if (data.length !== e.compressed) {
    throw new ZipRefused("archive_unreadable", "a truncated archive entry");
  }
  if (e.uncompressed > budget.left) {
    throw new ZipRefused("zip_bomb", "too much data to inspect");
  }
  let out: Buffer;
  if (e.method === 0) {
    out = data;
  } else if (e.method === 8) {
    try {
      out = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, e.uncompressed) });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ERR_BUFFER_TOO_LARGE") {
        throw new ZipRefused("zip_bomb", "an entry inflates beyond its declared size");
      }
      throw new ZipRefused("archive_unreadable", "an entry does not inflate");
    }
  } else {
    throw new ZipRefused("archive_unreadable", `compression method ${e.method} is not accepted`);
  }
  if (out.length !== e.uncompressed) {
    throw new ZipRefused("zip_bomb", "an entry's size does not match its declaration");
  }
  budget.left -= out.length;
  return out;
}

/**
 * Inspect a zip (an Office file or a plain archive) at `depth` (0 = the attachment itself).
 * Nested archives are opened once (depth 1); an archive inside that is refused.
 */
function inspectZip(
  buf: Buffer,
  depth: number,
  limits: ZipLimits,
  budget: { left: number },
): PolicyRefusalCode | null {
  const entries = readZipDirectory(buf, limits);
  let total = 0;
  for (const e of entries) {
    // Bit 0: traditional encryption; method 99: AES (WinZip).
    if ((e.flags & 0x1) !== 0 || e.method === 99) {
      throw new ZipRefused("encrypted_archive", "an encrypted (password protected) archive");
    }
    total += e.uncompressed;
    if (total > limits.maxTotalUncompressed) {
      throw new ZipRefused("zip_bomb", "the archive expands beyond the size cap");
    }
    if (
      e.uncompressed > limits.ratioMinBytes &&
      e.uncompressed / Math.max(1, e.compressed) > limits.maxRatio
    ) {
      throw new ZipRefused("zip_bomb", "an entry's compression ratio is beyond the cap");
    }
  }
  for (const e of entries) {
    const lower = e.name.toLowerCase();
    if (lower.endsWith("/")) {
      continue;
    }
    const base = lower.split("/").pop() ?? "";
    if (base === "vbaproject.bin" || base === "vbaprojectsignature.bin") {
      throw new ZipRefused("office_macro", "an Office file with macros (vbaProject.bin)");
    }
    const exts = extensionsOf(base);
    if (exts[0] && EXECUTABLE_EXTENSIONS.has(exts[0]) && !ARCHIVE_EXTENSIONS.has(exts[0])) {
      throw new ZipRefused("executable", "an executable or script inside the archive");
    }
    if (lower === "[content_types].xml") {
      const xml = entryData(buf, e, budget).toString("utf8");
      if (/macroEnabled|vbaProject/i.test(xml)) {
        throw new ZipRefused("office_macro", "a macro-enabled Office content type");
      }
      continue;
    }
    const nestedByName = exts[0] !== undefined && ARCHIVE_EXTENSIONS.has(exts[0]);
    // Embedded objects (word/embeddings/…, xl/embeddings/…) and anything named like an
    // archive are opened: their content decides.
    if (nestedByName || /(^|\/)embeddings\//.test(lower) || lower.endsWith(".bin")) {
      const inner = entryData(buf, e, budget);
      const magic = magicRefusal(inner);
      if (magic && !magic.ok) {
        throw new ZipRefused(magic.code, `${magic.reason} inside the archive`);
      }
      if (startsWith(inner, CFB_MAGIC)) {
        const r = cfbRefusal(inner);
        if (!r.ok && r.code !== "unsupported_type") {
          throw new ZipRefused(r.code, `${r.reason} inside the archive`);
        }
        continue;
      }
      if (
        startsWith(inner, [0x50, 0x4b, 0x03, 0x04]) ||
        startsWith(inner, [0x50, 0x4b, 0x05, 0x06])
      ) {
        if (depth >= 1) {
          throw new ZipRefused("nested_archive", "archives nested more than one level deep");
        }
        inspectZip(inner, depth + 1, limits, budget);
      } else if (nestedByName && ["7z", "rar", "gz", "tgz", "bz2", "xz", "cab"].includes(exts[0])) {
        // Formats the policy cannot open are not inspected, so they are not accepted.
        throw new ZipRefused("nested_archive", "an archive the policy cannot inspect");
      }
    }
  }
  return null;
}

/** The static verdict for one inbound file. Pure (no I/O beyond the buffer). */
export async function checkAttachmentPolicy(
  name: string,
  buf: Buffer,
  opts: { maxBytes?: number; zip?: ZipLimits } = {},
): Promise<PolicyResult> {
  const maxBytes = opts.maxBytes ?? ATTACHMENT_MAX_BYTES;
  if (buf.length === 0) {
    return refuse("empty", "the file is empty");
  }
  if (buf.length > maxBytes) {
    return refuse("too_large", `the file is larger than ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
  const exts = extensionsOf(name);
  const last = exts[0] ?? "";
  if (EXECUTABLE_EXTENSIONS.has(last)) {
    return refuse("executable", `.${last} files are never accepted`);
  }
  if (MACRO_EXTENSIONS.has(last)) {
    return refuse("office_macro", `.${last} is a macro-enabled Office format`);
  }
  const magic = magicRefusal(buf);
  if (magic) {
    return magic;
  }
  if (startsWith(buf, CFB_MAGIC)) {
    return cfbRefusal(buf);
  }
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) {
    try {
      inspectZip(buf, 0, opts.zip ?? DEFAULT_ZIP_LIMITS, {
        left: (opts.zip ?? DEFAULT_ZIP_LIMITS).maxInflated,
      });
    } catch (err) {
      if (err instanceof ZipRefused) {
        return refuse(err.code, err.message);
      }
      return refuse("archive_unreadable", "the archive cannot be read");
    }
  }
  // Last: the document allow-list (extension and content must agree).
  if (!kindFromName(name)) {
    return refuse("unsupported_type", "the file type is not in the document allow-list");
  }
  const check = await validateDocument(name, buf);
  if (!check.ok) {
    return refuse("type_mismatch", "the content does not match the file extension");
  }
  return { ok: true, kind: check.kind };
}
