// PL/I file parser: procedures (OPTIONS(MAIN), nested internal procedures), DO / BEGIN / SELECT
// groups for END matching, DECLARE (structures, files, entries), %INCLUDE, CALL, record and
// stream I/O (READ, WRITE, REWRITE, DELETE, LOCATE, GET, PUT, OPEN, CLOSE), EXEC SQL with its
// tables, and ON-units. Actions after IF ... THEN, ELSE, WHEN (...), OTHERWISE and ON are read as
// statements. Macro statements (%IF, %DO, %DECLARE, %name = ...), FETCH / RELEASE, secondary
// ENTRY points, EXEC CICS / DLI, dynamic SQL and EXEC SQL INCLUDE of members are gaps.

import type { PliDecl, PliFile, PliIo, PliProc } from "./pli-types.js";
import type { EngineGap } from "./types.js";
import { parseDeclare } from "./pli-declare.js";
import { type PStmt, blank, close, lineOf, option, pliStatements, split } from "./pli-source.js";
import { sqlTables } from "./sql-text.js";

const LISTING = /^%\s*(PAGE|SKIP|PRINT|NOPRINT|PUSH|POP|CONTROL|NOTE)\b/;
const IO_VERBS = /^(OPEN|CLOSE|READ|WRITE|REWRITE|DELETE|LOCATE|GET|PUT)\b/;

type Block = { kind: "proc" | "group"; label?: string; proc?: PliProc };

function newProc(name: string, file: string, line: number, parent?: PliProc): PliProc {
  return {
    file,
    line,
    name,
    qualified: parent ? `${parent.qualified}.${name}` : name,
    ...(parent ? { parent: parent.qualified } : {}),
    main: false,
    params: [],
    recursive: false,
    endLine: line,
    decls: [],
    files: [],
    entries: [],
    includes: [],
    calls: [],
    io: [],
    sql: [],
    onUnits: [],
  };
}

