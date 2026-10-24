// Replay stepper (KoLo 2.0, M12c): walk an evidence log one event at a time and show the state
// of the job at each step. Pure: the same events and step give the same state in the CLI, the
// TUI and the web view.
import type { EvidenceEvent, EvidenceUsage } from "./types.js";
import { pathsOfToolCall } from "./summary.js";

export type ReplayState = {
  /** 1-based step; 0 means "before the first event". */
  step: number;
  total: number;
  event: EvidenceEvent | null;
  /** Milliseconds since the job started, at this event. */
  elapsedMs: number | null;
  status: string;
  modelTurns: number;
  toolCalls: number;
  toolErrors: number;
  /** Tool calls started but not finished at this step. */
  openTools: Array<{ toolCallId: string; name: string }>;
  filesTouched: string[];
  usage: EvidenceUsage;
  permissions: { allowed: number; denied: number };
  loopStops: number;
  auditSeqs: number[];
  /** Redacted excerpt of the latest assistant text, when any. */
  lastText: string | null;
  truncated: boolean;
};

function addUsage(total: EvidenceUsage, usage: unknown): void {
  if (!usage || typeof usage !== "object") {
    return;
  }
  const u = usage as Record<string, unknown>;
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
    const v = u[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      total[key] = (total[key] ?? 0) + v;
    }
  }
}

/** The job's state after the first `step` events have been applied. */
export function stateAt(events: EvidenceEvent[], step: number): ReplayState {
  const total = events.length;
  const n = Math.max(0, Math.min(total, Math.floor(step)));
  const startedAt =
    events[0]?.type === "job.start"
      ? Date.parse(String(events[0].data.startedAt ?? events[0].ts))
      : Date.parse(events[0]?.ts ?? "");
  const state: ReplayState = {
    step: n,
    total,
    event: n > 0 ? events[n - 1] : null,
    elapsedMs: null,
    status: n > 0 ? "running" : "not started",
    modelTurns: 0,
    toolCalls: 0,
    toolErrors: 0,
    openTools: [],
    filesTouched: [],
    usage: {},
    permissions: { allowed: 0, denied: 0 },
    loopStops: 0,
    auditSeqs: [],
    lastText: null,
    truncated: false,
  };
  const files = new Set<string>();
  const open = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const e = events[i];
    switch (e.type) {
      case "model.turn": {
        state.modelTurns += 1;
        addUsage(state.usage, e.data.usage);
        const text = e.data.text ?? e.data.excerpt;
        state.lastText = typeof text === "string" && text ? text : state.lastText;
        break;
      }
      case "tool.call": {
        state.toolCalls += 1;
        const name = String(e.data.name ?? "?");
        open.set(String(e.data.toolCallId), name);
        for (const p of pathsOfToolCall(name, e.data.args)) {
          files.add(p);
        }
        break;
      }
      case "tool.result":
        open.delete(String(e.data.toolCallId));
        if (e.data.isError === true) {
          state.toolErrors += 1;
        }
        break;
      case "snapshot":
        for (const f of (e.data.files as Array<{ path?: string }> | undefined) ?? []) {
          if (typeof f?.path === "string") {
            files.add(f.path);
          }
        }
        break;
      case "permission":
        if (e.data.decision === "deny") {
          state.permissions.denied += 1;
        } else {
          state.permissions.allowed += 1;
        }
        break;
      case "loop_guard":
        state.loopStops += 1;
        break;
      case "audit":
        if (typeof e.data.seq === "number") {
          state.auditSeqs.push(e.data.seq);
        }
        break;
      case "truncated":
        state.truncated = true;
        break;
      case "job.end":
        state.status = String(e.data.status ?? "ended");
        break;
      default:
        break;
    }
  }
  state.openTools = [...open.entries()].map(([toolCallId, name]) => ({ toolCallId, name }));
  state.filesTouched = [...files].toSorted();
  if (state.event && Number.isFinite(startedAt)) {
    const at = Date.parse(state.event.ts);
    state.elapsedMs = Number.isFinite(at) ? Math.max(0, at - startedAt) : null;
  }
  return state;
}

export type Stepper = {
  readonly total: number;
  current: () => ReplayState;
  next: () => ReplayState;
  prev: () => ReplayState;
  jump: (step: number) => ReplayState;
};

export function createStepper(events: EvidenceEvent[], start = 1): Stepper {
  let step = Math.max(0, Math.min(events.length, start));
  return {
    total: events.length,
    current: () => stateAt(events, step),
    next: () => {
      step = Math.min(events.length, step + 1);
      return stateAt(events, step);
    },
    prev: () => {
      step = Math.max(0, step - 1);
      return stateAt(events, step);
    },
    jump: (to: number) => {
      step = Math.max(0, Math.min(events.length, Math.floor(to)));
      return stateAt(events, step);
    },
  };
}

