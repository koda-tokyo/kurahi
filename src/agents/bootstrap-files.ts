import type { KoLoConfig } from "../config/config.js";
import type { EmbeddedContextFile } from "./pi-embedded-helpers.js";
import { markMemoryText, resolveTrustMarkContext, trustOfPath } from "../memory/retrieval-trust.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { applyBootstrapHookOverrides } from "./bootstrap-hooks.js";
import { buildBootstrapContextFiles, resolveBootstrapMaxChars } from "./pi-embedded-helpers.js";
import {
  filterBootstrapFilesForSession,
  loadWorkspaceBootstrapFiles,
  type WorkspaceBootstrapFile,
} from "./workspace.js";

export function makeBootstrapWarn(params: {
  sessionLabel: string;
  warn?: (message: string) => void;
}): ((message: string) => void) | undefined {
  if (!params.warn) {
    return undefined;
  }
  return (message: string) => params.warn?.(`${message} (sessionKey=${params.sessionLabel})`);
}

export async function resolveBootstrapFilesForRun(params: {
  workspaceDir: string;
  config?: KoLoConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
}): Promise<WorkspaceBootstrapFile[]> {
  const sessionKey = params.sessionKey ?? params.sessionId;
  const bootstrapFiles = filterBootstrapFilesForSession(
    await loadWorkspaceBootstrapFiles(params.workspaceDir),
    sessionKey,
  );
  const files = await applyBootstrapHookOverrides({
    files: bootstrapFiles,
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    agentId: params.agentId,
  });
  return markBootMemoryFiles(files, {
    ...params,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(sessionKey),
  });
}

const BOOT_MEMORY_FILES = new Set(["MEMORY.md", "memory.md"]);

/** ASI06: MEMORY.md injected at boot carries the trust of its origin like any other recall. */
function markBootMemoryFiles(
  files: WorkspaceBootstrapFile[],
  params: { workspaceDir: string; config?: KoLoConfig; agentId: string },
): WorkspaceBootstrapFile[] {
  const marks = resolveTrustMarkContext(params);
  if (!marks) {
    return files;
  }
  return files.map((file) => {
    if (file.missing || typeof file.content !== "string" || !BOOT_MEMORY_FILES.has(file.name)) {
      return file;
    }
    const { trust } = trustOfPath(file.path, marks);
    return { ...file, content: markMemoryText(file.content, trust, file.name) };
  });
}

export async function resolveBootstrapContextForRun(params: {
  workspaceDir: string;
  config?: KoLoConfig;
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  warn?: (message: string) => void;
}): Promise<{
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
}> {
  const bootstrapFiles = await resolveBootstrapFilesForRun(params);
  const contextFiles = buildBootstrapContextFiles(bootstrapFiles, {
    maxChars: resolveBootstrapMaxChars(params.config),
    warn: params.warn,
  });
  return { bootstrapFiles, contextFiles };
}
