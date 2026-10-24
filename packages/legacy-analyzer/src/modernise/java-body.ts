// Method-body scanning for the Java engine: call sites (bare, qualified, `new`, method
// references), SQL in string literals (adjacent literals joined with `+`), identifier references
// (for SQL held in constants) and the constructs the engine does not model inside a body
// (anonymous and local classes: their calls are attributed to the enclosing method).

import type { JTok } from "./java-lexer.js";
import type { EngineGap, JavaCall, SqlUse } from "./types.js";
import { looksLikeSql, sqlTables } from "./sql-text.js";

const NOT_CALLS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "synchronized",
  "return",
  "throw",
  "try",
  "do",
  "else",
  "case",
  "assert",
  "yield",
]);

/** Index of the token that closes the bracket opened at `open` (or the last index). */
export function matching(toks: JTok[], open: number, end = toks.length): number {
  const o = toks[open].v;
  const c = o === "(" ? ")" : o === "[" ? "]" : o === "{" ? "}" : ">";
  let depth = 0;
  for (let k = open; k < end; k++) {
    const v = toks[k].k === "op" ? toks[k].v : "";
    if (v === o) {
      depth++;
    } else if (v === c) {
      depth--;
      if (depth === 0) {
        return k;
      }
    }
  }
  return end - 1;
}

/** Top-level argument count of the call whose `(` is at `open`. */
function argCount(toks: JTok[], open: number, close: number): number {
  if (close === open + 1) {
    return 0;
  }
  let depth = 0;
  let n = 1;
  for (let k = open + 1; k < close; k++) {
    const v = toks[k].k === "op" ? toks[k].v : "";
    if (v === "(" || v === "[" || v === "{") {
      depth++;
    } else if (v === ")" || v === "]" || v === "}") {
      depth--;
    } else if (v === "," && depth === 0) {
      n++;
    }
  }
  return n;
}

/** The dotted receiver ending just before `toks[k]` (which is a `.`), or "<expr>". */
function qualifierBefore(toks: JTok[], k: number, start: number): string {
  const parts: string[] = [];
  let j = k;
  while (j > start && toks[j].v === "." && toks[j - 1].k === "id") {
    parts.unshift(toks[j - 1].v);
    j -= 2;
  }
  if (parts.length === 0 || (j >= start && (toks[j].v === ")" || toks[j].v === "]"))) {
    return parts.length === 0 ? "<expr>" : `<expr>.${parts.join(".")}`;
  }
  return parts.join(".");
}

export type BodyFacts = {
  calls: JavaCall[];
  sql: SqlUse[];
  refs: Array<{ name: string; file: string; line: number }>;
  gaps: EngineGap[];
};

/** Facts of the tokens `toks[start..end)` (the inside of a method or initializer body). */
export function scanBody(file: string, toks: JTok[], start: number, end: number): BodyFacts {
  const calls: JavaCall[] = [];
  const sql: SqlUse[] = [];
  const refs: BodyFacts["refs"] = [];
  const gaps: EngineGap[] = [];
  const joined = new Set<number>();
  for (let k = start; k < end; k++) {
    const t = toks[k];
    if (t.k === "str" && joined.has(k)) {
      continue;
    }
    if (t.k === "str") {
      // Adjacent literals joined with '+'; a non-literal operand makes the text partial.
      let text = t.v;
      let j = k + 1;
      let partial = false;
      while (j + 1 < end && toks[j].v === "+") {
        if (toks[j + 1].k === "str") {
          text += toks[j + 1].v;
          joined.add(j + 1);
          j += 2;
          continue;
        }
        // A non-literal operand (identifier chain, call): skipped, the text becomes partial.
        partial = true;
        let q = j + 1;
        while (q < end && (toks[q].k === "id" || toks[q].v === ".")) {
          q++;
        }
        if (toks[q]?.v === "(") {
          q = matching(toks, q, end) + 1;
        }
        if (q === j + 1) {
          break;
        }
        j = q;
      }
      if (k > start && toks[k - 1].v === "+" && toks[k - 2]?.k !== "str") {
        partial = true;
      }
      const clean = text.replace(/\\[nrt]/g, " ").replace(/\\(["'\\])/g, "$1");
      if (looksLikeSql(clean)) {
        const { op, tables } = sqlTables(clean);
        sql.push({
          file,
          line: t.line,
          text: clean.replace(/\s+/g, " ").trim(),
          op,
          tables,
          via: "jdbc",
          ...(partial ? { partial: true } : {}),
        });
      }
      continue;
    }
    if (t.k !== "id") {
      continue;
    }
    const next = toks[k + 1];
    const prev = toks[k - 1];
    if (
      (t.v === "class" || t.v === "interface" || t.v === "enum") &&
      toks[k + 1]?.k === "id" &&
      prev?.v !== "."
    ) {
      gaps.push({
        file,
        line: t.line,
        construct: `local ${t.v}`,
        detail: `Local ${t.v} ${toks[k + 1].v}: its members are not modelled; its calls count for the enclosing method.`,
      });
      continue;
    }
    if (t.v === "new" && next?.k === "id") {
      let j = k + 1;
      const name: string[] = [];
      while (toks[j]?.k === "id") {
        name.push(toks[j].v);
        if (toks[j + 1]?.v !== ".") {
          j++;
          break;
        }
        j += 2;
      }
      if (toks[j]?.v === "<") {
        j = matching(toks, j, end) + 1;
      }
      if (toks[j]?.v === "(") {
        const close = matching(toks, j, end);
        calls.push({
          file,
          line: t.line,
          name: name[name.length - 1],
          ...(name.length > 1 ? { qualifier: name.slice(0, -1).join(".") } : {}),
          args: argCount(toks, j, close),
          form: "new",
        });
        if (toks[close + 1]?.v === "{") {
          gaps.push({
            file,
            line: t.line,
            construct: "anonymous class",
            detail: `Anonymous ${name.join(".")}: its methods are not modelled; their calls count for the enclosing method.`,
          });
        }
        k = j;
      }
      continue;
    }
    if (prev?.v === "::") {
      const parts: string[] = [];
      let j = k - 2;
      while (j >= start && toks[j].k === "id") {
        parts.unshift(toks[j].v);
        if (toks[j - 1]?.v !== ".") {
          break;
        }
        j -= 2;
      }
      const qualifier = parts.length > 0 ? parts.join(".") : "<expr>";
      calls.push({ file, line: t.line, name: t.v, qualifier, args: -1, form: "ref" });
      continue;
    }
    if (next?.v === "(" && !NOT_CALLS.has(t.v) && prev?.v !== "@") {
      const close = matching(toks, k + 1, end);
      const qualifier = prev?.v === "." ? qualifierBefore(toks, k - 1, start) : undefined;
      calls.push({
        file,
        line: t.line,
        name: t.v,
        ...(qualifier ? { qualifier } : {}),
        args: argCount(toks, k + 1, close),
        form: "call",
      });
      continue;
    }
    if (prev?.v !== "." && /^[A-Z][A-Z0-9_]*$/.test(t.v)) {
      refs.push({ name: t.v, file, line: t.line });
    }
  }
  return { calls, sql, refs, gaps };
}
