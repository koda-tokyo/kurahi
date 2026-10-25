// HTTP route registry (KoLo 2.0, M4a): every HTTP route the gateway serves is declared here
// once, with its auth kind and TypeBox request/response schemas. The router dispatches from the
// same declarations, and the OpenAPI 3.1 document (`GET /doc`) is generated from them, so the
// described API and the served API cannot drift apart.
//
// Two kinds of entries:
//   routes  exact method + path template ("/api/admin/covenants/{userId}"), dispatched by
//           `HttpRouter.dispatch`; auth is enforced by the router unless `authEnforcedBy` is
//           "handler" (the handler owns a route-specific error shape, e.g. 403 for a migrate key).
//   mounts  prefix/dynamic handlers that cannot be described operation by operation this
//           milestone (static assets, plugin webhooks, hooks with a configurable base path).
//           Each carries a reason and is listed in the spec under `x-kolo-undocumented-routes`.
import type { TSchema } from "@sinclair/typebox";
import type { IncomingMessage, ServerResponse } from "node:http";
import { buildOpenApiDocument, type OpenApiBuildOptions } from "./http-openapi.js";
import { PAIR_SCOPES, type PairScope, routeMinScope } from "./scopes.js";

export { routeMinScope };

export const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Token classes that can authorize an HTTP request. An array on a route means "any of". */
export const HTTP_AUTH_KINDS = [
  "none",
  "gateway-token",
  "session-admin",
  "pair-credential",
  "hook-token",
  "migrate-key",
  "plugin",
  "sso-session",
  "scim-token",
] as const;
export type HttpAuthKind = (typeof HTTP_AUTH_KINDS)[number];

/** Responses shared by many operations; defined once under `components.responses`. */
export type SharedResponseName =
  | "BadRequest"
  | "Unauthorized"
  | "Forbidden"
  | "NotFound"
  | "MethodNotAllowed"
  | "PayloadTooLarge"
  | "TooManyRequests"
  | "InternalError";

export type ResponseSpec = {
  description: string;
  /** Body schema; omit for an empty body. */
  schema?: TSchema;
  /** Defaults to application/json. */
  contentType?: string;
  headers?: Record<string, { description: string; schema: TSchema }>;
};

export type RouteContext = {
  url: URL;
  params: Record<string, string>;
};

/** Returns false to decline (the request continues to the mounts and then 404). */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => Promise<boolean | void> | boolean | void;

export type MountHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => Promise<boolean> | boolean;

export type RouteStage = "pre-auth" | "main";

export type RouteDefinition = {
  method: HttpMethod;
  /** Path template; `{name}` matches one non-empty segment. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  auth: HttpAuthKind | readonly HttpAuthKind[];
  /**
   * Minimum pairing scope a `pair-credential` needs (M3a). Defaults to the table in
   * scopes.ts, and to `admin` when the operation is not listed there, so a new route is never
   * open to a lesser credential by accident. Owner credentials satisfy every scope.
   */
  minScope?: PairScope;
  /** "router" (default): the router checks auth before calling the handler. */
  authEnforcedBy?: "router" | "handler";
  /**
   * "pre-auth" routes are dispatched before the credential-attempt gates (liveness probes).
   * Default "main".
   */
  stage?: RouteStage;
  request?: {
    params?: TSchema;
    query?: TSchema;
    headers?: TSchema;
    body?: TSchema;
    bodyContentType?: string;
    bodyRequired?: boolean;
  };
  responses: Record<number, ResponseSpec | SharedResponseName>;
  /**
   * Declared-only route whose requests are dispatched by the mount with this id (for example
   * hooks, whose base path comes from config).
   */
  servedBy?: string;
  /** Extra `x-*` keys copied onto the operation. */
  extensions?: Record<`x-${string}`, unknown>;
};

export type BoundRoute = RouteDefinition & {
  handler?: RouteHandler;
  /** Runtime switch (e.g. /v1/* disabled in config): a disabled route is invisible to matching. */
  enabled?: () => boolean;
};

