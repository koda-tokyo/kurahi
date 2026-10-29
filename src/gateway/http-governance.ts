// HTTP handler for eDiscovery export downloads (declared in http-routes.ts as
// downloadGovernanceExport). The router authenticates (attach); this handler binds the download
// to the export's creator: the SSO person, the pairing credential or the device that started it.
// The owner credential (gateway token / password) may download any export. Everyone else gets
// 404, as for an unknown id. Each download is audited.
import type { IncomingMessage } from "node:http";
import fs from "node:fs";
import type { RouteHandler } from "./http-registry.js";
import { auditSafe } from "../audit/audit-log.js";
import { resolveKoloHome } from "../config/kolo-home.js";
import { exportArchivePath, readExport } from "../governance/export.js";
import { auditDirOf } from "../governance/store.js";
import { getHttpPerson } from "../identity/http.js";
import { sendJson } from "./http-common.js";
import { getHttpPrincipal } from "./pair-auth.js";

/** The caller as the WS `actorOf` names it, or "owner" for owner secrets. */
function callerOf(req: IncomingMessage): { id: string; owner: boolean } {
  const person = getHttpPerson(req);
  if (person) {
    return { id: person.principal, owner: false };
  }
  const principal = getHttpPrincipal(req);
  if (!principal || principal.kind === "owner") {
    return { id: "owner", owner: true };
  }
  return { id: `pair:${principal.fingerprint.slice(0, 12)}`, owner: false };
}

export function createGovernanceHttpHandlers(deps: { home?: () => string } = {}) {
  const homeOf = deps.home ?? (() => resolveKoloHome());

  const downloadGovernanceExport: RouteHandler = (req, res, ctx) => {
    res.setHeader("Cache-Control", "no-store");
    const home = homeOf();
    const id = ctx.params.id ?? "";
    const status = readExport(home, id);
    const caller = callerOf(req);
    const allowed =
      status !== null &&
      status.status === "done" &&
      (caller.owner || caller.id === status.createdBy);
    let file: string | null = null;
    if (allowed) {
      try {
        file = exportArchivePath(home, id);
        fs.statSync(file);
      } catch {
        file = null;
      }
    }
    if (!file || !status) {
      void auditSafe(
        {
          identity: caller.id,
          action: "governance.export.download",
          outcome: "denied",
          source: "gateway.http",
          detail: { exportId: /^exp-[a-z0-9]{8,32}$/.test(id) ? id : null },
        },
        { dir: auditDirOf(home) },
      );
      sendJson(res, 404, { ok: false, error: "export not found" });
      return true;
    }
    void auditSafe(
      {
        identity: caller.id,
        action: "governance.export.download",
        outcome: "ok",
        source: "gateway.http",
        detail: { exportId: status.id, bytes: status.bytes, sha256: status.sha256 },
      },
      { dir: auditDirOf(home) },
    );
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${status.id}.zip"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (status.sha256) {
      res.setHeader("X-Kurahi-Export-Sha256", status.sha256);
    }
    fs.createReadStream(file).pipe(res);
    return true;
  };

  return { downloadGovernanceExport };
}
