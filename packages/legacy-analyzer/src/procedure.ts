// PROCEDURE DIVISION: paragraphs and sections, statements with the data items they set and use,
// PERFORM/CALL/GO TO edges, file I/O, EXEC SQL, and the IF/EVALUATE/phrase nesting that guards
// each statement. Scope follows COBOL rules: ELSE pairs with the nearest open IF, END-x closes
// the nearest matching scope, a period closes every open scope.

import type { IoOp, Paragraph, Statement, Token } from "./types.js";
import { FIGURATIVE } from "./data.js";
import { joinTokens } from "./tokenizer.js";

export const VERBS = new Set([
  "ACCEPT",
  "ADD",
  "ALTER",
  "CALL",
  "CANCEL",
  "CLOSE",
  "COMPUTE",
  "CONTINUE",
  "DELETE",
  "DISPLAY",
  "DIVIDE",
  "ENTRY",
  "EVALUATE",
  "EXIT",
  "GENERATE",
  "GO",
  "GOBACK",
  "IF",
  "INITIALIZE",
  "INITIATE",
  "INSPECT",
  "INVOKE",
  "MERGE",
  "MOVE",
  "MULTIPLY",
  "OPEN",
  "PERFORM",
  "READ",
  "RELEASE",
  "RETURN",
  "REWRITE",
  "SEARCH",
  "SET",
  "SORT",
  "START",
  "STOP",
  "STRING",
  "SUBTRACT",
  "SUPPRESS",
  "TERMINATE",
  "UNSTRING",
  "USE",
  "WRITE",
]);

const ARITHMETIC = new Set(["ADD", "SUBTRACT", "MULTIPLY", "DIVIDE", "COMPUTE"]);

export type ProcContext = {
  dataNames: Set<string>;
  /** 88-level name → its conditional variable. */
  conditionParents: Map<string, string>;
  fileNames: Set<string>;
  /** 01 record name → file (FD) name. */
  recordFile: Map<string, string>;
  /** File (FD) name → its 01 records. */
  fileRecords: Map<string, string[]>;
  quote: (file: string, from: number, to: number) => string;
  fixed: boolean;
};

const SPECIAL_REGISTERS = new Set(["RETURN-CODE", "SORT-RETURN", "TALLY", "WHEN-COMPILED"]);

function isWord(t: Token | undefined, ...values: string[]): boolean {
  return t !== undefined && t.kind === "word" && (values.length === 0 || values.includes(t.value));
}

/** A conditional phrase starting at `i` (AT END, INVALID KEY, ON SIZE ERROR, ...), or null. */
function phraseAt(toks: Token[], i: number): { len: number; label: string } | null {
  let k = i;
  const neg = isWord(toks[k], "NOT");
  if (neg) {
    k++;
  }
  const start = k;
  if (isWord(toks[k], "AT")) {
    k++;
  }
  if (isWord(toks[k], "END", "END-OF-PAGE", "EOP")) {
    return { len: k - i + 1, label: `${neg ? "NOT " : ""}AT ${toks[k].value}` };
  }
  k = start;
  if (isWord(toks[k], "INVALID")) {
    return {
      len: k - i + (isWord(toks[k + 1], "KEY") ? 2 : 1),
      label: `${neg ? "NOT " : ""}INVALID KEY`,
    };
  }
  if (isWord(toks[k], "ON")) {
    k++;
  }
  if (isWord(toks[k], "SIZE") && isWord(toks[k + 1], "ERROR")) {
    return { len: k - i + 2, label: `${neg ? "NOT " : ""}ON SIZE ERROR` };
  }
  if (isWord(toks[k], "EXCEPTION", "OVERFLOW")) {
    return { len: k - i + 1, label: `${neg ? "NOT " : ""}ON ${toks[k].value}` };
  }
  return null;
}

function isBoundary(toks: Token[], i: number): boolean {
  const t = toks[i];
  if (!t) {
    return true;
  }
  if (t.kind === "period") {
    return true;
  }
  if (t.kind !== "word") {
    return false;
  }
  if (
    VERBS.has(t.value) ||
    t.value === "ELSE" ||
    t.value === "WHEN" ||
    t.value === "EXEC" ||
    t.value.startsWith("END-")
  ) {
    return true;
  }
  if (t.value === "NEXT" && isWord(toks[i + 1], "SENTENCE")) {
    return true;
  }
  return phraseAt(toks, i) !== null;
}

