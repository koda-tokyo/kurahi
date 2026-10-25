// Gather arguments a routine takes from the engine instead of hard-coding them. An argument value
// may be one of two references; every other value is passed to the tool as written.
//
//   { fromKnowledge: "topics", max?: 1–25, optional?: bool, join?: "<sep>", file?: "<path>" }
//       the bullet list under the key `topics` in a knowledge file the routine declares (a
//       heading `## topics` or a line `topics:`, then `- value` lines). Knowledge files live in a
//       read-only folder people maintain (knowledge.ts), so the values are trusted input; they
//       are still bounded (at most `max` values of 200 characters). A list (or, with `join`, one
//       string). An empty list fails the run as `no_input` unless `optional` (then the argument
//       is left out and the tool's default applies).
//   { var: "lastRun", fallbackDays?: 1–365 }
//       the date (YYYY-MM-DD, UTC) the last successful run of this routine started, or
//       `fallbackDays` (default 7) before now when it has none. With an `each` fan-out's seen
//       list this makes a watch routine plan only new work.
//   { var: "today" }  today's date in the routine's time zone.
//
// Validation is strict and happens when the routines file is loaded (fail closed): unknown keys,
// a key that is not a plain name, a `file` the routine does not declare, out-of-range numbers.

import type { KnowledgeFile } from "./knowledge.js";
import type { GatherStep, Routine } from "./types.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

export const KNOWLEDGE_KEY_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const MAX_KNOWLEDGE_VALUES = 25;
const MAX_VALUE_CHARS = 200;
const ENGINE_VARS = ["lastRun", "today"] as const;

export type ArgRef =
  | {
      kind: "knowledge";
      key: string;
      max: number;
      optional: boolean;
      join: string | null;
      file: string | null;
    }
  | { kind: "var"; name: (typeof ENGINE_VARS)[number]; fallbackDays: number };

function intIn(v: unknown, def: number, min: number, max: number, where: string): number {
  if (v === undefined) {
    return def;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${where} must be an integer from ${min} to ${max}`);
  }
  return v;
}

function onlyKeys(o: Obj, keys: string[], where: string): void {
  for (const k of Object.keys(o)) {
    if (!keys.includes(k)) {
      throw new Error(`${where}: unknown key ${k}`);
    }
  }
}

/** The reference an argument value is, null for a literal value. Throws when malformed. */
export function parseArgRef(
  v: unknown,
  where: string,
  knowledge: readonly string[],
): ArgRef | null {
  if (!isObj(v) || !("fromKnowledge" in v || "var" in v)) {
    return null;
  }
  if ("fromKnowledge" in v) {
    onlyKeys(v, ["fromKnowledge", "max", "optional", "join", "file"], where);
    const key = v.fromKnowledge;
    if (typeof key !== "string" || !KNOWLEDGE_KEY_RE.test(key)) {
      throw new Error(`${where}.fromKnowledge must be a key name (lowercase letters, digits, - _)`);
    }
    if (knowledge.length === 0) {
      throw new Error(`${where}: fromKnowledge needs the routine to declare knowledge files`);
    }
    const file = v.file === undefined ? null : v.file;
    if (file !== null && (typeof file !== "string" || !knowledge.includes(file))) {
      throw new Error(`${where}.file must be one of the routine's knowledge files`);
    }
    if (v.optional !== undefined && typeof v.optional !== "boolean") {
      throw new Error(`${where}.optional must be true or false`);
    }
    const join = v.join === undefined ? null : v.join;
    if (join !== null && (typeof join !== "string" || join.length > 8)) {
      throw new Error(`${where}.join must be a separator of at most 8 characters`);
    }
    return {
      kind: "knowledge",
      key,
      max: intIn(v.max, 10, 1, MAX_KNOWLEDGE_VALUES, `${where}.max`),
      optional: v.optional === true,
      join,
      file,
    };
  }
  onlyKeys(v, ["var", "fallbackDays"], where);
  if (!(ENGINE_VARS as readonly unknown[]).includes(v.var)) {
    throw new Error(`${where}.var must be one of ${ENGINE_VARS.join(", ")}`);
  }
  const name = v.var as (typeof ENGINE_VARS)[number];
  if (name === "today" && v.fallbackDays !== undefined) {
    throw new Error(`${where}.fallbackDays applies to lastRun only`);
  }
  return {
    kind: "var",
    name,
    fallbackDays: intIn(v.fallbackDays, 7, 1, 365, `${where}.fallbackDays`),
  };
}

