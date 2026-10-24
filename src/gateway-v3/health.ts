// gateway-v3 health — forwards lease + consciousness dispatcher state to /health.

import type { LeaseManager } from "./supervisor/lease.js";

export type NodePosture = "alive" | "handoff_ready" | "degraded" | "unhealthy" | "serviceable";

export interface V3HealthSnapshot {
  posture: NodePosture;
  lease: { held: boolean; holdingMs: number } | null;
  /** Registered v3 consciousness dispatchers, or null when v3 dispatch is not booted. */
  dispatchers: { count: number } | null;
}

let v3LeaseSingleton: LeaseManager | null = null;
let v3DispatcherCount: (() => number) | null = null;

export function setV3LeaseSingleton(lease: LeaseManager | null): void {
  v3LeaseSingleton = lease;
}

/** Wire the live dispatcher count (gateway.v3.enabled); null unwires it. */
export function setV3DispatcherCountSource(source: (() => number) | null): void {
  v3DispatcherCount = source;
}

/** Real lease state, or null when the lease is disabled / not booted. */
export function getGatewayLeaseState(): { held: boolean; holdingMs: number } | null {
  return v3LeaseSingleton
    ? { held: v3LeaseSingleton.isHeld, holdingMs: v3LeaseSingleton.holdingMs }
    : null;
}

export function getV3HealthSnapshot(): V3HealthSnapshot {
  const lease = getGatewayLeaseState();
  return {
    posture: lease && !lease.held ? "handoff_ready" : "alive",
    lease,
    dispatchers: v3DispatcherCount ? { count: v3DispatcherCount() } : null,
  };
}