type Frame = {
  kind: "IF" | "EVALUATE" | "SEARCH" | "PERFORM" | "PHRASE";
  label: string;
  closer: string;
  cond?: string;
  inElse?: boolean;
  subject?: string;
  ownerVerb?: string;
  ownerTarget?: string;
};

function frameLabel(f: Frame): string {
  if (f.kind === "IF") {
    return f.inElse ? `ELSE OF IF ${f.cond}` : `IF ${f.cond}`;
  }
  return f.label;
}

/** Base names of data references in a token run (declared items and special registers). */
export function dataRefs(toks: Token[], ctx: ProcContext): string[] {
  const out: string[] = [];
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k];
    if (t.kind !== "word") {
      continue;
    }
    // `X OF Y` / `X IN Y`: the qualifier is not a separate reference.
    if (isWord(toks[k - 1], "OF", "IN") && ctx.dataNames.has(toks[k - 2]?.value ?? "")) {
      continue;
    }
    const name = t.value.startsWith(":") ? t.value.slice(1) : t.value;
    if (ctx.dataNames.has(name) || SPECIAL_REGISTERS.has(name)) {
      out.push(name);
    }
  }
  return [...new Set(out)];
}

/** References at the top level of a token run (subscript contents are excluded). */
function topRefs(toks: Token[], ctx: ProcContext): { top: string[]; inner: Token[] } {
  const topToks: Token[] = [];
  const inner: Token[] = [];
  let depth = 0;
  for (const t of toks) {
    if (t.raw === "(") {
      depth++;
      if (depth === 1) {
        continue;
      }
    } else if (t.raw === ")") {
      depth--;
      if (depth === 0) {
        continue;
      }
    }
    (depth > 0 ? inner : topToks).push(t);
  }
  return { top: dataRefs(topToks, ctx), inner };
}

function splitAt(toks: Token[], ...words: string[]): [Token[], Token[]] {
  const k = toks.findIndex((t) => isWord(t, ...words));
  return k < 0 ? [toks, []] : [toks.slice(0, k), toks.slice(k + 1)];
}

