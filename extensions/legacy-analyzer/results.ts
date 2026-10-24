// Result helpers of the legacy-analyzer plugin tools: JSON text capped at MAX_TEXT, errors, and
// Markdown documents with a short header (the full document is saved by the analyser).

export const MAX_TEXT = 60_000;

export function result(value: unknown) {
  let text = JSON.stringify(value, null, 1);
  const truncated = text.length > MAX_TEXT;
  if (truncated) {
    text = `${text.slice(0, MAX_TEXT)}\n... (truncated at ${MAX_TEXT} characters; narrow the request, e.g. one program)`;
  }
  return { content: [{ type: "text" as const, text }], details: { ok: true, truncated } };
}

export function failure(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `Legacy analyser error: ${message}` }],
    details: { ok: false, error: message },
  };
}

/** A Markdown document with a short header; the document is cut at MAX_TEXT (the full one is saved). */
export function markdownResult(header: string[], markdown: string, savedTo: string) {
  const truncated = markdown.length > MAX_TEXT;
  const body = truncated
    ? `${markdown.slice(0, MAX_TEXT)}\n... (truncated at ${MAX_TEXT} characters; the full document is saved at ${savedTo}, or narrow the request with section or program)`
    : markdown;
  return {
    content: [{ type: "text" as const, text: `${header.join("\n")}\n\n${body}` }],
    details: { ok: true, truncated, savedTo },
  };
}

export const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
