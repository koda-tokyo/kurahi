// Project root guard for the kurahi-legacy MCP server. The server serves ONE project root, fixed
// at launch; every path a tool receives is resolved against it and refused when it leaves it,
// lexically (`../`, an absolute path elsewhere) or through a symbolic link (checked on the real
// path), or when it names a folder the analyser never reads (`_answer-keys`, the Kurahi folder).

import fs from "node:fs";
import path from "node:path";
import { SKIPPED_DIRS } from "../../../packages/legacy-analyzer/src/index.js";

/** The project's own Kurahi folder (cache and audit log live under it). */
export const KURAHI_DIR_NAME = ".kurahi";

export class PathRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathRefusedError";
  }
}

export type ProjectRoot = {
  /** Real (symlink-free) absolute path of the project root. */
  readonly abs: string;
  /** Resolve a tool path argument inside the root; throws PathRefusedError otherwise. */
  resolve(input: string | undefined): { abs: string; rel: string };
  /** Root-relative, forward-slash form of an absolute path inside the root. */
  relative(abs: string): string;
};

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const toPosix = (p: string) => p.split(path.sep).join("/");

export function openProjectRoot(input: string): ProjectRoot {
  if (!input || !input.trim()) {
    throw new Error("--root is required: the project folder to serve.");
  }
  let abs: string;
  try {
    abs = fs.realpathSync(path.resolve(input));
  } catch {
    throw new Error(`Project root not found: ${input}`);
  }
  if (!fs.statSync(abs).isDirectory()) {
    throw new Error(`Project root is not a folder: ${input}`);
  }
  if (abs === path.parse(abs).root) {
    throw new Error("Refusing to serve a file-system root; pass the project folder.");
  }

  const relative = (p: string) => toPosix(path.relative(abs, p)) || ".";

  const resolve = (raw: string | undefined) => {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text || text === ".") {
      return { abs, rel: "." };
    }
    if (text.includes("\0")) {
      throw new PathRefusedError("Refused: the path contains a NUL byte.");
    }
    const lexical = path.resolve(abs, text);
    if (!isInside(abs, lexical)) {
      throw new PathRefusedError(`Refused: ${text} is outside the project root.`);
    }
    let real: string;
    try {
      real = fs.realpathSync(lexical);
    } catch {
      throw new PathRefusedError(`Refused: ${text} does not exist in the project.`);
    }
    if (!isInside(abs, real)) {
      throw new PathRefusedError(
        `Refused: ${text} leads outside the project root through a symbolic link.`,
      );
    }
    const rel = relative(real);
    const segments = rel.split("/");
    if (segments.some((s) => SKIPPED_DIRS.has(s) || s === KURAHI_DIR_NAME)) {
      throw new PathRefusedError(`Refused: ${text} is in a folder excluded from analysis.`);
    }
    return { abs: real, rel };
  };

  return { abs, resolve, relative };
}
