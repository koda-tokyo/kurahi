// src/agents/memory-inject.ts
//
// Auto-injects relevant memory context before agent turns.
// Part of the "spine memory" architecture — memory as core infrastructure,
// not a bolt-on tool.
//

import type { KoLoConfig } from "../config/config.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getMemorySearchManager } from "../memory/index.js";
import {
  markMemoryText,
  resolveTrustMarkContext,
  trustOfPath,
  type TrustMarkContext,
} from "../memory/retrieval-trust.js";

const log = createSubsystemLogger("memory-inject");

export interface MemoryInjectParams {
  /** Existing context files from bootstrap */
  contextFiles: EmbeddedContextFile[];
  /** User's prompt/message (source for search query) */
  prompt: string;
  /** Full Kurahi config */
  config: KoLoConfig;
  /** Agent ID for memory scope */
  agentId: string;
  /** Workspace directory (for additional context) */
  workspaceDir?: string;
}

/**
 * Inject relevant memory context into the context files array.
 *
 * This is the core of "spine memory" — automatic RAG before every turn.
 *
 * Flow:
 * 1. Check if memory search is enabled
 * 2. Extract search query from user prompt
 * 3. Search memory (semantic + keyword hybrid)
 * 4. Format results and prepend to context files
 *
 * Returns the enriched context files array (with memory prepended if found).
 */
export async function injectMemoryContext(
  params: MemoryInjectParams,
): Promise<EmbeddedContextFile[]> {
  const { contextFiles, prompt, config, agentId } = params;

  // Check if memory search is available
  try {
    const { manager, error } = await getMemorySearchManager({
      cfg: config,
      agentId,
    });

    if (!manager) {
      log.debug(`memory inject skipped: ${error || "no manager"}`);
      return contextFiles;
    }

    // Extract search query from user prompt
    const query = extractSearchQuery(prompt);
    if (!query) {
      log.debug("memory inject skipped: no extractable query");
      return contextFiles;
    }

    // Search memory
    const results = await manager.search(query, {
      maxResults: 3,
      minScore: 0.35,
    });

    if (results.length === 0) {
      log.debug(`memory inject: no results for "${query.slice(0, 50)}..."`);
      return contextFiles;
    }

    // Build memory context file
    // ASI06: each recalled snippet is marked by the trust of its origin.
    const marks = resolveTrustMarkContext({
      config,
      agentId,
      workspaceDir: manager.status().workspaceDir,
    });
    const memoryContent = buildMemoryContextContent(results, marks);
    const memoryFile: EmbeddedContextFile = {
      path: "[Memory Recall]",
      content: memoryContent,
    };

    log.debug(`memory inject: ${results.length} results for "${query.slice(0, 50)}..." → injected`);

    // Prepend memory to context files (high priority)
    return [memoryFile, ...contextFiles];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`memory inject error: ${message}`);
    return contextFiles;
  }
}

/**
 * Extract a search query from the user's prompt.
 *
 * Strategy:
 * - Skip very short messages (likely greetings)
 * - Remove common prefixes
 * - Truncate to reasonable length for embedding
 */
function extractSearchQuery(prompt: string): string | null {
  if (!prompt || typeof prompt !== "string") {
    return null;
  }

  // Clean the message
  const cleaned = prompt
    .replace(/^(hey|hi|hello|ok|okay|sure|yes|no|thanks|thank you)\s*/i, "")
    .trim();

  // Skip very short messages
  if (cleaned.length < 10) {
    return null;
  }

  // Skip messages that are just commands
  if (/^\/\w+/.test(cleaned)) {
    return null;
  }

  // Truncate to first 200 chars (embedding models handle this well)
  return cleaned.slice(0, 200);
}

/**
 * Format memory search results into a context file content string.
 */
export function buildMemoryContextContent(
  results: Array<{
    path: string;
    snippet: string;
    score: number;
    source?: string;
    startLine?: number;
    endLine?: number;
  }>,
  marks: TrustMarkContext | null = null,
): string {
  const lines: string[] = [
    "# Relevant Memories (auto-recalled)",
    "",
    "_These memories were automatically retrieved based on your message._",
    "",
  ];

  for (const r of results) {
    const scoreDisplay = (r.score * 100).toFixed(0);
    const trust = marks ? trustOfPath(r.path, marks, r.source).trust : null;
    lines.push(`## ${r.path} (${scoreDisplay}% match${trust ? `, trust: ${trust}` : ""})`);

    // Clean and truncate snippet
    const snippet = r.snippet
      .trim()
      .replace(/\n{3,}/g, "\n\n") // Collapse multiple newlines
      .slice(0, 500); // Cap snippet length

    lines.push(trust ? markMemoryText(snippet, trust, r.path) : snippet);
    lines.push("");
  }

  lines.push("---");
  lines.push("_Use memory_search tool for deeper recall. These are the top automatic matches._");

  return lines.join("\n");
}
