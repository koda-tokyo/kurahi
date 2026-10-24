// Project store: `<KOLO_HOME>/projects/projects.json`, plus a per-project data area
// `<KOLO_HOME>/projects/<id>/` (attachments, artifacts). Small file, synchronous reads so the
// tool guard can resolve a project on every run without plumbing a promise through.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  LocalizedText,
  Project,
  ProjectMode,
  ProjectRules,
  ProjectTemplate,
} from "./types.js";
import { resolveKoloHome } from "../config/kolo-home.js";

const FILE_VERSION = 1;
const ID_RE = /^p[a-z0-9]{10}$/;
const MAX_NAME = 120;
const MAX_LIST = 64;

type StoreFile = { version: number; projects: Project[] };

export function projectsRoot(home: string = resolveKoloHome()): string {
  return path.join(home, "projects");
}

export function projectDataDir(projectId: string, home: string = resolveKoloHome()): string {
  assertProjectId(projectId);
  return path.join(projectsRoot(home), projectId);
}

/** Per-user scratch area for uploads made outside any project. */
export function scratchDir(userKey: string, home: string = resolveKoloHome()): string {
  const safe = userKey.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "user";
  return path.join(home, "scratch", safe);
}

export function isProjectId(id: unknown): id is string {
  return typeof id === "string" && ID_RE.test(id);
}

function assertProjectId(id: string): void {
  if (!isProjectId(id)) {
    throw new Error("invalid project id");
  }
}

export function newProjectId(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(10);
  let out = "p";
  for (const b of bytes) {
    out += alphabet[b % alphabet.length];
  }
  return out;
}

function storePath(home: string): string {
  return path.join(projectsRoot(home), "projects.json");
}

function writeAtomic(file: string, data: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

export function loadProjects(home: string = resolveKoloHome()): Project[] {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath(home), "utf8")) as StoreFile;
    return Array.isArray(raw?.projects) ? raw.projects.filter((p) => isProjectId(p?.id)) : [];
  } catch {
    return [];
  }
}

function saveProjects(projects: Project[], home: string): void {
  const file: StoreFile = { version: FILE_VERSION, projects };
  writeAtomic(storePath(home), `${JSON.stringify(file, null, 2)}\n`);
}

export function getProject(id: string, home: string = resolveKoloHome()): Project | null {
  if (!isProjectId(id)) {
    return null;
  }
  return loadProjects(home).find((p) => p.id === id) ?? null;
}

/** Folders that no project may reach (for example hidden answer keys in demo packs). */
export const EXCLUDED_DIR_NAMES = ["_answer-keys"];

function posixPath(p: string): string {
  return p.split(path.sep).join("/");
}

export function excludedPathRegexes(): RegExp[] {
  return EXCLUDED_DIR_NAMES.map(
    (name) => new RegExp(`(^|/)${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(/|$)`),
  );
}

/** True when `dir` is, or directly or one level down contains, an excluded directory. */
export function containsExcludedDir(dir: string): boolean {
  if (excludedPathRegexes().some((re) => re.test(posixPath(dir)))) {
    return true;
  }
  const scan = (d: string, depth: number): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const e of entries) {
      if (!e.isDirectory()) {
        continue;
      }
      if (EXCLUDED_DIR_NAMES.includes(e.name)) {
        return true;
      }
      if (depth > 0 && scan(path.join(d, e.name), depth - 1)) {
        return true;
      }
    }
    return false;
  };
  return scan(dir, 1);
}

// ---- validation ----

function cleanList(raw: unknown, re: RegExp): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && re.test(v.trim()) && !out.includes(v.trim())) {
      out.push(v.trim());
    }
  }
  return out.slice(0, MAX_LIST);
}

const AGENT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const MODEL_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const SKILL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** A folder-relative path: no absolute paths, no `..`, forward slashes. */
export function cleanRelPath(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const v = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  if (v === "" || v === ".") {
    return ".";
  }
  if (
    v.startsWith("/") ||
    /^[A-Za-z]:/.test(v) ||
    v.split("/").some((s) => s === ".." || s === "")
  ) {
    return null;
  }
  return v.length <= 200 ? v : null;
}

