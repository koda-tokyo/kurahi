// Files trigger watcher: one per Project folder subpath. fs.watch (recursive) when the platform
// offers it, else (or after a watch error) a bounded polling scan of names, sizes and mtimes.
// Changes under the routines' own output folder (output/autopilot), hidden files and editor
// temporaries are ignored. Only "something changed" is signalled (no names leave this module).

import fs from "node:fs";
import path from "node:path";
import { ROUTINE_OUTPUT_DIR } from "../routines.js";

const SCAN_MAX_ENTRIES = 5000;
const SCAN_MAX_DEPTH = 8;

/** Project-relative path (forward slashes) a change must not trigger on. */
export function ignoredFileChange(rel: string): boolean {
  const p = rel.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (p === ROUTINE_OUTPUT_DIR || p.startsWith(`${ROUTINE_OUTPUT_DIR}/`)) {
    return true;
  }
  const base = p.split("/").at(-1) ?? "";
  return (
    p.split("/").some((s) => s.startsWith(".")) ||
    base.startsWith("~$") ||
    base.endsWith("~") ||
    base.endsWith(".tmp") ||
    base.endsWith(".swp") ||
    base.endsWith(".crdownload")
  );
}

export type FilesWatcherOptions = {
  /** Absolute Project folder. */
  projectFolder: string;
  /** Project-relative folder to watch (`.` = the whole folder). */
  folder: string;
  onChange: () => void;
  onHealth: (h: { status: "active" | "degraded"; error: string | null }) => void;
  /** Polling interval (fallback). Default 30 s. */
  pollMs?: number;
  /** Force polling (tests, network drives). */
  mode?: "auto" | "poll";
};

export class FilesWatcher {
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: Map<string, string> | null = null;
  private closed = false;
  readonly dir: string;

  constructor(private readonly opts: FilesWatcherOptions) {
    this.dir =
      opts.folder === "." ? opts.projectFolder : path.join(opts.projectFolder, opts.folder);
  }

  start(): void {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(this.dir);
    } catch {
      this.opts.onHealth({ status: "degraded", error: "folder_missing" });
      return;
    }
    if (!st.isDirectory()) {
      this.opts.onHealth({ status: "degraded", error: "not_a_folder" });
      return;
    }
    if (this.opts.mode !== "poll" && this.tryWatch()) {
      this.opts.onHealth({ status: "active", error: null });
      return;
    }
    this.startPolling();
  }

  private relOf(name: string): string {
    const abs = path.join(this.dir, name);
    return path.relative(this.opts.projectFolder, abs).split(path.sep).join("/");
  }

  private tryWatch(): boolean {
    try {
      const w = fs.watch(this.dir, { recursive: true, persistent: false }, (_event, name) => {
        const rel = name ? this.relOf(String(name)) : null;
        if (rel !== null && ignoredFileChange(rel)) {
          return;
        }
        this.opts.onChange();
      });
      w.on("error", () => {
        // A watch that dies (folder removed, too many watches) falls back to polling.
        w.close();
        if (this.watcher === w && !this.closed) {
          this.watcher = null;
          this.startPolling();
        }
      });
      this.watcher = w;
      return true;
    } catch {
      return false;
    }
  }

  private startPolling(): void {
    this.snapshot = this.scan();
    this.opts.onHealth({ status: "active", error: null });
    const t = setInterval(() => this.poll(), this.opts.pollMs ?? 30_000);
    t.unref?.();
    this.timer = t;
  }

  /** One polling pass (exposed for tests): signals once when anything changed. */
  poll(): boolean {
    if (this.closed) {
      return false;
    }
    const next = this.scan();
    const prev = this.snapshot;
    this.snapshot = next;
    if (!prev) {
      return false;
    }
    let diff = prev.size !== next.size;
    if (!diff) {
      for (const [k, v] of next) {
        if (prev.get(k) !== v) {
          diff = true;
          break;
        }
      }
    }
    if (diff) {
      this.opts.onChange();
    }
    return diff;
  }

  /** Names, sizes and mtimes under the folder (bounded; symlinks are not followed). */
  private scan(): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (abs: string, depth: number) => {
      if (depth > SCAN_MAX_DEPTH || out.size >= SCAN_MAX_ENTRIES) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (out.size >= SCAN_MAX_ENTRIES) {
          return;
        }
        const child = path.join(abs, e.name);
        const rel = path.relative(this.opts.projectFolder, child).split(path.sep).join("/");
        if (ignoredFileChange(rel)) {
          continue;
        }
        if (e.isDirectory()) {
          walk(child, depth + 1);
        } else if (e.isFile()) {
          try {
            const st = fs.lstatSync(child);
            out.set(rel, `${st.size}:${st.mtimeMs}`);
          } catch {
            // vanished between readdir and stat
          }
        }
      }
    };
    walk(this.dir, 0);
    return out;
  }

  get polling(): boolean {
    return this.timer !== null;
  }

  close(): void {
    this.closed = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
