// Read an import bundle (a .zip or a folder) into memory under hard limits, refusing anything
// that is not a plain, relative, bounded set of files:
//
//   - zip: the central directory is read here first (not trusted to the zip library, which
//     rewrites `..` in names): ZIP64, encryption, unknown compression, symbolic links, absolute or
//     `..`/`.` paths, backslashes, NUL, duplicate names, too many entries, a declared size over the
//     limits or a compression ratio past MAX_RATIO are refused before anything is inflated; then
//     every entry is inflated as a stream and cut off at the declared size (a lying header is a
//     zip bomb, refused)
//   - folder: walked without following symbolic links; anything that is not a file or folder
//     is refused
//
// Nothing from the bundle is executed or written anywhere by this module.

import JSZip from "jszip";
import fs from "node:fs";
import path from "node:path";
import { ProviderError } from "../providers.js";

export type BundleLimits = {
  /** Size of the .zip file itself. */
  maxArchiveBytes: number;
  /** Sum of all files once extracted. */
  maxTotalBytes: number;
  maxFileBytes: number;
  maxEntries: number;
  /** Highest uncompressed/compressed ratio for an entry larger than 1 MiB. */
  maxRatio: number;
};

export const DEFAULT_BUNDLE_LIMITS: BundleLimits = {
  maxArchiveBytes: 200 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxEntries: 5000,
  maxRatio: 100,
};

export type BundleFiles = Map<string, Buffer>;

const reject = (message: string) =>
  new ProviderError(
    "ARTEFACT_INTEGRITY_FAILED",
    message,
    "Export the bundle again from the vendor tool and import the unchanged file.",
  );

