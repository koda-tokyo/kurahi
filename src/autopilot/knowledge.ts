// Approved company knowledge for a routine's reasoning: files people keep in a READ-ONLY folder
// of the Project (e.g. knowledge/company-facts.md), declared by the routine (`knowledge:`). Their
// text reaches the model as TRUSTED facts in a block of its own, apart from the gathered
// sources (always untrusted). Trust comes from where the file lives: only people can write a
// read-only folder (agents and the autopilot cannot), and the routine file that names it is set
// by an administrator.
//
// Fail closed: a path outside every read-only folder, or one that leaves the Project (`..`, a
// symbolic link), fails the run. A file that does not exist (yet) is skipped and recorded.
// Bounded: at most MAX_KNOWLEDGE_FILE_BYTES per file and MAX_KNOWLEDGE_CHARS in total.

import fs from "node:fs";
import type { Project } from "../projects/types.js";
import { resolveProjectFile } from "../projects/scope.js";

export const MAX_KNOWLEDGE_FILE_BYTES = 64 * 1024;
export const MAX_KNOWLEDGE_CHARS = 20_000;

export type KnowledgeFile = { path: string; text: string; bytes: number; truncated: boolean };
export type KnowledgeLoad = {
  files: KnowledgeFile[];
  /** Declared files that were not there (skipped). */
  missing: string[];
};

/** The read-only folder a Project-relative path lies under, or null. */
export function readOnlyFolderOf(project: Pick<Project, "rules">, rel: string): string | null {
  for (const r of project.rules.readOnly) {
    if (r === "." || rel.startsWith(`${r}/`)) {
      return r;
    }
  }
  return null;
}

export class KnowledgeRefused extends Error {}

export function loadKnowledge(
  project: Pick<Project, "folder" | "rules">,
  paths: readonly string[],
): KnowledgeLoad {
  const out: KnowledgeLoad = { files: [], missing: [] };
  let budget = MAX_KNOWLEDGE_CHARS;
  for (const rel of paths) {
    if (!readOnlyFolderOf(project, rel)) {
      throw new KnowledgeRefused(
        `knowledge ${rel} is not under a read-only folder of the Project (read-only: ${project.rules.readOnly.join(", ") || "none"})`,
      );
    }
    let abs: string;
    try {
      abs = resolveProjectFile(project.folder, rel);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/does not exist/.test(msg)) {
        out.missing.push(rel);
        continue;
      }
      throw new KnowledgeRefused(`knowledge ${rel}: ${msg}`, { cause: err });
    }
    const size = fs.statSync(abs).size;
    if (size > MAX_KNOWLEDGE_FILE_BYTES) {
      throw new KnowledgeRefused(
        `knowledge ${rel} is larger than ${MAX_KNOWLEDGE_FILE_BYTES / 1024} KB; keep approved facts short`,
      );
    }
    const raw = fs.readFileSync(abs, "utf8");
    const text = raw.slice(0, Math.max(0, budget));
    budget -= text.length;
    out.files.push({ path: rel, text, bytes: size, truncated: text.length < raw.length });
  }
  return out;
}
