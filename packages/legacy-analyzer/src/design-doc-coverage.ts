// カバレッジと要確認事項 / Coverage report: what was parsed, what was not and why, every gap with
// its location, and the analyser's known limits. Gaps are listed, never smoothed over.

import type { Gap } from "./coverage.js";
import type { DocCtx } from "./design-doc-context.js";
import type { GapKind } from "./doc-i18n.js";
import { gapCount } from "./coverage.js";
import { cell, cite, code, table } from "./md.js";

export function renderCoverage(ctx: DocCtx, n: number): string[] {
  const { s, cov } = ctx;
  const out = [`## ${n}. ${s.coverage}`, ""];
  out.push(`### ${n}.1 ${s.parsedFiles}`, "");
  out.push(
    ...table(
      [s.colFile, s.colKind, s.colLines, s.colContains, s.colSource],
      cov.parsed.map((f) => [
        cell(f.path),
        s.fileKind(f.kind),
        String(f.lines),
        cell([...f.programs, ...f.jobs].join(", ")),
        cite({ file: f.path, line: 1 }),
      ]),
    ),
    "",
  );
  out.push(`### ${n}.2 ${s.notParsed}`, "");
  if (cov.skipped.length > 0) {
    out.push(
      ...table(
        [s.colFile, s.colReason, s.colSource],
        cov.skipped.map((d) => [cell(d.file), cell(d.message), cite(d)]),
      ),
      "",
    );
  }
  if (cov.notAnalysedTotal > 0) {
    out.push(`> ${s.otherFiles(cov.notAnalysedTotal)}`, ">");
    out.push(
      `> ${cov.notAnalysed.map((f) => code(f)).join(", ")}${cov.notAnalysedTotal > cov.notAnalysed.length ? ` … (+${cov.notAnalysedTotal - cov.notAnalysed.length})` : ""}`,
      "",
    );
  }
  if (cov.skipped.length === 0 && cov.notAnalysedTotal === 0) {
    out.push(s.nothingSkipped, "");
  }
  out.push(`> ${s.excludedDirs}`, "");
  out.push(`### ${n}.3 ${s.diagnostics}`, "");
  if (cov.diagnostics.length > 0) {
    out.push(
      ...table(
        [s.colSeverity, s.colMessage, s.colSource],
        cov.diagnostics.map((d) => [d.severity, cell(d.message), cite(d)]),
      ),
      "",
    );
  } else {
    out.push(s.noDiagnostics, "");
  }
  out.push(`### ${n}.4 ${s.openQuestions} (${gapCount(cov)})`, "");
  const groups: Array<[GapKind, Gap[]]> = [
    ["externalCalls", cov.externalCalls],
    ["dynamicCalls", cov.dynamicCalls],
    ["missingCopybooks", cov.missingCopybooks],
    ["stepsWithoutSource", cov.stepsWithoutSource],
    ["execNotModelled", cov.execNotModelled],
    ["unboundFiles", cov.unboundFiles],
    ["unboundDds", cov.unboundDds],
    ["noEntry", cov.noEntry],
    ["unreferencedParagraphs", cov.unreferencedParagraphs],
    ["unknownLengths", cov.unknownLengths],
  ];
  const rows: string[][] = [];
  for (const [kind, gaps] of groups) {
    for (const g of gaps) {
      rows.push([s.gapKind(kind), code(g.subject), cell(g.detail), s.gapAction(kind), cite(g.loc)]);
    }
  }
  if (rows.length > 0) {
    out.push(...table([s.colGap, s.colSubject, s.colDetail, s.colAction, s.colSource], rows), "");
  } else {
    out.push(s.noGaps, "");
  }
  // Business purpose is never derivable from code: one placeholder per program.
  out.push(`### ${n}.5 ${s.humanInput}`, "");
  for (const p of ctx.index.programs) {
    out.push(`- ${s.purposeQuestion(p.name)} ${cite(p)}`);
  }
  out.push("", `### ${n}.6 ${s.limits}`, "");
  for (const l of s.limitNotes) {
    out.push(`> ${l}`, ">");
  }
  out.pop();
  return out;
}
