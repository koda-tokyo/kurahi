// Read a linked-case plan from a pack worksheet (people-operations onboarding/offboarding). The
// worksheet has a task manifest (Key | Task | Depends on | …) and a department mapping
// (Task key | Department ID | …). Dotted worksheet keys map one-to-one to engine keys
// (`onboarding.hr-confirm` → `onboarding-hr-confirm`); both are returned so evidence can keep
// the worksheet key. Pure: nothing is installed. Any cell that cannot be read exactly refuses the
// whole plan — dropping a dependency would open a step early.

import type { LinkedCasePlan, LinkedCaseStep, LinkedPlanProblem } from "./links.js";
import { validateLinkedPlan } from "./links.js";
import { isDepartmentId } from "./types.js";

export type WorksheetPlanProblem =
  | { code: "no_manifest" }
  | { code: "no_department_mapping" }
  | { code: "duplicate_table"; table: "manifest" | "mapping" }
  | { code: "duplicate_column"; table: "manifest" | "mapping"; column: string }
  | { code: "bad_row"; table: "manifest" | "mapping"; line: number }
  | { code: "bad_task_key"; line: number }
  | { code: "duplicate_task"; key: string }
  | { code: "bad_title"; key: string }
  | { code: "bad_dependency_cell"; key: string }
  | { code: "unmapped_task"; key: string }
  | { code: "mapping_without_task"; key: string }
  | { code: "duplicate_mapping"; key: string }
  | { code: "bad_department"; key: string; department: string }
  | LinkedPlanProblem;

export type WorksheetPlan = {
  plan: LinkedCasePlan | null;
  /** Engine step key → worksheet task key. */
  sourceKeys: Record<string, string>;
  problems: WorksheetPlanProblem[];
};

const SOURCE_KEY_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/;
const TITLE_MAX = 200;
const NONE = new Set(["", "—", "-", "–"]);

type Table = { header: string[]; rows: Array<{ cells: string[]; line: number }> };

function cells(line: string): string[] | null {
  const t = line.trim();
  if (!t.startsWith("|") || !t.endsWith("|") || t.length < 2) {
    return null;
  }
  return t
    .slice(1, -1)
    .split("|")
    .map((c) => c.trim());
}

function tables(markdown: string): Table[] {
  const lines = markdown.split(/\r?\n/);
  const out: Table[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const header = cells(lines[i]);
    const sep = cells(lines[i + 1]);
    if (!header || !sep || !sep.every((c) => /^:?-{3,}:?$/.test(c))) {
      continue;
    }
    const table: Table = { header: header.map((h) => h.split(" / ")[0].trim()), rows: [] };
    let j = i + 2;
    for (; j < lines.length; j++) {
      const row = cells(lines[j]);
      if (!row) {
        break;
      }
      table.rows.push({ cells: row, line: j + 1 });
    }
    out.push(table);
    i = j - 1;
  }
  return out;
}

