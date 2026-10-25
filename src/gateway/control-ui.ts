import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { KoLoConfig } from "../config/config.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import {
  buildControlUiAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "./control-ui-shared.js";

const ROOT_PREFIX = "/";

/**
 * Content-Security-Policy of the console (a Vite-built SPA: one module script, one stylesheet).
 * Scripts: same origin plus the per-response nonce of the injected bootstrap script, never
 * inline or eval. Styles: same origin, the Google Fonts stylesheet the console imports, and
 * inline styles (lit templates use `style=` attributes). connect-src stays open to ws/wss/http
 * (s) because the console can attach to a gateway URL other than its own origin; images too
 * (agent avatars are remote or data: URLs). Never framed (clickjacking).
 */
export function controlUiCsp(nonce: string): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob: https: http:",
    "connect-src 'self' ws: wss: http: https:",
    "worker-src 'self' blob:",
    "frame-src 'self'",
    "manifest-src 'self'",
  ].join("; ");
}

/** Served avatar files (may be SVG): no script, no plugins, sandboxed, never framed. */
export const CONTROL_UI_AVATAR_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; frame-ancestors 'none'; sandbox";

function setSecurityHeaders(res: ServerResponse, csp: string) {
  res.setHeader("Content-Security-Policy", csp);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

export type ControlUiRequestOptions = {
  basePath?: string;
  config?: KoLoConfig;
  agentId?: string;
};

function resolveControlUiRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const execDir = (() => {
    try {
      return path.dirname(fs.realpathSync(process.execPath));
    } catch {
      return null;
    }
  })();
  const candidates = [
    // Packaged app: control-ui lives alongside the executable.
    execDir ? path.resolve(execDir, "control-ui") : null,
    // Running from dist: dist/gateway/control-ui.js -> dist/control-ui
    path.resolve(here, "../control-ui"),
    // Running from source: src/gateway/control-ui.ts -> dist/control-ui
    path.resolve(here, "../../dist/control-ui"),
    // Fallback to cwd (dev)
    path.resolve(process.cwd(), "dist", "control-ui"),
  ].filter((dir): dir is string => Boolean(dir));
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }
  return null;
}

function contentTypeForExt(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

export type ControlUiAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

type ControlUiAvatarMeta = {
  avatarUrl: string | null;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

export function handleControlUiAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: { basePath?: string; resolveAvatar: (agentId: string) => ControlUiAvatarResolution },
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts.basePath);
  const pathname = url.pathname;
  const pathWithBase = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (!pathname.startsWith(pathWithBase)) {
    return false;
  }

  setSecurityHeaders(res, CONTROL_UI_AVATAR_CSP);
  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    respondNotFound(res);
    return true;
  }

  if (url.searchParams.get("meta") === "1") {
    const resolved = opts.resolveAvatar(agentId);
    const avatarUrl =
      resolved.kind === "local"
        ? buildControlUiAvatarUrl(basePath, agentId)
        : resolved.kind === "remote" || resolved.kind === "data"
          ? resolved.url
          : null;
    sendJson(res, 200, { avatarUrl } satisfies ControlUiAvatarMeta);
    return true;
  }

  const resolved = opts.resolveAvatar(agentId);
  if (resolved.kind !== "local") {
    respondNotFound(res);
    return true;
  }

  if (req.method === "HEAD") {
    res.statusCode = 200;
    res.setHeader("Content-Type", contentTypeForExt(path.extname(resolved.filePath).toLowerCase()));
    res.setHeader("Cache-Control", "no-cache");
    res.end();
    return true;
  }

  serveFile(res, resolved.filePath);
  return true;
}

function respondNotFound(res: ServerResponse) {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end("Not Found");
}

function serveFile(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  // Static UI should never be cached aggressively while iterating; allow the
  // browser to revalidate.
  res.setHeader("Cache-Control", "no-cache");
  res.end(fs.readFileSync(filePath));
}

interface ControlUiInjectionOpts {
  basePath: string;
  assistantName?: string;
  assistantAvatar?: string;
  /** CSP nonce of this response: the only inline script the console page may run. */
  nonce?: string;
}

