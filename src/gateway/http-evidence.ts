// HTTP handlers for job evidence (KoLo 2.0, M12c), declared in http-routes.ts: getJobEvidence,
// listJobEvidenceEvents, exportJobEvidence, getEvidenceView. The router authenticates (attach
// for reads, admin for export); a paired credential restricted to sessions only sees jobs of
// those sessions, an SSO person only jobs the Project access policy lets them read
// (identity/evidence-access.ts; 404 otherwise). Exports land under
// <KOLO_HOME>/evidence-exports, never at a caller-chosen path.
import type { IncomingMessage, ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import type { RouteContext, RouteHandler } from "./http-registry.js";
import { auditSafe, resolveAuditDir } from "../audit/audit-log.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { resolveStateDir } from "../config/paths.js";
import {
  EvidenceNotFoundError,
  EvidenceUnfinishedError,
  exportEvidenceBundle,
} from "../evidence/bundle.js";
import { EVIDENCE_VIEW_CSP, renderEvidenceHtml } from "../evidence/html.js";
import { isSafeJobId, readJobEvents, readJobManifest } from "../evidence/store.js";
import { summarizeEvents } from "../evidence/summary.js";
import { personMayReadJobEvidence } from "../identity/evidence-access.js";
import { getHttpPerson } from "../identity/http.js";
import { sendJson } from "./http-common.js";
import { getHttpPrincipal } from "./pair-auth.js";
import { sessionAllowed, sessionIdentityFromKey } from "./session-allowlist.js";
import { allowlistOf } from "./session-discovery.js";

export const EVIDENCE_EVENTS_MAX_LIMIT = 500;
const MAX_BODY_BYTES = 16 * 1024;

/** JSON object body; `{}` when empty; null when oversized or not an object. */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_BODY_BYTES) {
      return null;
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
export const EVIDENCE_EVENTS_DEFAULT_LIMIT = 100;

export function resolveEvidenceExportsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "evidence-exports");
}

