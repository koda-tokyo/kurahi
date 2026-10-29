import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { FileScanner, ScanVerdict } from "../security/scanner.js";
import {
  infectedFileFacts,
  isInside,
  quarantineFile,
  scanIndexPath,
  scanShares,
  stampOf,
} from "./scan.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-guardian-scan-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let seq = 0;

/** A fresh KOLO_HOME and share with the given files (relative path → content). */
function setup(files: Record<string, string>): { home: string; share: string } {
  const base = path.join(root, `case${++seq}`);
  const home = path.join(base, "home");
  const share = path.join(base, "share");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(share, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(share, rel)), { recursive: true });
    fs.writeFileSync(path.join(share, rel), body);
  }
  return { home, share };
}

/** A scanner that calls files containing "EICAR" infected and files containing "BOOM" errors. */
function fakeScanner(name: FileScanner["name"] = "clamav"): FileScanner & { seen: string[] } {
  const seen: string[] = [];
  return {
    name,
    seen,
    async scan(file): Promise<ScanVerdict> {
      seen.push(file);
      const body = fs.readFileSync(file, "utf8");
      const base = { scanner: name, ms: 0, signature: null, detail: null };
      if (body.includes("EICAR")) {
        return { ...base, verdict: "infected", signature: "Test.EICAR" };
      }
      if (body.includes("BOOM")) {
        return { ...base, verdict: "error", detail: "engine exit 2" };
      }
      return { ...base, verdict: "clean" };
    },
  };
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

describe("guardian share scan", () => {
  it("scans every file, quarantines a hashed copy with a sidecar, keeps the original", async () => {
    const { home, share } = setup({ "a.txt": "hello", "sub/bad.exe": "xx EICAR xx" });
    const scanner = fakeScanner();
    const r = await scanShares({ shares: [share], scanner, home });
    expect(r).toMatchObject({ scanner: "clamav", scanned: 2, skipped: 0, truncated: false });
    expect(r.errors).toEqual([]);
    expect(r.infected).toHaveLength(1);
    const hit = r.infected[0];
    expect(hit).toMatchObject({
      path: path.join(share, "sub", "bad.exe"),
      sha256: sha("xx EICAR xx"),
      signature: "Test.EICAR",
      movedTo: null,
    });
    const qDir = path.join(home, "guardian", "quarantine");
    expect(hit.quarantined).toBe(path.join(qDir, sha("xx EICAR xx")));
    expect(fs.readFileSync(hit.quarantined!, "utf8")).toBe("xx EICAR xx");
    expect(fs.existsSync(path.join(share, "sub", "bad.exe"))).toBe(true);
    const sidecar = JSON.parse(
      fs.readFileSync(path.join(qDir, `${sha("xx EICAR xx")}.json`), "utf8"),
    );
    expect(sidecar).toMatchObject({ sha256: sha("xx EICAR xx"), size: 11 });
    expect(sidecar.sightings[0]).toMatchObject({
      originalPath: path.join(share, "sub", "bad.exe"),
      scanner: "clamav",
      verdict: "infected",
      signature: "Test.EICAR",
    });
  });

  it("skips files unchanged since the same engine found them clean; rescans infected and changed", async () => {
    const { home, share } = setup({ "a.txt": "hello", "b.txt": "EICAR" });
    await scanShares({ shares: [share], scanner: fakeScanner(), home });
    expect(fs.existsSync(scanIndexPath(home))).toBe(true);

    const second = fakeScanner();
    const r2 = await scanShares({ shares: [share], scanner: second, home });
    expect(r2).toMatchObject({ scanned: 1, skipped: 1 });
    expect(second.seen).toEqual([path.join(share, "b.txt")]);

    fs.writeFileSync(path.join(share, "a.txt"), "hello again");
    const third = fakeScanner();
    await scanShares({ shares: [share], scanner: third, home });
    expect(third.seen).toContain(path.join(share, "a.txt"));

    // Another engine does not trust the first engine's clean verdicts.
    const other = fakeScanner("defender");
    const r4 = await scanShares({ shares: [share], scanner: other, home });
    expect(r4.skipped).toBe(0);
  });

  it("an engine error is an error entry, never clean, and is scanned again next run", async () => {
    const { home, share } = setup({ "x.bin": "BOOM" });
    const r = await scanShares({ shares: [share], scanner: fakeScanner(), home });
    expect(r.errors).toEqual([{ path: path.join(share, "x.bin"), detail: "engine exit 2" }]);
    const again = fakeScanner();
    await scanShares({ shares: [share], scanner: again, home });
    expect(again.seen).toHaveLength(1);
  });

  it("move mode renames the original into quarantine and never deletes it", async () => {
    const { home, share } = setup({ "bad.doc": "EICAR" });
    const r = await scanShares({
      shares: [share],
      scanner: fakeScanner(),
      home,
      quarantine: { mode: "move" },
    });
    const hit = r.infected[0];
    expect(fs.existsSync(path.join(share, "bad.doc"))).toBe(false);
    expect(hit.movedTo).toMatch(/\.original$/);
    expect(fs.readFileSync(hit.movedTo!, "utf8")).toBe("EICAR");
    expect(fs.readFileSync(hit.quarantined!, "utf8")).toBe("EICAR");
  });

  it("uses a configured quarantine folder inside the share without rescanning it", async () => {
    const { home, share } = setup({ "bad.doc": "EICAR" });
    const qDir = path.join(share, ".quarantine");
    await scanShares({ shares: [share], scanner: fakeScanner(), home, quarantine: { dir: qDir } });
    expect(fs.readdirSync(qDir)).toContain(sha("EICAR"));
    fs.writeFileSync(path.join(share, "bad.doc"), "EICAR!"); // changed: scanned again
    const s = fakeScanner();
    await scanShares({ shares: [share], scanner: s, home, quarantine: { dir: qDir } });
    expect(s.seen.every((f) => !f.startsWith(qDir))).toBe(true);
  });

  it("follows file links inside the share; a link out of it is an error, a folder link is skipped", async () => {
    const { home, share } = setup({ "real.txt": "ok" });
    const outside = path.join(path.dirname(share), "outside.txt");
    fs.writeFileSync(outside, "EICAR");
    try {
      fs.symlinkSync(outside, path.join(share, "escape.lnk"));
      fs.symlinkSync(path.join(share, "real.txt"), path.join(share, "inside.lnk"));
      fs.symlinkSync(share, path.join(share, "dirlink"));
    } catch {
      return; // no symlink privilege (Windows without developer mode)
    }
    const s = fakeScanner();
    const r = await scanShares({ shares: [share], scanner: s, home });
    expect(r.symlinksSkipped).toBe(1);
    expect(r.errors).toEqual([
      {
        path: path.join(share, "escape.lnk"),
        detail: "symlink points outside the share; not scanned",
      },
    ]);
    expect(r.infected).toEqual([]);
    expect(s.seen.toSorted()).toEqual(
      [path.join(share, "inside.lnk"), path.join(share, "real.txt")].toSorted(),
    );
  });

  it("stops at maxFiles and maxBytes and says so", async () => {
    const { home, share } = setup({ "1": "aaaa", "2": "bbbb", "3": "cccc" });
    const byFiles = await scanShares({
      shares: [share],
      scanner: fakeScanner(),
      home,
      maxFiles: 2,
    });
    expect(byFiles).toMatchObject({ scanned: 2, truncated: true, truncatedBy: "maxFiles" });
    const h2 = setup({ "1": "aaaa", "2": "bbbb" });
    const byBytes = await scanShares({
      shares: [h2.share],
      scanner: fakeScanner(),
      home: h2.home,
      maxBytes: 6,
    });
    expect(byBytes).toMatchObject({ scanned: 1, truncated: true, truncatedBy: "maxBytes" });
  });

  it("stops at the whole-run deadline", async () => {
    const { home, share } = setup({ "1": "a", "2": "b" });
    let t = 0;
    const r = await scanShares({
      shares: [share],
      scanner: fakeScanner(),
      home,
      deadlineMs: 10,
      now: () => (t += 20),
    });
    expect(r).toMatchObject({ truncated: true, truncatedBy: "deadline", scanned: 0 });
  });

  it("fails closed with no engine, no shares, a missing share or a relative path", async () => {
    const { home, share } = setup({ a: "x" });
    const none: FileScanner = {
      name: "none",
      scan: async () => ({
        verdict: "unscanned",
        scanner: "none",
        signature: null,
        detail: null,
        ms: 0,
      }),
    };
    expect((await scanShares({ shares: [share], scanner: none, home })).errorCount).toBe(1);
    expect((await scanShares({ shares: [], scanner: fakeScanner(), home })).errorCount).toBe(1);
    const r = await scanShares({
      shares: [path.join(share, "missing"), "relative/share"],
      scanner: fakeScanner(),
      home,
    });
    expect(r.errors.map((e) => e.detail)).toEqual([
      expect.stringMatching(/share unreadable/),
      "share path is not absolute",
    ]);
  });

  it("refuses to run beside another scan of the same home", async () => {
    const { home, share } = setup({ a: "x" });
    fs.mkdirSync(path.join(home, "guardian"), { recursive: true });
    fs.writeFileSync(path.join(home, "guardian", "scan.lock"), "{}");
    const r = await scanShares({ shares: [share], scanner: fakeScanner(), home });
    expect(r.errors[0].detail).toBe("another share scan is running");
    expect(r.scanned).toBe(0);
  });

  it("a file over the remaining byte budget is passed over, not a stop; one over maxBytes is an error", async () => {
    const { home, share } = setup({ "a-big": "x".repeat(50), "b-mid": "y".repeat(8), c: "z" });
    const s = fakeScanner();
    const r = await scanShares({ shares: [share], scanner: s, home, maxBytes: 10 });
    expect(s.seen).toEqual([path.join(share, "b-mid"), path.join(share, "c")]);
    expect(r.errors).toEqual([
      { path: path.join(share, "a-big"), detail: "too large to scan (50 bytes; maxBytes 10)" },
    ]);
    expect(r.truncated).toBe(false);

    // Tonight only one of two medium files fits; tomorrow the other one is reached.
    const h = setup({ m1: "1".repeat(6), m2: "2".repeat(6) });
    const n1 = fakeScanner();
    const r1 = await scanShares({ shares: [h.share], scanner: n1, home: h.home, maxBytes: 10 });
    expect(r1).toMatchObject({ scanned: 1, truncated: true, truncatedBy: "maxBytes" });
    const n2 = fakeScanner();
    const r2 = await scanShares({ shares: [h.share], scanner: n2, home: h.home, maxBytes: 10 });
    expect(n2.seen).toEqual([path.join(h.share, "m2")]);
    expect(r2).toMatchObject({ scanned: 1, skipped: 1, truncated: false });
  });

  it("rescans a same-size swap whose mtime was set back (ctime and inode differ)", async () => {
    const { home, share } = setup({ "doc.txt": "clean-01" });
    const file = path.join(share, "doc.txt");
    await scanShares({ shares: [share], scanner: fakeScanner(), home });
    const before = fs.statSync(file);
    fs.rmSync(file);
    fs.writeFileSync(file, "EICAR-01");
    fs.utimesSync(file, before.atime, before.mtime);
    const s = fakeScanner();
    const r = await scanShares({ shares: [share], scanner: s, home });
    expect(s.seen).toEqual([file]);
    expect(r.infected).toHaveLength(1);
  });

  it("move mode never moves a symlink (it would move the link, not the file)", async () => {
    const { home, share } = setup({ "real.bin": "EICAR" });
    try {
      fs.symlinkSync(path.join(share, "real.bin"), path.join(share, "alias.lnk"));
    } catch {
      return;
    }
    const r = await scanShares({
      shares: [share],
      scanner: fakeScanner(),
      home,
      quarantine: { mode: "move" },
    });
    const viaLink = r.infected.find((f) => f.path.endsWith("alias.lnk"))!;
    expect(viaLink.movedTo).toBeNull();
    expect(viaLink.quarantined).not.toBeNull();
    expect(r.errors.map((e) => e.detail)).toContain(
      "original not moved: it is a symlink (a copy of its target is kept)",
    );
  });

  it("refuses to quarantine a file that changed after it was scanned", async () => {
    const { home, share } = setup({ "bad.bin": "EICAR" });
    const file = path.join(share, "bad.bin");
    const scanned = stampOf(fs.statSync(file));
    fs.writeFileSync(file, "EICAR plus more");
    const dir = path.join(home, "guardian", "quarantine");
    await expect(
      quarantineFile({
        file,
        dir,
        mode: "copy",
        scanner: "clamav",
        signature: "Test.EICAR",
        now: new Date(),
        expect: scanned,
      }),
    ).rejects.toThrow(/changed after it was scanned/);
    expect(fs.existsSync(dir) ? fs.readdirSync(dir) : []).toEqual([]);
  });

  it("isInside: `..name` is inside, `..` and `../x` are not", () => {
    const p = path.resolve("/srv/share");
    expect(isInside(p, path.join(p, "..data"))).toBe(true);
    expect(isInside(p, p)).toBe(true);
    expect(isInside(p, path.dirname(p))).toBe(false);
    expect(isInside(p, path.join(path.dirname(p), "other"))).toBe(false);
  });

  it("infected file facts carry the full hash, signature and quarantine copy, never the share path", async () => {
    const { home, share } = setup({ "secret-plan.exe": "EICAR" });
    const r = await scanShares({ shares: [share], scanner: fakeScanner(), home });
    const facts = infectedFileFacts(r.infected, 10);
    expect(facts).toEqual({
      infected1Sha256: sha("EICAR"),
      infected1Signature: "Test.EICAR",
      infected1Quarantine: path.join(home, "guardian", "quarantine", sha("EICAR")),
    });
    expect(JSON.stringify(facts)).not.toContain("secret-plan");
    expect(Object.keys(infectedFileFacts([...r.infected, ...r.infected], 1))).toHaveLength(3);
  });
});
