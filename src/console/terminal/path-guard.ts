// Path guard for the console terminal: every path a command line names must resolve inside the
// session's project root, `cd` included. Resolution is lexical first (`..`, absolute paths,
// `~` = the project root, which is the shell's HOME) and then through symlinks for whatever
// already exists, so a link inside the project that points outside is refused too.
//
// Limits (docs/security/terminal-broker.md): the guard sees the words of the line. A program can
// still open paths it computes itself (a script, a Makefile, `find` output piped to `xargs`),
// which is why those lines are never read-only and act-mode approval stays on, and why the
// container sandbox is the real boundary.

import fs from "node:fs";
import path from "node:path";
import { excludedPathRegexes } from "../../projects/store.js";
import { SHELLS } from "./command-tables.js";
import { basenameOf, parseShellLine, type ShellWord } from "./shell-words.js";

export type PathGuardResult =
  | { ok: true; cwdAfter: string | null }
  | { ok: false; code: "path-escape" | "unverifiable-path" };

/** Device files any command may name. */
const ALLOWED_DEVICES = new Set([
  "/dev/null",
  "/dev/zero",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/urandom",
  "/dev/random",
]);
/** Absolute program paths allowed as the command word (system binaries). */
const SYSTEM_BIN_DIRS = new Set([
  "/bin",
  "/sbin",
  "/usr/bin",
  "/usr/sbin",
  "/usr/local/bin",
  "/opt/homebrew/bin",
]);
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const REMOTE_RE = /^[^/\s]+@[^/\s]+:|^[A-Za-z0-9.-]+:(?!\/\/)/;
const MAX_CWD_CANDIDATES = 16;
const MAX_COUNT = 10_000;

export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/** Real path of the longest existing prefix of `target`, with the missing tail re-appended. */
export function realpathPrefix(target: string): string {
  let current = target;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return tail.length > 0 ? path.join(real, ...tail.toReversed()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return target;
      }
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * The path the kernel opens for `raw` (an absolute path as written, `..` not yet applied): every
 * existing component's symlink is followed, dangling links included, and `..` is applied to the
 * resolved directory, not to the text (`link/..` is the parent of the link's target).
 */
export function canonicalPath(raw: string, depth = 0): string {
  const parts = raw.split("/").filter((p) => p !== "" && p !== ".");
  let cur = path.parse(raw).root || "/";
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === "..") {
      cur = path.dirname(cur);
      continue;
    }
    const next = path.join(cur, parts[i]);
    let link: string | null = null;
    try {
      link = fs.lstatSync(next).isSymbolicLink() ? fs.readlinkSync(next) : null;
    } catch {
      return path.resolve(next, ...parts.slice(i + 1));
    }
    if (link === null) {
      cur = next;
    } else if (depth >= 40) {
      return path.resolve(next, ...parts.slice(i + 1));
    } else {
      cur = canonicalPath(path.isAbsolute(link) ? link : `${cur}/${link}`, depth + 1);
    }
  }
  return cur;
}

type Ctx = { root: string; realRoot: string };

/** Check one resolved absolute path. */
function pathAllowed(ctx: Ctx, abs: string): boolean {
  if (ALLOWED_DEVICES.has(abs) || /^\/dev\/fd\/\d+$/.test(abs)) {
    return true;
  }
  if (!isInside(ctx.root, abs)) {
    return false;
  }
  const real = realpathPrefix(abs);
  if (!isInside(ctx.realRoot, real) && !isInside(ctx.root, real)) {
    return false;
  }
  const rel = path.relative(ctx.realRoot, real).split(path.sep).join("/");
  return !excludedPathRegexes().some((re) => re.test(rel));
}

/** The path a word names, or null when it does not name one. */
function candidateOf(word: ShellWord): string | null {
  let v = word.value;
  if (v.startsWith("-")) {
    const eq = v.indexOf("=");
    if (eq >= 0) {
      v = v.slice(eq + 1);
    } else {
      const at = v.search(/[/~]|\.\.?(\/|$)/);
      if (at < 0) {
        return null;
      }
      v = v.slice(at);
    }
  } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
    v = v.slice(v.indexOf("=") + 1);
  }
  if (v === "" || URL_RE.test(v) || REMOTE_RE.test(v)) {
    return null;
  }
  return v;
}

/** The candidate as the kernel sees it: absolute, `..` not applied (see canonicalPath). */
export function rawCandidate(root: string, cwd: string, v: string): string {
  if (v === "~" || v.startsWith("~/")) {
    return `${root}/${v.slice(2)}`;
  }
  return path.isAbsolute(v) ? v : `${cwd}/${v}`;
}

