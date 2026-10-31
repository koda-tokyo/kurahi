// Google Cloud Mainframe Assessment Tool, "Neo4j graph" export (VERIFIED_FROM_DOCS, envelope):
// https://docs.cloud.google.com/mainframe-assessment-tool/docs/export-results
//
// The page documents a JSON Lines file where "each line ... represents either a node or a
// relationship", and the APOC import queries fix the envelope:
//   node          {"type":"node", "id":…, "labels":[…], "properties":{…}}
//                 (apoc.merge.node(value.labels, {id: value.id}, value.properties, …))
//   relationship  {"type":"relationship", "start":{"id":…}, "end":{"id":…}, "label":…, "properties":{…}}
//                 (MATCH (startNode{id: value.start.id}), (endNode{id: value.end.id})
//                  apoc.merge.relationship(startNode, value.label, {}, value.properties, endNode))
// Label values (beyond "programs, JCL jobs, datasets, databases, and BMS maps" in prose) and
// property names are NOT documented: they are stored verbatim and never interpreted. A line that
// does not fit the envelope rejects the file (SCHEMA_REJECTED), it is not skipped by guess.

import type { ParseInput, ParseResult } from "./types.js";
import { ProviderError } from "../../providers.js";
import { decodeUtf8, sha256Hex } from "../manifest.js";
import { base, emptyArtefacts, normaliseRelation, scalarProps } from "../model.js";

const MAX_ERRORS = 5;

type NodeId = string;

function idOf(v: unknown): NodeId | null {
  if (typeof v === "string" && v.length > 0 && v.length <= 400) {
    return v;
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return String(v);
  }
  return null;
}

export function parseNeo4jJsonl(input: ParseInput): ParseResult {
  const out = emptyArtefacts();
  const shapes = new Set<string>();
  const errors: string[] = [];
  const nodes = new Map<NodeId, { itemId: string; name: string }>();
  const rels: {
    start: NodeId;
    end: NodeId;
    label: string;
    props: unknown;
    file: string;
    sha: string;
    line: number;
  }[] = [];
  if (input.data.length === 0) {
    throw new ProviderError(
      "SCHEMA_REJECTED",
      "the bundle has no JSON Lines graph file",
      "Add the .jsonl file extracted from the Neo4j graph export.",
    );
  }
  for (const f of input.data) {
    const text = decodeUtf8(f.bytes, f.path);
    const sha = f.sha256;
    const lines = text.split(/\r?\n/);
    let records = 0;
    lines.forEach((raw, i) => {
      const line = i + 1;
      if (!raw.trim() || errors.length >= MAX_ERRORS) {
        return;
      }
      let v: unknown;
      try {
        v = JSON.parse(raw);
      } catch {
        errors.push(`${f.path}:${line} is not JSON`);
        return;
      }
      if (!v || typeof v !== "object" || Array.isArray(v)) {
        errors.push(`${f.path}:${line} is not a JSON object`);
        return;
      }
      const o = v as Record<string, unknown>;
      records++;
      shapes.add(`${String(o.type)}:${Object.keys(o).toSorted().join(",")}`);
      const props = o.properties;
      if (
        props !== undefined &&
        props !== null &&
        (typeof props !== "object" || Array.isArray(props))
      ) {
        errors.push(`${f.path}:${line} properties is not an object`);
        return;
      }
      if (o.type === "node") {
        const id = idOf(o.id);
        const labels = o.labels;
        if (
          !id ||
          !Array.isArray(labels) ||
          labels.length === 0 ||
          !labels.every((l) => typeof l === "string" && l.length > 0 && l.length <= 120)
        ) {
          errors.push(`${f.path}:${line} node without id or labels`);
          return;
        }
        if (nodes.has(id)) {
          // apoc.merge.node merges on id: the later record updates the same node.
          out.notes.push(`${f.path}:${line} repeats node id ${id.slice(0, 80)} (merged)`);
          return;
        }
        const p = scalarProps(props);
        const named = typeof p.name === "string" && p.name.trim() !== "";
        const itemId = `n-${sha256Hex(id).slice(0, 16)}`;
        const name = named ? String(p.name) : id;
        nodes.set(id, { itemId, name });
        out.items.push({
          ...base(itemId, { file: f.path, sha256: sha, line }),
          name,
          nameFrom: named ? "properties.name" : "id",
          kind: (labels as string[]).join(":"),
          properties: { ...p, id },
        });
        return;
      }
      if (o.type === "relationship") {
        const start = idOf((o.start as Record<string, unknown> | undefined)?.id);
        const end = idOf((o.end as Record<string, unknown> | undefined)?.id);
        const label = o.label;
        if (!start || !end || typeof label !== "string" || !label || label.length > 120) {
          errors.push(`${f.path}:${line} relationship without start.id, end.id or label`);
          return;
        }
        rels.push({ start, end, label, props, file: f.path, sha, line });
        return;
      }
      errors.push(`${f.path}:${line} type is neither "node" nor "relationship"`);
    });
    if (records === 0 && errors.length === 0) {
      errors.push(`${f.path} has no records`);
    }
  }
  if (errors.length > 0) {
    throw new ProviderError(
      "SCHEMA_REJECTED",
      `not the documented Neo4j JSON Lines export: ${errors.join("; ")}`,
      "Import the .jsonl file from the Neo4j graph export unchanged, or use a mapped import.",
    );
  }
  for (const r of rels) {
    const a = nodes.get(r.start);
    const b = nodes.get(r.end);
    const src = { file: r.file, sha256: r.sha, line: r.line };
    if (!a || !b) {
      // The documented MATCH would not create this relationship either.
      out.findings.push({
        ...base(`f-${sha256Hex(`${r.file}:${r.line}`).slice(0, 16)}`, src),
        title: "Relationship refers to a node that is not in the export",
        detail: `${r.label} from ${r.start.slice(0, 80)} to ${r.end.slice(0, 80)}`,
        severity: "warning",
        subject: null,
      });
      continue;
    }
    out.edges.push({
      ...base(`e-${sha256Hex(`${r.file}:${r.line}`).slice(0, 16)}`, src),
      from: a.itemId,
      to: b.itemId,
      fromName: a.name,
      toName: b.name,
      relation: r.label,
      relationNormalised: normaliseRelation(r.label),
      properties: scalarProps(r.props),
    });
  }
  const detail = [...shapes].toSorted();
  return { artefacts: out, fingerprint: sha256Hex(detail.join("\n")), fingerprintDetail: detail };
}
