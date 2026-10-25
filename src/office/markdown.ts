// Markdown → DOCX blocks: a deterministic conversion of the GitHub-flavoured Markdown the
// generators in this repo write (headings, paragraphs, block quotes, bullet and numbered lists,
// pipe tables, fenced code such as Mermaid) into the docx renderer's blocks. The same Markdown
// always gives the same blocks; inline markup is reduced to its text (code spans, bold, links
// as "text (url)"), table cells keep their `<br>` line breaks.

import type { DocBlock, DocSpec } from "./docx.js";

export type MarkdownDocOptions = {
  lang: "ja" | "en";
  /** Title when the Markdown has no level-1 heading. */
  fallbackTitle: string;
  footer?: string;
};

const FENCE_RE = /^\s*(```|~~~)/;
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const RULE_RE = /^\s*([-*_])(\s*\1){2,}\s*$/;

/** Inline Markdown reduced to plain text. */
export function inlineText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) =>
      text && text !== url ? `${text} (${url})` : url,
    )
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|>])/g, "$1");
}

/** The cells of one pipe-table row (escaped pipes stay inside their cell). */
export function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) {
    s = s.slice(1);
  }
  if (s.endsWith("|") && !s.endsWith("\\|")) {
    s = s.slice(0, -1);
  }
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur);
  return cells.map((c) => inlineText(c.trim()));
}

export function markdownToDocSpec(markdown: string, opts: MarkdownDocOptions): DocSpec {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: DocBlock[] = [];
  let title: string | undefined;
  let para: string[] = [];
  let quote: string[] = [];
  let bullets: Array<{ text: string; level: number }> = [];

  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ type: "paragraph", text: inlineText(para.join(" ")) });
      para = [];
    }
  };
  const flushQuote = () => {
    // A blank `>` line separates paragraphs of the quote.
    const text = quote.join("\n").trim();
    for (const p of text.split(/\n{2,}/)) {
      if (p.trim()) {
        blocks.push({ type: "paragraph", text: inlineText(p.replace(/\n/g, " ").trim()) });
      }
    }
    quote = [];
  };
  const flushBullets = () => {
    if (bullets.length > 0) {
      blocks.push({ type: "bullets", items: bullets });
      bullets = [];
    }
  };
  const flushAll = () => {
    flushPara();
    flushQuote();
    flushBullets();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushAll();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) {
        body.push(lines[i]);
        i++;
      }
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushBullets();
      if (quote.length > 0) {
        flushQuote();
      }
      continue;
    }
    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll();
      const text = inlineText(heading[2]);
      const depth = heading[1].length;
      if (depth === 1 && title === undefined) {
        title = text;
      } else {
        // `#` after the title and `##` are level 1; `###` level 2; deeper ones level 3.
        const level = depth <= 2 ? 1 : depth === 3 ? 2 : 3;
        blocks.push({ type: "heading", text, level });
      }
      continue;
    }
    if (line.trimStart().startsWith(">")) {
      flushPara();
      flushBullets();
      quote.push(line.trimStart().replace(/^>\s?/, ""));
      continue;
    }
    if (quote.length > 0) {
      flushQuote();
    }
    if (line.trimStart().startsWith("|") && TABLE_SEP_RE.test(lines[i + 1] ?? "")) {
      flushAll();
      const header = tableCells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const cells = tableCells(lines[i]).slice(0, header.length);
        while (cells.length < header.length) {
          cells.push("");
        }
        rows.push(cells);
        i++;
      }
      i--;
      blocks.push({ type: "table", header, rows });
      continue;
    }
    const item = LIST_RE.exec(line);
    if (item) {
      flushPara();
      const indent = item[1].replace(/\t/g, "  ").length;
      const ordered = /^\d/.test(item[2]);
      const text = inlineText(item[3]);
      bullets.push({
        text: ordered ? `${item[2]} ${text}` : text,
        level: Math.min(2, Math.floor(indent / 2)),
      });
      continue;
    }
    if (RULE_RE.test(line)) {
      flushAll();
      continue;
    }
    if (bullets.length > 0 && /^\s+/.test(line)) {
      // A continuation line of the last list item.
      const last = bullets[bullets.length - 1];
      last.text = `${last.text} ${inlineText(line.trim())}`;
      continue;
    }
    flushBullets();
    para.push(line.trim());
  }
  flushAll();
  return {
    title: title ?? opts.fallbackTitle,
    ...(opts.footer ? { footer: opts.footer } : {}),
    pageNumbers: true,
    pageSize: "A4",
    lang: opts.lang,
    blocks,
  };
}
