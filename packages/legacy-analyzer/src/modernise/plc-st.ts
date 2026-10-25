// PLC engine, first slice: IEC 61131-3 Structured Text. Reads POUs (PROGRAM, FUNCTION_BLOCK,
// FUNCTION), their VAR sections with direct addresses (AT %IX0.0), the function block instances and
// functions each body calls, and the variables it assigns. Deterministic, source text only.
// Object-oriented members (METHOD, PROPERTY, ACTION, INTERFACE) and VAR_CONFIG are reported as
// gaps, never guessed.

import type { Loc } from "../types.js";
import type {
  PlcAddressArea,
  PlcAnalysis,
  PlcCall,
  PlcFile,
  PlcIoPoint,
  PlcPou,
  PlcType,
  PlcVar,
  PlcVarSection,
  PlcWrite,
} from "./plc-st-types.js";
import type { EngineGap } from "./types.js";

type Tok = {
  kind: "word" | "num" | "addr" | "str" | "op";
  /** Upper-cased for words and addresses; the text otherwise. */
  value: string;
  line: number;
  start: number;
  end: number;
};

type Comment = { line: number; endLine: number; text: string };

const SECTIONS = new Set<string>([
  "VAR",
  "VAR_INPUT",
  "VAR_OUTPUT",
  "VAR_IN_OUT",
  "VAR_GLOBAL",
  "VAR_EXTERNAL",
  "VAR_TEMP",
  "VAR_STAT",
  "VAR_INST",
]);
const QUALIFIERS = new Set(["CONSTANT", "RETAIN", "NON_RETAIN", "PERSISTENT"]);
const POU_END: Record<PlcPou["kind"], string> = {
  PROGRAM: "END_PROGRAM",
  FUNCTION_BLOCK: "END_FUNCTION_BLOCK",
  FUNCTION: "END_FUNCTION",
};
/** Members and blocks this slice does not analyse: reported as a gap and skipped to their end. */
const SKIPPED: Record<string, string> = {
  METHOD: "END_METHOD",
  PROPERTY: "END_PROPERTY",
  ACTION: "END_ACTION",
  INTERFACE: "END_INTERFACE",
  VAR_CONFIG: "END_VAR",
  VAR_ACCESS: "END_VAR",
};
/** Words followed by `(` that are not calls. */
const NOT_CALLS = new Set([
  "IF",
  "ELSIF",
  "WHILE",
  "UNTIL",
  "CASE",
  "FOR",
  "TO",
  "BY",
  "RETURN",
  "NOT",
  "AND",
  "OR",
  "XOR",
  "MOD",
  "AND_THEN",
  "OR_ELSE",
  "THEN",
  "DO",
  "OF",
  "ELSE",
  "REPEAT",
]);