function analyseStatement(verb: string, body: Token[], ctx: ProcContext, st: Statement): void {
  const sets: string[] = [];
  const uses: string[] = [];
  const target = (toks: Token[]) => {
    const { top, inner } = topRefs(toks, ctx);
    sets.push(...top);
    uses.push(...dataRefs(inner, ctx));
  };
  const use = (toks: Token[]) => uses.push(...dataRefs(toks, ctx));
  switch (verb) {
    case "MOVE": {
      const [src, dst] = splitAt(body, "TO");
      use(src);
      target(dst);
      break;
    }
    case "COMPUTE": {
      const k = body.findIndex((t) => t.raw === "=" || isWord(t, "EQUAL"));
      target(body.slice(0, Math.max(0, k)));
      use(body.slice(k + 1));
      break;
    }
    case "ADD":
    case "SUBTRACT":
    case "MULTIPLY":
    case "DIVIDE": {
      const g = body.findIndex((t) => isWord(t, "GIVING"));
      if (g >= 0) {
        use(body.slice(0, g));
        const rest = body.slice(g + 1);
        const [giving, rem] = splitAt(rest, "REMAINDER");
        target(giving);
        target(rem);
      } else {
        const kw =
          verb === "ADD"
            ? "TO"
            : verb === "SUBTRACT"
              ? "FROM"
              : verb === "MULTIPLY"
                ? "BY"
                : "INTO";
        const [src, dst] = splitAt(body, kw);
        use(src);
        target(dst);
      }
      break;
    }
    case "SET": {
      const [dst, src] = splitAt(body, "TO", "UP", "DOWN");
      target(dst);
      use(src);
      const parents = sets
        .map((s) => ctx.conditionParents.get(s))
        .filter((p): p is string => p !== undefined);
      sets.push(...parents);
      break;
    }
    case "INITIALIZE":
    case "ACCEPT":
      target(splitAt(body, "REPLACING", "FROM")[0]);
      break;
    case "STRING": {
      const [src, dst] = splitAt(body, "INTO");
      use(src);
      target(dst);
      break;
    }
    case "UNSTRING": {
      const [src, dst] = splitAt(body, "INTO");
      use(src);
      target(dst);
      break;
    }
    case "INSPECT": {
      const [subject, rest] = splitAt(body, "TALLYING", "REPLACING", "CONVERTING");
      if (body.some((t) => isWord(t, "TALLYING"))) {
        use(subject);
        const [cnt] = splitAt(rest, "FOR");
        target(cnt);
      } else {
        target(subject);
        use(rest);
      }
      break;
    }
    case "READ":
    case "RETURN": {
      const file = body[0]?.value ?? "";
      const [, into] = splitAt(body, "INTO");
      target(splitAt(into, "KEY")[0]);
      sets.push(...(ctx.fileRecords.get(file) ?? []));
      st.io = { op: "READ", file };
      break;
    }
    case "WRITE":
    case "REWRITE":
    case "RELEASE": {
      const record = body[0]?.value ?? "";
      const [, from] = splitAt(body, "FROM");
      use(from);
      // WRITE rec FROM x moves x into the record area first.
      (from.length > 0 ? target : use)(body.slice(0, 1));
      if (verb !== "RELEASE") {
        st.io = { op: verb as IoOp, file: ctx.recordFile.get(record) ?? record, record };
      }
      break;
    }
    case "DELETE":
    case "START":
      st.io = { op: verb as IoOp, file: body[0]?.value ?? "" };
      use(body.slice(1));
      break;
    case "OPEN":
    case "CLOSE":
      break; // handled by the caller (one statement per file)
    case "PERFORM":
    case "CALL":
    case "EVALUATE":
    case "IF":
    case "SEARCH":
    case "DISPLAY":
    default:
      use(body);
  }
  st.sets = [...new Set(sets)];
  st.uses = [...new Set(uses.filter((u) => !st.sets.includes(u) || verb === "COMPUTE"))];
}

function parseSql(body: Token[]): NonNullable<Statement["sql"]> & { into: string[] } {
  const tables: string[] = [];
  const ops: string[] = [];
  const hostVars: string[] = [];
  const into: string[] = [];
  const first = body[1]?.value; // body[0] is SQL / CICS
  if (first) {
    ops.push(first);
  }
  let inInto = false;
  for (let k = 1; k < body.length; k++) {
    const t = body[k];
    if (t.kind === "word" && t.value.startsWith(":")) {
      const hv = t.value.slice(1);
      hostVars.push(hv);
      if (inInto) {
        into.push(hv);
      }
      continue;
    }
    if (isWord(t, "INTO")) {
      inInto = body[k - 1]?.value !== "INSERT";
    } else if (isWord(t, "FROM", "WHERE", "VALUES", "SET")) {
      inInto = false;
    }
    if (
      isWord(t, "FROM", "JOIN", "UPDATE") ||
      (isWord(t, "INTO") && isWord(body[k - 1], "INSERT"))
    ) {
      // A comma-separated table list after FROM; aliases follow the table name.
      let j = k + 1;
      while (j < body.length) {
        const tt = body[j];
        if (tt.kind === "word" && !tt.value.startsWith(":") && tt.value !== "SELECT") {
          tables.push(tt.value);
        } else {
          break;
        }
        while (
          j < body.length &&
          body[j].raw !== "," &&
          !isWord(
            body[j],
            "WHERE",
            "JOIN",
            "ON",
            "SET",
            "ORDER",
            "GROUP",
            "INNER",
            "LEFT",
            "RIGHT",
            "FULL",
            "UNION",
            "FOR",
            "WITH",
            "HAVING",
            "FETCH",
            "VALUES",
          )
        ) {
          j++;
          if (body[j]?.raw === ")" || body[j]?.raw === "(") {
            break;
          }
        }
        if (body[j]?.raw !== ",") {
          break;
        }
        j++;
      }
    }
  }
  return { tables: [...new Set(tables)], ops, hostVars: [...new Set(hostVars)], into };
}

