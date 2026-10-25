// src/gateway/admin-api.ts
// Admin API endpoints for Kurahi Control Room
//
// Clients depend on these contracts:
// - GET /api/admin/status
// - GET /api/admin/audit
// - GET /api/admin/workspaces
// - GET /api/admin/users

import type { IncomingMessage, ServerResponse } from "node:http";
import { queryAuditEvents, getAuditStats, logAudit, AUDIT_ACTIONS } from "../db/audit.js";
import { query, mapUser, mapWorkspace } from "../db/client.js";
import { requestClientIp } from "./request-client-ip.js";

// ============================================================================
// Response Helpers
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

// ============================================================================
// GET /api/admin/status
// System status for Control Room dashboard
// ============================================================================

interface StatusResponse {
  ok: boolean;
  mode: "alpha" | "production";
  database: "connected" | "disconnected" | "not_configured";
  build: {
    sha: string;
    time: string;
  };
  features: {
    inviteOnly: boolean;
    jpComplianceMode: boolean;
    auditLogging: boolean;
  };
}

async function handleStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Check database connectivity
  let dbStatus: StatusResponse["database"] = "not_configured";
  try {
    await query("SELECT 1");
    dbStatus = "connected";
  } catch {
    dbStatus = "disconnected";
  }

  const response: StatusResponse = {
    ok: dbStatus === "connected",
    mode: "alpha",
    database: dbStatus,
    build: {
      sha: process.env.BUILD_SHA ?? "dev",
      time: process.env.BUILD_TIME ?? new Date().toISOString(),
    },
    features: {
      inviteOnly: true,
      jpComplianceMode: true,
      auditLogging: true,
    },
  };

  sendJson(res, 200, response);
}

// ============================================================================
// GET /api/admin/audit
// Audit log with filters and cursor pagination
// ============================================================================

interface AuditResponse {
  ok: boolean;
  events: Array<{
    id: string;
    timestamp: string;
    userId: string | null;
    action: string;
    targetType: string;
    targetId: string | null;
    ipAddress: string | null;
    metadata: Record<string, unknown>;
  }>;
  nextCursor: string | null;
  stats?: Record<string, number>;
}

async function handleAudit(
  req: IncomingMessage,
  res: ServerResponse,
  userId?: string,
): Promise<void> {
  const url = parseUrl(req);

  // Parse query params
  const filterUserId = url.searchParams.get("userId") ?? undefined;
  const action = url.searchParams.get("action") ?? undefined;
  const targetType = url.searchParams.get("targetType") ?? undefined;
  const targetId = url.searchParams.get("targetId") ?? undefined;
  const startDate = url.searchParams.get("startDate");
  const endDate = url.searchParams.get("endDate");
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "50", 10), 100);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  const includeStats = url.searchParams.get("stats") === "true";

  try {
    // Log that admin is viewing audit (meta!)
    if (userId) {
      await logAudit({
        userId,
        action: AUDIT_ACTIONS.ADMIN_VIEW_AUDIT,
        targetType: "audit",
        ipAddress: requestClientIp(req),
        metadata: { filterUserId, action, targetType },
      });
    }

    const { events, nextCursor } = await queryAuditEvents({
      userId: filterUserId,
      action,
      targetType,
      targetId,
      startDate: startDate ? new Date(startDate) : undefined,
      endDate: endDate ? new Date(endDate) : undefined,
      limit,
      cursor,
    });

    const response: AuditResponse = {
      ok: true,
      events: events.map((e) => ({
        ...e,
        timestamp: e.timestamp.toISOString(),
      })),
      nextCursor,
    };

    if (includeStats) {
      response.stats = await getAuditStats(
        startDate ? new Date(startDate) : undefined,
        endDate ? new Date(endDate) : undefined,
      );
    }

    sendJson(res, 200, response);
  } catch (err) {
    console.error("[admin-api] Audit query failed:", err);
    sendJson(res, 500, { ok: false, error: "Failed to query audit events" });
  }
}

// ============================================================================
// GET /api/admin/workspaces
// List all workspaces (admin only)
// ============================================================================