/** Splits Structured Text into tokens, dropping `(* *)`, `/* *\/` and `//` comments. */
export function plcTokens(text: string): { toks: Tok[]; comments: Comment[]; unclosed?: number } {
  const toks: Tok[] = [];
  const comments: Comment[] = [];
  let line = 1;
  let i = 0;
  const n = text.length;
  const countLines = (from: number, to: number) => {
    for (let k = from; k < to; k++) {
      if (text[k] === "\n") {
        line++;
      }
    }
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
    const two = text.slice(i, i + 2);
    if (two === "(*" || two === "/*") {
      const close = two === "(*" ? "*)" : "*/";
      const endAt = text.indexOf(close, i + 2);
      const startLine = line;
      const stop = endAt < 0 ? n : endAt + 2;
      countLines(i, stop);
      comments.push({
        line: startLine,
        endLine: line,
        text: text.slice(i + 2, endAt < 0 ? n : endAt).trim(),
      });
      if (endAt < 0) {
        return { toks, comments, unclosed: startLine };
      }
      i = stop;
      continue;
    }
    if (two === "//") {
      const eol = text.indexOf("\n", i);
      const stop = eol < 0 ? n : eol;
      comments.push({ line, endLine: line, text: text.slice(i + 2, stop).trim() });
      i = stop;
      continue;
    }
    const start = i;
    if (c === "'" || c === '"') {
      i++;
      while (i < n && text[i] !== c) {
        // `$'` escapes the quote inside a string literal.
        i += text[i] === "$" ? 2 : 1;
      }
      i++;
      const startLine = line;
      countLines(start, Math.min(i, n));
      toks.push({ kind: "str", value: text.slice(start, i), line: startLine, start, end: i });
      continue;
    }
    if (c === "%") {
      const m = /^%[IQM][XBWDL]?(?:\*|\d+(?:\.\d+)*)/i.exec(text.slice(i, i + 40));
      if (m) {
        i += m[0].length;
        toks.push({ kind: "addr", value: m[0].toUpperCase(), line, start, end: i });
        continue;
      }
    }
    if (/[A-Za-z_]/.test(c)) {
      while (i < n && /\w/.test(text[i])) {
        i++;
      }
      // Typed literals: INT#5, T#5s, TIME#1h2m.
      if (text[i] === "#") {
        i++;
        while (i < n && /[\w.:+-]/.test(text[i])) {
          i++;
        }
        toks.push({ kind: "num", value: text.slice(start, i), line, start, end: i });
        continue;
      }
      toks.push({ kind: "word", value: text.slice(start, i).toUpperCase(), line, start, end: i });
      continue;
    }
    if (/\d/.test(c)) {
      while (i < n && /[\w.#]/.test(text[i]) && text.slice(i, i + 2) !== "..") {
        i++;
      }
      toks.push({ kind: "num", value: text.slice(start, i), line, start, end: i });
      continue;
    }
    const op = [":=", "=>", "..", "<=", ">=", "<>", "**"].includes(two) ? two : c;
    i += op.length;
    toks.push({ kind: "op", value: op, line, start, end: i });
  }
  return { toks, comments };
}

const areaOf = (addr: string): PlcAddressArea =>
  addr[1] === "I" ? "input" : addr[1] === "Q" ? "output" : "memory";

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Reads one Structured Text source file. */
export function parsePlcFile(path: string, text: string): PlcFile {
  const { toks, comments, unclosed } = plcTokens(text);
  const gaps: EngineGap[] = [];
  const at = (line: number): Loc => ({ file: path, line });
  if (unclosed !== undefined) {
    gaps.push({
      ...at(unclosed),
      construct: "comment",
      detail: "Comment never closed; the rest of the file is not read.",
    });
  }
  const pous: PlcPou[] = [];
  const types: PlcType[] = [];
  const globals: PlcVar[] = [];
  const src = (from: number, to: number) =>
    collapse(text.slice(toks[from].start, toks[to - 1].end));
  const word = (k: number, v?: string) =>
    k < toks.length && toks[k].kind === "word" && (v === undefined || toks[k].value === v);
  const op = (k: number, v: string) =>
    k < toks.length && toks[k].kind === "op" && toks[k].value === v;
  const findWord = (from: number, v: string) => {
    for (let k = from; k < toks.length; k++) {
      if (word(k, v)) {
        return k;
      }
    }
    return -1;
  };

  /** Reads a VAR section starting at its keyword; returns the index after END_VAR. */
  const readSection = (k: number, into: PlcVar[]): number => {
    const section = toks[k].value as PlcVarSection;
    k++;
    const qualifiers: string[] = [];
    while (word(k) && QUALIFIERS.has(toks[k].value)) {
      qualifiers.push(toks[k++].value);
    }
    while (k < toks.length && !word(k, "END_VAR")) {
      const line = toks[k].line;
      const names: string[] = [];
      while (word(k)) {
        names.push(toks[k++].value);
        if (!op(k, ",")) {
          break;
        }
        k++;
      }
      let address: string | undefined;
      if (word(k, "AT") && toks[k + 1]?.kind === "addr") {
        address = toks[k + 1].value;
        k += 2;
      }
      if (names.length === 0 || !op(k, ":")) {
        // Not a declaration (pragma, vendor attribute): skip to the next ';'.
        gaps.push({ ...at(line), construct: "declaration", detail: `Not read in ${section}.` });
        while (k < toks.length && !op(k, ";") && !word(k, "END_VAR")) {
          k++;
        }
        if (op(k, ";")) {
          k++;
        }
        continue;
      }
      k++;
      const typeStart = k;
      let depth = 0;
      while (
        k < toks.length &&
        !(depth === 0 && (op(k, ":=") || op(k, ";"))) &&
        !word(k, "END_VAR")
      ) {
        depth += op(k, "(") || op(k, "[") ? 1 : op(k, ")") || op(k, "]") ? -1 : 0;
        k++;
      }
      const type = k > typeStart ? src(typeStart, k) : "";
      let init: string | undefined;
      if (op(k, ":=")) {
        const initStart = ++k;
        depth = 0;
        while (k < toks.length && !(depth === 0 && op(k, ";")) && !word(k, "END_VAR")) {
          depth += op(k, "(") || op(k, "[") ? 1 : op(k, ")") || op(k, "]") ? -1 : 0;
          k++;
        }
        init = k > initStart ? src(initStart, k) : undefined;
      }
      if (op(k, ";")) {
        k++;
      }
      for (const name of names) {
        into.push({
          ...at(line),
          name,
          section,
          qualifiers: [...qualifiers],
          type,
          ...(address ? { address, area: areaOf(address) } : {}),
          ...(init !== undefined ? { init } : {}),
        });
      }
    }
    return word(k, "END_VAR") ? k + 1 : k;
  };

  /** Skips a member or block this slice does not analyse; returns the index after its end. */
  const skip = (k: number, end: string): number => {
    const tok = toks[k];
    const close = findWord(k + 1, end);
    gaps.push({
      ...at(tok.line),
      construct: tok.value,
      detail: `${tok.value}${word(k + 1) && tok.value !== "VAR_CONFIG" ? ` ${toks[k + 1].value}` : ""} is not analysed yet.`,
    });
    return close < 0 ? toks.length : close + 1;
  };

  const readTypes = (k: number): number => {
    const end = findWord(k + 1, "END_TYPE");
    const stop = end < 0 ? toks.length : end;
    k++;
    while (k < stop) {
      if (!(word(k) && op(k + 1, ":"))) {
        k++;
        continue;
      }
      const name = toks[k].value;
      const line = toks[k].line;
      k += 2;
      let kind: PlcType["kind"] = "alias";
      let endLine = line;
      if (word(k, "STRUCT")) {
        kind = "struct";
        const close = findWord(k + 1, "END_STRUCT");
        k = close < 0 || close > stop ? stop : close;
      } else if (op(k, "(")) {
        kind = "enum";
      }
      while (k < stop && !op(k, ";")) {
        k++;
      }
      endLine = toks[Math.min(k, toks.length - 1)].line;
      types.push({ ...at(line), name, kind, endLine });
      k++;
    }
    if (end < 0) {
      gaps.push({
        ...at(toks[stop - 1]?.line ?? 1),
        construct: "TYPE",
        detail: "TYPE without END_TYPE.",
      });
    }
    return end < 0 ? toks.length : end + 1;
  };

  const docAbove = (line: number): string | undefined => {
    const c = comments.findLast((x) => x.endLine === line - 1 || x.endLine === line - 2);
    return c && c.endLine < line && !toks.some((t) => t.line > c.endLine && t.line < line)
      ? c.text
      : undefined;
  };

  const readBody = (from: number, to: number, pou: PlcPou, globalsHere: PlcVar[]) => {
    const known = new Map<string, PlcVar>();
    for (const v of [...globalsHere, ...pou.vars]) {
      known.set(v.name, v);
    }
    for (let k = from; k < to; k++) {
      if (!word(k) || op(k - 1, ".")) {
        continue;
      }
      // A qualified name: A, A.B, A.B.C (array subscripts are not followed).
      let j = k;
      const parts = [toks[j].value];
      while (op(j + 1, ".") && word(j + 2)) {
        parts.push(toks[j + 2].value);
        j += 2;
      }
      const name = parts.join(".");
      const line = toks[k].line;
      if (op(j + 1, "(") && !NOT_CALLS.has(parts[0])) {
        const v = known.get(parts[0]);
        const call: PlcCall = v
          ? { ...at(line), name, kind: "instance", type: v.type }
          : { ...at(line), name, kind: "function" };
        pou.calls.push(call);
      } else if (op(j + 1, ":=") && !op(k - 1, "(") && !op(k - 1, ",")) {
        pou.writes.push({ ...at(line), target: name } satisfies PlcWrite);
      }
      k = j;
    }
  };

  const fileGlobals: PlcVar[] = [];
  let k = 0;
  while (k < toks.length) {
    const t = toks[k];
    if (t.kind !== "word") {
      k++;
      continue;
    }
    if (t.value in SKIPPED) {
      k = skip(k, SKIPPED[t.value]);
      continue;
    }
    if (t.value === "TYPE") {
      k = readTypes(k);
      continue;
    }
    if (t.value === "VAR_GLOBAL") {
      k = readSection(k, fileGlobals);
      continue;
    }
    if (t.value === "PROGRAM" || t.value === "FUNCTION_BLOCK" || t.value === "FUNCTION") {
      const kind = t.value;
      let h = k + 1;
      while (word(h, "ABSTRACT") || word(h, "FINAL") || word(h, "PUBLIC") || word(h, "INTERNAL")) {
        h++;
      }
      if (!word(h)) {
        k++;
        continue;
      }
      if (kind === "PROGRAM" && (word(h + 1, "WITH") || op(h + 1, ":"))) {
        // A program instance inside a RESOURCE (PROGRAM Line WITH Main : LineCtl;), not a POU.
        while (k < toks.length && !op(k, ";")) {
          k++;
        }
        continue;
      }
      const pou: PlcPou = {
        ...at(t.line),
        name: toks[h].value,
        kind,
        endLine: t.line,
        implements: [],
        vars: [],
        calls: [],
        writes: [],
      };
      const doc = docAbove(t.line);
      if (doc) {
        pou.doc = doc;
      }
      h++;
      if (kind === "FUNCTION" && op(h, ":")) {
        const s = ++h;
        while (
          h < toks.length &&
          toks[h].line === toks[s].line &&
          !op(h, ";") &&
          !(word(h) && (SECTIONS.has(toks[h].value) || toks[h].value === POU_END.FUNCTION))
        ) {
          h++;
        }
        if (h > s) {
          pou.returns = src(s, h);
        }
      }
      if (word(h, "EXTENDS") && word(h + 1)) {
        pou.extends = toks[h + 1].value;
        h += 2;
      }
      if (word(h, "IMPLEMENTS")) {
        h++;
        while (word(h)) {
          pou.implements.push(toks[h++].value);
          if (!op(h, ",")) {
            break;
          }
          h++;
        }
      }
      const endWord = POU_END[kind];
      let body = h;
      let end = -1;
      for (let m = h; m < toks.length; m++) {
        if (word(m, endWord)) {
          end = m;
          break;
        }
        if (word(m) && SECTIONS.has(toks[m].value)) {
          m = readSection(m, pou.vars) - 1;
          body = m + 1;
          continue;
        }
        if (word(m) && toks[m].value in SKIPPED) {
          // A method, property or action declared inside the block: the body before it is kept.
          readBody(body, m, pou, fileGlobals);
          m = skip(m, SKIPPED[toks[m].value]) - 1;
          body = m + 1;
        }
      }
      if (end < 0) {
        gaps.push({
          ...at(t.line),
          construct: kind,
          detail: `${pou.name} has no ${endWord}; read to the end of the file.`,
        });
        end = toks.length;
      }
      readBody(body, end, pou, fileGlobals);
      pou.endLine = toks[Math.min(end, toks.length - 1)].line;
      pous.push(pou);
      k = end + 1;
      continue;
    }
    k++;
  }
  globals.push(...fileGlobals);
  return { path, pous, types, globals, gaps };
}

const cmpLoc = (a: Loc, b: Loc) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);

