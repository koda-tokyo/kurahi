import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handleControlUiAvatarRequest, handleControlUiHttpRequest } from "./control-ui.js";

function call(
  handler: (req: IncomingMessage, res: ServerResponse) => boolean,
  url: string,
): { handled: boolean; status: number; headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {};
  let body = "";
  const res = {
    statusCode: 200,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = String(v);
    },
    end: (chunk?: string | Buffer) => {
      body = chunk ? chunk.toString() : "";
    },
  } as unknown as ServerResponse;
  const req = { url, method: "GET", headers: {} } as unknown as IncomingMessage;
  const handled = handler(req, res);
  return { handled, status: res.statusCode, headers, body };
}

const builtIndex = path.resolve(process.cwd(), "dist", "control-ui", "index.html");

describe("control UI security headers", () => {
  it("sets CSP (frame-ancestors 'none', nonce scripts), nosniff and Referrer-Policy", () => {
    const r = call((req, res) => handleControlUiHttpRequest(req, res, { basePath: "" }), "/");
    expect(r.handled).toBe(true);
    const csp = r.headers["content-security-policy"] ?? "";
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]{16,}'/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    expect(r.headers["referrer-policy"]).toBe("no-referrer");
  });

  it("uses a fresh nonce per response", () => {
    const nonceOf = () =>
      /'nonce-([^']+)'/.exec(
        call((req, res) => handleControlUiHttpRequest(req, res, { basePath: "" }), "/").headers[
          "content-security-policy"
        ] ?? "",
      )?.[1];
    expect(nonceOf()).not.toBe(nonceOf());
  });

  it.skipIf(!fs.existsSync(builtIndex))(
    "the built console page runs only same-origin scripts and the nonce'd bootstrap",
    () => {
      const r = call((req, res) => handleControlUiHttpRequest(req, res, { basePath: "" }), "/");
      expect(r.status).toBe(200);
      const nonce = /'nonce-([^']+)'/.exec(r.headers["content-security-policy"] ?? "")?.[1];
      const scripts = [...r.body.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
      expect(scripts.length).toBeGreaterThan(0);
      for (const attrs of scripts) {
        const src = /\bsrc="([^"]+)"/.exec(attrs)?.[1];
        if (src) {
          // Same origin (relative); allowed by script-src 'self'.
          expect(src).not.toMatch(/^[a-z]+:|^\/\//i);
        } else {
          expect(attrs).toContain(`nonce="${nonce}"`);
        }
      }
    },
  );

  it("sandboxes served avatar files", () => {
    const r = call(
      (req, res) =>
        handleControlUiAvatarRequest(req, res, {
          basePath: "",
          resolveAvatar: () => ({ kind: "none", reason: "test" }),
        }),
      "/avatar/main",
    );
    expect(r.handled).toBe(true);
    expect(r.headers["content-security-policy"]).toContain("sandbox");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
  });
});
