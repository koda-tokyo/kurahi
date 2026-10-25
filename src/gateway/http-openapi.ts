// OpenAPI 3.1 document builder for the HTTP route registry (KoLo 2.0, M4a).
// Pure: no I/O, no clock, deterministic key order, so the committed spec can be drift-checked.
import type { TSchema } from "@sinclair/typebox";
import type {
  BoundMount,
  BoundRoute,
  HttpAuthKind,
  ResponseSpec,
  SharedResponseName,
} from "./http-registry.js";
import {
  PROTOCOL_VERSION,
  protocolDefinitions,
  resolveEventSchemaName,
  resolveMethodSchemaNames,
  toPlainJsonSchema,
} from "./protocol/json-schema.js";
import {
  AUTH_ATTEMPT_LIMIT,
  AUTH_ATTEMPT_WINDOW_MS,
  HTTP_RATE_LIMITS,
  httpRateLimitClass,
  isAuthBearingPath,
} from "./rate-limiter.js";
import { routeMinScope } from "./scopes.js";

export const OPENAPI_VERSION = "3.1.0";
export const DEFAULT_GATEWAY_PORT = 18789;

type JsonObject = Record<string, unknown>;

export type WebSocketDescription = {
  methods: readonly string[];
  events: readonly string[];
};

export type OpenApiBuildOptions = {
  /** info.version; the package version. */
  version?: string;
  websocket?: WebSocketDescription;
  /** Routes registered at runtime (plugin webhooks); appended after the static registry. */
  runtimeRoutes?: readonly BoundRoute[];
};

/** auth kind → securitySchemes key, token class name (`x-kolo-scope`), scheme object. */
export const SECURITY_SCHEMES: Record<
  Exclude<HttpAuthKind, "none">,
  { name: string; scope: string; scheme: JsonObject }
> = {
  "gateway-token": {
    name: "gatewayToken",
    scope: "gateway",
    scheme: {
      type: "http",
      scheme: "bearer",
      description:
        "Gateway shared secret (token or password mode) as `Authorization: Bearer <secret>`. " +
        "The secret lives in the gateway's 0600 token file, never in config or argv.",
    },
  },
  "session-admin": {
    name: "adminSession",
    scope: "admin-session",
    scheme: {
      type: "apiKey",
      in: "cookie",
      name: "kolo_session",
      description:
        "Invite-flow session with the admin role: the `kolo_session` cookie set by " +
        "POST /api/auth/redeem (a Bearer session token is accepted too).",
    },
  },
  "sso-session": {
    name: "ssoSession",
    scope: "person",
    scheme: {
      type: "http",
      scheme: "bearer",
      description:
        "SSO session token (`kss_…`) of a person who signed in through the organisation's " +
        "identity provider (OIDC or SAML), as `Authorization: Bearer`. The person's roles give " +
        "the scope; auditors may also read the audit chain and evidence.",
    },
  },
  "scim-token": {
    name: "scimToken",
    scope: "scim",
    scheme: {
      type: "http",
      scheme: "bearer",
      description:
        "Provisioning token from `gateway.identity.scim.token` (secrets store), presented by the " +
        "identity provider's SCIM client.",
    },
  },
  "pair-credential": {
    name: "pairToken",
    scope: "pair",
    scheme: {
      type: "http",
      scheme: "bearer",
      description:
        "Pairing access token (`kpa_…`) from POST /api/pair/redeem or /api/pair/refresh, as " +
        "`Authorization: Bearer`. Bound to the device key that redeemed the invitation and " +
        "carrying one scope (observe < attach < admin); `x-kolo-min-scope` on the operation " +
        "is the least scope it accepts. Short-lived; rotate with the refresh token.",
    },
  },
  "hook-token": {
    name: "hookToken",
    scope: "hook",
    scheme: {
      type: "apiKey",
      in: "header",
      name: "X-KoLo-Token",
      description:
        "hooks.token from config, as `X-KoLo-Token` or `Authorization: Bearer`. A `?token=` " +
        "query parameter still works but is deprecated (URLs leak into logs).",
    },
  },
  "migrate-key": {
    name: "migrateKey",
    scope: "migrate",
    scheme: {
      type: "apiKey",
      in: "header",
      name: "X-Migrate-Key",
      description: "INVITE_SIGNING_KEY from the gateway environment (timing-safe compare).",
    },
  },
  plugin: {
    name: "pluginSignature",
    scope: "plugin",
    scheme: {
      type: "apiKey",
      in: "header",
      name: "X-Provider-Signature",
      description:
        "Channel webhooks are verified by the owning plugin with the provider's own scheme " +
        "(for example X-Line-Signature HMAC, Slack signing secret). The header name varies.",
    },
  },
};

