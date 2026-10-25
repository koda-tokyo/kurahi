// Project scope: which session belongs to which project, and the tool permission set that keeps
// an agent working in a project inside that project's folder.
//
// The scope is enforced by the existing tool permission guard (src/agents/permissions.ts, the
// same `class:pattern` rules as agents.list[].permissions): in a project session, read, write and
// exec are deny-by-default; reads are allowed in the project folder and the project's data area
// (attachments, artifacts); writes only in the folders the project rules mark writable; exec is
// not granted. Directories named in EXCLUDED_DIR_NAMES are never reachable.

import fs from "node:fs";
import path from "node:path";
import type { ToolPermissionSet } from "../agents/permissions.js";
import type { Project, ProjectTemplate } from "./types.js";
import { parsePermissionRule } from "../agents/permissions.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { isDepartmentId, type DepartmentId } from "../workitems/types.js";
import { excludedPathRegexes, projectDataDir, projectMode } from "./store.js";
import { loadTemplates } from "./templates.js";

export { EXCLUDED_DIR_NAMES, containsExcludedDir, excludedPathRegexes } from "./store.js";

const REST_RE = /^proj-(p[a-z0-9]{10})-([a-z0-9]{1,32})$/;

export type ProjectSessionRef = { agentId: string; projectId: string; chatId: string };

export function projectSessionKey(agentId: string, projectId: string, chatId: string): string {
  return `agent:${agentId}:proj-${projectId}-${chatId}`;
}

export function parseProjectSessionKey(key: string | undefined | null): ProjectSessionRef | null {
  const parsed = parseAgentSessionKey(key);
  if (!parsed) {
    return null;
  }
  const m = REST_RE.exec(parsed.rest);
  return m ? { agentId: parsed.agentId, projectId: m[1], chatId: m[2] } : null;
}

/** Department tags are conversation context, never access grants. */
export function departmentIdOfProjectChat(chatId: string): DepartmentId | null {
  const match = /^dept([a-z]+)0[a-z0-9]+$/.exec(chatId);
  return match && chatId.length <= 32 && isDepartmentId(match[1]) ? match[1] : null;
}

function posix(p: string): string {
  return p.split(path.sep).join("/");
}