export type MountDefinition = {
  id: string;
  summary: string;
  /** Path patterns this mount answers (documentation; `*` = any suffix). */
  paths: string[];
  methods: readonly HttpMethod[] | "*";
  auth: HttpAuthKind | readonly HttpAuthKind[];
  /** Why the routes under this mount are not described operation by operation. */
  reason: string;
  /** "before-routes" mounts see the request before route matching. Default "after-routes". */
  phase?: "before-routes" | "after-routes";
  /** Operations (by operationId) this mount serves that ARE documented. */
  documents?: string[];
};

export type BoundMount = MountDefinition & { handler?: MountHandler };

/**
 * `true` authenticates; `false` means this token class is absent or wrong; "forbidden" means
 * the credential is valid but its scope is below the route's minimum (answered 403, not 401).
 */
export type AuthDecision = boolean | "forbidden";
export type Authenticator = (
  req: IncomingMessage,
  route: BoundRoute,
) => Promise<AuthDecision> | AuthDecision;

export type RouteMatch =
  | { kind: "match"; route: BoundRoute; params: Record<string, string> }
  | { kind: "method-not-allowed"; allow: HttpMethod[] }
  | { kind: "none" };

type CompiledPath = { segments: Array<{ literal: string } | { param: string }>; literals: number };

const PARAM_SEGMENT = /^\{([A-Za-z_][A-Za-z0-9_]*)\}$/;
const OPERATION_ID = /^[a-z][A-Za-z0-9]*$/;

function compilePath(path: string): CompiledPath {
  if (!path.startsWith("/")) {
    throw new Error(`http route path must start with "/": ${path}`);
  }
  const segments = path
    .slice(1)
    .split("/")
    .map((segment) => {
      const param = PARAM_SEGMENT.exec(segment);
      if (param) {
        return { param: param[1] };
      }
      if (segment.includes("{") || segment.includes("}")) {
        throw new Error(`http route path has a malformed parameter: ${path}`);
      }
      return { literal: segment };
    });
  return { segments, literals: segments.filter((s) => "literal" in s).length };
}

function matchCompiled(compiled: CompiledPath, pathname: string): Record<string, string> | null {
  const parts = pathname.slice(1).split("/");
  if (!pathname.startsWith("/") || parts.length !== compiled.segments.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < parts.length; i++) {
    const segment = compiled.segments[i];
    const part = parts[i];
    if ("literal" in segment) {
      if (segment.literal !== part) {
        return null;
      }
      continue;
    }
    if (!part) {
      return null;
    }
    try {
      params[segment.param] = decodeURIComponent(part);
    } catch {
      return null;
    }
  }
  return params;
}

export function authKindsOf(auth: HttpAuthKind | readonly HttpAuthKind[]): HttpAuthKind[] {
  return Array.isArray(auth) ? [...auth] : [auth as HttpAuthKind];
}

/** Validates a route declaration (throws on a malformed one) and returns it unchanged. */
export function defineRoute<T extends BoundRoute>(def: T): T {
  if (!HTTP_METHODS.includes(def.method)) {
    throw new Error(`http route ${def.operationId}: unsupported method ${def.method}`);
  }
  if (!OPERATION_ID.test(def.operationId)) {
    throw new Error(`http route operationId must be lowerCamelCase: ${def.operationId}`);
  }
  const kinds = authKindsOf(def.auth);
  if (kinds.length === 0 || kinds.some((k) => !HTTP_AUTH_KINDS.includes(k))) {
    throw new Error(`http route ${def.operationId}: invalid auth ${JSON.stringify(def.auth)}`);
  }
  if (kinds.includes("none") && kinds.length > 1) {
    throw new Error(`http route ${def.operationId}: "none" cannot be combined with other auth`);
  }
  if (!def.summary.trim() || def.tags.length === 0) {
    throw new Error(`http route ${def.operationId}: summary and tags are required`);
  }
  if (def.minScope !== undefined && !PAIR_SCOPES.includes(def.minScope)) {
    throw new Error(`http route ${def.operationId}: invalid minScope ${String(def.minScope)}`);
  }
  // A success is a 2xx, or a 3xx for browser redirect steps (SSO sign-in).
  if (!def.responses[200] && !Object.keys(def.responses).some((code) => /^[23]/.test(code))) {
    throw new Error(`http route ${def.operationId}: needs a 2xx or 3xx response`);
  }
  compilePath(def.path);
  return def;
}