const SCOPE_NONE = "public";

const ERROR_SCHEMAS: Record<string, JsonObject> = {
  GatewayError: {
    type: "object",
    description: "Error body of the OpenAI-compatible and gateway-token routes.",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["message", "type"],
        properties: { message: { type: "string" }, type: { type: "string" } },
      },
    },
  },
  OkFalseError: {
    type: "object",
    description: "Error body of the admin, auth, migrate and hook routes.",
    required: ["ok", "error"],
    properties: {
      ok: { const: false },
      error: { type: "string" },
      details: {},
    },
  },
  RateLimitError: {
    type: "object",
    required: ["error", "retryAfter"],
    properties: {
      error: { const: "Too Many Requests" },
      retryAfter: { type: "integer", description: "Seconds until the window frees up." },
    },
  },
};

const RATE_LIMIT_HEADERS: Record<string, JsonObject> = {
  "Retry-After": {
    description: "Seconds to wait before retrying.",
    schema: { type: "integer", minimum: 1 },
  },
  "X-RateLimit-Limit": {
    description: "Requests (or credential attempts) allowed per window for this class.",
    schema: { type: "integer" },
  },
  "X-RateLimit-Remaining": {
    description: "Always 0 on a 429.",
    schema: { type: "integer" },
  },
};

const json = (ref: string) => ({
  "application/json": { schema: { $ref: `#/components/schemas/${ref}` } },
});
const text = { "text/plain": { schema: { type: "string" } } };

const SHARED_RESPONSES: Record<SharedResponseName, JsonObject> = {
  BadRequest: {
    description: "Malformed request body or parameters.",
    content: json("OkFalseError"),
  },
  Unauthorized: {
    description: "Missing or invalid credentials. Counts as a credential attempt.",
    content: json("GatewayError"),
  },
  Forbidden: {
    description: "Credentials valid but not allowed for this action.",
    content: json("OkFalseError"),
  },
  NotFound: { description: "Unknown resource.", content: text },
  MethodNotAllowed: {
    description: "The path exists for other methods; see the Allow header.",
    headers: { Allow: { schema: { type: "string" } } },
    content: text,
  },
  PayloadTooLarge: {
    description: "Body over the route's byte limit.",
    content: json("OkFalseError"),
  },
  TooManyRequests: {
    description:
      "Per-IP rate limit (see x-kolo-rate-limit on the operation) or the credential-attempt " +
      `limiter (${AUTH_ATTEMPT_LIMIT} attempts per ${AUTH_ATTEMPT_WINDOW_MS / 1000} s per source).`,
    headers: {
      "Retry-After": { $ref: "#/components/headers/Retry-After" },
      "X-RateLimit-Limit": { $ref: "#/components/headers/X-RateLimit-Limit" },
      "X-RateLimit-Remaining": { $ref: "#/components/headers/X-RateLimit-Remaining" },
    },
    content: json("RateLimitError"),
  },
  InternalError: { description: "Unexpected server error.", content: text },
};

function authKinds(auth: BoundRoute["auth"]): HttpAuthKind[] {
  return Array.isArray(auth) ? [...auth] : [auth as HttpAuthKind];
}

function scopeOf(kinds: HttpAuthKind[]): string | string[] {
  const scopes = kinds.map((k) => (k === "none" ? SCOPE_NONE : SECURITY_SCHEMES[k].scope));
  return scopes.length === 1 ? scopes[0] : scopes;
}

function securityOf(kinds: HttpAuthKind[]): JsonObject[] {
  if (kinds.includes("none")) {
    return [];
  }
  return kinds.map((k) => ({
    [SECURITY_SCHEMES[k as Exclude<HttpAuthKind, "none">].name]: [],
  }));
}

function objectParameters(schema: TSchema | undefined, location: "path" | "query" | "header") {
  if (!schema) {
    return [];
  }
  const plain = toPlainJsonSchema(schema) as {
    properties?: Record<string, JsonObject>;
    required?: string[];
  };
  const required = new Set(plain.required ?? []);
  return Object.entries(plain.properties ?? {}).map(([name, prop]) => {
    const { description, ...rest } = prop as JsonObject & { description?: string };
    return {
      name,
      in: location,
      required: location === "path" ? true : required.has(name),
      ...(description ? { description } : {}),
      schema: rest,
    };
  });
}

function pathParamNames(path: string): string[] {
  return [...path.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)].map((m) => m[1]);
}

