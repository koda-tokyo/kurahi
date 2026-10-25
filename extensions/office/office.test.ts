import JSZip from "jszip";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import type { KoLoPluginApi, KoLoPluginAuditInput } from "../../src/plugins/types.js";
import type { ProjectMode } from "../../src/projects/types.js";
import { loadPluginManifest } from "../../src/plugins/manifest.js";
import { extractText, validateDocument } from "../../src/projects/documents.js";
import { projectSessionKey } from "../../src/projects/scope.js";
import { createProject } from "../../src/projects/store.js";
import register, { createOfficeTools, OFFICE_TOOL_NAMES } from "./index.js";

const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kurahi-office-test-")));
const home = path.join(tmpRoot, "state");
fs.mkdirSync(home, { recursive: true });
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const NOW = new Date("2026-10-25T09:00:00Z");
const rules = {
  readOnly: ["source"],
  writable: ["output", "notes"],
  artifactApprovalRequired: false,
  instructions: [],
};

let seq = 0;
function setup(mode: ProjectMode = "act", maxBytes?: number) {
  const folder = path.join(tmpRoot, `project-${++seq}`);
  for (const sub of ["source", "output", "notes"]) {
    fs.mkdirSync(path.join(folder, sub), { recursive: true });
  }
  const project = createProject(
    { name: `Office ${seq}`, folder, rules, mode },
    { createdBy: "owner", home },
  );
  const audits: KoLoPluginAuditInput[] = [];
  const tools = createOfficeTools({
    agentId: "main",
    sessionKey: projectSessionKey("main", project.id, "c1"),
    audit: (a) => audits.push(a),
    home,
    now: () => NOW,
    maxBytes,
  });
  const tool = (name: string) => {
    const t = tools.find((x) => x.name === name);
    if (!t) {
      throw new Error(`missing ${name}`);
    }
    return (params: Record<string, unknown>) =>
      (
        t as unknown as {
          execute: (
            id: string,
            p: Record<string, unknown>,
          ) => Promise<{ content: Array<{ text: string }>; details?: Record<string, unknown> }>;
        }
      ).execute("call-1", params);
  };
  return {
    folder: project.folder,
    audits,
    pptx: tool("office_pptx_create"),
    docx: tool("office_docx_create"),
    xlsx: tool("office_xlsx_create"),
  };
}

const BADGE = "架空データ・テスト資料";

function deck(extra: Record<string, unknown> = {}) {
  return {
    path: "output/売上レビュー.pptx",
    title: "2026年度 上期 売上レビュー",
    subtitle: "営業本部 / 架空データ",
    badge: BADGE,
    footer: "社外秘",
    slides: [
      {
        heading: "売上は前年比 12% 増",
        bullets: ["東日本が牽引", "新製品の寄与が大きい", "下期は在庫調整に注意"],
        kpis: [
          { label: "売上高", value: "¥4.2億" },
          { label: "前年比", value: "+12%" },
          { label: "粗利率", value: "38.5%" },
        ],
        chart: {
          type: "column",
          categories: ["4月", "5月", "6月"],
          series: [
            { name: "2025", values: [100, 120, 130] },
            { name: "2026", values: [110, 140, 150] },
          ],
          number_format: "#,##0",
        },
        note: "※ 数値はすべて架空です",
        speaker_notes: "ここで東日本の伸びを強調する。",
      },
      {
        heading: "地域別",
        chart: {
          type: "bar",
          categories: ["東", "西"],
          series: [{ name: "売上", values: [3, 2] }],
        },
      },
      {
        heading: "推移",
        chart: {
          type: "line",
          categories: ["Q1", "Q2"],
          series: [{ name: "件数", values: [5, 7] }],
        },
        bullets: ["増加傾向"],
      },
      { heading: "まとめ", bullets: ["下期計画を見直す"], chart: null },
    ],
    ...extra,
  };
}

async function unzip(file: string) {
  return JSZip.loadAsync(fs.readFileSync(file));
}

describe("office plugin wiring", () => {
  it("ships a valid, project-scoped manifest and registers the three tools", () => {
    const res = loadPluginManifest(fileURLToPath(new URL(".", import.meta.url)));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.manifest.id).toBe("office");
    }
    const registered: unknown[] = [];
    register({
      registerTool: (_t: unknown, opts?: { names?: string[] }) => registered.push(opts?.names),
      audit: () => {},
    } as unknown as KoLoPluginApi);
    expect(registered).toEqual([OFFICE_TOOL_NAMES]);
  });
});

