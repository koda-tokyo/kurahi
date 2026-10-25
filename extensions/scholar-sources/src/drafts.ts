// Project files the Scholars tools read: one file, or the newest few documents of a folder
// (drafts in output/drafts/, the grants list in knowledge/). Only inside the current Project
// folder, never through a symbolic link, never an excluded folder (the core project-file reader
// checks each file again), bounded in count and size.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Project } from "../../../src/projects/types.js";
import {
  ConnectorError,
  extractDocumentText,
  readProjectFile,
  type ToolContext,
} from "../../../src/connectors/business/index.js";
import { parseProjectSessionKey } from "../../../src/projects/scope.js";
import { getProject } from "../../../src/projects/store.js";

export const DRAFT_MAX_BYTES = 20 * 1024 * 1024;
export const MAX_DRAFTS = 5;
const MAX_TEXT_CHARS = 200_000;
const DOC_EXT = /\.(md|txt|docx|pdf)$/i;

export function projectOf(ctx: ToolContext): Project {
  const ref = parseProjectSessionKey(ctx.sessionKey);
  const project = ref ? getProject(ref.projectId) : null;
  if (!project || project.archived) {
    throw new ConnectorError(
      "unsupported",
      "not in a project session",
      undefined,
      "this tool works only in a Project chat or a Project routine",
    );
  }
  return project;
}

export type DraftText = {
  path: string;
  /** Empty when only the listing was asked for. */
  text: string;
  modifiedAt: string;
  /** First 12 hex digits of the file's SHA-256: one version of the draft. */
  sha12: string;
};

/** A draft version as one token (`<sha12>:<encoded path>`), what a routine fans out over. */
export function draftRef(d: Pick<DraftText, "path" | "sha12">): string {
  return `${d.sha12}:${encodeURIComponent(d.path)}`;
}

export function parseDraftRef(v: string): { sha12: string; path: string } | null {
  const m = /^([0-9a-f]{12}):([A-Za-z0-9%._~!*'()-]{1,1500})$/.exec(v.trim());
  if (!m) {
    return null;
  }
  try {
    return { sha12: m[1], path: decodeURIComponent(m[2]) };
  } catch {
    return null;
  }
}

function relInside(root: string, input: string): string {
  const lexical = path.resolve(root, input.trim());
  const rel = path.relative(root, lexical);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new ConnectorError(
      "bad_request",
      "path refused",
      undefined,
      "the path is outside the Project",
    );
  }
  return rel;
}

/** Text of `input` (a file) or of the newest documents in `input` (a folder), changed since. */
export async function readDrafts(
  ctx: ToolContext,
  input: string,
  since: string | null,
  opts: { text?: boolean } = {},
): Promise<DraftText[]> {
  const project = projectOf(ctx);
  let root: string;
  try {
    root = fs.realpathSync(project.folder);
  } catch {
    throw new ConnectorError(
      "unsupported",
      "project folder missing",
      undefined,
      "the Project folder is not available",
    );
  }
  const rel = relInside(root, input);
  const abs = path.join(root, rel);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(abs);
  } catch {
    throw new ConnectorError(
      "not_found",
      "path missing",
      undefined,
      "the path does not exist in the Project",
    );
  }
  if (st.isSymbolicLink()) {
    throw new ConnectorError(
      "bad_request",
      "symlink",
      undefined,
      "symbolic links are not followed",
    );
  }
  let files: Array<{ rel: string; mtime: number }>;
  if (st.isDirectory()) {
    const real = fs.realpathSync(abs);
    if (path.relative(root, real).startsWith("..")) {
      throw new ConnectorError(
        "bad_request",
        "path refused",
        undefined,
        "the folder is outside the Project",
      );
    }
    const after = since ? Date.parse(`${since}T00:00:00Z`) : 0;
    files = fs
      .readdirSync(real, { withFileTypes: true })
      .filter((d) => d.isFile() && !d.name.startsWith(".") && DOC_EXT.test(d.name))
      .map((d) => ({
        rel: path.posix.join(rel.split(path.sep).join("/"), d.name),
        mtime: fs.lstatSync(path.join(real, d.name)).mtimeMs,
      }))
      .filter((f) => f.mtime >= after)
      .toSorted((a, b) => b.mtime - a.mtime)
      .slice(0, MAX_DRAFTS);
  } else {
    files = [{ rel: rel.split(path.sep).join("/"), mtime: st.mtimeMs }];
  }
  const out: DraftText[] = [];
  for (const f of files) {
    const file = await readProjectFile(ctx, f.rel, DRAFT_MAX_BYTES);
    const text =
      opts.text === false
        ? ""
        : file.kind === "md" || file.kind === "txt"
          ? file.buf.toString("utf8")
          : await extractDocumentText(file.name, file.buf);
    out.push({
      path: f.rel,
      text: text.slice(0, MAX_TEXT_CHARS),
      modifiedAt: new Date(f.mtime).toISOString(),
      sha12: createHash("sha256").update(file.buf).digest("hex").slice(0, 12),
    });
  }
  return out;
}
