// Which paths one simple command of a console terminal line would write, create, delete, move or
// change the permissions of. Used by the read-only folder guard (./readonly-guard.ts); the risk
// preview stays in ./classify.ts. Like the classifier this reads the words of the line, not the
// program: a script, an interpreter's code or a build tool it does not know is not listed here
// (the post-command diff reports such writes as violations).

import { hasFlag, isFlag, operandsOf } from "./classify-shared.js";
import {
  DELETE_PROGRAMS,
  PERMISSION_PROGRAMS,
  SHELLS,
  WRAPPER_VALUE_FLAGS,
  WRAPPERS,
} from "./command-tables.js";
import { basenameOf, type ShellWord } from "./shell-words.js";

/**
 * One write. `word` names the path (resolved against the cwd); without `word` it is the cwd
 * itself. `tree`: everything below the path may be written too (recursive delete or chmod, a move,
 * an extraction or a git checkout into it), so a read-only folder inside it conflicts as well.
 * `child`: when the path is an existing directory, the write lands in `<path>/<child>`.
 */
export type WriteTarget = { word?: ShellWord; tree?: boolean; child?: string };

export type CommandWrites = {
  targets: WriteTarget[];
  /** Lines this command runs (`sh -c`, `eval`): checked like the line itself. */
  nested: string[];
  /** Writes whose paths come from input (`… | xargs rm`): every path on the line counts. */
  lineWide: boolean;
};

const word = (value: string): ShellWord => ({
  value,
  expands: false,
  glob: false,
  tilde: false,
});

/** Value of a flag: `-f x`, `-fx`, `--file=x`, `--file x`. */
function flagValues(args: ShellWord[], short: string | null, long: string | null): ShellWord[] {
  const out: ShellWord[] = [];
  for (let i = 0; i < args.length; i++) {
    const v = args[i].value;
    if ((short && v === short) || (long && v === long)) {
      if (args[i + 1]) {
        out.push(args[i + 1]);
      }
    } else if (long && v.startsWith(`${long}=`)) {
      out.push({ ...args[i], value: v.slice(long.length + 1) });
    } else if (short && v.startsWith(short) && !v.startsWith("--") && v.length > short.length) {
      out.push({ ...args[i], value: v.slice(short.length) });
    }
  }
  return out;
}

/** Operands, minus the values of the given value-taking flags. */
function operandsWithout(args: ShellWord[], valueFlags: RegExp): ShellWord[] {
  const skip = new Set<ShellWord>();
  args.forEach((w, i) => {
    if (valueFlags.test(w.value) && args[i + 1]) {
      skip.add(args[i + 1]);
    }
  });
  return operandsOf(args).filter((w) => !skip.has(w));
}

const RECURSIVE = /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/;
const BUILD_TOOLS = new Set(["make", "gmake", "ninja", "cmake", "mvn", "gradle", "ant", "cargo"]);
const PACKAGE_CWD = new Set(["npm", "pnpm", "yarn", "pip", "pip3", "go", "bundle", "composer"]);
const COMPILERS = new Set(["gcc", "g++", "cc", "c++", "clang", "clang++", "cobc", "gfortran"]);
const COMPRESSORS = new Set(["gzip", "gunzip", "xz", "unxz", "bzip2", "bunzip2", "zstd"]);

/** cp, install, ln, mv, rsync, scp: the destination and where each source lands in it. */
function copyLike(program: string, args: ShellWord[]): WriteTarget[] {
  const valueFlags =
    program === "install" ? /^(-t|-m|-o|-g|-S|--target-directory)$/ : /^(-t|--target-directory)$/;
  const operands = operandsWithout(args, valueFlags);
  const targetDir = flagValues(args, "-t", "--target-directory")[0];
  const recursive = hasFlag(args, /^(-[a-zA-Z]*[rRa][a-zA-Z]*|--recursive|--archive)$/);
  const out: WriteTarget[] = [];
  if (program === "install" && hasFlag(args, /^(-d|--directory)$/)) {
    return operands.map((w) => ({ word: w }));
  }
  const dest = targetDir ?? (operands.length > 1 ? operands[operands.length - 1] : undefined);
  const sources = targetDir ? operands : operands.slice(0, -1);
  if (!dest) {
    // `ln -s x` / `cp x` with one operand: a link or copy named after it in the cwd.
    const only = operands[0];
    if (only && program === "ln") {
      out.push({ child: basenameOf(only.value) });
    }
    if (only && program === "mv") {
      out.push({ word: only, tree: true });
    }
  } else {
    out.push({ word: dest });
    for (const s of sources) {
      const base = basenameOf(s.value.replace(/\/+$/, ""));
      const contents = base === "." || (program === "rsync" && s.value.endsWith("/"));
      out.push(contents ? { word: dest, tree: true } : { word: dest, child: base });
    }
  }
  if (program === "mv") {
    sources.forEach((s) => out.push({ word: s, tree: true }));
  }
  const hardLink =
    (program === "ln" && !hasFlag(args, /^(-[a-zA-Z]*s[a-zA-Z]*|--symbolic)$/)) ||
    (program === "cp" && hasFlag(args, /^(-[a-zA-Z]*l[a-zA-Z]*|--link)$/));
  if (hardLink) {
    // A hard link to a read-only file is a writable alias of it.
    sources.forEach((s) => out.push({ word: s, tree: recursive }));
  }
  if (program === "rsync" && hasFlag(args, /^--remove-source-files$/)) {
    sources.forEach((s) => out.push({ word: s, tree: true }));
  }
  return out;
}