describe("office_pptx_create", () => {
  it("writes a deck with native charts, notes, badge and page numbers into the project", async () => {
    const env = setup();
    const res = await env.pptx(deck());
    expect(res.content[0].text).toContain("Wrote output/売上レビュー.pptx");
    expect(res.details).toMatchObject({ slides: 5, charts: 3 });
    const file = path.join(env.folder, "output", "売上レビュー.pptx");
    const zip = await unzip(file);
    for (const part of [
      "[Content_Types].xml",
      "ppt/presentation.xml",
      "ppt/_rels/presentation.xml.rels",
      "ppt/slideMasters/slideMaster1.xml",
      "ppt/slideLayouts/slideLayout1.xml",
      "ppt/theme/theme1.xml",
      "ppt/slides/slide5.xml",
      "ppt/notesMasters/notesMaster1.xml",
      "ppt/notesSlides/notesSlide2.xml",
      "ppt/charts/chart1.xml",
      "ppt/charts/chart3.xml",
      "ppt/charts/_rels/chart1.xml.rels",
      "ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx",
    ]) {
      expect(zip.file(part), part).toBeTruthy();
    }
    const types = await zip.file("[Content_Types].xml")!.async("string");
    expect(types).toContain('PartName="/ppt/charts/chart1.xml"');
    expect(types).toContain('Extension="xlsx"');
    const c1 = await zip.file("ppt/charts/chart1.xml")!.async("string");
    expect(c1).toContain('<c:barDir val="col"/>');
    expect(c1).toContain('<c:grouping val="clustered"/>');
    expect(c1.match(/<c:ser>/g)).toHaveLength(2);
    expect(c1).toContain("<c:v>4月</c:v>");
    expect(await zip.file("ppt/charts/chart2.xml")!.async("string")).toContain(
      '<c:barDir val="bar"/>',
    );
    expect(await zip.file("ppt/charts/chart3.xml")!.async("string")).toContain("<c:lineChart>");
    const slide2 = await zip.file("ppt/slides/slide2.xml")!.async("string");
    expect(slide2).toContain("http://schemas.openxmlformats.org/drawingml/2006/chart");
    expect(slide2).toContain(BADGE);
    expect(slide2).toContain("2 / 5");
    expect(slide2).toContain('typeface="Yu Gothic"');
    expect(await zip.file("ppt/slides/slide5.xml")!.async("string")).toContain("5 / 5");
    expect(await zip.file("ppt/notesSlides/notesSlide2.xml")!.async("string")).toContain(
      "東日本の伸びを強調",
    );
    // The embedded workbook carries the chart data (Edit Data).
    const embedded = await zip
      .file("ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx")!
      .async("nodebuffer");
    expect(await extractText("xlsx", embedded)).toContain("4月,100,110");

    // Round trip through the project's own document checks.
    const buf = fs.readFileSync(file);
    expect(await validateDocument("deck.pptx", buf)).toEqual({ ok: true, kind: "pptx" });
    const text = await extractText("pptx", buf);
    expect(text).toContain("2026年度 上期 売上レビュー");
    expect(text).toContain("売上は前年比 12% 増");
    expect(text).toContain("¥4.2億");
    expect(text).toContain(BADGE);

    // Audit: kind, size and counts only.
    expect(env.audits).toHaveLength(1);
    expect(env.audits[0]).toMatchObject({
      action: "office.pptx.create",
      outcome: "ok",
      detail: { kind: "pptx", bytes: buf.length, slides: 5, charts: 3 },
    });
    const auditText = JSON.stringify(env.audits);
    expect(auditText).not.toContain("売上");
    expect(auditText).not.toContain(BADGE);
  });

  it("renders the same spec to the same bytes", async () => {
    const env = setup();
    await env.pptx(deck({ path: "a.pptx" }));
    await env.pptx(deck({ path: "b.pptx" }));
    const a = fs.readFileSync(path.join(env.folder, "output", "a.pptx"));
    const b = fs.readFileSync(path.join(env.folder, "output", "b.pptx"));
    expect(a.equals(b)).toBe(true);
  });

  it("refuses bad specs with clear errors", async () => {
    const env = setup();
    const slide = { heading: "x" };
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ slides: Array.from({ length: 40 }, () => slide) }, /slides: at most 39/],
      [{ slides: [{ heading: "x", bullets: ["1", "2", "3", "4", "5"] }] }, /bullets: at most 4/],
      [
        {
          slides: [
            { heading: "x", kpis: [1, 2, 3, 4].map((n) => ({ label: `k${n}`, value: "1" })) },
          ],
        },
        /kpis: at most 3/,
      ],
      [
        {
          slides: [
            {
              heading: "x",
              chart: {
                type: "column",
                categories: ["a"],
                series: [1, 2, 3, 4, 5].map((n) => ({ name: `s${n}`, values: [1] })),
              },
            },
          ],
        },
        /series: at most 4/,
      ],
      [
        {
          slides: [
            {
              heading: "x",
              chart: {
                type: "column",
                categories: Array.from({ length: 25 }, (_, i) => `c${i}`),
                series: [],
              },
            },
          ],
        },
        /categories: at most 24/,
      ],
      [
        {
          slides: [
            {
              heading: "x",
              chart: {
                type: "column",
                categories: ["a", "b"],
                series: [{ name: "s", values: [1] }],
              },
            },
          ],
        },
        /values: at least 2/,
      ],
      [
        { slides: [{ heading: "x", chart: { type: "pie", categories: ["a"], series: [] } }] },
        /type must be one of/,
      ],
      [{ slides: [{ heading: "y".repeat(161) }] }, /heading is too long/],
      [{ title: "" }, /title is required/],
    ];
    for (const [patch, re] of cases) {
      const res = await env.pptx({ ...deck({ path: "bad.pptx" }), ...patch });
      expect(res.content[0].text, String(re)).toMatch(re);
      expect(res.details?.error).toBe("bad_request");
    }
    expect(fs.existsSync(path.join(env.folder, "output", "bad.pptx"))).toBe(false);
  });
});

