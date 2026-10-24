// WS `connectors.status` (observe scope, read-only): the business connectors' configuration,
// sign-in and last health probe, as reported by their plugins. Sanitized twice: when a plugin
// reports and again here, so a plugin bug cannot leak a token, an address or a provider message.
import type { GatewayRequestHandlers } from "./types.js";
import { listConnectorStatus } from "../../connectors/business/status.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConnectorsStatusParams,
} from "../protocol/index.js";

export const connectorsHandlers: GatewayRequestHandlers = {
  "connectors.status": ({ params, respond }) => {
    if (!validateConnectorsStatusParams(params ?? {})) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid connectors.status params: ${formatValidationErrors(validateConnectorsStatusParams.errors)}`,
        ),
      );
      return;
    }
    respond(true, { connectors: listConnectorStatus() }, undefined);
  },
};
