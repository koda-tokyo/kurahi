import type { Duplex } from "node:stream";
import type { TlsOptions } from "node:tls";
import type { WebSocketServer } from "ws";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAgentAvatar } from "../agents/identity-avatar.js";
import { auditHttpAuthFailure } from "../audit/http.js";
import { handleA2uiHttpRequest } from "../canvas-host/a2ui.js";
import { type KoLoConfig, loadConfig } from "../config/config.js";
import { authorizeSsoSession, createSsoHttpHandlers, getHttpPerson } from "../identity/http.js";
import { createScimHandler } from "../identity/scim.js";
import { getIdentityService } from "../identity/service.js";
import { getPolicyEngine } from "../policy/engine.js";
import { handleSlackHttpRequest, listSlackHttpPaths } from "../slack/http/index.js";
import { VERSION } from "../version.js";
import { handleAdminApiRequest } from "./admin-api.js";
import { handleAdminCovenantRequest } from "./admin-covenant.js";
import { getAdminSessionUser, getCurrentUser, handleAuthApiRequest } from "./auth-api.js";
import { isLocalDirectRequest } from "./auth.js";
import { createCodeModeHttpHandlers } from "./code-mode-http.js";
import { createContinuityHttpHandlers } from "./continuity-http.js";
import { handleControlUiAvatarRequest, handleControlUiHttpRequest } from "./control-ui.js";
import { handleHealthRequest, PACKAGE_VERSION } from "./health.js";
import { applyHookMappings } from "./hooks-mapping.js";
import {
  extractHookToken,
  getHookChannelError,
  type HookMessageChannel,
  type HooksConfigResolved,
  normalizeAgentPayload,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  resolveHookChannel,
  resolveHookDeliver,
} from "./hooks.js";
import { isProtectedAdminPath, rejectUnauthorizedAdminRequest } from "./http-admin-auth.js";
import { createChannelsHttpHandlers } from "./http-channels.js";
import { sendForbidden, sendUnauthorized } from "./http-common.js";
import { DOC_VIEWER_CSP, DOC_VIEWER_HTML } from "./http-doc-viewer.js";
import { createEvidenceHttpHandlers } from "./http-evidence.js";
import { createFactoryHttpHandlers } from "./http-factory.js";
import { cancelJobHandler, getJobHandler, listJobsHandler } from "./http-jobs.js";
import { type BoundRoute, HTTP_METHODS, type HttpMethod } from "./http-registry.js";
import {
  applyAuthAttemptGate,
  isRemoteGatedPath,
  isRemoteUpgradeAuthorized,
  rejectUnauthenticatedRemoteRequest,
  resolveAttemptKey,
  upgradePathname,
} from "./http-remote-auth.js";
import { SCIM_OPERATION_IDS } from "./http-routes-identity.js";
import { createGatewayRouter } from "./http-routes.js";
import { mayUseSharedSecret } from "./http-shared-secret.js";
import { createSnapshotsHttpHandlers } from "./http-snapshots.js";
import { getBearerToken } from "./http-utils.js";
import { handleMetricsRequest } from "./metrics.js";
import { handleMigrateRequest, handleBootstrapInviteRequest } from "./migrate-api.js";
import { handleOpenAiHttpRequest } from "./openai-http.js";
import { handleOpenResponsesHttpRequest } from "./openresponses-http.js";
import {
  authorizeHttpBearer,
  clearHttpPrincipal,
  getHttpPrincipal,
  isPairAccessToken,
} from "./pair-auth.js";
import { createPairHttpHandlers } from "./pair-http.js";
import { getCredentialStore, storeOptionsFromConfig } from "./pair-store.js";
import { createPluginsHttpHandlers } from "./plugins-http.js";
import { createPolicyHttpHandlers } from "./policy-http.js";
import { checkHttpRateLimit, decideWsConnectionRateLimit } from "./rate-limiter.js";
import { routeMinScope } from "./scopes.js";
import { GATEWAY_EVENTS, listGatewayMethods } from "./server-methods-list.js";
import { createSessionsHttpHandlers } from "./sessions-http.js";
import { handleToolsInvokeHttpRequest } from "./tools-invoke-http.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: {
    message: string;
    name: string;
    wakeMode: "now" | "next-heartbeat";
    sessionKey: string;
    deliver: boolean;
    channel: HookMessageChannel;
    to?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
    allowUnsafeExternalContent?: boolean;
  }) => string;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, bindHost, port, logHooks, dispatchAgentHook, dispatchWakeHook } = opts;
  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    const url = new URL(req.url ?? "/", `http://${bindHost}:${port}`);
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    const { token, fromQuery } = extractHookToken(req, url);
    if (!token || token !== hooksConfig.token) {
      auditHttpAuthFailure(req, 401, "hooks token");
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }
    if (fromQuery) {
      logHooks.warn(
        "Hook token provided via query parameter is deprecated for security reasons. " +
          "Tokens in URLs appear in logs, browser history, and referrer headers. " +
          "Use Authorization: Bearer <token> or X-kolo-Token header instead.",
      );
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status = body.error === "payload too large" ? 413 : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      const runId = dispatchAgentHook(normalized.value);
      sendJson(res, 202, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            wakeMode: mapped.action.wakeMode,
            sessionKey: mapped.action.sessionKey ?? "",
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
          });
          sendJson(res, 202, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}