describe("office_docx_create", () => {
  it("writes headings, paragraphs, bullets, a table and a footer", async () => {
    const env = setup();
    const res = await env.docx({
      path: "notes/議事録.docx",
      title: "定例会議 議事録",
      subtitle: "2026年10月25日",
      footer: "社外秘・架空データ",
      blocks: [
        { type: "heading", text: "決定事項", level: 1 },
        { type: "paragraph", text: "次回までに見積を更新する。\n担当は営業部。" },
        { type: "bullets", items: ["見積の更新", "顧客への連絡"] },
        { type: "heading", text: "数値", level: 2 },
        {
          type: "table",
          header: ["項目", "値"],
          rows: [["売上", "4.2億"], ["件数"]],
          caption: "表1 概要",
        },
        { type: "heading", text: "補足", level: 3 },
        { type: "paragraph", text: "制御\u0007文字\uD800は除く & <ok>" },
      ],
    });
    expect(res.content[0].text).toContain("Wrote notes/議事録.docx");
    const file = path.join(env.folder, "notes", "議事録.docx");
    const zip = await unzip(file);
    for (const part of [
      "[Content_Types].xml",
      "word/document.xml",
      "word/styles.xml",
      "word/numbering.xml",
      "word/footer1.xml",
      "word/_rels/document.xml.rels",
    ]) {
      expect(zip.file(part), part).toBeTruthy();
    }
    const doc = await zip.file("word/document.xml")!.async("string");
    expect(doc).toContain('<w:pStyle w:val="Heading1"/>');
    expect(doc).toContain('<w:pStyle w:val="Heading3"/>');
    expect(doc).toContain('<w:numId w:val="1"/>');
    expect(doc.match(/<w:gridCol /g)).toHaveLength(2);
    const footer = await zip.file("word/footer1.xml")!.async("string");
    expect(footer).toContain("社外秘・架空データ");
    expect(footer).toContain("NUMPAGES");

    const buf = fs.readFileSync(file);
    expect(await validateDocument("x.docx", buf)).toEqual({ ok: true, kind: "docx" });
    const text = await extractText("docx", buf);
    expect(text).toContain("定例会議 議事録");
    expect(text).toContain("次回までに見積を更新する。");
    expect(text).toContain("4.2億");
    expect(text).toContain("制御文字は除く & <ok>");
    expect(env.audits[0]).toMatchObject({
      action: "office.docx.create",
      outcome: "ok",
      detail: { kind: "docx", blocks: 7, tables: 1 },
    });
  });

  it("refuses more than 12 table columns and unknown block types", async () => {
    const env = setup();
    const base = { path: "d.docx", title: "T" };
    const wide = await env.docx({
      ...base,
      blocks: [{ type: "table", header: Array.from({ length: 13 }, (_, i) => `c${i}`), rows: [] }],
    });
    expect(wide.content[0].text).toMatch(/header: at most 12/);
    const extra = await env.docx({
      ...base,
      blocks: [{ type: "table", header: ["a"], rows: [["1", "2"]] }],
    });
    expect(extra.content[0].text).toMatch(/rows\[0\]: at most 1/);
    const unknown = await env.docx({ ...base, blocks: [{ type: "image" }] });
    expect(unknown.content[0].text).toMatch(/type must be one of/);
    const level = await env.docx({ ...base, blocks: [{ type: "heading", text: "x", level: 4 }] });
    expect(level.content[0].text).toMatch(/level must be 1, 2 or 3/);
  });
});

