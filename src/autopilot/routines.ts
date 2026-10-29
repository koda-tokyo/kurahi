// Routine definitions per Project: `autopilot.yaml` (or .yml / .json), looked up like the work
// queue policy (first found wins):
//   1. <project folder>/context/autopilot.(yaml|yml|json)    the client's own routines
//   2. <KOLO_HOME>/projects/<id>/autopilot.(yaml|yml|json)    set by an administrator
//   3. templates/projects/packs/<templateId>/autopilot.yaml   the template's starter routines
// Validation is strict and fails closed: one invalid routine makes the whole file invalid and no
// routine of the Project runs until it is fixed (the error is shown in the console).

import { Cron } from "croner";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { Project } from "../projects/types.js";
import type {
  EventSpec,
  EventTrigger,
  GatherStep,
  Routine,
  RoutineSet,
  RoutineTrigger,
  WorkItemTriggerAction,
} from "./types.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { projectDataDir } from "../projects/store.js";
import { resolveTemplatesDir } from "../projects/templates.js";
import { getActionDef } from "./actions.js";
import { validateStepArgs } from "./args.js";
import { REASONING_BACKENDS } from "./reasoner.js";
import { BUILTIN_PROMPTS, isKnownSchema, MAX_INLINE_PROMPT_BYTES } from "./reasoning.js";
import { gatherToolRefusal } from "./tools.js";
import {
  AUTONOMY_LEVELS,
  EDITION_AREAS,
  EVENT_SOURCES,
  isAreaOf,
  isEdition,
  WORKITEM_TRIGGER_ACTIONS,
} from "./types.js";

const MAX_FILE_BYTES = 256 * 1024;
const NAMES = ["autopilot.yaml", "autopilot.yml", "autopilot.json"];
export const ROUTINE_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const STEP_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const ARG_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const AGENT_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_STEPS = 10;
const MAX_ROUTINES = 50;

const ROUTINE_KEYS = new Set([
  "id",
  "edition",
  "area",
  "name",
  "enabled",
  "trigger",
  "agent",
  "gather",
  "reasoning",
  "actions",
  "actionTools",
  "level",
  "limits",
  "requireCitations",
  "metrics",
  "queue",
  "knowledge",
  "outputFolder",
]);

/** At most this many knowledge files per routine (their text is bounded at run time). */
export const MAX_KNOWLEDGE_FILES = 10;
const KNOWLEDGE_PATH_RE =
  /^[A-Za-z0-9_][A-Za-z0-9._ -]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9._ -]{0,63}){0,5}\.(md|txt)$/;

function parseKnowledge(raw: unknown, where: string): string[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_KNOWLEDGE_FILES) {
    throw new Error(`${where}.knowledge must be a list of at most ${MAX_KNOWLEDGE_FILES} paths`);
  }
  const out = new Set<string>();
  for (const p of raw) {
    const v = typeof p === "string" ? p.trim().replace(/\\/g, "/") : "";
    // Relative, no `.`/`..` segments, a .md or .txt file. The read-only folder is checked
    // against the Project's rules when the routine runs (knowledge.ts).
    if (!KNOWLEDGE_PATH_RE.test(v) || v.split("/").some((s) => s === "." || s === "..")) {
      throw new Error(
        `${where}.knowledge: ${String(p)} must be a Project-relative .md or .txt path`,
      );
    }
    out.add(v);
  }
  return [...out];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * A backend the engine can run, refused when the file is loaded instead of at the first run: `api`
 * also needs the model as "<provider>/<model>".
 */
function reasoningBackend(
  backend: string | null,
  model: string | null,
  where: string,
): string | null {
  if (backend === null) {
    return null;
  }
  const id = backend.trim().toLowerCase();
  if (!REASONING_BACKENDS.has(id)) {
    throw new Error(
      `${where}.backend: unknown reasoning backend "${backend}" (one of ${[...REASONING_BACKENDS].join(", ")})`,
    );
  }
  if (id === "api" && !/^[^/\s]+\/\S+$/.test(model ?? "")) {
    throw new Error(`${where}.model: the api backend needs a model "<provider>/<model>"`);
  }
  return backend;
}

