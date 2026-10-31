import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolchainIdentity } from "./types.js";
import {
  checkLocator,
  detectEncoding,
  detectLineEnding,
  diffLiveFolder,
  freezeSnapshot,
  loadSnapshot,
  makeLocator,
  snapshotsDir,
  verifySnapshot,
} from "./snapshot.js";

const TOOLCHAIN: ToolchainIdentity = {
  language: "cobol",
  compiler: "/usr/bin/cobc",
  version: "cobc (GnuCOBOL) 3.1.2.0",
  binarySha256: "0".repeat(64),
  dialect: null,
  flags: [],
};

let tmp: string;
let src: string;
let data: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-snap-"));
  src = path.join(tmp, "src");
  data = path.join(tmp, "data");
  fs.mkdirSync(path.join(src, "copy"), { recursive: true });
  fs.writeFileSync(
    path.join(src, "PAY.cbl"),
    "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PAY.\n       PROCEDURE DIVISION.\n           STOP RUN.\n",
  );
  fs.writeFileSync(path.join(src, "copy", "REC.cpy"), "       01  REC PIC X(10).\r\n");
  fs.mkdirSync(path.join(src, "output"));
  fs.writeFileSync(path.join(src, "output", "ignored.txt"), "x");
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("source snapshots (AC-010)", () => {
  it("records hash, size, encoding and line endings, and the id is stable across freezes", () => {
    const a = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN });
    const b = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN });
    expect(a.id).toMatch(/^snap-[0-9a-f]{64}$/);
    expect(b.id).toBe(a.id);
    expect(b.createdAt).toBe(a.createdAt);
    expect(a.files.map((f) => [f.path, f.encoding, f.lineEnding, f.lines])).toEqual([
      ["PAY.cbl", "ascii", "lf", 4],
      ["copy/REC.cpy", "ascii", "crlf", 1],
    ]);
    expect(a.skipped).toEqual([{ path: "output", reason: "excluded folder" }]);
    expect(verifySnapshot(data, a.id)).toEqual([]);
  });

  it("stores objects read-only and content-addressed; the toolchain is part of the identity", () => {
    const a = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN });
    const obj = path.join(snapshotsDir(data), "objects", a.files[0].sha256);
    expect(fs.statSync(obj).mode & 0o222).toBe(0);
    const other = freezeSnapshot({
      root: src,
      dataDir: data,
      toolchain: { ...TOOLCHAIN, dialect: "ibm" },
    });
    expect(other.id).not.toBe(a.id);
  });

  it("a mutated source gives a new snapshot and leaves the old one intact", () => {
    const a = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN });
    fs.appendFileSync(path.join(src, "PAY.cbl"), "      * changed\n");
    const b = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN, parent: a.id });
    expect(b.id).not.toBe(a.id);
    expect(b.parent).toBe(a.id);
    expect(verifySnapshot(data, a.id)).toEqual([]);
    expect(diffLiveFolder(loadSnapshot(data, a.id), src)).toEqual(["PAY.cbl changed"]);
    expect(diffLiveFolder(b, src)).toEqual([]);
  });

  it("detects a tampered object or manifest", () => {
    const a = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN });
    const obj = path.join(snapshotsDir(data), "objects", a.files[0].sha256);
    fs.chmodSync(obj, 0o600);
    fs.writeFileSync(obj, "tampered");
    expect(verifySnapshot(data, a.id)).toEqual(["PAY.cbl: object altered"]);
    const man = path.join(snapshotsDir(data), `${a.id}.json`);
    fs.chmodSync(man, 0o600);
    fs.writeFileSync(man, fs.readFileSync(man, "utf8").replace('"PAY.cbl"', '"PAX.cbl"'));
    expect(() => loadSnapshot(data, a.id)).toThrow(/altered/);
  });

  it("does not follow symbolic links out of the scope", () => {
    fs.symlinkSync("/etc/hostname", path.join(src, "link.cbl"));
    const a = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN });
    expect(a.files.some((f) => f.path === "link.cbl")).toBe(false);
    expect(a.skipped).toContainEqual({ path: "link.cbl", reason: "symbolic link (not followed)" });
  });
});

describe("source locators (AC-011)", () => {
  it("accepts a locator that matches the frozen excerpt", () => {
    const a = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN });
    const loc = makeLocator(data, a.id, "PAY.cbl", 2, 3);
    expect(checkLocator(data, loc)).toEqual({ ok: true });
    expect(checkLocator(data, loc, { liveRoot: src })).toEqual({ ok: true });
  });

  it("rejects a locator once the live source changed, and one re-pointed at the new snapshot", () => {
    const a = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN });
    const loc = makeLocator(data, a.id, "PAY.cbl", 2, 3);
    fs.writeFileSync(
      path.join(src, "PAY.cbl"),
      "       IDENTIFICATION DIVISION.\n       PROGRAM-ID. PAY2.\n       PROCEDURE DIVISION.\n           STOP RUN.\n",
    );
    const live = checkLocator(data, loc, { liveRoot: src });
    expect(live.ok).toBe(false);
    expect(!live.ok && live.reason).toMatch(/stale: PAY.cbl changed/);
    const b = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN, parent: a.id });
    const moved = checkLocator(data, { ...loc, snapshot: b.id });
    expect(moved.ok).toBe(false);
    expect(!moved.ok && moved.reason).toMatch(/does not match the locator hash/);
  });

  it("rejects out-of-range lines, unknown paths and unknown snapshots", () => {
    const a = freezeSnapshot({ root: src, dataDir: data, toolchain: TOOLCHAIN });
    const loc = makeLocator(data, a.id, "PAY.cbl", 1, 1);
    expect(checkLocator(data, { ...loc, endLine: 99 }).ok).toBe(false);
    expect(checkLocator(data, { ...loc, path: "NOPE.cbl" }).ok).toBe(false);
    expect(checkLocator(data, { ...loc, snapshot: `snap-${"1".repeat(64)}` }).ok).toBe(false);
    expect(() => makeLocator(data, a.id, "PAY.cbl", 3, 2)).toThrow(/outside/);
  });
});

describe("encoding and line-ending detection", () => {
  it("labels what it observes", () => {
    expect(detectEncoding(Buffer.from("abc"))).toBe("ascii");
    expect(detectEncoding(Buffer.from("給与", "utf8"))).toBe("utf-8");
    expect(detectEncoding(Buffer.from([0xc1, 0xc2, 0x40]))).toBe("unknown-8bit");
    expect(detectEncoding(Buffer.from([0x41, 0x00]))).toBe("binary");
    expect(detectLineEnding(Buffer.from("a\nb\n"))).toBe("lf");
    expect(detectLineEnding(Buffer.from("a\r\nb\r\n"))).toBe("crlf");
    expect(detectLineEnding(Buffer.from("a\rb\r"))).toBe("cr");
    expect(detectLineEnding(Buffer.from("a\r\nb\n"))).toBe("mixed");
    expect(detectLineEnding(Buffer.from("ab"))).toBe("none");
  });
});
