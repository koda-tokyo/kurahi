import { describe, expect, it } from "vitest";
import { inlineText, markdownToDocSpec, tableCells } from "./markdown.js";

const MD = [
  "# 設計書：source",
  "",
  "> 本書の記載はすべて事実です。",
  ">",
  "> 解析対象：5 ファイル",
  "",
  "## 1. システム概要",
  "",
  "### 1.1 資産一覧",
  "",
  "| 種別 | 名称 | 根拠 |",
  "| --- | --- | --- |",
  "| COBOL | `ORD\\|CALC` | `cobol/ORDCALC.cbl:1` |",
  "| JCL | ORDJOB<br>S1 |",
  "",
  "```mermaid",
  "flowchart LR",
  '  n1["ORDCALC"]',
  "```",
  "",
  "1. 一番目",
  "- **要確認** の項目 `a.cbl:3`",
  "  - 入れ子 [link](https://example.com)",
  "#### 3.1.1 基本情報",
  "本文の一行目",
  "二行目",
].join("\n");

describe("markdown → docx blocks", () => {
  it("converts headings, quotes, tables, code, lists and paragraphs deterministically", () => {
    const spec = markdownToDocSpec(MD, { lang: "ja", fallbackTitle: "x" });
    expect(spec.title).toBe("設計書：source");
    expect(spec.lang).toBe("ja");
    expect(spec.blocks).toEqual([
      { type: "paragraph", text: "本書の記載はすべて事実です。" },
      { type: "paragraph", text: "解析対象：5 ファイル" },
      { type: "heading", text: "1. システム概要", level: 1 },
      { type: "heading", text: "1.1 資産一覧", level: 2 },
      {
        type: "table",
        header: ["種別", "名称", "根拠"],
        rows: [
          ["COBOL", "ORD|CALC", "cobol/ORDCALC.cbl:1"],
          ["JCL", "ORDJOB\nS1", ""],
        ],
      },
      { type: "code", text: 'flowchart LR\n  n1["ORDCALC"]' },
      {
        type: "bullets",
        items: [
          { text: "1. 一番目", level: 0 },
          { text: "要確認 の項目 a.cbl:3", level: 0 },
          { text: "入れ子 link (https://example.com)", level: 1 },
        ],
      },
      { type: "heading", text: "3.1.1 基本情報", level: 3 },
      { type: "paragraph", text: "本文の一行目 二行目" },
    ]);
    expect(markdownToDocSpec(MD, { lang: "ja", fallbackTitle: "x" })).toEqual(spec);
  });

  it("uses the fallback title and keeps inline text readable", () => {
    expect(markdownToDocSpec("text", { lang: "en", fallbackTitle: "Doc" }).title).toBe("Doc");
    expect(inlineText("**a** `b` \\| c")).toBe("a b | c");
    expect(tableCells("| a | b \\| c |")).toEqual(["a", "b | c"]);
  });
});
