// Child process entry for isolated text extraction (isolated-extract.ts). It reads one request
// ({ kind, file }) from stdin, extracts the text of that one accepted document with the Project
// document extractors and writes one JSON line to stdout. It makes no network calls, writes no
// files and spawns nothing; the parent bounds its heap, wall clock and output, and kills it on
// timeout. A parser bug or a hostile document can only crash or stall this process.

import fs from "node:fs";
import { type DocumentKind, extractText } from "../projects/documents.js";

const KINDS = new Set(["pdf", "xlsx", "docx", "pptx", "csv", "txt", "md"]);

async function main(): Promise<void> {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += String(chunk);
    if (raw.length > 8192) {
      throw new Error("request too large");
    }
  }
  const req = JSON.parse(raw) as { kind?: unknown; file?: unknown };
  if (typeof req.kind !== "string" || !KINDS.has(req.kind) || typeof req.file !== "string") {
    throw new Error("invalid request");
  }
  const buf = fs.readFileSync(req.file);
  const text = await extractText(req.kind as DocumentKind, buf);
  process.stdout.write(`${JSON.stringify({ ok: true, text })}\n`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    process.stdout.write(
      `${JSON.stringify({ ok: false, error: String(err instanceof Error ? err.message : err).slice(0, 200) })}\n`,
    );
    process.exit(1);
  },
);
