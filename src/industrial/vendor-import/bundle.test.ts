import JSZip from "jszip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { DEFAULT_BUNDLE_LIMITS, readBundle, readZipBundle, safeEntryName } from "./bundle.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-bundle-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

async function zipOf(
  entries: Record<string, string | Buffer>,
  opts: { unix?: Record<string, number>; compression?: "STORE" | "DEFLATE" } = {},
) {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(entries)) {
    zip.file(name, data, {
      date: new Date(0),
      ...(opts.unix?.[name] ? { unixPermissions: opts.unix[name] } : {}),
    });
  }
  return await zip.generateAsync({
    type: "nodebuffer",
    compression: opts.compression ?? "DEFLATE",
    platform: opts.unix ? "UNIX" : "DOS",
  });
}

/** Replace every occurrence of `from` with `to` (same length) in the raw zip bytes. */
function patch(buf: Buffer, from: string, to: string): Buffer {
  expect(from.length).toBe(to.length);
  const out = Buffer.from(buf);
  let i = out.indexOf(from);
  expect(i).toBeGreaterThanOrEqual(0);
  while (i >= 0) {
    out.write(to, i, "latin1");
    i = out.indexOf(from, i + 1);
  }
  return out;
}

const reason = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (err) {
    return `${(err as { code?: string }).code}: ${(err as Error).message}`;
  }
  return "accepted";
};

describe("import bundle reader", () => {
  it("reads a plain zip and a plain folder", async () => {
    const files = await readZipBundle(await zipOf({ "a/b.txt": "hello", "c.json": "{}" }));
    expect([...files.keys()].toSorted()).toEqual(["a/b.txt", "c.json"]);
    expect(files.get("a/b.txt")?.toString()).toBe("hello");
    const dir = path.join(tmp, "plain");
    fs.mkdirSync(path.join(dir, "x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "x", "y.md"), "# y");
    const r = await readBundle(dir);
    expect(r.kind).toBe("folder");
    expect([...r.files.keys()]).toEqual(["x/y.md"]);
  });

  it("refuses path traversal and absolute paths in a zip (AC-035)", async () => {
    const zip = await zipOf({ "aa/evil.txt": "x" });
    expect(await reason(readZipBundle(patch(zip, "aa/evil", "../evil")))).toMatch(
      /ARTEFACT_INTEGRITY_FAILED: .*unsafe path/,
    );
    const abs = await zipOf({ "xetc/passwd": "x" });
    expect(await reason(readZipBundle(patch(abs, "xetc/", "/etc/")))).toMatch(/unsafe path/);
    const back = await zipOf({ "a_b.txt": "x" });
    expect(await reason(readZipBundle(patch(back, "a_b", "a\\b")))).toMatch(/unsafe path/);
    for (const n of ["../x", "/x", "a/../b", "a/./b", "C:x", "a\\b", "a//b", ""]) {
      expect(safeEntryName(n), n).toBe(false);
    }
  });

  it("refuses symbolic links, encrypted entries and duplicate names", async () => {
    const link = await zipOf({ link: "/etc/passwd" }, { unix: { link: 0o120777 } });
    expect(await reason(readZipBundle(link))).toMatch(/symbolic link/);
    // Set the encryption flag in the central directory (general purpose bit 0).
    const enc = Buffer.from(await zipOf({ "a.txt": "x" }, { compression: "STORE" }));
    const cd = enc.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
    expect(await reason(readZipBundle(enc))).toMatch(/encrypted/);
    const dup = await zipOf({ "a.txt": "x", "b.txt": "y" });
    expect(await reason(readZipBundle(patch(dup, "b.txt", "a.txt")))).toMatch(/same path twice/);
  });

  it("refuses zip bombs: a high ratio, a total over the limit, a lying size header", async () => {
    const zeros = Buffer.alloc(4 * 1024 * 1024);
    expect(await reason(readZipBundle(await zipOf({ "z.bin": zeros })))).toMatch(/ratio/);
    const limits = { ...DEFAULT_BUNDLE_LIMITS, maxTotalBytes: 1000, maxRatio: 1e9 };
    expect(
      await reason(readZipBundle(await zipOf({ a: "x".repeat(600), b: "y".repeat(600) }), limits)),
    ).toMatch(/extracts to more than 1000/);
    // Declare 10 bytes in the central directory for a 5000-byte entry.
    const lie = Buffer.from(await zipOf({ "a.txt": "q".repeat(5000) }));
    const cd = lie.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    lie.writeUInt32LE(10, cd + 24);
    expect(await reason(readZipBundle(lie))).toMatch(/ARTEFACT_INTEGRITY_FAILED/);
    expect(
      await reason(
        readZipBundle(await zipOf({ a: "1", b: "2", c: "3" }), {
          ...DEFAULT_BUNDLE_LIMITS,
          maxEntries: 2,
        }),
      ),
    ).toMatch(/3 entries/);
  });

  it("refuses a file that is not a zip, a symlinked bundle and symlinks inside a folder", async () => {
    const notZip = path.join(tmp, "x.zip");
    fs.writeFileSync(notZip, "MZ this is an executable");
    expect(await reason(readBundle(notZip))).toMatch(/not a zip/);
    const dir = path.join(tmp, "withlink");
    fs.mkdirSync(dir);
    fs.symlinkSync("/etc/hostname", path.join(dir, "host"));
    expect(await reason(readBundle(dir))).toMatch(/symbolic link/);
    const linked = path.join(tmp, "linked");
    fs.symlinkSync(path.join(tmp, "plain"), linked);
    expect(await reason(readBundle(linked))).toMatch(/symbolic link/);
    expect(await reason(readBundle(path.join(tmp, "absent")))).toMatch(
      /SCHEMA_REJECTED: .*does not exist/,
    );
  });
});