export function defineMount<T extends BoundMount>(def: T): T {
  if (!def.reason.trim()) {
    throw new Error(`http mount ${def.id}: undocumented mounts need a reason`);
  }
  return def;
}

function writeMethodNotAllowed(res: ServerResponse, allow: HttpMethod[]) {
  res.statusCode = 405;
  res.setHeader("Allow", allow.join(", "));
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Method Not Allowed");
}

function writeUnauthorized(res: ServerResponse) {
  res.statusCode = 401;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: { message: "Unauthorized", type: "unauthorized" } }));
}

function writeForbidden(res: ServerResponse) {
  res.statusCode = 403;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: { message: "Forbidden", type: "forbidden" } }));
}

export type HttpRouterOptions = {
  /** One authenticator per token class; a missing one fails closed (401). */
  authenticators?: Partial<Record<HttpAuthKind, Authenticator>>;
  onUnauthorized?: (req: IncomingMessage, res: ServerResponse, route: BoundRoute) => void;
  /** Valid credential, insufficient scope (default: 403 JSON error model). */
  onForbidden?: (req: IncomingMessage, res: ServerResponse, route: BoundRoute) => void;
  /**
   * M13: consulted after authentication and before the handler. A refusal is answered 403 with
   * the policy rule id; the handler never runs.
   */
  policyGate?: (
    req: IncomingMessage,
    route: BoundRoute,
  ) => { ok: true } | { ok: false; rule: string; reason: string };
};

export class HttpRouter {
  private readonly entries: Array<{ route: BoundRoute; compiled: CompiledPath }> = [];
  private readonly mountList: BoundMount[] = [];
  private readonly authenticators: Partial<Record<HttpAuthKind, Authenticator>>;
  private readonly onUnauthorized: NonNullable<HttpRouterOptions["onUnauthorized"]>;
  private readonly policyGate: HttpRouterOptions["policyGate"];
  private readonly onForbidden: NonNullable<HttpRouterOptions["onForbidden"]>;

  constructor(opts: HttpRouterOptions = {}) {
    this.authenticators = opts.authenticators ?? {};
    this.onUnauthorized = opts.onUnauthorized ?? ((_req, res) => writeUnauthorized(res));
    this.onForbidden = opts.onForbidden ?? ((_req, res) => writeForbidden(res));
    this.policyGate = opts.policyGate;
  }

  add(route: BoundRoute): this {
    defineRoute(route);
    for (const { route: existing } of this.entries) {
      if (existing.operationId === route.operationId) {
        throw new Error(`duplicate http operationId: ${route.operationId}`);
      }
      if (existing.method === route.method && existing.path === route.path) {
        throw new Error(`duplicate http route: ${route.method} ${route.path}`);
      }
    }
    this.entries.push({ route, compiled: compilePath(route.path) });
    return this;
  }

  mount(mount: BoundMount): this {
    defineMount(mount);
    if (this.mountList.some((m) => m.id === mount.id)) {
      throw new Error(`duplicate http mount: ${mount.id}`);
    }
    this.mountList.push(mount);
    return this;
  }

  routes(): readonly BoundRoute[] {
    return this.entries.map((e) => e.route);
  }

  mounts(): readonly BoundMount[] {
    return this.mountList;
  }