/** JSON for an inline script: `<` escaped so a value can never close the script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function injectControlUiConfig(html: string, opts: ControlUiInjectionOpts): string {
  const { basePath, assistantName, assistantAvatar, nonce } = opts;
  const script =
    (nonce ? `<script nonce="${nonce}">` : `<script>`) +
    `window.__KOLO_CONTROL_UI_BASE_PATH__=${scriptJson(basePath)};` +
    `window.__KOLO_ASSISTANT_NAME__=${scriptJson(
      assistantName ?? DEFAULT_ASSISTANT_IDENTITY.name,
    )};` +
    `window.__KOLO_ASSISTANT_AVATAR__=${scriptJson(
      assistantAvatar ?? DEFAULT_ASSISTANT_IDENTITY.avatar,
    )};` +
    `</script>`;
  // Check if already injected
  if (html.includes("__KOLO_ASSISTANT_NAME__")) {
    return html;
  }
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) {
    return `${html.slice(0, headClose)}${script}${html.slice(headClose)}`;
  }
  return `${script}${html}`;
}

interface ServeIndexHtmlOpts {
  basePath: string;
  config?: KoLoConfig;
  agentId?: string;
  nonce: string;
}

function serveIndexHtml(res: ServerResponse, indexPath: string, opts: ServeIndexHtmlOpts) {
  const { basePath, config, agentId, nonce } = opts;
  const identity = config
    ? resolveAssistantIdentity({ cfg: config, agentId })
    : DEFAULT_ASSISTANT_IDENTITY;
  const resolvedAgentId =
    typeof (identity as { agentId?: string }).agentId === "string"
      ? (identity as { agentId?: string }).agentId
      : agentId;
  const avatarValue =
    resolveAssistantAvatarUrl({
      avatar: identity.avatar,
      agentId: resolvedAgentId,
      basePath,
    }) ?? identity.avatar;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  const raw = fs.readFileSync(indexPath, "utf8");
  res.end(
    injectControlUiConfig(raw, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: avatarValue,
      nonce,
    }),
  );
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith("../") || normalized === "..") {
    return false;
  }
  if (normalized.includes("\0")) {
    return false;
  }
  return true;
}

export function handleControlUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: ControlUiRequestOptions,
): boolean {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;

  if (!basePath) {
    if (pathname === "/ui" || pathname.startsWith("/ui/")) {
      respondNotFound(res);
      return true;
    }
  }

  if (basePath) {
    if (pathname === basePath) {
      res.statusCode = 302;
      res.setHeader("Location", `${basePath}/${url.search}`);
      res.end();
      return true;
    }
    if (!pathname.startsWith(`${basePath}/`)) {
      return false;
    }
  }

  // Every console response (page, assets, fallbacks) carries the security headers; the nonce
  // admits the bootstrap script injected into index.html and nothing else inline.
  const nonce = randomBytes(16).toString("base64");
  setSecurityHeaders(res, controlUiCsp(nonce));

  const root = resolveControlUiRoot();
  if (!root) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(
      "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.",
    );
    return true;
  }

  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const rel = (() => {
    if (uiPath === ROOT_PREFIX) {
      return "";
    }
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) {
      return uiPath.slice(assetsIndex + 1);
    }
    return uiPath.slice(1);
  })();
  const requested = rel && !rel.endsWith("/") ? rel : `${rel}index.html`;
  const fileRel = requested || "index.html";
  if (!isSafeRelativePath(fileRel)) {
    respondNotFound(res);
    return true;
  }

  const filePath = path.join(root, fileRel);
  if (!filePath.startsWith(root)) {
    respondNotFound(res);
    return true;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    if (path.basename(filePath) === "index.html") {
      serveIndexHtml(res, filePath, {
        basePath,
        config: opts?.config,
        agentId: opts?.agentId,
        nonce,
      });
      return true;
    }
    serveFile(res, filePath);
    return true;
  }

  // SPA fallback (client-side router): serve index.html for unknown paths.
  const indexPath = path.join(root, "index.html");
  if (fs.existsSync(indexPath)) {
    serveIndexHtml(res, indexPath, {
      basePath,
      config: opts?.config,
      agentId: opts?.agentId,
      nonce,
    });
    return true;
  }

  respondNotFound(res);
  return true;
}
