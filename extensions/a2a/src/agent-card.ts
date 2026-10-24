import type { A2aExposedAgent, A2aServerConfig } from "./config.js";
import type { Dialect } from "./protocol.js";

// Agent Cards are built only from operator-written config: public name, description, version,
// skills and the endpoint URL. Nothing from the runtime (agent id, workspace, model, provider,
// tool list) is ever read here, so nothing internal can leak through discovery.

export const CARD_PATH = "/.well-known/agent-card.json";
export const SECURITY_SCHEME = "bearer";
const INPUT_MODES = ["text/plain", "application/json"];
const OUTPUT_MODES = ["text/plain"];

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::\d{1,5})?$/i;

/** Base URL for links on the card: the operator's publicUrl, else a loopback Host, else 127.0.0.1. */
export function resolveBaseUrl(
  server: Pick<A2aServerConfig, "publicUrl">,
  hostHeader: string | undefined,
  fallbackPort: number,
): string {
  if (server.publicUrl) {
    return server.publicUrl.replace(/\/+$/, "");
  }
  const host = hostHeader?.trim();
  if (host && LOOPBACK_HOST.test(host)) {
    return `http://${host}`;
  }
  return `http://127.0.0.1:${fallbackPort}`;
}

export function rpcPath(server: Pick<A2aServerConfig, "basePath">, slug: string): string {
  return `${server.basePath}/${slug}`;
}

export function cardPath(server: Pick<A2aServerConfig, "basePath">, slug: string): string {
  return `${rpcPath(server, slug)}${CARD_PATH}`;
}

function skills(agent: A2aExposedAgent) {
  return agent.skills.map((skill) => ({
    id: skill.id,
    name: skill.name,
    description: skill.description,
    tags: skill.tags,
    ...(skill.examples?.length ? { examples: skill.examples } : {}),
  }));
}

export function buildAgentCard(params: {
  server: Pick<A2aServerConfig, "basePath" | "streaming" | "provider" | "publicUrl">;
  agent: A2aExposedAgent;
  baseUrl: string;
  dialect: Dialect;
}) {
  const { server, agent, baseUrl, dialect } = params;
  const url = `${baseUrl}${rpcPath(server, agent.slug)}`;
  const provider = server.provider
    ? { organization: server.provider.organization, url: server.provider.url }
    : undefined;
  const common = {
    name: agent.name,
    description: agent.description,
    version: agent.version,
    ...(provider ? { provider } : {}),
    defaultInputModes: INPUT_MODES,
    defaultOutputModes: OUTPUT_MODES,
    skills: skills(agent),
  };
  if (dialect === "1.0") {
    return {
      ...common,
      supportedInterfaces: [
        { url, protocolBinding: "JSONRPC", protocolVersion: "1.0" },
        { url, protocolBinding: "JSONRPC", protocolVersion: "0.3" },
      ],
      capabilities: {
        streaming: server.streaming,
        pushNotifications: false,
        extendedAgentCard: false,
      },
      securitySchemes: {
        [SECURITY_SCHEME]: {
          httpAuthSecurityScheme: { scheme: "Bearer", description: "Per-client bearer token" },
        },
      },
      securityRequirements: [{ schemes: { [SECURITY_SCHEME]: { list: [] } } }],
    };
  }
  return {
    protocolVersion: "0.3.0",
    ...common,
    url,
    preferredTransport: "JSONRPC",
    additionalInterfaces: [{ url, transport: "JSONRPC" }],
    capabilities: {
      streaming: server.streaming,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    securitySchemes: {
      [SECURITY_SCHEME]: {
        type: "http",
        scheme: "bearer",
        description: "Per-client bearer token",
      },
    },
    security: [{ [SECURITY_SCHEME]: [] }],
  };
}
