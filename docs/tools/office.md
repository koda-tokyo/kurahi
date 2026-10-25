---
summary: "Office tools: agents write PowerPoint, Word and Excel files into the current Project folder from a structured spec. Local rendering only; nothing is sent anywhere."
read_when:
  - Letting an agent produce a deck, a document or a workbook in a Project
  - Checking where Office files are written and what is refused
  - Enabling the office plugin
title: "Office documents"
---

# Office documents

日本語: [Office ドキュメント](/ja/tools/office)

Three agent tools (plugin `extensions/office`) write Office files into the **current Project
folder**. The model supplies the content as a structured JSON spec; the tool renders it with a
fixed, calm layout, so the same spec always produces the same file. The files are plain Office
Open XML written on the gateway host: no Office installation, no cloud service, no network call.
**Files are written to the Project folder only, and nothing is sent anywhere.**

| Tool                 | Writes  | Content                                                                                                    |
| -------------------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `office_pptx_create` | `.pptx` | 16:9 deck: title slide, content slides with heading, bullets, KPI cards, native chart, note, speaker notes |
| `office_docx_create` | `.docx` | Title, subtitle, headings (levels 1 to 3), paragraphs, bullet lists, tables, footer and page numbers       |
| `office_xlsx_create` | `.xlsx` | Sheets with a bold frozen header row, typed cells, estimated column widths, number formats per column      |

## Where files go

- `path` is relative to the Project folder, for example `output/review.pptx`. A bare file name
  goes into `output/` when that folder is writable, otherwise into the Project's first writable
  folder. Missing sub-folders are created.
- The extension must match the tool. The file name is cleaned the same way as uploads (no
  control characters or characters Windows forbids).
- Refused: absolute paths, `..`, folders the Project does not mark writable (and read-only
  folders), excluded folders such as `_answer-keys`, any symbolic link on the way or as the file,
  files registered with the integrity registry, and an existing file unless `overwrite: true`.
- The file is written to a temporary name in the same folder and renamed, so nobody sees half a
  file.

## Project modes

The tools work only in a Project chat whose mode is **実行 Act**. In **参照 Read** and **計画
Plan** modes they are refused (the project guard does not offer them, and the tools check the
mode again themselves). Outside a Project they refuse with `not_in_project`.

## office_pptx_create

```json
{
  "path": "output/h1-review.pptx",
  "title": "2026年度 上期 売上レビュー",
  "subtitle": "営業本部",
  "badge": "架空データ・テスト資料",
  "footer": "社外秘",
  "page_numbers": true,
  "slides": [
    {
      "heading": "売上は前年比 12% 増",
      "bullets": ["東日本が牽引", "新製品の寄与"],
      "kpis": [{ "label": "売上高", "value": "¥4.2億" }],
      "chart": {
        "type": "column",
        "categories": ["4月", "5月", "6月"],
        "series": [{ "name": "2026", "values": [110, 140, 150] }],
        "number_format": "#,##0"
      },
      "note": "※ 数値は架空です",
      "speaker_notes": "東日本の伸びを強調する。"
    }
  ]
}
```

- `badge`: short text in a pill at the top right of every slide (for example a "test material"
  marker). `footer`: text at the bottom left of every slide. `page_numbers` (default true):
  "n / N" at the bottom right of content slides.
- Charts are native, editable PowerPoint charts (`column` and `bar` are clustered, `line`), with
  the data embedded as a workbook so "Edit Data" works. Up to 4 series and 24 categories; each
  series has one value per category. Optional `title`, `number_format`, `data_labels`.
- Text sizes are fitted to their boxes. Fonts: Yu Gothic for Latin and Japanese text; where it is
  missing, Office substitutes a sans-serif face (for example Meiryo).
- `speaker_notes` at the top level may be an array giving each content slide's notes by position;
  a slide's own `speaker_notes` wins.

## office_docx_create

`blocks` is a list of objects with `type`:

| `type`      | Fields                                                              |
| ----------- | ------------------------------------------------------------------- |
| `heading`   | `text`, `level` (1, 2 or 3; default 1)                              |
| `paragraph` | `text` (line breaks are kept)                                       |
| `bullets`   | `items` (strings)                                                   |
| `table`     | `header` (at most 12 columns), `rows` (strings), optional `caption` |

Top level: `title`, optional `subtitle`, `footer`, `page_numbers` (default true, "n / N"),
`page_size` (`A4` default, or `Letter`), `language` (`ja` default, or `en`).

## office_xlsx_create

```json
{
  "path": "output/sales.xlsx",
  "sheets": [
    {
      "name": "月次",
      "header": ["月", "売上", "前年比", "締め日"],
      "rows": [["4月", 68000000, 0.097, "2026-04-30"]],
      "column_formats": ["", "#,##0", "0.0%"]
    }
  ]
}
```

- Cells: strings, numbers, booleans, `null` (empty), and ISO dates (`2026-04-30`,
  `2026-04-30T18:00`), which become real Excel dates.
- Text is always stored as text, never as a formula: a cell starting with `=` stays a string.
- Sheet names: at most 31 characters, no `[ ] : * ? / \`, unique.

## Limits

| Limit                           | Value                                                |
| ------------------------------- | ---------------------------------------------------- |
| Slides                          | 40 including the title slide                         |
| Bullets / KPI cards per slide   | 4 / 3                                                |
| Chart series / categories       | 4 / 24                                               |
| Heading / bullet / note length  | 160 / 300 / 300 characters                           |
| Document blocks / table columns | 2,000 / 12 (500 rows per table)                      |
| Workbook                        | 20 sheets, 200 columns, 50,000 rows, 1,000,000 cells |
| File size                       | 20 MB                                                |

A spec over a limit is refused with a message naming the field, for example
`slides[2].bullets: at most 4 items (got 5)`. Nothing is written.

## Audit

Every call writes one audit row (`office.pptx.create`, `office.docx.create`,
`office.xlsx.create`) with the outcome, the file kind, the byte size and the counts (slides and
charts, blocks and tables, sheets and rows). No content and no file names are recorded.

## Enabling

The plugin is off by default. To give the tools to every Project session:
`kurahi config set plugins.entries.office.enabled true`. The manifest declares
`"projectScope": true`, so a Project template can enable it for its Projects only with
`"plugins": ["office"]` (see [Legacy analyser](/tools/legacy-analyzer#enabled-per-project-not-for-the-gateway)
for how project-scoped plugins work).

The generated files open in Microsoft Office and LibreOffice. The gateway's document checks
(`src/projects/documents.ts`) recognise all three kinds, including `.pptx`, whose slide text is
extracted for the agent.
