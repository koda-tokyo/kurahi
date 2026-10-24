// Line classification for the console terminal: is a submitted command line read-only, which
// risks does it carry (the preview the approval shows), and must it be refused outright
// (privilege elevation, detaching, interactive programs, constructs the line does not show).
//
// This reads the line, not the programs: a script, a Makefile target or an interpreter's code
// can do anything. Such lines are "runs-program" and never read-only. The hardline guard
// (src/security/exec-guard.ts) and the path guard (./path-guard.ts) run beside this.

import { analyzeGit } from "./classify-git.js";
import {
  type ClassifyOptions,
  Collector,
  hasFlag,
  type LineClass,
  operandsOf,
} from "./classify-shared.js";
import {
  DANGEROUS_ENV_RE,
  DB_CLIENTS,
  DELETE_PROGRAMS,
  DETACH_PROGRAMS,
  ENV_PRINTERS,
  INTERACTIVE_PROGRAMS,
  INTERPRETERS,
  NETWORK_PROGRAMS,
  OVERWRITE_PROGRAMS,
  PACKAGE_INSTALL,
  PACKAGE_RUNNERS,
  PERMISSION_PROGRAMS,
  PRIVILEGE_PROGRAMS,
  PROCESS_PROGRAMS,
  READ_ONLY_FLAG_EXCEPTIONS,
  READ_ONLY_PROGRAMS,
  SHELLS,
  UNSUPPORTED_BUILTINS,
  WRAPPER_VALUE_FLAGS,
  WRAPPERS,
  WRITE_PROGRAMS,
} from "./command-tables.js";
import { basenameOf, parseShellLine, type ShellWord } from "./shell-words.js";

export type { ClassifyOptions, LineClass, Refusal } from "./classify-shared.js";

const MAX_NESTING = 3;
const OUTPUT_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>", "<>", ">&"]);
const TRUNCATING_REDIRECTS = new Set([">", ">|", "&>", ">&"]);

function checkAssignment(c: Collector, word: ShellWord) {
  const name = word.value.slice(0, word.value.indexOf("="));
  if (DANGEROUS_ENV_RE.test(name)) {
    c.risk("runs-program", { program: "env", variable: name });
  }
}

/** Skip a wrapper's own options; returns the words of the wrapped command. */
function unwrap(program: string, args: ShellWord[], c: Collector): ShellWord[] | null {
  const valueFlags = WRAPPER_VALUE_FLAGS[program] ?? new Set<string>();
  let i = 0;
  while (i < args.length) {
    const v = args[i].value;
    if (program === "env" && (v === "-S" || v.startsWith("--split-string"))) {
      c.refuse("eval-refused", { program });
      return null;
    }
    if (program === "env" && /^[A-Za-z_][A-Za-z0-9_]*=/.test(v)) {
      checkAssignment(c, args[i]);
      i++;
      continue;
    }
    if (v === "--") {
      i++;
      break;
    }
    if (!v.startsWith("-") || v === "-") {
      break;
    }
    i += valueFlags.has(v) ? 2 : 1;
  }
  if (program === "timeout" && i < args.length) {
    i++; // the duration
  }
  if (program === "command" && args.some((w) => /^-[vV]$/.test(w.value))) {
    return [];
  }
  return args.slice(i);
}

function interactive(c: Collector, program: string): boolean {
  if (c.opts.allowInteractive?.has(program)) {
    c.risk("runs-program", { program });
    return true;
  }
  c.refuse("interactive-refused", { program });
  return false;
}

