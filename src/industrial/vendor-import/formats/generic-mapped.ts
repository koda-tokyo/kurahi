// Generic mapped import, for vendor outputs whose field-level schema is not publicly documented
// (UNVERIFIED_SCHEMA in the registry). Nothing is inferred: the bundle carries a mapping file
// (role `mapping` in the manifest) that names, for each data file, which column or JSON field
// holds each value. A named column that is absent, a required value that is empty, a data file
// no table maps or a table that matches no file rejects the import (SCHEMA_REJECTED).
//
//   {
//     "schema": "kurahi.vendor-import-mapping/1",
//     "tables": [
//       { "file": "rules/*.csv", "format": "csv", "produces": "rules",
//         "fields": { "text": "Description", "vendorId": "Rule ID", "subject": "Program" } },
//       { "file": "deps.json", "format": "json", "records": "dependencies", "produces": "edges",
//         "fields": { "from": "source", "to": "target", "relation": "=CALLS" } }
//     ]
//   }
//
// `fields` values are a column name (CSV), a dotted path (JSON, JSON Lines), or `=literal`.
// `file` matches a bundle path; `*` matches within one path segment, `**/` any folders.

import type { NormalisedArtefacts } from "../model.js";
import type { DataFile, ParseInput, ParseResult } from "./types.js";
import { ProviderError } from "../../providers.js";
import { decodeUtf8, sha256Hex } from "../manifest.js";
import { base, emptyArtefacts, normaliseRelation } from "../model.js";

export const MAPPING_SCHEMA = "kurahi.vendor-import-mapping/1";

const PRODUCES = {
  items: { required: ["name"], optional: ["kind", "id"] },
  edges: { required: ["from", "to"], optional: ["relation"] },
  rules: { required: ["text"], optional: ["vendorId", "subject", "title", "ruleType"] },
  findings: { required: ["title"], optional: ["detail", "severity", "subject"] },
} as const;
type Produces = keyof typeof PRODUCES;

type Table = {
  file: string;
  format: "csv" | "json" | "jsonl";
  records: string | null;
  delimiter: string;
  produces: Produces;
  fields: Record<string, string>;
};

const reject = (message: string) =>
  new ProviderError(
    "SCHEMA_REJECTED",
    message,
    "Fix the field mapping file so that it names the columns the export really has.",
  );

export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (glob.startsWith("**/", i)) {
      re += "(?:.*/)?";
      i += 2;
    } else if (c === "*") {
      re += "[^/]*";
    } else {
      re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function parseMapping(file: DataFile | null): Table[] {
  if (!file) {
    throw reject(
      "this format has no published schema: the bundle needs a field mapping file (role mapping)",
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(decodeUtf8(file.bytes, file.path));
  } catch (err) {
    throw err instanceof ProviderError ? err : reject("the mapping file is not valid JSON");
  }
  const m = (json && typeof json === "object" ? json : {}) as Record<string, unknown>;
  if (m.schema !== MAPPING_SCHEMA) {
    throw reject(`the mapping file schema must be "${MAPPING_SCHEMA}"`);
  }
  if (!Array.isArray(m.tables) || m.tables.length === 0 || m.tables.length > 100) {
    throw reject("the mapping file needs 1 to 100 tables");
  }
  return m.tables.map((t: unknown, i: number) => {
    const o = (t && typeof t === "object" ? t : {}) as Record<string, unknown>;
    const where = `tables[${i}]`;
    if (typeof o.file !== "string" || !o.file.trim()) {
      throw reject(`${where}.file is required`);
    }
    if (o.format !== "csv" && o.format !== "json" && o.format !== "jsonl") {
      throw reject(`${where}.format must be csv, json or jsonl`);
    }
    if (typeof o.produces !== "string" || !(o.produces in PRODUCES)) {
      throw reject(`${where}.produces must be items, edges, rules or findings`);
    }
    const produces = o.produces as Produces;
    const fields = (o.fields && typeof o.fields === "object" ? o.fields : {}) as Record<
      string,
      unknown
    >;
    const spec = PRODUCES[produces];
    const allowed = new Set<string>([...spec.required, ...spec.optional]);
    for (const k of Object.keys(fields)) {
      if (!allowed.has(k) || typeof fields[k] !== "string" || !String(fields[k]).trim()) {
        throw reject(`${where}.fields.${k.slice(0, 40)} is not a field of ${produces}`);
      }
    }
    for (const k of spec.required) {
      if (!fields[k]) {
        throw reject(`${where}.fields.${k} is required for ${produces}`);
      }
    }
    const delimiter = typeof o.delimiter === "string" ? o.delimiter : ",";
    if (![",", ";", "\t", "|"].includes(delimiter)) {
      throw reject(`${where}.delimiter must be one of , ; | or a tab`);
    }
    return {
      file: o.file.trim(),
      format: o.format,
      records: typeof o.records === "string" && o.records.trim() ? o.records.trim() : null,
      delimiter,
      produces,
      fields: fields as Record<string, string>,
    };
  });
}

/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"' && field === "") {
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") {
        i++;
      }
      row.push(field);
      field = "";
      if (row.some((x) => x !== "")) {
        rows.push(row);
      }
      row = [];
    } else {
      field += c;
    }
  }
  if (quoted) {
    throw reject("a CSV file has an unterminated quoted field");
  }
  row.push(field);
  if (row.some((x) => x !== "")) {
    rows.push(row);
  }
  return rows;
}

