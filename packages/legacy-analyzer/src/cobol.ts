// Program parser: splits a COBOL source file into programs and assembles divisions, sections,
// FILE-CONTROL, the DATA DIVISION and the PROCEDURE DIVISION into one fact record per program.

import path from "node:path";
import type { CopyResolver } from "./copybook.js";
import type { CodeStream } from "./source.js";
import type { DataItem, Diagnostic, FileDef, Program, Token } from "./types.js";
import { expandCopies } from "./copybook.js";
import { buildDataItems, parseSelects, splitSentences } from "./data.js";
import { parseProcedure } from "./procedure.js";
import { sourceText } from "./source.js";
import { tokenize } from "./tokenizer.js";

export type StreamStore = (file: string) => CodeStream | null;

const DATA_SECTIONS = new Set([
  "FILE",
  "WORKING-STORAGE",
  "LOCAL-STORAGE",
  "LINKAGE",
  "COMMUNICATION",
  "REPORT",
  "SCREEN",
]);

function isWord(t: Token | undefined, ...values: string[]): boolean {
  return t !== undefined && t.kind === "word" && (values.length === 0 || values.includes(t.value));
}

/** Description of a data item from comments: inline, directly above, or a field table. */
export function describe(item: DataItem, stream: CodeStream | null): string | undefined {
  if (!stream) {
    return undefined;
  }
  const inline = stream.comments.find(
    (c) => c.line >= item.line && c.line <= (item.endLine ?? item.line),
  );
  if (inline?.text) {
    return inline.text;
  }
  // Comment lines immediately above the item (no code line in between).
  const above: string[] = [];
  for (let n = item.line - 1; n > 0; n--) {
    const c = stream.comments.find((x) => x.line === n);
    if (!c) {
      break;
    }
    above.unshift(c.text);
  }
  const cleaned = above
    .map((t) => t.replace(/^[-*=\s]+|[-*=\s]+$/g, ""))
    .filter((t) => t.length > 0 && !/^[-*=]+$/.test(t));
  if (cleaned.length > 0 && cleaned.length <= 3 && above.length <= 3) {
    return cleaned.join(" ");
  }
  // A field table in a header comment: "<pos> <len> NAME description".
  if (item.name !== "FILLER") {
    // Data names are letters, digits and hyphens: no regular-expression escaping is needed.
    const re = new RegExp(`(^|\\s)${item.name}(\\s+|$)(.*)$`);
    for (const c of stream.comments) {
      const m = re.exec(c.text);
      if (m && m[3].replace(/\*+\s*$/, "").trim().length > 0) {
        return m[3].replace(/\*+\s*$/, "").trim();
      }
    }
  }
  return undefined;
}

export type ParsedFile = { programs: Program[]; diagnostics: Diagnostic[] };

export function parseCobolFile(
  file: string,
  streams: StreamStore,
  resolve: CopyResolver,
): ParsedFile {
  const stream = streams(file);
  const diagnostics: Diagnostic[] = [];
  if (!stream) {
    return {
      programs: [],
      diagnostics: [{ file, line: 1, severity: "error", message: "Cannot read file." }],
    };
  }
  const expanded = expandCopies(tokenize(stream), resolve);
  diagnostics.push(...expanded.diagnostics);
  const toks = expanded.tokens;
  const quote = (f: string, from: number, to: number) => {
    const s = streams(f);
    return s ? sourceText(s, from, to) : "";
  };

  // Program boundaries: IDENTIFICATION/ID DIVISION ... up to END PROGRAM or the next program.
  const starts: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (isWord(toks[i], "IDENTIFICATION", "ID") && isWord(toks[i + 1], "DIVISION")) {
      starts.push(i);
    }
  }
  if (starts.length === 0) {
    diagnostics.push({
      file,
      line: 1,
      severity: "warning",
      message: "No IDENTIFICATION DIVISION found; not a COBOL program.",
    });
    return { programs: [], diagnostics };
  }
  const programs: Program[] = [];
  starts.forEach((start, n) => {
    let end = starts[n + 1] ?? toks.length;
    for (let k = start; k < end; k++) {
      if (isWord(toks[k], "END") && isWord(toks[k + 1], "PROGRAM")) {
        end = k;
        break;
      }
    }
    const pt = toks.slice(start, end);
    const prog = parseProgram(
      pt,
      file,
      expanded.copies,
      streams,
      quote,
      stream.format === "fixed",
      diagnostics,
    );
    if (prog) {
      programs.push(prog);
    }
  });
  return { programs, diagnostics };
}