function strictKeys(o: Obj, allowed: Set<string> | string[], where: string): void {
  const set = allowed instanceof Set ? allowed : new Set(allowed);
  for (const k of Object.keys(o)) {
    if (!set.has(k)) {
      throw new Error(`${where}: unknown key ${k}`);
    }
  }
}

function int(v: unknown, def: number, min: number, max: number, where: string): number {
  if (v === undefined) {
    return def;
  }
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new Error(`${where} must be an integer from ${min} to ${max}`);
  }
  return v;
}

function validTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** At most this many event sources per routine. */
export const MAX_EVENT_SOURCES = 8;
/** Graph mail folder: a well-known name (inbox, archive …) or an opaque folder id. */
const MAIL_FOLDER_RE = /^[A-Za-z0-9=_+/-]{1,512}$/;
/** A Project-relative folder (`.` = the whole Project folder). */
const FOLDER_RE =
  /^(\.|[A-Za-z0-9_][A-Za-z0-9._ -]{0,63}(\/[A-Za-z0-9_][A-Za-z0-9._ -]{0,63}){0,7})$/;

export function normalizeFolder(raw: unknown): string | null {
  const v = typeof raw === "string" ? raw.trim().replace(/\\/g, "/").replace(/\/+$/, "") : "";
  if (!FOLDER_RE.test(v) || (v !== "." && v.split("/").some((s) => s === "." || s === ".."))) {
    return null;
  }
  return v;
}

function parseEventSource(raw: unknown, w: string): EventSpec {
  if (!isObj(raw)) {
    throw new Error(`${w} must be an object`);
  }
  switch (raw.source) {
    case "m365.mail": {
      strictKeys(raw, ["source", "folder"], w);
      const folder = raw.folder === undefined ? "inbox" : raw.folder;
      if (typeof folder !== "string" || !MAIL_FOLDER_RE.test(folder) || folder.includes("..")) {
        throw new Error(`${w}.folder must be a mail folder name or id`);
      }
      return { source: "m365.mail", folder };
    }
    case "workitems": {
      strictKeys(raw, ["source", "queue", "actions"], w);
      if (
        raw.queue !== undefined &&
        (typeof raw.queue !== "string" || !ROUTINE_ID_RE.test(raw.queue))
      ) {
        throw new Error(`${w}.queue must be a work queue id`);
      }
      const actions = raw.actions === undefined ? [...WORKITEM_TRIGGER_ACTIONS] : raw.actions;
      if (
        !Array.isArray(actions) ||
        actions.length === 0 ||
        actions.some((a) => !(WORKITEM_TRIGGER_ACTIONS as readonly unknown[]).includes(a))
      ) {
        throw new Error(`${w}.actions must list ${WORKITEM_TRIGGER_ACTIONS.join(", ")}`);
      }
      return {
        source: "workitems",
        queue: typeof raw.queue === "string" ? raw.queue : null,
        actions: [...new Set(actions as WorkItemTriggerAction[])],
      };
    }
    case "deadline": {
      strictKeys(raw, ["source", "withinHours"], w);
      if (raw.withinHours === undefined) {
        throw new Error(`${w}.withinHours is required`);
      }
      return {
        source: "deadline",
        withinHours: int(raw.withinHours, 0, 1, 168, `${w}.withinHours`),
      };
    }
    case "files": {
      strictKeys(raw, ["source", "folder"], w);
      const folder = normalizeFolder(raw.folder);
      if (!folder) {
        throw new Error(`${w}.folder must be a Project-relative folder`);
      }
      return { source: "files", folder };
    }
    default:
      throw new Error(`${w}.source must be one of ${EVENT_SOURCES.join(", ")}`);
  }
}