export type ProcedureResult = {
  paragraphs: Paragraph[];
  sections: Array<{ name: string; file: string; line: number }>;
};

/** Parse procedure-division tokens (after the `PROCEDURE DIVISION ... .` header). */
export function parseProcedure(toks: Token[], ctx: ProcContext): ProcedureResult {
  // Pass 1: paragraph and section headers.
  type Header = { index: number; name: string; section: boolean; tok: Token; len: number };
  const headers: Header[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const sentenceStart = i === 0 || toks[i - 1].kind === "period";
    if (t.kind !== "word" || !sentenceStart || (ctx.fixed && t.col > 11)) {
      continue;
    }
    if (isWord(toks[i + 1], "SECTION") && toks[i + 2]?.kind === "period") {
      headers.push({ index: i, name: t.value, section: true, tok: t, len: 3 });
    } else if (toks[i + 1]?.kind === "period" && !VERBS.has(t.value) && t.value !== "EXIT") {
      headers.push({ index: i, name: t.value, section: false, tok: t, len: 2 });
    } else if (
      isWord(t, "DECLARATIVES") ||
      (isWord(t, "END") && isWord(toks[i + 1], "DECLARATIVES"))
    ) {
      continue;
    }
  }
  const procNames = new Set(headers.map((h) => h.name));
  const sections: ProcedureResult["sections"] = [];
  const paragraphs: Paragraph[] = [];
  let currentSection: string | undefined;

  const ranges: Array<{ name: string; tok: Token; from: number; to: number; section?: string }> =
    [];
  if (headers.length === 0 || headers[0].index > 0) {
    const end = headers[0]?.index ?? toks.length;
    if (end > 0) {
      ranges.push({ name: "(PROCEDURE)", tok: toks[0], from: 0, to: end });
    }
  }
  headers.forEach((h, n) => {
    const to = headers[n + 1]?.index ?? toks.length;
    if (h.section) {
      currentSection = h.name;
      sections.push({ name: h.name, file: h.tok.file, line: h.tok.line });
      // Statements between a section header and its first paragraph belong to the section.
      if (to > h.index + h.len) {
        ranges.push({ name: h.name, tok: h.tok, from: h.index + h.len, to, section: h.name });
      }
      return;
    }
    ranges.push({ name: h.name, tok: h.tok, from: h.index + h.len, to, section: currentSection });
  });

  for (const r of ranges) {
    const body = toks.slice(r.from, r.to);
    const last = body.length > 0 ? body[body.length - 1] : r.tok;
    paragraphs.push({
      name: r.name,
      section: r.section,
      file: r.tok.file,
      line: r.tok.line,
      endLine: last.file === r.tok.file ? last.line : r.tok.line,
      statements: parseStatements(body, ctx, procNames),
    });
  }
  return { paragraphs, sections };
}

