// Index cache for the MCP server. The analyser's own cache may live in a project `output/`
// folder up to two levels above the indexed path; this server must not write outside the
// project's Kurahi folder, so it builds the index with the exported `buildIndex` and keeps its own
// cache: in memory, and on disk under `<root>/.kurahi/legacy-mcp/cache/`.
//
// Freshness is a fingerprint of the tree: relative path, size and mtime of every regular file the
// walk reaches (symbolic links are not followed, excluded folders are not entered). Any change,
// including an added or removed file, rebuilds the index.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ServerState } from "./state.js";
import {
  SKIPPED_DIRS,
  buildIndex,
  type LegacyIndex,
} from "../../../packages/legacy-analyzer/src/index.js";
import { KURAHI_DIR_NAME } from "./root-guard.js";

const MAX_WALK = 200_000;
const SCHEMA = "kurahi.legacy-mcp-cache/1";

export type IndexHandle = {
  index: LegacyIndex;
  /** "memory" | "disk": served from a cache; "built": parsed now. */
  source: "memory" | "disk" | "built";
  fingerprint: string;
  builtAt: string;
  buildMs: number;
};

export function treeFingerprint(scopeAbs: string): {
  hash: string;
  files: number;
  partial: boolean;
} {
  const h = crypto.createHash("sha256");
  let files = 0;
  let partial = false;
  const st = fs.statSync(scopeAbs);
  if (st.isFile()) {
    h.update(`${path.basename(scopeAbs)}\0${st.size}\0${Math.floor(st.mtimeMs)}\n`);
    return { hash: h.digest("hex"), files: 1, partial };
  }
  const visit = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      if (files >= MAX_WALK) {
        partial = true;
        return;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIPPED_DIRS.has(e.name) && e.name !== KURAHI_DIR_NAME) {
          visit(full);
        }
      } else if (e.isFile()) {
        try {
          const fst = fs.lstatSync(full);
          h.update(`${path.relative(scopeAbs, full)}\0${fst.size}\0${Math.floor(fst.mtimeMs)}\n`);
          files++;
        } catch {
          // vanished between readdir and stat: the next call sees the change
        }
      }
    }
  };
  visit(scopeAbs);
  return { hash: h.digest("hex"), files, partial };
}

type Persisted = {
  schema: typeof SCHEMA;
  scope: string;
  fingerprint: string;
  builtAt: string;
  buildMs: number;
  index: LegacyIndex;
};

export function createIndexCache(state: ServerState) {
  const memory = new Map<string, IndexHandle>();
  const fileName = (scopeRel: string) =>
    `index-${crypto.createHash("sha256").update(scopeRel).digest("hex").slice(0, 16)}.json`;

  /** Read-only peek: the cached index when still fresh, without building. */
  function peek(scopeAbs: string, scopeRel: string): IndexHandle | null {
    const fp = treeFingerprint(scopeAbs).hash;
    const hit = memory.get(scopeRel);
    if (hit && hit.fingerprint === fp) {
      return { ...hit, source: "memory" };
    }
    const raw = state.readCache(fileName(scopeRel));
    if (!raw) {
      return null;
    }
    try {
      const p = JSON.parse(raw) as Persisted;
      if (
        p.schema !== SCHEMA ||
        p.scope !== scopeRel ||
        p.fingerprint !== fp ||
        p.index?.schema !== "kurahi.legacy-index/1" ||
        p.index.root !== scopeAbs
      ) {
        return null;
      }
      const handle: IndexHandle = {
        index: p.index,
        source: "disk",
        fingerprint: fp,
        builtAt: p.builtAt,
        buildMs: p.buildMs,
      };
      memory.set(scopeRel, handle);
      return handle;
    } catch {
      return null;
    }
  }

  function build(scopeAbs: string, scopeRel: string): IndexHandle {
    const fp = treeFingerprint(scopeAbs).hash;
    const started = Date.now();
    const index = buildIndex(scopeAbs);
    const handle: IndexHandle = {
      index,
      source: "built",
      fingerprint: fp,
      builtAt: new Date().toISOString(),
      buildMs: Date.now() - started,
    };
    memory.set(scopeRel, handle);
    const persisted: Persisted = {
      schema: SCHEMA,
      scope: scopeRel,
      fingerprint: fp,
      builtAt: handle.builtAt,
      buildMs: handle.buildMs,
      index,
    };
    state.writeCache(fileName(scopeRel), JSON.stringify(persisted));
    return handle;
  }

  return {
    peek,
    build,
    /** The fresh index for the scope, building it when missing or stale. */
    get(scopeAbs: string, scopeRel: string): IndexHandle {
      return peek(scopeAbs, scopeRel) ?? build(scopeAbs, scopeRel);
    },
  };
}

export type IndexCache = ReturnType<typeof createIndexCache>;
