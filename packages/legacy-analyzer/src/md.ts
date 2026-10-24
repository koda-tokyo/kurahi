// Markdown helpers for the generated documents: citations, table cells, tables and Mermaid
// identifiers and labels. Output is plain GitHub-flavoured Markdown.

import type { Loc } from "./types.js";

/** `path:line` in code style: the citation every fact line carries. */
export function cite(l: Loc | undefined): string {
  return l ? `\`${l.file}:${l.line}\`` : "";
}

/** Distinct citations, sorted by file and line, joined with spaces (at most `max`, then "+N"). */
export function cites(locs: Array<Loc | undefined>, max = 6): string {
  const seen = new Map<string, Loc>();
  for (const l of locs) {
    if (l) {
      seen.set(`${l.file}:${l.line}`, l);
    }
  }
  const sorted = [...seen.values()].toSorted((a, b) =>
    a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line,
  );
  const shown = sorted.slice(0, max).map(cite);
  if (sorted.length > max) {
    shown.push(`+${sorted.length - max}`);
  }
  return shown.join(" ");
}

/** Text safe inside a table cell. */
export function cell(s: string | number | undefined): string {
  if (s === undefined || s === "") {
    return "";
  }
  return String(s).replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");
}

/** Text as inline code inside a table cell (backticks in the text are replaced). */
export function code(s: string | undefined): string {
  if (!s) {
    return "";
  }
  return `\`${cell(s.replace(/\s*\r?\n\s*/g, " ")).replace(/`/g, "'")}\``;
}

export function table(
  headers: string[],
  rows: Array<Array<string | number | undefined>>,
): string[] {
  const out = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const r of rows) {
    out.push(`| ${r.map((c) => (c === undefined ? "" : String(c))).join(" | ")} |`);
  }
  return out;
}

/** Short Mermaid node ids (`n1`, `n2`, ...) allocated in first-use order: deterministic. */
export function mermaidIds(prefix = "n"): (key: string) => string {
  const ids = new Map<string, string>();
  return (key: string) => {
    let id = ids.get(key);
    if (!id) {
      id = `${prefix}${ids.size + 1}`;
      ids.set(key, id);
    }
    return id;
  };
}

/** A quoted Mermaid label with the characters Mermaid treats specially written as entities. */
export function mermaidLabel(s: string): string {
  return `"${s.replace(/&/g, "#38;").replace(/"/g, "#quot;").replace(/</g, "#lt;").replace(/>/g, "#gt;")}"`;
}

/** Lines of a section, separated by a blank line. */
export function block(...parts: Array<string[] | string>): string[] {
  const out: string[] = [];
  for (const p of parts) {
    const lines = typeof p === "string" ? [p] : p;
    if (lines.length === 0) {
      continue;
    }
    if (out.length > 0) {
      out.push("");
    }
    out.push(...lines);
  }
  return out;
}
