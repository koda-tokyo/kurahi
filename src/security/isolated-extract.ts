// Text extraction of an accepted attachment in a separate, bounded child process: a fresh Node
// process (extract-child.ts) with a small V8 heap (`--max-old-space-size`), an empty
// environment, no stdin beyond the one request, capped stdout and a wall clock after which it
// is SIGKILLed. The document parsers (zip, XML, PDF) therefore never run in the gateway
// process: a parser bug, a decompression bomb the static policy missed or a hostile PDF can only
// exhaust or crash the child. The child code makes no network calls and writes no files.

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { DocumentKind } from "../projects/documents.js";
import { runBounded, type BoundedExec } from "./bounded-exec.js";

export type IsolatedExtractOptions = {
  timeoutMs?: number;
  maxOldSpaceMb?: number;
  exec?: BoundedExec;
  /** Tests: a different child entry (a .mjs/.js file run with plain node). */
  childScript?: string;
};

export type IsolatedExtractResult =
  | { ok: true; text: string; ms: number }
  | {
      ok: false;
      code: "timeout" | "crashed" | "failed" | "unavailable";
      error: string;
      ms: number;
    };

export const EXTRACT_TIMEOUT_MS = 30_000;
export const EXTRACT_MAX_OLD_SPACE_MB = 256;
const EXTRACTABLE = new Set<DocumentKind>(["pdf", "xlsx", "docx", "pptx", "csv", "txt", "md"]);

/** The node argv that runs the child entry: built JS, or the TS source through tsx (dev). */
function childArgv(script: string | undefined): string[] | null {
  if (script) {
    return [script];
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const js = path.join(here, "extract-child.js");
  if (fs.existsSync(js)) {
    return [js];
  }
  const ts = path.join(here, "extract-child.ts");
  if (!fs.existsSync(ts)) {
    return null;
  }
  try {
    const loader = createRequire(import.meta.url).resolve("tsx");
    return ["--import", pathToFileURL(loader).href, ts];
  } catch {
    return null;
  }
}

export async function extractTextIsolated(
  kind: DocumentKind,
  file: string,
  opts: IsolatedExtractOptions = {},
): Promise<IsolatedExtractResult> {
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  if (!EXTRACTABLE.has(kind)) {
    return { ok: true, text: "", ms: 0 };
  }
  const entry = childArgv(opts.childScript);
  if (!entry) {
    return { ok: false, code: "unavailable", error: "the extraction child is missing", ms: ms() };
  }
  const heap = Math.min(Math.max(opts.maxOldSpaceMb ?? EXTRACT_MAX_OLD_SPACE_MB, 32), 2048);
  const exec = opts.exec ?? runBounded;
  const r = await exec(
    [process.execPath, `--max-old-space-size=${heap}`, "--no-warnings", ...entry],
    {
      timeoutMs: opts.timeoutMs ?? EXTRACT_TIMEOUT_MS,
      // Nothing from the gateway's environment (no tokens, no proxies, no NODE_OPTIONS).
      env: {},
      cwd: path.dirname(file),
      input: JSON.stringify({ kind, file }),
      maxOutputBytes: 4 * 1024 * 1024,
    },
  );
  if (r.timedOut) {
    return { ok: false, code: "timeout", error: "text extraction timed out", ms: ms() };
  }
  const line = r.stdout.trim().split("\n").pop() ?? "";
  type ChildReply = { ok?: boolean; text?: unknown; error?: unknown };
  let parsed: ChildReply | null;
  try {
    parsed = JSON.parse(line) as ChildReply;
  } catch {
    parsed = null;
  }
  if (r.code === 0 && !r.truncated && parsed?.ok === true && typeof parsed.text === "string") {
    return { ok: true, text: parsed.text, ms: ms() };
  }
  if (parsed?.ok === false) {
    return {
      ok: false,
      code: "failed",
      error: (typeof parsed.error === "string" ? parsed.error : "extraction failed").slice(0, 200),
      ms: ms(),
    };
  }
  return {
    ok: false,
    code: "crashed",
    error: `the extraction process ended (${r.code ?? r.signal ?? "?"})${r.truncated ? ", output over the cap" : ""}`,
    ms: ms(),
  };
}
