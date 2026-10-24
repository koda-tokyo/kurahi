// PL/I source to statements: `/* */` comments removed (kept apart for procedure purposes),
// character and bit literals kept, text upper-cased outside literals, statements ended by `;`.
// Mainframe sources with sequence numbers in columns 73-80 are read with MARGINS(2,72).

export type PStmt = {
  text: string;
  line: number;
  endLine: number;
  terminated: boolean;
  /** Offsets in `text` where a new source line starts. */
  breaks: number[];
};

/** Source line of an offset in a statement's text. */
export function lineOf(st: PStmt, offset: number): number {
  return st.line + st.breaks.filter((b) => b <= offset).length;
}

/** Sequence numbers in columns 73-80 on most long lines: read columns 2-72. */
export function hasMargins(lines: string[]): boolean {
  const long = lines.filter((l) => l.length > 72);
  return (
    long.length > 0 &&
    long.length * 2 >= lines.filter((l) => l.trim()).length &&
    long.filter((l) => /^[\dA-Z ]{1,8}$/.test(l.slice(72, 80))).length * 2 >= long.length
  );
}

export function pliStatements(text: string): {
  stmts: PStmt[];
  comments: Array<{ line: number; endLine: number; text: string }>;
  margins: boolean;
} {
  let lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const margins = hasMargins(lines);
  if (margins) {
    lines = lines.map((l) => ` ${l.slice(1, 72)}`);
  }
  const src = lines.join("\n");
  const stmts: PStmt[] = [];
  const comments: Array<{ line: number; endLine: number; text: string }> = [];
  let cur = "";
  let start = 0;
  let line = 1;
  let breaks: number[] = [];
  const push = (terminated: boolean) => {
    const lead = cur.length - cur.trimStart().length;
    const text = cur.trim();
    stmts.push({
      text,
      line: start,
      endLine: line,
      terminated,
      breaks: breaks.filter((b) => b > lead).map((b) => b - lead),
    });
  };
  const n = src.length;
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (c === "\n") {
      line++;
      breaks.push(cur.length);
      cur += " ";
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      const body = src.slice(i + 2, end < 0 ? n : end);
      const l0 = line;
      const nl = (body.match(/\n/g) ?? []).length;
      line += nl;
      for (let k = 0; k < nl; k++) {
        breaks.push(cur.length);
      }
      comments.push({ line: l0, endLine: line, text: body.replace(/\s+/g, " ").trim() });
      cur += " ";
      i = stop - 1;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (; j < n; j++) {
        if (src[j] === "\n") {
          line++;
          breaks.push(cur.length + (j - i));
        }
        if (src[j] === c) {
          if (src[j + 1] === c) {
            j++;
            continue;
          }
          break;
        }
      }
      if (cur.trim() === "") {
        start = line;
      }
      cur += src.slice(i, Math.min(j + 1, n)).replace(/\n/g, " ");
      i = j;
      continue;
    }
    if (c === ";") {
      if (cur.trim() !== "") {
        push(true);
      }
      cur = "";
      breaks = [];
      continue;
    }
    if (cur.trim() === "" && !/\s/.test(c)) {
      start = line;
    }
    cur += c.toUpperCase();
  }
  if (cur.trim() !== "") {
    push(false);
  }
  return { stmts, comments, margins };
}

/** Text with literals blanked out. */
export function blank(s: string): string {
  return s.replace(/'(?:[^']|'')*'?|"(?:[^"]|"")*"?/g, (x) => " ".repeat(x.length));
}

/** Top-level split on `sep` (parentheses and literals respected). */
export function split(text: string, sep = ","): string[] {
  return splitAt(text, sep).map((p) => p.text);
}

/** Top-level split with the offset of each piece's first character. */
export function splitAt(text: string, sep = ","): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let depth = 0;
  let q: string | null = null;
  let cur = "";
  const add = (end: number) => {
    const lead = cur.length - cur.trimStart().length;
    if (cur.trim() !== "") {
      out.push({ text: cur.trim(), at: end - cur.length + lead });
    }
  };
  for (let i = 0; i < text.length; i++) {
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
    } else if (c === sep && depth === 0) {
      add(i);
      cur = "";
      continue;
    }
    cur += c;
  }
  add(text.length);
  return out;
}

/** Index past the parenthesis closing the one at `start`, or -1. */
export function close(text: string, start: number): number {
  let depth = 0;
  const s = blank(text);
  for (let i = start; i < s.length; i++) {
    if (s[i] === "(") {
      depth++;
    } else if (s[i] === ")") {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
  }
  return -1;
}

/** Value of an option `NAME(value)` in a statement (first occurrence, outside literals). */
export function option(text: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*\\(`);
  const m = re.exec(blank(text));
  if (!m) {
    return undefined;
  }
  const open = m.index + m[0].length - 1;
  const end = close(text, open);
  return end < 0 ? undefined : text.slice(open + 1, end - 1).trim();
}