function analyzeWords(
  words: ShellWord[],
  c: Collector,
  depth: number,
  analyzeLine: (line: string, depth: number) => void,
): void {
  if (words.length === 0) {
    return;
  }
  const head = words[0];
  if (head.expands || head.glob) {
    c.refuse("eval-refused");
    return;
  }
  const program = basenameOf(head.value);
  const args = words.slice(1);
  const ops = operandsOf(args);
  c.programs.push(program);
  const p = { program };
  if (PRIVILEGE_PROGRAMS.has(program)) {
    return c.refuse("privilege-refused", p);
  }
  if (DETACH_PROGRAMS.has(program)) {
    return c.refuse("detach-refused", p);
  }
  if (UNSUPPORTED_BUILTINS.has(program)) {
    return c.refuse("unsupported-builtin", p);
  }
  if (head.value.includes("/")) {
    c.risk("runs-program", p);
    return;
  }
  if (program === "eval") {
    c.risk("runs-nested-command", p);
    return analyzeLine(args.map((w) => w.value).join(" "), depth + 1);
  }
  if (program === "source" || program === ".") {
    c.risk("runs-program", p);
    return;
  }
  if (program === "cd" || program === "exit" || program === "logout") {
    return;
  }
  if (program === "xargs") {
    c.risk("runs-nested-command", p);
    if (hasFlag(args, /^(-p|--interactive)$/)) {
      return void interactive(c, program);
    }
    const valueFlags = /^(-n|-I|-P|-L|-d|-E|-s|-a|--max-args|--max-procs|--delimiter|--arg-file)$/;
    let i = 0;
    while (i < args.length && args[i].value.startsWith("-")) {
      i += valueFlags.test(args[i].value) ? 2 : 1;
    }
    return analyzeWords(args.slice(i), c, depth + 1, analyzeLine);
  }
  if (WRAPPERS.has(program)) {
    const inner = unwrap(program, args, c);
    if (inner === null) {
      return;
    }
    if (inner.length === 0) {
      if (program === "env") {
        c.printsEnv = true;
      }
      return;
    }
    return analyzeWords(inner, c, depth, analyzeLine);
  }
  if (SHELLS.has(program)) {
    const ci = args.findIndex((w) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(w.value));
    if (ci >= 0 && args[ci + 1]) {
      c.risk("runs-nested-command", p);
      return analyzeLine(args[ci + 1].value, depth + 1);
    }
    if (ops.length > 0 && !hasFlag(args, /^(-i|-s)$/)) {
      c.risk("runs-program", p);
      return;
    }
    return void interactive(c, program);
  }
  if (INTERACTIVE_PROGRAMS.has(program)) {
    return void interactive(c, program);
  }
  if (INTERPRETERS.has(program)) {
    const inline = hasFlag(args, /^(-c|-e|-E|-m|-p|-r|--eval|--print|--command)$/);
    if ((inline || ops.length > 0) && !hasFlag(args, /^-i$/)) {
      c.risk("runs-program", p);
      return;
    }
    return void interactive(c, program);
  }
  if (program in DB_CLIENTS) {
    const inline =
      hasFlag(args, DB_CLIENTS[program]) ||
      (program === "sqlite3" && ops.length >= 2) ||
      (program === "redis-cli" && ops.length >= 1);
    if (!inline) {
      return void interactive(c, program);
    }
    c.risk("network", p);
    c.risk("runs-program", p);
    return;
  }
  if (program === "git") {
    return analyzeGit(args, c);
  }
  if (program === "find") {
    for (let i = 0; i < args.length; i++) {
      const v = args[i].value;
      if (/^-(exec|execdir|ok|okdir)$/.test(v)) {
        let end = i + 1;
        while (end < args.length && args[end].value !== ";" && args[end].value !== "+") {
          end++;
        }
        c.risk("runs-nested-command", p);
        analyzeWords(
          args.slice(i + 1, end).filter((w) => w.value !== "{}"),
          c,
          depth + 1,
          analyzeLine,
        );
        i = end;
      } else if (v === "-delete") {
        c.risk("deletes-files", p);
      } else if (/^-(fprint|fprint0|fprintf|fls)$/.test(v)) {
        c.risk("writes-files", { count: 1 });
      }
    }
    return;
  }
  if (ENV_PRINTERS.has(program) && !READ_ONLY_PROGRAMS.has(program)) {
    const assigns = args.filter((w) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w.value));
    assigns.forEach((w) => checkAssignment(c, w));
    if (ops.length === 0 || hasFlag(args, /^-p$/)) {
      c.printsEnv = true;
    }
    return;
  }
  if (READ_ONLY_PROGRAMS.has(program)) {
    const exception = READ_ONLY_FLAG_EXCEPTIONS[program];
    if (exception && hasFlag(args, exception)) {
      c.risk("writes-files", { count: 1 });
      return;
    }
    if (program === "uniq" && ops.length >= 2) {
      c.risk(c.exists(ops[1]) ? "overwrites-files" : "writes-files", { count: 1 });
    } else if (program === "hostname" && ops.length > 0) {
      c.risk("process-control", p);
    } else if (program === "printenv") {
      c.printsEnv = true;
    }
    return;
  }
  if (DELETE_PROGRAMS.has(program)) {
    const recursive = hasFlag(args, /^(-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)$/);
    return c.risk("deletes-files", { count: c.count(ops, recursive) });
  }
  if (program === "mv") {
    return c.risk("moves-files", { count: Math.max(1, c.count(ops.slice(0, -1))) });
  }
  if (program === "sed" || program === "perl") {
    if (hasFlag(args, /^(-i.*|--in-place(=.*)?|-[a-zA-Z]*i[a-zA-Z]*)$/)) {
      return c.risk("overwrites-files", { count: c.count(ops.slice(1)) });
    }
    return c.risk("runs-program", p);
  }
  if (program === "cp" || program === "install") {
    const dest = ops[ops.length - 1];
    const count = Math.max(1, c.count(ops.slice(0, -1)));
    return c.risk(dest && c.exists(dest) ? "overwrites-files" : "writes-files", { count });
  }
  if (program === "tee") {
    const append = hasFlag(args, /^(-a|--append)$/);
    const existing = ops.filter((w) => c.exists(w)).length;
    if (!append && existing > 0) {
      c.risk("overwrites-files", { count: existing });
    }
    if (ops.length - (append ? 0 : existing) > 0) {
      c.risk("writes-files", { count: ops.length - (append ? 0 : existing) });
    }
    return;
  }
  if (program === "awk" || program === "gawk") {
    return c.risk("runs-program", p);
  }
  if (WRITE_PROGRAMS.has(program)) {
    return c.risk("writes-files", { count: Math.max(1, ops.length) });
  }
  if (OVERWRITE_PROGRAMS.has(program)) {
    return c.risk("overwrites-files", { count: program === "dd" ? 1 : Math.max(1, ops.length) });
  }
  if (PERMISSION_PROGRAMS.has(program)) {
    const recursive = hasFlag(args, /^(-R|--recursive)$/);
    return c.risk("changes-permissions", { count: c.count(ops.slice(1), recursive) });
  }
  if (PROCESS_PROGRAMS.has(program)) {
    return c.risk("process-control", p);
  }
  if (NETWORK_PROGRAMS.has(program)) {
    return c.risk("network", p);
  }
  if (PACKAGE_RUNNERS.has(program)) {
    c.risk("installs-packages", { manager: program });
    c.risk("network", p);
    return c.risk("runs-program", p);
  }
  const installs = PACKAGE_INSTALL[program];
  if (installs) {
    const sub = ops[0]?.value ?? (program === "pacman" ? (args[0]?.value ?? "") : "");
    if (installs.has(sub) || (program === "pacman" && installs.has(args[0]?.value ?? ""))) {
      c.risk("installs-packages", { manager: program });
      return c.risk("network", p);
    }
    return c.risk("runs-program", p);
  }
  c.risk("runs-program", p);
}