function parseProgram(
  pt: Token[],
  file: string,
  allCopies: Program["copies"],
  streams: StreamStore,
  quote: (f: string, from: number, to: number) => string,
  fixed: boolean,
  diagnostics: Diagnostic[],
): Program | null {
  const pidIdx = pt.findIndex((t) => isWord(t, "PROGRAM-ID"));
  let nameTok = pt[pidIdx + 1];
  if (nameTok?.kind === "period") {
    nameTok = pt[pidIdx + 2];
  }
  if (pidIdx < 0 || !nameTok) {
    diagnostics.push({
      file,
      line: pt[0]?.line ?? 1,
      severity: "warning",
      message: "PROGRAM-ID missing.",
    });
    return null;
  }
  const name = nameTok.kind === "str" ? nameTok.value.toUpperCase() : nameTok.value;
  const divisions: Program["divisions"] = [];
  const divIndex = new Map<string, number>();
  for (let i = 0; i < pt.length; i++) {
    if (pt[i].kind === "word" && isWord(pt[i + 1], "DIVISION")) {
      const d = pt[i].value === "ID" ? "IDENTIFICATION" : pt[i].value;
      divisions.push({ name: d, file: pt[i].file, line: pt[i].line });
      divIndex.set(d, i);
    }
  }
  const from = (d: string) => divIndex.get(d);
  const until = (d: string, next: string[]) => {
    const s = from(d);
    if (s === undefined) {
      return [] as Token[];
    }
    const ends = next.map((x) => from(x)).filter((x): x is number => x !== undefined && x > s);
    return pt.slice(s + 2, ends.length > 0 ? Math.min(...ends) : pt.length);
  };
  const envToks = until("ENVIRONMENT", ["DATA", "PROCEDURE"]);
  const dataToks = until("DATA", ["PROCEDURE"]);
  const procStart = from("PROCEDURE");

  const sections: Program["sections"] = [];
  const envSentences = splitSentences(envToks);
  for (const s of envSentences) {
    if (s.length === 2 && isWord(s[1], "SECTION")) {
      sections.push({
        name: s[0].value,
        division: "ENVIRONMENT",
        file: s[0].file,
        line: s[0].line,
      });
    }
  }
  const files: FileDef[] = parseSelects(envSentences);
  const fileByName = new Map(files.map((f) => [f.name, f]));

  // DATA DIVISION: track the section and the FD each record belongs to.
  const dataSentences: Array<{ tokens: Token[]; section: string; fd?: string }> = [];
  let section = "";
  let fd: string | undefined;
  for (const s of splitSentences(dataToks)) {
    if (s.length === 2 && isWord(s[1], "SECTION") && DATA_SECTIONS.has(s[0].value)) {
      section = s[0].value;
      fd = undefined;
      sections.push({ name: section, division: "DATA", file: s[0].file, line: s[0].line });
      continue;
    }
    if (isWord(s[0], "FD", "SD", "RD") && s[1]) {
      fd = s[1].value;
      const f = fileByName.get(fd);
      if (f) {
        f.fdLine = s[0].line;
        f.fdFile = s[0].file;
      } else {
        const nf: FileDef = {
          file: s[0].file,
          line: s[0].line,
          name: fd,
          records: [],
          fdLine: s[0].line,
          fdFile: s[0].file,
        };
        files.push(nf);
        fileByName.set(fd, nf);
      }
      continue;
    }
    dataSentences.push({ tokens: s, section, fd: section === "FILE" ? fd : undefined });
  }
  const dataItems = buildDataItems(dataSentences, (fdName, rec) =>
    fileByName.get(fdName)?.records.push(rec),
  );
  for (const item of dataItems) {
    item.text = quote(item.file, item.line, item.endLine ?? item.line);
    if (item.file !== file) {
      item.copybook = path
        .basename(item.file)
        .replace(/\.[^.]+$/, "")
        .toUpperCase();
    }
    const d = describe(item, streams(item.file));
    if (d && !item.description) {
      item.description = d;
    }
  }

  // PROCEDURE DIVISION [USING a b] .
  const usingParams: string[] = [];
  let paragraphs: Program["paragraphs"] = [];
  if (procStart !== undefined) {
    let k = procStart + 2;
    if (isWord(pt[k], "USING")) {
      k++;
      while (k < pt.length && pt[k].kind !== "period") {
        if (
          pt[k].kind === "word" &&
          !["BY", "REFERENCE", "VALUE", "CONTENT"].includes(pt[k].value)
        ) {
          usingParams.push(pt[k].value);
        }
        k++;
      }
    }
    while (k < pt.length && pt[k].kind !== "period") {
      k++;
    }
    const procToks = pt.slice(k + 1);
    const recordFile = new Map<string, string>();
    const fileRecords = new Map<string, string[]>();
    for (const f of files) {
      fileRecords.set(f.name, f.records);
      for (const r of f.records) {
        recordFile.set(r, f.name);
      }
    }
    const conditionParents = new Map<string, string>();
    for (const it of dataItems) {
      if (it.level === 88 && it.parent) {
        conditionParents.set(it.name, it.parent);
      }
    }
    const res = parseProcedure(procToks, {
      dataNames: new Set(dataItems.filter((d) => d.name !== "FILLER").map((d) => d.name)),
      conditionParents,
      fileNames: new Set(files.map((f) => f.name)),
      recordFile,
      fileRecords,
      quote,
      fixed,
    });
    paragraphs = res.paragraphs;
    for (const s of res.sections) {
      sections.push({ ...s, division: "PROCEDURE" });
    }
  }
  const first = pt[0];
  const lastTok = pt[pt.length - 1] ?? first;
  const copies = allCopies.filter(
    (c) => c.file !== file || (c.line >= first.line && c.line <= lastTok.line),
  );
  return {
    name,
    file,
    line: first.line,
    divisions,
    sections,
    usingParams,
    paragraphs,
    dataItems,
    files,
    copies,
  };
}
