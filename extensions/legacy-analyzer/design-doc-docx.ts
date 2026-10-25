// 設計書 as Word: the design document's Markdown, converted deterministically into docx blocks
// (src/office/markdown.ts) and rendered by the shared docx renderer (src/office/docx.ts), written
// into the Project's output/design-docs/ with the office tools' path guards (src/office/target.ts:
// a Project session, a folder the mode makes writable, no symlinks, never over an existing file;
// a taken name gets -2, -3 …). The renderer is shared rather than called through the office
// plugin's tool because the Industrial template does not enable that plugin, and a plugin must
// not depend on another one being loaded; both now use the same module.

import { MAX_OUTPUT_BYTES, OfficeError } from "../../src/office/common.js";
import { renderDocx } from "../../src/office/docx.js";
import { markdownToDocSpec } from "../../src/office/markdown.js";
import { projectForSession, writeUniqueTarget } from "../../src/office/target.js";

export const DESIGN_DOC_DIR = "output/design-docs";

/** YYYYMMDD in the gateway's local time. */
export function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

export function designDocStem(lang: "ja" | "en", now: Date): string {
  return lang === "ja" ? `設計書_${ymd(now)}` : `design-doc_${ymd(now)}`;
}

export async function writeDesignDocx(params: {
  markdown: string;
  lang: "ja" | "en";
  sessionKey: string | undefined;
  now: Date;
  home?: string;
  maxBytes?: number;
}): Promise<{ path: string; bytes: number; blocks: number; tables: number }> {
  const { lang, now } = params;
  const project = projectForSession(params.sessionKey, params.home, { anyMode: true });
  const spec = markdownToDocSpec(params.markdown, {
    lang,
    fallbackTitle: lang === "ja" ? "設計書" : "Design document",
    footer:
      lang === "ja"
        ? "ソースコードから生成（要確認事項は担当者が記入）"
        : "Generated from the source code (items to confirm are for a person to fill in)",
  });
  const out = await renderDocx(spec, now);
  const max = params.maxBytes ?? MAX_OUTPUT_BYTES;
  if (out.buffer.length > max) {
    throw new OfficeError(
      "too_large",
      `the Word file would be ${out.buffer.length} bytes, over the ${max} limit; narrow it with section or program`,
    );
  }
  const target = writeUniqueTarget({
    project,
    dir: DESIGN_DOC_DIR,
    stem: designDocStem(lang, now),
    ext: "docx",
    buf: out.buffer,
  });
  return { path: target.rel, bytes: out.buffer.length, blocks: out.blocks, tables: out.tables };
}
