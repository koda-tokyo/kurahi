import { PROTOCOL_SCHEMA_URL } from "../../config/product-urls.js";
// JSON Schema view of the Gateway WebSocket protocol (TypeBox → plain JSON). Shared by
// scripts/protocol-gen.ts (dist/protocol.schema.json) and the OpenAPI document (M4a).
import { PROTOCOL_VERSION, ProtocolSchemas } from "./schema/protocol-schemas.js";

/** TypeBox schemas carry symbol keys (Kind, Hint); a JSON round trip leaves plain JSON Schema. */
export function toPlainJsonSchema<T>(schema: T): T {
  return JSON.parse(JSON.stringify(schema)) as T;
}

export function protocolDefinitions(): Record<string, Record<string, unknown>> {
  const definitions: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(ProtocolSchemas)) {
    definitions[name] = toPlainJsonSchema(schema) as Record<string, unknown>;
  }
  return definitions;
}

export function buildProtocolJsonSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: PROTOCOL_SCHEMA_URL,
    title: "KoLo Gateway Protocol",
    description: "Handshake, request/response, and event frames for the Gateway WebSocket.",
    oneOf: [
      { $ref: "#/definitions/RequestFrame" },
      { $ref: "#/definitions/ResponseFrame" },
      { $ref: "#/definitions/EventFrame" },
    ],
    discriminator: {
      propertyName: "type",
      mapping: {
        req: "#/definitions/RequestFrame",
        res: "#/definitions/ResponseFrame",
        event: "#/definitions/EventFrame",
      },
    },
    definitions: protocolDefinitions(),
  };
}

function pascal(name: string): string {
  return name
    .split(/[.\-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

// Methods whose schema names do not follow `<Pascal(method)>Params|Result`.
const METHOD_SCHEMA_ALIASES: Record<string, { params?: string; result?: string }> = {
  "agent.identity.get": { params: "AgentIdentityParams", result: "AgentIdentityResult" },
  "exec.approvals.get": { result: "ExecApprovalsSnapshot" },
  "exec.approvals.node.get": { result: "ExecApprovalsSnapshot" },
  "cron.runs": { result: "CronRunLogEntry" },
  "terminal.input": { result: "TerminalAckResult" },
  "terminal.resize": { result: "TerminalAckResult" },
  "terminal.cancel": { result: "TerminalAckResult" },
  "terminal.close": { result: "TerminalAckResult" },
};

// Events whose payload schema name does not follow `<Pascal(event)>Event`.
const EVENT_SCHEMA_ALIASES: Record<string, string> = {
  "terminal.event": "TerminalEvent",
};

export type WsMethodSchemaNames = { params?: string; result?: string };

/** Schema names (keys of ProtocolSchemas) for one WS method, when they exist. */
export function resolveMethodSchemaNames(method: string): WsMethodSchemaNames {
  const alias = METHOD_SCHEMA_ALIASES[method] ?? {};
  const base = pascal(method);
  const pick = (...candidates: Array<string | undefined>) =>
    candidates.find((c) => c !== undefined && c in ProtocolSchemas);
  return {
    params: pick(alias.params, `${base}Params`),
    result: pick(alias.result, `${base}Result`, `${base}Response`),
  };
}

/** Schema name for one WS event payload, when it exists. */
export function resolveEventSchemaName(event: string): string | undefined {
  const name = EVENT_SCHEMA_ALIASES[event] ?? `${pascal(event)}Event`;
  return name in ProtocolSchemas ? name : undefined;
}

export { PROTOCOL_VERSION };
