import type { A2aExposedAgent, A2aServerConfig } from "./config.js";
import { API_KEY_HEADER, rpcPath } from "./agent-card.js";
import { A2aRpcError, optionalId, RpcError } from "./protocol.js";

// Plain JSON "ask" endpoint and its OpenAPI 3.0 description, for callers that import tools from
// an OpenAPI document rather than speaking A2A (server.rest, off by default). It is a thin front
// on the same task path as message/send: same gate, tokens, allowlist, limits, isolated session
// and untrusted wrapping. The document follows the constraints common OpenAPI tool importers
// impose: OpenAPI 3.0, exactly one server URL without variables, an operationId and a
// description on every operation, JSON in and out.

export function askPath(server: Pick<A2aServerConfig, "basePath">, slug: string): string {
  return `${rpcPath(server, slug)}/ask`;
}

export function openApiPath(server: Pick<A2aServerConfig, "basePath">, slug: string): string {
  return `${rpcPath(server, slug)}/openapi.json`;
}

/** snake_case operation id derived from the public slug (never the internal agent id). */
export function askOperationId(slug: string): string {
  return `ask_${slug.replace(/[^a-z0-9]+/g, "_")}`;
}

export type AskRequest = { text: string; contextId?: string };

/** `{ "message": string, "contextId"?: string }`. Throws InvalidParams on anything else. */
export function parseAskBody(body: unknown): AskRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new A2aRpcError(RpcError.InvalidParams, "body must be a JSON object");
  }
  const b = body as Record<string, unknown>;
  if (typeof b.message !== "string" || !b.message.trim()) {
    throw new A2aRpcError(RpcError.InvalidParams, "message must be a non-empty string");
  }
  return { text: b.message, contextId: optionalId(b.contextId, "contextId") };
}

export function buildOpenApiDocument(params: {
  server: Pick<A2aServerConfig, "basePath" | "maxInputChars"> & { apiKeyHeader?: boolean };
  agent: A2aExposedAgent;
  baseUrl: string;
}) {
  const { server, agent, baseUrl } = params;
  const skills = agent.skills.map((s) => `- ${s.name}: ${s.description}`).join("\n");
  const description = `${agent.description}\n\nSkills:\n${skills}`;
  const security = [
    { bearer: [] as string[] },
    ...(server.apiKeyHeader ? [{ apiKey: [] as string[] }] : []),
  ];
  return {
    openapi: "3.0.3",
    info: { title: agent.name, version: agent.version, description: agent.description },
    servers: [{ url: baseUrl }],
    paths: {
      [askPath(server, agent.slug)]: {
        post: {
          operationId: askOperationId(agent.slug),
          summary: `Ask ${agent.name}`.slice(0, 120),
          description,
          security,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["message"],
                  additionalProperties: false,
                  properties: {
                    message: {
                      type: "string",
                      maxLength: server.maxInputChars,
                      description: "The request, in plain text.",
                    },
                    contextId: {
                      type: "string",
                      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$",
                      description:
                        "Continue an earlier conversation: the contextId returned by a previous call.",
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "The agent's reply.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["reply", "state", "taskId", "contextId"],
                    properties: {
                      reply: { type: "string", description: "The reply text." },
                      state: {
                        type: "string",
                        enum: ["completed", "failed", "canceled"],
                        description: "Final task state.",
                      },
                      taskId: { type: "string" },
                      contextId: {
                        type: "string",
                        description: "Pass back to continue the same conversation.",
                      },
                    },
                  },
                },
              },
            },
            "400": { description: "Invalid request.", content: errorContent },
            "401": { description: "Missing or wrong token.", content: errorContent },
            "403": { description: "Caller or agent not allowed.", content: errorContent },
            "429": { description: "Rate limited; see Retry-After.", content: errorContent },
            "503": { description: "Busy; see Retry-After.", content: errorContent },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "Per-client token" },
        ...(server.apiKeyHeader
          ? {
              apiKey: {
                type: "apiKey",
                in: "header",
                name: API_KEY_HEADER,
                description: "The same per-client token, in a header",
              },
            }
          : {}),
      },
    },
  };
}

const errorContent = {
  "application/json": {
    schema: {
      type: "object",
      required: ["error"],
      properties: { error: { type: "string" } },
    },
  },
};