function resolveCandidate(ctx: Ctx, cwd: string, v: string): string | null {
  if (v === "~" || v.startsWith("~/")) {
    return path.resolve(ctx.root, v.slice(2));
  }
  if (v.startsWith("~")) {
    return null; // ~user
  }
  return path.resolve(cwd, v);
}

const GLOB_CHARS = /[*?[]/;
const MAX_GLOB_MATCHES = 1000;

/**
 * Expand an absolute glob pattern the way the shell would (no dotglob: a leading dot must be
 * literal). Null when it matches too many entries to check.
 */
export function expandGlob(pattern: string): string[] | null {
  let current = [path.parse(pattern).root];
  for (const seg of pattern.split("/").filter(Boolean)) {
    if (!GLOB_CHARS.test(seg)) {
      current = current.map((dir) => path.join(dir, seg));
      continue;
    }
    const re = globToRegex(seg);
    const next: string[] = [];
    for (const dir of current) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        if ((name.startsWith(".") && !seg.startsWith(".")) || !re.test(name)) {
          continue;
        }
        next.push(path.join(dir, name));
        if (next.length > MAX_GLOB_MATCHES) {
          return null;
        }
      }
    }
    current = next;
  }
  return current;
}

/** Check one word against every cwd the line may be in at that point. */
function checkWord(
  ctx: Ctx,
  cwds: string[],
  word: ShellWord,
  opts: { program?: boolean; expansionOk?: boolean } = {},
): "ok" | "path-escape" | "unverifiable-path" {
  if (word.expands) {
    return opts.expansionOk ? "ok" : "unverifiable-path";
  }
  const v = opts.program ? word.value : candidateOf(word);
  if (v === null) {
    return "ok";
  }
  if (opts.program) {
    if (!v.includes("/")) {
      return "ok";
    }
    if (path.isAbsolute(v)) {
      const dir = path.dirname(v);
      if (SYSTEM_BIN_DIRS.has(dir)) {
        return "ok";
      }
    }
  }
  if (word.tilde && v.startsWith("~") && !v.startsWith("~/") && v !== "~") {
    return "unverifiable-path";
  }
  const looksLikePath = v.includes("/") || v === "." || v === ".." || v.startsWith("~");
  // A dot-led glob segment (`.*`) can match `..` in older shells: not verifiable.
  if (word.glob && v.split("/").some((seg) => seg.startsWith(".") && GLOB_CHARS.test(seg))) {
    return "unverifiable-path";
  }
  for (const cwd of cwds) {
    const abs = resolveCandidate(ctx, cwd, v);
    if (abs === null) {
      return "unverifiable-path";
    }
    if (word.glob && GLOB_CHARS.test(v)) {
      // The shell expands the glob: every match must stay inside (a match may be a symlink).
      if (!pathAllowed(ctx, abs.replace(/[^/]*[*?[].*$/, "") || "/")) {
        return "path-escape";
      }
      const matches = expandGlob(abs);
      if (matches === null) {
        return "unverifiable-path";
      }
      if (matches.some((m) => !pathAllowed(ctx, m))) {
        return "path-escape";
      }
      continue;
    }
    if (!looksLikePath) {
      // A plain word is a path only if it exists (then a symlink must not lead outside).
      let exists = false;
      try {
        fs.lstatSync(abs);
        exists = true;
      } catch {
        exists = false;
      }
      if (!exists) {
        continue;
      }
    }
    if (!pathAllowed(ctx, abs)) {
      return "path-escape";
    }
    // `link/..` goes to the parent of the link's target, not back to where the text says.
    if (v.includes("..") && !pathAllowed(ctx, canonicalPath(rawCandidate(ctx.root, cwd, v)))) {
      return "path-escape";
    }
  }
  return "ok";
}

function checkLine(
  ctx: Ctx,
  line: string,
  start: string[],
  previousCwd: string | null,
  depth: number,
): PathGuardResult {
  const parsed = parseShellLine(line);
  if (!parsed.ok) {
    return { ok: true, cwdAfter: null };
  }
  let cwds = [...start];
  let cwdAfter: string | null = null;
  for (const cmd of parsed.commands) {
    const words = cmd.words;
    const program = words[0] ? basenameOf(words[0].value) : "";
    const expansionOk = program === "echo" || program === "printf";
    for (const a of cmd.assignments) {
      const r = checkWord(ctx, cwds, a);
      if (r !== "ok") {
        return { ok: false, code: r };
      }
    }
    for (const r of cmd.redirects) {
      if (r.target) {
        const res = checkWord(ctx, cwds, r.target);
        if (res !== "ok") {
          return { ok: false, code: res };
        }
      }
    }
    if (words.length === 0) {
      continue;
    }
    const head = checkWord(ctx, cwds, words[0], { program: true });
    if (head !== "ok") {
      return { ok: false, code: head };
    }
    if (program === "cd") {
      const target = words.slice(1).find((w) => !(w.value.startsWith("-") && w.value.length > 1));
      if (target?.expands) {
        return { ok: false, code: "unverifiable-path" };
      }
      const next: string[] = [];
      for (const cwd of cwds) {
        let abs: string | null;
        if (!target || target.value === "~") {
          abs = ctx.root;
        } else if (target.value === "-") {
          abs = previousCwd ?? cwd;
        } else {
          abs = resolveCandidate(ctx, cwd, target.value);
        }
        if (abs === null) {
          return { ok: false, code: "unverifiable-path" };
        }
        if (!pathAllowed(ctx, abs)) {
          return { ok: false, code: "path-escape" };
        }
        next.push(abs);
      }
      if (parsed.commands.length === 1 && depth === 0) {
        cwdAfter = next[0] ?? null;
      }
      // The cd may fail or run in a subshell: later words are checked against both.
      cwds = [...new Set([...cwds, ...next])];
      if (cwds.length > MAX_CWD_CANDIDATES) {
        return { ok: false, code: "unverifiable-path" };
      }
      continue;
    }
    for (const w of words.slice(1)) {
      const r = checkWord(ctx, cwds, w, { expansionOk });
      if (r !== "ok") {
        return { ok: false, code: r };
      }
    }
    const ci = words.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.value));
    const nested =
      SHELLS.has(program) && ci > 0 && words[ci + 1]
        ? words[ci + 1].value
        : program === "eval"
          ? words
              .slice(1)
              .map((w) => w.value)
              .join(" ")
          : null;
    if (nested !== null && depth < 3) {
      const r = checkLine(ctx, nested, cwds, previousCwd, depth + 1);
      if (!r.ok) {
        return r;
      }
    }
  }
  return { ok: true, cwdAfter };
}

