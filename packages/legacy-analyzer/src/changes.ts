// Change detection against a stored baseline. A snapshot is the fact index reduced to the
// things a reviewer tracks: COBOL programs, copybooks, JCL jobs, SQL DDL tables, their columns
// and stored routines (each with a content hash and its path:line), and the edges between them
// (CALL, PERFORM, EXEC SQL table use, JCL step EXEC). Comparing tonight's snapshot with the
// baseline gives what was added, removed and changed, with evidence. Snapshots live in the
// analyser cache folder (`<project>/output/.legacy-index/baseline/`), never in the sources:
//
//   baseline-<id>.json   what the next comparison is against;
//   candidate-<id>.json  the snapshot the last comparison computed; advancing the baseline
//                        promotes exactly this one, so a change that lands between the
//                        comparison and the advance is still reported the next time.
//
// Deterministic: entities and edges are sorted, hashes cover structure (or the normalised source
// text of a routine), never times or absolute paths.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Polyglot } from "./modernise/project.js";
import type { Job, JobStep, LegacyIndex, Loc } from "./types.js";
import { writeInCache } from "./cache.js";

export const BASELINE_SCHEMA = "kurahi.legacy-baseline/1";
export const ENTITY_KINDS = ["program", "copybook", "job", "table", "column", "routine"] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];
export const EDGE_KINDS = ["CALL", "PERFORM", "EXEC SQL", "STEP"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number];

export type SnapshotEntity = Loc & {
  kind: EntityKind;
  /** Unique within its kind (a duplicate name carries `@file`). */
  key: string;
  name: string;
  hash: string;
  /** Programs: paragraph names; tables: column names; jobs: step names. */
  parts?: string[];
  /** Programs: statement count. */
  size?: number;
};

export type SnapshotEdge = Loc & {
  kind: EdgeKind;
  from: string;
  to: string;
  /** EXEC SQL: the operation (SELECT, INSERT …). */
  op?: string;
  count: number;
};

export type Snapshot = {
  schema: typeof BASELINE_SCHEMA;
  root: string;
  /** Hash of the entities and edges: equal digests mean equal snapshots. */
  digest: string;
  createdAt: string;
  totals: Record<EntityKind | "edges", number>;
  entities: SnapshotEntity[];
  edges: SnapshotEdge[];
};

const sha = (v: unknown) =>
  crypto
    .createHash("sha256")
    .update(typeof v === "string" ? v : JSON.stringify(v))
    .digest("hex")
    .slice(0, 16);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();
const byLoc = (a: Loc, b: Loc) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
const KIND_ORDER = new Map<string, number>(ENTITY_KINDS.map((k, i) => [k, i]));
const EDGE_ORDER = new Map<string, number>(EDGE_KINDS.map((k, i) => [k, i]));

function stepShape(s: JobStep): unknown {
  return [
    s.name,
    s.program ?? null,
    s.proc ?? null,
    s.parm ?? null,
    s.cond ?? null,
    s.dds.map((d) => [d.ddname, d.dsn ?? null, d.disp ?? null, d.sysout ?? null, d.dummy ?? false]),
    (s.procSteps ?? []).map(stepShape),
  ];
}

function jobSteps(job: Job): Array<{ path: string; step: JobStep }> {
  const out: Array<{ path: string; step: JobStep }> = [];
  for (const s of job.steps) {
    out.push({ path: `${job.name}.${s.name}`, step: s });
    for (const p of s.procSteps ?? []) {
      out.push({ path: `${job.name}.${s.name}.${p.name}`, step: p });
    }
  }
  return out;
}

