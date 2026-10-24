// Gateway wiring for the console terminal broker (src/console/terminal): approvals through the
// gateway's ExecApprovalManager (the same records `exec.approval.resolve` answers), the
// exec-approvals file for act-mode `policy`, the hash-chained audit log, the container sandbox,
// and event delivery to the session owner's admin connections only.

import type { KoLoConfig } from "../config/config.js";
import type { ExecApprovalManager } from "./exec-approval-manager.js";
import type { TerminalEvent } from "./protocol/index.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveSandboxConfigForAgent } from "../agents/sandbox/config.js";
import { ensureSandboxContainer } from "../agents/sandbox/docker.js";
import { auditSafe } from "../audit/audit-log.js";
import { TerminalBroker } from "../console/terminal/broker.js";
import { createHostBackend, createSandboxBackend } from "../console/terminal/pty-backend.js";
import {
  evaluateShellAllowlist,
  maxAsk,
  minSecurity,
  resolveExecApprovals,
  resolveSafeBins,
} from "../infra/exec-approvals.js";
import { getProject } from "../projects/store.js";
import { loadTerminalProfiles } from "../projects/templates.js";
import { scopeSatisfies } from "./scopes.js";
import { MAX_BUFFERED_BYTES } from "./server-constants.js";
import { actorOf } from "./server-methods/projects.js";

export const TERMINAL_EVENT = "terminal.event";
const ADMIN_SCOPE = "operator.admin";

/** Admin operators only, and only the identity that owns the session. */
export function mayReceiveTerminalEvent(client: GatewayWsClient, owner: string): boolean {
  const role = client.connect.role ?? "operator";
  if (role !== "operator") {
    return false;
  }
  if (client.pairing && !scopeSatisfies(client.pairing.scope, "admin")) {
    return false;
  }
  const scopes = Array.isArray(client.connect.scopes) ? client.connect.scopes : [];
  if (!scopes.includes(ADMIN_SCOPE)) {
    return false;
  }
  return actorOf(client) === owner;
}

export function createGatewayTerminalBroker(params: {
  clients: Set<GatewayWsClient>;
  approvals: ExecApprovalManager;
  broadcast: (event: string, payload: unknown, opts?: { dropIfSlow?: boolean }) => void;
  loadConfig: () => KoLoConfig;
}): TerminalBroker {
  const { approvals, broadcast } = params;
  return new TerminalBroker({
    getConfig: params.loadConfig,
    getProject: (id) => getProject(id),
    profileIsolated: (project) =>
      loadTerminalProfiles().find((p) => p.id === project.terminalProfile)?.clientIsolated === true,
    createBackend: async ({ project, root, sandbox }) => {
      if (!sandbox) {
        return await createHostBackend();
      }
      const cfg = params.loadConfig();
      const agentId = resolveDefaultAgentId(cfg);
      const sandboxCfg = resolveSandboxConfigForAgent(cfg, agentId);
      const containerName = await ensureSandboxContainer({
        sessionKey: `agent:${agentId}:terminal-${project.id}`,
        workspaceDir: root,
        agentWorkspaceDir: root,
        cfg: { ...sandboxCfg, scope: "session", workspaceAccess: "rw" },
      });
      return await createSandboxBackend({
        containerName,
        hostRoot: root,
        containerRoot: sandboxCfg.docker.workdir,
      });
    },
    approvals: {
      request(req) {
        const agentId = resolveDefaultAgentId(params.loadConfig());
        const request = {
          command: req.command,
          cwd: req.cwd,
          host: req.host,
          security: null,
          ask: null,
          agentId,
          resolvedPath: null,
          sessionKey: `terminal:${req.sessionId}`,
        };
        const record = approvals.create(request, req.timeoutMs, null);
        const wait = approvals.waitForDecision(record, req.timeoutMs);
        broadcast(
          "exec.approval.requested",
          {
            id: record.id,
            request: record.request,
            createdAtMs: record.createdAtMs,
            expiresAtMs: record.expiresAtMs,
          },
          { dropIfSlow: true },
        );
        return {
          approvalId: record.id,
          expiresAtMs: record.expiresAtMs,
          decision: wait.then((decision) => ({
            decision,
            resolvedBy: record.resolvedBy ?? null,
          })),
        };
      },
      cancel(approvalId, by) {
        if (approvals.resolve(approvalId, "deny", by)) {
          broadcast(
            "exec.approval.resolved",
            { id: approvalId, decision: "deny", resolvedBy: by, ts: Date.now() },
            { dropIfSlow: true },
          );
        }
      },
    },
    policy: (line, cwd) => {
      const agentId = resolveDefaultAgentId(params.loadConfig());
      const resolved = resolveExecApprovals(agentId, { security: "allowlist", ask: "on-miss" });
      const security = minSecurity("allowlist", resolved.agent.security);
      const ask = maxAsk("on-miss", resolved.agent.ask);
      const evaluation = evaluateShellAllowlist({
        command: line,
        allowlist: resolved.allowlist,
        safeBins: resolveSafeBins(params.loadConfig().tools?.exec?.safeBins),
        cwd,
      });
      return {
        security,
        ask,
        analysisOk: evaluation.analysisOk,
        allowlistSatisfied: evaluation.allowlistSatisfied,
      };
    },
    audit: (input) => void auditSafe(input),
    deliver: (event: TerminalEvent, owner: string) => {
      const frame = JSON.stringify({ type: "event", event: TERMINAL_EVENT, payload: event });
      for (const client of params.clients) {
        // A slow consumer misses events instead of stalling the gateway; it replays by seq.
        if (
          !mayReceiveTerminalEvent(client, owner) ||
          client.socket.bufferedAmount > MAX_BUFFERED_BYTES
        ) {
          continue;
        }
        try {
          client.socket.send(frame);
        } catch {
          // a closed socket: the client replays after reconnecting
        }
      }
    },
  });
}
