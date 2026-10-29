// Engineering pack (エンジニアリングパック): standing project context the gateway gives the agent
// with every message in a project.
//
// A pack is a `context/` folder with five sections: rules/, processes/, guides/, templates/,
// prompts/. Two places are read, in this order: the project folder's own `context/` (the
// client's pack) and the project's data area `<KOLO_HOME>/projects/<id>/context/` (the starter
// pack copied from the template). Rules always come first; inside a section files are sorted by
// path; the order never depends on the file system. Text files only (.md, .txt). The whole pack
// is kept within a character budget: files are included in order until the budget runs out, and
// the file that crosses it is truncated with a marker.

import fs from "node:fs";
import path from "node:path";
import type { Project } from "./types.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { EXCLUDED_DIR_NAMES, projectDataDir } from "./store.js";

export const PACK_SECTIONS = ["rules", "processes", "guides", "templates", "prompts"] as const;
export type PackSection = (typeof PACK_SECTIONS)[number];

/** Default size budget for the pack text given to the agent (characters). */
export const PACK_BUDGET_CHARS = 6000;
const MAX_FILES_PER_SECTION = 50;
const MAX_FILE_BYTES = 256 * 1024;
const TEXT_EXT = /\.(md|markdown|txt)$/i;
// Starter files may also be CSV / JSON data (a sample price list); pack sections stay text.
const STARTER_EXT = /\.(md|markdown|txt|csv|json)$/i;

export type PackFile = {
  section: PackSection;
  source: "project" | "template";
  /** Path relative to the pack root (e.g. "rules/01-source-is-read-only.md"). */
  path: string;
  chars: number;
  includedChars: number;
  truncated: boolean;
};

export type LoadedPack = {
  budget: number;
  totalChars: number;
  includedChars: number;
  files: PackFile[];
  /** The text the agent receives (empty when there is no pack). */
  text: string;
};

function listSection(root: string, section: PackSection): string[] {
  const dir = path.join(root, section);
  const out: string[] = [];
  const walk = (d: string, rel: string, depth: number) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || EXCLUDED_DIR_NAMES.includes(e.name) || e.isSymbolicLink()) {
        continue;
      }
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && depth < 2) {
        walk(path.join(d, e.name), relPath, depth + 1);
      } else if (e.isFile() && TEXT_EXT.test(e.name)) {
        out.push(relPath);
      }
    }
  };
  walk(dir, "", 0);
  // Code-point order, independent of locale and file system.
  return out.toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, MAX_FILES_PER_SECTION);
}

export function packRoots(
  project: Pick<Project, "id" | "folder">,
  home: string = resolveKoloHome(),
) {
  return [
    { source: "project" as const, root: path.join(project.folder, "context") },
    { source: "template" as const, root: path.join(projectDataDir(project.id, home), "context") },
  ];
}

/** Load a project's engineering pack within `budget` characters. */
export function loadProjectPack(
  project: Pick<Project, "id" | "folder">,
  opts: { home?: string; budget?: number } = {},
): LoadedPack {
  const budget = opts.budget ?? PACK_BUDGET_CHARS;
  const roots = packRoots(project, opts.home);
  const files: PackFile[] = [];
  const parts: string[] = [];
  let used = 0;
  let total = 0;
  for (const section of PACK_SECTIONS) {
    for (const { source, root } of roots) {
      for (const rel of listSection(root, section)) {
        let text: string;
        try {
          const full = path.join(root, section, rel);
          if (fs.statSync(full).size > MAX_FILE_BYTES) {
            continue;
          }
          text = fs.readFileSync(full, "utf8").replace(/^﻿/, "").trim();
        } catch {
          continue;
        }
        const relPath = `${section}/${rel}`;
        total += text.length;
        const header = `### ${relPath}\n`;
        const room = budget - used - header.length;
        let included = 0;
        let truncated = false;
        if (room > 0) {
          const body = text.length <= room ? text : text.slice(0, room);
          truncated = body.length < text.length;
          included = body.length;
          parts.push(
            `${header}${body}${truncated ? `\n[... truncated: ${text.length - body.length} more characters]` : ""}`,
          );
          used += header.length + body.length;
        } else {
          truncated = text.length > 0;
        }
        files.push({
          section,
          source,
          path: relPath,
          chars: text.length,
          includedChars: included,
          truncated,
        });
      }
    }
  }
  return {
    budget,
    totalChars: total,
    includedChars: files.reduce((n, f) => n + f.includedChars, 0),
    files,
    text: parts.length ? `[Engineering pack]\n${parts.join("\n\n")}` : "",
  };
}

/** Copy a template's starter pack into the project's data area (never into the client folder). */
export function seedStarterPack(
  projectId: string,
  templatePackDir: string,
  home: string = resolveKoloHome(),
): number {
  const target = path.join(projectDataDir(projectId, home), "context");
  let copied = 0;
  for (const section of PACK_SECTIONS) {
    for (const rel of listSection(templatePackDir, section)) {
      const from = path.join(templatePackDir, section, rel);
      const to = path.join(target, section, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
      fs.copyFileSync(from, to);
      copied++;
    }
  }
  return copied;
}

/** At most this many starter files per template, each at most 64 KB of text. */
export const MAX_STARTER_FILES = 10;
const MAX_STARTER_BYTES = 64 * 1024;

/**
 * Copy a template's starter files (`starterFiles`, from `<pack>/starter/<path>`) into the new
 * project's folder: fill-in forms a person keeps, such as knowledge/research-profile.md, and
 * starter data such as quotes/price-list.csv. Only a text file (.md, .txt, .csv, .json), only under one of the template's read-only folders (only people write
 * there), only when nothing exists at that path yet (never replaced), never through a symbolic
 * link. Returns the project-relative paths written.
 */
export function seedStarterFiles(
  project: Pick<Project, "folder" | "rules">,
  templatePackDir: string,
  files: readonly string[],
): string[] {
  const written: string[] = [];
  let root: string;
  try {
    root = fs.realpathSync(project.folder);
  } catch {
    return written;
  }
  for (const rel of files.slice(0, MAX_STARTER_FILES)) {
    if (!STARTER_EXT.test(rel) || rel.split("/").some((s) => !s || s === "." || s === "..")) {
      continue;
    }
    if (!project.rules.readOnly.some((r) => r !== "." && rel.startsWith(`${r}/`))) {
      continue;
    }
    const from = path.join(templatePackDir, "starter", rel);
    let data: Buffer;
    try {
      const st = fs.lstatSync(from);
      if (!st.isFile() || st.size > MAX_STARTER_BYTES) {
        continue;
      }
      data = fs.readFileSync(from);
    } catch {
      continue;
    }
    const to = path.join(root, rel);
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      const inside = path.relative(root, fs.realpathSync(path.dirname(to)));
      if (inside.startsWith("..") || path.isAbsolute(inside)) {
        continue;
      }
      // wx: never over an existing file, nor through a link at the final name.
      fs.writeFileSync(to, data, { flag: "wx", mode: 0o644 });
      written.push(rel);
    } catch {
      // An existing file, or a folder that cannot be written: the person's own copy stays.
    }
  }
  return written;
}
