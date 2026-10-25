import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";

const sessions = vi.hoisted(() => ({ role: null as string | null }));
vi.mock("./auth-api.js", () => ({
  getAdminSessionUser: async (req: IncomingMessage) => {
    const cookie = String(req.headers.cookie ?? "");
    if (!cookie.includes("kolo_session=valid")) {
      return null;
    }
    return sessions.role === "admin" ? { id: "u1", role: sessions.role } : null;
  },
}));

const { isProtectedAdminPath, rejectUnauthorizedAdminRequest } =
  await import("./http-admin-auth.js");

const auth = { mode: "token" as const, token: "gw-secret", allowTailscale: false };

function makeReq(
  url: string,
  headers: Record<string, string> = {},
  remote = false,
): IncomingMessage {
  return {
    url,
    method: "GET",
    headers: { host: remote ? "gateway.example.test" : "127.0.0.1:18800", ...headers },
    socket: { remoteAddress: remote ? "203.0.113.7" : "127.0.0.1" },
  } as unknown as IncomingMessage;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: "",
    setHeader: () => undefined,
    end(chunk?: string) {
      res.body = chunk ?? "";
    },
  };
  return res;
}

async function gate(
  url: string,
  headers?: Record<string, string>,
  opts: { remote?: boolean; ssoRequired?: boolean } = {},
) {
  const res = makeRes();
  const rejected = await rejectUnauthorizedAdminRequest(
    makeReq(url, headers, opts.remote),
    res as unknown as ServerResponse,
    { auth, ssoRequired: opts.ssoRequired },
  );
  return { rejected, status: res.statusCode };
}

describe("admin/metrics auth gate", () => {
  it("protects /metrics and /api/admin/* but not health", () => {
    expect(isProtectedAdminPath("/metrics")).toBe(true);
    expect(isProtectedAdminPath("/api/admin/status")).toBe(true);
    expect(isProtectedAdminPath("/api/admin/covenants/u1")).toBe(true);
    expect(isProtectedAdminPath("/health")).toBe(false);
    expect(isProtectedAdminPath("/api/health")).toBe(false);
  });

  it("returns 401 without auth", async () => {
    for (const url of ["/metrics", "/api/admin/status", "/api/admin/covenants/u1"]) {
      expect(await gate(url)).toEqual({ rejected: true, status: 401 });
    }
  });

  it("returns 401 with a wrong bearer token", async () => {
    expect(await gate("/metrics", { authorization: "Bearer nope" })).toEqual({
      rejected: true,
      status: 401,
    });
  });

  it("lets the gateway bearer token through", async () => {
    expect((await gate("/metrics", { authorization: "Bearer gw-secret" })).rejected).toBe(false);
    expect((await gate("/api/admin/audit", { authorization: "Bearer gw-secret" })).rejected).toBe(
      false,
    );
  });

  it("lets an admin kolo_session through, not a member", async () => {
    sessions.role = "member";
    expect((await gate("/api/admin/users", { cookie: "kolo_session=valid" })).status).toBe(401);
    sessions.role = "admin";
    expect((await gate("/api/admin/users", { cookie: "kolo_session=valid" })).rejected).toBe(false);
  });

  it("leaves health and other routes alone", async () => {
    expect(await gate("/health")).toEqual({ rejected: false, status: 200 });
    expect(await gate("/api/health")).toEqual({ rejected: false, status: 200 });
  });

  describe("with gateway.identity.ssoRequired", () => {
    const bearer = { authorization: "Bearer gw-secret" };
    const sso = { ssoRequired: true };

    it("refuses the gateway token from another host, with or without a break-glass reason", async () => {
      for (const url of ["/metrics", "/api/admin/status"]) {
        expect(await gate(url, bearer, { ...sso, remote: true })).toEqual({
          rejected: true,
          status: 401,
        });
        expect(
          await gate(url, { ...bearer, "x-kolo-break-glass": "outage" }, { ...sso, remote: true }),
        ).toEqual({ rejected: true, status: 401 });
      }
      // Without SSO required the remote token works as before.
      expect((await gate("/metrics", bearer, { remote: true })).rejected).toBe(false);
    });

    it("on the gateway host the token needs a break-glass reason", async () => {
      expect(await gate("/api/admin/status", bearer, sso)).toEqual({ rejected: true, status: 401 });
      expect(
        (await gate("/api/admin/status", { ...bearer, "x-kolo-break-glass": "IdP down" }, sso))
          .rejected,
      ).toBe(false);
    });

    it("refuses a legacy admin session from another host", async () => {
      sessions.role = "admin";
      const cookie = { cookie: "kolo_session=valid" };
      expect(await gate("/api/admin/users", cookie, { ...sso, remote: true })).toEqual({
        rejected: true,
        status: 401,
      });
      expect((await gate("/api/admin/users", cookie, sso)).rejected).toBe(false);
    });
  });
});
