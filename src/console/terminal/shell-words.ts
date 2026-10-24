// A small POSIX shell lexer for the console terminal's line gate. It does not run or expand
// anything: it splits one command line into simple commands (words, assignments, redirections)
// and flags the constructs whose effect the line does not show (command or process
// substitution, here-documents, parameter expansion). The gate refuses or asks on those flags;
// it never guesses what an expansion yields.

export type ShellWord = {
  /** Text with quotes removed and escapes applied (expansions left as written). */
  value: string;
  /** Contains an unquoted or double-quoted `$` expansion. */
  expands: boolean;
  /** Contains an unquoted glob character (`*`, `?`, `[`). */
  glob: boolean;
  /** Starts with an unquoted `~`. */
  tilde: boolean;
};

export type ShellRedirect = {
  op: string;
  /** Target word; absent for fd duplication (`2>&1`, `>&-`). */
  target?: ShellWord;
};

export type SimpleCommand = {
  assignments: ShellWord[];
  words: ShellWord[];
  redirects: ShellRedirect[];
  /** Operator that ended this command (`|`, `&&`, `;`, `&`, …) or "" at the end of the line. */
  terminator: string;
};

export type ShellParse =
  | {
      ok: true;
      commands: SimpleCommand[];
      /** `$(…)`, backticks, `<(…)` or `>(…)` appear somewhere in the line. */
      substitution: boolean;
      /** A here-document (`<<`) appears: its body is not part of the line. */
      heredoc: boolean;
      /** Grouping with `(`…`)` or `{`…`}`. */
      grouping: boolean;
    }
  | { ok: false; reason: "unterminated-quote" | "trailing-escape" | "empty" };

const OPERATORS = ["||", "&&", "|&", ";;", "|", ";", "&", "(", ")"];
const REDIRECTS = ["&>>", "<<<", "<<-", ">>", ">|", "<>", "<<", ">&", "<&", "&>", ">", "<"];
const ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

type Token =
  | { kind: "word"; word: ShellWord }
  | { kind: "op"; value: string }
  | { kind: "redir"; value: string };

type WordBuilder = ShellWord & { started: boolean; unquoted: string };

function emptyWord(): WordBuilder {
  return { value: "", expands: false, glob: false, tilde: false, started: false, unquoted: "" };
}

// Brace expansion (`{a,b}`, `{1..3}`, `{..,.}/x`) turns one word into several paths.
const BRACE_RE = /\{[^{}]*(,|\.\.)[^{}]*\}/;

