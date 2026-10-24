import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMPTY_LOCK_GRACE_MS,
  acquireRefreshLock,
  isRefreshLockStale,
  parseRefreshLock,
  releaseRefreshLock,
  withRefreshLock,
} from "./refresh-lock.js";

const alive = () => true;

describe("refresh lock", () => {
  let dir: string;
  let lockPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-refresh-lock-"));
    lockPath = path.join(dir, "run", "oauth-refresh.lock");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("acquires a fresh lock, creating the run directory, and release unlinks it", () => {
    expect(acquireRefreshLock(lockPath, { pid: 42, now: () => 1_000, isPidAlive: alive })).toBe(
      true,
    );
    expect(fs.readFileSync(lockPath, "utf8")).toMatch(/^42:1000:[0-9a-f]{16}$/);
    releaseRefreshLock(lockPath);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("blocks while another live process holds a recent lock", () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "7:5000");
    expect(
      acquireRefreshLock(lockPath, {
        pid: 8,
        now: () => 6_000,
        timeoutMs: 30_000,
        isPidAlive: alive,
      }),
    ).toBe(false);
    expect(fs.readFileSync(lockPath, "utf8")).toBe("7:5000");
  });

  const writeAged = (content: string, ageMs: number) => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, content);
    const at = new Date(Date.now() - ageMs);
    fs.utimesSync(lockPath, at, at);
  };

  it('takes over an old empty lock file (the old release wrote "")', () => {
    writeAged("", EMPTY_LOCK_GRACE_MS + 5_000);
    expect(acquireRefreshLock(lockPath, { pid: 9, isPidAlive: alive })).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toMatch(/^9:\d+:/);
  });

  it("takes over an old unparseable lock", () => {
    writeAged("garbage", EMPTY_LOCK_GRACE_MS + 5_000);
    expect(acquireRefreshLock(lockPath, { pid: 9, isPidAlive: alive })).toBe(true);
  });

  it("never takes over a fresh empty or unparseable lock: it may be mid-write", () => {
    for (const content of ["", "7:"]) {
      writeAged(content, 0);
      const opts = { pid: 9, isPidAlive: alive, timeoutMs: Infinity };
      expect(acquireRefreshLock(lockPath, opts)).toBe(false);
      expect(fs.readFileSync(lockPath, "utf8")).toBe(content);
    }
  });

  it("the lock is never visible without its token, so a racing acquirer cannot take it", () => {
    // Review interleaving against fd5c: pause the first acquirer inside its create step and run a
    // second acquire there. With O_EXCL create-then-write the second saw an empty file, took it
    // over, and both returned true.
    const realLink = fs.linkSync.bind(fs);
    const seen: string[] = [];
    let second: boolean | undefined;
    vi.spyOn(fs, "linkSync").mockImplementation((src, dest) => {
      if (second === undefined && dest === lockPath) {
        second = false;
        // Before the link: no lock file at all, not an empty one.
        seen.push(String(fs.existsSync(lockPath)));
        realLink(src, dest);
        // After the link: the whole token is already there.
        seen.push(fs.readFileSync(lockPath, "utf8"));
        second = acquireRefreshLock(lockPath, { pid: 2, isPidAlive: alive, timeoutMs: Infinity });
        return;
      }
      realLink(src, dest);
    });
    const first = acquireRefreshLock(lockPath, { pid: 1, isPidAlive: alive, timeoutMs: Infinity });
    expect(seen[0]).toBe("false");
    expect(seen[1]).toMatch(/^1:\d+:[0-9a-f]{16}$/);
    expect([first, second]).toEqual([true, false]);
    expect(fs.readFileSync(lockPath, "utf8")).toBe(seen[1]);
    expect(fs.readdirSync(path.dirname(lockPath))).toEqual(["oauth-refresh.lock"]);
  });

  it("takes over a lock older than the timeout", () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "7:1000");
    expect(
      acquireRefreshLock(lockPath, {
        pid: 9,
        now: () => 1000 + 30_001,
        timeoutMs: 30_000,
        isPidAlive: alive,
      }),
    ).toBe(true);
  });

  it("takes over a lock whose holder is gone", () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "7:1000");
    expect(
      acquireRefreshLock(lockPath, {
        pid: 9,
        now: () => 1001,
        timeoutMs: 30_000,
        isPidAlive: () => false,
      }),
    ).toBe(true);
  });

  it("a second refresh after a release is not blocked", async () => {
    const opts = { isPidAlive: alive };
    expect(await withRefreshLock(lockPath, async () => "first", opts)).toBe("first");
    expect(await withRefreshLock(lockPath, async () => "second", opts)).toBe("second");
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it("withRefreshLock returns null when the lock is held", async () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}`);
    expect(await withRefreshLock(lockPath, async () => "ran")).toBeNull();
  });

  it("parse and staleness helpers", () => {
    expect(parseRefreshLock("")).toBeNull();
    expect(parseRefreshLock("x:y")).toBeNull();
    expect(parseRefreshLock("12:34")).toEqual({ pid: 12, timestamp: 34 });
    expect(isRefreshLockStale("", { isPidAlive: alive })).toBe(false);
    expect(isRefreshLockStale("", { now: () => 40_000, isPidAlive: alive }, 1_000)).toBe(true);
    expect(isRefreshLockStale("", { now: () => 2_000, isPidAlive: alive }, 1_000)).toBe(false);
    expect(isRefreshLockStale("12:34", { now: () => 35, isPidAlive: alive })).toBe(false);
  });

  it("release by a holder that was taken over leaves its successor's lock", () => {
    expect(acquireRefreshLock(lockPath, { pid: 42, now: () => 1_000, isPidAlive: alive })).toBe(
      true,
    );
    // Another process took it over after the timeout while the first holder was still running.
    const successor = "43:1000000:feedfacefeedface";
    fs.unlinkSync(lockPath);
    fs.writeFileSync(lockPath, successor);
    releaseRefreshLock(lockPath); // the first holder's release
    expect(fs.readFileSync(lockPath, "utf8")).toBe(successor);
    releaseRefreshLock(lockPath); // nothing held any more
    expect(fs.readFileSync(lockPath, "utf8")).toBe(successor);
  });

  it("an infinite timeout never takes over a live holder, however old its lock", () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "7:1:aaaaaaaaaaaaaaaa");
    const opts = { pid: 9, now: () => 10 ** 13, isPidAlive: alive, timeoutMs: Infinity };
    expect(acquireRefreshLock(lockPath, opts)).toBe(false);
    expect(acquireRefreshLock(lockPath, { ...opts, isPidAlive: (p) => p !== 7 })).toBe(true);
  });

  it("recovers when a reaper died holding the reaper lock", () => {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const stale = "7:5000:bbbbbbbbbbbbbbbb";
    fs.writeFileSync(lockPath, stale);
    const dead = (p: number) => p !== 7 && p !== 8;
    // Reaper pid 8 took the reaper lock for this content, then died before removing the stale lock.
    const digest = createHash("sha256").update(stale).digest("hex").slice(0, 16);
    fs.writeFileSync(`${lockPath}.reap-${digest}`, "8:6000:cccccccccccccccc");
    expect(acquireRefreshLock(lockPath, { pid: 9, now: () => 7_000, isPidAlive: dead })).toBe(true);
    expect(fs.readFileSync(lockPath, "utf8")).toMatch(/^9:7000:/);
    expect(fs.readdirSync(path.dirname(lockPath))).toEqual(["oauth-refresh.lock"]);
  });

  it("exactly one of several processes takes over the same stale lock", async () => {
    const modulePath = fileURLToPath(new URL("./refresh-lock.ts", import.meta.url));
    const tsx = path.resolve(path.dirname(modulePath), "../../node_modules/tsx/dist/esm/index.mjs");
    const script = (goAt: number) => `
      import { acquireRefreshLock } from ${JSON.stringify(pathToFileURL(modulePath).href)};
      while (Date.now() < ${goAt}) {}
      const got = acquireRefreshLock(${JSON.stringify(lockPath)}, { timeoutMs: Infinity });
      process.stdout.write(got ? "1" : "0");
      if (got) await new Promise((r) => setTimeout(r, 300));
    `;
    const run = (code: string) =>
      new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [
          "--import",
          pathToFileURL(tsx).href,
          "--input-type=module",
          "-e",
          code,
        ]);
        let out = "";
        child.stdout.on("data", (d) => (out += String(d)));
        child.on("error", reject);
        child.on("exit", () => resolve(out));
      });
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    for (let round = 0; round < 3; round++) {
      // A lock left by a pid that no longer exists (max pid is far below this).
      fs.writeFileSync(lockPath, `99999999:${Date.now()}:${round}`);
      const code = script(Date.now() + 3_000);
      const outs = await Promise.all(Array.from({ length: 8 }, () => run(code)));
      expect(outs.toSorted()).toEqual(["0", "0", "0", "0", "0", "0", "0", "1"]);
      expect(fs.readdirSync(path.dirname(lockPath))).toEqual(["oauth-refresh.lock"]);
    }
  }, 60_000);
});