function cleanText(raw: unknown): LocalizedText[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
    .map((t) => ({
      ...(typeof t.ja === "string" ? { ja: t.ja.slice(0, 2000) } : {}),
      ...(typeof t.en === "string" ? { en: t.en.slice(0, 2000) } : {}),
    }))
    .filter((t) => t.ja || t.en)
    .slice(0, MAX_LIST);
}

export function cleanRules(raw: unknown): ProjectRules {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const paths = (v: unknown) =>
    Array.isArray(v)
      ? [...new Set(v.map(cleanRelPath).filter((p): p is string => p !== null))].slice(0, MAX_LIST)
      : [];
  return {
    readOnly: paths(r.readOnly),
    writable: paths(r.writable),
    artifactApprovalRequired: r.artifactApprovalRequired === true,
    instructions: cleanText(r.instructions),
  };
}

/**
 * The project folder must be an existing directory, given as an absolute path, and must not be
 * the filesystem root, the home directory itself, or anything inside the Kurahi state dir.
 */
export function validateProjectFolder(raw: unknown, home: string = resolveKoloHome()): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("folder is required");
  }
  const input = raw.trim();
  if (!path.isAbsolute(input)) {
    throw new Error("folder must be an absolute path");
  }
  let real: string;
  try {
    real = fs.realpathSync(input);
  } catch {
    throw new Error("folder does not exist");
  }
  if (!fs.statSync(real).isDirectory()) {
    throw new Error("folder is not a directory");
  }
  if (/[*?[\]{}]/.test(real)) {
    throw new Error("folder path may not contain * ? [ ] { }");
  }
  if (containsExcludedDir(real)) {
    throw new Error(
      `folder is or contains an excluded directory (${EXCLUDED_DIR_NAMES.join(", ")})`,
    );
  }
  const root = path.parse(real).root;
  if (real === root) {
    throw new Error("the filesystem root cannot be a project folder");
  }
  if (real === os.homedir()) {
    throw new Error("the home directory itself cannot be a project folder");
  }
  let stateReal = home;
  try {
    stateReal = fs.realpathSync(home);
  } catch {
    // state dir may not exist yet
  }
  const rel = path.relative(stateReal, real);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
    throw new Error("a project folder cannot be inside the Kurahi state directory");
  }
  return real;
}

export type ProjectInput = {
  name?: unknown;
  folder?: unknown;
  allowedAgents?: unknown;
  allowedModels?: unknown;
  rules?: unknown;
  suggestedSkills?: unknown;
  starterPrompts?: unknown;
  terminalProfile?: unknown;
  templateId?: unknown;
  mode?: unknown;
};

function cleanName(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new Error("name is required");
  }
  return raw.trim().slice(0, MAX_NAME);
}

function cleanProfile(raw: unknown): string {
  return typeof raw === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(raw) ? raw : "standard";
}

/** Create a project, optionally from a template, and make the template's folders. */
export function createProject(
  input: ProjectInput,
  opts: { createdBy: string; template?: ProjectTemplate | null; home?: string; now?: Date },
): Project {
  const home = opts.home ?? resolveKoloHome();
  const tpl = opts.template ?? null;
  const folder = validateProjectFolder(input.folder, home);
  const now = (opts.now ?? new Date()).toISOString();
  const project: Project = {
    id: newProjectId(),
    name: cleanName(input.name),
    folder,
    allowedAgents: cleanList(input.allowedAgents ?? tpl?.suggestedAgents, AGENT_ID_RE),
    allowedModels: cleanList(input.allowedModels, MODEL_REF_RE),
    templateId: tpl?.id ?? null,
    rules: cleanRules(input.rules ?? tpl?.rules),
    suggestedSkills: cleanList(input.suggestedSkills ?? tpl?.suggestedSkills, SKILL_RE),
    // From the template only: a client cannot enable plugins on a project through the API.
    plugins: cleanList(tpl?.plugins, PLUGIN_ID_RE),
    starterPrompts: cleanText(input.starterPrompts ?? tpl?.starterPrompts),
    terminalProfile: cleanProfile(input.terminalProfile ?? tpl?.terminalProfile),
    mode: isProjectMode(input.mode) ? input.mode : DEFAULT_PROJECT_MODE,
    archived: false,
    createdAt: now,
    updatedAt: now,
    createdBy: opts.createdBy,
  };
  for (const sub of tpl?.folders ?? []) {
    const rel = cleanRelPath(sub);
    if (rel && rel !== ".") {
      fs.mkdirSync(path.join(folder, rel), { recursive: true });
    }
  }
  fs.mkdirSync(path.join(projectDataDir(project.id, home), "attachments"), {
    recursive: true,
    mode: 0o700,
  });
  const all = loadProjects(home);
  all.push(project);
  saveProjects(all, home);
  return project;
}

