// Java tokenizer: identifiers, literals and punctuation with their 1-based line. Comments are
// dropped (a Javadoc comment's first sentence is kept on the token that follows it); string,
// text-block and char literals become single tokens, so braces or keywords inside them never
// confuse the declaration parser. `>` is always a single token, which keeps generic types such
// as `Map<String, List<Long>>` balanced.

export type JTokKind = "id" | "num" | "str" | "chr" | "op";

export type JTok = {
  k: JTokKind;
  /** Identifier or operator text; a literal's content (escapes kept as written). */
  v: string;
  line: number;
  /** First sentence of a Javadoc comment just before this token. */
  doc?: string;
};

const MULTI_OPS = ["...", "::", "->"];

function docSentence(raw: string): string | undefined {
  const body = raw
    .replace(/^\/\*\*/, "")
    .replace(/\*\/$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\*\s?/, "").trim())
    .filter((l) => l && !l.startsWith("@"))
    .join(" ")
    .replace(/<[^>]+>/g, "")
    .replace(/\{@\w+\s+([^}]*)\}/g, "$1")
    .trim();
  if (!body) {
    return undefined;
  }
  const m = /^(.+?[.。])(\s|$)/.exec(body);
  return (m ? m[1] : body).slice(0, 200);
}

export function lexJava(text: string): { tokens: JTok[]; unterminated: number[] } {
  const tokens: JTok[] = [];
  const unterminated: number[] = [];
  let i = 0;
  let line = 1;
  let pendingDoc: string | undefined;
  const n = text.length;
  const push = (t: JTok) => {
    if (pendingDoc) {
      t.doc = pendingDoc;
      pendingDoc = undefined;
    }
    tokens.push(t);
  };
  while (i < n) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "\f") {
      i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      const raw = text.slice(i, stop);
      if (raw.startsWith("/**") && raw !== "/**/") {
        pendingDoc = docSentence(raw);
      }
      if (end < 0) {
        unterminated.push(line);
      }
      for (const ch of raw) {
        if (ch === "\n") {
          line++;
        }
      }
      i = stop;
      continue;
    }
    if (c === '"' && text.startsWith('"""', i)) {
      // Text block: content starts after the line break that follows the opening quotes.
      const start = line;
      let j = i + 3;
      let body = "";
      while (j < n && !text.startsWith('"""', j)) {
        if (text[j] === "\\" && j + 1 < n) {
          body += text[j] + text[j + 1];
          if (text[j + 1] === "\n") {
            line++;
          }
          j += 2;
          continue;
        }
        if (text[j] === "\n") {
          line++;
        }
        body += text[j];
        j++;
      }
      if (j >= n) {
        unterminated.push(start);
      }
      push({ k: "str", v: body.replace(/^[^\n]*\n/, ""), line: start });
      i = j + 3;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let body = "";
      while (j < n && text[j] !== c && text[j] !== "\n") {
        if (text[j] === "\\" && j + 1 < n) {
          body += text[j] + text[j + 1];
          j += 2;
          continue;
        }
        body += text[j];
        j++;
      }
      if (text[j] !== c) {
        unterminated.push(line);
      }
      push({ k: c === '"' ? "str" : "chr", v: body, line });
      i = text[j] === c ? j + 1 : j;
      continue;
    }
    if (/[A-Za-z_$À-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$À-￿]/.test(text[j])) {
        j++;
      }
      push({ k: "id", v: text.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(text[j])) {
        // A '.' followed by a non-digit ends the number (method call on a literal is rare).
        if (text[j] === "." && !/[0-9]/.test(text[j + 1] ?? "")) {
          break;
        }
        j++;
      }
      push({ k: "num", v: text.slice(i, j), line });
      i = j;
      continue;
    }
    const multi = MULTI_OPS.find((op) => text.startsWith(op, i));
    if (multi) {
      push({ k: "op", v: multi, line });
      i += multi.length;
      continue;
    }
    push({ k: "op", v: c, line });
    i++;
  }
  return { tokens, unterminated };
}
