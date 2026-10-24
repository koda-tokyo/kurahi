import type { KoLoApp } from "./app";
import type { EventLogEntry } from "./app-events";
import type { ExecApprovalRequest } from "./controllers/exec-approval";
import type { GatewayEventFrame, GatewayHelloOk } from "./gateway";
import type { Tab } from "./navigation";
import type { UiSettings } from "./storage";
import type { AgentsListResult, PresenceEntry, HealthSnapshot, StatusSummary } from "./types";
import { CHAT_SESSIONS_ACTIVE_MINUTES, flushChatQueueForEvent } from "./app-chat";
import {
  applySettings,
  guardTab,
  loadCron,
  refreshActiveTab,
  setLastActiveSessionKey,
  setTabFromRoute,
  syncUrlWithTab,
} from "./app-settings";
import { handleAgentEvent, resetToolStream, type AgentEventPayload } from "./app-tool-stream";
import { loadAgents } from "./controllers/agents";
import { loadAssistantIdentity } from "./controllers/assistant-identity";
import { businessEvent, loadBusiness, resetBusiness } from "./controllers/business";
import { loadChatHistory } from "./controllers/chat";
import { handleChatEvent, type ChatEventPayload } from "./controllers/chat";
import { loadChatHistoryPanel } from "./controllers/chat-history";
import { loadDevices } from "./controllers/devices";
import { recordApprovalDecision, type EnterpriseState } from "./controllers/enterprise";
import {
  addExecApproval,
  parseExecApprovalRequested,
  parseExecApprovalResolved,
  removeExecApproval,
} from "./controllers/exec-approval";
import { loadNodes } from "./controllers/nodes";
import { loadSessions } from "./controllers/sessions";
import {
  disconnectTerminal,
  replayTerminal,
  terminalEvent,
  type TerminalState,
} from "./controllers/terminal";
import { cancelVoice, voiceEvent, type VoiceHost } from "./controllers/voice";
import { GatewayBrowserClient } from "./gateway";
import { matchLocale } from "./i18n";

type GatewayHost = {
  voice: VoiceHost["voice"];
  voiceCapture: VoiceHost["voiceCapture"];
  terminal: TerminalState;
  settings: UiSettings;
  password: string;
  client: GatewayBrowserClient | null;
  connected: boolean;
  hello: GatewayHelloOk | null;
  lastError: string | null;
  onboarding?: boolean;
  eventLogBuffer: EventLogEntry[];
  eventLog: EventLogEntry[];
  tab: Tab;
  presenceEntries: PresenceEntry[];
  presenceError: string | null;
  presenceStatus: StatusSummary | null;
  agentsLoading: boolean;
  agentsList: AgentsListResult | null;
  agentsError: string | null;
  debugHealth: HealthSnapshot | null;
  assistantName: string;
  assistantAvatar: string | null;
  assistantAgentId: string | null;
  sessionKey: string;
  chatRunId: string | null;
  refreshSessionsAfterChat: Set<string>;
  execApprovalQueue: ExecApprovalRequest[];
  execApprovalError: string | null;
};

type SessionDefaultsSnapshot = {
  defaultAgentId?: string;
  mainKey?: string;
  mainSessionKey?: string;
  scope?: string;
};

function normalizeSessionKeyForDefaults(
  value: string | undefined,
  defaults: SessionDefaultsSnapshot,
): string {
  const raw = (value ?? "").trim();
  const mainSessionKey = defaults.mainSessionKey?.trim();
  if (!mainSessionKey) {
    return raw;
  }
  if (!raw) {
    return mainSessionKey;
  }
  const mainKey = defaults.mainKey?.trim() || "main";
  const defaultAgentId = defaults.defaultAgentId?.trim();
  const isAlias =
    raw === "main" ||
    raw === mainKey ||
    (defaultAgentId &&
      (raw === `agent:${defaultAgentId}:main` || raw === `agent:${defaultAgentId}:${mainKey}`));
  return isAlias ? mainSessionKey : raw;
}

function applySessionDefaults(host: GatewayHost, defaults?: SessionDefaultsSnapshot) {
  if (!defaults?.mainSessionKey) {
    return;
  }
  const resolvedSessionKey = normalizeSessionKeyForDefaults(host.sessionKey, defaults);
  const resolvedSettingsSessionKey = normalizeSessionKeyForDefaults(
    host.settings.sessionKey,
    defaults,
  );
  const resolvedLastActiveSessionKey = normalizeSessionKeyForDefaults(
    host.settings.lastActiveSessionKey,
    defaults,
  );
  const nextSessionKey = resolvedSessionKey || resolvedSettingsSessionKey || host.sessionKey;
  const nextSettings = {
    ...host.settings,
    sessionKey: resolvedSettingsSessionKey || nextSessionKey,
    lastActiveSessionKey: resolvedLastActiveSessionKey || nextSessionKey,
  };
  const shouldUpdateSettings =
    nextSettings.sessionKey !== host.settings.sessionKey ||
    nextSettings.lastActiveSessionKey !== host.settings.lastActiveSessionKey;
  if (nextSessionKey !== host.sessionKey) {
    host.sessionKey = nextSessionKey;
  }
  if (shouldUpdateSettings) {
    applySettings(host as unknown as Parameters<typeof applySettings>[0], nextSettings);
  }
}

