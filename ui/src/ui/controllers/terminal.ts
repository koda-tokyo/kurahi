/* eslint-disable no-control-regex -- Terminal input rejects control bytes; output strips escape actions. */
import type {
  TerminalEvent,
  TerminalOpenResult,
} from "../../../../packages/client/src/generated/types";
import type { GatewayBrowserClient } from "../gateway";
import { addExecApproval, removeExecApproval, type ExecApprovalRequest } from "./exec-approval";
import { projectModeOf, type Project } from "./projects";

// The generated replay union currently has incorrect array precedence. Use the event contract.
type Replay = { events: TerminalEvent[]; truncated: boolean; hasMore: boolean; lastSeq: number };
export type TerminalState = {
  session: TerminalOpenResult | null;
  cursor: number;
  events: TerminalEvent[];
  draft: string;
  busy: boolean;
  replaying: boolean;
  replayAgain: boolean;
  synced: boolean;
  closed: boolean;
  truncated: boolean;
  error: boolean;
  generation: number;
};
export const emptyTerminal = (): TerminalState => ({
  session: null,
  cursor: 0,
  events: [],
  draft: "",
  busy: false,
  replaying: false,
  replayAgain: false,
  synced: false,
  closed: false,
  truncated: false,
  error: false,
  generation: 0,
});
export type TerminalHost = {
  client: Pick<GatewayBrowserClient, "request"> | null;
  connected: boolean;
  terminal: TerminalState;
  execApprovalQueue: ExecApprovalRequest[];
};
function patch(host: TerminalHost, next: Partial<TerminalState>) {
  host.terminal = { ...host.terminal, ...next };
}

/** Keep only a bounded transcript. Render it as text, never HTML or terminal escape actions. */
function retain(events: TerminalEvent[]): { events: TerminalEvent[]; trimmed: boolean } {
  let clipped = false;
  events = events.map((event) => {
    if ((event.type === "stdout" || event.type === "stderr") && event.data.length > 32768) {
      clipped = true;
      return { ...event, data: event.data.slice(-32768) };
    }
    return event;
  });
  let bytes = 0;
  let start = events.length;
  while (start > 0 && events.length - start < 250) {
    const event = events[start - 1];
    bytes += JSON.stringify(event).length;
    if (bytes > 131072 && start < events.length) {
      break;
    }
    start--;
  }
  return { events: events.slice(start), trimmed: clipped || start > 0 };
}

export function disconnectTerminal(host: TerminalHost, reset = false) {
  if (!host.terminal) {
    return;
  }
  const generation = host.terminal.generation + 1;
  host.terminal = reset
    ? { ...emptyTerminal(), generation }
    : {
        ...host.terminal,
        generation,
        busy: false,
        replaying: false,
        replayAgain: false,
        synced: false,
        draft: "",
      };
}