/** Lex a single line into words, operators and redirection operators. */
function lex(
  line: string,
):
  | { ok: true; tokens: Token[]; substitution: boolean }
  | { ok: false; reason: "unterminated-quote" | "trailing-escape" } {
  const tokens: Token[] = [];
  let substitution = false;
  let cur = emptyWord();
  const flush = () => {
    if (cur.started) {
      const { started: _started, unquoted, ...word } = cur;
      if (BRACE_RE.test(unquoted)) {
        word.expands = true;
      }
      tokens.push({ kind: "word", word });
    }
    cur = emptyWord();
  };
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      flush();
      if (ch === "\n" || ch === "\r") {
        tokens.push({ kind: "op", value: ";" });
      }
      i++;
      continue;
    }
    if (ch === "#" && !cur.started) {
      break;
    }
    if (ch === "\\") {
      if (i + 1 >= line.length) {
        return { ok: false, reason: "trailing-escape" };
      }
      cur.value += line[i + 1];
      cur.started = true;
      i += 2;
      continue;
    }
    if (ch === "'") {
      const end = line.indexOf("'", i + 1);
      if (end < 0) {
        return { ok: false, reason: "unterminated-quote" };
      }
      cur.value += line.slice(i + 1, end);
      cur.started = true;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let closed = false;
      while (j < line.length) {
        const c = line[j];
        if (c === "\\" && j + 1 < line.length && '$`"\\\n'.includes(line[j + 1])) {
          cur.value += line[j + 1];
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          break;
        }
        if (c === "`" || (c === "$" && line[j + 1] === "(")) {
          substitution = true;
        }
        if (c === "$") {
          cur.expands = true;
        }
        cur.value += c;
        j++;
      }
      if (!closed) {
        return { ok: false, reason: "unterminated-quote" };
      }
      cur.started = true;
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      substitution = true;
      cur.value += ch;
      cur.started = true;
      i++;
      continue;
    }
    if (ch === "$") {
      if (line[i + 1] === "(") {
        substitution = true;
      }
      cur.expands = true;
      cur.value += ch;
      cur.started = true;
      i++;
      continue;
    }
    if ((ch === "<" || ch === ">") && line[i + 1] === "(") {
      substitution = true;
      flush();
      tokens.push({ kind: "op", value: "(" });
      i += 2;
      continue;
    }
    const redir = REDIRECTS.find((r) => line.startsWith(r, i));
    if (redir) {
      // `2>` / `10>>`: a word made only of digits right before the operator is the fd.
      if (cur.started && /^\d+$/.test(cur.value) && !cur.expands) {
        cur = emptyWord();
      } else {
        flush();
      }
      tokens.push({ kind: "redir", value: redir });
      i += redir.length;
      continue;
    }
    const op = OPERATORS.find((o) => line.startsWith(o, i));
    if (op) {
      flush();
      tokens.push({ kind: "op", value: op });
      i += op.length;
      continue;
    }
    if (!cur.started && ch === "~") {
      cur.tilde = true;
    }
    if (ch === "*" || ch === "?" || ch === "[") {
      cur.glob = true;
    }
    cur.value += ch;
    cur.unquoted += ch;
    cur.started = true;
    i++;
  }
  flush();
  return { ok: true, tokens, substitution };
}

/** Split one command line into simple commands. */
export function parseShellLine(line: string): ShellParse {
  const lexed = lex(line);
  if (!lexed.ok) {
    return lexed;
  }
  const commands: SimpleCommand[] = [];
  let heredoc = false;
  let grouping = false;
  let cur: SimpleCommand = { assignments: [], words: [], redirects: [], terminator: "" };
  const push = (terminator: string) => {
    if (cur.words.length > 0 || cur.assignments.length > 0 || cur.redirects.length > 0) {
      cur.terminator = terminator;
      commands.push(cur);
    } else if (terminator === "&" && commands.length > 0) {
      commands[commands.length - 1].terminator = "&";
    }
    cur = { assignments: [], words: [], redirects: [], terminator: "" };
  };
  const tokens = lexed.tokens;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === "op") {
      if (t.value === "(" || t.value === ")") {
        grouping = true;
      }
      push(t.value);
      continue;
    }
    if (t.kind === "redir") {
      if (t.value.startsWith("<<") && t.value !== "<<<") {
        heredoc = true;
      }
      const next = tokens[i + 1];
      const target = next?.kind === "word" ? next.word : undefined;
      if (target) {
        i++;
      }
      const dup =
        (t.value === ">&" || t.value === "<&") && target && /^(\d+|-)$/.test(target.value);
      cur.redirects.push(dup ? { op: t.value } : { op: t.value, ...(target ? { target } : {}) });
      continue;
    }
    const word = t.word;
    if ((word.value === "{" || word.value === "}") && !word.expands) {
      grouping = true;
      continue;
    }
    if (cur.words.length === 0 && ASSIGNMENT_RE.test(word.value)) {
      cur.assignments.push(word);
      continue;
    }
    cur.words.push(word);
  }
  push("");
  if (commands.length === 0) {
    return { ok: false, reason: "empty" };
  }
  return { ok: true, commands, substitution: lexed.substitution, heredoc, grouping };
}

/** The value part of an assignment word (`NAME=value` → `value`). */
export function assignmentValue(word: ShellWord): string {
  const eq = word.value.indexOf("=");
  return eq >= 0 ? word.value.slice(eq + 1) : "";
}

export function basenameOf(program: string): string {
  const parts = program.split("/");
  return parts[parts.length - 1] ?? program;
}
