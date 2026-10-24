import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KoLoConfig } from "../config/config.js";
import { resetPrivateOverlayCache } from "../infra/private-overlay.js";
import { EMPTY_LOCK_GRACE_MS } from "../infra/refresh-lock.js";
import { startOAuthRefresher } from "./oauth-refresher.js";
import { resolveOAuthRefreshTargets, resolveTargetLockPath } from "./oauth-sources.js";

const cfg: KoLoConfig = { agents: { list: [{ id: "alice", default: true }] } };

describe("gateway OAuth refresher", () => {
  let home: string;
  let overlayDir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-oauth-refresher-"));
    overlayDir = path.join(home, "overlay-empty");
    fs.mkdirSync(overlayDir);
    for (const k of ["KOLO_HOME", "KOLO_STATE_DIR", "KOLO_OVERLAY_DIR"]) {
      saved[k] = process.env[k];
    }
    process.env.KOLO_HOME = home;
    process.env.KOLO_STATE_DIR = home;
    // A directory without hooks: the worktree's own private/overlay must not reach the test.
    process.env.KOLO_OVERLAY_DIR = overlayDir;
    resetPrivateOverlayCache();
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
    resetPrivateOverlayCache();
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does not start and does not log when nothing is configured", () => {
    const setIntervalSpy = vi.fn();
    const handle = startOAuthRefresher({
      cfg,
      setInterval: setIntervalSpy as unknown as typeof setInterval,
    });
    expect(handle.started).toBe(false);
    expect(handle.targets).toHaveLength(0);
    expect(handle.reason).toMatch(/nothing|no OAuth/i);
    expect(setIntervalSpy).not.toHaveBeenCalled();
    // No lock, no run dir, nothing written for a refresher that did not start.
    expect(fs.existsSync(path.join(home, "run"))).toBe(false);
  });

  it("finds OAuth-kind profiles under KOLO_HOME and nothing else", () => {
    const agentDir = path.join(home, "agents", "alice", "agent");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, "auth-profiles.json"),
      JSON.stringify({
        version: 1,
        profiles: {
          "acme:key": { type: "api_key", provider: "acme", key: "k" },
          "acme:oauth": {
            type: "oauth",
            provider: "acme",
            access: "a",
            refresh: "r",
            expires: Date.now() + 3_600_000,
          },
        },
      }),
    );
    const targets = resolveOAuthRefreshTargets(cfg);
    expect(targets.map((t) => t.id)).toEqual(["profile:acme:oauth"]);
    expect(resolveTargetLockPath(targets[0])).toBe(
      path.join(home, "run", "oauth-refresh-profile_acme_oauth.lock"),
    );
  });

  it("refreshes each target under its lock and releases the lock afterwards", async () => {
    const refresh = vi.fn(async () => ({ ok: true, refreshed: true, expiresAt: Date.now() + 1 }));
    const timers: Array<() => void> = [];
    const handle = startOAuthRefresher({
      cfg,
      targets: [{ id: "t1", provider: "acme", refresh }],
      setInterval: ((fn: () => void) => {
        timers.push(fn);
        return { unref() {} };
      }) as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
    });
    expect(handle.started).toBe(true);
    expect(timers).toHaveLength(1);
    const results = await handle.initial;
    expect(results.get("t1")).toMatchObject({ ok: true, refreshed: true });
    expect(refresh).toHaveBeenCalledWith({ minValidMs: 5 * 60_000 });
    expect((await handle.tick()).get("t1")).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(home, "run", "oauth-refresh-t1.lock"))).toBe(false);
    handle.stop();
  });

  it("skips a target whose lock another process holds", async () => {
    const refresh = vi.fn(async () => ({ ok: true, refreshed: false }));
    const lockPath = path.join(home, "run", "held.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, `${process.pid}:${Date.now()}`);
    const handle = startOAuthRefresher({
      cfg,
      targets: [{ id: "held", provider: "acme", refresh, lockPath }],
      setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
    });
    await handle.initial;
    const results = await handle.tick();
    expect(results.get("held")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    // A fresh empty lock may be mid-write: it still blocks.
    fs.writeFileSync(lockPath, "");
    await handle.tick();
    expect(refresh).not.toHaveBeenCalled();
    // An old empty lock (what the old release left behind) no longer blocks.
    const old = new Date(Date.now() - EMPTY_LOCK_GRACE_MS - 5_000);
    fs.utimesSync(lockPath, old, old);
    await handle.tick();
    expect(refresh).toHaveBeenCalledTimes(1);
    handle.stop();
  });

  it("backs off after a failed refresh", async () => {
    let now = 1_000_000;
    const refresh = vi.fn(async () => ({ ok: false, refreshed: false, error: "boom" }));
    const handle = startOAuthRefresher({
      cfg,
      targets: [{ id: "flaky", provider: "acme", refresh }],
      now: () => now,
      setInterval: (() => ({ unref() {} })) as unknown as typeof setInterval,
      clearInterval: (() => {}) as unknown as typeof clearInterval,
    });
    await handle.initial;
    await handle.tick();
    expect(refresh).toHaveBeenCalledTimes(1);
    now += 5 * 60_000 + 1;
    await handle.tick();
    expect(refresh).toHaveBeenCalledTimes(2);
    handle.stop();
  });

  it("takes sources from the oauth-sources overlay", () => {
    const dir = path.join(home, "overlay");
    fs.mkdirSync(dir);
    fs.writeFileSync(
      path.join(dir, "oauth-sources.cjs"),
      `module.exports = { listSources: (ctx) => [{ id: "ext", provider: "acme", lockPath: ctx.koloHome + "/ext.lock", refresh: async () => ({ ok: true, refreshed: false }) }] };`,
    );
    process.env.KOLO_OVERLAY_DIR = dir;
    resetPrivateOverlayCache();
    const targets = resolveOAuthRefreshTargets(cfg);
    expect(targets.map((t) => t.id)).toEqual(["ext"]);
    expect(resolveTargetLockPath(targets[0])).toBe(`${home}/ext.lock`);
  });
});