export type PluginHttpRouteInfo = {
  path: string;
  pluginId?: string;
  methods?: string[];
  summary?: string;
  description?: string;
};

function pluginOperationId(prefix: string, method: string, path: string): string {
  const words = `${method.toLowerCase()} ${path}`.split(/[^A-Za-z0-9]+/).filter(Boolean);
  return prefix + words.map((w) => w[0].toUpperCase() + w.slice(1)).join("");
}

/** Declared-only operations for webhook routes registered at runtime (live GET /doc). */
export function describeRuntimeHttpRoutes(params: {
  pluginRoutes: readonly PluginHttpRouteInfo[];
  slackPaths: readonly string[];
  staticPaths: ReadonlySet<string>;
}): BoundRoute[] {
  const out: BoundRoute[] = [];
  const seen = new Set<string>();
  const add = (route: BoundRoute) => {
    const key = `${route.method} ${route.path}`;
    if (params.staticPaths.has(route.path) || seen.has(key) || !route.path.startsWith("/")) {
      return;
    }
    seen.add(key);
    out.push(route);
  };
  for (const entry of params.pluginRoutes) {
    const methods = entry.methods?.length ? entry.methods : ["POST"];
    for (const raw of methods) {
      const method = raw.toUpperCase() as HttpMethod;
      if (!HTTP_METHODS.includes(method)) {
        continue;
      }
      add({
        method,
        // Template braces in a plugin path would read as parameters; keep them literal.
        path: entry.path.replace(/[{}]/g, ""),
        operationId: pluginOperationId("plugin", method, entry.path),
        summary: entry.summary?.trim() || `Plugin webhook (${entry.pluginId ?? "unknown plugin"})`,
        ...(entry.description ? { description: entry.description } : {}),
        tags: ["plugins"],
        auth: "plugin",
        authEnforcedBy: "handler",
        servedBy: "plugin-http",
        responses: { 200: { description: "Handled by the plugin." } },
        extensions: { "x-kolo-plugin": entry.pluginId ?? "unknown", "x-kolo-runtime": true },
      });
    }
  }
  for (const path of params.slackPaths) {
    add({
      method: "POST",
      path: path.replace(/[{}]/g, ""),
      operationId: pluginOperationId("slack", "POST", path),
      summary: "Slack Events API webhook",
      description: "Verified with the Slack signing secret by the channel.",
      tags: ["plugins"],
      auth: "plugin",
      authEnforcedBy: "handler",
      servedBy: "slack-webhooks",
      responses: { 200: { description: "Handled by the Slack channel." } },
      extensions: { "x-kolo-plugin": "slack", "x-kolo-runtime": true },
    });
  }
  return out;
}