/** The snapshot of an index (and its SQL DDL model). */
export function buildSnapshot(
  index: LegacyIndex,
  poly: Pick<Polyglot, "sql">,
  now: Date,
): Snapshot {
  const base =
    fs.existsSync(index.root) && fs.statSync(index.root).isFile()
      ? path.dirname(index.root)
      : index.root;
  const fileSha = new Map(index.files.map((f) => [f.path, f.sha256]));
  const raw: Array<Omit<SnapshotEntity, "key">> = [];
  const edges = new Map<string, SnapshotEdge>();
  const edge = (e: Omit<SnapshotEdge, "count">) => {
    const k = `${e.kind}|${e.from}|${e.to}|${e.op ?? ""}`;
    const prior = edges.get(k);
    if (!prior) {
      edges.set(k, { ...e, count: 1 });
      return;
    }
    prior.count++;
    if (byLoc(e, prior) < 0) {
      prior.file = e.file;
      prior.line = e.line;
    }
  };

  for (const p of index.programs) {
    let statements = 0;
    for (const para of p.paragraphs) {
      for (const s of para.statements) {
        statements++;
        const at = { file: s.file, line: s.line };
        if (s.call) {
          edge({ kind: "CALL", from: p.name, to: s.call.target, ...at });
        }
        if (s.performs) {
          edge({
            kind: "PERFORM",
            from: `${p.name}.${para.name}`,
            to: `${p.name}.${s.performs.target}`,
            ...at,
          });
        }
        for (const table of s.sql?.tables ?? []) {
          for (const op of s.sql?.ops.length ? s.sql.ops : ["?"]) {
            edge({ kind: "EXEC SQL", from: p.name, to: table, op, ...at });
          }
        }
      }
    }
    raw.push({
      kind: "program",
      name: p.name,
      file: p.file,
      line: p.line,
      hash: sha([
        p.usingParams,
        p.paragraphs.map((x) => [x.name, x.section ?? null, x.statements.map((s) => norm(s.code))]),
        p.dataItems.map((d) => norm(d.text)),
        p.files.map((f) => [f.name, f.assign ?? null, f.organization ?? null, f.access ?? null]),
        p.copies.map((c) => [c.name, c.replacing]),
      ]),
      parts: p.paragraphs.map((x) => x.name),
      size: statements,
    });
  }
  for (const c of index.copybooks) {
    raw.push({
      kind: "copybook",
      name: c.name,
      file: c.file,
      line: 1,
      hash: fileSha.get(c.file)?.slice(0, 16) ?? sha(c.name),
    });
  }
  for (const j of index.jobs) {
    raw.push({
      kind: "job",
      name: j.name,
      file: j.file,
      line: j.line,
      hash: sha([j.kind, j.symbols, j.steps.map(stepShape)]),
      parts: j.steps.map((s) => s.name),
    });
    for (const { path: from, step } of jobSteps(j)) {
      if (step.program) {
        edge({ kind: "STEP", from, to: step.program, file: step.file, line: step.line });
      }
    }
  }
  for (const t of poly.sql.tables) {
    const tname = t.schema ? `${t.schema}.${t.name}` : t.name;
    raw.push({
      kind: "table",
      name: tname,
      file: t.file,
      line: t.line,
      hash: sha([
        t.kind,
        t.columns.map((c) => [c.name, c.type]),
        t.constraints.map((c) => [c.kind, c.columns, c.references ?? null, c.text ?? null]),
        t.sources,
      ]),
      parts: t.columns.map((c) => c.name),
    });
    for (const c of t.columns) {
      raw.push({
        kind: "column",
        name: `${tname}.${c.name}`,
        file: c.file,
        line: c.line,
        hash: sha([
          c.type,
          c.nullable ?? null,
          c.default ?? null,
          c.primaryKey ?? false,
          c.unique ?? false,
          c.references ?? null,
        ]),
      });
    }
  }
  const texts = new Map<string, string[] | null>();
  const linesOf = (file: string) => {
    if (!texts.has(file)) {
      try {
        texts.set(file, fs.readFileSync(path.join(base, file), "utf8").split(/\r?\n/));
      } catch {
        texts.set(file, null);
      }
    }
    return texts.get(file) ?? null;
  };
  for (const r of poly.sql.routines) {
    const lines = linesOf(r.file);
    const body = lines
      ? lines
          .slice(r.line - 1, r.endLine)
          .map(norm)
          .filter(Boolean)
      : null;
    raw.push({
      kind: "routine",
      name: r.schema ? `${r.schema}.${r.name}` : r.name,
      file: r.file,
      line: r.line,
      hash: sha(
        body ?? [
          r.kind,
          r.on ?? null,
          r.events ?? [],
          r.access.map((a) => [a.table, a.op]),
          r.calls.map((c) => c.name),
        ],
      ),
    });
  }

  raw.sort(
    (a, b) =>
      KIND_ORDER.get(a.kind)! - KIND_ORDER.get(b.kind)! ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) ||
      byLoc(a, b),
  );
  const seen = new Set<string>();
  const entities: SnapshotEntity[] = raw.map((e) => {
    let key = `${e.kind}:${e.name}`;
    if (seen.has(key)) {
      key = `${key}@${e.file}`;
    }
    seen.add(key);
    return { ...e, key };
  });
  const edgeList = [...edges.values()].toSorted(
    (a, b) =>
      EDGE_ORDER.get(a.kind)! - EDGE_ORDER.get(b.kind)! ||
      (a.from < b.from ? -1 : a.from > b.from ? 1 : 0) ||
      (a.to < b.to ? -1 : a.to > b.to ? 1 : 0) ||
      ((a.op ?? "") < (b.op ?? "") ? -1 : (a.op ?? "") > (b.op ?? "") ? 1 : 0),
  );
  const totals = Object.fromEntries([
    ...ENTITY_KINDS.map((k) => [k, entities.filter((e) => e.kind === k).length]),
    ["edges", edgeList.length],
  ]) as Snapshot["totals"];
  return {
    schema: BASELINE_SCHEMA,
    root: index.root,
    digest: sha({ entities, edges: edgeList }),
    createdAt: now.toISOString(),
    totals,
    entities,
    edges: edgeList,
  };
}

