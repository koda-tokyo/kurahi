// A gateway started with KOLO_HOME writes nothing outside it. HOME, USERPROFILE, LOCALAPPDATA,
// the XDG dirs, the working directory and the temp dir all point at fresh empty directories
// next to KOLO_HOME; after a full boot (health 200) and a clean stop, every one of them must
// still be empty while KOLO_HOME holds the state the run created.
//
// The gateway runs as a child process from the TypeScript sources (tsx) so module-level path
// constants are computed in the isolated environment, not in the test worker.

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = path.join(ROOT, "src", "entry.ts");
// Resolved here: the child runs from a directory with no node_modules, so a bare "tsx" would
// not be found.
const TSX_LOADER = import.meta.resolve("tsx");
// The tsx cache lives under the temp dir, and the temp dir must start empty, so every run
// compiles the whole gateway cold: about two minutes on an idle 10-core host and well over
// 200 s when the rest of the gateway suite runs beside it. The deadline is generous on purpose;
// a gateway that really hangs still fails, it just takes longer to say so.
const BOOT_DEADLINE_MS = 420_000;
const TEST_TIMEOUT_MS = 480_000;
// Caches the TypeScript loaders keep under the temp dir; not the product's doing.
const LOADER_TMP = /^(tsx-[^/\\]+|jiti)([/\\]|$)/; // tsx-<uid> on POSIX, tsx-<username> on Windows

function listTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      out.push(relPath);
      if (entry.isDirectory()) {
        walk(path.join(current, entry.name), relPath);
      }
    }
  };
  walk(dir, "");
  return out.toSorted();
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitHealth(
  port: number,
  child: ChildProcess,
  deadline: number,
  tail: () => string,
): Promise<void> {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`gateway exited early with code ${child.exitCode}\n${tail()}`);
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(2_000),
      });
      if (res.ok) {
        return;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`gateway did not answer /health before the deadline\n${tail()}`);
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    child.once("exit", () => {
      clearTimeout(killTimer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

describe("KOLO_HOME isolation", () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "kolo-isolation-"));
  const koloHome = path.join(base, "kolo-home");
  const fakeHome = path.join(base, "fake-home");
  const fakeCwd = path.join(base, "cwd");
  const fakeTmp = path.join(base, "tmp");
  const emptyOverlay = path.join(base, "overlay");
  const outside = [fakeHome, fakeCwd, fakeTmp];
  let logText = "";

  beforeAll(() => {
    for (const dir of [koloHome, fakeHome, fakeCwd, fakeTmp, emptyOverlay]) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  });

  afterAll(() => {
    // Windows: the gateway child can still hold its cwd for a moment after it exits (EBUSY).
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  });

  it(
    "boots, serves /health and leaves HOME, cwd and the temp dir untouched",
    async () => {
      const port = await freePort();
      const token = randomBytes(24).toString("hex");
      fs.mkdirSync(path.join(koloHome, "secrets"), { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(koloHome, "secrets", "gateway.token"), `${token}\n`, {
        mode: 0o600,
      });
      fs.writeFileSync(
        path.join(koloHome, "kolo.json"),
        `${JSON.stringify(
          {
            gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token" } },
            agents: { list: [{ id: "alice", default: true }] },
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );

      const env: Record<string, string> = {};
      // Strip the test harness: the child must behave like a real gateway (canvas host on,
      // sentinels on), not like a module under vitest.
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !/^(KOLO|CLAWDBOT|XDG|VITEST)/.test(k) && k !== "NODE_ENV") {
          env[k] = v;
        }
      }
      Object.assign(env, {
        HOME: fakeHome,
        USERPROFILE: fakeHome,
        LOCALAPPDATA: path.join(fakeHome, "AppData", "Local"),
        APPDATA: path.join(fakeHome, "AppData", "Roaming"),
        XDG_CONFIG_HOME: path.join(fakeHome, ".config"),
        XDG_DATA_HOME: path.join(fakeHome, ".local", "share"),
        XDG_STATE_HOME: path.join(fakeHome, ".local", "state"),
        XDG_CACHE_HOME: path.join(fakeHome, ".cache"),
        TMPDIR: fakeTmp,
        TEMP: fakeTmp,
        TMP: fakeTmp,
        KOLO_HOME: koloHome,
        KOLO_GATEWAY_TOKEN: token,
        KOLO_SKIP_CHANNELS: "1",
        KOLO_OVERLAY_DIR: emptyOverlay,
        NO_COLOR: "1",
      });

      const before = outside.map((dir) => listTree(dir));
      expect(before.every((entries) => entries.length === 0)).toBe(true);

      const child = spawn(
        process.execPath,
        ["--import", TSX_LOADER, ENTRY, "gateway", "--port", String(port)],
        { cwd: fakeCwd, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );
      child.stdout?.on("data", (chunk: Buffer) => {
        logText += chunk.toString();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        logText += chunk.toString();
      });
      try {
        await waitHealth(port, child, Date.now() + BOOT_DEADLINE_MS, () => logText.slice(-3000));
      } finally {
        await stop(child);
      }

      // The run did create state, and all of it is under KOLO_HOME.
      const inside = listTree(koloHome);
      expect(inside.length).toBeGreaterThan(2);
      const after = outside.map((dir) =>
        dir === fakeTmp ? listTree(dir).filter((entry) => !LOADER_TMP.test(entry)) : listTree(dir),
      );
      const leaked = outside
        .map((dir, i) => ({ dir, entries: after[i] ?? [] }))
        .filter(({ entries }) => entries.length > 0);
      expect(
        leaked,
        `files created outside KOLO_HOME:\n${leaked
          .map(({ dir, entries }) => `${dir}:\n  ${entries.join("\n  ")}`)
          .join("\n")}\n--- gateway log tail ---\n${logText.slice(-3000)}`,
      ).toEqual([]);
      // A gateway with no OAuth profiles configured has no refresher and says nothing about one.
      expect(logText).not.toMatch(/OAuth refresher started/);
    },
    TEST_TIMEOUT_MS,
  );
});