function parseEvents(raw: Obj, where: string): EventTrigger | undefined {
  const w = `${where}.trigger`;
  if (raw.event === undefined) {
    if (raw.debounceSeconds !== undefined || raw.maxRunsPerHour !== undefined) {
      throw new Error(`${w}: debounceSeconds and maxRunsPerHour need an event list`);
    }
    return undefined;
  }
  if (!Array.isArray(raw.event) || raw.event.length === 0 || raw.event.length > MAX_EVENT_SOURCES) {
    throw new Error(`${w}.event must be a list of 1 to ${MAX_EVENT_SOURCES} sources`);
  }
  const seen = new Set<string>();
  const sources: EventSpec[] = [];
  raw.event.forEach((e, i) => {
    const spec = parseEventSource(e, `${w}.event[${i}]`);
    const key = JSON.stringify(spec);
    if (!seen.has(key)) {
      seen.add(key);
      sources.push(spec);
    }
  });
  return {
    sources,
    debounceSeconds: int(raw.debounceSeconds, 30, 5, 600, `${w}.debounceSeconds`),
    maxRunsPerHour: int(raw.maxRunsPerHour, 12, 1, 60, `${w}.maxRunsPerHour`),
  };
}

function parseTrigger(raw: unknown, where: string, defaultTz: string): RoutineTrigger {
  if (!isObj(raw)) {
    throw new Error(`${where}.trigger is required`);
  }
  strictKeys(
    raw,
    ["schedule", "tz", "interval", "event", "debounceSeconds", "maxRunsPerHour"],
    `${where}.trigger`,
  );
  const events = parseEvents(raw, where);
  const time = parseTimeTrigger(raw, where, defaultTz, events !== undefined);
  return events ? { ...time, events } : time;
}

function parseTimeTrigger(
  raw: Obj,
  where: string,
  defaultTz: string,
  hasEvents: boolean,
): RoutineTrigger {
  if (raw.schedule !== undefined && raw.interval !== undefined) {
    throw new Error(`${where}.trigger: schedule or interval, not both`);
  }
  if (raw.schedule === undefined && raw.interval === undefined && hasEvents) {
    const tz = typeof raw.tz === "string" ? raw.tz : defaultTz;
    if (!validTz(tz)) {
      throw new Error(`${where}.trigger: unknown timezone ${tz}`);
    }
    return { kind: "event", tz };
  }
  if (typeof raw.schedule === "string") {
    const expr = raw.schedule.trim();
    const tz = typeof raw.tz === "string" ? raw.tz : defaultTz;
    if (!validTz(tz)) {
      throw new Error(`${where}.trigger: unknown timezone ${tz}`);
    }
    try {
      new Cron(expr, { timezone: tz, catch: false, paused: true }).stop();
    } catch {
      throw new Error(`${where}.trigger: invalid cron expression ${expr}`);
    }
    if (expr.split(/\s+/).length !== 5) {
      throw new Error(`${where}.trigger: schedule needs the five cron fields`);
    }
    return { kind: "schedule", expr, tz };
  }
  if (raw.interval !== undefined) {
    return {
      kind: "interval",
      minutes: int(raw.interval, 0, 5, 10_080, `${where}.trigger.interval`),
    };
  }
  throw new Error(
    `${where}.trigger: schedule (cron), interval (minutes) or event (sources) is required`,
  );
}