// ---- comparison ------------------------------------------------------------------------------

export type ChangeKind = "added" | "removed" | "changed";
const CHANGE_ORDER: Record<ChangeKind, number> = { added: 0, removed: 1, changed: 2 };

export type EntityChange = {
  change: ChangeKind;
  kind: EntityKind;
  name: string;
  /** `path:line`: the current source for added/changed, the baseline's for removed. */
  evidence: string;
  detail?: string;
  /** Programs: who runs it and what it touches now (callers, job steps, tables). */
  impact?: { callers: string[]; steps: string[]; tables: string[] };
};

export type EdgeChange = {
  change: "added" | "removed";
  kind: EdgeKind;
  from: string;
  to: string;
  op?: string;
  evidence: string;
};

export type ChangeReport = {
  added: Partial<Record<EntityKind, number>>;
  removed: Partial<Record<EntityKind, number>>;
  changed: Partial<Record<EntityKind, number>>;
  edgesAdded: Partial<Record<EdgeKind, number>>;
  edgesRemoved: Partial<Record<EdgeKind, number>>;
  total: number;
  changes: EntityChange[];
  edges: EdgeChange[];
  /** Entries left out by the limit (the counts above are complete). */
  omitted: { changes: number; edges: number };
};

const at = (l: Loc) => `${l.file}:${l.line}`;
const inc = <K extends string>(m: Partial<Record<K, number>>, k: K) => {
  m[k] = (m[k] ?? 0) + 1;
};

function listDiff(before: string[] = [], after: string[] = []) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    plus: after.filter((x) => !b.has(x)),
    minus: before.filter((x) => !a.has(x)),
  };
}

function short(list: string[], max = 8): string {
  return list.length > max
    ? `${list.slice(0, max).join(", ")} +${list.length - max}`
    : list.join(", ");
}

function changeDetail(before: SnapshotEntity, after: SnapshotEntity): string {
  const bits: string[] = [];
  const { plus, minus } = listDiff(before.parts, after.parts);
  const label =
    after.kind === "program" ? "paragraphs" : after.kind === "table" ? "columns" : "steps";
  if (plus.length) {
    bits.push(`+${label} ${short(plus)}`);
  }
  if (minus.length) {
    bits.push(`-${label} ${short(minus)}`);
  }
  if (after.size !== undefined && before.size !== after.size) {
    bits.push(`statements ${before.size ?? 0}→${after.size}`);
  }
  if (before.file !== after.file) {
    bits.push(`moved from ${before.file}`);
  }
  return bits.length ? bits.join("; ") : "content changed";
}

function impactOf(name: string, edges: SnapshotEdge[]) {
  const uniq = (xs: string[]) => [...new Set(xs)].toSorted().slice(0, 10);
  return {
    callers: uniq(edges.filter((e) => e.kind === "CALL" && e.to === name).map((e) => e.from)),
    steps: uniq(edges.filter((e) => e.kind === "STEP" && e.to === name).map((e) => e.from)),
    tables: uniq(
      edges.filter((e) => e.kind === "EXEC SQL" && e.from === name).map((e) => `${e.to} (${e.op})`),
    ),
  };
}

