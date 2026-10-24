// PL/I DECLARE statements: scalars, structures with level numbers (the path from the level-1 item
// down), factored names `(A, B) FIXED BIN(31)`, data attributes (FIXED/FLOAT DECIMAL/BINARY,
// CHAR, BIT, PIC, POINTER, ...), storage and overlays (BASED, DEFINED, STATIC, CONTROLLED,
// EXTERNAL), INIT values, FILE constants with their attributes and ENTRY declarations.

import type { Loc } from "../types.js";
import type { PliDecl, PliFileDecl } from "./pli-types.js";
import { split, splitAt } from "./pli-source.js";

const STORAGE =
  /^(AUTOMATIC|AUTO|STATIC|CONTROLLED|CTL|BASED|DEFINED|DEF|POSITION|POS|EXTERNAL|EXT|INTERNAL|INT|PARAMETER|CONNECTED|ALIGNED|UNALIGNED)$/;
const FILE_ATTRS =
  /^(RECORD|STREAM|INPUT|OUTPUT|UPDATE|PRINT|SEQUENTIAL|SEQL|DIRECT|TRANSIENT|KEYED|BUFFERED|UNBUFFERED|BACKWARDS|ENVIRONMENT|ENV|EXCLUSIVE)$/;

const TOKEN =
  /\s*(PIC(?:TURE)?\s*'(?:[^']|'')*'|'(?:[^']|'')*'B?|[A-Z_#@$][\w#@$]*\s*(?:\((?:[^()']|'(?:[^']|'')*'|\((?:[^()']|'[^']*'|\([^()]*\))*\))*\))?|\S)/y;

type Attr = { word: string; arg?: string; raw: string };

function attrs(text: string): Attr[] {
  const out: Attr[] = [];
  TOKEN.lastIndex = 0;
  for (let m = TOKEN.exec(text); m; m = TOKEN.exec(text)) {
    const raw = m[1].trim();
    if (raw.startsWith("PIC")) {
      out.push({
        word: "PIC",
        arg: raw.replace(/^PIC(TURE)?\s*/, ""),
        raw: raw.replace(/\s+'/, "'"),
      });
      continue;
    }
    const w = /^([A-Z_#@$][\w#@$]*)\s*(?:\(([\s\S]*)\))?$/.exec(raw);
    if (w) {
      out.push({
        word: w[1],
        ...(w[2] !== undefined ? { arg: w[2].trim() } : {}),
        raw: raw.replace(/\s+\(/, "("),
      });
    } else {
      out.push({ word: raw, raw });
    }
    if (TOKEN.lastIndex >= text.length) {
      break;
    }
  }
  return out;
}

export type DeclResult = {
  decls: PliDecl[];
  files: PliFileDecl[];
  entries: Array<Loc & { name: string; external: boolean }>;
};

/**
 * Items of one DECLARE statement (`body`: the text after DCL / DECLARE); `lineAt` gives the
 * source line of an offset in `body`, so each structure member cites its own line.
 */
export function parseDeclare(
  body: string,
  file: string,
  lineAt: (offset: number) => number,
  via?: string,
): DeclResult {
  const out: DeclResult = { decls: [], files: [], entries: [] };
  const stack: Array<{ level: number; name: string }> = [];
  for (const piece of splitAt(body)) {
    const item = piece.text;
    const loc: Loc = { file, line: lineAt(piece.at) };
    const m = /^(\d+)?\s*(\((?:[^()]|\([^()]*\))*\)|[A-Z_#@$*][\w#@$]*)\s*([\s\S]*)$/.exec(
      item.trim(),
    );
    if (!m) {
      continue;
    }
    const level = m[1] ? Number(m[1]) : 1;
    let rest = m[3];
    const names = m[2].startsWith("(")
      ? split(m[2].slice(1, -1)).map((x) => x.trim().split(/\s+/)[0])
      : [m[2]];
    let dims: string | undefined;
    const dm = /^\(([^()]*)\)/.exec(rest);
    if (dm) {
      dims = dm[1].replace(/\s+/g, "");
      rest = rest.slice(dm[0].length);
    }
    const list = attrs(rest);
    const has = (w: string) => list.some((a) => a.word === w);
    if (has("BUILTIN") || has("CONDITION") || has("GENERIC")) {
      continue;
    }
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }
    for (const name of names) {
      if (has("FILE")) {
        out.files.push({
          ...loc,
          name,
          attrs: list.filter((a) => FILE_ATTRS.test(a.word)).map((a) => a.raw),
        });
        continue;
      }
      if (has("ENTRY") && level === 1) {
        out.entries.push({ ...loc, name, external: !has("INTERNAL") && !has("INT") });
        continue;
      }
      const storage: string[] = [];
      const type: string[] = [];
      let init: string | undefined;
      for (let k = 0; k < list.length; k++) {
        const a = list[k];
        if (a.word === "INIT" || a.word === "INITIAL" || a.word === "VALUE") {
          init = a.arg;
        } else if (
          (a.word === "DEFINED" || a.word === "DEF") &&
          a.arg === undefined &&
          list[k + 1]
        ) {
          storage.push(`DEFINED(${list[k + 1].raw})`);
          k++;
        } else if (STORAGE.test(a.word)) {
          storage.push(a.word === "DEF" ? `DEFINED(${a.arg ?? ""})` : a.raw);
        } else if (a.word === "LIKE" && list[k + 1]) {
          type.push(`LIKE ${list[k + 1].raw}`);
          k++;
        } else {
          type.push(a.raw);
        }
      }
      const path = [...stack.map((s) => s.name), name];
      out.decls.push({
        ...loc,
        level,
        name,
        path,
        ...(type.length ? { type: type.join(" ") } : {}),
        ...(dims ? { dims } : {}),
        storage,
        ...(init !== undefined ? { init } : {}),
        ...(via ? { via } : {}),
      });
    }
    if (names.length === 1) {
      stack.push({ level, name: names[0] });
    }
  }
  return out;
}

/** A structure item has members (the next item has a higher level and this path as prefix). */
export function isStructure(d: PliDecl, all: PliDecl[]): boolean {
  return all.some(
    (x) => x.path.length === d.path.length + 1 && d.path.every((p, i) => x.path[i] === p),
  );
}