function parseGather(raw: unknown, where: string, knowledge: readonly string[]): GatherStep[] {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw) || raw.length > MAX_STEPS) {
    throw new Error(`${where}.gather must be a list of at most ${MAX_STEPS} steps`);
  }
  const ids = new Set<string>();
  return raw.map((s, i) => {
    const w = `${where}.gather[${i}]`;
    if (!isObj(s)) {
      throw new Error(`${w} must be an object`);
    }
    strictKeys(s, ["id", "tool", "args", "each", "gate"], w);
    if (s.gate !== undefined && typeof s.gate !== "boolean") {
      throw new Error(`${w}.gate must be true or false`);
    }
    if (s.gate === true && s.each !== undefined) {
      throw new Error(`${w}: a gate step cannot fan out (each)`);
    }
    const id = typeof s.id === "string" ? s.id : `s${i + 1}`;
    if (!STEP_ID_RE.test(id) || ids.has(id)) {
      throw new Error(`${w}: id must be unique (lowercase letters, digits, _)`);
    }
    const tool = typeof s.tool === "string" ? s.tool : "";
    const refusal = gatherToolRefusal(tool);
    if (refusal) {
      throw new Error(`${w}: ${refusal}`);
    }
    if (s.args !== undefined && !isObj(s.args)) {
      throw new Error(`${w}.args must be an object`);
    }
    // Argument references (fromKnowledge, engine variables): checked now, resolved per run.
    validateStepArgs(s.args ?? {}, w, knowledge);
    let each: GatherStep["each"];
    if (s.each !== undefined) {
      if (!isObj(s.each)) {
        throw new Error(`${w}.each must be an object`);
      }
      strictKeys(s.each, ["from", "match", "arg", "max"], `${w}.each`);
      const from = typeof s.each.from === "string" ? s.each.from : "";
      if (!ids.has(from)) {
        throw new Error(`${w}.each.from must name an earlier step`);
      }
      const match = typeof s.each.match === "string" ? s.each.match : "";
      let re: RegExp;
      try {
        re = new RegExp(match);
      } catch {
        throw new Error(`${w}.each.match is not a valid regular expression`);
      }
      if (!match || match.length > 200 || !/\((?!\?)/.test(re.source)) {
        throw new Error(`${w}.each.match needs one capturing group (≤ 200 chars)`);
      }
      const arg = typeof s.each.arg === "string" ? s.each.arg : "";
      if (!ARG_RE.test(arg)) {
        throw new Error(`${w}.each.arg must be an argument name`);
      }
      each = { from, match, arg, max: int(s.each.max, 10, 1, 50, `${w}.each.max`) };
    }
    ids.add(id);
    return {
      id,
      tool,
      args: s.args ?? {},
      ...(each ? { each } : {}),
      ...(s.gate === true ? { gate: true } : {}),
    };
  });
}

