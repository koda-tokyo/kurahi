// Where an Office file may be written: a relative path inside the current Project's folder, in a
// folder the Project's mode makes writable (実行 Act only), never through a symlink, never over an
// existing file unless asked, never onto a file the integrity registry protects.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Project } from "../projects/types.js";
import { currentProtectedSet, isProtectedPath } from "../integrity/write-policy.js";
import { safeFileName } from "../projects/documents.js";
import { parseProjectSessionKey, writableForMode } from "../projects/scope.js";
import { EXCLUDED_DIR_NAMES, getProject, projectMode } from "../projects/store.js";
import { OfficeError } from "./common.js";

export type OfficeTarget = {
  project: Project;
  /** Real path of the file to write. */
  abs: string;
  /** Path relative to the project folder, forward slashes. */
  rel: string;
  overwrite: boolean;
};

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * The project of a session, refusing outside projects and outside 実行 Act mode. `anyMode`: any
 * mode with a writable folder (計画 Plan writes plans/ and output/); resolveTarget still limits
 * the path to the folders the mode makes writable (the legacy analyser's 設計書 into output/).
 */
export function projectForSession(
  sessionKey: string | undefined,
  home?: string,
  opts: { anyMode?: boolean } = {},
): Project {
  const ref = parseProjectSessionKey(sessionKey);
  if (!ref) {
    throw new OfficeError(
      "not_in_project",
      "Office files can only be written in a Project chat. Open this conversation inside a Project.",
    );
  }
  const project = getProject(ref.projectId, home);
  if (!project || project.archived) {
    throw new OfficeError("not_in_project", "this Project does not exist or is archived");
  }
  const mode = projectMode(project);
  if (mode !== "act" && !(opts.anyMode && mode === "plan")) {
    throw new OfficeError(
      "mode",
      `the Project is in ${mode === "read" ? "参照 Read" : "計画 Plan"} mode; creating files needs ${opts.anyMode ? "計画 Plan or " : ""}実行 Act mode`,
    );
  }
  return project;
}

/** Validate the requested relative path and resolve it to a real path in the project. */
export function resolveTarget(params: {
  project: Project;
  path: unknown;
  ext: "pptx" | "docx" | "xlsx";
  overwrite: boolean;
}): OfficeTarget {
  const { project, ext } = params;
  if (typeof params.path !== "string" || !params.path.trim()) {
    throw new OfficeError("path", `path is required (a file name such as "report.${ext}")`);
  }
  const raw = params.path.trim().replace(/\\/g, "/");
  if (raw.length > 240) {
    throw new OfficeError("path", "path is too long");
  }
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) {
    throw new OfficeError("path", "path must be relative to the Project folder");
  }
  const segments = raw.split("/");
  if (segments.some((s) => s === ".." || s === "." || s === "")) {
    throw new OfficeError("path", "path may not contain '..', '.' or empty segments");
  }
  const name = safeFileName(segments.pop() ?? "");
  if (!name.toLowerCase().endsWith(`.${ext}`) || name.length <= ext.length + 1) {
    throw new OfficeError("path", `the file name must end in .${ext}`);
  }
  for (const s of segments) {
    if (safeFileName(s) !== s || s.startsWith(".")) {
      throw new OfficeError("path", `folder name "${s}" is not allowed`);
    }
    if (EXCLUDED_DIR_NAMES.includes(s)) {
      throw new OfficeError("path", `"${s}" is never reachable`);
    }
  }

  const writable = writableForMode(project);
  if (writable.length === 0) {
    throw new OfficeError("path", "this Project has no writable folder");
  }
  // A bare file name goes into output/ when that is writable, else the first writable folder.
  let dirRel = segments.join("/");
  if (!dirRel) {
    dirRel = writable.includes(".")
      ? ""
      : writable.includes("output")
        ? "output"
        : (writable[0] ?? "");
  }
  const rel = dirRel ? `${dirRel}/${name}` : name;
  if (!writable.some((w) => w === "." || rel.startsWith(`${w}/`))) {
    throw new OfficeError(
      "path",
      `"${rel}" is not in a writable folder of this Project (writable: ${writable.join(", ")})`,
    );
  }

  let folderReal: string;
  try {
    folderReal = fs.realpathSync(project.folder);
  } catch {
    throw new OfficeError("path", "the Project folder does not exist");
  }
  // Walk (and create) the folders one by one, refusing any symlink on the way.
  let dir = folderReal;
  for (const s of dirRel ? dirRel.split("/") : []) {
    dir = path.join(dir, s);
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(dir);
    } catch {
      st = null;
    }
    if (st?.isSymbolicLink()) {
      throw new OfficeError("path", `"${s}" is a symbolic link; refusing to write through it`);
    }
    if (st && !st.isDirectory()) {
      throw new OfficeError("path", `"${s}" is not a folder`);
    }
    if (!st) {
      fs.mkdirSync(dir);
    }
  }
  const dirReal = fs.realpathSync(dir);
  if (!within(dirReal, folderReal)) {
    throw new OfficeError("path", "the target folder resolves outside the Project");
  }
  const abs = path.join(dirReal, name);
  let st: fs.Stats | null = null;
  try {
    st = fs.lstatSync(abs);
  } catch {
    st = null;
  }
  if (st?.isSymbolicLink()) {
    throw new OfficeError("path", `"${rel}" is a symbolic link; refusing to write through it`);
  }
  if (st && !st.isFile()) {
    throw new OfficeError("path", `"${rel}" exists and is not a file`);
  }
  if (st && !params.overwrite) {
    throw new OfficeError("exists", `"${rel}" already exists; pass overwrite: true to replace it`);
  }
  if (isProtectedPath(abs, folderReal, currentProtectedSet())) {
    throw new OfficeError("path", `"${rel}" is protected by the integrity registry`);
  }
  return { project, abs, rel, overwrite: params.overwrite };
}

