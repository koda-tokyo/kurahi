// DATA DIVISION and FILE-CONTROL: data items with level, PIC, USAGE, VALUE, REDEFINES and
// OCCURS; 88-level condition names; SELECT and FD entries; byte lengths and offsets.

import type { DataItem, FileDef, Token } from "./types.js";

const FIGURATIVE = new Set([
  "ZERO",
  "ZEROS",
  "ZEROES",
  "SPACE",
  "SPACES",
  "HIGH-VALUE",
  "HIGH-VALUES",
  "LOW-VALUE",
  "LOW-VALUES",
  "QUOTE",
  "QUOTES",
  "NULL",
  "NULLS",
]);

const USAGE_WORDS = new Set([
  "COMP",
  "COMP-1",
  "COMP-2",
  "COMP-3",
  "COMP-4",
  "COMP-5",
  "COMPUTATIONAL",
  "COMPUTATIONAL-1",
  "COMPUTATIONAL-2",
  "COMPUTATIONAL-3",
  "COMPUTATIONAL-4",
  "COMPUTATIONAL-5",
  "BINARY",
  "PACKED-DECIMAL",
  "DISPLAY",
  "INDEX",
  "POINTER",
  "NATIONAL",
]);

const CLAUSE_WORDS = new Set([
  "REDEFINES",
  "PIC",
  "PICTURE",
  "USAGE",
  "VALUE",
  "VALUES",
  "OCCURS",
  "SIGN",
  "JUST",
  "JUSTIFIED",
  "BLANK",
  "SYNC",
  "SYNCHRONIZED",
  "EXTERNAL",
  "GLOBAL",
  "RENAMES",
  "IS",
  ...USAGE_WORDS,
]);

export function splitSentences(tokens: Token[]): Token[][] {
  const out: Token[][] = [];
  let cur: Token[] = [];
  for (const t of tokens) {
    if (t.kind === "period") {
      if (cur.length > 0) {
        out.push(cur);
      }
      cur = [];
    } else {
      cur.push(t);
    }
  }
  if (cur.length > 0) {
    out.push(cur);
  }
  return out;
}

function normaliseUsage(u: string): string {
  const map: Record<string, string> = {
    COMPUTATIONAL: "COMP",
    "COMPUTATIONAL-1": "COMP-1",
    "COMPUTATIONAL-2": "COMP-2",
    "COMPUTATIONAL-3": "COMP-3",
    "COMPUTATIONAL-4": "COMP-4",
    "COMPUTATIONAL-5": "COMP-5",
    "PACKED-DECIMAL": "COMP-3",
  };
  return map[u] ?? u;
}

export function expandPic(pic: string): string {
  return pic
    .toUpperCase()
    .replace(/(.)\((\d+)\)/g, (_m, ch: string, n: string) => ch.repeat(Number(n)));
}

export type PicInfo = {
  displayLength: number;
  numeric?: { digits: number; scale: number; signed: boolean };
};

export function picInfo(pic: string, signSeparate = false): PicInfo {
  const s = expandPic(pic);
  let len = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "S") {
      len += signSeparate ? 1 : 0;
    } else if (ch === "V" || ch === "P") {
      // assumed decimal point and scaling positions take no storage
    } else if ((ch === "C" && s[i + 1] === "R") || (ch === "D" && s[i + 1] === "B")) {
      len += 2;
      i++;
    } else if (ch === "N") {
      len += 2;
    } else {
      len += 1;
    }
  }
  if (/^S?[9P]*V?[9P]*$/.test(s) && s.includes("9")) {
    const [intPart, fracPart = ""] = s.replace("S", "").split("V");
    return {
      displayLength: len,
      numeric: {
        digits: (intPart.match(/9/g) ?? []).length + (fracPart.match(/9/g) ?? []).length,
        scale: (fracPart.match(/9/g) ?? []).length,
        signed: s.startsWith("S"),
      },
    };
  }
  return { displayLength: len };
}

/** Storage bytes of an elementary item, or undefined when it cannot be determined. */
export function storageLength(
  pic: string | undefined,
  usage: string | undefined,
  signSeparate = false,
): number | undefined {
  const u = usage ? normaliseUsage(usage) : "DISPLAY";
  if (u === "COMP-1") {
    return 4;
  }
  if (u === "COMP-2") {
    return 8;
  }
  if (u === "INDEX" || u === "POINTER") {
    return 4;
  }
  if (!pic) {
    return undefined;
  }
  const info = picInfo(pic, signSeparate);
  if (u === "COMP" || u === "COMP-4" || u === "COMP-5" || u === "BINARY") {
    const d = info.numeric?.digits ?? info.displayLength;
    return d <= 4 ? 2 : d <= 9 ? 4 : 8;
  }
  if (u === "COMP-3") {
    const d = info.numeric?.digits ?? info.displayLength;
    return Math.floor(d / 2) + 1;
  }
  return info.displayLength;
}