function at(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const k of dotted.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

type Rec = { get: (key: string) => unknown; where: { line?: number; record?: number } };

function recordsOf(t: Table, f: DataFile, shapes: Set<string>): Rec[] {
  const text = decodeUtf8(f.bytes, f.path);
  const keys = Object.values(t.fields).filter((v) => !v.startsWith("="));
  if (t.format === "csv") {
    const rows = parseCsv(text, t.delimiter);
    const header = (rows[0] ?? []).map((h) => h.trim());
    shapes.add(`csv:${header.join(",")}`);
    for (const k of keys) {
      if (!header.includes(k)) {
        throw reject(`${f.path.slice(0, 120)} has no column "${k.slice(0, 60)}"`);
      }
    }
    return rows.slice(1).map((r, i) => ({
      get: (key: string) => r[header.indexOf(key)],
      // Line numbers assume one physical line per row (multi-line quoted cells shift them).
      where: { record: i + 1, line: i + 2 },
    }));
  }
  let values: unknown[];
  if (t.format === "jsonl") {
    values = [];
    text.split(/\r?\n/).forEach((l, i) => {
      if (!l.trim()) {
        return;
      }
      try {
        values.push(JSON.parse(l));
      } catch {
        throw reject(`${f.path.slice(0, 120)}:${i + 1} is not JSON`);
      }
    });
  } else {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw reject(`${f.path.slice(0, 120)} is not valid JSON`);
    }
    const list = t.records ? at(json, t.records) : json;
    values = Array.isArray(list) ? list : list && typeof list === "object" ? [list] : [];
    if (!Array.isArray(list) && !(list && typeof list === "object")) {
      throw reject(`${f.path.slice(0, 120)} has no records at "${t.records ?? "(root)"}"`);
    }
  }
  const first = values[0];
  if (first && typeof first === "object") {
    shapes.add(`${t.format}:${Object.keys(first).toSorted().join(",")}`);
  }
  return values.map((v, i) => ({ get: (key: string) => at(v, key), where: { record: i + 1 } }));
}

function value(rec: Rec, spec: string | undefined): string | null {
  if (!spec) {
    return null;
  }
  if (spec.startsWith("=")) {
    return spec.slice(1);
  }
  const v = rec.get(spec);
  if (typeof v === "string") {
    return v.trim() ? v.trim() : null;
  }
  if (typeof v === "number" || typeof v === "boolean") {
    return String(v);
  }
  return null;
}

function emit(out: NormalisedArtefacts, t: Table, f: DataFile, rec: Rec) {
  const req = (k: string) => {
    const v = value(rec, t.fields[k]);
    if (v === null) {
      throw reject(
        `${f.path.slice(0, 120)} record ${rec.where.record}: required ${k} ("${t.fields[k].slice(0, 60)}") is empty`,
      );
    }
    return v.slice(0, 4000);
  };
  const opt = (k: string) => value(rec, t.fields[k])?.slice(0, 2000) ?? null;
  const src = { file: f.path, sha256: f.sha256, ...rec.where };
  const id = (p: string) => `${p}-${sha256Hex(`${f.path}:${rec.where.record}`).slice(0, 16)}`;
  if (t.produces === "items") {
    const name = req("name");
    out.items.push({
      ...base(id("i"), src),
      name,
      nameFrom: `mapped ${t.fields.name}`,
      kind: opt("kind") ?? "item",
      properties: { vendorId: opt("id") },
    });
  } else if (t.produces === "edges") {
    const from = req("from");
    const to = req("to");
    const relation = opt("relation") ?? "RELATED";
    out.edges.push({
      ...base(id("e"), src),
      from: `name:${from}`,
      to: `name:${to}`,
      fromName: from,
      toName: to,
      relation,
      relationNormalised: normaliseRelation(relation),
      properties: {},
    });
  } else if (t.produces === "rules") {
    out.rules.push({
      ...base(id("r"), src),
      vendorId: opt("vendorId"),
      title: opt("title"),
      text: req("text"),
      subject: opt("subject"),
      ruleType: opt("ruleType") ?? "BUSINESS_RULE",
    });
  } else {
    out.findings.push({
      ...base(id("f"), src),
      title: req("title"),
      detail: opt("detail"),
      severity: opt("severity"),
      subject: opt("subject"),
    });
  }
}

export function parseGenericMapped(input: ParseInput): ParseResult {
  const tables = parseMapping(input.mapping);
  const out = emptyArtefacts();
  const shapes = new Set<string>();
  const used = new Set<string>();
  for (const t of tables) {
    const re = globToRegExp(t.file);
    const files = input.data.filter((f) => re.test(f.path));
    if (files.length === 0) {
      throw reject(`mapping table "${t.file.slice(0, 80)}" matches no file of the bundle`);
    }
    for (const f of files) {
      used.add(f.path);
      for (const rec of recordsOf(t, f, shapes)) {
        emit(out, t, f, rec);
      }
    }
  }
  const unmapped = input.data.filter((f) => !used.has(f.path));
  if (unmapped.length > 0) {
    throw reject(
      `${unmapped.length} data file(s) are not mapped (first: ${unmapped[0].path.slice(0, 80)}); map them or list them with role ignored`,
    );
  }
  const detail = [...shapes].toSorted();
  return { artefacts: out, fingerprint: sha256Hex(detail.join("\n")), fingerprintDetail: detail };
}