  /**
   * Resolves method + pathname. The most specific path wins (more literal segments); a path that
   * exists for other methods only yields method-not-allowed with the Allow list.
   */
  match(
    method: string,
    pathname: string,
    filter: (route: BoundRoute) => boolean = () => true,
  ): RouteMatch {
    const upper = method.toUpperCase();
    let best: { route: BoundRoute; params: Record<string, string>; literals: number } | null = null;
    const allow = new Set<HttpMethod>();
    for (const { route, compiled } of this.entries) {
      if (!filter(route)) {
        continue;
      }
      const params = matchCompiled(compiled, pathname);
      if (!params) {
        continue;
      }
      allow.add(route.method);
      if (route.method === upper && (!best || compiled.literals > best.literals)) {
        best = { route, params, literals: compiled.literals };
      }
    }
    if (best) {
      return { kind: "match", route: best.route, params: best.params };
    }
    if (allow.size > 0) {
      return { kind: "method-not-allowed", allow: HTTP_METHODS.filter((m) => allow.has(m)) };
    }
    return { kind: "none" };
  }

  private async authorize(
    req: IncomingMessage,
    route: BoundRoute,
  ): Promise<"ok" | "unauthorized" | "forbidden"> {
    const kinds = authKindsOf(route.auth);
    if (kinds.includes("none") || route.authEnforcedBy === "handler") {
      return "ok";
    }
    let forbidden = false;
    for (const kind of kinds) {
      const check = this.authenticators[kind];
      if (!check) {
        continue;
      }
      const decision = await check(req, route);
      if (decision === true) {
        return "ok";
      }
      if (decision === "forbidden") {
        forbidden = true;
      }
    }
    return forbidden ? "forbidden" : "unauthorized";
  }

  /**
   * Dispatches to a bound route of the given stage. Returns true when a response was written
   * (including 405 and 401), false when no route claimed the request.
   */
  async dispatch(
    req: IncomingMessage,
    res: ServerResponse,
    opts: { stage?: RouteStage } = {},
  ): Promise<boolean> {
    const stage = opts.stage ?? "main";
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://localhost");
    } catch {
      return false;
    }
    const found = this.match(
      req.method ?? "GET",
      url.pathname,
      (route) =>
        (route.stage ?? "main") === stage &&
        Boolean(route.handler) &&
        (route.enabled ? route.enabled() : true),
    );
    if (found.kind === "none") {
      return false;
    }
    if (found.kind === "method-not-allowed") {
      writeMethodNotAllowed(res, found.allow);
      return true;
    }
    const { route, params } = found;
    const decision = await this.authorize(req, route);
    if (decision === "unauthorized") {
      this.onUnauthorized(req, res, route);
      return true;
    }
    if (decision === "forbidden") {
      this.onForbidden(req, res, route);
      return true;
    }
    if (this.policyGate && route.auth !== "none") {
      const gate = this.policyGate(req, route);
      if (!gate.ok) {
        res.statusCode = 403;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(
          JSON.stringify({
            error: {
              message: `policy: ${gate.reason} (rule ${gate.rule})`,
              type: "policy_denied",
              rule: gate.rule,
            },
          }),
        );
        return true;
      }
    }
    const handled = await route.handler?.(req, res, { url, params });
    return handled !== false;
  }

  /** Runs the bound mounts of one phase in registration order. */
  async dispatchMounts(
    req: IncomingMessage,
    res: ServerResponse,
    phase: "before-routes" | "after-routes",
  ): Promise<boolean> {
    for (const mount of this.mountList) {
      if ((mount.phase ?? "after-routes") !== phase || !mount.handler) {
        continue;
      }
      if (await mount.handler(req, res)) {
        return true;
      }
    }
    return false;
  }

  toOpenAPI(opts: OpenApiBuildOptions = {}): Record<string, unknown> {
    return buildOpenApiDocument({ routes: this.routes(), mounts: this.mounts() }, opts);
  }
}

export function createHttpRouter(opts?: HttpRouterOptions): HttpRouter {
  return new HttpRouter(opts);
}
