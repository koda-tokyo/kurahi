// Business connectors (Kurahi Business edition): error codes that are safe to show anywhere.
//
// A connector error carries one code from a closed list. The code is what reaches the status
// method, the audit log and the agent; provider response bodies, tokens and URLs never do.

export const CONNECTOR_ERROR_CODES = [
  "not_configured",
  "not_authenticated",
  "reauth_required",
  "scope_missing",
  "consent_required",
  "forbidden",
  "not_found",
  "bad_request",
  "rate_limited",
  "provider_unavailable",
  "network",
  "timeout",
  "too_large",
  "invalid_response",
  "approval_denied",
  "unsupported",
  "unknown",
] as const;

export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

const CODE_SET = new Set<string>(CONNECTOR_ERROR_CODES);

export function isConnectorErrorCode(value: unknown): value is ConnectorErrorCode {
  return typeof value === "string" && CODE_SET.has(value);
}

export class ConnectorError extends Error {
  constructor(
    public readonly code: ConnectorErrorCode,
    message: string,
    public readonly status?: number,
    /** A content-free hint for the agent in place of the code's default (no names or paths). */
    public readonly hint?: string,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

/** The safe code for any thrown value. Unknown errors map to `unknown`, never to their text. */
export function errorCodeOf(err: unknown): ConnectorErrorCode {
  if (err instanceof ConnectorError) {
    return err.code;
  }
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return "timeout";
  }
  if (err instanceof TypeError) {
    // fetch() rejects with TypeError on DNS, refused connections and TLS failures.
    return "network";
  }
  return "unknown";
}

/** Map an HTTP status (and an OAuth/Graph error code when present) to a safe code. */
export function codeForHttpStatus(status: number, providerCode?: string): ConnectorErrorCode {
  const pc = (providerCode ?? "").toLowerCase();
  if (pc === "invalid_grant" || pc === "interaction_required") {
    return "reauth_required";
  }
  if (pc === "consent_required") {
    return "consent_required";
  }
  if (status === 401) {
    return "not_authenticated";
  }
  if (status === 403) {
    return pc.includes("scope") || pc === "insufficient_permissions"
      ? "scope_missing"
      : "forbidden";
  }
  if (status === 404) {
    return "not_found";
  }
  if (status === 413) {
    return "too_large";
  }
  if (status === 429) {
    return "rate_limited";
  }
  if (status >= 500) {
    return "provider_unavailable";
  }
  if (status >= 400) {
    return "bad_request";
  }
  return "unknown";
}

/** A one-line, content-free message for the agent. */
export function describeConnectorError(err: unknown): string {
  const code = errorCodeOf(err);
  const hints: Partial<Record<ConnectorErrorCode, string>> = {
    not_configured: "the connector is not configured; an administrator must set it up",
    not_authenticated: "not signed in; run the connector login command",
    reauth_required: "the sign-in expired or was revoked; run the connector login command again",
    scope_missing: "the granted permissions do not include this operation",
    consent_required: "an administrator must grant consent for the requested permissions",
    forbidden: "the account is not allowed to access this item",
    not_found: "the item was not found",
    rate_limited: "the service is rate limiting requests; try again later",
    provider_unavailable: "the service is temporarily unavailable",
    network: "the service could not be reached",
    timeout: "the request timed out",
    too_large: "the item is larger than the configured size limit",
    approval_denied: "a person did not approve this action",
  };
  const own = err instanceof ConnectorError ? err.hint : undefined;
  return `${code}: ${own ?? hints[code] ?? "the request failed"}`;
}
