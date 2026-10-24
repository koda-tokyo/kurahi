// Chat history helpers for the Control UI history panel: archived conversations (kept, just
// hidden from the default list) and full-text search over conversation transcripts.

import fs from "node:fs";
import path from "node:path";
import { resolveKoloHome } from "../config/kolo-home.js";

const MAX_ARCHIVED = 5000;
const MAX_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_RESULTS = 200;

function archiveFile(home: string): string {
  return path.join(home, "projects", "chats.json");
}

export function loadArchivedChats(home: string = resolveKoloHome()): string[] {
  try {
    const raw = JSON.parse(fs.readFileSync(archiveFile(home), "utf8")) as { archived?: unknown };
    return Array.isArray(raw.archived)
      ? raw.archived.filter((k): k is string => typeof k === "string")
      : [];
  } catch {
    return [];
  }
}

export function setChatArchived(
  key: unknown,
  archived: boolean,
  home: string = resolveKoloHome(),
): string[] {
  if (typeof key !== "string" || !/^agent:[^\s]{1,300}$/.test(key)) {
    throw new Error("invalid session key");
  }
  const set = new Set(loadArchivedChats(home));
  if (archived) {
    set.add(key);
  } else {
    set.delete(key);
  }
  const list = [...set].slice(-MAX_ARCHIVED);
  const file = archiveFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ archived: list }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return list;
}

type StoreEntry = { sessionId?: string; sessionFile?: string };

/**
 * Session keys whose transcript text contains `query` (case-insensitive). Scans each agent's
 * session store under the state dir; large transcripts are read up to MAX_SCAN_BYTES.
 */
export function searchChatTranscripts(query: unknown, home: string = resolveKoloHome()): string[] {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (q.length < 2 || q.length > 200) {
    return [];
  }
  const agentsDir = path.join(home, "agents");
  let agents: string[];
  try {
    agents = fs.readdirSync(agentsDir);
  } catch {
    return [];
  }
  const hits: string[] = [];
  for (const agent of agents) {
    const sessionsDir = path.join(agentsDir, agent, "sessions");
    let store: Record<string, StoreEntry>;
    try {
      store = JSON.parse(
        fs.readFileSync(path.join(sessionsDir, "sessions.json"), "utf8"),
      ) as Record<string, StoreEntry>;
    } catch {
      continue;
    }
    for (const [key, entry] of Object.entries(store)) {
      const file = entry?.sessionFile
        ? path.resolve(sessionsDir, entry.sessionFile)
        : entry?.sessionId
          ? path.join(sessionsDir, `${entry.sessionId}.jsonl`)
          : null;
      if (!file || !file.startsWith(sessionsDir)) {
        continue;
      }
      try {
        const fd = fs.openSync(file, "r");
        try {
          const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, MAX_SCAN_BYTES));
          fs.readSync(fd, buf, 0, buf.length, 0);
          if (messageTextOf(buf.toString("utf8")).toLowerCase().includes(q)) {
            hits.push(key);
          }
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        // missing transcript
      }
      if (hits.length >= MAX_RESULTS) {
        return hits;
      }
    }
  }
  return hits;
}

/** The text of user and assistant messages in a JSONL transcript (no tool payloads). */
export function messageTextOf(jsonl: string): string {
  const out: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const rec = JSON.parse(line) as { message?: { role?: string; content?: unknown } };
      const m = rec.message;
      if (!m || (m.role !== "user" && m.role !== "assistant")) {
        continue;
      }
      if (typeof m.content === "string") {
        out.push(m.content);
      } else if (Array.isArray(m.content)) {
        for (const part of m.content) {
          if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
            const text = (part as { text?: unknown }).text;
            out.push(typeof text === "string" ? text : "");
          }
        }
      }
    } catch {
      // partial last line
    }
  }
  return out.join("\n");
}
