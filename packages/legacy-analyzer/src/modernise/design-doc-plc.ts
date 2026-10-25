// PLC プログラム仕様 / PLC program specifications of the design document (IEC 61131-3 Structured
// Text): the POU list, the I/O allocation table (入出力割付表) ordered by address, the data types,
// then per POU its purpose (the comment above the header, or an explicit placeholder), declaration,
// variables, calls and assignment targets, and finally what the engine did not read. Every fact
// line cites `path:line`. Source text only: nothing here comes from a controller.

import type { DocCtx } from "../design-doc-context.js";
import type { DocLang } from "../doc-i18n.js";
import type { PlcAnalysis, PlcPou } from "./plc-st-types.js";
import { cell, cite, cites, code, table } from "../md.js";

const en = {
  plc: "PLC program specifications (IEC 61131-3)",
  note: "Read from Structured Text source and PLCopen XML exports only; no controller was connected. Addresses are as declared (AT %I / %Q / %M), not as configured on the hardware. An instance call is linked to the FUNCTION_BLOCK of its type when that block is in the sources; any other call is a function. In PLCopen XML, Structured Text bodies are read, FBD and LD networks give their block calls and the variables their outputs and coils write (IL and SFC bodies are gaps); vendor ladder exports are listed, not read.",
  noPlc: "No PLC Structured Text sources were analysed.",
  pouList: "POU list",
  ioMap: "I/O allocation table",
  types: "Data types",
  notModelled: "Not modelled (review by hand)",
  colPou: "POU",
  colKind: "Kind",
  colHeader: "Returns / extends",
  colInstances: "FB instances",
  colFunctions: "Functions called",
  colIo: "I/O",
  colSource: "Source",
  colAddress: "Address",
  colArea: "Area",
  colVariable: "Variable",
  colType: "Type",
  colName: "Name",
  colSection: "Section",
  colInit: "Initial value",
  colQualifiers: "Qualifiers",
  colCallee: "Callee",
  colForm: "Form",
  colDefined: "Defined at",
  colTarget: "Target",
  colWrites: "Assigned at",
  area: { input: "input", output: "output", memory: "memory" } as Record<string, string>,
  global: "(global)",
  purpose: "Purpose",
  fromComment: "(from the comment above the header)",
  tbc: "needs confirmation",
  declaration: "Declaration",
  variables: "Variables",
  calls: "Calls",
  writes: "Assignment targets",
  instance: "instance",
  function: "function",
  notInSources: "not in the sources",
  shared: "Address declared by more than one variable",
  exportNotRead: "Export not read (vendor ladder)",
};

type PlcStrings = typeof en;

const ja: PlcStrings = {
  plc: "PLC プログラム仕様（IEC 61131-3）",
  note: "Structured Text のソースと PLCopen XML エクスポートのみから読み取った。コントローラには接続していない。アドレスは宣言どおり（AT %I / %Q / %M）であり、実機の構成ではない。インスタンス呼出しは、その型の FUNCTION_BLOCK がソース内にある場合に関連付け、それ以外の呼出しは関数とする。PLCopen XML では ST 本体を読み取り、FBD・LD はブロック呼出しと出力変数・コイルへの書込みを読み取る（IL・SFC 本体は未解析として記録）。ベンダーのラダーエクスポートは一覧に記すのみで、読み取っていない。",
  noPlc: "解析した PLC Structured Text ソースはない。",
  pouList: "POU 一覧",
  ioMap: "入出力割付表",
  types: "データ型定義",
  notModelled: "未モデル化（要目視確認）",
  colPou: "POU",
  colKind: "種別",
  colHeader: "戻り値 / 継承",
  colInstances: "FB インスタンス",
  colFunctions: "呼出し関数",
  colIo: "入出力",
  colSource: "出典",
  colAddress: "アドレス",
  colArea: "区分",
  colVariable: "変数",
  colType: "型",
  colName: "名前",
  colSection: "セクション",
  colInit: "初期値",
  colQualifiers: "修飾子",
  colCallee: "呼出し先",
  colForm: "形式",
  colDefined: "定義箇所",
  colTarget: "代入先",
  colWrites: "代入箇所",
  area: { input: "入力", output: "出力", memory: "内部メモリ" },
  global: "（グローバル）",
  purpose: "目的",
  fromComment: "（ヘッダ直前のコメントより）",
  tbc: "要確認",
  declaration: "宣言",
  variables: "変数",
  calls: "呼出し",
  writes: "代入先",
  instance: "インスタンス",
  function: "関数",
  notInSources: "ソース内にない",
  shared: "複数の変数が宣言しているアドレス",
  exportNotRead: "読み取っていないエクスポート（ベンダーラダー）",
};

function plcStrings(lang: DocLang): PlcStrings {
  return lang === "en" ? en : ja;
}

export function plcTitle(lang: DocLang): string {
  return plcStrings(lang).plc;
}