export function createEvidenceHttpHandlers(
  deps: { gatewayVersion?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const env = deps.env;

  /** Events of a job the caller may see, or null after a 404 has been sent. */
  const load = (req: IncomingMessage, res: ServerResponse, ctx: RouteContext) => {
    const id = ctx.params.id ?? "";
    res.setHeader("Cache-Control", "no-store");
    const notFound = () => {
      sendJson(res, 404, { ok: false, error: `no evidence for job ${id}` });
      return null;
    };
    if (!isSafeJobId(id)) {
      return notFound();
    }
    const events = readJobEvents(id, env);
    if (events.length === 0) {
      return notFound();
    }
    const sessionKey =
      events[0].type === "job.start" ? String(events[0].data.sessionKey ?? "") : "";
    const allowlist = allowlistOf(getHttpPrincipal(req));
    if (allowlist && !sessionAllowed(allowlist, sessionIdentityFromKey(sessionKey))) {
      return notFound();
    }
    // An SSO person reads only jobs the Project access policy lets them see (404 otherwise, as
    // for a restricted pairing credential): attach scope alone is not enough.
    const person = getHttpPerson(req);
    if (person) {
      const projectId = events[0].type === "job.start" ? events[0].data.projectId : null;
      const job = { sessionKey, projectId: typeof projectId === "string" ? projectId : null };
      if (
        !personMayReadJobEvidence(person, job, { home: env ? resolveKoloHome({ env }) : undefined })
      ) {
        return notFound();
      }
    }
    return { id, events, manifest: readJobManifest(id, env) };
  };

  const getJobEvidence: RouteHandler = (req, res, ctx) => {
    const loaded = load(req, res, ctx);
    if (!loaded) {
      return true;
    }
    sendJson(res, 200, {
      ok: true,
      job: loaded.id,
      summary: summarizeEvents(loaded.events, { signed: Boolean(loaded.manifest) }),
      manifest: loaded.manifest,
    });
    return true;
  };

  const listJobEvidenceEvents: RouteHandler = (req, res, ctx) => {
    const loaded = load(req, res, ctx);
    if (!loaded) {
      return true;
    }
    const q = ctx.url.searchParams;
    const fromRaw = q.get("from");
    const limitRaw = q.get("limit");
    const from = fromRaw ? Number.parseInt(fromRaw, 10) : 1;
    const limit = limitRaw ? Number.parseInt(limitRaw, 10) : EVIDENCE_EVENTS_DEFAULT_LIMIT;
    if (!Number.isInteger(from) || from < 1) {
      sendJson(res, 400, { ok: false, error: "from must be a positive integer (1-based seq)" });
      return true;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > EVIDENCE_EVENTS_MAX_LIMIT) {
      sendJson(res, 400, { ok: false, error: `limit must be 1-${EVIDENCE_EVENTS_MAX_LIMIT}` });
      return true;
    }
    const total = loaded.events.length;
    const page = loaded.events.slice(from - 1, from - 1 + limit);
    const next = from + page.length;
    sendJson(res, 200, {
      ok: true,
      job: loaded.id,
      from,
      count: page.length,
      total,
      next: next <= total ? next : null,
      events: page,
    });
    return true;
  };

  const exportJobEvidence: RouteHandler = async (req, res, ctx) => {
    const loaded = load(req, res, ctx);
    if (!loaded) {
      return true;
    }
    const body = await readJsonBody(req);
    if (body === null) {
      sendJson(res, 400, { ok: false, error: "body must be a JSON object under 16 KiB" });
      return true;
    }
    const format = body.format ?? "zip";
    if (format !== "zip" && format !== "dir") {
      sendJson(res, 400, { ok: false, error: 'format must be "zip" or "dir"' });
      return true;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const out = path.join(
      resolveEvidenceExportsDir(env),
      format === "zip" ? `${loaded.id}-${stamp}.zip` : `${loaded.id}-${stamp}`,
    );
    try {
      fs.mkdirSync(resolveEvidenceExportsDir(env), { recursive: true, mode: 0o700 });
      const result = await exportEvidenceBundle({
        jobId: loaded.id,
        out,
        env,
        gatewayVersion: deps.gatewayVersion,
      });
      void auditSafe(
        {
          identity:
            getHttpPerson(req)?.principal ??
            (getHttpPrincipal(req)?.kind === "pair" ? "pair-credential" : "owner"),
          scope: loaded.manifest?.sessionKey ?? null,
          action: "evidence.export",
          outcome: "ok",
          source: "gateway.http",
          detail: {
            jobId: loaded.id,
            format: result.format,
            path: result.path,
            bytes: result.bytes,
          },
        },
        { dir: resolveAuditDir(env) },
      );
      sendJson(res, 200, {
        ok: true,
        job: loaded.id,
        path: result.path,
        format: result.format,
        bytes: result.bytes,
        files: result.files,
        manifest: result.manifest,
      });
    } catch (err) {
      if (err instanceof EvidenceUnfinishedError) {
        sendJson(res, 409, { ok: false, error: err.message });
      } else if (err instanceof EvidenceNotFoundError) {
        sendJson(res, 404, { ok: false, error: err.message });
      } else {
        sendJson(res, 500, { ok: false, error: `export failed: ${String(err)}` });
      }
    }
    return true;
  };

  const getEvidenceView: RouteHandler = (req, res, ctx) => {
    const loaded = load(req, res, ctx);
    if (!loaded) {
      return true;
    }
    const html = renderEvidenceHtml({
      jobId: loaded.id,
      events: loaded.events,
      manifest: loaded.manifest,
      summary: summarizeEvents(loaded.events, { signed: Boolean(loaded.manifest) }),
    });
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Content-Security-Policy", EVIDENCE_VIEW_CSP);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.end(html);
    return true;
  };

  return { getJobEvidence, listJobEvidenceEvents, exportJobEvidence, getEvidenceView };
}
