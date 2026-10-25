// office.create: the typed document spec a routine's model proposes, per kind (docx / pptx /
// xlsx). Three layers, all fail-closed:
//   1. the plan schema (reasoning.ts) types the spec per kind (shape, sizes, no unknown keys);
//   2. before executing, the engine validates the spec with the OFFICE PLUGIN's own parsers,
//      which the plugin registers here when it loads (extensions/office/index.ts); no parser for
//      the kind → the action fails (the plugin is not enabled for the Project);
//   3. the engine executes through the plugin's own tool (office_<kind>_create) in the routine's
//      project session, so the tool's guards apply unchanged (Project in 実行 Act mode, a writable
//      folder, no symlinks, no protected files) and the tool parses the spec once more.
//
// The registry is on globalThis (registered symbol): the plugin is loaded through jiti and may
// see its own copy of this module.

export const OFFICE_KINDS = ["docx", "pptx", "xlsx"] as const;
export type OfficeKind = (typeof OFFICE_KINDS)[number];

/** The plugin tool that renders each kind. */
export const OFFICE_TOOL_OF: Record<OfficeKind, string> = {
  docx: "office_docx_create",
  pptx: "office_pptx_create",
  xlsx: "office_xlsx_create",
};

/** The plugin that must answer for those tools (a look-alike tool from another plugin is refused). */
export const OFFICE_PLUGIN_ID = "office";

/** A file name the engine writes under output/ (ASCII, the kind's extension, no folders). */
export const OFFICE_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(docx|pptx|xlsx)$/;

export type OfficeSpecParser = (spec: Record<string, unknown>) => unknown;

const KEY = Symbol.for("kurahi.autopilot.officeSpecParsers");

function parsers(): Map<OfficeKind, OfficeSpecParser> {
  const g = globalThis as { [KEY]?: Map<OfficeKind, OfficeSpecParser> };
  g[KEY] ??= new Map();
  return g[KEY];
}

export function isOfficeKind(v: unknown): v is OfficeKind {
  return typeof v === "string" && (OFFICE_KINDS as readonly string[]).includes(v);
}

/** The office plugin registers its spec parser per kind (idempotent; last load wins). */
export function registerOfficeSpecParser(kind: OfficeKind, parse: OfficeSpecParser): void {
  parsers().set(kind, parse);
}

export function hasOfficeSpecParser(kind: OfficeKind): boolean {
  return parsers().has(kind);
}

/** Tests: forget the registered parsers. */
export function resetOfficeSpecParsersForTests(): void {
  parsers().clear();
}

/** Kind, output file name and spec shape (no parser): the authorize-time check. */
export function officeArgsError(args: Record<string, unknown>): string | null {
  const kind = args.kind;
  if (!isOfficeKind(kind)) {
    return `kind must be one of ${OFFICE_KINDS.join(", ")}`;
  }
  const file = typeof args.file === "string" ? args.file : "";
  if (!OFFICE_FILE_RE.test(file) || !file.toLowerCase().endsWith(`.${kind}`)) {
    return `file must be an ASCII file name ending in .${kind} (no folders)`;
  }
  const spec = args.spec;
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    return "spec must be an object";
  }
  return null;
}

/**
 * Validate one office.create proposal fully: kind, output file name, and the spec with the
 * plugin's parser. Returns an error message, or null when the spec is valid.
 */
export function officeSpecError(args: Record<string, unknown>): string | null {
  const shape = officeArgsError(args);
  if (shape) {
    return shape;
  }
  const kind = args.kind as OfficeKind;
  const spec = args.spec;
  const parse = parsers().get(kind);
  if (!parse) {
    return `the office plugin is not enabled here (no ${kind} renderer)`;
  }
  try {
    parse(spec as Record<string, unknown>);
    return null;
  } catch (err) {
    return `spec: ${String(err instanceof Error ? err.message : err).slice(0, 200)}`;
  }
}