function responseObject(spec: ResponseSpec | SharedResponseName): JsonObject {
  if (typeof spec === "string") {
    return { $ref: `#/components/responses/${spec}` };
  }
  const out: JsonObject = { description: spec.description };
  if (spec.headers) {
    out.headers = Object.fromEntries(
      Object.entries(spec.headers).map(([name, h]) => [
        name,
        { description: h.description, schema: toPlainJsonSchema(h.schema) },
      ]),
    );
  }
  if (spec.schema) {
    out.content = {
      [spec.contentType ?? "application/json"]: { schema: toPlainJsonSchema(spec.schema) },
    };
  }
  return out;
}

function rateLimitOf(path: string): JsonObject {
  const limitClass = httpRateLimitClass(path);
  const window = HTTP_RATE_LIMITS[limitClass];
  return {
    class: limitClass,
    limit: window.limit,
    windowSeconds: window.windowMs / 1000,
    credentialAttempts: isAuthBearingPath(path)
      ? { limit: AUTH_ATTEMPT_LIMIT, windowSeconds: AUTH_ATTEMPT_WINDOW_MS / 1000 }
      : "only when the request carries credentials and fails with 401/403",
  };
}

function operationOf(route: BoundRoute): JsonObject {
  const kinds = authKinds(route.auth);
  const declared = new Set(pathParamNames(route.path));
  const parameters = [
    ...objectParameters(route.request?.params, "path"),
    ...objectParameters(route.request?.query, "query"),
    ...objectParameters(route.request?.headers, "header"),
  ];
  for (const name of declared) {
    if (!parameters.some((p) => p.in === "path" && p.name === name)) {
      parameters.push({ name, in: "path", required: true, schema: { type: "string" } });
    }
  }

  const responses: Record<string, JsonObject> = {};
  const codes = Object.keys(route.responses)
    .map(Number)
    .toSorted((a, b) => a - b);
  for (const code of codes) {
    responses[String(code)] = responseObject(route.responses[code]);
  }
  if (!kinds.includes("none") && route.authEnforcedBy !== "handler" && !responses["401"]) {
    responses["401"] = responseObject("Unauthorized");
  }
  if (!responses["429"]) {
    responses["429"] = responseObject("TooManyRequests");
  }
  const ordered = Object.fromEntries(
    Object.entries(responses).toSorted(([a], [b]) => Number(a) - Number(b)),
  );

  const op: JsonObject = {
    operationId: route.operationId,
    summary: route.summary,
    ...(route.description ? { description: route.description } : {}),
    tags: route.tags,
    security: securityOf(kinds),
    "x-kolo-scope": scopeOf(kinds),
    "x-kolo-auth-enforced-by": kinds.includes("none") ? "none" : (route.authEnforcedBy ?? "router"),
    "x-kolo-rate-limit": rateLimitOf(route.path),
  };
  if (kinds.includes("pair-credential")) {
    op["x-kolo-min-scope"] = routeMinScope(route);
  }
  if (route.servedBy) {
    op["x-kolo-served-by"] = route.servedBy;
  }
  if (parameters.length > 0) {
    op.parameters = parameters;
  }
  if (route.request?.body) {
    op.requestBody = {
      required: route.request.bodyRequired ?? true,
      content: {
        [route.request.bodyContentType ?? "application/json"]: {
          schema: toPlainJsonSchema(route.request.body),
        },
      },
    };
  }
  op.responses = ordered;
  for (const [key, value] of Object.entries(route.extensions ?? {})) {
    op[key] = value;
  }
  return op;
}

function undocumentedOf(mount: BoundMount): JsonObject {
  const kinds = authKinds(mount.auth);
  return {
    id: mount.id,
    // A dispatcher whose operations are all documented (hooks) is listed for completeness only.
    "x-kolo-undocumented": !mount.documents?.length,
    summary: mount.summary,
    paths: mount.paths,
    methods: mount.methods === "*" ? "*" : [...mount.methods],
    security: securityOf(kinds),
    "x-kolo-scope": scopeOf(kinds),
    reason: mount.reason,
    ...(mount.documents?.length ? { documents: mount.documents } : {}),
  };
}

