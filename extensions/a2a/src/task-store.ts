import { randomUUID } from "node:crypto";
import {
  TERMINAL_STATES,
  type Artifact,
  type Message,
  type TaskState,
  type TaskView,
} from "./protocol.js";

// In-memory task store. Tasks belong to the client that created them: every lookup takes the
// client id, and a task of another client is reported as not found. Terminal tasks are kept for
// the TTL and the oldest terminal ones are evicted first when the store is full; running tasks are
// never evicted.

export type TaskRecord = TaskView & {
  clientId: string;
  slug: string;
  createdAt: number;
  updatedAt: number;
  abort: AbortController;
};

export type TaskListener = (
  task: TaskRecord,
  change: "status" | "artifact",
  artifact?: Artifact,
) => void;

export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly listeners = new Map<string, Set<TaskListener>>();

  constructor(private readonly opts: { maxTasks: number; ttlMs: number; now?: () => number }) {}

  private now() {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  get size() {
    return this.tasks.size;
  }

  runningCount(): number {
    let n = 0;
    for (const task of this.tasks.values()) {
      if (!TERMINAL_STATES.has(task.status.state)) {
        n += 1;
      }
    }
    return n;
  }

  /** A running task in the same client context (one turn at a time per session). */
  activeInContext(clientId: string, contextId: string): TaskRecord | undefined {
    for (const task of this.tasks.values()) {
      if (
        task.clientId === clientId &&
        task.contextId === contextId &&
        !TERMINAL_STATES.has(task.status.state)
      ) {
        return task;
      }
    }
    return undefined;
  }

  /** Null when the store is full of running tasks. */
  create(params: {
    clientId: string;
    slug: string;
    contextId: string;
    message: Message;
  }): TaskRecord | null {
    this.prune();
    if (this.tasks.size >= this.opts.maxTasks) {
      return null;
    }
    const id = randomUUID();
    const now = this.now();
    const task: TaskRecord = {
      id,
      contextId: params.contextId,
      clientId: params.clientId,
      slug: params.slug,
      status: { state: "submitted", timestamp: new Date(now).toISOString() },
      history: [{ ...params.message, taskId: id, contextId: params.contextId }],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
      abort: new AbortController(),
    };
    this.tasks.set(id, task);
    return task;
  }

  get(clientId: string, taskId: string): TaskRecord | undefined {
    const task = this.tasks.get(taskId);
    if (!task || task.clientId !== clientId) {
      return undefined;
    }
    if (this.expired(task)) {
      this.tasks.delete(taskId);
      return undefined;
    }
    return task;
  }

  /** Moves a task to a new state. A terminal task never changes again. */
  setState(task: TaskRecord, state: TaskState, message?: Message): boolean {
    if (TERMINAL_STATES.has(task.status.state)) {
      return false;
    }
    const now = this.now();
    task.status = {
      state,
      ...(message ? { message: { ...message, taskId: task.id, contextId: task.contextId } } : {}),
      timestamp: new Date(now).toISOString(),
    };
    if (message) {
      task.history.push(task.status.message as Message);
    }
    task.updatedAt = now;
    this.emit(task, "status");
    if (TERMINAL_STATES.has(state)) {
      this.listeners.delete(task.id);
    }
    return true;
  }

  addArtifact(task: TaskRecord, artifact: Artifact) {
    if (TERMINAL_STATES.has(task.status.state)) {
      return;
    }
    task.artifacts.push(artifact);
    task.updatedAt = this.now();
    this.emit(task, "artifact", artifact);
  }

  subscribe(task: TaskRecord, listener: TaskListener): () => void {
    let set = this.listeners.get(task.id);
    if (!set) {
      set = new Set();
      this.listeners.set(task.id, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  /** Aborts every running task (plugin unload). */
  abortAll(reason: string) {
    for (const task of this.tasks.values()) {
      if (!TERMINAL_STATES.has(task.status.state)) {
        task.abort.abort(reason);
      }
    }
  }

  private emit(task: TaskRecord, change: "status" | "artifact", artifact?: Artifact) {
    for (const listener of this.listeners.get(task.id) ?? []) {
      try {
        listener(task, change, artifact);
      } catch {
        // a broken stream must not break the task
      }
    }
  }

  private expired(task: TaskRecord) {
    return TERMINAL_STATES.has(task.status.state) && this.now() - task.updatedAt > this.opts.ttlMs;
  }

  private prune() {
    for (const [id, task] of this.tasks) {
      if (this.expired(task)) {
        this.tasks.delete(id);
      }
    }
    if (this.tasks.size < this.opts.maxTasks) {
      return;
    }
    const terminal = [...this.tasks.values()]
      .filter((t) => TERMINAL_STATES.has(t.status.state))
      .toSorted((a, b) => a.updatedAt - b.updatedAt);
    for (const task of terminal) {
      if (this.tasks.size < this.opts.maxTasks) {
        break;
      }
      this.tasks.delete(task.id);
    }
  }
}