// Preserve sessions only when explicitly reconnecting to the same endpoint and identity.
const terminalConnections = new WeakMap<
  GatewayHost,
  { url: string; token: string; password: string }
>();
export function connectGateway(host: GatewayHost) {
  resetBusiness(host as unknown as KoLoApp);
  cancelVoice(host);
  const previous = terminalConnections.get(host);
  const next = {
    url: host.settings.gatewayUrl,
    token: host.settings.token,
    password: host.password,
  };
  const same =
    previous?.url === next.url &&
    previous.token === next.token &&
    previous.password === next.password;
  disconnectTerminal(host, !same);
  terminalConnections.set(host, next);
  host.lastError = null;
  host.hello = null;
  host.connected = false;
  host.execApprovalQueue = same
    ? host.execApprovalQueue.filter(
        (entry) =>
          entry.request.sessionKey === `terminal:${host.terminal.session?.sessionId}` &&
          entry.expiresAtMs > Date.now(),
      )
    : [];
  host.execApprovalError = null;

  host.client?.stop();
  const client = new GatewayBrowserClient({
    url: host.settings.gatewayUrl,
    token: host.settings.token.trim() ? host.settings.token : undefined,
    password: host.password.trim() ? host.password : undefined,
    clientName: "kolo-control-ui",
    mode: "webchat",
    onHello: (hello) => {
      if (host.client !== client) {
        return;
      }
      host.connected = true;
      host.lastError = null;
      host.hello = hello;
      void replayTerminal(host);
      applySnapshot(host, hello);
      // Reset orphaned chat run state from before disconnect.
      // Any in-flight run's final event was lost during the disconnect window.
      host.chatRunId = null;
      (host as unknown as { chatStream: string | null }).chatStream = null;
      (host as unknown as { chatStreamStartedAt: number | null }).chatStreamStartedAt = null;
      (host as unknown as { chatStreamReasoning: unknown }).chatStreamReasoning = null;
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      void loadAssistantIdentity(host as unknown as KoLoApp);
      void loadAgents(host as unknown as KoLoApp);
      void loadNodes(host as unknown as KoLoApp, { quiet: true });
      void loadDevices(host as unknown as KoLoApp, { quiet: true });
      void loadOrgLocale(host);
      // The role is known now: a business user on a page outside the role filter goes Home.
      const settingsHost = host as unknown as Parameters<typeof guardTab>[0];
      const allowed = guardTab(settingsHost, settingsHost.tab);
      if (allowed !== settingsHost.tab) {
        setTabFromRoute(settingsHost, allowed);
        syncUrlWithTab(settingsHost, allowed, true);
        return;
      }
      void refreshActiveTab(host as unknown as Parameters<typeof refreshActiveTab>[0]);
    },
    onClose: ({ code, reason }) => {
      if (host.client !== client) {
        return;
      }
      host.connected = false;
      resetBusiness(host as unknown as KoLoApp);
      cancelVoice(host);
      disconnectTerminal(host);
      // Code 1012 = Service Restart (expected during config saves, don't show as error)
      if (code !== 1012) {
        host.lastError = `disconnected (${code}): ${reason || "no reason"}`;
      }
    },
    onEvent: (evt) => {
      if (host.client === client) {
        handleGatewayEvent(host, evt);
      }
    },
    onGap: ({ expected, received }) => {
      if (host.client !== client) {
        return;
      }
      void replayTerminal(host);
      void loadBusiness(host as unknown as KoLoApp);
      host.lastError = `event gap detected (expected seq ${expected}, got ${received}); refresh recommended`;
    },
  });
  host.client = client;
  client.start();
}

export function handleGatewayEvent(host: GatewayHost, evt: GatewayEventFrame) {
  try {
    handleGatewayEventUnsafe(host, evt);
  } catch (err) {
    console.error("[gateway] handleGatewayEvent error:", evt.event, err);
  }
}