function websocketOf(ws: WebSocketDescription, schemaNames: Set<string>): JsonObject {
  const ref = (name: string | undefined) => {
    if (!name) {
      return undefined;
    }
    schemaNames.add(name);
    return { $ref: `#/components/schemas/${name}` };
  };
  const methods = [...new Set(ws.methods)].toSorted().map((name) => {
    const names = resolveMethodSchemaNames(name);
    return {
      name,
      ...(names.params ? { params: ref(names.params) } : {}),
      ...(names.result ? { result: ref(names.result) } : {}),
      ...(!names.params && !names.result ? { "x-kolo-untyped": true } : {}),
    };
  });
  const events = [...new Set(ws.events)].toSorted().map((name) => {
    const schema = resolveEventSchemaName(name);
    return { name, ...(schema ? { payload: ref(schema) } : { "x-kolo-untyped": true }) };
  });
  return {
    url: "ws://127.0.0.1:{port}/",
    protocolVersion: PROTOCOL_VERSION,
    description:
      "JSON frames over one WebSocket. The first request must be `connect` (ConnectParams, " +
      "auth.token = gateway secret or a paired device token); the gateway answers hello-ok. " +
      "Then `req` frames call methods and `event` frames stream server events. The schema for " +
      "the frames alone is published as dist/protocol.schema.json.",
    frames: {
      request: ref("RequestFrame"),
      response: ref("ResponseFrame"),
      event: ref("EventFrame"),
    },
    handshake: { method: "connect", params: ref("ConnectParams"), result: ref("HelloOk") },
    errors: ref("ErrorShape"),
    rateLimit: "10 new connections per minute per IP; 30 messages per second per client",
    methods,
    events,
  };
}

/** Builds the OpenAPI 3.1 document for a set of routes and mounts. */
export function buildOpenApiDocument(
  registry: { routes: readonly BoundRoute[]; mounts: readonly BoundMount[] },
  opts: OpenApiBuildOptions = {},
): JsonObject {
  const routes = [...registry.routes, ...(opts.runtimeRoutes ?? [])];
  const paths: Record<string, Record<string, JsonObject>> = {};
  const usedKinds = new Set<HttpAuthKind>();
  for (const route of routes) {
    const item = (paths[route.path] ??= {});
    item[route.method.toLowerCase()] = operationOf(route);
    for (const kind of authKinds(route.auth)) {
      usedKinds.add(kind);
    }
  }
  for (const mount of registry.mounts) {
    for (const kind of authKinds(mount.auth)) {
      usedKinds.add(kind);
    }
  }

  const schemas: Record<string, unknown> = { ...ERROR_SCHEMAS };
  let websocket: JsonObject | undefined;
  if (opts.websocket) {
    const names = new Set<string>();
    websocket = websocketOf(opts.websocket, names);
    const defs = protocolDefinitions();
    for (const name of [...names].toSorted()) {
      if (name in schemas) {
        throw new Error(`OpenAPI schema name collision: ${name}`);
      }
      schemas[name] = defs[name];
    }
  }

  const securitySchemes: Record<string, JsonObject> = {};
  for (const [kind, entry] of Object.entries(SECURITY_SCHEMES)) {
    if (usedKinds.has(kind as HttpAuthKind)) {
      securitySchemes[entry.name] = { ...entry.scheme, "x-kolo-scope": entry.scope };
    }
  }

  const tags = [...new Set(routes.flatMap((r) => r.tags))].toSorted().map((name) => ({ name }));

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: "KoLo Gateway API",
      version: opts.version ?? "0.0.0",
      description:
        "HTTP surface of one Kurahi gateway (one per identity). Generated from the route " +
        "registry in src/gateway/http-routes.ts; the gateway serves the live copy at GET /doc. " +
        "Every operation names its token class in `x-kolo-scope`. All HTTP requests share a " +
        "per-IP sliding window (x-kolo-rate-limit) and credential-bearing requests also count " +
        `against a ${AUTH_ATTEMPT_LIMIT}/min credential-attempt limiter; both answer 429 with ` +
        "Retry-After. Routes that exist but are not described operation by operation are " +
        "listed in x-kolo-undocumented-routes with the reason.",
      license: { name: "MIT" },
    },
    jsonSchemaDialect: "https://spec.openapis.org/oas/3.1/dialect/base",
    servers: [
      {
        url: "http://127.0.0.1:{port}",
        description: "Loopback (default bind). Remote access is an explicit opt-in.",
        variables: { port: { default: String(DEFAULT_GATEWAY_PORT) } },
      },
    ],
    tags,
    paths: Object.fromEntries(
      Object.keys(paths)
        .toSorted()
        .map((p) => [p, paths[p]]),
    ),
    components: {
      securitySchemes,
      schemas,
      responses: SHARED_RESPONSES,
      headers: RATE_LIMIT_HEADERS,
    },
    "x-kolo-undocumented-routes": registry.mounts.map(undocumentedOf),
    ...(websocket ? { "x-kolo-websocket": websocket } : {}),
  };
}

/** Operation count of a built document (for smoke checks and tests). */
export function countOperations(doc: JsonObject): number {
  const paths = (doc.paths ?? {}) as Record<string, Record<string, unknown>>;
  return Object.values(paths).reduce((n, item) => n + Object.keys(item).length, 0);
}