function literalText(t: Token): string {
  if (t.kind === "str") {
    return t.raw;
  }
  return t.raw.toUpperCase();
}

type Entry = DataItem & { signSeparate?: boolean; children: Entry[] };

/** Parse one data description entry (the tokens of one sentence). */
export function parseEntry(sentence: Token[], section: string): Entry | null {
  const first = sentence[0];
  if (!first || first.kind !== "num" || !/^\d{1,2}$/.test(first.raw)) {
    return null;
  }
  const level = Number(first.raw);
  if (!((level >= 1 && level <= 49) || level === 66 || level === 77 || level === 88)) {
    return null;
  }
  let i = 1;
  let name = "FILLER";
  if (sentence[1]?.kind === "word" && !CLAUSE_WORDS.has(sentence[1].value)) {
    name = sentence[1].value;
    i = 2;
  }
  const item: Entry = {
    file: first.file,
    line: first.line,
    level,
    name,
    path: [],
    section,
    text: "",
    children: [],
  };
  const values: string[] = [];
  const isClause = (t: Token | undefined) =>
    t?.kind === "word" && CLAUSE_WORDS.has(t.value) && t.value !== "IS";
  while (i < sentence.length) {
    const t = sentence[i];
    const v = t.kind === "word" ? t.value : "";
    if (v === "REDEFINES") {
      item.redefines = sentence[i + 1]?.value;
      i += 2;
    } else if (v === "PIC" || v === "PICTURE") {
      i++;
      if (sentence[i]?.value === "IS") {
        i++;
      }
      item.pic = sentence[i]?.raw.toUpperCase();
      i++;
    } else if (v === "USAGE") {
      i++;
      if (sentence[i]?.value === "IS") {
        i++;
      }
      if (sentence[i]) {
        item.usage = normaliseUsage(sentence[i].value);
      }
      i++;
    } else if (USAGE_WORDS.has(v)) {
      item.usage = normaliseUsage(v);
      i++;
    } else if (v === "VALUE" || v === "VALUES") {
      i++;
      if (sentence[i]?.value === "IS" || sentence[i]?.value === "ARE") {
        i++;
      }
      while (i < sentence.length && !isClause(sentence[i])) {
        const lt = sentence[i];
        if (lt.kind === "word" && (lt.value === "THRU" || lt.value === "THROUGH")) {
          const hi = sentence[i + 1];
          if (hi) {
            if (level === 88) {
              values[values.length - 1] = `${values[values.length - 1]} THRU ${literalText(hi)}`;
            } else {
              item.valueThru = literalText(hi);
            }
          }
          i += 2;
          continue;
        }
        if (lt.kind === "word" && lt.value === "ALL" && sentence[i + 1]) {
          values.push(`ALL ${literalText(sentence[i + 1])}`);
          i += 2;
          continue;
        }
        if (
          lt.kind === "str" ||
          lt.kind === "num" ||
          (lt.kind === "word" && FIGURATIVE.has(lt.value))
        ) {
          values.push(literalText(lt));
        }
        i++;
      }
    } else if (v === "OCCURS") {
      const min = Number(sentence[i + 1]?.raw ?? "1");
      let max = min;
      i += 2;
      if (sentence[i]?.value === "TO") {
        max = Number(sentence[i + 1]?.raw ?? String(min));
        i += 2;
      }
      item.occurs = { min, max };
      while (i < sentence.length && !isClause(sentence[i])) {
        if (sentence[i].value === "DEPENDING") {
          let k = i + 1;
          if (sentence[k]?.value === "ON") {
            k++;
          }
          item.occurs.dependingOn = sentence[k]?.value;
          i = k + 1;
          continue;
        }
        i++;
      }
    } else if (v === "SIGN") {
      i++;
      while (i < sentence.length && !isClause(sentence[i])) {
        if (sentence[i].value === "SEPARATE") {
          item.signSeparate = true;
        }
        i++;
      }
    } else if (v === "RENAMES") {
      item.redefines = undefined;
      item.description = `RENAMES ${sentence
        .slice(i + 1)
        .map((x) => x.raw)
        .join(" ")}`;
      break;
    } else {
      i++;
    }
  }
  if (level === 88) {
    item.conditionValues = values;
  } else if (values.length > 0) {
    item.value = values;
  }
  return item;
}

