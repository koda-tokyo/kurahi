// scholar_fetch_pdf: an OPEN-ACCESS PDF into the Project's corpus-inbox/, through the core
// attachment intake (quarantine, static policy, malware scan; only a clean file is stored). The
// model gets the stored path, never the bytes.
//
// Open access means one of:
//   - an arXiv e-print (arXiv's terms allow retrieval for personal or research use, and ask that
//     e-prints are not re-served: the copy stays in the researcher's own Project;
//     https://info.arxiv.org/help/api/tou.html);
//   - a work whose best open-access location (OpenAlex) or Crossref licence is an open licence
//     (Creative Commons or public domain) AND names a direct PDF.
// Anything else is refused (`not_open_access`) before a byte is downloaded: no paywalled copy,
// no "bronze" free-to-read copy without a licence, no guessing from the landing page.
import type { LookupFn } from "../../../src/infra/net/ssrf.js";
import type { Project } from "../../../src/projects/types.js";
import { currentEngineInvocation } from "../../../src/autopilot/engine-origin.js";
import { ConnectorError, readCapped } from "../../../src/connectors/business/index.js";
import { fetchWithSsrFGuard } from "../../../src/infra/net/fetch-guard.js";
import {
  type AttachmentIntakeInput,
  type AttachmentIntakeResult,
  intakeAttachment,
  recordAttachmentRefusal,
} from "../../../src/security/attachment-intake.js";
import { ATTACHMENT_MAX_BYTES } from "../../../src/security/attachment-policy.js";
import { PLUGIN_ID, userAgent } from "./config.js";
/** The SSRF guard's fetch shape (tests inject one). */
export type PdfFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
import type { Limiters, ScholarHttp } from "./http.js";
import type { ScholarRecord } from "./record.js";
import { auditId, type ScholarId } from "./ids.js";
import { crossrefGet, openalexGet } from "./sources.js";

export const FETCH_PDF_TOOL = "scholar_fetch_pdf";
export const CORPUS_INBOX = "corpus-inbox";

const OPEN_LICENSE = /^(cc-|cc0|public-domain|pd$)/i;

export type OaDecision =
  | {
      ok: true;
      url: string;
      license: string;
      basis: "arxiv" | "open-licence";
      record: ScholarRecord | null;
    }
  | { ok: false; reason: string };

export function isOpenLicense(license: string | null): boolean {
  return typeof license === "string" && OPEN_LICENSE.test(license.trim());
}

/** Is there an open-access PDF for the id, and where? No download happens here. */
export async function decideOpenAccess(http: ScholarHttp, id: ScholarId): Promise<OaDecision> {
  if (id.kind === "arxiv") {
    return {
      ok: true,
      url: `https://arxiv.org/pdf/${id.value}`,
      license: "arxiv",
      basis: "arxiv",
      record: null,
    };
  }
  let record = await openalexGet(http, id);
  if ((!record || !record.oaPdfUrl) && id.kind === "doi") {
    record = (await crossrefGet(http, id.value)) ?? record;
  }
  if (!record) {
    return { ok: false, reason: "the work was not found" };
  }
  if (!record.oaPdfUrl) {
    return { ok: false, reason: "no open-access PDF is listed for this work" };
  }
  if (!isOpenLicense(record.license)) {
    return {
      ok: false,
      reason: `the open copy has no open licence (${record.license ?? "none stated"}); fetch it yourself if your access allows`,
    };
  }
  return {
    ok: true,
    url: record.oaPdfUrl,
    license: record.license!,
    basis: "open-licence",
    record,
  };
}

export type PdfDeps = {
  http: ScholarHttp;
  limiters: Limiters;
  fetch?: PdfFetch;
  lookupFn?: LookupFn;
  pinDns?: boolean;
  intake?: (input: AttachmentIntakeInput) => Promise<AttachmentIntakeResult>;
};

export type PdfOutcome = {
  decision: OaDecision;
  result: AttachmentIntakeResult | null;
};

/** Download the decided URL (SSRF-guarded, size-capped, PDF magic) and run the intake. */
export async function fetchOpenAccessPdf(
  deps: PdfDeps,
  project: Project,
  ctx: { agentId?: string; sessionKey?: string },
  id: ScholarId,
): Promise<PdfOutcome> {
  const decision = await decideOpenAccess(deps.http, id);
  if (!decision.ok) {
    return { decision, result: null };
  }
  const inv = currentEngineInvocation();
  const run =
    inv && inv.tool === FETCH_PDF_TOOL && inv.sessionKey === ctx.sessionKey
      ? { routineId: inv.routineId, runId: inv.runId }
      : null;
  const ref = auditId(id);
  const base: Omit<AttachmentIntakeInput, "name" | "bytes"> = {
    project,
    connector: PLUGIN_ID,
    messageId: ref,
    attachmentId: "pdf",
    actor: run ? `autopilot:${run.routineId}` : (ctx.agentId ?? "main"),
    sessionKey: ctx.sessionKey,
    run,
    folder: CORPUS_INBOX,
  };
  await (decision.basis === "arxiv" ? deps.limiters.arxiv : deps.limiters.doi).acquire();
  const guarded = await fetchWithSsrFGuard({
    url: decision.url,
    fetchImpl: deps.fetch,
    lookupFn: deps.lookupFn,
    pinDns: deps.pinDns,
    maxRedirects: 5,
    timeoutMs: Math.max(deps.http.settings.timeoutMs, 60_000),
    init: { headers: { accept: "application/pdf", "user-agent": userAgent(deps.http.settings) } },
  }).catch((err: unknown) => {
    throw new ConnectorError(
      "network",
      "pdf download failed",
      undefined,
      err instanceof Error && err.name === "SsrFBlockedError"
        ? "the PDF address is not a public host; refused"
        : "the PDF could not be downloaded",
    );
  });
  let bytes: Buffer;
  try {
    if (!guarded.response.ok) {
      throw new ConnectorError(
        guarded.response.status === 404 ? "not_found" : "provider_unavailable",
        `pdf host answered ${guarded.response.status}`,
        guarded.response.status,
        "the open-access PDF is not available right now",
      );
    }
    try {
      bytes = await readCapped(guarded.response, ATTACHMENT_MAX_BYTES);
    } catch (err) {
      if (err instanceof ConnectorError && err.code === "too_large") {
        return {
          decision,
          result: recordAttachmentRefusal(base, {
            stage: "policy",
            code: "too_large",
            reason: "the file is larger than 20 MB",
            size: ATTACHMENT_MAX_BYTES + 1,
          }),
        };
      }
      throw err;
    }
  } finally {
    await guarded.release();
  }
  if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
    // A landing page or a login wall instead of the PDF: nothing is stored.
    throw new ConnectorError(
      "unsupported",
      "not a pdf",
      undefined,
      "the open-access address did not return a PDF (it may be a landing page)",
    );
  }
  const name = `${ref.replace(/\//g, "-").slice(0, 100)}.pdf`;
  const intake = deps.intake ?? ((input: AttachmentIntakeInput) => intakeAttachment(input));
  const result = await intake({ ...base, name, bytes });
  return { decision, result };
}