function tarWrites(args: ShellWord[]): WriteTarget[] {
  // Short options may be clustered (`-czf out.tgz`, or `czf out.tgz` as the first word).
  const clusters = args
    .map((w, i) => ({ w, i, letters: /^-[a-zA-Z]+$/.test(w.value) ? w.value.slice(1) : "" }))
    .filter((c) => c.letters || (c.i === 0 && /^[a-zA-Z]+$/.test(c.w.value)))
    .map((c) => ({ ...c, letters: c.letters || c.w.value }));
  const has = (letter: string, long: RegExp) =>
    clusters.some((c) => c.letters.includes(letter)) || args.some((w) => long.test(w.value));
  const archive = flagValues(args, null, "--file");
  for (const c of clusters) {
    const at = c.letters.indexOf("f");
    if (at >= 0) {
      const rest = c.letters.slice(at + 1);
      const value = rest ? { ...c.w, value: rest } : args[c.i + 1];
      if (value) {
        archive.push(value);
      }
    }
  }
  if (has("x", /^(--extract|--get)$/)) {
    const dir = flagValues(args, "-C", "--directory")[0];
    return [dir ? { word: dir, tree: true } : { tree: true }];
  }
  if (has("t", /^--list$/)) {
    return [];
  }
  return archive.map((w) => ({ word: w }));
}

/** Git subcommands that rewrite files of the working tree. */
const GIT_WORKTREE = new Set([
  "checkout",
  "switch",
  "restore",
  "reset",
  "stash",
  "merge",
  "rebase",
  "pull",
  "cherry-pick",
  "revert",
  "am",
  "apply",
  "clean",
  "rm",
  "mv",
  "submodule",
  "sparse-checkout",
  "worktree",
]);
const GIT_PATH_ONLY = new Set(["restore", "rm", "mv", "clean"]);

function gitWrites(args: ShellWord[]): WriteTarget[] {
  let i = 0;
  let dir: ShellWord | undefined;
  while (i < args.length && args[i].value.startsWith("-")) {
    const v = args[i].value;
    if (v === "-C" || v === "--work-tree") {
      dir = args[i + 1];
    }
    i += v === "-C" || v === "-c" || v === "--git-dir" || v === "--work-tree" ? 2 : 1;
  }
  const sub = args[i]?.value ?? "";
  const rest = args.slice(i + 1);
  const at = (w?: ShellWord, tree = true): WriteTarget =>
    dir ? { word: w ?? dir, tree } : w ? { word: w, tree } : { tree };
  if (sub === "clone") {
    const ops = operandsWithout(rest, /^(-b|--branch|-o|--origin|--depth|-c|--config)$/);
    return [ops[1] ? { word: ops[1], tree: true } : at(undefined, false)];
  }
  if (sub === "init") {
    const ops = operandsOf(rest);
    return [ops[0] ? { word: ops[0], tree: true } : at(undefined, false)];
  }
  if (!GIT_WORKTREE.has(sub)) {
    return []; // commit, add, fetch, branch, config, …: the repository, not the working tree
  }
  if (sub === "reset" && !hasFlag(rest, /^--(hard|merge|keep)$/)) {
    return [];
  }
  if (
    (sub === "checkout" && hasFlag(rest, /^-b$/)) ||
    (sub === "switch" && hasFlag(rest, /^-c$/))
  ) {
    return [];
  }
  // Pathspecs after `--` are written; without them a branch or patch may rewrite the whole tree.
  const dashdash = rest.findIndex((w) => w.value === "--");
  const paths =
    dashdash >= 0 ? rest.slice(dashdash + 1) : GIT_PATH_ONLY.has(sub) ? operandsOf(rest) : [];
  const named = paths.map((w): WriteTarget => ({ word: w, tree: true }));
  // With -C, pathspecs are relative to that directory: the directory itself is checked too.
  return named.length > 0 && !dir ? named : [at(), ...named];
}

