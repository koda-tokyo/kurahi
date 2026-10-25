// In-process work item change events: every write of an item (store.ts writeWorkItem) is
// announced to the listeners of this process, whoever made it (a gateway method, an agent tool,
// the autopilot engine, the escalation sweep). The autopilot's workitems trigger listens here;
// the WebSocket `workitems.changed` broadcast is separate and unchanged.
//
// Listeners get ids, queue, action, actor and status only (no titles, no field values). A
// listener that throws never affects the write.
//
// On globalThis under a registered symbol: plugin code loaded through jiti may hold its own copy
// of this module.

import type { WorkItem, WorkItemStatus } from "./types.js";

export type WorkItemChange = {
  projectId: string;
  id: string;
  queue: string;
  /** The last history entry's action (`create`, `decide.approve`, `flag.clear` …). */
  action: string;
  /** Who made the change (the last history entry's `by`). */
  actor: string;
  actorKind: "person" | "agent" | "system";
  status: WorkItemStatus;
  dueAt: string | null;
  revision: number;
};

type Listener = (change: WorkItemChange) => void;

const KEY = Symbol.for("kurahi.workitems.changeListeners");

function listeners(): Set<Listener> {
  const g = globalThis as { [KEY]?: Set<Listener> };
  g[KEY] ??= new Set();
  return g[KEY];
}

/** Subscribe to work item writes in this process; returns the unsubscribe. */
export function onWorkItemChange(fn: Listener): () => void {
  listeners().add(fn);
  return () => {
    listeners().delete(fn);
  };
}

export function workItemChangeOf(item: WorkItem): WorkItemChange {
  const last = item.history.at(-1);
  return {
    projectId: item.projectId,
    id: item.id,
    queue: item.queue,
    action: last?.action ?? "update",
    actor: last?.by ?? item.createdBy,
    actorKind: last?.actorKind ?? "system",
    status: item.status,
    dueAt: item.dueAt,
    revision: item.revision,
  };
}

export function emitWorkItemChange(item: WorkItem): void {
  const set = listeners();
  if (set.size === 0) {
    return;
  }
  const change = workItemChangeOf(item);
  for (const fn of set) {
    try {
      fn(change);
    } catch {
      // A listener never breaks a write.
    }
  }
}