export function updateProject(
  id: string,
  patch: ProjectInput & { archived?: unknown },
  opts: { home?: string; now?: Date } = {},
): Project {
  const home = opts.home ?? resolveKoloHome();
  const all = loadProjects(home);
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) {
    throw new Error("project not found");
  }
  const cur = all[idx];
  const next: Project = {
    ...cur,
    ...(patch.name !== undefined ? { name: cleanName(patch.name) } : {}),
    ...(patch.folder !== undefined ? { folder: validateProjectFolder(patch.folder, home) } : {}),
    ...(patch.allowedAgents !== undefined
      ? { allowedAgents: cleanList(patch.allowedAgents, AGENT_ID_RE) }
      : {}),
    ...(patch.allowedModels !== undefined
      ? { allowedModels: cleanList(patch.allowedModels, MODEL_REF_RE) }
      : {}),
    ...(patch.rules !== undefined ? { rules: cleanRules(patch.rules) } : {}),
    ...(patch.starterPrompts !== undefined
      ? { starterPrompts: cleanText(patch.starterPrompts) }
      : {}),
    ...(patch.terminalProfile !== undefined
      ? { terminalProfile: cleanProfile(patch.terminalProfile) }
      : {}),
    ...(typeof patch.archived === "boolean" ? { archived: patch.archived } : {}),
    updatedAt: (opts.now ?? new Date()).toISOString(),
  };
  all[idx] = next;
  saveProjects(all, home);
  return next;
}

/** Whether an agent may work in a project. An empty list allows only the default agent. */
export const PROJECT_MODES: ProjectMode[] = ["read", "plan", "act"];
export const DEFAULT_PROJECT_MODE: ProjectMode = "plan";

export function isProjectMode(v: unknown): v is ProjectMode {
  return typeof v === "string" && (PROJECT_MODES as string[]).includes(v);
}

/** The effective mode: projects created before modes existed keep their full ("act") scope. */
export function projectMode(project: Pick<Project, "mode">): ProjectMode {
  return isProjectMode(project.mode) ? project.mode : "act";
}

/** Change a project's mode; returns the previous and the new mode. */
export function setProjectMode(
  id: string,
  mode: unknown,
  opts: { home?: string; now?: Date } = {},
): { project: Project; from: ProjectMode; to: ProjectMode } {
  if (!isProjectMode(mode)) {
    throw new Error("mode must be read, plan or act");
  }
  const home = opts.home ?? resolveKoloHome();
  const all = loadProjects(home);
  const idx = all.findIndex((p) => p.id === id);
  if (idx < 0) {
    throw new Error("project not found");
  }
  const from = projectMode(all[idx]);
  all[idx] = { ...all[idx], mode, updatedAt: (opts.now ?? new Date()).toISOString() };
  saveProjects(all, home);
  return { project: all[idx], from, to: mode };
}

export function isAgentAllowed(project: Project, agentId: string, defaultAgentId: string): boolean {
  if (project.allowedAgents.length === 0) {
    return agentId === defaultAgentId;
  }
  return project.allowedAgents.includes(agentId);
}
