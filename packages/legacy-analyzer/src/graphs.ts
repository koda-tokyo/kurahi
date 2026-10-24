// Graphviz DOT renderings of the CALL and PERFORM graphs (for people; agents use the JSON).

import type { LegacyIndex } from "./types.js";
import { allSteps, callEdges, performEdges } from "./query.js";

const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;

export function callGraphDot(index: LegacyIndex): string {
  const lines = ["digraph calls {", "  rankdir=LR;", "  node [shape=box];"];
  for (const { job, step } of allSteps(index)) {
    if (step.program) {
      lines.push(`  ${q(`${job.name}.${step.name}`)} [shape=ellipse];`);
      lines.push(`  ${q(`${job.name}.${step.name}`)} -> ${q(step.program)} [label="EXEC"];`);
    }
  }
  for (const e of callEdges(index)) {
    const style = e.dynamic
      ? ' [style=dashed,label="dynamic"]'
      : e.resolved
        ? ""
        : ' [label="external"]';
    lines.push(`  ${q(e.program)} -> ${q(e.target)}${style};`);
  }
  lines.push("}");
  return [...new Set(lines)].join("\n");
}

export function performGraphDot(index: LegacyIndex): string {
  const lines = ["digraph performs {", "  rankdir=TB;", "  node [shape=box];"];
  for (const p of index.programs) {
    lines.push(`  subgraph ${q(`cluster_${p.name}`)} {`, `    label=${q(p.name)};`);
    for (const para of p.paragraphs) {
      lines.push(`    ${q(`${p.name}.${para.name}`)} [label=${q(para.name)}];`);
    }
    lines.push("  }");
  }
  for (const e of performEdges(index)) {
    const style =
      e.kind === "GO TO"
        ? ' [style=dashed,label="GO TO"]'
        : e.kind === "PERFORM THRU"
          ? ' [label="THRU"]'
          : "";
    lines.push(`  ${q(`${e.program}.${e.from}`)} -> ${q(`${e.program}.${e.to}`)}${style};`);
  }
  lines.push("}");
  return [...new Set(lines)].join("\n");
}
