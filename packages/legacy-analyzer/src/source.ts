// Source reader: turns a COBOL or copybook file into one code stream with a position map.
//
// Fixed format (the default): columns 1-6 are the sequence area, column 7 the indicator,
// columns 8-72 the program text, 73+ the identification area. Indicator `*` or `/` marks a
// comment line, `D` a debugging line (treated as a comment), `-` a continuation line. A
// continued alphanumeric literal runs to column 72 inclusive and resumes after the first
// quote of the continuation line; a continued word resumes at the first non-blank character.
// Free format is used when the file says `>>SOURCE FORMAT FREE`; then `*>` starts a comment.

export type CommentLine = { line: number; text: string };

export type CodeStream = {
  file: string;
  text: string;
  /** For each character of `text`: its 1-based source line. */
  lineAt: Int32Array;
  /** For each character of `text`: its 1-based source column. */
  colAt: Int32Array;
  comments: CommentLine[];
  /** Physical lines as written (for quoting exact source text). */
  physical: string[];
  format: "fixed" | "free";
};

const FREE_DIRECTIVE = /^\s*>>\s*SOURCE\s+(FORMAT\s+)?(IS\s+)?FREE\b/i;

function stripInlineComment(s: string): { code: string; comment?: string } {
  // `*>` outside a literal starts an inline comment.
  let quote: string | null = null;
  for (let i = 0; i < s.length - 1; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (ch === "*" && s[i + 1] === ">") {
      return { code: s.slice(0, i), comment: s.slice(i + 2).trim() };
    }
  }
  return { code: s };
}

/** The quote character of a literal left open at the end of `s`, or null. */
export function openLiteralAtEnd(s: string): string | null {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) {
        if (s[i + 1] === quote) {
          i++;
        } else {
          quote = null;
        }
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    }
  }
  return quote;
}

export function detectFormat(lines: string[]): "fixed" | "free" {
  for (const l of lines.slice(0, 50)) {
    if (FREE_DIRECTIVE.test(l)) {
      return "free";
    }
  }
  return "fixed";
}

export function readCodeStream(
  file: string,
  content: string,
  format?: "fixed" | "free",
): CodeStream {
  const physical = content.replace(/\r\n?/g, "\n").split("\n");
  if (physical.length > 0 && physical[physical.length - 1] === "") {
    physical.pop();
  }
  const fmt = format ?? detectFormat(physical);
  const chars: string[] = [];
  const lineAt: number[] = [];
  const colAt: number[] = [];
  const comments: CommentLine[] = [];

  const push = (s: string, line: number, startCol: number) => {
    for (let i = 0; i < s.length; i++) {
      chars.push(s[i]);
      lineAt.push(line);
      colAt.push(startCol + i);
    }
  };
  const newline = (line: number) => {
    chars.push("\n");
    lineAt.push(line);
    colAt.push(0);
  };

  for (let idx = 0; idx < physical.length; idx++) {
    const lineNo = idx + 1;
    const raw = physical[idx].replace(/\t/g, "    ");
    if (/^\s*>>/.test(raw) || /^\s*\$\s*SET\b/i.test(raw)) {
      newline(lineNo); // compiler directive: not program text
      continue;
    }
    if (fmt === "free") {
      const trimmed = raw.trimStart();
      if (trimmed.startsWith("*>")) {
        comments.push({ line: lineNo, text: trimmed.slice(2).trim() });
        newline(lineNo);
        continue;
      }
      const { code, comment } = stripInlineComment(raw);
      if (comment) {
        comments.push({ line: lineNo, text: comment });
      }
      push(code.trimEnd(), lineNo, 1);
      newline(lineNo);
      continue;
    }
    const indicator = raw.length >= 7 ? raw[6] : " ";
    const area = raw.length > 7 ? raw.slice(7, 72) : "";
    if (indicator === "*" || indicator === "/" || indicator === "D" || indicator === "d") {
      comments.push({ line: lineNo, text: area.trim() });
      newline(lineNo);
      continue;
    }
    const { code, comment } = stripInlineComment(area);
    if (comment) {
      comments.push({ line: lineNo, text: comment });
    }
    if (indicator === "-") {
      // Remove the line break pushed after the previous code line, then join.
      while (chars.length > 0 && chars[chars.length - 1] === "\n") {
        chars.pop();
        lineAt.pop();
        colAt.pop();
      }
      // Recover the previous code line to see whether a literal was left open.
      let start = chars.length;
      while (start > 0 && chars[start - 1] !== "\n") {
        start--;
      }
      const prev = chars.slice(start).join("");
      const quote = openLiteralAtEnd(prev);
      const lead = code.length - code.trimStart().length;
      let rest = code.trimStart();
      let col = 8 + lead;
      if (quote) {
        // Literal continuation: the previous line's literal ran to column 72.
        const prevLine = lineAt[chars.length - 1] ?? lineNo;
        const prevArea = physical[prevLine - 1]?.replace(/\t/g, "    ").slice(7, 72) ?? "";
        const pad = Math.max(0, 65 - prevArea.length);
        push(" ".repeat(pad), prevLine, 73 - pad);
        if (rest.startsWith(quote)) {
          rest = rest.slice(1);
          col += 1;
        }
        // A literal may be continued again: keep its trailing spaces while it stays open.
        push(openLiteralAtEnd(quote + rest) ? rest : rest.trimEnd(), lineNo, col);
      } else {
        push(openLiteralAtEnd(prev + rest) ? rest : rest.trimEnd(), lineNo, col);
      }
      newline(lineNo);
      continue;
    }
    // A normal line keeps trailing spaces only while a literal is open (it may be continued).
    const keep = openLiteralAtEnd(code) ? code : code.trimEnd();
    push(keep, lineNo, 8);
    newline(lineNo);
  }

  return {
    file,
    text: chars.join(""),
    lineAt: Int32Array.from(lineAt),
    colAt: Int32Array.from(colAt),
    comments,
    physical,
    format: fmt,
  };
}

/** Program text of lines `from`..`to` (1-based, inclusive), code area only, comments dropped. */
export function sourceText(
  stream: Pick<CodeStream, "physical" | "format">,
  from: number,
  to: number,
): string {
  const out: string[] = [];
  for (let n = from; n <= to && n <= stream.physical.length; n++) {
    const raw = stream.physical[n - 1] ?? "";
    if (stream.format === "free") {
      out.push(raw.trimEnd());
      continue;
    }
    const ind = raw[6];
    if (ind === "*" || ind === "/" || ind === "D" || ind === "d") {
      continue;
    }
    out.push(raw.slice(7, 72).trimEnd());
  }
  // Keep relative indentation, drop the common left margin.
  const margin = Math.min(
    ...out.filter((l) => l.trim().length > 0).map((l) => l.length - l.trimStart().length),
  );
  return out
    .map((l) => (Number.isFinite(margin) ? l.slice(margin) : l))
    .join("\n")
    .trim();
}