export function compareSnapshots(base: Snapshot, cur: Snapshot, limit: number): ChangeReport {
  const report: ChangeReport = {
    added: {},
    removed: {},
    changed: {},
    edgesAdded: {},
    edgesRemoved: {},
    total: 0,
    changes: [],
    edges: [],
    omitted: { changes: 0, edges: 0 },
  };
  const before = new Map(base.entities.map((e) => [e.key, e]));
  const after = new Map(cur.entities.map((e) => [e.key, e]));
  const changes: EntityChange[] = [];
  const withImpact = (c: EntityChange): EntityChange =>
    c.kind === "program" ? { ...c, impact: impactOf(c.name, cur.edges) } : c;
  for (const e of cur.entities) {
    const b = before.get(e.key);
    if (!b) {
      inc(report.added, e.kind);
      changes.push(withImpact({ change: "added", kind: e.kind, name: e.name, evidence: at(e) }));
    } else if (b.hash !== e.hash) {
      inc(report.changed, e.kind);
      changes.push(
        withImpact({
          change: "changed",
          kind: e.kind,
          name: e.name,
          evidence: at(e),
          detail: changeDetail(b, e),
        }),
      );
    }
  }
  for (const b of base.entities) {
    if (!after.has(b.key)) {
      inc(report.removed, b.kind);
      changes.push(
        withImpact({
          change: "removed",
          kind: b.kind,
          name: b.name,
          evidence: `${at(b)} (baseline)`,
        }),
      );
    }
  }
  changes.sort(
    (x, y) =>
      KIND_ORDER.get(x.kind)! - KIND_ORDER.get(y.kind)! ||
      CHANGE_ORDER[x.change] - CHANGE_ORDER[y.change] ||
      (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
  );
  const ekey = (e: SnapshotEdge) => `${e.kind}|${e.from}|${e.to}|${e.op ?? ""}`;
  const eBefore = new Set(base.edges.map(ekey));
  const eAfter = new Set(cur.edges.map(ekey));
  const edgeChanges: EdgeChange[] = [];
  const edgeOf = (change: EdgeChange["change"], e: SnapshotEdge, suffix = ""): EdgeChange => ({
    change,
    kind: e.kind,
    from: e.from,
    to: e.to,
    ...(e.op ? { op: e.op } : {}),
    evidence: `${at(e)}${suffix}`,
  });
  for (const e of cur.edges) {
    if (!eBefore.has(ekey(e))) {
      inc(report.edgesAdded, e.kind);
      edgeChanges.push(edgeOf("added", e));
    }
  }
  for (const e of base.edges) {
    if (!eAfter.has(ekey(e))) {
      inc(report.edgesRemoved, e.kind);
      edgeChanges.push(edgeOf("removed", e, " (baseline)"));
    }
  }
  edgeChanges.sort(
    (x, y) =>
      EDGE_ORDER.get(x.kind)! - EDGE_ORDER.get(y.kind)! ||
      (x.change === y.change ? 0 : x.change === "added" ? -1 : 1) ||
      (x.from < y.from ? -1 : x.from > y.from ? 1 : 0) ||
      (x.to < y.to ? -1 : x.to > y.to ? 1 : 0) ||
      ((x.op ?? "") < (y.op ?? "") ? -1 : (x.op ?? "") > (y.op ?? "") ? 1 : 0),
  );
  report.total = changes.length + edgeChanges.length;
  report.changes = changes.slice(0, limit);
  report.edges = edgeChanges.slice(0, limit);
  report.omitted = {
    changes: changes.length - report.changes.length,
    edges: edgeChanges.length - report.edges.length,
  };
  return report;
}

// ---- storage ---------------------------------------------------------------------------------

export const BASELINE_DIR_NAME = "baseline";

export function baselineDir(cacheDir: string): string {
  return path.join(cacheDir, BASELINE_DIR_NAME);
}

const rootId = (root: string) =>
  crypto.createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);

export function snapshotFile(cacheDir: string, root: string, which: "baseline" | "candidate") {
  return path.join(baselineDir(cacheDir), `${which}-${rootId(root)}.json`);
}

export function readSnapshot(
  cacheDir: string,
  root: string,
  which: "baseline" | "candidate",
): Snapshot | null {
  try {
    const s = JSON.parse(fs.readFileSync(snapshotFile(cacheDir, root, which), "utf8")) as Snapshot;
    return s.schema === BASELINE_SCHEMA && s.root === path.resolve(root) ? s : null;
  } catch {
    return null;
  }
}

export function writeSnapshot(
  cacheDir: string,
  root: string,
  which: "baseline" | "candidate",
  snap: Snapshot,
): string {
  return writeInCache(
    baselineDir(cacheDir),
    path.basename(snapshotFile(cacheDir, root, which)),
    JSON.stringify(snap),
  );
}
