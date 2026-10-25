// Open WebSocket connections of SSO persons follow their session and roles while idle.
//
// A request already re-resolves the person (server-methods.ts), but a socket that only receives
// broadcasts would otherwise keep the scopes of its handshake past the session's absolute
// lifetime, its idle timeout and any role change. The watcher re-evaluates the session:
//   - every PERSON_REEVALUATE_MS (unref'd, cleared when the connection closes);
//   - at once when the identity directory changes (persons, groups, units, assignments,
//     mappings), so deprovisioning and demotion apply without waiting for the timer;
//   - at once on revocation (logout, admin, SCIM).
// An ended session (expired, idle, revoked, person deactivated / deleted / without a role)
// closes the socket with 4001; otherwise `client.person` and `client.connect.scopes` are
// refreshed, which is what broadcast filtering (server-broadcast.ts) reads.
import type { IdentityService } from "../../../identity/service.js";
import type { GatewayWsClient } from "../ws-types.js";
import { legacyScopesForPerson } from "../../../identity/rbac.js";

export const PERSON_REEVALUATE_MS = 30_000;
export const PERSON_SESSION_ENDED_CODE = 4001;

let intervalOverrideMs: number | null = null;

/** Tests: shorten the re-evaluation interval (null restores the default). */
export function setPersonReevaluateIntervalForTest(ms: number | null): void {
  intervalOverrideMs = ms;
}

export function watchPersonConnection(params: {
  client: GatewayWsClient;
  sessionId: string;
  identity: IdentityService;
  close: (code: number, reason: string) => void;
  intervalMs?: number;
}): () => void {
  const { client, sessionId, identity, close } = params;
  let stopped = false;
  let pending = false;
  const end = () => {
    stop();
    close(PERSON_SESSION_ENDED_CODE, "session ended");
  };
  const reevaluate = () => {
    pending = false;
    if (stopped) {
      return;
    }
    let live: ReturnType<IdentityService["principalForSession"]>;
    try {
      // No touch: an open socket is not activity, so the idle timeout still applies.
      live = identity.principalForSession(sessionId);
    } catch {
      end(); // fail closed
      return;
    }
    if (!live.ok) {
      end();
      return;
    }
    client.person = live.principal;
    client.connect.scopes = legacyScopesForPerson(live.principal);
  };
  // Directory writes come in bursts (one admin operation, one SCIM request): coalesce.
  const schedule = () => {
    if (!pending && !stopped) {
      pending = true;
      queueMicrotask(reevaluate);
    }
  };
  const timer = setInterval(
    reevaluate,
    params.intervalMs ?? intervalOverrideMs ?? PERSON_REEVALUATE_MS,
  );
  timer.unref?.();
  const offRevoked = identity.sessions.onRevoked(sessionId, end);
  const offChange = identity.store.onChange(schedule);
  function stop() {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(timer);
    offRevoked();
    offChange();
  }
  return stop;
}
