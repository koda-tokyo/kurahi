// WS `connectors.status` (Kurahi Business edition): read-only, sanitized state of the business
// connectors (Microsoft 365, Gmail, Microsoft Entra ID). No tokens, account names, addresses or
// provider messages: scopes are names only and errors are codes from a closed list.
import { Type } from "@sinclair/typebox";
import { CONNECTOR_ERROR_CODES } from "../../../connectors/business/errors.js";

export const ConnectorsStatusParamsSchema = Type.Object({}, { additionalProperties: false });

export const ConnectorStatusEntrySchema = Type.Object(
  {
    id: Type.String({ pattern: "^[a-z][a-z0-9-]{0,47}$" }),
    configured: Type.Boolean(),
    authenticated: Type.Boolean(),
    lastProbeOk: Type.Union([Type.Boolean(), Type.Null()]),
    lastProbeAt: Type.Union([Type.String(), Type.Null()]),
    scopes: Type.Array(Type.String({ maxLength: 64 }), { maxItems: 64 }),
    error: Type.Union([
      Type.Union(CONNECTOR_ERROR_CODES.map((code) => Type.Literal(code))),
      Type.Null(),
    ]),
  },
  { additionalProperties: false },
);

export const ConnectorsStatusResultSchema = Type.Object(
  { connectors: Type.Array(ConnectorStatusEntrySchema) },
  { additionalProperties: false },
);
