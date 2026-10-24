// Markdown rendering of the wave plan, in Japanese or English. Labelled as a proposal; every
// fact line cites the source.

import type { Gap } from "./coverage.js";
import type { GapKind } from "./doc-i18n.js";
import type { LegacyIndex, Loc } from "./types.js";
import { rootName, sourceFingerprint } from "./design-doc-context.js";
import { type DocLang, strings } from "./doc-i18n.js";
import { cell, cite, cites, code, mermaidIds, mermaidLabel, table } from "./md.js";
import { waveStrings } from "./wave-i18n.js";
import { type WavePlan, wavePlan } from "./wave-plan.js";

const bare = (id: string) => id.replace(/^program:/, "");

function waveSection(plan: WavePlan, index: LegacyIndex, lang: DocLang, n: number): string[] {
  const w = waveStrings(lang);
  const loc = new Map(index.programs.map((p) => [p.name, { file: p.file, line: p.line } as Loc]));
  const stmts = new Map(plan.metrics.map((m) => [m.program, m.statements]));
  const out = [`## ${n}. ${w.waves}`, ""];
  // Diagram: one subgraph per wave, arrows from a program to what it depends on.
  const id = mermaidIds();
  out.push("```mermaid", "flowchart RL");
  for (const wave of plan.waves) {
    out.push(`  subgraph ${id(`wave:${wave.number}`)}[${mermaidLabel(w.wave(wave.number))}]`);
    for (const g of wave.groups) {
      for (const p of g.programs) {
        out.push(`    ${id(p)}[${mermaidLabel(p)}]`);
      }
    }
    out.push("  end");
  }
  const drawn = new Set<string>();
  for (const d of plan.dependencies) {
    const k = `${d.from}|${d.to}`;
    if (!drawn.has(k)) {
      drawn.add(k);
      out.push(`  ${id(bare(d.from))} -->|${d.kind}| ${id(bare(d.to))}`);
    }
  }
  out.push("```", "", `> ${w.diagramNote}`, "");
  plan.waves.forEach((wave, k) => {
    out.push(`### ${n}.${k + 1} ${w.wave(wave.number)}`, "");
    let order = 0;
    const rows: string[][] = [];
    for (const g of wave.groups) {
      order++;
      for (const p of g.programs) {
        const own = plan.dependencies.filter((d) => bare(d.from) === p);
        const needed = [
          ...new Set(plan.dependencies.filter((d) => bare(d.to) === p).map((d) => bare(d.from))),
        ];
        const reasons = [
          ...(g.cycle ? [w.cycleGroup] : []),
          ...(own.length === 0
            ? [w.noDeps]
            : own.map((d) => w.dependsOn(bare(d.to), d.kind, plan.waveOf[bare(d.to)]))),
          ...(needed.length > 0 ? [w.usedBy(needed.join(", "))] : []),
        ];
        const risk = plan.risks.find((r) => r.program === p);
        rows.push([
          String(order),
          code(p),
          w.band(risk?.band ?? "low"),
          String(risk?.score ?? 0),
          String(stmts.get(p) ?? 0),
          reasons.map(cell).join("<br>"),
          cites([loc.get(p), ...own.flatMap((d) => d.evidence)], 8),
        ]);
      }
    }
    out.push(
      ...table(
        [
          w.colOrder,
          w.colProgram,
          w.colRisk,
          w.colScore,
          w.colStatements,
          w.colReasons,
          w.colSource,
        ],
        rows,
      ),
      "",
    );
  });
  return out;
}