/** Write via a temp file in the same folder and rename, so a reader never sees half a file. */
export function writeTarget(target: OfficeTarget, buf: Buffer): void {
  const dir = path.dirname(target.abs);
  const tmp = path.join(dir, `.${crypto.randomBytes(6).toString("hex")}.office.tmp`);
  try {
    fs.writeFileSync(tmp, buf, { flag: "wx", mode: 0o644 });
    // Re-check right before the rename: the name may have appeared (or become a link) meanwhile.
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(target.abs);
    } catch {
      st = null;
    }
    if (st && (st.isSymbolicLink() || !st.isFile() || !target.overwrite)) {
      throw new OfficeError("exists", `"${target.rel}" appeared while writing; not replaced`);
    }
    fs.renameSync(tmp, target.abs);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Write `buf` as `<dir>/<stem>.<ext>` in the Project, never over an existing file: when the name
 * is taken, `<stem>-2`, `<stem>-3` … (at most `maxTries` names). Same path guards as above.
 */
export function writeUniqueTarget(params: {
  project: Project;
  dir: string;
  stem: string;
  ext: "pptx" | "docx" | "xlsx";
  buf: Buffer;
  maxTries?: number;
}): OfficeTarget {
  const max = params.maxTries ?? 99;
  for (let n = 1; n <= max; n++) {
    const name = `${params.stem}${n === 1 ? "" : `-${n}`}.${params.ext}`;
    try {
      const target = resolveTarget({
        project: params.project,
        path: params.dir ? `${params.dir}/${name}` : name,
        ext: params.ext,
        overwrite: false,
      });
      writeTarget(target, params.buf);
      return target;
    } catch (err) {
      if (err instanceof OfficeError && err.code === "exists") {
        continue;
      }
      throw err;
    }
  }
  throw new OfficeError("exists", `no free file name for ${params.stem}.${params.ext}`);
}