// Break-glass over HTTP lives with the shared-secret check; re-exported for existing callers.
export { BREAK_GLASS_HEADER, httpBreakGlass } from "./http-shared-secret.js";

export function createGatewayHttpServer(opts: {
  canvasHost: CanvasHostHandler | null;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  openAiChatCompletionsEnabled: boolean;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  handleHooksRequest: HooksRequestHandler;
  handlePluginRequest?: HooksRequestHandler;
  /** Plugin webhook routes registered at runtime, for the live GET /doc. */
  listPluginHttpRoutes?: () => readonly PluginHttpRouteInfo[];
  resolvedAuth: import("./auth.js").ResolvedGatewayAuth;
  tlsOptions?: TlsOptions;
}): HttpServer {
  const {
    canvasHost,
    controlUiEnabled,
    controlUiBasePath,
    openAiChatCompletionsEnabled,
    openResponsesEnabled,
    openResponsesConfig,
    handleHooksRequest,
    handlePluginRequest,
    resolvedAuth,
  } = opts;
  // Per-request config (trusted proxies, identity, avatars): loaded once per request in
  // handleRequest and carried by AsyncLocalStorage, so concurrent requests never read each
  // other's snapshot across an await.
  const requestConfig = new AsyncLocalStorage<KoLoConfig>();
  const configSnapshot = (): KoLoConfig => requestConfig.getStore() ?? loadConfig();
  const trustedProxies = () => configSnapshot().gateway?.trustedProxies ?? [];

  // Pairing store (M3a): created from `gateway.pairing` on the first request that needs it.
  const credentialStore = () =>
    getCredentialStore(storeOptionsFromConfig(configSnapshot().gateway?.pairing));
  // SSO required (gateway.identity.ssoRequired): the shared secret and pairing credentials work
  // over HTTP only from the gateway host itself, the shared secret only as audited break-glass;
  // people elsewhere use their SSO session. One check for every gate: mayUseSharedSecret.
  const sharedSecretGate = () => ({
    ssoRequired: getIdentityService(configSnapshot()).settings.ssoRequired,
    trustedProxies: trustedProxies(),
  });
  const gatewayTokenOk = async (req: IncomingMessage, route?: BoundRoute) => {
    const bearer = getBearerToken(req);
    if (isPairAccessToken(bearer)) {
      return false; // handled by the pair-credential authenticator
    }
    const result = await authorizeHttpBearer(req, {
      auth: resolvedAuth,
      trustedProxies: trustedProxies(),
    });
    if (!result.ok) {
      return false;
    }
    const accepted = mayUseSharedSecret(req, sharedSecretGate(), {
      credential: "shared-secret",
      operation: route?.operationId ?? null,
    });
    if (!accepted) {
      clearHttpPrincipal(req);
    }
    return accepted;
  };
  const pairCredentialOk = async (req: IncomingMessage, route: BoundRoute) => {
    const bearer = getBearerToken(req);
    if (!isPairAccessToken(bearer)) {
      return false;
    }
    const result = await authorizeHttpBearer(req, {
      auth: resolvedAuth,
      trustedProxies: trustedProxies(),
      minScope: routeMinScope(route),
      store: credentialStore(),
    });
    if (result.ok) {
      const accepted = mayUseSharedSecret(req, sharedSecretGate(), {
        credential: "pairing",
        operation: route.operationId,
      });
      if (!accepted) {
        clearHttpPrincipal(req);
      }
      return accepted;
    }
    if (result.status === 403) {
      auditHttpAuthFailure(req, 403, result.reason);
      return "forbidden" as const;
    }
    return false;
  };
  // Canvas / A2UI / avatars from another host: an SSO session of a person who may observe.
  const remoteSsoSession = (req: IncomingMessage) =>
    authorizeSsoSession(
      req,
      { operationId: "remote-gated", minScope: "observe" },
      getIdentityService(configSnapshot()),
    ) === true;
  const pairHandlers = createPairHttpHandlers({ store: undefined, resolveStore: credentialStore });
  const sessionsHandlers = createSessionsHttpHandlers();
  const snapshotsHandlers = createSnapshotsHttpHandlers();
  const codeModeHandlers = createCodeModeHttpHandlers();
  const pluginsHttpHandlers = createPluginsHttpHandlers();
  const continuityHandlers = createContinuityHttpHandlers({ gatewayVersion: PACKAGE_VERSION });
  const evidenceHandlers = createEvidenceHttpHandlers({ gatewayVersion: PACKAGE_VERSION });
  const policyHttpHandlers = createPolicyHttpHandlers();
  // M15: the factory reads the per-request config snapshot (kipEngine, factory, evidence).
  const factoryHandlers = createFactoryHttpHandlers({
    getConfig: () => configSnapshot(),
    gatewayVersion: PACKAGE_VERSION,
  });
  const channelsHandlers = createChannelsHttpHandlers();
  // Sign-in return targets: console routes only, never a path the gateway itself serves (API,
  // canvas / A2UI, avatars, plugin and channel webhooks, hooks), where another page's script
  // could read the fragment.
  const isGatewayPath = (pathname: string) => {
    const under = (prefix: string) => {
      const p = prefix.replace(/\/+$/, "");
      return p !== "" && (pathname === p || pathname.startsWith(`${p}/`));
    };
    const hooksPath = configSnapshot().hooks?.path?.trim() || "/hooks";
    return (
      staticPaths.has(pathname) ||
      isRemoteGatedPath(pathname, controlUiBasePath) ||
      isProtectedAdminPath(pathname) ||
      under(hooksPath.startsWith("/") ? hooksPath : `/${hooksPath}`) ||
      listSlackHttpPaths().some(under) ||
      (opts.listPluginHttpRoutes?.() ?? []).some((r) => under(r.path))
    );
  };
  const ssoHandlers = createSsoHttpHandlers({
    service: () => getIdentityService(configSnapshot()),
    attemptKey: (req) =>
      isLocalDirectRequest(req, trustedProxies()) ? null : resolveAttemptKey(req, trustedProxies()),
    consoleBasePath: controlUiBasePath,
    isGatewayPath,
  });
  const scim = createScimHandler({ service: () => getIdentityService(configSnapshot()) });
  const scimHandlers = Object.fromEntries(
    SCIM_OPERATION_IDS.map((id) => [
      id,
      (req: IncomingMessage, res: ServerResponse) => scim.handle(req, res),
    ]),
  );
  const adminApi = async (req: IncomingMessage, res: ServerResponse) => {
    const currentUser = await getCurrentUser(req);
    return await handleAdminApiRequest(req, res, { userId: currentUser?.id });
  };

  const router = createGatewayRouter(
    {
      handlers: {
        getHealth: (req, res) =>
          handleHealthRequest(req, res, {
            authorize: async (request) =>
              (
                await authorizeHttpBearer(request, {
                  auth: resolvedAuth,
                  trustedProxies: trustedProxies(),
                  minScope: "observe",
                })
              ).ok,
          }),
        getBuildHealth: (req, res) => handleHealthRequest(req, res),
        getMetrics: (req, res) => handleMetricsRequest(req, res),
        getOpenApiDocument: (_req, res) => {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.end(JSON.stringify(buildLiveDocument()));
        },
        getApiViewer: (_req, res) => {
          res.statusCode = 200;
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Content-Security-Policy", DOC_VIEWER_CSP);
          res.setHeader("X-Content-Type-Options", "nosniff");
          res.end(DOC_VIEWER_HTML);
        },
        runDatabaseMigration: (req, res) => handleMigrateRequest(req, res),
        createBootstrapInvite: (req, res) => handleBootstrapInviteRequest(req, res),
        invokeTool: (req, res) =>
          handleToolsInvokeHttpRequest(req, res, {
            auth: resolvedAuth,
            trustedProxies: trustedProxies(),
          }),
        listCovenants: (req, res) => handleAdminCovenantRequest(req, res),
        getCovenant: (req, res) => handleAdminCovenantRequest(req, res),
        createInvite: (req, res) => handleAuthApiRequest(req, res),
        listInvites: (req, res) => handleAuthApiRequest(req, res),
        redeemInvite: (req, res) => handleAuthApiRequest(req, res),
        getSessionUser: (req, res) => handleAuthApiRequest(req, res),
        logout: (req, res) => handleAuthApiRequest(req, res),
        getAdminStatus: adminApi,
        listAuditEvents: adminApi,
        listJobs: (req, res, ctx) => listJobsHandler(req, res, ctx),
        getJob: (req, res, ctx) => getJobHandler(req, res, ctx),
        cancelJob: (req, res, ctx) => cancelJobHandler(req, res, ctx),
        getJobEvidence: evidenceHandlers.getJobEvidence,
        listJobEvidenceEvents: evidenceHandlers.listJobEvidenceEvents,
        exportJobEvidence: evidenceHandlers.exportJobEvidence,
        getEvidenceView: evidenceHandlers.getEvidenceView,
        listFactoryBoards: factoryHandlers.listFactoryBoards,
        listFactoryCards: factoryHandlers.listFactoryCards,
        createFactoryCard: factoryHandlers.createFactoryCard,
        getFactoryCard: factoryHandlers.getFactoryCard,
        moveFactoryCard: factoryHandlers.moveFactoryCard,
        runFactoryCard: factoryHandlers.runFactoryCard,
        cancelFactoryCard: factoryHandlers.cancelFactoryCard,
        getFactoryView: factoryHandlers.getFactoryView,
        postWebhookInbound: channelsHandlers.postWebhookInbound,
        getChannelsDeliveryStatus: channelsHandlers.getChannelsDeliveryStatus,
        getContinuityManifest: continuityHandlers.getContinuityManifest,
        recallMemory: continuityHandlers.recallMemory,
        getAuditChain: continuityHandlers.getAuditChain,
        getPolicyStatus: policyHttpHandlers.getPolicyStatus,
        killPolicy: policyHttpHandlers.killPolicy,
        releasePolicy: policyHttpHandlers.releasePolicy,
        listWorkspaces: adminApi,
        listUsers: adminApi,
        createPairInvitation: pairHandlers.createPairInvitation,
        listPairInvitations: pairHandlers.listPairInvitations,
        revokePairInvitation: pairHandlers.revokePairInvitation,
        createPairNonce: pairHandlers.createPairNonce,
        redeemPairInvitation: pairHandlers.redeemPairInvitation,
        refreshPairCredential: pairHandlers.refreshPairCredential,
        getPairPrincipal: pairHandlers.getPairPrincipal,
        listPairDevices: pairHandlers.listPairDevices,
        approvePairDevice: pairHandlers.approvePairDevice,
        revokePairDevice: pairHandlers.revokePairDevice,
        listSessions: sessionsHandlers.listSessions,
        getSession: sessionsHandlers.getSession,
        listSnapshots: snapshotsHandlers.listSnapshots,
        restoreSnapshot: snapshotsHandlers.restoreSnapshot,
        runCodeMode: codeModeHandlers.runCodeMode,
        listMcpServers: codeModeHandlers.listMcpServers,
        listPlugins: pluginsHttpHandlers.listPlugins,
        reloadPlugin: pluginsHttpHandlers.reloadPlugin,
        createResponse: (req, res) =>
          handleOpenResponsesHttpRequest(req, res, {
            auth: resolvedAuth,
            config: openResponsesConfig,
            trustedProxies: trustedProxies(),
          }),
        getSsoConfig: ssoHandlers.getSsoConfig,
        startSsoLogin: ssoHandlers.startSsoLogin,
        ssoCallback: ssoHandlers.ssoCallback,
        samlAcs: ssoHandlers.samlAcs,
        getSamlMetadata: ssoHandlers.samlMetadata,
        exchangeSsoCode: ssoHandlers.exchangeSsoCode,
        getIdentitySession: ssoHandlers.getIdentitySession,
        logoutIdentity: ssoHandlers.logoutIdentity,
        ...scimHandlers,
        createChatCompletion: (req, res) =>
          handleOpenAiHttpRequest(req, res, {
            auth: resolvedAuth,
            trustedProxies: trustedProxies(),
          }),
      },
      enabled: {
        createResponse: () => openResponsesEnabled,
        createChatCompletion: () => openAiChatCompletionsEnabled,
      },
      mounts: {
        hooks: (req, res) => handleHooksRequest(req, res),
        "slack-webhooks": (req, res) => handleSlackHttpRequest(req, res),
        // Same order as the pre-registry chain: covenants, invites/auth, admin API.
        "admin-fallback": async (req, res) => {
          if (!isProtectedAdminPath(new URL(req.url ?? "/", "http://localhost").pathname)) {
            return false;
          }
          return (
            (await handleAdminCovenantRequest(req, res)) ||
            (await handleAuthApiRequest(req, res)) ||
            (await adminApi(req, res))
          );
        },
        "plugin-http": async (req, res) =>
          handlePluginRequest ? await handlePluginRequest(req, res) : false,
        a2ui: async (req, res) => (canvasHost ? await handleA2uiHttpRequest(req, res) : false),
        "canvas-host": async (req, res) =>
          canvasHost ? await canvasHost.handleHttpRequest(req, res) : false,
        "control-ui-avatar": (req, res) =>
          controlUiEnabled &&
          handleControlUiAvatarRequest(req, res, {
            basePath: controlUiBasePath,
            resolveAvatar: (agentId) => resolveAgentAvatar(configSnapshot(), agentId),
          }),
        "control-ui": (req, res) =>
          controlUiEnabled &&
          handleControlUiHttpRequest(req, res, {
            basePath: controlUiBasePath,
            config: configSnapshot(),
          }),
      },
    },
    {
      authenticators: {
        "gateway-token": gatewayTokenOk,
        "pair-credential": pairCredentialOk,
        "session-admin": async (req, route) =>
          Boolean(await getAdminSessionUser(req)) &&
          mayUseSharedSecret(req, sharedSecretGate(), {
            credential: "legacy-session",
            operation: route.operationId,
          }),
        "sso-session": (req, route) =>
          authorizeSsoSession(
            req,
            { operationId: route.operationId, minScope: routeMinScope(route) },
            getIdentityService(configSnapshot()),
          ),
        "scim-token": (req) => scim.authorize(req),
      },
      onUnauthorized: (_req, res) => sendUnauthorized(res),
      onForbidden: (_req, res) => sendForbidden(res),
      // M13: after auth, every HTTP operation is a policy decision point (kill switch on
      // agent-driving operations, `requests.deny` by operationId and credential scope).
      policyGate: (req, route) => {
        const decision = getPolicyEngine().evaluate("request", {
          surface: "http",
          operation: route.operationId,
          scope: getHttpPrincipal(req)?.scope ?? getHttpPerson(req)?.scope ?? "owner",
        });
        return decision.effect === "allow"
          ? { ok: true }
          : { ok: false, rule: decision.ruleId, reason: decision.reason };
      },
    },
  );
  const staticPaths = new Set(router.routes().map((r) => r.path));

  function buildLiveDocument() {
    return router.toOpenAPI({
      version: VERSION,
      websocket: { methods: listGatewayMethods(), events: GATEWAY_EVENTS },
      runtimeRoutes: describeRuntimeHttpRoutes({
        pluginRoutes: opts.listPluginHttpRoutes?.() ?? [],
        slackPaths: listSlackHttpPaths(),
        staticPaths,
      }),
    });
  }

  // A failure outside the per-route try (config load, rate limiter) answers 503 instead of
  // becoming an unhandled rejection that takes the process down.
  const onRequest = (req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res).catch(() => sendServiceUnavailable(res));
  };
  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, onRequest)
    : createHttpServer(onRequest);

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if (String(req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }
    let config: KoLoConfig;
    try {
      config = loadConfig();
    } catch {
      sendServiceUnavailable(res);
      return;
    }
    await requestConfig.run(config, () => handleConfiguredRequest(req, res));
  }

  async function handleConfiguredRequest(req: IncomingMessage, res: ServerResponse) {
    // ── Rate limiting (Gateway v3 — Phase 1 hardening) ──────────────────
    if (!checkHttpRateLimit(req, res, trustedProxies())) {
      return; // 429 already written by rate limiter
    }

    try {
      // Liveness routes (/health, /api/health): open, before the credential gates.
      if (await router.dispatch(req, res, { stage: "pre-auth" })) {
        return;
      }
      // Credential attempts: 20/min per source on auth-bearing requests (M2a)
      if (applyAuthAttemptGate(req, res, { trustedProxies: trustedProxies() })) {
        return;
      }
      // Canvas / A2UI / avatars: gateway auth for non-local clients (M2a)
      if (
        await rejectUnauthenticatedRemoteRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies: trustedProxies(),
          controlUiBasePath,
          ssoRequired: sharedSecretGate().ssoRequired,
          ssoSession: remoteSsoSession,
        })
      ) {
        return;
      }
      // /metrics and /api/admin/*: gateway token (Bearer) or admin kolo_session required. Kept as
      // a prefix gate so unknown /api/admin subpaths never answer before auth.
      if (
        await rejectUnauthorizedAdminRequest(req, res, {
          auth: resolvedAuth,
          trustedProxies: trustedProxies(),
          ssoRequired: sharedSecretGate().ssoRequired,
        })
      ) {
        return;
      }
      // Registry (M4a): hooks dispatcher, then declared routes, then the remaining mounts.
      if (await router.dispatchMounts(req, res, "before-routes")) {
        return;
      }
      if (await router.dispatch(req, res, { stage: "main" })) {
        return;
      }
      if (await router.dispatchMounts(req, res, "after-routes")) {
        return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch {
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  resolvedAuth?: import("./auth.js").ResolvedGatewayAuth;
}) {
  const { httpServer, wss, canvasHost, resolvedAuth } = opts;
  // A throwing config load or gate refuses the upgrade (503) instead of crashing the process.
  httpServer.on("upgrade", (req, socket, head) => {
    try {
      handleUpgrade(req, socket, head);
    } catch {
      refuseUpgrade(socket);
    }
  });

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    // ── WebSocket connection rate limiting (Gateway v3 — Phase 1 hardening)
    const configSnapshot = loadConfig();
    const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
    const rate = decideWsConnectionRateLimit(req, trustedProxies);
    if (!rate.allowed) {
      if (!rate.explain) {
        socket.destroy();
        return;
      }
      // Tell the client why (1013 = try again later) instead of a bare 1006. The connection is
      // never handed to the gateway: no "connection" event, no auth, no messages.
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.close(1013, rate.reason);
      });
      return;
    }

    // Canvas live-reload WS: same gate as the canvas HTTP routes for non-local clients (M2a).
    if (canvasHost && resolvedAuth && isRemoteGatedPath(upgradePathname(req))) {
      void (async () => {
        const identity = getIdentityService(configSnapshot);
        const allowed = await isRemoteUpgradeAuthorized(req, resolvedAuth, trustedProxies, {
          ssoRequired: identity.settings.ssoRequired,
          ssoSession: (r) =>
            authorizeSsoSession(
              r,
              { operationId: "remote-gated", minScope: "observe" },
              identity,
            ) === true,
        });
        if (!allowed) {
          socket.destroy();
          return;
        }
        if (!canvasHost.handleUpgrade(req, socket, head)) {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
          });
        }
      })().catch(() => refuseUpgrade(socket));
      return;
    }
    if (canvasHost?.handleUpgrade(req, socket, head)) {
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
}

/** 503 for a request whose handling failed outside the route handlers (headers permitting). */
function sendServiceUnavailable(res: ServerResponse): void {
  try {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Retry-After", "5");
    res.end("Service Unavailable");
  } catch {
    // the socket is already gone
  }
}

/** Refuse a WebSocket upgrade with a plain 503 and close the socket. */
function refuseUpgrade(socket: Duplex): void {
  try {
    if (socket.writable) {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    }
  } catch {
    // ignore
  }
  socket.destroy();
}