export function renderWavePlan(index: LegacyIndex, lang: DocLang = "ja"): string {
  const plan = wavePlan(index);
  const w = waveStrings(lang);
  const ds = strings(lang);
  const loc = new Map(index.programs.map((p) => [p.name, { file: p.file, line: p.line } as Loc]));
  const out: string[] = [
    `# ${w.title(rootName(index))}`,
    "",
    `> ${w.proposal}`,
    ">",
    `> ${w.provenance(index.files.length, sourceFingerprint(index))}`,
    "",
    `## 1. ${w.method}`,
    "",
  ];
  for (const note of w.methodNotes) {
    out.push(`> ${note}`, ">");
  }
  out.pop();
  out.push("");
  out.push(...waveSection(plan, index, lang, 2));
  out.push(`## 3. ${w.dependencies}`, "");
  if (plan.dependencies.length > 0) {
    out.push(
      ...table(
        [w.colFrom, w.colKind, w.colTo, w.colVia, w.colSource],
        plan.dependencies.map((d) => [
          code(bare(d.from)),
          d.kind,
          code(bare(d.to)),
          cell(d.via.map((v) => v.replace(/^dataset:/, "")).join(" → ")),
          cites(d.evidence, 8),
        ]),
      ),
      "",
    );
  } else {
    out.push(w.noDependencies, "");
  }
  out.push(`## 4. ${w.cycles}`, "");
  if (plan.cycles.length > 0) {
    for (const c of plan.cycles) {
      const ev = plan.dependencies
        .filter((d) => c.includes(bare(d.from)) && c.includes(bare(d.to)))
        .flatMap((d) => d.evidence);
      out.push(`- ${w.cycleLine(c.join(", "))} ${cites(ev, 8)}`);
    }
  } else {
    out.push(w.noCycles);
  }
  out.push("", `## 5. ${w.clusters}`, "");
  plan.clusters.forEach((c, k) => {
    out.push(
      `- ${w.clusterLine(k + 1, c.join(", "))} ${cites(
        c.map((p) => loc.get(p)),
        8,
      )}`,
    );
  });
  out.push("", `## 6. ${w.couplings}`, "");
  if (plan.couplings.length > 0) {
    out.push(
      ...table(
        [w.colPair, w.colCalls, w.colDatasets, w.colCopybooks, w.colWeight, w.colSource],
        plan.couplings.map((c) => [
          `${code(c.a)} ↔ ${code(c.b)}`,
          String(c.calls.length),
          cell(c.datasets.join(", ")),
          cell(c.copybooks.join(", ")),
          String(c.weight),
          cites([...c.calls, ...c.dataEvidence, ...c.copyEvidence], 8),
        ]),
      ),
      "",
    );
  } else {
    out.push(w.noCouplings, "");
  }
  out.push(`## 7. ${w.riskFactors}`, "");
  const factorRows = plan.risks.flatMap((r) =>
    r.factors.map((f) => [
      code(r.program),
      w.factor(f.factor),
      String(f.count),
      String(f.points),
      cites(f.evidence, 6),
    ]),
  );
  out.push(
    ...(factorRows.length > 0
      ? table([w.colProgram, w.colFactor, w.colCount, w.colPoints, w.colSource], factorRows)
      : [w.noFactors]),
    "",
  );
  out.push(`## 8. ${w.metrics}`, "");
  out.push(
    ...table(
      [
        w.colProgram,
        w.colParagraphs,
        w.colStatements,
        w.colDecisions,
        w.colGoTo,
        w.colCallsOut,
        w.colCallers,
        w.colDataTargets,
        w.colCopies,
        w.colRules,
        w.colSource,
      ],
      plan.metrics.map((m) => [
        code(m.program),
        String(m.paragraphs),
        String(m.statements),
        String(m.decisions),
        String(m.goTo),
        String(m.callsOut),
        String(m.callers),
        String(m.datasets),
        String(m.copybooks),
        String(m.rules),
        cite(m.loc),
      ]),
    ),
    "",
  );
  out.push(`## 9. ${w.outOfScope}`, "");
  if (plan.outOfScope.length > 0) {
    for (const o of plan.outOfScope) {
      out.push(
        `- ${code(o.name)}: ${o.kind === "dynamic" ? w.outDynamic : w.outExternal} ${cites(o.evidence, 6)}`,
      );
    }
    out.push("", `> ${w.outNote}`);
  } else {
    out.push(w.noOutOfScope);
  }
  out.push("", `## 10. ${w.openQuestions}`, "");
  const cov = plan.coverage;
  const groups: Array<[GapKind, Gap[]]> = [
    ["externalCalls", cov.externalCalls],
    ["dynamicCalls", cov.dynamicCalls],
    ["missingCopybooks", cov.missingCopybooks],
    ["execNotModelled", cov.execNotModelled],
    ["unboundFiles", cov.unboundFiles],
    ["unboundDds", cov.unboundDds],
    ["noEntry", cov.noEntry],
  ];
  const files = new Set(index.programs.map((p) => p.file));
  const relevant = groups.flatMap(([k, gs]) =>
    gs.filter((g) => files.has(g.loc.file)).map((g) => ({ k, g })),
  );
  const total = groups.reduce((k, [, gs]) => k + gs.length, 0) + cov.stepsWithoutSource.length;
  out.push(`> ${w.openNote(total)}`, "");
  if (relevant.length > 0) {
    for (const { k, g } of relevant) {
      out.push(`- ${w.gapLine(code(g.subject), ds.gapKind(k))} ${cite(g.loc)}`);
    }
  } else {
    out.push(w.noOpen);
  }
  return `${out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}
