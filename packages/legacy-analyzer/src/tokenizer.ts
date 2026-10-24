// COBOL tokenizer over a code stream. Separators are spaces, line breaks, and `,`/`;` followed
// by a space. A period followed by a space or line end is the separator period. The character
// string after PIC/PICTURE is one token (it may contain `,`, `.`, `(`, `)`).

import type { CodeStream } from "./source.js";
import type { Token } from "./types.js";

const WORD_CHAR = /[A-Za-z0-9\-_#@$]/;

function isSpace(ch: string | undefined): boolean {
  return ch === undefined || ch === " " || ch === "\n" || ch === "\t";
}

export function tokenize(stream: CodeStream): Token[] {
  const { text, lineAt, colAt, file } = stream;
  const tokens: Token[] = [];
  let i = 0;
  let picNext = false;
  let inExec = false;
  const make = (kind: Token["kind"], value: string, raw: string, at: number): Token => ({
    kind,
    value,
    raw,
    file,
    line: lineAt[at] ?? 0,
    col: colAt[at] ?? 0,
  });

  while (i < text.length) {
    const ch = text[i];
    if (isSpace(ch)) {
      i++;
      continue;
    }
    if ((ch === "," || ch === ";") && isSpace(text[i + 1])) {
      // Inside EXEC ... END-EXEC a comma separates SQL list items: keep it.
      if (inExec && ch === ",") {
        tokens.push(make("op", ",", ",", i));
      }
      i++;
      continue;
    }
    if (picNext) {
      // The PICTURE character string: up to the next space, minus a separator period.
      let j = i;
      while (j < text.length && !isSpace(text[j])) {
        j++;
      }
      let s = text.slice(i, j);
      const up = s.toUpperCase();
      if (up === "IS") {
        tokens.push(make("word", "IS", s, i));
        i = j;
        continue;
      }
      let endsSentence = false;
      if (s.endsWith(".") && s.length > 1) {
        s = s.slice(0, -1);
        endsSentence = true;
      }
      tokens.push(make("word", s.toUpperCase(), s, i));
      if (endsSentence) {
        tokens.push(make("period", ".", ".", j - 1));
      }
      picNext = false;
      i = j;
      continue;
    }
    // Alphanumeric, hex (X'..'), national (N'..') and null-terminated (Z'..') literals.
    const prefixed = /[XxNnZzGg]/.test(ch) && (text[i + 1] === "'" || text[i + 1] === '"') ? 1 : 0;
    const q = text[i + prefixed];
    if (q === "'" || q === '"') {
      let j = i + prefixed + 1;
      let value = "";
      while (j < text.length) {
        if (text[j] === q) {
          if (text[j + 1] === q) {
            value += q;
            j += 2;
            continue;
          }
          break;
        }
        value += text[j];
        j++;
      }
      const raw = text.slice(i, Math.min(j + 1, text.length));
      tokens.push(make("str", value, raw, i));
      i = j + 1;
      continue;
    }
    if (ch === "=" && text[i + 1] === "=") {
      tokens.push(make("pseudo", "==", "==", i));
      i += 2;
      continue;
    }
    if (ch === "." && isSpace(text[i + 1])) {
      tokens.push(make("period", ".", ".", i));
      i++;
      continue;
    }
    // Numeric literal: [+-]digits[.digits] or .digits (sign only after a separator or `(`).
    const prev = text[i - 1];
    const signOk =
      (ch === "+" || ch === "-") &&
      (isSpace(prev) || prev === "(") &&
      /[0-9.]/.test(text[i + 1] ?? "");
    if (/[0-9]/.test(ch) || signOk || (ch === "." && /[0-9]/.test(text[i + 1] ?? ""))) {
      let j = i + (signOk ? 1 : 0);
      while (j < text.length && /[0-9]/.test(text[j])) {
        j++;
      }
      if (text[j] === "." && /[0-9]/.test(text[j + 1] ?? "")) {
        j++;
        while (j < text.length && /[0-9]/.test(text[j])) {
          j++;
        }
      }
      // Digits followed by word characters form a word (e.g. paragraph 0000-MAIN, level 01 is
      // fine because a space follows).
      if (j < text.length && WORD_CHAR.test(text[j]) && !signOk) {
        let k = j;
        while (k < text.length && WORD_CHAR.test(text[k])) {
          k++;
        }
        const raw = text.slice(i, k);
        tokens.push(make("word", raw.toUpperCase(), raw, i));
        i = k;
        continue;
      }
      const raw = text.slice(i, j);
      tokens.push(make("num", raw, raw, i));
      i = j;
      continue;
    }
    if (ch === ":" && /[A-Za-z]/.test(text[i + 1] ?? "")) {
      // `:TAG:` for COPY REPLACING, `:HOST-VAR` in EXEC SQL.
      let j = i + 1;
      while (j < text.length && WORD_CHAR.test(text[j])) {
        j++;
      }
      if (text[j] === ":") {
        j++;
        while (j < text.length && WORD_CHAR.test(text[j])) {
          j++;
        }
      }
      const raw = text.slice(i, j);
      tokens.push(make("word", raw.toUpperCase(), raw, i));
      i = j;
      continue;
    }
    if (WORD_CHAR.test(ch)) {
      let j = i;
      while (j < text.length && WORD_CHAR.test(text[j])) {
        j++;
      }
      const raw = text.slice(i, j);
      const value = raw.toUpperCase();
      tokens.push(make("word", value, raw, i));
      if ((value === "PIC" || value === "PICTURE") && !inExec) {
        picNext = true;
      } else if (value === "EXEC") {
        inExec = true;
      } else if (value === "END-EXEC") {
        inExec = false;
      }
      i = j;
      continue;
    }
    // Operators.
    const two = text.slice(i, i + 2);
    if (two === "**" || two === ">=" || two === "<=" || two === "<>") {
      tokens.push(make("op", two, two, i));
      i += 2;
      continue;
    }
    tokens.push(make("op", ch, ch, i));
    i++;
  }
  return tokens;
}

/** Text of a token run, rebuilt with single spaces (for conditions and expressions). */
export function joinTokens(tokens: Token[]): string {
  let out = "";
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const piece = t.raw;
    const prev = tokens[k - 1];
    const adjacent =
      prev !== undefined && prev.line === t.line && t.col === prev.col + prev.raw.length;
    const tight =
      prev !== undefined &&
      (prev.raw === "(" ||
        t.raw === ")" ||
        t.raw === ":" ||
        prev.raw === ":" ||
        (t.raw === "(" && adjacent));
    out += out.length === 0 || tight ? piece : ` ${piece}`;
  }
  return out;
}
