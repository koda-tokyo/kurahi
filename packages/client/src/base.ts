// SPDX-License-Identifier: MIT
// Runtime for the generated KoloClient: URL building, auth, timeouts and the error model.
// Isomorphic: only fetch, URL, AbortController and Headers (Node 22+, browsers, Bun, Deno).
import type { OperationSpec } from "./operation-spec.js";
import { discover, type DiscoverOptions, type DiscoveredGateway } from "./discover.js";
import { DEFAULT_PORT, operations, type OperationId } from "./generated/operations.js";
import {
  type DeviceKey,
  readDeviceCredential,
  refresh as refreshDevice,
  type RefreshOptions,
} from "./pair.js";
import { connectWs, type KoloSocket, type KoloWsOptions } from "./ws.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type KoloCredentials = {
  /**
   * Bearer credential: the gateway shared secret (scheme gatewayToken) or a pairing access
   * token `kpa_…` (scheme pairToken, M3a). Both travel as `Authorization: Bearer`.
   */
  token?: string;
  /** Device key behind a pairing access token; signs the WebSocket connect challenge. */
  device?: DeviceKey;
  /** Admin invite-flow session token (scheme adminSession; sent as Bearer when no gateway token applies). */
  sessionToken?: string;
  /** hooks.token (scheme hookToken, `X-KoLo-Token`). */
  hookToken?: string;
  /** INVITE_SIGNING_KEY (scheme migrateKey, `X-Migrate-Key`). */
  migrateKey?: string;
};

export type KoloClientOptions = KoloCredentials & {
  /** Gateway base URL. Default `http://127.0.0.1:<spec default port>`. */
  baseUrl?: string;
  /** Per-request timeout in milliseconds. Default 30 000; 0 disables. */
  timeoutMs?: number;
  /** Injectable fetch (tests, proxies). Default globalThis.fetch. */
  fetch?: FetchLike;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
};

export type ParamValue = string | number | boolean | null | undefined;

export type RequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

export type OperationInput = RequestOptions & {
  params?: Record<string, ParamValue | readonly ParamValue[]>;
  body?: unknown;
};

export type KoloResponse<T = unknown> = {
  operationId: string;
  status: number;
  ok: boolean;
  headers: Headers;
  data: T;
};

/** A non-2xx answer. `body` is the decoded error model (GatewayError, OkFalseError, RateLimitError, text). */
export class KoloApiError extends Error {
  readonly name = "KoloApiError";
  constructor(
    readonly operationId: string,
    readonly status: number,
    readonly body: unknown,
    readonly headers: Headers,
  ) {
    super(`${operationId}: HTTP ${status}${describeErrorBody(body)}`);
  }

  /** Seconds from Retry-After on a 429, if present. */
  get retryAfterSeconds(): number | undefined {
    const raw = this.headers.get("retry-after");
    const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
    return Number.isFinite(n) ? n : undefined;
  }
}

/** Request never reached a response: network failure, timeout or abort. */
export class KoloNetworkError extends Error {
  readonly name = "KoloNetworkError";
  constructor(
    readonly operationId: string,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`${operationId}: ${message}`);
  }
}

function describeErrorBody(body: unknown): string {
  if (typeof body === "string") {
    return body.trim() ? `: ${body.trim().slice(0, 200)}` : "";
  }
  if (body && typeof body === "object") {
    const err = (body as { error?: unknown }).error;
    if (typeof err === "string") {
      return `: ${err}`;
    }
    if (
      err &&
      typeof err === "object" &&
      typeof (err as { message?: unknown }).message === "string"
    ) {
      return `: ${(err as { message: string }).message}`;
    }
  }
  return "";
}

export function defaultBaseUrl(): string {
  return `http://127.0.0.1:${DEFAULT_PORT}`;
}

export function getOperation(operationId: string): OperationSpec | undefined {
  return Object.hasOwn(operations, operationId)
    ? (operations as Record<string, OperationSpec>)[operationId]
    : undefined;
}

export function listOperations(): OperationSpec[] {
  return Object.values(operations as Record<string, OperationSpec>);
}

function encodeParam(v: ParamValue): string {
  return v === null || v === undefined ? "" : String(v);
}

