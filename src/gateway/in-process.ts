// Whether code runs INSIDE the gateway process, and the gateway's broadcast there. Set by the
// gateway server at start (server.impl.ts) and cleared at close. Agent tools that would
// otherwise open a WebSocket to their own gateway for every call (callGatewayTool) use it to call
// the module directly instead: the gateway limits new connections per address per minute, and an
// autopilot run or a busy agent trips that limit with one connection per tool call.
//
// On globalThis under a registered symbol: plugin code loaded through jiti may hold its own copy
// of this module.

export type GatewayBroadcast = (
  event: string,
  payload: unknown,
  opts?: { dropIfSlow?: boolean },
) => void;

type InProcess = { broadcast: GatewayBroadcast };

const KEY = Symbol.for("kurahi.gateway.inProcess");

function slot(): { [KEY]?: InProcess | null } {
  return globalThis as { [KEY]?: InProcess | null };
}

export function markGatewayInProcess(state: InProcess): void {
  slot()[KEY] = state;
}

export function clearGatewayInProcess(): void {
  slot()[KEY] = null;
}

/** The running gateway of this process, or null (CLI, a separate agent process, tests). */
export function gatewayInProcess(): InProcess | null {
  return slot()[KEY] ?? null;
}