describe("office_xlsx_create", () => {
  it("writes sheets with a frozen bold header, dates, number formats and widths", async () => {
    const env = setup();
    const res = await env.xlsx({
      path: "output/売上.xlsx",
      sheets: [
        {
          name: "月次",
          header: ["月", "売上", "比率", "日付", "メモ"],
          rows: [
            ["4月", 1234567, 0.125, "2026-04-01", "=SUM(A1:A9)"],
            ["5月", 2345678, 0.25, "2026-05-01T09:30", "東日本が好調"],
            ["6月", null, true],
          ],
          column_formats: ["", "#,##0", "0.0%"],
        },
        { name: "Other", header: ["a"], rows: [] },
      ],
    });
    expect(res.content[0].text).toContain("Wrote output/売上.xlsx");
    expect(res.details).toMatchObject({ sheets: 2, rows: 3 });
    const file = path.join(env.folder, "output", "売上.xlsx");
    const zip = await unzip(file);
    for (const part of [
      "[Content_Types].xml",
      "xl/workbook.xml",
      "xl/styles.xml",
      "xl/sharedStrings.xml",
      "xl/worksheets/sheet1.xml",
      "xl/worksheets/sheet2.xml",
    ]) {
      expect(zip.file(part), part).toBeTruthy();
    }
    const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<c r="A1" s="1" t="s">');
    expect(sheet).toContain("<v>46113</v>"); // 2026-04-01 as an Excel serial date
    expect(sheet).toContain('<c r="E2" t="s">'); // "=SUM(...)" stays text, never a formula
    expect(sheet).not.toContain("<f>");
    expect(sheet).toMatch(/<col min="5" max="5" width="(\d+)"/);
    const styles = await zip.file("xl/styles.xml")!.async("string");
    expect(styles).toContain('formatCode="#,##0"');
    expect(styles).toContain('formatCode="0.0%"');
    expect(styles).toContain("<b/>");

    const buf = fs.readFileSync(file);
    expect(await validateDocument("x.xlsx", buf)).toEqual({ ok: true, kind: "xlsx" });
    const text = await extractText("xlsx", buf);
    expect(text).toContain("## 月次");
    expect(text).toContain("月,売上,比率,日付,メモ");
    expect(text).toContain("4月,1234567,0.125,46113,=SUM(A1:A9)");
    expect(text).toContain("東日本が好調");
    expect(text).toContain("## Other");
  });

  it("refuses too many rows, long rows and bad sheet names", async () => {
    const env = setup();
    const many = await env.xlsx({
      path: "big.xlsx",
      sheets: [{ name: "a", header: ["n"], rows: Array.from({ length: 50_001 }, (_, i) => [i]) }],
    });
    expect(many.content[0].text).toMatch(/at most 50000/);
    const long = await env.xlsx({
      path: "r.xlsx",
      sheets: [{ name: "a", header: ["n"], rows: [[1, 2]] }],
    });
    expect(long.content[0].text).toMatch(/rows\[0\]: at most 1/);
    const name = await env.xlsx({
      path: "n.xlsx",
      sheets: [{ name: "a/b", header: ["n"], rows: [] }],
    });
    expect(name.content[0].text).toMatch(/name may not contain/);
    const dup = await env.xlsx({
      path: "n.xlsx",
      sheets: [
        { name: "A", header: ["n"], rows: [] },
        { name: "a", header: ["n"], rows: [] },
      ],
    });
    expect(dup.content[0].text).toMatch(/used twice/);
  });
});

