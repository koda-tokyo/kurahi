// Ransomware shield (Kurahi 2.0, M17a): a pure detector over file events. It looks for the three
// signatures ransomware leaves and normal agent work does not:
//
//   1. canary   a decoy file the shield planted is changed or deleted (nothing legitimate does that)
//   2. encrypt  existing text-like files are rewritten into high-entropy content, or replaced by
//               a high-entropy file with an extra extension, many times inside a short window
//   3. note     a file with a ransom-note name appears
//
// Builds, installs and downloads create new files; they do not turn existing text into noise, so
// they do not count. No I/O here: the watcher feeds events and acts on the verdict.
import path from "node:path";

export type ShieldEvent =
  | { kind: "change"; path: string; entropy: number; previousEntropy?: number }
  | { kind: "add"; path: string; entropy: number }
  | { kind: "unlink"; path: string }
  | { kind: "canary"; path: string; what: "changed" | "deleted" };

export type ShieldTrigger = {
  reason: "canary" | "encrypt" | "note";
  detail: string;
  paths: string[];
  at: number;
};

export type ShieldThresholds = {
  /** Suspicious rewrites inside the window that trigger (default 12). */
  rewrites: number;
  /** Sliding window in ms (default 60 s). */
  windowMs: number;
  /** Entropy (bits per byte) at or above which content looks encrypted (default 7.2). */
  highEntropy: number;
  /** Entropy below which content counts as plain text before the rewrite (default 6.0). */
  plainEntropy: number;
};

export const DEFAULT_SHIELD_THRESHOLDS: ShieldThresholds = {
  rewrites: 12,
  windowMs: 60_000,
  highEntropy: 7.2,
  plainEntropy: 6.0,
};

/** Formats that are compressed or encrypted by design: a high-entropy rewrite is normal. */
const NATURALLY_DENSE = new Set([
  ".zip",
  ".gz",
  ".tgz",
  ".bz2",
  ".xz",
  ".zst",
  ".7z",
  ".rar",
  ".jar",
  ".whl",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".heic",
  ".ico",
  ".mp3",
  ".mp4",
  ".m4a",
  ".mov",
  ".webm",
  ".ogg",
  ".opus",
  ".flac",
  ".wav",
  ".pdf",
  ".docx",
  ".xlsx",
  ".pptx",
  ".odt",
  ".ods",
  ".epub",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".wasm",
  ".node",
  ".so",
  ".dylib",
  ".dll",
  ".exe",
  ".gpg",
  ".age",
  ".enc",
  ".kdbx",
  ".pem",
  ".key",
  ".p12",
  ".sqlite",
  ".db",
]);

const RANSOM_NOTE_RE =
  /(?:^|[-_. ])(?:how[-_ ]?to[-_ ]?(?:decrypt|restore|recover)|decrypt(?:ion)?[-_ ]?(?:instructions|files|readme)|restore[-_ ]?(?:my[-_ ]?)?files|recover[-_ ]?(?:your[-_ ]?)?files|readme[-_ ]?(?:to[-_ ]?)?decrypt|ransom)/i;

export function isNaturallyDense(file: string): boolean {
  return NATURALLY_DENSE.has(path.extname(file).toLowerCase());
}

export function looksLikeRansomNote(file: string): boolean {
  const base = path.basename(file);
  return /\.(?:txt|html?|hta|rtf|url)$/i.test(base) && RANSOM_NOTE_RE.test(base);
}

/** Shannon entropy in bits per byte (0..8). */
export function shannonEntropy(buf: Uint8Array): number {
  if (buf.length === 0) {
    return 0;
  }
  const counts = new Uint32Array(256);
  for (const b of buf) {
    counts[b] += 1;
  }
  let h = 0;
  for (const c of counts) {
    if (c > 0) {
      const p = c / buf.length;
      h -= p * Math.log2(p);
    }
  }
  return h;
}

export class ShieldDetector {
  private readonly t: ShieldThresholds;
  private suspicious: Array<{ at: number; path: string }> = [];
  private recentUnlinks = new Map<string, number>();

  constructor(thresholds: Partial<ShieldThresholds> = {}) {
    this.t = { ...DEFAULT_SHIELD_THRESHOLDS, ...thresholds };
  }

  get thresholds(): ShieldThresholds {
    return this.t;
  }

  observe(event: ShieldEvent, now: number = Date.now()): ShieldTrigger | null {
    this.prune(now);
    switch (event.kind) {
      case "canary":
        return {
          reason: "canary",
          detail: `decoy file ${event.what}`,
          paths: [event.path],
          at: now,
        };
      case "unlink":
        this.recentUnlinks.set(event.path, now);
        return null;
      case "add": {
        if (looksLikeRansomNote(event.path)) {
          return {
            reason: "note",
            detail: "ransom-note file created",
            paths: [event.path],
            at: now,
          };
        }
        // `report.docx` deleted, `report.docx.locked` written as noise: the classic swap.
        const original = this.replacedOriginal(event.path);
        if (original && event.entropy >= this.t.highEntropy && !isNaturallyDense(event.path)) {
          return this.count(event.path, now);
        }
        return null;
      }
      case "change": {
        // macOS FSEvents can coalesce create+write into one event that arrives as `change`.
        if (looksLikeRansomNote(event.path)) {
          return {
            reason: "note",
            detail: "ransom-note file written",
            paths: [event.path],
            at: now,
          };
        }
        if (isNaturallyDense(event.path) || event.entropy < this.t.highEntropy) {
          return null;
        }
        const wasPlain =
          event.previousEntropy === undefined
            ? isTextLike(event.path)
            : event.previousEntropy < this.t.plainEntropy;
        return wasPlain ? this.count(event.path, now) : null;
      }
    }
  }

  private replacedOriginal(added: string): string | null {
    const dir = path.dirname(added);
    const base = path.basename(added);
    for (const removed of this.recentUnlinks.keys()) {
      if (path.dirname(removed) === dir) {
        const rb = path.basename(removed);
        if (base.length > rb.length && base.startsWith(`${rb}.`)) {
          return removed;
        }
      }
    }
    return null;
  }

  private count(file: string, now: number): ShieldTrigger | null {
    this.suspicious.push({ at: now, path: file });
    if (this.suspicious.length >= this.t.rewrites) {
      const paths = [...new Set(this.suspicious.map((s) => s.path))];
      this.suspicious = [];
      return {
        reason: "encrypt",
        detail: `${paths.length} files turned into high-entropy content within ${Math.round(this.t.windowMs / 1000)} s`,
        paths: paths.slice(0, 20),
        at: now,
      };
    }
    return null;
  }

  private prune(now: number) {
    const cutoff = now - this.t.windowMs;
    if (this.suspicious.length > 0 && this.suspicious[0].at < cutoff) {
      this.suspicious = this.suspicious.filter((s) => s.at >= cutoff);
    }
    for (const [p, at] of this.recentUnlinks) {
      if (at < cutoff) {
        this.recentUnlinks.delete(p);
      }
    }
  }
}

const TEXT_LIKE = new Set([
  ".txt",
  ".md",
  ".markdown",
  ".csv",
  ".tsv",
  ".json",
  ".jsonl",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".xml",
  ".html",
  ".htm",
  ".css",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".sh",
  ".ps1",
  ".sql",
  ".log",
  ".env",
  ".conf",
  ".cfg",
  ".rtf",
  ".tex",
  ".doc",
  ".xls",
  ".ppt",
]);

/** Used when no earlier sample exists: a rewrite of a text-like file into noise is suspicious. */
export function isTextLike(file: string): boolean {
  return TEXT_LIKE.has(path.extname(file).toLowerCase());
}
