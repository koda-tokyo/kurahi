// src/gateway/auth-api.ts
// Authentication API for invite-only auth
//
// Flow:
// 1. Admin creates invite → POST /api/admin/invites
// 2. User redeems invite → POST /api/auth/redeem
// 3. User gets session → Cookie/Header auth
// 4. User logs out → POST /api/auth/logout

import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { CreateInvite } from "../db/types.js";
import { auditHttpAuthFailure } from "../audit/http.js";
import {
  createInvite,
  redeemInvite,
  validateSession,
  logout,
  listPendingInvites,
} from "../db/invite.js";
import { requestClientIp } from "./request-client-ip.js";

// ============================================================================
// Request Parsing Helpers
// ============================================================================

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function getSessionToken(req: IncomingMessage): string | null {
  // Check Authorization header first
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  // Check cookie
  const cookies = req.headers.cookie;
  if (cookies) {
    const match = cookies.match(/kolo_session=([^;]+)/);
    if (match) {
      return match[1];
    }
  }

  return null;
}

function setSessionCookie(res: ServerResponse, token: string, maxAgeSeconds: number) {
  const cookie = `kolo_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
  res.setHeader("Set-Cookie", cookie);
}

function clearSessionCookie(res: ServerResponse) {
  res.setHeader("Set-Cookie", "kolo_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
}

// ============================================================================
// Schemas
// ============================================================================

const CreateInviteBodySchema = z.object({
  email: z.string().email(),
  workspaceId: z.string().uuid(),
  role: z.enum(["owner", "admin", "member"]).default("member"),
});

const RedeemInviteBodySchema = z.object({
  token: z.string().min(1),
  name: z.string().optional(),
});

// ============================================================================
// POST /api/admin/invites - Create invite (admin only)
// ============================================================================

async function handleCreateInvite(
  req: IncomingMessage,
  res: ServerResponse,
  adminUserId: string,
): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const parsed = CreateInviteBodySchema.safeParse(body);

    if (!parsed.success) {
      sendJson(res, 400, {
        ok: false,
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }

    const { invite, token } = await createInvite(
      parsed.data as CreateInvite,
      adminUserId,
      requestClientIp(req),
    );

    // Generate invite URL
    const baseUrl = process.env.APP_URL ?? "http://localhost:3457";
    const inviteUrl = `${baseUrl}/invite?token=${encodeURIComponent(token)}`;

    sendJson(res, 201, {
      ok: true,
      invite: {
        id: invite.id,
        email: invite.email,
        workspaceId: invite.workspaceId,
        role: invite.role,
        expiresAt: invite.expiresAt.toISOString(),
      },
      inviteUrl,
      // Token is returned ONCE here - cannot be retrieved later
      token,
    });
  } catch (err) {
    console.error("[auth-api] Create invite failed:", err);
    sendJson(res, 500, { ok: false, error: "Failed to create invite" });
  }
}

// ============================================================================
// GET /api/admin/invites?workspaceId= - List pending invites
// ============================================================================

async function handleListInvites(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = parseUrl(req);
  const workspaceId = url.searchParams.get("workspaceId");

  if (!workspaceId) {
    sendJson(res, 400, { ok: false, error: "workspaceId required" });
    return;
  }

  try {
    const invites = await listPendingInvites(workspaceId);

    sendJson(res, 200, {
      ok: true,
      invites: invites.map((i) => ({
        id: i.id,
        email: i.email,
        role: i.role,
        expiresAt: i.expiresAt.toISOString(),
        createdAt: i.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[auth-api] List invites failed:", err);
    sendJson(res, 500, { ok: false, error: "Failed to list invites" });
  }
}

// ============================================================================
// POST /api/auth/redeem - Redeem invite token
// ============================================================================

async function handleRedeemInvite(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readJsonBody(req);
    const parsed = RedeemInviteBodySchema.safeParse(body);

    if (!parsed.success) {
      sendJson(res, 400, {
        ok: false,
        error: "Invalid request body",
        details: parsed.error.issues,
      });
      return;
    }

    const result = await redeemInvite(parsed.data.token, parsed.data.name, requestClientIp(req));

    // Set session cookie (30 days)
    setSessionCookie(res, result.sessionToken, 30 * 24 * 60 * 60);

    sendJson(res, 200, {
      ok: true,
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: result.user.role,
      },
      workspace: {
        id: result.workspaceId,
        name: result.workspaceName,
      },
      // Also return token for clients that prefer header auth
      sessionToken: result.sessionToken,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[auth-api] Redeem invite failed:", message);

    if (message === "Invalid or expired invite") {
      sendJson(res, 400, { ok: false, error: message });
    } else {
      sendJson(res, 500, { ok: false, error: "Failed to redeem invite" });
    }
  }
}

// ============================================================================
// GET /api/auth/me - Get current user
// ============================================================================

async function handleGetMe(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = getSessionToken(req);

  if (!token) {
    auditHttpAuthFailure(req, 401, "Not authenticated");
    sendJson(res, 401, { ok: false, error: "Not authenticated" });
    return;
  }

  try {
    const session = await validateSession(token);

    if (!session.valid || !session.user) {
      auditHttpAuthFailure(req, 401, "Invalid session");
      sendJson(res, 401, { ok: false, error: "Invalid session" });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      user: {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        role: session.user.role,
      },
      workspaces: session.workspaces,
    });
  } catch (err) {
    console.error("[auth-api] Get me failed:", err);
    sendJson(res, 500, { ok: false, error: "Failed to get user info" });
  }
}

// ============================================================================
// POST /api/auth/logout - Logout
// ============================================================================

async function handleLogout(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const token = getSessionToken(req);

  if (!token) {
    sendJson(res, 400, { ok: false, error: "No session to logout" });
    return;
  }

  try {
    await logout(token, requestClientIp(req));
    clearSessionCookie(res);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    console.error("[auth-api] Logout failed:", err);
    sendJson(res, 500, { ok: false, error: "Failed to logout" });
  }
}

// ============================================================================
// Main Handler
// ============================================================================

/**
 * Handle auth API requests.
 *
 * Endpoints:
 * - POST /api/admin/invites - Create invite (admin only)
 * - GET /api/admin/invites - List pending invites
 * - POST /api/auth/redeem - Redeem invite token
 * - GET /api/auth/me - Get current user
 * - POST /api/auth/logout - Logout
 *
 * Returns true if handled, false to pass to next handler.
 */
export async function handleAuthApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const url = parseUrl(req);
  const pathname = url.pathname;

  // POST /api/admin/invites - Create invite
  if (pathname === "/api/admin/invites" && req.method === "POST") {
    // Require admin auth
    const token = getSessionToken(req);
    if (!token) {
      auditHttpAuthFailure(req, 401, "Authentication required");
      sendJson(res, 401, { ok: false, error: "Authentication required" });
      return true;
    }

    const session = await validateSession(token);
    if (!session.valid || !session.user || session.user.role !== "admin") {
      auditHttpAuthFailure(req, 403, "Admin access required");
      sendJson(res, 403, { ok: false, error: "Admin access required" });
      return true;
    }

    await handleCreateInvite(req, res, session.user.id);
    return true;
  }

  // GET /api/admin/invites - List invites
  if (pathname === "/api/admin/invites" && req.method === "GET") {
    // Require admin auth
    const token = getSessionToken(req);
    if (!token) {
      auditHttpAuthFailure(req, 401, "Authentication required");
      sendJson(res, 401, { ok: false, error: "Authentication required" });
      return true;
    }

    const session = await validateSession(token);
    if (!session.valid || !session.user || session.user.role !== "admin") {
      auditHttpAuthFailure(req, 403, "Admin access required");
      sendJson(res, 403, { ok: false, error: "Admin access required" });
      return true;
    }

    await handleListInvites(req, res);
    return true;
  }

  // POST /api/auth/redeem - Public endpoint
  if (pathname === "/api/auth/redeem" && req.method === "POST") {
    await handleRedeemInvite(req, res);
    return true;
  }

  // GET /api/auth/me
  if (pathname === "/api/auth/me" && req.method === "GET") {
    await handleGetMe(req, res);
    return true;
  }

  // POST /api/auth/logout
  if (pathname === "/api/auth/logout" && req.method === "POST") {
    await handleLogout(req, res);
    return true;
  }

  return false;
}

/**
 * Middleware helper to get current user from request.
 * Returns null if not authenticated.
 */
export async function getCurrentUser(req: IncomingMessage) {
  const token = getSessionToken(req);
  if (!token) return null;

  const session = await validateSession(token);
  if (!session.valid || !session.user) return null;

  return session.user;
}

/**
 * Session user with the `admin` role, from the `kolo_session`
 * cookie or a Bearer session token. Any lookup failure (no DB, expired session) → null.
 */
export async function getAdminSessionUser(req: IncomingMessage) {
  const token = getSessionToken(req);
  if (!token) {
    return null;
  }
  try {
    const session = await validateSession(token);
    if (!session.valid || !session.user) {
      return null;
    }
    return session.user.role === "admin" ? session.user : null;
  } catch {
    return null;
  }
}
