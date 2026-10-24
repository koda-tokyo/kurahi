// Chat history panel (v0.3): past conversations grouped by project, search by title and text,
// new chat, rename and archive. Built on sessions.list plus chats.archived / chats.search.
import type { GatewayBrowserClient } from "../gateway";
import type { Project } from "./projects";
import { projectIdOfSession } from "./projects";

export type HistoryRow = {
  key: string;
  label?: string;
  displayName?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  updatedAt: number | null;
};

export type ChatHistoryState = {
  open: boolean;
  loading: boolean;
  error: string | null;
  rows: HistoryRow[];
  archived: string[];
  showArchived: boolean;
  query: string;
  /** Keys whose transcript text matched the last server-side search; null = no text search. */
  textHits: string[] | null;
  renaming: string | null;
  renameValue: string;
};

export const DEFAULT_CHAT_HISTORY_STATE: ChatHistoryState = {
  open: true,
  loading: false,
  error: null,
  rows: [],
  archived: [],
  showArchived: false,
  query: "",
  textHits: null,
  renaming: null,
  renameValue: "",
};

export type HistoryGroup = { projectId: string | null; name: string; rows: HistoryRow[] };

/** The title shown for a conversation. */
export function chatTitle(row: HistoryRow): string {
  return (row.label || row.derivedTitle || row.displayName || row.key).trim();
}

/** Filter, then group by project (projects first, by name; then conversations without one). */
export function groupHistory(
  rows: HistoryRow[],
  opts: {
    projects: Pick<Project, "id" | "name">[];
    archived: string[];
    showArchived: boolean;
    query: string;
    textHits: string[] | null;
    noProjectLabel: string;
  },
): HistoryGroup[] {
  const archived = new Set(opts.archived);
  const q = opts.query.trim().toLowerCase();
  const hits = opts.textHits ? new Set(opts.textHits) : null;
  const visible = rows.filter((r) => {
    if (archived.has(r.key) !== opts.showArchived) {
      return false;
    }
    if (!q) {
      return true;
    }
    const inTitle = [chatTitle(r), r.lastMessagePreview ?? ""].some((f) =>
      f.toLowerCase().includes(q),
    );
    return inTitle || Boolean(hits?.has(r.key));
  });
  const byProject = new Map<string | null, HistoryRow[]>();
  for (const r of visible) {
    const pid = projectIdOfSession(r.key);
    const list = byProject.get(pid) ?? [];
    list.push(r);
    byProject.set(pid, list);
  }
  const groups: HistoryGroup[] = [];
  const names = new Map(opts.projects.map((p) => [p.id, p.name]));
  const projectIds = [...byProject.keys()].filter((k): k is string => k !== null);
  projectIds.sort((a, b) => (names.get(a) ?? a).localeCompare(names.get(b) ?? b));
  for (const pid of projectIds) {
    groups.push({
      projectId: pid,
      name: names.get(pid) ?? pid,
      rows: sortRows(byProject.get(pid) ?? []),
    });
  }
  const loose = byProject.get(null);
  if (loose?.length) {
    groups.push({ projectId: null, name: opts.noProjectLabel, rows: sortRows(loose) });
  }
  return groups;
}

function sortRows(rows: HistoryRow[]): HistoryRow[] {
  return rows.toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

/** A new conversation key outside any project. */
export function newChatKey(agentId: string, now = Date.now()): string {
  const suffix = `${now.toString(36)}${Math.floor(Math.random() * 1296)
    .toString(36)
    .padStart(2, "0")}`;
  return `agent:${agentId}:chat-${suffix}`;
}

type Host = {
  client: GatewayBrowserClient | null;
  connected: boolean;
  chatHistory: ChatHistoryState;
};

function patch(host: Host, next: Partial<ChatHistoryState>) {
  host.chatHistory = { ...host.chatHistory, ...next };
}

export async function loadChatHistoryPanel(host: Host) {
  if (!host.client || !host.connected) {
    return;
  }
  patch(host, { loading: true, error: null });
  try {
    const [list, archived] = await Promise.all([
      host.client.request("sessions.list", {
        limit: 200,
        includeDerivedTitles: true,
        includeLastMessage: true,
      }) as Promise<{ sessions?: HistoryRow[] }>,
      host.client.request("chats.archived", {}) as Promise<{ archived?: string[] }>,
    ]);
    patch(host, {
      loading: false,
      rows: (list?.sessions ?? []).filter((r) => r.key.startsWith("agent:")),
      archived: archived?.archived ?? [],
    });
  } catch (err) {
    patch(host, { loading: false, error: String(err) });
  }
}

export async function searchChatText(host: Host) {
  const q = host.chatHistory.query.trim();
  if (!host.client || !host.connected || q.length < 2) {
    patch(host, { textHits: null });
    return;
  }
  try {
    const res = (await host.client.request("chats.search", { query: q })) as { keys?: string[] };
    patch(host, { textHits: res?.keys ?? [] });
  } catch (err) {
    patch(host, { error: String(err) });
  }
}

export async function archiveChat(host: Host, key: string, archived: boolean) {
  if (!host.client || !host.connected) {
    return;
  }
  try {
    const res = (await host.client.request("chats.archive", { key, archived })) as {
      archived?: string[];
    };
    patch(host, { archived: res?.archived ?? host.chatHistory.archived });
  } catch (err) {
    patch(host, { error: String(err) });
  }
}

export async function renameChat(host: Host, key: string, label: string) {
  if (!host.client || !host.connected) {
    return;
  }
  const clean = label.trim().slice(0, 120);
  try {
    await host.client.request("sessions.patch", { key, label: clean || null });
    patch(host, {
      renaming: null,
      rows: host.chatHistory.rows.map((r) =>
        r.key === key ? { ...r, label: clean || undefined } : r,
      ),
    });
  } catch (err) {
    patch(host, { error: String(err) });
  }
}