describe("where office files may be written", () => {
  const sheet = { sheets: [{ name: "s", header: ["a"], rows: [[1]] }] };

  it("refuses path escapes, absolute paths, wrong extensions and folders outside writable", async () => {
    const env = setup();
    for (const p of [
      "../x.xlsx",
      "output/../../x.xlsx",
      "/tmp/x.xlsx",
      "C:/x.xlsx",
      "~/x.xlsx",
      "output/./x.xlsx",
    ]) {
      const res = await env.xlsx({ ...sheet, path: p });
      expect(res.details?.error, p).toBe("path");
    }
    expect((await env.xlsx({ ...sheet, path: "output/x.docx" })).content[0].text).toMatch(
      /must end in \.xlsx/,
    );
    const ro = await env.xlsx({ ...sheet, path: "source/x.xlsx" });
    expect(ro.content[0].text).toMatch(/not in a writable folder/);
    const root = await env.xlsx({ ...sheet, path: "elsewhere/x.xlsx" });
    expect(root.details?.error).toBe("path");
    expect(fs.existsSync(path.join(env.folder, "elsewhere"))).toBe(false);
    expect(env.audits.every((a) => a.outcome === "denied")).toBe(true);
  });

  it("refuses symlinks out of the project, for folders and for files", async () => {
    const env = setup();
    const outside = fs.mkdtempSync(path.join(tmpRoot, "outside-"));
    fs.symlinkSync(outside, path.join(env.folder, "output", "link"));
    const viaDir = await env.xlsx({ ...sheet, path: "output/link/x.xlsx" });
    expect(viaDir.content[0].text).toMatch(/symbolic link/);
    fs.symlinkSync(path.join(outside, "target.xlsx"), path.join(env.folder, "output", "f.xlsx"));
    const viaFile = await env.xlsx({ ...sheet, path: "output/f.xlsx", overwrite: true });
    expect(viaFile.content[0].text).toMatch(/symbolic link/);
    expect(fs.readdirSync(outside)).toEqual([]);
  });

  it("refuses to overwrite unless asked", async () => {
    const env = setup();
    expect((await env.xlsx({ ...sheet, path: "x.xlsx" })).details?.error).toBeUndefined();
    const again = await env.xlsx({ ...sheet, path: "x.xlsx" });
    expect(again.details?.error).toBe("exists");
    expect(again.content[0].text).toMatch(/overwrite: true/);
    const replaced = await env.xlsx({ ...sheet, path: "x.xlsx", overwrite: true });
    expect(replaced.details?.error).toBeUndefined();
    expect(fs.readdirSync(path.join(env.folder, "output"))).toEqual(["x.xlsx"]);
  });

  it("refuses in 参照 Read and 計画 Plan modes and outside a Project", async () => {
    for (const mode of ["read", "plan"] as const) {
      const env = setup(mode);
      const res = await env.pptx(deck({ path: "x.pptx" }));
      expect(res.details?.error).toBe("mode");
      expect(res.content[0].text).toMatch(/実行 Act/);
      expect(fs.readdirSync(path.join(env.folder, "output"))).toEqual([]);
    }
    const [tool] = createOfficeTools({ sessionKey: "agent:main:main", home });
    const res = await (
      tool as unknown as {
        execute: (id: string, p: unknown) => Promise<{ details?: Record<string, unknown> }>;
      }
    ).execute("c", deck());
    expect(res.details?.error).toBe("not_in_project");
  });

  it("refuses files over the size cap", async () => {
    const env = setup("act", 1000);
    const res = await env.xlsx({ ...sheet, path: "cap.xlsx" });
    expect(res.details?.error).toBe("too_large");
    expect(res.content[0].text).toMatch(/over the .* limit/);
    expect(fs.existsSync(path.join(env.folder, "output", "cap.xlsx"))).toBe(false);
  });
});

describe("document language", () => {
  it("uses the spec's language, else Japanese only when the text has kana or kanji", async () => {
    const { pickLang } = await import("../../src/office/common.js");
    expect(pickLang("en", "日本語")).toBe("en");
    expect(pickLang(undefined, "Approvals and security")).toBe("en");
    expect(pickLang(undefined, "承認とセキュリティ")).toBe("ja");
    expect(pickLang(undefined, "カタカナ only")).toBe("ja");
  });
});
