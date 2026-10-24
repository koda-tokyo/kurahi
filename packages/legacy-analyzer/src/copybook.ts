// COPY resolution. `COPY name [OF|IN library] [SUPPRESS] [REPLACING a BY b ...].` is replaced by
// the copybook's tokens, which keep their own file and line. REPLACING supports pseudo-text
// (==...==), single words and literals matched as whole tokens, LEADING/TRAILING on words, and
// `:TAG:` substitution inside words. The REPLACE statement is not supported (reported).

import type { CopyUse, Diagnostic, Token } from "./types.js";
import { readCodeStream } from "./source.js";
import { tokenize } from "./tokenizer.js";

export type CopyResolver = (
  name: string,
  library?: string,
) => { file: string; content: string } | null;

type Replacement = { mode: "full" | "leading" | "trailing"; from: Token[]; to: Token[] };

const MAX_DEPTH = 10;

function readOperand(tokens: Token[], i: number): { seq: Token[]; next: number } | null {
  const t = tokens[i];
  if (!t) {
    return null;
  }
  if (t.kind === "pseudo") {
    const seq: Token[] = [];
    let j = i + 1;
    while (j < tokens.length && tokens[j].kind !== "pseudo") {
      seq.push(tokens[j]);
      j++;
    }
    return { seq, next: j + 1 };
  }
  if (t.kind === "period") {
    return null;
  }
  return { seq: [t], next: i + 1 };
}

function sameToken(a: Token, b: Token): boolean {
  return a.kind === b.kind && (a.kind === "word" ? a.value === b.value : a.raw === b.raw);
}

function relocate(seq: Token[], at: Token): Token[] {
  return seq.map((t) => ({ ...t, file: at.file, line: at.line, col: at.col }));
}

export function applyReplacing(tokens: Token[], reps: Replacement[]): Token[] {
  if (reps.length === 0) {
    return tokens;
  }
  const out: Token[] = [];
  let i = 0;
  outer: while (i < tokens.length) {
    for (const r of reps) {
      if (r.mode !== "full" || r.from.length === 0) {
        continue;
      }
      if (r.from.every((f, k) => tokens[i + k] && sameToken(tokens[i + k], f))) {
        out.push(...relocate(r.to, tokens[i]));
        i += r.from.length;
        continue outer;
      }
    }
    let t = tokens[i];
    if (t.kind === "word") {
      for (const r of reps) {
        const from = r.from.length === 1 && r.from[0].kind === "word" ? r.from[0].value : null;
        const to = r.to.map((x) => x.raw.toUpperCase()).join("");
        if (!from) {
          continue;
        }
        let v = t.value;
        if (r.mode === "leading" && v.startsWith(from) && v !== from) {
          v = to + v.slice(from.length);
        } else if (r.mode === "trailing" && v.endsWith(from) && v !== from) {
          v = v.slice(0, v.length - from.length) + to;
        } else if (
          r.mode === "full" &&
          from.startsWith(":") &&
          from.endsWith(":") &&
          v.includes(from)
        ) {
          v = v.split(from).join(to);
        }
        if (v !== t.value) {
          // Replaced text is not examined again by later operands.
          t = { ...t, value: v, raw: v };
          break;
        }
      }
    }
    out.push(t);
    i++;
  }
  return out;
}

export type ExpandResult = { tokens: Token[]; copies: CopyUse[]; diagnostics: Diagnostic[] };

/** Expand COPY statements in `tokens` (recursively, with a depth limit and cycle check). */
export function expandCopies(
  tokens: Token[],
  resolve: CopyResolver,
  stack: string[] = [],
): ExpandResult {
  const out: Token[] = [];
  const copies: CopyUse[] = [];
  const diagnostics: Diagnostic[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind === "word" && t.value === "REPLACE" && tokens[i + 1]?.kind === "pseudo") {
      diagnostics.push({
        file: t.file,
        line: t.line,
        severity: "warning",
        message: "REPLACE statement is not supported; text is analysed as written.",
      });
    }
    if (
      !(t.kind === "word" && t.value === "COPY" && tokens[i + 1] && tokens[i + 1].kind !== "period")
    ) {
      out.push(t);
      i++;
      continue;
    }
    const nameTok = tokens[i + 1];
    const name = nameTok.kind === "str" ? nameTok.value.toUpperCase() : nameTok.value;
    let j = i + 2;
    let library: string | undefined;
    if (tokens[j]?.kind === "word" && (tokens[j].value === "OF" || tokens[j].value === "IN")) {
      const lib = tokens[j + 1];
      library = lib ? (lib.kind === "str" ? lib.value : lib.value) : undefined;
      j += 2;
    }
    if (tokens[j]?.value === "SUPPRESS") {
      j++;
    }
    const reps: Replacement[] = [];
    if (tokens[j]?.kind === "word" && tokens[j].value === "REPLACING") {
      j++;
      while (j < tokens.length && tokens[j].kind !== "period") {
        let mode: Replacement["mode"] = "full";
        if (
          tokens[j].kind === "word" &&
          (tokens[j].value === "LEADING" || tokens[j].value === "TRAILING")
        ) {
          mode = tokens[j].value === "LEADING" ? "leading" : "trailing";
          j++;
        }
        const from = readOperand(tokens, j);
        if (!from || tokens[from.next]?.value !== "BY") {
          break;
        }
        const to = readOperand(tokens, from.next + 1);
        if (!to) {
          break;
        }
        reps.push({ mode, from: from.seq, to: to.seq });
        j = to.next;
      }
    }
    while (j < tokens.length && tokens[j].kind !== "period") {
      j++;
    }
    const use: CopyUse = {
      file: t.file,
      line: t.line,
      name,
      replacing: reps.map((r) => ({
        from:
          (r.mode === "full" ? "" : `${r.mode.toUpperCase()} `) +
          r.from.map((x) => x.raw).join(" "),
        to: r.to.map((x) => x.raw).join(" "),
      })),
    };
    copies.push(use);
    i = j + 1; // skip the COPY statement including its period
    const key = `${library ?? ""}/${name}`;
    if (stack.includes(key) || stack.length >= MAX_DEPTH) {
      diagnostics.push({
        file: t.file,
        line: t.line,
        severity: "error",
        message: `COPY ${name}: ${stack.includes(key) ? "recursive copy" : "nesting too deep"}; not expanded.`,
      });
      continue;
    }
    const found = resolve(name, library);
    if (!found) {
      diagnostics.push({
        file: t.file,
        line: t.line,
        severity: "warning",
        message: `COPY ${name}: copybook not found; its contents are not analysed.`,
      });
      continue;
    }
    use.resolved = found.file;
    const inner = tokenize(readCodeStream(found.file, found.content));
    const nested = expandCopies(inner, resolve, [...stack, key]);
    copies.push(...nested.copies);
    diagnostics.push(...nested.diagnostics);
    out.push(...applyReplacing(nested.tokens, reps));
  }
  return { tokens: out, copies, diagnostics };
}
