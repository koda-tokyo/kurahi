// Shared context of the design-document generator: the index, its knowledge graph, the CRUD
// facts, the coverage report and the string table of the output language, plus display labels
// for graph nodes.

import crypto from "node:crypto";
import path from "node:path";
import type { DocLang, Strings } from "./doc-i18n.js";
import type { Polyglot } from "./modernise/project.js";
import type { LegacyIndex } from "./types.js";
import { type Coverage, coverage } from "./coverage.js";
import { type CrudMatrix, type GraphView, crudMatrix, viewOf } from "./crud.js";
import { strings } from "./doc-i18n.js";
import { type KnowledgeGraph, buildGraph } from "./graph.js";
import { buildPolyglotGraph } from "./modernise/poly-graph.js";

export type DocCtx = {
  index: LegacyIndex;
  graph: KnowledgeGraph;
  view: GraphView;
  crud: CrudMatrix;
  cov: Coverage;
  lang: DocLang;
  s: Strings;
  /** Java and SQL DDL facts of the same project, when the document covers them. */
  poly?: Polyglot;
  /** Display label of a graph node. */
  label: (id: string) => string;
};

export function docContext(
  index: LegacyIndex,
  lang: DocLang,
  alsoAnalysed?: ReadonlySet<string>,
  poly?: Polyglot,
): DocCtx {
  const graph = poly ? buildPolyglotGraph(poly) : buildGraph(index);
  const view = viewOf(graph);
  const s = strings(lang);
  const label = (id: string): string => {
    const n = view.node.get(id);
    if (!n) {
      return id.replace(/^[a-z-]+:/, "");
    }
    switch (n.kind) {
      case "dataset":
        return n.attrs?.temporary ? `${n.name} (${n.attrs.job})` : n.name;
      case "table":
        return `${n.name} (${s.sqlTable})`;
      case "cics-file":
        return `${n.name} (${s.cicsFile})`;
      case "file": {
        const dd = (view.out.get(id) ?? []).find((e) => e.kind === "ASSIGN");
        const ddNode = dd ? view.node.get(dd.to) : undefined;
        const what =
          ddNode?.attrs?.sysout !== undefined ? "SYSOUT" : ddNode ? `DD ${ddNode.name}` : s.noDd;
        return `${n.attrs?.program}.${n.name} (${what})`;
      }
      case "step":
        return `${n.attrs?.job}.${n.name}`;
      case "java-type":
        return `${id.replace(/^type:/, "")} (Java)`;
      case "dynamic-target":
        return `${n.name} (${s.dynamic})`;
      default:
        return n.name;
    }
  };
  return {
    index,
    graph,
    view,
    crud: crudMatrix(view),
    cov: coverage(index, view, alsoAnalysed),
    lang,
    s,
    ...(poly ? { poly } : {}),
    label,
  };
}

/** Fingerprint of the analysed sources: sha256 over sorted "path sha256" lines. */
export function sourceFingerprint(index: LegacyIndex): string {
  const lines = index.files.map((f) => `${f.path} ${f.sha256}`).toSorted();
  return crypto.createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

export function rootName(index: LegacyIndex): string {
  return path.basename(index.root);
}

/** Last source line of a program in its own file (paragraphs and data items). */
export function programEndLine(index: LegacyIndex, name: string): number {
  const p = index.programs.find((x) => x.name === name);
  if (!p) {
    return 0;
  }
  let end = p.line;
  for (const para of p.paragraphs) {
    if (para.file === p.file) {
      end = Math.max(end, para.endLine);
    }
  }
  for (const d of p.dataItems) {
    if (d.file === p.file) {
      end = Math.max(end, d.endLine ?? d.line);
    }
  }
  return end;
}