function layout(node: Entry, offset: number, usage: string | undefined): number | undefined {
  const effUsage = node.usage ?? usage;
  node.offset = offset;
  if (
    node.pic ||
    effUsage === "COMP-1" ||
    effUsage === "COMP-2" ||
    effUsage === "INDEX" ||
    effUsage === "POINTER"
  ) {
    node.length = storageLength(node.pic, effUsage, node.signSeparate);
    if (node.pic) {
      const info = picInfo(node.pic, node.signSeparate);
      if (info.numeric) {
        node.numeric = info.numeric;
      }
    }
    return node.length;
  }
  const kids = node.children.filter((c) => c.level !== 88 && c.level !== 66);
  if (kids.length === 0) {
    return undefined;
  }
  let cursor = offset;
  let known = true;
  const starts = new Map<string, number>();
  for (const c of kids) {
    const start =
      c.redefines && starts.has(c.redefines) ? (starts.get(c.redefines) as number) : cursor;
    const len = layout(c, start, effUsage);
    starts.set(c.name, start);
    if (len === undefined) {
      known = false;
    }
    if (!c.redefines && len !== undefined) {
      cursor = start + len * (c.occurs?.max ?? 1);
    }
  }
  node.length = known ? cursor - offset : undefined;
  return node.length;
}

/** Build data items from data-division sentences, with the hierarchy, lengths and offsets. */
export function buildDataItems(
  sentences: Array<{ tokens: Token[]; section: string; fd?: string }>,
  onRecord?: (fd: string, record: string) => void,
): DataItem[] {
  const all: Entry[] = [];
  const roots: Entry[] = [];
  const stack: Entry[] = [];
  let lastNon88: Entry | undefined;
  for (const s of sentences) {
    const e = parseEntry(s.tokens, s.section);
    if (!e) {
      continue;
    }
    const last = s.tokens[s.tokens.length - 1];
    e.endLine = last.file === e.file ? last.line : e.line;
    if (e.level === 88) {
      if (lastNon88) {
        e.parent = lastNon88.name;
        e.path = [...lastNon88.path, e.name];
        lastNon88.children.push(e);
      }
      all.push(e);
      continue;
    }
    if (e.level === 1 || e.level === 77 || e.level === 66) {
      stack.length = 0;
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= e.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent && e.level !== 66) {
      e.parent = parent.name;
      e.path = [...parent.path, e.name];
      parent.children.push(e);
    } else {
      e.path = [e.name];
      roots.push(e);
      if (s.fd && e.level === 1 && onRecord) {
        onRecord(s.fd, e.name);
      }
    }
    if (e.level !== 66 && e.level !== 77) {
      stack.push(e);
    }
    lastNon88 = e;
    all.push(e);
  }
  // Each 01 record (and each FD's record) is laid out from offset 0.
  for (const r of roots) {
    layout(r, 0, undefined);
  }
  for (const e of all) {
    delete (e as Partial<Entry>).children;
    delete (e as Partial<Entry>).signSeparate;
  }
  return all;
}

/** SELECT entries of FILE-CONTROL. */
export function parseSelects(sentences: Token[][]): FileDef[] {
  const files: FileDef[] = [];
  for (const s of sentences) {
    const sel = s.findIndex((t) => t.kind === "word" && t.value === "SELECT");
    if (sel < 0) {
      continue;
    }
    let i = sel + 1;
    if (s[i]?.value === "OPTIONAL") {
      i++;
    }
    const nameTok = s[i];
    if (!nameTok) {
      continue;
    }
    const f: FileDef = { file: nameTok.file, line: s[sel].line, name: nameTok.value, records: [] };
    for (let k = i + 1; k < s.length; k++) {
      const v = s[k].value;
      const skip = (n: number) => {
        let j = k + n;
        while (s[j] && (s[j].value === "IS" || s[j].value === "TO" || s[j].value === "MODE")) {
          j++;
        }
        return j;
      };
      if (v === "ASSIGN") {
        const j = skip(1);
        if (s[j]) {
          f.assign = s[j].kind === "str" ? s[j].value.toUpperCase() : s[j].value;
        }
      } else if (v === "ORGANIZATION") {
        const j = skip(1);
        f.organization =
          s[j]?.value === "LINE" ? `LINE ${s[j + 1]?.value ?? ""}`.trim() : s[j]?.value;
      } else if (v === "ACCESS") {
        f.access = s[skip(1)]?.value;
      } else if (v === "STATUS") {
        f.status = s[skip(1)]?.value;
      }
    }
    files.push(f);
  }
  return files;
}

/** The DD name a SELECT ... ASSIGN TO name binds to (IBM `UT-S-name` style prefixes removed). */
export function ddNameOf(assign: string | undefined): string | undefined {
  if (!assign) {
    return undefined;
  }
  const m = /^(?:UT-S-|UT-|DA-S-|DA-|S-)(.+)$/.exec(assign);
  return (m ? m[1] : assign).toUpperCase();
}

export { FIGURATIVE };
