import type { WebSocket } from "ws";
import type { PersonPrincipal } from "../../identity/types.js";
import type { PairPrincipal } from "../pair-store.js";
import type { ConnectParams } from "../protocol/index.js";

export type GatewayWsClient = {
  socket: WebSocket;
  connect: ConnectParams;
  connId: string;
  presenceKey?: string;
  /** Set when the connection authenticated with a pairing access token (M3a). */
  pairing?: PairPrincipal;
  /** Set when the connection authenticated with an SSO session (enterprise identity). */
  person?: PersonPrincipal;
  /** Owner login admitted as break-glass with a stated reason (audited). */
  breakGlass?: boolean;
  /** Credential the handshake verified: token, password, tailscale, device-token, pair-credential, sso. */
  authMethod?: string;
};