/** A bundle-relative path is safe when it is plain, relative and has no `.`/`..` segments. */
export function safeEntryName(name: string): boolean {
  if (!name || name.length > 512 || name.includes("\0") || name.includes("\\")) {
    return false;
  }
  if (name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    return false;
  }
  return name.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

type CentralEntry = {
  name: string;
  dir: boolean;
  compressed: number;
  size: number;
};

/** Parse the zip central directory (classic zip only) and apply the static limits. */
export function readCentralDirectory(buf: Buffer, limits: BundleLimits): CentralEntry[] {
  const EOCD = 0x06054b50;
  const min = Math.max(0, buf.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw reject("the file is not a zip archive");
  }
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    throw reject("ZIP64 archives are not accepted");
  }
  if (count > limits.maxEntries) {
    throw reject(`the archive has ${count} entries, over the limit of ${limits.maxEntries}`);
  }
  if (cdOffset + cdSize > eocd) {
    throw reject("the zip central directory is damaged");
  }
  const out: CentralEntry[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) {
      throw reject("the zip central directory is damaged");
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const external = buf.readUInt32LE(p + 38);
    const raw = buf.subarray(p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const name = raw.toString("utf8");
    if (flags & 0x1) {
      throw reject("encrypted zip entries are not accepted");
    }
    const unixType = (external >>> 16) & 0o170000;
    if (unixType === 0o120000) {
      throw reject("the archive contains a symbolic link");
    }
    const dir = name.endsWith("/");
    const plain = dir ? name.slice(0, -1) : name;
    if (!safeEntryName(plain)) {
      throw reject("the archive contains an unsafe path (absolute, '..' or not plain)");
    }
    if (dir) {
      continue;
    }
    if (method !== 0 && method !== 8) {
      throw reject(`zip compression method ${method} is not accepted`);
    }
    if (seen.has(plain)) {
      throw reject("the archive contains the same path twice");
    }
    seen.add(plain);
    if (size > limits.maxFileBytes) {
      throw reject(`an entry is ${size} bytes, over the per-file limit of ${limits.maxFileBytes}`);
    }
    if (size > 1024 * 1024 && size / Math.max(1, compressed) > limits.maxRatio) {
      throw reject("an entry's compression ratio is too high (possible zip bomb)");
    }
    total += size;
    if (total > limits.maxTotalBytes) {
      throw reject(`the archive extracts to more than ${limits.maxTotalBytes} bytes`);
    }
    out.push({ name: plain, dir, compressed, size });
  }
  return out;
}

async function inflateCapped(entry: JSZip.JSZipObject, cap: number): Promise<Buffer> {
  const stream = entry.nodeStream("nodebuffer") as NodeJS.ReadableStream & {
    destroy?: () => void;
  };
  return await new Promise<Buffer>((resolve, reject_) => {
    const chunks: Buffer[] = [];
    let n = 0;
    let done = false;
    stream.on("data", (chunk: Buffer) => {
      if (done) {
        return;
      }
      n += chunk.length;
      if (n > cap) {
        done = true;
        stream.pause();
        stream.destroy?.();
        reject_(reject("an entry inflates past its declared size (possible zip bomb)"));
        return;
      }
      chunks.push(chunk);
    });
    stream.on("error", (err: Error) => {
      if (!done) {
        done = true;
        reject_(reject(`the archive could not be read: ${err.message.slice(0, 120)}`));
      }
    });
    stream.on("end", () => {
      if (!done) {
        done = true;
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

export async function readZipBundle(
  buf: Buffer,
  limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
): Promise<BundleFiles> {
  if (buf.length > limits.maxArchiveBytes) {
    throw reject(`the archive is larger than ${limits.maxArchiveBytes} bytes`);
  }
  const entries = readCentralDirectory(buf, limits);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buf, { checkCRC32: true });
  } catch (err) {
    throw reject(
      `the archive could not be read: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`,
    );
  }
  const out: BundleFiles = new Map();
  for (const e of entries) {
    const entry = zip.file(e.name);
    if (!entry) {
      throw reject("the zip central directory and its entries disagree");
    }
    const data = await inflateCapped(entry, e.size);
    if (data.length !== e.size) {
      throw reject("an entry's size differs from the zip directory");
    }
    out.set(e.name, data);
  }
  return out;
}

export function readFolderBundle(
  dir: string,
  limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
): BundleFiles {
  const root = path.resolve(dir);
  const out: BundleFiles = new Map();
  let total = 0;
  const walk = (abs: string, rel: string) => {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      const childAbs = path.join(abs, ent.name);
      if (!safeEntryName(childRel)) {
        throw reject("the folder contains an unsafe path");
      }
      const st = fs.lstatSync(childAbs);
      if (st.isSymbolicLink()) {
        throw reject("the folder contains a symbolic link");
      }
      if (st.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (!st.isFile()) {
        throw reject("the folder contains something that is not a file");
      }
      if (out.size + 1 > limits.maxEntries) {
        throw reject(`the folder has more than ${limits.maxEntries} files`);
      }
      if (st.size > limits.maxFileBytes) {
        throw reject(`a file is over the per-file limit of ${limits.maxFileBytes} bytes`);
      }
      total += st.size;
      if (total > limits.maxTotalBytes) {
        throw reject(`the folder holds more than ${limits.maxTotalBytes} bytes`);
      }
      out.set(childRel, fs.readFileSync(childAbs));
    }
  };
  walk(root, "");
  return out;
}

/** Read a bundle from a path: a folder, or a file that must be a zip archive. */
export async function readBundle(
  target: string,
  limits: BundleLimits = DEFAULT_BUNDLE_LIMITS,
): Promise<{ kind: "zip" | "folder"; files: BundleFiles; archive: Buffer | null }> {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(target);
  } catch {
    throw new ProviderError(
      "SCHEMA_REJECTED",
      "the bundle path does not exist",
      "Give the path of the exported .zip or folder.",
    );
  }
  if (st.isSymbolicLink()) {
    throw reject("the bundle path is a symbolic link");
  }
  if (st.isDirectory()) {
    return { kind: "folder", files: readFolderBundle(target, limits), archive: null };
  }
  if (!st.isFile()) {
    throw reject("the bundle is neither a file nor a folder");
  }
  if (st.size > limits.maxArchiveBytes) {
    throw reject(`the archive is larger than ${limits.maxArchiveBytes} bytes`);
  }
  const archive = fs.readFileSync(target);
  return { kind: "zip", files: await readZipBundle(archive, limits), archive };
}
