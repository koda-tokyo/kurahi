// Read-only folders for the console terminal. A project's `rules.readOnly` folders (for example
// `source`, `data` and `docs` in the industrial modernisation template) cannot be written,
// created in, deleted, moved or chmod-ed from the terminal in any mode: such a line is refused
// before any approval is offered (risk and notice code `read-only-path`). Reading them is not
// affected. The rule follows the project config, which is re-read for every line, so an operator
// unlocks a folder by removing it from the project's read-only list.
//
// Targets come from ./write-targets.ts. Each one is checked twice: lexically, and as the kernel
// would open it (symlinks followed, dangling ones too, `..` applied after them), against both the
// folder's path and its real path, case-insensitively on macOS and Windows. What the line does not
// show (a script, a build tool, an interpreter) is caught afterwards by the diff (`violations`).

import fs from "node:fs";
import path from "node:path";
import { canonicalPath, expandGlob, isInside, rawCandidate } from "./path-guard.js";
import { parseShellLine, type ShellWord } from "./shell-words.js";
import { commandWrites, type WriteTarget } from "./write-targets.js";

export type ReadOnlyFolder = { rel: string; forms: string[] };
export type ReadOnlyCheck = { ok: true } | { ok: false; folder: string };

const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";
const MAX_DEPTH = 3;

function norm(p: string): string {
  const n = p.normalize("NFC");
  return FOLD_CASE ? n.toLowerCase() : n;
}

/** `target` is `dir` or inside it. */
function within(dir: string, target: string): boolean {
  return isInside(norm(dir), norm(target));
}

/** The read-only folders of a project as absolute paths (as configured and as real paths). */
export function readOnlyFolders(root: string, rel: readonly string[]): ReadOnlyFolder[] {
  return rel.map((r) => {
    const abs = r === "." ? root : path.resolve(root, r);
    return { rel: r, forms: [...new Set([abs, canonicalPath(abs)])] };
  });
}

type Ctx = { root: string; folders: ReadOnlyFolder[] };

function conflict(ctx: Ctx, forms: string[], tree: boolean): string | null {
  for (const f of ctx.folders) {
    for (const dir of f.forms) {
      if (forms.some((t) => within(dir, t) || (tree && within(t, dir)))) {
        return f.rel;
      }
    }
  }
  return null;
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

type Forms = { forms: string[]; tree: boolean };

/** Every path a target may stand for in `cwd`: lexical and kernel forms, globs expanded. */
function formsOf(ctx: Ctx, cwd: string, t: WriteTarget): Forms[] {
  const tree = t.tree === true;
  if (!t.word) {
    return [{ forms: [cwd, canonicalPath(cwd)], tree }];
  }
  const v = t.word.value;
  const lexical =
    v === "~" || v.startsWith("~/") ? path.resolve(ctx.root, v.slice(2)) : path.resolve(cwd, v);
  if (t.word.glob && /[*?[]/.test(v)) {
    // The literal prefix is where the matches live (and what the shell keeps if none match).
    const prefix = lexical.replace(/[^/]*[*?[].*$/, "") || "/";
    const matches = expandGlob(lexical) ?? [];
    return [
      { forms: [prefix, canonicalPath(prefix)], tree: false },
      ...matches.map((m) => ({ forms: [m, canonicalPath(m)], tree })),
    ];
  }
  return [{ forms: [lexical, canonicalPath(rawCandidate(ctx.root, cwd, v))], tree }];
}

function checkTarget(ctx: Ctx, cwds: string[], t: WriteTarget): string | null {
  for (const cwd of cwds) {
    for (const { forms, tree } of formsOf(ctx, cwd, t)) {
      const hit = conflict(ctx, forms, tree);
      if (hit) {
        return hit;
      }
      const child = t.child;
      if (child && (!t.word || forms.some(isDir))) {
        const childHit = conflict(
          ctx,
          forms.map((f) => path.join(f, child)),
          false,
        );
        if (childHit) {
          return childHit;
        }
      }
    }
  }
  return null;
}

const looksLikePath = (w: ShellWord) =>
  w.value.includes("/") || w.value === "." || w.value === ".." || w.value.startsWith("~");

function checkLine(
  ctx: Ctx,
  line: string,
  start: string[],
  prev: string | null,
  depth: number,
): ReadOnlyCheck {
  const parsed = parseShellLine(line);
  if (!parsed.ok) {
    return { ok: true };
  }
  let cwds = [...start];
  let lineWide = false;
  const pathWords: ShellWord[] = [];
  for (const cmd of parsed.commands) {
    const program = cmd.words[0]?.value ?? "";
    if (path.basename(program) === "cd") {
      const target = cmd.words
        .slice(1)
        .find((w) => !(w.value.startsWith("-") && w.value.length > 1));
      const next = cwds.map((cwd) =>
        !target || target.value === "~"
          ? ctx.root
          : target.value === "-"
            ? (prev ?? cwd)
            : canonicalPath(rawCandidate(ctx.root, cwd, target.value)),
      );
      cwds = [...new Set([...cwds, ...next])];
      continue;
    }
    const targets: WriteTarget[] = cmd.redirects
      .filter((r) => OUTPUT_REDIRECTS.has(r.op) && r.target && r.target.value !== "/dev/null")
      .map((r) => ({ word: r.target }));
    const writes = commandWrites(cmd.words);
    targets.push(...writes.targets);
    lineWide ||= writes.lineWide;
    for (const t of targets) {
      const hit = checkTarget(ctx, cwds, t);
      if (hit) {
        return { ok: false, folder: hit };
      }
    }
    for (const nested of writes.nested) {
      const r =
        depth < MAX_DEPTH ? checkLine(ctx, nested, cwds, prev, depth + 1) : { ok: true as const };
      if (!r.ok) {
        return r;
      }
    }
    pathWords.push(
      ...cmd.words.slice(1).filter((w) => !w.value.startsWith("-") || w.value.includes("=")),
    );
  }
  if (lineWide) {
    // Paths read from input (`find … | xargs rm`): any path the line names, or else the cwd.
    const named = pathWords.filter(
      (w) => looksLikePath(w) || cwds.some((c) => fs.existsSync(path.resolve(c, w.value))),
    );
    const wide = named.length > 0 ? named.map((w) => ({ word: w, tree: true })) : [{ tree: true }];
    for (const t of wide) {
      const hit = checkTarget(ctx, cwds, t);
      if (hit) {
        return { ok: false, folder: hit };
      }
    }
  }
  return { ok: true };
}

/** Refuse a line that would write inside one of the project's read-only folders. */
export function checkReadOnlyWrites(
  line: string,
  opts: {
    root: string;
    cwd: string;
    previousCwd?: string | null;
    readOnly: readonly string[];
  },
): ReadOnlyCheck {
  if (opts.readOnly.length === 0) {
    return { ok: true };
  }
  const root = path.resolve(opts.root);
  const ctx: Ctx = { root, folders: readOnlyFolders(root, opts.readOnly) };
  return checkLine(ctx, line, [opts.cwd], opts.previousCwd ?? null, 0);
}

/** The read-only folder a project-relative path (as the diff reports it) lies in, if any. */
export function readOnlyFolderOf(rel: string, readOnly: readonly string[]): string | null {
  const p = norm(rel);
  for (const r of readOnly) {
    const f = norm(r);
    if (f === "." || p === f || p.startsWith(`${f}/`)) {
      return r;
    }
  }
  return null;
}