export async function replayTerminal(host: TerminalHost) {
  if (!host.terminal) {
    return;
  }
  const { session, generation } = host.terminal;
  const client = host.client;
  if (!client || !host.connected || !session) {
    return;
  }
  if (host.terminal.replaying) {
    patch(host, { replayAgain: true });
    return;
  }
  const current = () =>
    host.connected &&
    host.client === client &&
    host.terminal.generation === generation &&
    host.terminal.session?.sessionId === session.sessionId;
  patch(host, { replaying: true, synced: false });
  try {
    let more = true;
    while (more && current()) {
      patch(host, { replayAgain: false });
      const page = await client.request<Replay>("terminal.replay", {
        sessionId: session.sessionId,
        afterSeq: host.terminal.cursor,
        limit: 200,
      });
      if (!current()) {
        return;
      }
      const events = page.events.filter(
        (event) => event.sessionId === session.sessionId && event.seq > host.terminal.cursor,
      );
      if (page.hasMore && !events.length) {
        throw new Error("Replay made no progress");
      }
      for (const event of events) {
        if (event.type === "approval.requested" && event.expiresAtMs > Date.now()) {
          host.execApprovalQueue = addExecApproval(host.execApprovalQueue, {
            id: event.approvalId,
            createdAtMs: event.ts,
            expiresAtMs: event.expiresAtMs,
            request: {
              command: event.command,
              cwd: event.cwd,
              sessionKey: `terminal:${session.sessionId}`,
            },
          });
        } else if (event.type === "approval.resolved") {
          host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, event.approvalId);
        }
      }
      const kept = retain([...host.terminal.events, ...events]);
      const closed = events.some(
        (event) =>
          event.type === "notice" && ["closed", "idle-timeout", "shutdown"].includes(event.code),
      );
      patch(host, {
        events: kept.events,
        cursor: events.at(-1)?.seq ?? host.terminal.cursor,
        truncated: host.terminal.truncated || page.truncated || kept.trimmed,
        closed: host.terminal.closed || closed,
      });
      more = page.hasMore || host.terminal.replayAgain;
    }
    if (current()) {
      patch(host, { synced: true, error: false });
    }
  } catch (error) {
    if (current()) {
      const details =
        error && typeof error === "object" && "details" in error ? error.details : null;
      const missing =
        details && typeof details === "object" && "code" in details && details.code === "not-found";
      patch(host, { error: true, synced: false, closed: host.terminal.closed || Boolean(missing) });
      if (missing) {
        host.execApprovalQueue = host.execApprovalQueue.filter(
          (entry) => entry.request.sessionKey !== `terminal:${session.sessionId}`,
        );
      }
    }
  } finally {
    if (current()) {
      patch(host, { replaying: false });
    }
  }
}

export function terminalEvent(host: TerminalHost, payload: unknown) {
  if (!host.terminal?.session || !payload || typeof payload !== "object") {
    return;
  }
  if ((payload as { sessionId?: string }).sessionId === host.terminal.session.sessionId) {
    void replayTerminal(host);
  }
}

export async function openTerminal(host: TerminalHost, project: Project) {
  if (
    !host.client ||
    !host.connected ||
    host.terminal.busy ||
    (host.terminal.session && !host.terminal.closed) ||
    projectModeOf(project) === "read"
  ) {
    return;
  }
  const client = host.client;
  const generation = host.terminal.generation + 1;
  host.terminal = { ...emptyTerminal(), generation, busy: true };
  try {
    const session = await client.request<TerminalOpenResult>("terminal.open", {
      projectId: project.id,
      name: "Workbench",
    });
    if (host.client !== client || host.terminal.generation !== generation || !host.connected) {
      return;
    }
    patch(host, { session });
    await replayTerminal(host);
  } catch {
    if (host.terminal.generation === generation) {
      patch(host, { error: true });
    }
  } finally {
    if (host.terminal.generation === generation) {
      patch(host, { busy: false });
    }
  }
}

export async function terminalAction(
  host: TerminalHost,
  action: "input" | "cancel" | "close",
  project: Project,
) {
  const { session, generation, draft } = host.terminal;
  if (
    !host.client ||
    !host.connected ||
    !session ||
    session.projectId !== project.id ||
    host.terminal.busy ||
    host.terminal.closed
  ) {
    return;
  }
  // Input is never retried: a lost acknowledgment does not mean the command did not run.
  if (
    action === "input" &&
    (!host.terminal.synced ||
      projectModeOf(project) === "read" ||
      !draft.trim() ||
      /[\r\n\x00-\x1f\x7f]/.test(draft) ||
      draft.length > session.limits.maxLineLength)
  ) {
    return;
  }
  const client = host.client;
  patch(host, { busy: true, error: false, ...(action === "input" ? { draft: "" } : {}) });
  try {
    await client.request(`terminal.${action}`, {
      sessionId: session.sessionId,
      ...(action === "input" ? { data: `${draft}\r` } : {}),
    });
    if (host.terminal.generation !== generation || host.client !== client) {
      return;
    }
    if (action === "close") {
      patch(host, { closed: true });
    }
    await replayTerminal(host);
  } catch {
    if (host.terminal.generation === generation) {
      patch(host, { error: true, synced: false });
    }
  } finally {
    if (host.terminal.generation === generation) {
      patch(host, { busy: false });
    }
  }
}