/** Classify one submitted command line. */
export function classifyLine(line: string, opts: ClassifyOptions = {}): LineClass {
  const c = new Collector(opts);
  const analyzeLine = (text: string, depth: number) => {
    if (depth > MAX_NESTING) {
      return c.refuse("eval-refused");
    }
    const parsed = parseShellLine(text);
    if (!parsed.ok) {
      if (parsed.reason !== "empty") {
        c.refuse("unparsed", { construct: parsed.reason });
      }
      return;
    }
    if (parsed.substitution) {
      return c.refuse("substitution-refused");
    }
    if (parsed.heredoc) {
      return c.refuse("unparsed", { construct: "heredoc" });
    }
    for (const cmd of parsed.commands) {
      cmd.assignments.forEach((w) => checkAssignment(c, w));
      for (const r of cmd.redirects) {
        if (!OUTPUT_REDIRECTS.has(r.op) || !r.target || r.target.value === "/dev/null") {
          continue;
        }
        const truncates = TRUNCATING_REDIRECTS.has(r.op) && c.exists(r.target);
        c.risk(truncates ? "overwrites-files" : "writes-files", { count: 1 });
      }
      analyzeWords(cmd.words, c, depth, analyzeLine);
      if (cmd.terminator === "&") {
        c.risk("background-job");
      }
      if (c.refusal) {
        return;
      }
    }
  };
  analyzeLine(line, 0);
  const risks = c.sortedRisks();
  const readOnly = c.refusal === null && c.readOnly && risks.length === 0;
  if (!readOnly && risks.length === 0 && c.refusal === null) {
    risks.push({ code: "runs-program", params: { program: c.programs[0] ?? "sh" } });
  }
  if (c.printsEnv && !risks.some((r) => r.code === "prints-environment") && !readOnly) {
    risks.push({ code: "prints-environment" });
  }
  return { refusal: c.refusal, readOnly, risks, printsEnv: c.printsEnv, programs: c.programs };
}