/** Labels (`A: B:`) and condition prefixes (`(SIZE):`) stripped; the offset of what is left. */
function stripLabels(t: string): { labels: string[]; rest: string; at: number } {
  const labels: string[] = [];
  let at = 0;
  for (;;) {
    const s = t.slice(at);
    const m =
      /^\s*([A-Z_#@$][\w#@$]*)\s*:(?!=)/.exec(s) ??
      /^\s*\((\s*N?O?[A-Z]+\s*(,\s*N?O?[A-Z]+\s*)*)\)\s*:/.exec(s);
    if (!m) {
      break;
    }
    if (!m[0].trimStart().startsWith("(")) {
      labels.push(m[1]);
    }
    at += m[0].length;
  }
  const lead = t.slice(at).length - t.slice(at).trimStart().length;
  return { labels, rest: t.slice(at).trim(), at: at + lead };
}

/** The executable statement inside IF ... THEN x / ELSE x / WHEN (...) x / OTHERWISE x. */
function action(t: string): { text: string; at: number } {
  let at = 0;
  for (let guard = 0; guard < 20; guard++) {
    const s = t.slice(at);
    const b = blank(s);
    let m = /^\s*(ELSE|OTHERWISE|OTHER)\b\s*/.exec(b);
    if (m) {
      at += m[0].length;
      continue;
    }
    m = /^\s*WHEN\s*\(/.exec(b);
    if (m) {
      const end = close(s, m[0].length - 1);
      if (end < 0) {
        break;
      }
      at += end;
      continue;
    }
    if (/^\s*IF\b/.test(b)) {
      // THEN at parenthesis depth 0.
      let depth = 0;
      let k = 0;
      for (; k < b.length; k++) {
        if (b[k] === "(") {
          depth++;
        } else if (b[k] === ")") {
          depth--;
        } else if (depth === 0 && /^THEN\b/.test(b.slice(k)) && /\W/.test(b[k - 1] ?? " ")) {
          break;
        }
      }
      if (k >= b.length) {
        break;
      }
      at += k + 4;
      continue;
    }
    break;
  }
  const rest = t.slice(at);
  return { text: rest.trim(), at: at + rest.length - rest.trimStart().length };
}

const opensGroup = (t: string) => /^(DO|BEGIN|SELECT)\b/.test(blank(t));

export function parsePliFile(path: string, text: string): PliFile {
  const { stmts, comments, margins } = pliStatements(text);
  const gaps: EngineGap[] = [];
  const gap = (line: number, construct: string, detail: string) =>
    gaps.push({ file: path, line, construct, detail: detail.slice(0, 160) });
  const procs: PliProc[] = [];
  const stack: Block[] = [];
  const fragment: PliDecl[] = [];
  const codeLines = new Set(stmts.map((s) => s.line));
  const docAbove = (line: number) => {
    const c = comments.filter((x) => x.endLine < line && x.endLine >= line - 3 && x.text);
    const last = c[c.length - 1];
    return last && ![...codeLines].some((l) => l > last.endLine && l < line)
      ? last.text.slice(0, 300)
      : undefined;
  };
  const proc = () => stack.toReversed().find((b) => b.kind === "proc")?.proc;

  const exec = (st: PStmt, t: string, off: number, p: PliProc | undefined) => {
    const line = lineOf(st, off);
    const loc = { file: path, line };
    const b = blank(t);
    if (!p) {
      if (/^(DCL|DECLARE)\b/.test(b)) {
        const kw = /^(DCL|DECLARE)\s*/.exec(t) as RegExpExecArray;
        fragment.push(
          ...parseDeclare(t.slice(kw[0].length), path, (o) => lineOf(st, off + kw[0].length + o))
            .decls,
        );
      } else if (!t.startsWith("%")) {
        gap(line, "statement outside a procedure", t.slice(0, 80));
      }
      return;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(DCL|DECLARE)\s*/.exec(b))) {
      const n = m[0].length;
      const r = parseDeclare(t.slice(n), path, (o) => lineOf(st, off + n + o));
      p.decls.push(...r.decls);
      p.files.push(...r.files);
      p.entries.push(...r.entries);
    } else if ((m = /^CALL\s+([A-Z_#@$][\w#@$]*)\s*/.exec(b))) {
      const argText = t.slice(m[0].length).startsWith("(") ? t.slice(m[0].length) : "";
      const end = argText ? close(argText, 0) : -1;
      p.calls.push({
        ...loc,
        name: m[1],
        args: end > 0 ? split(argText.slice(1, end - 1)).length : 0,
      });
    } else if (/^(FETCH|RELEASE)\b/.test(b)) {
      gap(line, "dynamic load", `${t.slice(0, 80)} (the loaded routine is not linked)`);
    } else if ((m = /^ON\s+([A-Z]+)\s*/.exec(b))) {
      const cond = m[1];
      let rest = t.slice(m[0].length);
      let target: string | undefined;
      if (rest.startsWith("(")) {
        const end = close(rest, 0);
        target = end > 0 ? rest.slice(1, end - 1).trim() : undefined;
        rest = end > 0 ? rest.slice(end) : "";
      }
      const restOff = off + t.length - rest.length;
      const act = rest.replace(/^\s*SNAP\b/, "").trim();
      p.onUnits.push({
        ...loc,
        condition: cond,
        ...(target ? { target } : {}),
        action: /^BEGIN\b/.test(act) ? "BEGIN block" : act === "" ? "(null)" : act.slice(0, 120),
      });
      if (act && !/^(BEGIN|SYSTEM)\b/.test(act)) {
        exec(st, act, restOff + rest.indexOf(act), p);
      }
    } else if ((m = /^EXEC\s+SQL\b\s*/.exec(b))) {
      const sql = t.slice(m[0].length).trim();
      const head = blank(sql);
      if ((m = /^INCLUDE\s+(\w+)/.exec(head))) {
        if (!/^SQL(CA|DA)$/.test(m[1])) {
          gap(line, "EXEC SQL INCLUDE", `${m[1]}: the member is not expanded`);
        }
      } else if (/^(PREPARE|EXECUTE)\b/.test(head)) {
        gap(line, "dynamic SQL", sql.slice(0, 120));
      } else if (!/^(WHENEVER|BEGIN|END|CLOSE|COMMIT|ROLLBACK|CONNECT)\b/.test(head)) {
        const cur = /^DECLARE\s+(\w+)\s+(?:\w+\s+)*?CURSOR\b/.exec(head);
        const { op, tables } = sqlTables(sql.replace(/:\s*[A-Z_#@$][\w#@$.]*/g, ":H"));
        p.sql.push({
          ...loc,
          text: sql.replace(/\s+/g, " "),
          op,
          tables,
          ...(cur ? { cursor: cur[1] } : {}),
        });
      }
    } else if ((m = /^EXEC\s+(CICS|DLI)\b/.exec(b))) {
      gap(line, `EXEC ${m[1]}`, t.slice(0, 120));
    } else if ((m = IO_VERBS.exec(b))) {
      const verb = m[1] as PliIo["verb"];
      if ((verb === "OPEN" || verb === "CLOSE") && /\bFILE\s*\(/.test(b)) {
        for (const part of split(t.slice(m[0].length))) {
          const f = option(part, "FILE");
          if (f) {
            const mode = /\b(INPUT|OUTPUT|UPDATE)\b/.exec(blank(part))?.[1];
            const title = option(part, "TITLE");
            const lit = title && /^'(.*)'$/.exec(title)?.[1];
            p.io.push({
              ...loc,
              verb,
              fileName: f,
              ...(mode ? { mode } : {}),
              ...(lit ? { title: lit } : {}),
            });
          }
        }
        return;
      }
      if ((verb === "GET" || verb === "PUT") && /\bSTRING\s*\(/.test(b)) {
        return; // stream I/O on a character string, not a file
      }
      const f = option(t, "FILE");
      if (!f) {
        if (verb === "GET" || verb === "PUT") {
          p.io.push({ ...loc, verb, fileName: verb === "GET" ? "SYSIN" : "SYSPRINT" });
        }
        return;
      }
      const data =
        option(t, "INTO") ??
        option(t, "FROM") ??
        option(t, "SET") ??
        (verb === "LOCATE" ? /^LOCATE\s+(\w+)/.exec(b)?.[1] : undefined);
      p.io.push({ ...loc, verb, fileName: f, ...(data ? { data } : {}) });
    }
  };

  for (const st of stmts) {
    const { labels, rest, at } = stripLabels(st.text);
    const t = rest;
    const b = blank(t);
    const line = lineOf(st, at);
    const p = proc();
    if (b.startsWith("%")) {
      const inc = /^%\s*INCLUDE\s+(.*)$/.exec(t);
      if (inc) {
        for (const x of split(inc[1])) {
          const name = /^(?:[A-Z_#@$][\w#@$]*\s*\(\s*([\w#@$]+)\s*\)|'([^']+)'|([\w#@$]+))/.exec(
            x.trim(),
          );
          const member = name?.[1] ?? name?.[2] ?? name?.[3];
          if (member && p) {
            p.includes.push({ file: path, line, name: member });
          } else if (member) {
            gap(line, "%INCLUDE outside a procedure", member);
          }
        }
      } else if (!LISTING.test(b)) {
        gap(
          line,
          "macro preprocessor",
          `${t.slice(0, 100)} (not evaluated: the code of every branch is read)`,
        );
      }
      continue;
    }
    if (/^(PROC|PROCEDURE)\b/.test(b)) {
      const name = labels[labels.length - 1] ?? "(UNNAMED)";
      const np = newProc(name, path, line, p);
      const params = /^(?:PROC|PROCEDURE)\s*\(([^)]*)\)/.exec(t);
      if (params) {
        np.params = split(params[1]);
      }
      const opts = option(t, "OPTIONS");
      if (opts) {
        np.options = opts;
        np.main = /\bMAIN\b/.test(opts);
      }
      const ret = option(t, "RETURNS");
      if (ret) {
        np.returns = ret;
      }
      np.recursive = /\bRECURSIVE\b/.test(b);
      const doc = docAbove(line);
      if (doc) {
        np.doc = doc;
      }
      procs.push(np);
      stack.push({ kind: "proc", label: name, proc: np });
      continue;
    }
    if (/^ENTRY\b/.test(b) && labels.length > 0) {
      gap(
        line,
        "ENTRY",
        `${labels[labels.length - 1]}: a secondary entry point of ${p?.name ?? "?"} (not modelled)`,
      );
      continue;
    }
    if (/^END\b/.test(b)) {
      const name = /^END\s+([A-Z_#@$][\w#@$]*)/.exec(b)?.[1];
      if (stack.length === 0) {
        gap(line, "END without block", t);
        continue;
      }
      // END name closes the named block and every open group inside it.
      let idx = stack.length - 1;
      if (name) {
        const k = stack.map((x) => x.label).lastIndexOf(name);
        if (k >= 0) {
          idx = k;
        } else {
          gap(line, "END name mismatch", `END ${name} closes ${stack[idx].label ?? "a group"}`);
        }
      }
      for (const blk of stack.splice(idx)) {
        if (blk.proc) {
          blk.proc.endLine = st.endLine;
        }
      }
      continue;
    }
    const act = action(t);
    if (opensGroup(act.text) || /^ON\b.*\bBEGIN\s*$/.test(blank(act.text))) {
      stack.push({ kind: "group", ...(labels.length ? { label: labels[labels.length - 1] } : {}) });
      if (/^ON\b/.test(act.text)) {
        exec(st, act.text, at + act.at, p);
      }
      continue;
    }
    exec(st, act.text, at + act.at, p);
  }
  for (const blk of stack) {
    if (blk.proc) {
      gap(
        blk.proc.line,
        "unterminated procedure",
        `${blk.proc.name} has no END (the file may be truncated)`,
      );
      blk.proc.endLine = stmts[stmts.length - 1]?.endLine ?? blk.proc.line;
    }
  }
  const last = stmts[stmts.length - 1];
  if (last && !last.terminated) {
    gap(
      last.line,
      "unterminated statement",
      `${last.text.slice(0, 80)} (no ';': the file may be truncated)`,
    );
  }
  return {
    path,
    procs,
    ...(fragment.length > 0 ? { fragment } : {}),
    statements: stmts.length,
    margins,
    gaps: gaps.toSorted((a, b) => a.line - b.line),
  };
}