function handleGatewayEventUnsafe(host: GatewayHost, evt: GatewayEventFrame) {
  if (evt.event === "workitems.changed") {
    businessEvent(host as unknown as KoLoApp, evt.payload);
    return;
  }
  // Audio and transcripts are ephemeral and must never enter the debug event history.
  if (evt.event.startsWith("voice.")) {
    voiceEvent(host, evt.event, evt.payload);
    return;
  }
  if (evt.event === "terminal.event") {
    terminalEvent(host, evt.payload);
    return;
  }
  host.eventLogBuffer = [
    { ts: Date.now(), event: evt.event, payload: evt.payload },
    ...host.eventLogBuffer,
  ].slice(0, 250);
  if (host.tab === "debug") {
    host.eventLog = host.eventLogBuffer;
  }

  if (evt.event === "agent") {
    if (host.onboarding) {
      return;
    }
    handleAgentEvent(
      host as unknown as Parameters<typeof handleAgentEvent>[0],
      evt.payload as AgentEventPayload | undefined,
    );
    return;
  }

  if (evt.event === "chat") {
    const payload = evt.payload as ChatEventPayload | undefined;
    if (payload?.sessionKey) {
      setLastActiveSessionKey(
        host as unknown as Parameters<typeof setLastActiveSessionKey>[0],
        payload.sessionKey,
      );
    }
    const state = handleChatEvent(host as unknown as KoLoApp, payload);
    if (state === "final" || state === "error" || state === "aborted") {
      resetToolStream(host as unknown as Parameters<typeof resetToolStream>[0]);
      void flushChatQueueForEvent(host as unknown as Parameters<typeof flushChatQueueForEvent>[0]);
      const runId = payload?.runId;
      if (runId && host.refreshSessionsAfterChat.has(runId)) {
        host.refreshSessionsAfterChat.delete(runId);
        if (state === "final") {
          void loadSessions(host as unknown as KoLoApp, {
            activeMinutes: CHAT_SESSIONS_ACTIVE_MINUTES,
          });
        }
      }
    }
    if (state === "final") {
      void loadChatHistory(host as unknown as KoLoApp);
      // v0.3: a first message creates the conversation; show it in the history panel.
      void loadChatHistoryPanel(host as unknown as KoLoApp);
    }
    return;
  }

  if (evt.event === "presence") {
    const payload = evt.payload as { presence?: PresenceEntry[] } | undefined;
    if (payload?.presence && Array.isArray(payload.presence)) {
      host.presenceEntries = payload.presence;
      host.presenceError = null;
      host.presenceStatus = null;
    }
    return;
  }

  if (evt.event === "cron" && host.tab === "cron") {
    void loadCron(host as unknown as Parameters<typeof loadCron>[0]);
  }

  if (evt.event === "device.pair.requested" || evt.event === "device.pair.resolved") {
    void loadDevices(host as unknown as KoLoApp, { quiet: true });
  }

  if (evt.event === "exec.approval.requested") {
    const entry = parseExecApprovalRequested(evt.payload);
    if (entry) {
      host.execApprovalQueue = addExecApproval(host.execApprovalQueue, entry);
      host.execApprovalError = null;
      const delay = Math.max(0, entry.expiresAtMs - Date.now() + 500);
      window.setTimeout(() => {
        host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, entry.id);
      }, delay);
    }
    return;
  }

  if (evt.event === "exec.approval.resolved") {
    const resolved = parseExecApprovalResolved(evt.payload);
    if (resolved) {
      const ent = host as unknown as { enterprise?: EnterpriseState };
      if (ent.enterprise) {
        ent.enterprise = {
          ...ent.enterprise,
          approvalHistory: recordApprovalDecision(
            ent.enterprise.approvalHistory,
            host.execApprovalQueue,
            resolved,
          ),
        };
      }
      host.execApprovalQueue = removeExecApproval(host.execApprovalQueue, resolved.id);
    }
  }
}

export function applySnapshot(host: GatewayHost, hello: GatewayHelloOk) {
  const snapshot = hello.snapshot as
    | {
        presence?: PresenceEntry[];
        health?: HealthSnapshot;
        sessionDefaults?: SessionDefaultsSnapshot;
      }
    | undefined;
  if (snapshot?.presence && Array.isArray(snapshot.presence)) {
    host.presenceEntries = snapshot.presence;
  }
  if (snapshot?.health) {
    host.debugHealth = snapshot.health;
  }
  if (snapshot?.sessionDefaults) {
    applySessionDefaults(host, snapshot.sessionDefaults);
  }
}

/**
 * Organisation default locale: `gateway.controlUi.defaultLocale` in the config. Read quietly; a
 * credential that may not read the config simply keeps the OS locale.
 */
async function loadOrgLocale(host: GatewayHost) {
  const client = (
    host as unknown as { client?: { request: (m: string, p: unknown) => Promise<unknown> } | null }
  ).client;
  if (!client) {
    return;
  }
  try {
    const res = (await client.request("config.get", {})) as {
      config?: { gateway?: { controlUi?: { defaultLocale?: unknown } } };
    };
    const locale = res?.config?.gateway?.controlUi?.defaultLocale;
    (host as unknown as { orgLocale: string | null }).orgLocale =
      typeof locale === "string" ? matchLocale([locale]) : null;
  } catch {
    (host as unknown as { orgLocale: string | null }).orgLocale = null;
  }
}
