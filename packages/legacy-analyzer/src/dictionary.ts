// Data dictionary from copybooks: each field with level, PIC, USAGE, length, offset and the
// description found in the copybook's comments. Lengths are storage bytes of one occurrence;
// offsets are 0-based from the start of the 01 record (`start` is the 1-based position).

import path from "node:path";
import type { CodeStream } from "./source.js";
import type { DataItem, LegacyIndex } from "./types.js";
import { describe } from "./cobol.js";
import { expandCopies } from "./copybook.js";
import { buildDataItems, splitSentences } from "./data.js";
import { readIndexedFile } from "./indexer.js";
import { readCodeStream, sourceText } from "./source.js";
import { tokenize } from "./tokenizer.js";

export type DictionaryEntry = {
  name: string;
  level: number;
  path: string;
  pic?: string;
  usage: string;
  length?: number;
  occurs?: number;
  totalLength?: number;
  offset?: number;
  start?: number;
  end?: number;
  redefines?: string;
  value?: string;
  conditionValues?: string[];
  description?: string;
  file: string;
  line: number;
};

export type Dictionary = {
  copybook: string;
  file: string;
  records: Array<{ name: string; length?: number }>;
  entries: DictionaryEntry[];
};

function memberName(file: string): string {
  return path
    .basename(file)
    .replace(/\.[^.]+$/, "")
    .toUpperCase();
}

function toEntry(d: DataItem, items: DataItem[]): DictionaryEntry {
  let usage = d.usage;
  for (let p = d.parent; !usage && p; ) {
    const parent = items.find((x) => x.name === p && x.level < d.level);
    usage = parent?.usage;
    p = parent?.parent;
  }
  const occ = d.occurs?.max;
  const total = d.length !== undefined ? d.length * (occ ?? 1) : undefined;
  return {
    name: d.name,
    level: d.level,
    path: d.path.join("."),
    pic: d.pic,
    usage: d.level === 88 ? "" : (usage ?? "DISPLAY"),
    length: d.length,
    occurs: occ,
    totalLength: total,
    offset: d.offset,
    start: d.offset !== undefined && d.level !== 88 ? d.offset + 1 : undefined,
    end: d.offset !== undefined && total !== undefined ? d.offset + total : undefined,
    redefines: d.redefines,
    value: d.value?.join(" "),
    conditionValues: d.conditionValues,
    description: d.description,
    file: d.file,
    line: d.line,
  };
}

export function dictionaryFor(index: LegacyIndex, copybookFile: string): Dictionary {
  const contents = new Map<string, string>();
  const read = (rel: string) => {
    if (!contents.has(rel)) {
      const t = readIndexedFile(index, rel);
      if (t !== null) {
        contents.set(rel, t);
      }
    }
    return contents.get(rel) ?? null;
  };
  const streamCache = new Map<string, CodeStream>();
  const stream = (rel: string) => {
    if (!streamCache.has(rel)) {
      const t = read(rel);
      if (t !== null) {
        streamCache.set(rel, readCodeStream(rel, t));
      }
    }
    return streamCache.get(rel) ?? null;
  };
  const members = new Map(
    index.files.filter((f) => f.kind !== "jcl").map((f) => [memberName(f.path), f.path]),
  );
  const resolve = (name: string) => {
    const rel = members.get(name.toUpperCase());
    const content = rel ? read(rel) : null;
    return rel && content !== null ? { file: rel, content } : null;
  };
  const s = stream(copybookFile);
  if (!s) {
    throw new Error(`Cannot read ${copybookFile}.`);
  }
  const toks = expandCopies(tokenize(s), resolve).tokens;
  const items = buildDataItems(
    splitSentences(toks).map((t) => ({ tokens: t, section: "COPYBOOK" })),
  );
  for (const d of items) {
    const st = stream(d.file);
    d.text = st ? sourceText(st, d.line, d.endLine ?? d.line) : "";
    d.description = d.description ?? describe(d, st);
  }
  return {
    copybook: memberName(copybookFile),
    file: copybookFile,
    records: items
      .filter((d) => d.level === 1 || d.level === 77)
      .map((d) => ({ name: d.name, length: d.length })),
    entries: items.map((d) => toEntry(d, items)),
  };
}

/** Dictionary of one copybook (by member name or path), or of every copybook in the index. */
export function dictionary(index: LegacyIndex, copybook?: string): Dictionary[] {
  const books = index.files.filter((f) => f.kind === "copybook");
  if (!copybook) {
    return books.map((b) => dictionaryFor(index, b.path));
  }
  const want = copybook.trim();
  const hit = books.find((b) => b.path === want || memberName(b.path) === want.toUpperCase());
  if (!hit) {
    throw new Error(`No copybook named ${copybook} in the index.`);
  }
  return [dictionaryFor(index, hit.path)];
}