/** Joins parsed files: the I/O map, the function block instances and shared addresses. */
export function analysePlc(files: PlcFile[]): PlcAnalysis {
  const sorted = [...files].toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const pous = sorted.flatMap((f) => f.pous);
  const globals = sorted.flatMap((f) => f.globals);
  const blocks = new Map<string, PlcPou>();
  for (const p of pous) {
    if (p.kind === "FUNCTION_BLOCK" && !blocks.has(p.name)) {
      blocks.set(p.name, p);
    }
  }
  const io: PlcIoPoint[] = [
    ...globals.flatMap((v) =>
      v.address
        ? [
            {
              file: v.file,
              line: v.line,
              address: v.address,
              area: v.area!,
              name: v.name,
              type: v.type,
            },
          ]
        : [],
    ),
    ...pous.flatMap((p) =>
      p.vars.flatMap((v) =>
        v.address
          ? [
              {
                file: v.file,
                line: v.line,
                address: v.address,
                area: v.area!,
                name: v.name,
                pou: p.name,
                type: v.type,
              },
            ]
          : [],
      ),
    ),
  ].toSorted((a, b) => (a.address < b.address ? -1 : a.address > b.address ? 1 : cmpLoc(a, b)));
  const byAddress = new Map<string, Loc[]>();
  for (const p of io) {
    if (!p.address.endsWith("*")) {
      byAddress.set(p.address, [
        ...(byAddress.get(p.address) ?? []),
        { file: p.file, line: p.line },
      ]);
    }
  }
  const instances = pous.flatMap((p) =>
    p.calls.flatMap((c) => {
      const def = c.kind === "instance" && c.type ? blocks.get(c.type.toUpperCase()) : undefined;
      if (!def || !c.type) {
        return [];
      }
      return [
        {
          file: c.file,
          line: c.line,
          pou: p.name,
          instance: c.name,
          type: c.type,
          definedAt: { file: def.file, line: def.line },
        },
      ];
    }),
  );
  return {
    files: sorted.map((f) => f.path),
    pous,
    types: sorted.flatMap((f) => f.types),
    globals,
    io,
    instances,
    sharedAddresses: [...byAddress]
      .filter(([, by]) => by.length > 1)
      .map(([address, by]) => ({ address, by })),
    gaps: sorted.flatMap((f) => f.gaps),
  };
}