/** Check every argument reference of a step's args (top-level values only). */
export function validateStepArgs(args: Obj, where: string, knowledge: readonly string[]): void {
  for (const [k, v] of Object.entries(args)) {
    parseArgRef(v, `${where}.args.${k}`, knowledge);
  }
}

export function stepUsesKnowledge(step: GatherStep, knowledge: readonly string[]): boolean {
  return Object.values(step.args).some(
    (v) => parseArgRef(v, "args", knowledge)?.kind === "knowledge",
  );
}

export function routineUsesKnowledgeArgs(routine: Pick<Routine, "gather" | "knowledge">): boolean {
  return routine.gather.some((s) => stepUsesKnowledge(s, routine.knowledge));
}

// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;
const KEY_LINE = /^\s*(?:#{1,6}\s*)?([A-Za-z][A-Za-z0-9 _-]{0,40}?)\s*:?\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;

/**
 * The values listed under `key` in a knowledge file, or null when the file does not define the
 * key. A key is a heading (`## Topics`) or a line `topics:`; matching ignores case and treats
 * spaces as `-` / `_`. Its values are the bullet lines that follow, up to the next heading or key.
 */
export function knowledgeValues(text: string, key: string): string[] | null {
  const norm = (s: string) =>
    s
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "-");
  const want = norm(key);
  const lines = text.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/);
  let found = false;
  let inList = false;
  const out: string[] = [];
  for (const raw of lines) {
    const bullet = BULLET.exec(raw);
    if (bullet) {
      if (inList) {
        const v = bullet[1]
          .replace(CONTROL_RE, " ")
          .trim()
          .replace(/^["'`]|["'`]$/g, "")
          .trim()
          .slice(0, MAX_VALUE_CHARS);
        if (v && !out.includes(v)) {
          out.push(v);
        }
      }
      continue;
    }
    const isHeading = /^\s*#{1,6}\s/.test(raw);
    const keyLine = isHeading || /:\s*$/.test(raw) ? KEY_LINE.exec(raw) : null;
    if (keyLine) {
      inList = norm(keyLine[1]) === want;
      found ||= inList;
    } else if (isHeading) {
      inList = false;
    }
  }
  return found ? out : null;
}

export class EmptyKnowledgeArg extends Error {}

export type ArgContext = {
  knowledge: readonly KnowledgeFile[];
  /** When the last successful run of the routine started (ISO), or null. */
  lastSuccessAt: string | null;
  now: Date;
  tz: string;
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** The args the tool receives: references resolved, literals unchanged. */
export function resolveArgs(
  args: Record<string, unknown>,
  ctx: ArgContext,
  declared: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    const ref = parseArgRef(v, `args.${k}`, declared);
    if (!ref) {
      out[k] = v;
      continue;
    }
    if (ref.kind === "var") {
      if (ref.name === "today") {
        out[k] = ctx.now.toLocaleDateString("sv-SE", { timeZone: ctx.tz });
      } else {
        const last = ctx.lastSuccessAt ? new Date(ctx.lastSuccessAt) : null;
        out[k] =
          last && !Number.isNaN(last.getTime())
            ? isoDay(last)
            : isoDay(new Date(ctx.now.getTime() - ref.fallbackDays * 86_400_000));
      }
      continue;
    }
    const files = ref.file ? ctx.knowledge.filter((f) => f.path === ref.file) : ctx.knowledge;
    let values: string[] | null = null;
    let from = ref.file ?? declared.join(", ");
    for (const f of files) {
      values = knowledgeValues(f.text, ref.key);
      if (values) {
        from = f.path;
        break;
      }
    }
    const list = (values ?? []).slice(0, ref.max);
    if (list.length === 0) {
      if (ref.optional) {
        continue;
      }
      throw new EmptyKnowledgeArg(`knowledge key ${ref.key} lists no values (${from})`);
    }
    out[k] = ref.join !== null ? list.join(ref.join) : list;
  }
  return out;
}