function parseStatements(toks: Token[], ctx: ProcContext, procNames: Set<string>): Statement[] {
  const out: Statement[] = [];
  const frames: Frame[] = [];
  let lastAtDepth: Statement | undefined;
  const guards = () => frames.map(frameLabel);
  const record = (
    verb: string,
    from: number,
    to: number,
    extra?: Partial<Statement>,
  ): Statement => {
    const first = toks[from];
    let lastTok = toks[Math.max(from, to - 1)] ?? first;
    if (lastTok.file !== first.file) {
      lastTok = first;
    }
    const own = toks.slice(from, to);
    const st: Statement = {
      verb,
      file: first.file,
      line: first.line,
      endLine: lastTok.line,
      text: ctx.quote(first.file, first.line, lastTok.line),
      code: joinTokens(own.filter((x) => !isWord(x, "THEN"))),
      literals: [
        ...new Set(
          own
            .filter(
              (x) =>
                x.kind === "num" ||
                x.kind === "str" ||
                (x.kind === "word" && FIGURATIVE.has(x.value)),
            )
            .map((x) => (x.kind === "str" ? x.raw : x.raw.toUpperCase())),
        ),
      ],
      sets: [],
      uses: [],
      guards: guards(),
      ...extra,
    };
    out.push(st);
    return st;
  };
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t.kind === "period") {
      frames.length = 0;
      i++;
      continue;
    }
    if (isWord(t, "EXEC")) {
      let j = i + 1;
      while (j < toks.length && !isWord(toks[j], "END-EXEC")) {
        j++;
      }
      const body = toks.slice(i + 1, j);
      const st = record("EXEC", i, Math.min(j + 1, toks.length));
      if (isWord(body[0], "SQL")) {
        const sql = parseSql(body);
        st.sql = { tables: sql.tables, ops: sql.ops, hostVars: sql.hostVars };
        st.sets = sql.into.filter((h) => ctx.dataNames.has(h));
        st.uses = sql.hostVars.filter((h) => ctx.dataNames.has(h) && !st.sets.includes(h));
      }
      i = j + 1;
      continue;
    }
    if (t.kind === "word" && t.value.startsWith("END-")) {
      const idx = frames.map((f) => f.closer).lastIndexOf(t.value);
      if (idx >= 0) {
        frames.length = idx;
      }
      i++;
      continue;
    }
    const phrase = phraseAt(toks, i);
    if (phrase) {
      const top = frames[frames.length - 1];
      let ownerVerb = lastAtDepth?.verb ?? "";
      let ownerTarget = lastAtDepth?.io?.file ?? lastAtDepth?.sets[0] ?? "";
      if (top?.kind === "PHRASE") {
        // A sibling phrase (NOT AT END after AT END) belongs to the same statement.
        frames.pop();
        ownerVerb = top.ownerVerb ?? "";
        ownerTarget = top.ownerTarget ?? "";
      }
      frames.push({
        kind: "PHRASE",
        label: `${phrase.label} OF ${ownerVerb}${ownerTarget ? ` ${ownerTarget}` : ""}`,
        closer: `END-${ownerVerb}`,
        ownerVerb,
        ownerTarget,
      });
      i += phrase.len;
      continue;
    }
    if (isWord(t, "ELSE")) {
      while (frames.length > 0) {
        const top = frames[frames.length - 1];
        if (top.kind === "PHRASE" || (top.kind === "IF" && top.inElse)) {
          frames.pop();
          continue;
        }
        break;
      }
      const top = frames[frames.length - 1];
      if (top?.kind === "IF") {
        top.inElse = true;
      }
      i++;
      continue;
    }
    if (isWord(t, "WHEN")) {
      while (
        frames.length > 0 &&
        frames[frames.length - 1].kind !== "EVALUATE" &&
        frames[frames.length - 1].kind !== "SEARCH"
      ) {
        frames.pop();
      }
      let j = i + 1;
      while (j < toks.length && !isBoundary(toks, j)) {
        j++;
      }
      const cond = joinTokens(toks.slice(i + 1, j));
      const top = frames[frames.length - 1];
      const label =
        top?.kind === "EVALUATE" ? `EVALUATE ${top.subject} WHEN ${cond}` : `WHEN ${cond}`;
      // The WHEN itself is guarded by its EVALUATE only (not by the previous WHEN); the
      // statements under it see the full `EVALUATE ... WHEN ...` as their guard.
      if (top) {
        top.label = `${top.kind} ${top.subject ?? ""}`.trim();
      }
      const st = record("WHEN", i, j, { condition: label });
      analyseStatement("WHEN", toks.slice(i + 1, j), ctx, st);
      if (top) {
        top.label = label;
      }
      lastAtDepth = st;
      i = j;
      continue;
    }
    if (isWord(t, "NEXT") && isWord(toks[i + 1], "SENTENCE")) {
      record("NEXT SENTENCE", i, i + 2);
      i += 2;
      continue;
    }
    if (!(t.kind === "word" && VERBS.has(t.value))) {
      i++; // stray token (e.g. THEN, or a word after a phrase the parser does not model)
      continue;
    }
    let j = i + 1;
    while (j < toks.length && !isBoundary(toks, j)) {
      j++;
    }
    const verb = t.value;
    const body = toks.slice(i + 1, j);
    if (verb === "IF") {
      const condToks = body.filter((x) => !isWord(x, "THEN"));
      const cond = joinTokens(condToks);
      const st = record("IF", i, j, { condition: cond });
      analyseStatement("IF", condToks, ctx, st);
      frames.push({ kind: "IF", label: "", closer: "END-IF", cond });
      lastAtDepth = st;
      i = j;
      continue;
    }
    if (verb === "EVALUATE" || verb === "SEARCH") {
      const subject = joinTokens(body);
      const st = record(verb, i, j, { condition: verb === "EVALUATE" ? subject : undefined });
      analyseStatement(verb, body, ctx, st);
      frames.push({ kind: verb, label: `${verb} ${subject}`, closer: `END-${verb}`, subject });
      lastAtDepth = st;
      i = j;
      continue;
    }
    if (verb === "OPEN" || verb === "CLOSE") {
      let mode: string | undefined;
      for (const b of body) {
        if (isWord(b, "INPUT", "OUTPUT", "I-O", "EXTEND")) {
          mode = b.value;
        } else if (b.kind === "word" && ctx.fileNames.has(b.value)) {
          const st = record(verb, i, j, {
            io: { op: verb, file: b.value, mode: verb === "OPEN" ? mode : undefined },
          });
          lastAtDepth = st;
        }
      }
      i = j;
      continue;
    }
    const st = record(verb, i, j);
    analyseStatement(verb, body, ctx, st);
    if (ARITHMETIC.has(verb) && body.some((b) => isWord(b, "ROUNDED"))) {
      st.rounded = true;
    }
    if (verb === "PERFORM") {
      const first = body[0];
      const inline = !(first && first.kind === "word" && procNames.has(first.value));
      const thruIdx = body.findIndex((b) => isWord(b, "THRU", "THROUGH"));
      const untilIdx = body.findIndex((b) => isWord(b, "UNTIL"));
      const varyIdx = body.findIndex((b) => isWord(b, "VARYING"));
      const untilText = untilIdx >= 0 ? joinTokens(body.slice(untilIdx + 1)) : undefined;
      st.performs = {
        target: inline ? "(inline)" : first.value,
        thru: thruIdx >= 0 ? body[thruIdx + 1]?.value : undefined,
        until: untilText,
        varying:
          varyIdx >= 0
            ? joinTokens(body.slice(varyIdx + 1, untilIdx >= 0 ? untilIdx : body.length))
            : undefined,
        inline,
      };
      if (untilText) {
        st.condition = untilText;
      }
      if (varyIdx >= 0) {
        const [v] = splitAt(body.slice(varyIdx + 1), "FROM");
        st.sets = dataRefs(v, ctx);
      }
      if (inline) {
        frames.push({
          kind: "PERFORM",
          label: `PERFORM ${joinTokens(body)}`.trim(),
          closer: "END-PERFORM",
        });
      }
    } else if (verb === "CALL") {
      const tgt = body[0];
      const usingIdx = body.findIndex((b) => isWord(b, "USING"));
      const stop = body.findIndex((b, k) => k > usingIdx && isWord(b, "RETURNING", "ON", "NOT"));
      const args =
        usingIdx >= 0
          ? body
              .slice(usingIdx + 1, stop > usingIdx ? stop : body.length)
              .filter(
                (b) =>
                  b.kind === "word" &&
                  ![
                    "BY",
                    "REFERENCE",
                    "CONTENT",
                    "VALUE",
                    "ADDRESS",
                    "OF",
                    "LENGTH",
                    "OMITTED",
                  ].includes(b.value),
              )
              .map((b) => b.value)
          : [];
      st.call = {
        target: tgt?.kind === "str" ? tgt.value.toUpperCase() : (tgt?.value ?? ""),
        dynamic: tgt?.kind !== "str",
        using: args,
      };
    } else if (verb === "GO") {
      const names = body
        .filter((b) => b.kind === "word" && procNames.has(b.value))
        .map((b) => b.value);
      st.goTo = names;
    }
    lastAtDepth = st;
    i = j;
  }
  return out;
}