function parseRoutine(raw: unknown, i: number, defaults: Obj): Routine {
  if (!isObj(raw)) {
    throw new Error(`routine ${i + 1} must be an object`);
  }
  const id = typeof raw.id === "string" && ROUTINE_ID_RE.test(raw.id) ? raw.id : null;
  if (!id) {
    throw new Error(`routine ${i + 1}: id is required (lowercase letters, digits, -)`);
  }
  const where = `routine ${id}`;
  strictKeys(raw, ROUTINE_KEYS, where);
  if (!isEdition(raw.edition)) {
    throw new Error(`${where}: edition must be one of industrial, business, scholars, core`);
  }
  const edition = raw.edition;
  if (!isAreaOf(edition, raw.area)) {
    throw new Error(
      `${where}: area must be one of ${EDITION_AREAS[edition].join(", ")} for ${edition}`,
    );
  }
  const area = raw.area as string;
  const level = raw.level ?? "L1";
  if (!(AUTONOMY_LEVELS as readonly unknown[]).includes(level)) {
    throw new Error(`${where}: level must be L0, L1, L2 or L3`);
  }
  const actions = raw.actions === undefined ? [] : raw.actions;
  if (!Array.isArray(actions) || actions.some((a) => typeof a !== "string")) {
    throw new Error(`${where}: actions must be a list of action ids`);
  }
  for (const a of actions as string[]) {
    const def = getActionDef(a);
    if (!def) {
      throw new Error(`${where}: unknown action ${a}`);
    }
    if (!def.editions.includes(edition)) {
      throw new Error(`${where}: ${a} is not available in the ${edition} edition`);
    }
    if (def.class === "never") {
      throw new Error(`${where}: ${a} is never autonomous and cannot be listed`);
    }
  }
  if (level === "L0" && actions.length > 0) {
    throw new Error(`${where}: an L0 routine observes only; it lists no actions`);
  }
  const actionTools: Record<string, string> = {};
  if (raw.actionTools !== undefined) {
    if (!isObj(raw.actionTools)) {
      throw new Error(`${where}: actionTools must be an object`);
    }
    for (const [a, t] of Object.entries(raw.actionTools)) {
      const def = getActionDef(a);
      if (!def || !(actions as string[]).includes(a)) {
        throw new Error(`${where}: actionTools.${a} names an action the routine does not list`);
      }
      if (typeof t !== "string" || !def.tools.includes(t)) {
        throw new Error(`${where}: actionTools.${a} must be one of ${def.tools.join(", ")}`);
      }
      actionTools[a] = t;
    }
  }
  const r = isObj(raw.reasoning) ? raw.reasoning : null;
  if (!r) {
    throw new Error(`${where}: reasoning is required`);
  }
  strictKeys(
    r,
    ["prompt", "promptText", "schema", "backend", "model", "timeoutSeconds"],
    `${where}.reasoning`,
  );
  let promptId: string | null = null;
  let prompt = "";
  if (typeof r.promptText === "string") {
    if (r.prompt !== undefined) {
      throw new Error(`${where}.reasoning: prompt or promptText, not both`);
    }
    if (!r.promptText.trim() || Buffer.byteLength(r.promptText, "utf8") > MAX_INLINE_PROMPT_BYTES) {
      throw new Error(`${where}.reasoning.promptText must be 1 byte to 8 KB`);
    }
    prompt = r.promptText.trim();
  } else if (typeof r.prompt === "string" && r.prompt in BUILTIN_PROMPTS) {
    promptId = r.prompt;
    prompt = BUILTIN_PROMPTS[r.prompt];
  } else {
    throw new Error(
      `${where}.reasoning.prompt must be one of ${Object.keys(BUILTIN_PROMPTS).join(", ")} (or use promptText)`,
    );
  }
  const schemaId = typeof r.schema === "string" ? r.schema : "autopilot.plan.v1";
  if (!isKnownSchema(schemaId)) {
    throw new Error(`${where}.reasoning: unknown output schema ${schemaId}`);
  }
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const limits = isObj(raw.limits) ? raw.limits : {};
  strictKeys(limits, ["maxItemsPerRun", "maxActionsPerDay"], `${where}.limits`);
  const metrics = isObj(raw.metrics) ? raw.metrics : {};
  strictKeys(metrics, ["baselineMinutes"], `${where}.metrics`);
  let baselineMinutes: number | null = null;
  if (metrics.baselineMinutes !== undefined) {
    const b = metrics.baselineMinutes;
    if (typeof b !== "number" || !(b > 0) || b > 1440) {
      throw new Error(`${where}.metrics.baselineMinutes must be a number above 0 and up to 1440`);
    }
    baselineMinutes = b;
  }
  const agent = raw.agent === undefined ? null : raw.agent;
  if (agent !== null && (typeof agent !== "string" || !AGENT_RE.test(agent))) {
    throw new Error(`${where}: agent must be an agent id`);
  }
  if (
    raw.queue !== undefined &&
    (typeof raw.queue !== "string" || !ROUTINE_ID_RE.test(raw.queue))
  ) {
    throw new Error(`${where}: queue must be a work queue id`);
  }
  const knowledge = parseKnowledge(raw.knowledge, where);
  let outputFolder: string | null = null;
  if (raw.outputFolder !== undefined) {
    outputFolder = normalizeFolder(raw.outputFolder);
    if (!outputFolder || outputFolder === "." || under(outputFolder, ROUTINE_OUTPUT_DIR)) {
      throw new Error(
        `${where}.outputFolder must be a Project-relative folder (not the Project root or ${ROUTINE_OUTPUT_DIR})`,
      );
    }
  }
  const name = isObj(raw.name)
    ? {
        ...(typeof raw.name.ja === "string" ? { ja: raw.name.ja.slice(0, 120) } : {}),
        ...(typeof raw.name.en === "string" ? { en: raw.name.en.slice(0, 120) } : {}),
      }
    : { en: typeof raw.name === "string" ? raw.name.slice(0, 120) : id };
  return {
    id,
    edition,
    area,
    name,
    enabled: raw.enabled !== false,
    trigger: parseTrigger(
      raw.trigger,
      where,
      typeof defaults.timezone === "string" ? defaults.timezone : "Asia/Tokyo",
    ),
    agentId: agent,
    gather: parseGather(raw.gather, where, knowledge),
    reasoning: {
      promptId,
      prompt,
      schemaId,
      backend: reasoningBackend(
        str(r.backend) ?? str((defaults.reasoner as Obj | undefined)?.backend),
        str(r.model) ?? str((defaults.reasoner as Obj | undefined)?.model),
        `${where}.reasoning`,
      ),
      model: str(r.model) ?? str((defaults.reasoner as Obj | undefined)?.model),
      timeoutSeconds: int(r.timeoutSeconds, 300, 30, 900, `${where}.reasoning.timeoutSeconds`),
    },
    actions: [...new Set(actions as string[])],
    actionTools,
    level: level as Routine["level"],
    limits: {
      maxItemsPerRun: int(limits.maxItemsPerRun, 10, 1, 100, `${where}.limits.maxItemsPerRun`),
      maxActionsPerDay: int(
        limits.maxActionsPerDay,
        200,
        1,
        10_000,
        `${where}.limits.maxActionsPerDay`,
      ),
    },
    requireCitations:
      raw.requireCitations === undefined ? edition === "scholars" : raw.requireCitations === true,
    baselineMinutes,
    queue: typeof raw.queue === "string" ? raw.queue : null,
    knowledge,
    outputFolder,
  };
}