/** The writes of one simple command (its words, program first). */
export function commandWrites(words: ShellWord[], depth = 0): CommandWrites {
  const res: CommandWrites = { targets: [], nested: [], lineWide: false };
  if (words.length === 0 || depth > 4) {
    return res;
  }
  const program = basenameOf(words[0].value);
  const args = words.slice(1);
  const ops = operandsOf(args);
  const add = (...t: WriteTarget[]) => res.targets.push(...t);
  if (WRAPPERS.has(program)) {
    const valueFlags = WRAPPER_VALUE_FLAGS[program] ?? new Set<string>();
    let i = 0;
    while (i < args.length) {
      const v = args[i].value;
      if (v === "--") {
        i++;
        break;
      }
      if (
        (program === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) ||
        (isFlag(args[i]) && v !== "-")
      ) {
        i += valueFlags.has(v) ? 2 : 1;
        continue;
      }
      break;
    }
    if (program === "timeout" && i < args.length) {
      i++;
    }
    return commandWrites(args.slice(i), depth + 1);
  }
  if (program === "eval") {
    res.nested.push(args.map((w) => w.value).join(" "));
    return res;
  }
  if (SHELLS.has(program)) {
    const ci = args.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.value));
    if (ci >= 0 && args[ci + 1]) {
      res.nested.push(args[ci + 1].value);
    }
    return res;
  }
  if (program === "xargs") {
    const valueFlags = /^(-n|-I|-P|-L|-d|-E|-s|-a|--max-args|--max-procs|--delimiter|--arg-file)$/;
    let i = 0;
    while (i < args.length && args[i].value.startsWith("-")) {
      i += valueFlags.test(args[i].value) ? 2 : 1;
    }
    const inner = args.slice(i);
    const sub = commandWrites(inner, depth + 1);
    const innerProgram = inner[0] ? basenameOf(inner[0].value) : "";
    if (sub.targets.length > 0 || sub.lineWide || DELETE_PROGRAMS.has(innerProgram)) {
      return { targets: sub.targets, nested: sub.nested, lineWide: true };
    }
    return sub;
  }
  if (program === "find") {
    const starts: ShellWord[] = [];
    for (const w of args) {
      if (/^[-(!]/.test(w.value)) {
        break;
      }
      starts.push(w);
    }
    const roots = starts.length > 0 ? starts : [word(".")];
    for (let i = 0; i < args.length; i++) {
      const v = args[i].value;
      if (v === "-delete") {
        add(...roots.map((w) => ({ word: w, tree: true })));
      } else if (/^-(fprint|fprint0|fprintf|fls)$/.test(v) && args[i + 1]) {
        add({ word: args[i + 1] });
      } else if (/^-(exec|execdir|ok|okdir)$/.test(v)) {
        let end = i + 1;
        while (end < args.length && args[end].value !== ";" && args[end].value !== "+") {
          end++;
        }
        const inner = args.slice(i + 1, end);
        const sub = commandWrites(
          inner.filter((w) => !w.value.includes("{}")),
          depth + 1,
        );
        const innerProgram = inner[0] ? basenameOf(inner[0].value) : "";
        if (sub.targets.length > 0 || sub.lineWide || DELETE_PROGRAMS.has(innerProgram)) {
          add(...sub.targets, ...roots.map((w) => ({ word: w, tree: true })));
        }
        res.nested.push(...sub.nested);
        i = end;
      }
    }
    return res;
  }
  if (program === "git") {
    add(...gitWrites(args));
    return res;
  }
  if (DELETE_PROGRAMS.has(program)) {
    const tree = program === "rm" ? hasFlag(args, RECURSIVE) : program === "trash";
    add(...ops.map((w) => ({ word: w, tree })));
    return res;
  }
  if (PERMISSION_PROGRAMS.has(program)) {
    const tree = hasFlag(args, /^(-R|--recursive)$/);
    const valueFlags = program === "setfacl" ? /^(-m|-x|-M|-X|--modify|--remove)$/ : /^$/;
    const files = program === "setfacl" ? operandsWithout(args, valueFlags) : ops.slice(1);
    add(...files.map((w) => ({ word: w, tree })));
    return res;
  }
  if (["cp", "install", "ln", "mv", "rsync", "scp"].includes(program)) {
    add(...copyLike(program, args));
    return res;
  }
  if (["mkdir", "touch", "mkfifo", "mknod", "tee", "shred"].includes(program)) {
    const files = program === "mknod" ? ops.slice(0, 1) : ops;
    add(...files.map((w) => ({ word: w })));
    return res;
  }
  if (program === "truncate") {
    add(
      ...operandsWithout(args, /^(-s|--size|-r|--reference)$/).map((w) => ({
        word: w,
      })),
    );
    return res;
  }
  if (program === "dd") {
    for (const w of args) {
      if (w.value.startsWith("of=")) {
        add({ word: { ...w, value: w.value.slice(3) } });
      }
    }
    return res;
  }
  if (program === "sed" || program === "perl" || program === "awk" || program === "gawk") {
    const inPlace = hasFlag(args, /^(-i.*|--in-place(=.*)?|-[a-zA-Z]*i[a-zA-Z]*)$/);
    const awkInPlace = args.some((w, i) => w.value === "-i" && args[i + 1]?.value === "inplace");
    if (inPlace || awkInPlace) {
      add(...operandsWithout(args, /^(-e|-f|--expression|--file|-i)$/).map((w) => ({ word: w })));
    }
    return res;
  }
  if (program === "sort" || program === "tree") {
    add(
      ...flagValues(args, "-o", program === "sort" ? "--output" : null).map((w) => ({ word: w })),
    );
    return res;
  }
  if (program === "uniq" && ops.length >= 2) {
    add({ word: ops[1] });
    return res;
  }
  if (program === "tar") {
    add(...tarWrites(args));
    return res;
  }
  if (program === "unzip") {
    if (!hasFlag(args, /^-[a-zA-Z]*[lvtZ][a-zA-Z]*$/)) {
      const dir = flagValues(args, "-d", null)[0];
      add(dir ? { word: dir, tree: true } : { tree: true });
    }
    return res;
  }
  if (program === "zip") {
    if (ops[0]) {
      add({ word: ops[0] });
    }
    if (hasFlag(args, /^(-m|--move)$/)) {
      add(...ops.slice(1).map((w) => ({ word: w, tree: true })));
    }
    return res;
  }
  if (COMPRESSORS.has(program)) {
    if (!hasFlag(args, /^(-c|--stdout|-l|--list|-t|--test)$/)) {
      add(...ops.map((w) => ({ word: w })));
    }
    return res;
  }
  if (program === "patch") {
    const dir = flagValues(args, "-d", "--directory")[0];
    add(
      dir ? { word: dir, tree: true } : { tree: true },
      ...ops.slice(0, 1).map((w) => ({ word: w })),
    );
    return res;
  }
  if (program === "split" || program === "csplit") {
    const prefix = flagValues(args, "-f", "--prefix")[0] ?? ops[1];
    add(prefix ? { word: prefix } : {});
    return res;
  }
  if (program === "curl") {
    add(...flagValues(args, "-o", "--output").map((w) => ({ word: w })));
    if (hasFlag(args, /^(-O|--remote-name|-[a-zA-Z]*O[a-zA-Z]*)$/)) {
      add({});
    }
    return res;
  }
  if (program === "wget") {
    const out = flagValues(args, "-O", "--output-document");
    const dir = flagValues(args, "-P", "--directory-prefix")[0];
    add(
      ...(out.length > 0 ? out.map((w) => ({ word: w })) : [dir ? { word: dir, tree: true } : {}]),
    );
    return res;
  }
  if (program === "javac") {
    const dir = flagValues(args, "-d", null)[0];
    // Without -d, class files are written next to each source file.
    add(...(dir ? [{ word: dir, tree: true }] : ops.map((w) => ({ word: w }))));
    return res;
  }
  if (COMPILERS.has(program)) {
    const out = flagValues(args, "-o", null)[0];
    add(out ? { word: out } : {});
    return res;
  }
  if (BUILD_TOOLS.has(program) || PACKAGE_CWD.has(program)) {
    const dir =
      flagValues(args, "-C", "--prefix")[0] ?? flagValues(args, "--dir", "--directory")[0];
    // Build output and package folders land in the directory the tool runs in.
    add(dir ? { word: dir } : {});
    return res;
  }
  return res;
}