export function renderPlc(ctx: DocCtx, n: number): string[] {
  const m = plcStrings(ctx.lang);
  const out = [`## ${n}. ${m.plc}`, ""];
  const p = ctx.poly?.plc;
  const exports = ctx.poly?.plcExports ?? [];
  if (!p || p.pous.length + p.globals.length === 0) {
    out.push(m.noPlc, "");
    out.push(...notModelled(m, p, exports, `${n}.1`));
    return out;
  }
  out.push(`> ${m.note}`, "", `### ${n}.1 ${m.pouList}`, "");
  out.push(
    ...table(
      [m.colPou, m.colKind, m.colHeader, m.colInstances, m.colFunctions, m.colIo, m.colSource],
      p.pous.map((x) => [
        code(x.name),
        x.kind,
        code([x.returns, x.extends ? `EXTENDS ${x.extends}` : ""].filter(Boolean).join(" ")),
        cell(
          [
            ...new Set(
              p.instances.filter((i) => i.pou === x.name).map((i) => `${i.instance}:${i.type}`),
            ),
          ].join(", "),
        ),
        cell(
          [...new Set(x.calls.filter((c) => c.kind === "function").map((c) => c.name))].join(", "),
        ),
        cell(p.io.filter((i) => i.pou === x.name).length || ""),
        cite(x),
      ]),
    ),
    "",
  );
  out.push(`### ${n}.2 ${m.ioMap}`, "");
  if (p.io.length === 0) {
    out.push(ctx.s.none, "");
  } else {
    out.push(
      ...table(
        [m.colAddress, m.colArea, m.colVariable, m.colPou, m.colType, m.colSource],
        p.io.map((i) => [
          code(i.address),
          m.area[i.area] ?? i.area,
          code(i.name),
          i.pou ? code(i.pou) : m.global,
          code(i.type),
          cite(i),
        ]),
      ),
      "",
    );
  }
  out.push(`### ${n}.3 ${m.types}`, "");
  if (p.types.length === 0) {
    out.push(ctx.s.none, "");
  } else {
    out.push(
      ...table(
        [m.colName, m.colKind, m.colSource],
        p.types.map((t) => [code(t.name), t.kind, cite(t)]),
      ),
      "",
    );
  }
  p.pous.forEach((x, k) => out.push(...pouSpec(m, p, x, `${n}.${k + 4}`)));
  out.push(...notModelled(m, p, exports, `${n}.${p.pous.length + 4}`));
  return out;
}

function pouSpec(m: PlcStrings, p: PlcAnalysis, x: PlcPou, num: string): string[] {
  const out = [`### ${num} ${x.name}`, ""];
  out.push(
    x.doc
      ? `- ${m.purpose}: ${cell(x.doc)} ${m.fromComment} ${cite(x)}`
      : `- ${m.purpose}: ${m.tbc} ${cite(x)}`,
  );
  const head = [
    x.kind,
    x.returns ? `${x.name} : ${x.returns}` : x.name,
    x.extends ? `EXTENDS ${x.extends}` : "",
    x.implements.length > 0 ? `IMPLEMENTS ${x.implements.join(", ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  out.push(`- ${m.declaration}: ${code(head)} ${cite(x)}`, "");
  if (x.vars.length > 0) {
    out.push(`${m.variables}:`, "");
    out.push(
      ...table(
        [m.colName, m.colSection, m.colType, m.colAddress, m.colInit, m.colQualifiers, m.colSource],
        x.vars.map((v) => [
          code(v.name),
          v.section,
          code(v.type),
          code(v.address),
          code(v.init),
          cell(v.qualifiers.join(", ")),
          cite(v),
        ]),
      ),
      "",
    );
  }
  if (x.calls.length > 0) {
    const inst = p.instances.filter((i) => i.pou === x.name);
    out.push(`${m.calls}:`, "");
    out.push(
      ...table(
        [m.colCallee, m.colForm, m.colType, m.colDefined, m.colSource],
        x.calls.map((c) => {
          const at =
            c.kind === "instance"
              ? inst.find((i) => i.line === c.line && i.file === c.file)?.definedAt
              : undefined;
          return [
            code(c.name),
            c.kind === "instance" ? m.instance : m.function,
            code(c.type),
            c.kind === "instance" ? (at ? cite(at) : m.notInSources) : "",
            cite(c),
          ];
        }),
      ),
      "",
    );
  }
  if (x.writes.length > 0) {
    const byTarget = new Map<string, PlcPou["writes"]>();
    for (const w of x.writes) {
      byTarget.set(w.target, [...(byTarget.get(w.target) ?? []), w]);
    }
    out.push(`${m.writes}:`, "");
    out.push(
      ...table(
        [m.colTarget, m.colWrites],
        [...byTarget].map(([t, ws]) => [code(t), cites(ws)]),
      ),
      "",
    );
  }
  return out;
}

function notModelled(
  m: PlcStrings,
  p: PlcAnalysis | undefined,
  exports: string[],
  num: string,
): string[] {
  const gaps = p?.gaps ?? [];
  const shared = p?.sharedAddresses ?? [];
  if (gaps.length + shared.length + exports.length === 0) {
    return [];
  }
  const out = [`### ${num} ${m.notModelled}`, ""];
  for (const g of gaps) {
    out.push(`- ${code(g.construct)}: ${cell(g.detail)} ${cite(g)}`);
  }
  for (const s of shared) {
    out.push(`- ${m.shared}: ${code(s.address)} ${cites(s.by)}`);
  }
  for (const f of exports) {
    out.push(`- ${m.exportNotRead}: ${cite({ file: f, line: 1 })}`);
  }
  out.push("");
  return out;
}