/** Pick the first security alternative the credentials satisfy and set its headers. */
function applySecurity(spec: OperationSpec, creds: KoloCredentials, headers: Headers): void {
  for (const alternative of spec.security) {
    const set: Array<[string, string]> = [];
    let satisfied = alternative.length > 0;
    for (const scheme of alternative) {
      if ((scheme === "gatewayToken" || scheme === "pairToken") && creds.token) {
        set.push(["authorization", `Bearer ${creds.token}`]);
      } else if (scheme === "adminSession" && creds.sessionToken) {
        set.push(["authorization", `Bearer ${creds.sessionToken}`]);
      } else if (scheme === "hookToken" && creds.hookToken) {
        set.push(["x-kolo-token", creds.hookToken]);
      } else if (scheme === "migrateKey" && creds.migrateKey) {
        set.push(["x-migrate-key", creds.migrateKey]);
      } else {
        satisfied = false;
        break;
      }
    }
    if (satisfied) {
      for (const [k, v] of set) {
        if (!headers.has(k)) {
          headers.set(k, v);
        }
      }
      return;
    }
  }
  // Open operations (for example /health) answer more to a credential holder than to an
  // anonymous caller, so a gateway or pairing token is sent whenever one is available.
  if (spec.security.length === 0 && creds.token && !headers.has("authorization")) {
    headers.set("authorization", `Bearer ${creds.token}`);
  }
}

export type BuiltRequest = { url: string; init: RequestInit };

