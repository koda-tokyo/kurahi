// Minimal Markdown sectioning for vendor documents: ATX headings (`#` to `######`) split the
// file; fenced code blocks are skipped so a `#` inside code is not a heading. Nothing else of
// Markdown is interpreted.

export type MdSection = {
  heading: string;
  level: number;
  line: number;
  body: { text: string; line: number }[];
};

export function sectionsOf(text: string): { preamble: MdSection; sections: MdSection[] } {
  const preamble: MdSection = { heading: "", level: 0, line: 0, body: [] };
  const sections: MdSection[] = [];
  let current = preamble;
  let fence: string | null = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(raw);
    if (fenceMatch) {
      const mark = fenceMatch[1][0];
      fence = fence === null ? mark : fence === mark ? null : fence;
      current.body.push({ text: raw, line });
      return;
    }
    const h = fence === null ? /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw) : null;
    if (h) {
      current = { heading: cleanInline(h[2]), level: h[1].length, line, body: [] };
      sections.push(current);
      return;
    }
    current.body.push({ text: raw, line });
  });
  return { preamble, sections };
}

/** Strip emphasis, inline code and link markup from a heading or list item. */
export function cleanInline(s: string): string {
  return s
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** List items (`-`, `*`, `+`, `1.`) of a section body, continuation lines folded in. */
export function listItems(body: MdSection["body"]): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let cur: { text: string; line: number } | null = null;
  for (const b of body) {
    const m = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/.exec(b.text);
    if (m) {
      cur = { text: m[1], line: b.line };
      out.push(cur);
    } else if (cur && /^\s{2,}\S/.test(b.text)) {
      cur.text += ` ${b.text.trim()}`;
    } else if (!b.text.trim()) {
      cur = null;
    }
  }
  return out;
}

/** Paragraphs (blank-line separated) of a section body, for sections written as prose. */
export function paragraphs(body: MdSection["body"]): { text: string; line: number }[] {
  const out: { text: string; line: number }[] = [];
  let cur: { text: string; line: number } | null = null;
  for (const b of body) {
    if (!b.text.trim()) {
      cur = null;
      continue;
    }
    if (cur) {
      cur.text += ` ${b.text.trim()}`;
    } else {
      cur = { text: b.text.trim(), line: b.line };
      out.push(cur);
    }
  }
  return out;
}
