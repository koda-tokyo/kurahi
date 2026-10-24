export type AuthProfileConfig = {
  provider: string;
  /**
   * Credential type expected in auth-profiles.json for this profile id.
   * - api_key: static provider API key
   * - oauth: refreshable OAuth credentials (access+refresh+expires)
   * - token: static bearer-style token (optionally expiring; no refresh)
   */
  mode: "api_key" | "oauth" | "token";
  email?: string;
};

export type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  /**
   * How non-main agents get credentials.
   * - inherit (default): an agent without its own store inherits a copy of the main agent's
   *   profiles, and the main agent's profiles are merged into every agent's view.
   * - explicit: no inheritance and no merge; an agent sees only the profile ids granted to it in
   *   `grants`. Recommended for enterprise deployments.
   */
  isolation?: "inherit" | "explicit";
  /**
   * Profile ids each agent may use when `isolation` is "explicit" (agent id → profile ids).
   * `"*"` grants every profile (what `kurahi init` gives the identity agent it creates).
   */
  grants?: Record<string, string[]>;
  order?: Record<string, string[]>;
  cooldowns?: {
    /** Default billing backoff (hours). Default: 5. */
    billingBackoffHours?: number;
    /** Optional per-provider billing backoff (hours). */
    billingBackoffHoursByProvider?: Record<string, number>;
    /** Billing backoff cap (hours). Default: 24. */
    billingMaxHours?: number;
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
  };
};