/** `` `a.b` `` → `a.b`; anything else (bare text, several keys) → null. */
function sourceKey(cell: string): string | null {
  const m = /^`([^`]*)`$/.exec(cell);
  return m && SOURCE_KEY_RE.test(m[1]) ? m[1] : null;
}

function title(cell: string): LinkedCaseStep["title"] | null {
  const at = cell.indexOf(" / ");
  const en = (at < 0 ? cell : cell.slice(0, at)).trim();
  const ja = at < 0 ? "" : cell.slice(at + 3).trim();
  if (!en || en.length > TITLE_MAX || ja.length > TITLE_MAX) {
    return null;
  }
  return ja ? { en, ja } : { en };
}

function dependencies(cell: string): string[] | null {
  if (NONE.has(cell)) {
    return [];
  }
  const keys = cell.split(",").map((part) => sourceKey(part.trim()));
  return keys.every((k): k is string => k !== null) ? keys : null;
}

const engineKey = (source: string) => source.replaceAll(".", "-");

const MANIFEST_COLUMNS = ["Key", "Task", "Depends on"];
const MAPPING_COLUMNS = ["Task key", "Department ID"];

/** Structural columns that appear more than once — reading only the first would drop data. */
const repeatedColumns = (header: string[], columns: string[]) =>
  columns.filter((c) => header.indexOf(c) !== header.lastIndexOf(c));

export function linkedPlanFromWorksheet(markdown: string): WorksheetPlan {
  const all = tables(markdown);
  const manifests = all.filter(
    (t) => t.header[0] === "Key" && t.header.includes("Task") && t.header.includes("Depends on"),
  );
  const mappings = all.filter(
    (t) => t.header[0] === "Task key" && t.header.includes("Department ID"),
  );
  const [manifest] = manifests;
  const [mapping] = mappings;
  const problems: WorksheetPlanProblem[] = [];
  if (!manifest) {
    problems.push({ code: "no_manifest" });
  }
  if (!mapping) {
    problems.push({ code: "no_department_mapping" });
  }
  // Two candidate tables, or a structural column twice, leave which cell counts ambiguous.
  if (manifests.length > 1) {
    problems.push({ code: "duplicate_table", table: "manifest" });
  }
  if (mappings.length > 1) {
    problems.push({ code: "duplicate_table", table: "mapping" });
  }
  for (const column of manifest ? repeatedColumns(manifest.header, MANIFEST_COLUMNS) : []) {
    problems.push({ code: "duplicate_column", table: "manifest", column });
  }
  for (const column of mapping ? repeatedColumns(mapping.header, MAPPING_COLUMNS) : []) {
    problems.push({ code: "duplicate_column", table: "mapping", column });
  }
  if (!manifest || !mapping || problems.length) {
    return { plan: null, sourceKeys: {}, problems };
  }

  const departments = new Map<string, string>();
  const deptCol = mapping.header.indexOf("Department ID");
  for (const { cells: row, line } of mapping.rows) {
    const key = row.length === mapping.header.length ? sourceKey(row[0]) : null;
    const dept = row.length === mapping.header.length ? /^`([^`]*)`$/.exec(row[deptCol]) : null;
    if (!key || !dept) {
      problems.push({ code: "bad_row", table: "mapping", line });
      continue;
    }
    if (departments.has(key)) {
      problems.push({ code: "duplicate_mapping", key });
      continue;
    }
    departments.set(key, dept[1]);
  }

  const taskCol = manifest.header.indexOf("Task");
  const depCol = manifest.header.indexOf("Depends on");
  const steps: LinkedCaseStep[] = [];
  const sourceKeys: Record<string, string> = {};
  const seen = new Set<string>();
  const sourceDeps: Array<{ key: string; deps: string[] }> = [];
  for (const { cells: row, line } of manifest.rows) {
    if (row.length !== manifest.header.length) {
      problems.push({ code: "bad_row", table: "manifest", line });
      continue;
    }
    const key = sourceKey(row[0]);
    if (!key) {
      problems.push({ code: "bad_task_key", line });
      continue;
    }
    if (seen.has(key)) {
      problems.push({ code: "duplicate_task", key });
      continue;
    }
    seen.add(key);
    const t = title(row[taskCol]);
    const deps = dependencies(row[depCol]);
    const dept = departments.get(key);
    if (!t) {
      problems.push({ code: "bad_title", key });
    }
    if (!deps) {
      problems.push({ code: "bad_dependency_cell", key });
    }
    if (dept === undefined) {
      problems.push({ code: "unmapped_task", key });
    } else if (!isDepartmentId(dept)) {
      problems.push({ code: "bad_department", key, department: dept });
    }
    if (deps) {
      sourceDeps.push({ key, deps });
    }
    if (t && deps && dept !== undefined && isDepartmentId(dept)) {
      steps.push({
        key: engineKey(key),
        department: dept,
        title: t,
        dependsOn: deps.map(engineKey),
      });
      sourceKeys[engineKey(key)] = key;
    }
  }
  // Check references against the exact worksheet keys before normalizing: `a-b` must not
  // silently bind to a worksheet task `a.b`.
  for (const { key, deps } of sourceDeps) {
    for (const dependsOn of deps) {
      if (!seen.has(dependsOn)) {
        problems.push({ code: "unknown_dependency", key, dependsOn });
      }
    }
  }
  for (const key of departments.keys()) {
    if (!seen.has(key)) {
      problems.push({ code: "mapping_without_task", key });
    }
  }
  if (problems.length) {
    return { plan: null, sourceKeys: {}, problems };
  }
  const plan: LinkedCasePlan = { steps };
  const planProblems = validateLinkedPlan(plan);
  return planProblems.length
    ? { plan: null, sourceKeys: {}, problems: planProblems }
    : { plan, sourceKeys, problems: [] };
}
