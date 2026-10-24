// FORTRAN source form: fixed form (FORTRAN 66/77: comment in column 1, label in 1-5,
// continuation in 6, statement text in 7-72, DEC tab format) and free form (Fortran 90+: `!`
// comments, `&` continuation). Both become logical statements with the line they start on and
// their label; `;` separates statements on one line. Text is upper-cased outside character
// literals, which keep their case (FILE='grid.dat'). Preprocessor lines (`#ifdef`, `#include`)
// are returned apart: they are reported, never evaluated, so both branches of `#ifdef` are read.

import path from "node:path";

export type FStmt = { text: string; line: number; label?: string };

const FIXED_EXT = new Set([".f", ".for", ".f77", ".ftn", ".fpp"]);
const FREE_EXT = new Set([".f90", ".f95", ".f03", ".f08", ".f18"]);

/** Fixed or free form, from the extension, else from the text (comment or label columns). */
export function fortranForm(file: string, text: string): "fixed" | "free" {
  const ext = path.extname(file).toLowerCase();
  if (FIXED_EXT.has(ext)) {
    return "fixed";
  }
  if (FREE_EXT.has(ext)) {
    return "free";
  }
  const lines = text.split("\n").slice(0, 200);
  const fixed = lines.filter((l) => /^[Cc*]/.test(l) || /^( {6}|\d{1,5}\s*\t| {5}\S)/.test(l));
  const free = lines.filter((l) => /&\s*(!.*)?$/.test(l) || /^\s{0,5}[A-Za-z]/.test(l));
  return fixed.length >= free.length ? "fixed" : "free";
}

type Quote = "'" | '"' | null;

/** Text before a `!` comment (outside literals), upper-cased outside literals; the open quote. */
function scan(text: string, open: Quote): { code: string; open: Quote } {
  let out = "";
  let q = open;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      out += c;
      if (c === q) {
        if (text[i + 1] === q) {
          out += c;
          i++;
        } else {
          q = null;
        }
      }
      continue;
    }
    if (c === "!") {
      break;
    }
    if (c === "'" || c === '"') {
      q = c;
    }
    out += c.toUpperCase();
  }
  return { code: out, open: q };
}

/** Split a logical line at `;` outside literals. */
function splitSemis(text: string): string[] {
  const out: string[] = [];
  let q: Quote = null;
  let cur = "";
  for (const c of text) {
    if (q) {
      if (c === q) {
        q = null;
      }
    } else if (c === "'" || c === '"') {
      q = c;
    } else if (c === ";") {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

export function fortranStatements(
  text: string,
  form: "fixed" | "free",
): {
  stmts: FStmt[];
  pre: Array<{ line: number; text: string }>;
  /** Full-line comments (text after the comment mark) and the lines that hold code. */
  comments: Map<number, string>;
  code: Set<number>;
} {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const stmts: FStmt[] = [];
  const pre: Array<{ line: number; text: string }> = [];
  const comments = new Map<number, string>();
  const codeLines = new Set<number>();
  let cur: { text: string; line: number; label?: string } | null = null;
  let open: Quote = null;
  const flush = () => {
    if (cur) {
      const parts = splitSemis(cur.text);
      parts.forEach((p, k) => {
        if (cur) {
          stmts.push({
            text: p,
            line: cur.line,
            ...(k === 0 && cur.label ? { label: cur.label } : {}),
          });
        }
      });
    }
    cur = null;
    open = null;
  };
  lines.forEach((raw, i) => {
    const line = i + 1;
    if (/^\s*#/.test(raw)) {
      pre.push({ line, text: raw.trim().slice(0, 120) });
      return;
    }
    if (form === "fixed") {
      if (/^[Cc*!Dd]/.test(raw) || raw.trim() === "") {
        if (/^[Cc*!]/.test(raw)) {
          comments.set(line, raw.slice(1).trim());
        }
        return;
      }
      codeLines.add(line);
      let label = "";
      let contChar = "";
      let body = "";
      const tab = raw.indexOf("\t");
      if (tab >= 0 && tab < 6) {
        label = raw.slice(0, tab).trim();
        const rest = raw.slice(tab + 1);
        if (/^[1-9]/.test(rest)) {
          contChar = rest[0];
          body = rest.slice(1);
        } else {
          body = rest;
        }
      } else {
        label = raw.slice(0, 5).trim();
        contChar = (raw[5] ?? " ").trim();
        body = raw.slice(6, 72);
      }
      const isCont = contChar !== "" && contChar !== "0";
      if (isCont && cur) {
        const r = scan(body, open);
        cur.text += r.code;
        open = r.open;
        return;
      }
      flush();
      const r = scan(body, null);
      open = r.open;
      if (r.code.trim() === "") {
        return;
      }
      cur = { text: r.code, line, ...(/^\d+$/.test(label) ? { label } : {}) };
      return;
    }
    // Free form.
    if (/^\s*!/.test(raw)) {
      comments.set(line, raw.replace(/^\s*!+/, "").trim());
      return;
    }
    if (raw.trim() !== "") {
      codeLines.add(line);
    }
    let body = raw;
    if (cur) {
      const m = /^\s*&/.exec(body);
      if (m) {
        body = body.slice(m[0].length);
      }
    }
    const r = scan(body, cur ? open : null);
    let code = r.code;
    const more = /&\s*$/.test(code);
    if (more) {
      code = code.replace(/&\s*$/, "");
    }
    if (cur) {
      cur.text += code;
    } else if (code.trim() !== "") {
      const m = /^\s*(\d{1,5})\s+/.exec(code);
      cur = m ? { text: code.slice(m[0].length), line, label: m[1] } : { text: code, line };
    }
    open = r.open;
    if (!more) {
      flush();
    }
  });
  flush();
  return { stmts, pre, comments, code: codeLines };
}

/** Top-level comma split (parentheses and literals respected). */
export function splitTop(text: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0;
  let q: Quote = null;
  let cur = "";
  for (const c of text) {
    if (q) {
      if (c === q) {
        q = null;
      }
    } else if (c === "'" || c === '"') {
      q = c;
    } else if (c === "(" || c === "[") {
      depth++;
    } else if (c === ")" || c === "]") {
      depth--;
    } else if (c === sep && depth === 0) {
      out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim() !== "") {
    out.push(cur.trim());
  }
  return out;
}

/** Index just past the parenthesis that closes the one at `start` (or -1). */
export function closeParen(text: string, start: number): number {
  let depth = 0;
  let q: Quote = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === q) {
        q = null;
      }
    } else if (c === "'" || c === '"') {
      q = c;
    } else if (c === "(") {
      depth++;
    } else if (c === ")") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

/** The literal's content when `s` is one quoted literal. */
export function literal(s: string | undefined): string | undefined {
  const m = /^\s*(['"])([\s\S]*)\1\s*$/.exec(s ?? "");
  return m ? m[2].replace(m[1] === "'" ? /''/g : /""/g, m[1]) : undefined;
}

/** Text with literals blanked out (for keyword and name searches). */
export function blankLiterals(s: string): string {
  return s.replace(/'(?:[^']|'')*'?|"(?:[^"]|"")*"?/g, (x) => " ".repeat(x.length));
}