/** Writable folder-relative paths after removing anything that overlaps a read-only path. */
export function effectiveWritable(project: Pick<Project, "rules">): string[] {
  const ro = project.rules.readOnly;
  return project.rules.writable.filter((w) => {
    if (w === "." && ro.length > 0) {
      return false;
    }
    return !ro.some((r) => r === "." || w === r || w.startsWith(`${r}/`) || r.startsWith(`${w}/`));
  });
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Resolve a path a tool was given (relative to the project folder, or absolute inside it) to the
 * real path of a regular file in that folder. Refused: leaving the folder lexically (`../`, an
 * absolute path elsewhere) or through a symbolic link (checked on the real path), an excluded
 * folder, and anything that is not a regular file. Error messages never echo the path.
 */
export function resolveProjectFile(folder: string, input: unknown): string {
  const text = typeof input === "string" ? input.trim() : "";
  if (!text || text.includes("\0")) {
    throw new Error("path is required");
  }
  let root: string;
  try {
    root = fs.realpathSync(folder);
  } catch {
    throw new Error("the project folder is not available");
  }
  const lexical = path.resolve(root, text);
  if (!isInside(root, lexical)) {
    throw new Error("the path is outside the project folder");
  }
  let real: string;
  try {
    real = fs.realpathSync(lexical);
  } catch {
    throw new Error("the file does not exist in the project folder");
  }
  if (!isInside(root, real)) {
    throw new Error("the path leads outside the project folder through a symbolic link");
  }
  if (excludedPathRegexes().some((re) => re.test(posix(path.relative(root, real))))) {
    throw new Error("the path is in an excluded folder");
  }
  if (!fs.statSync(real).isFile()) {
    throw new Error("the path is not a regular file");
  }
  return real;
}

/**
 * Legacy analyser tools (extensions/legacy-analyzer). Reads: the permission guard classifies each
 * call as a read of its `path` (src/agents/permissions.ts), so they reach only the project folder
 * and never an excluded folder such as `_answer-keys`. They write the analyser's own cache folder
 * (`output/.legacy-index/`: the index, the latest design document and wave plan, the
 * change-detection baseline) and, for legacy_design_doc with output_format docx, a new Word file
 * in `output/design-docs/` under the office path guards (only where the mode makes output/
 * writable, never over an existing file); never a file the agent chooses.
 */
export const LEGACY_ANALYZER_TOOLS = [
  "legacy_index",
  "legacy_query",
  "legacy_rules",
  "legacy_dictionary",
  "legacy_impact",
  "legacy_design_doc",
  "legacy_wave_plan",
  "legacy_changes",
  "legacy_baseline_advance",
  "modernise_plan",
  "modernise_crud",
  "modernise_impact",
  "modernise_inventory",
];

/** Tools that only read (no writes, no commands, nothing leaves the machine). */
export const READ_MODE_TOOLS = [
  "read",
  "image",
  "memory_get",
  "memory_search",
  "sessions_list",
  "sessions_history",
  "session_status",
  "agents_list",
  ...LEGACY_ANALYZER_TOOLS,
];

/** Plan mode adds the file-writing tools; their paths are limited to plans/ and output/. */
export const PLAN_MODE_TOOLS = [...READ_MODE_TOOLS, "write", "edit", "apply_patch"];

/** Folders plan mode may write: drafts only. */
export const PLAN_MODE_FOLDERS = ["plans", "output"];

/** Writable folder-relative paths for a project in a given mode. */
export function writableForMode(project: Project): string[] {
  const mode = projectMode(project);
  if (mode === "read") {
    return [];
  }
  if (mode === "plan") {
    return effectiveWritable({
      rules: { ...project.rules, writable: PLAN_MODE_FOLDERS },
    });
  }
  return effectiveWritable(project);
}

/** The permission set for tools running in a session of `project`, by its mode. */
export function projectPermissionSet(project: Project, home?: string): ToolPermissionSet {
  const folder = posix(project.folder);
  const data = posix(projectDataDir(project.id, home));
  const mode = projectMode(project);
  const raw = [
    `read:${folder}/**`,
    `read:${data}/**`,
    ...writableForMode(project).map((w) =>
      w === "." ? `write:${folder}/**` : `write:${folder}/${w}/**`,
    ),
  ];
  const rules = raw
    .map((r) => parsePermissionRule(r, project.folder).rule)
    .filter((r): r is NonNullable<typeof r> => Boolean(r));
  return {
    active: true,
    rules,
    problems: [],
    denyByDefault: ["read", "write", "exec"],
    denyPaths: excludedPathRegexes(),
    label: `project "${project.name}" (${mode} mode)`,
    ...(mode === "read" ? { allowTools: READ_MODE_TOOLS } : {}),
    ...(mode === "plan" ? { allowTools: PLAN_MODE_TOOLS } : {}),
  };
}

/**
 * Plugins enabled for this project only: the project's own list, or, for a project made before
 * projects carried one, its template's list.
 */
export function projectPluginIds(
  project: Pick<Project, "plugins" | "templateId">,
  templates: Array<Pick<ProjectTemplate, "id" | "plugins">> = loadTemplates(),
): string[] {
  if (Array.isArray(project.plugins)) {
    return project.plugins;
  }
  return templates.find((t) => t.id === project.templateId)?.plugins ?? [];
}

/** Context the agent receives with each message in a project session (not shown in the UI). */
export function projectContextForAgent(
  project: Project,
  packText = "",
  departmentContext = "",
): string {
  const lines = [
    `[Project: ${project.name}]`,
    `Project folder: ${project.folder}`,
    `You may read files only inside the project folder. ` +
      (writableForMode(project).length > 0
        ? `You may write only inside: ${writableForMode(project)
            .map((w) => (w === "." ? project.folder : path.join(project.folder, w)))
            .join(", ")}.`
        : "You may not write files in this project."),
  ];
  const mode = projectMode(project);
  lines.push(
    `Mode: ${mode === "read" ? "read only (参照): no writes, no commands" : mode === "plan" ? "plan (計画): write drafts only to plans/ and output/" : "act (実行): the project's writable folders"}`,
  );
  if (project.rules.readOnly.length > 0) {
    lines.push(`Read-only: ${project.rules.readOnly.join(", ")}`);
  }
  for (const rule of project.rules.instructions) {
    lines.push(`Rule: ${rule.en ?? rule.ja}`);
  }
  if (projectPluginIds(project).includes("legacy-analyzer")) {
    lines.push(
      `Legacy analyser: before reading sources yourself, call legacy_index with path "${project.folder}", ` +
        "then legacy_query, legacy_rules, legacy_dictionary or legacy_impact with the same path " +
        "(legacy_design_doc and legacy_wave_plan generate the design document and a migration wave proposal). " +
        "For Java, SQL DDL or mixed projects, start with modernise_plan, then modernise_crud, modernise_impact or modernise_inventory; " +
        "assistants it lists as planned are not available yet, say so. " +
        "State only facts the analyser returned and cite each one as file:line from its output; the analyser provides the facts, you explain them.",
    );
  }
  lines.push(
    "Do not name your underlying model, its version or its vendor. If asked, say you are the Kurahi assistant.",
  );
  if (project.rules.artifactApprovalRequired) {
    lines.push("Outputs of this project need approval before they are final.");
  }
  if (departmentContext) {
    lines.push(departmentContext);
  }
  const body = packText ? `${lines.join("\n")}\n\n${packText}` : lines.join("\n");
  return `[[kurahi-project]]\n${body}\n[[/kurahi-project]]`;
}
