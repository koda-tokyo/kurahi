// Mail watch providers for `m365.mail` event triggers (docs/autopilot.md#triggers).
//
// A mail connector plugin registers ONE provider per connector sign-in when it loads
// (extensions/microsoft-365: Graph delta queries, optional change notifications). The trigger
// dispatcher subscribes per Project folder; the provider only says "new mail arrived" (a count),
// never ids, senders, subjects or bodies. The routine's own gather then reads the mail through
// the connector's read tools as on any run.
//
// The registry is on globalThis under a registered symbol: the plugin is loaded through jiti and
// may hold its own copy of this module.

import type { DeltaStore } from "./state.js";

export type ProviderHealth = {
  status: "active" | "degraded";
  /** Safe error code (connector error codes, `rate_limited`, `reauth_required` …) or null. */
  error: string | null;
};

export type MailSubscription = {
  /** Stable per Project folder (`<projectId>:<folder>`). */
  key: string;
  folder: string;
  /** Where the provider keeps its delta link (the Project data dir). */
  store: DeltaStore;
  onNewMail: (count: number) => void;
  onHealth: (health: ProviderHealth) => void;
};

export type MailWatchProvider = {
  /** Event source this provider serves. */
  source: "m365.mail";
  connector: string;
  subscribe(sub: MailSubscription): () => void;
};

type Registry = { providers: Map<string, MailWatchProvider>; listeners: Set<() => void> };

const KEY = Symbol.for("kurahi.autopilot.mailWatchProviders");

function registry(): Registry {
  const g = globalThis as { [KEY]?: Registry };
  g[KEY] ??= { providers: new Map(), listeners: new Set() };
  return g[KEY];
}

function changed(): void {
  for (const fn of registry().listeners) {
    try {
      fn();
    } catch {
      // ignore
    }
  }
}

/** Register (or replace, on a plugin reload) the provider of a source; returns the unregister. */
export function registerMailWatchProvider(provider: MailWatchProvider): () => void {
  registry().providers.set(provider.source, provider);
  changed();
  return () => {
    if (registry().providers.get(provider.source) === provider) {
      registry().providers.delete(provider.source);
      changed();
    }
  };
}

export function getMailWatchProvider(source: "m365.mail"): MailWatchProvider | null {
  return registry().providers.get(source) ?? null;
}

/** Called when a provider registers or goes away. */
export function onMailWatchProvidersChanged(fn: () => void): () => void {
  registry().listeners.add(fn);
  return () => {
    registry().listeners.delete(fn);
  };
}

/** Tests: forget every provider and listener. */
export function resetMailWatchProvidersForTests(): void {
  registry().providers.clear();
  registry().listeners.clear();
}