/** Parse a routines file. Throws on the first problem (callers fail closed). */
export function parseRoutines(text: string): Routine[] {
  const doc = YAML.parse(text) as unknown;
  if (!isObj(doc)) {
    throw new Error("autopilot file must be a YAML or JSON object");
  }
  strictKeys(doc, ["version", "timezone", "reasoner", "routines"], "autopilot file");
  if (doc.version !== undefined && doc.version !== 1) {
    throw new Error("autopilot file: version must be 1");
  }
  if (doc.timezone !== undefined && (typeof doc.timezone !== "string" || !validTz(doc.timezone))) {
    throw new Error("autopilot file: unknown timezone");
  }
  if (doc.reasoner !== undefined) {
    if (!isObj(doc.reasoner)) {
      throw new Error("autopilot file: reasoner must be an object");
    }
    strictKeys(doc.reasoner, ["backend", "model"], "reasoner");
  }
  const list = doc.routines ?? [];
  if (!Array.isArray(list) || list.length > MAX_ROUTINES) {
    throw new Error(`autopilot file: routines must be a list of at most ${MAX_ROUTINES}`);
  }
  const routines = list.map((r, i) => parseRoutine(r, i, doc));
  const seen = new Set<string>();
  for (const r of routines) {
    if (seen.has(r.id)) {
      throw new Error(`routine ${r.id} is defined twice`);
    }
    seen.add(r.id);
  }
  return routines;
}

function digestOf(t: string): string {
  return createHash("sha256").update(t, "utf8").digest("hex");
}