/** Check every path a line names; `cwdAfter` is set for a line that is only `cd <dir>`. */
export function checkLinePaths(
  line: string,
  opts: { root: string; cwd: string; previousCwd?: string | null },
): PathGuardResult {
  const root = path.resolve(opts.root);
  const ctx: Ctx = { root, realRoot: realpathPrefix(root) };
  if (!isInside(root, opts.cwd)) {
    return { ok: false, code: "path-escape" };
  }
  return checkLine(ctx, line, [opts.cwd], opts.previousCwd ?? null, 0);
}

function globToRegex(pattern: string): RegExp {
  let re = "^";
  for (const ch of pattern) {
    re += ch === "*" ? "[^/]*" : ch === "?" ? "[^/]" : ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${re}$`);
}

function countUnder(dir: string, budget: { left: number }): number {
  let n = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    if (budget.left <= 0) {
      return n;
    }
    budget.left--;
    n++;
    if (e.isDirectory() && !e.isSymbolicLink()) {
      n += countUnder(path.join(dir, e.name), budget);
    }
  }
  return n;
}

/** Helpers the classifier uses to fill risk counts (files named, globs expanded, `-r` walked). */
export function pathHelpers(root: string, cwd: string) {
  const resolve = (w: ShellWord) =>
    w.value === "~" || w.value.startsWith("~/")
      ? path.resolve(root, w.value.slice(2))
      : path.resolve(cwd, w.value);
  return {
    fileExists: (word: ShellWord): boolean => {
      try {
        return fs.statSync(resolve(word)).isFile();
      } catch {
        return false;
      }
    },
    countTargets: (operands: ShellWord[], recursive: boolean): number => {
      const budget = { left: MAX_COUNT };
      let n = 0;
      for (const w of operands) {
        const abs = resolve(w);
        let targets = [abs];
        if (w.glob) {
          const dir = path.dirname(abs);
          const re = globToRegex(path.basename(abs));
          try {
            targets = fs
              .readdirSync(dir)
              .filter((name) => re.test(name) && (!name.startsWith(".") || w.value.startsWith(".")))
              .map((name) => path.join(dir, name));
          } catch {
            targets = [];
          }
        }
        for (const t of targets) {
          let stat: fs.Stats | null = null;
          try {
            stat = fs.lstatSync(t);
          } catch {
            stat = null;
          }
          if (!stat) {
            continue;
          }
          n++;
          if (recursive && stat.isDirectory()) {
            n += countUnder(t, budget);
          }
        }
      }
      return Math.min(n, MAX_COUNT);
    },
  };
}