function one(value: unknown, max = 160): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** One line that names what the event is. */
export function describeEvent(e: EvidenceEvent): string {
  const d = e.data;
  switch (e.type) {
    case "job.start":
      return `job start: ${one(d.agent)} ${one(d.kind)} on ${one(d.provider)}/${one(d.model)}; prompt ${one(d.promptChars)} chars (sha256 ${one(String(d.promptDigest ?? "").slice(0, 12))})`;
    case "model.turn": {
      const u = (d.usage ?? {}) as EvidenceUsage;
      return `model turn ${one(d.index)}: ${one(d.model)} in ${u.input ?? 0} out ${u.output ?? 0}${d.stopReason ? ` stop ${one(d.stopReason)}` : ""}${d.error ? ` error ${one(d.error, 80)}` : ""}`;
    }
    case "tool.call":
      return `tool call ${one(d.name)}${d.meta ? ` (${one(d.meta, 60)})` : ""}: ${one(d.args, 120)}`;
    case "tool.result":
      return `tool result ${one(d.name)}: ${d.isError ? "error" : "ok"}${typeof d.durationMs === "number" ? ` in ${d.durationMs} ms` : ""}, ${one(d.resultChars)} chars`;
    case "snapshot":
      return `snapshot ${one(d.snapshotId)} before ${one(d.tool)}: ${((d.files as Array<{ path: string }>) ?? []).map((f) => f.path).join(", ")}`;
    case "permission":
      return `permission ${one(d.decision)}: ${one(d.tool)}${d.target ? ` on ${one(d.target, 80)}` : ""}${d.rule ? ` (${one(d.rule)})` : ""}`;
    case "approval":
      return `approval ${one(d.decision)}: ${one(d.tool)} by ${one(d.approver ?? "unknown")}${d.ruleId ? ` (${one(d.ruleId)})` : ""}`;
    case "redaction": {
      const counts = (d.counts ?? {}) as Record<string, number>;
      const masked = Object.entries(counts)
        .map(([k, n]) => `${n} ${k.toLowerCase()}`)
        .join(", ");
      return `context guard on ${one(d.tool)}: ${masked || "nothing"} masked${Number(d.restored) > 0 ? `, ${one(d.restored)} value(s) restored into arguments` : ""}`;
    }
    case "loop_guard":
      return `loop guard stop (${one(d.reason)}) after ${one(d.steps)} steps: ${one(d.summary, 100)}`;
    case "audit":
      return `audit entry seq ${one(d.seq)}: ${one(d.action)} ${one(d.outcome)}`;
    case "truncated":
      return `log truncated (${one(d.reason)}) after ${one(d.events)} events`;
    case "job.end":
      return `job end: ${one(d.status)}${d.error ? ` (${one(d.error, 100)})` : ""}; ${one(d.steps)} steps, ${one(d.toolCalls)} tool calls`;
    default:
      return `${e.type}: ${one(d, 120)}`;
  }
}

/** Text block for one step (CLI and TUI). */
export function formatStep(state: ReplayState): string[] {
  const lines: string[] = [];
  if (state.event) {
    lines.push(
      `step         ${state.step}/${state.total}  +${state.elapsedMs ?? 0} ms  ${state.event.type}`,
    );
    lines.push(`event        ${describeEvent(state.event)}`);
    lines.push(
      `hash         ${state.event.hash.slice(0, 16)} (prev ${state.event.prev.slice(0, 16)})`,
    );
  } else {
    lines.push(`step         0/${state.total}  before the first event`);
  }
  lines.push(`status       ${state.status}`);
  lines.push(
    `model turns  ${state.modelTurns} (input ${state.usage.input ?? 0}, output ${state.usage.output ?? 0} tokens)`,
  );
  lines.push(
    `tool calls   ${state.toolCalls} (${state.toolErrors} failed${state.openTools.length ? `, ${state.openTools.map((t) => t.name).join(", ")} running` : ""})`,
  );
  lines.push(`files        ${state.filesTouched.length ? state.filesTouched.join(", ") : "none"}`);
  lines.push(
    `policy       ${state.permissions.allowed} allowed, ${state.permissions.denied} denied, ${state.loopStops} loop stop${state.loopStops === 1 ? "" : "s"}${state.auditSeqs.length ? `, audit ${state.auditSeqs.join(", ")}` : ""}`,
  );
  if (state.lastText) {
    lines.push(`last text    ${one(state.lastText, 200)}`);
  }
  if (state.truncated) {
    lines.push("note         the log was truncated by the size cap");
  }
  return lines;
}