export function routineCandidates(
  project: Pick<Project, "id" | "folder" | "templateId">,
  home: string = resolveKoloHome(),
): Array<{ kind: "project" | "admin" | "template"; path: string }> {
  const out: Array<{ kind: "project" | "admin" | "template"; path: string }> = [];
  for (const n of NAMES) {
    out.push({ kind: "project", path: path.join(project.folder, "context", n) });
  }
  for (const n of NAMES) {
    out.push({ kind: "admin", path: path.join(projectDataDir(project.id, home), n) });
  }
  if (project.templateId && /^[a-z][a-z0-9-]{1,63}$/.test(project.templateId)) {
    for (const n of NAMES) {
      out.push({
        kind: "template",
        path: path.join(resolveTemplatesDir(), "packs", project.templateId, n),
      });
    }
  }
  return out;
}

/** Where the engine writes a routine's documents (act.ts); never a files trigger folder. */
export const ROUTINE_OUTPUT_DIR = "output/autopilot";

function under(rel: string, folder: string): boolean {
  return folder === "." || rel === folder || rel.startsWith(`${folder}/`);
}

/** A files trigger watches a read-only or writable folder of the Project, never the output. */
export function filesFolderError(
  rules: Pick<Project["rules"], "readOnly" | "writable">,
  folder: string,
): string | null {
  if (under(folder, ROUTINE_OUTPUT_DIR)) {
    return `${folder} is the routines' own output folder`;
  }
  const allowed = [...rules.readOnly, ...rules.writable];
  if (!allowed.some((r) => under(folder, normalizeFolder(r) ?? "\0"))) {
    return `${folder} is not a read-only or writable folder of the Project (${allowed.join(", ") || "none"})`;
  }
  return null;
}

function checkFilesTriggers(routines: Routine[], rules: Project["rules"]): void {
  const outputs = routines
    .map((r) => r.outputFolder)
    .filter((f): f is string => typeof f === "string");
  for (const r of routines) {
    if (
      r.outputFolder &&
      !rules.writable.some((w) => under(r.outputFolder!, normalizeFolder(w) ?? "\0"))
    ) {
      throw new Error(
        `routine ${r.id}.outputFolder: ${r.outputFolder} is not under a writable folder of the Project (${rules.writable.join(", ") || "none"})`,
      );
    }
    for (const e of r.trigger.events?.sources ?? []) {
      const problem = e.source === "files" ? filesFolderError(rules, e.folder) : null;
      if (problem) {
        throw new Error(`routine ${r.id}.trigger.event files: ${problem}`);
      }
      // A routine's documents never trigger a routine (they would loop).
      const folder = e.source === "files" ? e.folder : null;
      const out =
        folder !== null ? outputs.find((o) => under(folder, o) || under(o, folder)) : undefined;
      if (out) {
        throw new Error(
          `routine ${r.id}.trigger.event files: ${folder} overlaps the routines' output folder ${out}`,
        );
      }
    }
  }
}

export function loadRoutines(
  project: Pick<Project, "id" | "folder" | "templateId"> & { rules?: Project["rules"] },
  home?: string,
): RoutineSet {
  for (const c of routineCandidates(project, home)) {
    let raw: string;
    try {
      const st = fs.statSync(c.path);
      if (!st.isFile()) {
        continue;
      }
      if (st.size > MAX_FILE_BYTES) {
        return {
          routines: [],
          source: c,
          digest: digestOf(""),
          error: "file is larger than 256 KB",
        };
      }
      raw = fs.readFileSync(c.path, "utf8");
    } catch {
      continue;
    }
    try {
      const routines = parseRoutines(raw);
      if (project.rules) {
        checkFilesTriggers(routines, project.rules);
      }
      return { routines, source: c, digest: digestOf(raw), error: null };
    } catch (err) {
      return {
        routines: [],
        source: c,
        digest: digestOf(raw),
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
  return { routines: [], source: { kind: "none", path: null }, digest: digestOf(""), error: null };
}