interface WorkspacesResponse {
  ok: boolean;
  workspaces: Array<{
    id: string;
    name: string;
    tier: number;
    jpComplianceMode: boolean;
    memberCount: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

async function handleWorkspaces(
  req: IncomingMessage,
  res: ServerResponse,
  userId?: string,
): Promise<void> {
  try {
    // Log admin view
    if (userId) {
      await logAudit({
        userId,
        action: AUDIT_ACTIONS.ADMIN_VIEW_WORKSPACE,
        targetType: "workspace",
        ipAddress: requestClientIp(req),
      });
    }

    const sql = `
      SELECT w.*, COUNT(wm.user_id) as member_count
      FROM workspaces w
      LEFT JOIN workspace_members wm ON w.id = wm.workspace_id
      GROUP BY w.id
      ORDER BY w.created_at DESC
    `;

    const result = await query(sql);

    const workspaces = result.rows.map((row) => ({
      ...mapWorkspace(row),
      memberCount: Number(row.member_count),
      createdAt: new Date(row.created_at as string).toISOString(),
      updatedAt: new Date(row.updated_at as string).toISOString(),
    }));

    sendJson(res, 200, { ok: true, workspaces });
  } catch (err) {
    console.error("[admin-api] Workspaces query failed:", err);
    sendJson(res, 500, { ok: false, error: "Failed to query workspaces" });
  }
}

// ============================================================================
// GET /api/admin/users
// List users, optionally filtered by workspaceId
// ============================================================================

interface UsersResponse {
  ok: boolean;
  users: Array<{
    id: string;
    email: string;
    name: string | null;
    role: string;
    workspaces: Array<{ id: string; name: string; role: string }>;
    createdAt: string;
    updatedAt: string;
  }>;
}

async function handleUsers(
  req: IncomingMessage,
  res: ServerResponse,
  adminUserId?: string,
): Promise<void> {
  const url = parseUrl(req);
  const workspaceId = url.searchParams.get("workspaceId");

  try {
    // Log admin view
    if (adminUserId) {
      await logAudit({
        userId: adminUserId,
        action: AUDIT_ACTIONS.ADMIN_VIEW_USER,
        targetType: "user",
        ipAddress: requestClientIp(req),
        metadata: { workspaceId },
      });
    }

    let sql: string;
    let params: unknown[];

    if (workspaceId) {
      sql = `
        SELECT u.*, wm.role as workspace_role
        FROM users u
        JOIN workspace_members wm ON u.id = wm.user_id
        WHERE wm.workspace_id = $1
        ORDER BY u.created_at DESC
      `;
      params = [workspaceId];
    } else {
      sql = `
        SELECT u.*
        FROM users u
        ORDER BY u.created_at DESC
      `;
      params = [];
    }

    const result = await query(sql, params);

    // For each user, get their workspaces
    const users = await Promise.all(
      result.rows.map(async (row) => {
        const user = mapUser(row);
        const membershipSql = `
          SELECT w.id, w.name, wm.role
          FROM workspaces w
          JOIN workspace_members wm ON w.id = wm.workspace_id
          WHERE wm.user_id = $1
        `;
        const memberships = await query(membershipSql, [user.id]);

        return {
          ...user,
          workspaces: memberships.rows.map((m) => ({
            id: m.id as string,
            name: m.name as string,
            role: m.role as string,
          })),
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
        };
      }),
    );

    sendJson(res, 200, { ok: true, users });
  } catch (err) {
    console.error("[admin-api] Users query failed:", err);
    sendJson(res, 500, { ok: false, error: "Failed to query users" });
  }
}

// ============================================================================
// Main Handler
// ============================================================================

const ADMIN_API_PREFIX = "/api/admin";

/**
 * Handle admin API requests.
 *
 * Endpoints:
 * - GET /api/admin/status - System status
 * - GET /api/admin/audit - Audit log with filters
 * - GET /api/admin/workspaces - List workspaces
 * - GET /api/admin/users - List users
 *
 * Returns true if handled, false to pass to next handler.
 */
export async function handleAdminApiRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options?: { userId?: string },
): Promise<boolean> {
  const url = parseUrl(req);
  const pathname = url.pathname;

  // Only handle /api/admin/* paths
  if (!pathname.startsWith(ADMIN_API_PREFIX)) {
    return false;
  }

  if (req.method !== "GET") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  const subPath = pathname.slice(ADMIN_API_PREFIX.length);

  switch (subPath) {
    case "/status":
      await handleStatus(req, res);
      return true;

    case "/audit":
      await handleAudit(req, res, options?.userId);
      return true;

    case "/workspaces":
      await handleWorkspaces(req, res, options?.userId);
      return true;

    case "/users":
      await handleUsers(req, res, options?.userId);
      return true;

    default:
      // Unknown admin endpoint
      sendJson(res, 404, { ok: false, error: "Unknown admin endpoint" });
      return true;
  }
}