/** Build the URL and RequestInit for an operation. Throws on unknown or missing parameters. */
export function buildRequest(
  spec: OperationSpec,
  input: OperationInput,
  opts: { baseUrl: string; credentials: KoloCredentials; headers?: Record<string, string> },
): BuiltRequest {
  const params = input.params ?? {};
  const known = new Map(spec.params.map((p) => [p.name.toLowerCase(), p]));
  for (const name of Object.keys(params)) {
    if (!known.has(name.toLowerCase())) {
      const names = spec.params.map((p) => p.name).join(", ") || "none";
      throw new TypeError(`${spec.operationId}: unknown parameter "${name}" (accepts: ${names})`);
    }
  }
  const lookup = (name: string) => {
    const key = Object.keys(params).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : params[key];
  };
  let pathname = spec.path;
  const query = new URLSearchParams();
  const headers = new Headers(opts.headers);
  for (const [k, v] of Object.entries(input.headers ?? {})) {
    headers.set(k, v);
  }
  for (const p of spec.params) {
    const value = lookup(p.name);
    if (value === undefined || value === null) {
      if (p.required) {
        throw new TypeError(`${spec.operationId}: missing required ${p.in} parameter "${p.name}"`);
      }
      continue;
    }
    const values = Array.isArray(value) ? (value as readonly ParamValue[]) : [value as ParamValue];
    if (p.in === "path") {
      pathname = pathname.replace(`{${p.name}}`, encodeURIComponent(encodeParam(values[0])));
    } else if (p.in === "query") {
      for (const v of values) {
        query.append(p.name, encodeParam(v));
      }
    } else if (p.in === "header") {
      headers.set(p.name, values.map(encodeParam).join(","));
    }
  }
  applySecurity(spec, opts.credentials, headers);
  let body: string | undefined;
  if (spec.body) {
    if (input.body === undefined) {
      if (spec.body.required) {
        throw new TypeError(`${spec.operationId}: request body is required`);
      }
    } else {
      body = typeof input.body === "string" ? input.body : JSON.stringify(input.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", spec.body.contentType);
      }
    }
  } else if (input.body !== undefined) {
    throw new TypeError(`${spec.operationId}: operation takes no request body`);
  }
  if (!headers.has("accept")) {
    headers.set(
      "accept",
      spec.response === "text" ? "text/plain, application/json" : "application/json",
    );
  }
  const qs = query.toString();
  const base = opts.baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}${pathname}${qs ? `?${qs}` : ""}`,
    init: { method: spec.method, headers, body },
  };
}

async function decodeBody(res: Response, kind: OperationSpec["response"]): Promise<unknown> {
  if (res.status === 204 || res.status === 205) {
    return undefined;
  }
  const ct = (res.headers.get("content-type") ?? "").toLowerCase();
  if (kind === "binary" && !ct.includes("json") && !ct.startsWith("text/")) {
    return await res.arrayBuffer();
  }
  const text = await res.text();
  if (!text) {
    return undefined;
  }
  if (ct.includes("json") || (kind === "json" && /^\s*[{["]/.test(text))) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

export class KoloClientBase {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  protected readonly credentials: KoloCredentials;
  private readonly fetchImpl: FetchLike;
  private readonly headers: Record<string, string>;

  constructor(options: KoloClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? defaultBaseUrl()).replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.credentials = {
      token: options.token,
      device: options.device,
      sessionToken: options.sessionToken,
      hookToken: options.hookToken,
      migrateKey: options.migrateKey,
    };
    const f = options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (typeof f !== "function") {
      throw new TypeError("KoloClient: no fetch available; pass options.fetch");
    }
    this.fetchImpl = f;
    this.headers = { ...options.headers };
  }

  /**
   * A client for the local gateway found by discover() (KOLO_HOME lock + token file, env
   * overrides, else a paired device credential whose access token is refreshed when expired).
   * Explicit options win over discovered values.
   */
  static async local<C extends KoloClientBase>(
    this: new (options: KoloClientOptions) => C,
    options: KoloClientOptions & { discover?: DiscoverOptions } = {},
  ): Promise<C & { discovered: DiscoveredGateway }> {
    let found = await discover(options.discover);
    const { discover: _ignored, ...rest } = options;
    let token = rest.token ?? found.token;
    let device = rest.device;
    if (!rest.token && found.device && (found.tokenSource === "device" || !token)) {
      const deviceFile = found.device.file;
      if (found.device.expired || !token) {
        const rotated = await refreshDevice({
          file: deviceFile,
          fetch: rest.fetch as NonNullable<RefreshOptions["fetch"]>,
        });
        token = rotated.credential.accessToken;
        found = await discover(options.discover);
      }
      const stored = await readDeviceCredential(deviceFile);
      if (stored) {
        device ??= {
          fingerprint: stored.fingerprint,
          publicKey: stored.publicKey,
          privateKeyPem: stored.privateKeyPem,
        };
      }
    }
    // SSO required: the owner token over HTTP needs a stated break-glass reason, taken from
    // KOLO_BREAK_GLASS like the WebSocket client (percent-encoded: header values are ASCII).
    const breakGlass = (options.discover?.env ?? process.env).KOLO_BREAK_GLASS?.trim();
    const headers =
      breakGlass && token && token === found.token && found.tokenSource !== "device"
        ? { "X-KoLo-Break-Glass": encodeURIComponent(breakGlass.slice(0, 500)), ...rest.headers }
        : rest.headers;
    const client = new this({
      ...rest,
      baseUrl: rest.baseUrl ?? found.baseUrl,
      token,
      device,
      headers,
    });
    return Object.assign(client, { discovered: found });
  }

  /** Open the gateway WebSocket with this client's URL and token and perform the handshake. */
  ws(options: Omit<KoloWsOptions, "url"> & { url?: string } = {}): Promise<KoloSocket> {
    return connectWs({
      ...options,
      url: options.url ?? this.wsUrl,
      token: options.token ?? this.credentials.token,
      device: options.device ?? this.credentials.device,
    });
  }

  /** Whether a gateway token is configured (never exposes it). */
  get hasToken(): boolean {
    return Boolean(this.credentials.token);
  }

  /** Call an operation and return status, headers and decoded body without throwing on HTTP errors. */
  async send<T = unknown>(
    operationId: OperationId | (string & {}),
    input: OperationInput = {},
  ): Promise<KoloResponse<T>> {
    const spec = getOperation(operationId);
    if (!spec) {
      throw new TypeError(`unknown operationId "${operationId}"`);
    }
    const { url, init } = buildRequest(spec, input, {
      baseUrl: this.baseUrl,
      credentials: this.credentials,
      headers: this.headers,
    });
    const timeoutMs = input.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const onAbort = () => controller.abort(input.signal?.reason);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer =
      timeoutMs > 0
        ? setTimeout(() => controller.abort(new Error("timeout")), timeoutMs)
        : undefined;
    try {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal: controller.signal });
      } catch (err) {
        const why = controller.signal.aborted
          ? input.signal?.aborted
            ? "aborted"
            : `timed out after ${timeoutMs} ms`
          : `request failed (${err instanceof Error ? err.message : String(err)})`;
        throw new KoloNetworkError(spec.operationId, `${spec.method} ${url}: ${why}`, err);
      }
      const data = (await decodeBody(res, spec.response)) as T;
      return {
        operationId: spec.operationId,
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        data,
      };
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Call an operation; resolves with the decoded 2xx body, throws KoloApiError otherwise. */
  async request<T = unknown>(
    operationId: OperationId | (string & {}),
    input: OperationInput = {},
  ): Promise<T> {
    const res = await this.send<T>(operationId, input);
    if (!res.ok) {
      throw new KoloApiError(res.operationId, res.status, res.data, res.headers);
    }
    return res.data;
  }

  /** The WebSocket URL of this gateway (`ws(s)://host:port/`). */
  get wsUrl(): string {
    const u = new URL(this.baseUrl);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/";
    u.search = "";
    return u.toString();
  }
}
