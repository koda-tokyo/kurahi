// Microsoft 365 mail attachments (Mail.Read, the mail read scope; Graph
// `GET /me/messages/{id}/attachments/{id}` needs nothing more). `m365_mail_read` lists a
// message's attachments as id, name, size and content type only. `m365_mail_attachment_fetch`
// downloads ONE file attachment (at most 20 MB; item and reference attachments are refused) and
// hands the bytes to the core attachment intake (src/security/attachment-intake.ts): quarantine
// in the Project data area, static policy, malware scan, and only on a clean verdict a copy in
// the Project's `inbox-attachments/` folder. The model gets the project-relative path and the
// extracted text inside the untrusted-content boundary, never the bytes. A refusal is a normal
// result (details.attachment.status = "refused" with a code) so an autopilot run can flag the
// item `malicious_attachment` instead of failing.
import { Type } from "@sinclair/typebox";
import type { Project } from "../../../src/projects/types.js";
import { currentEngineInvocation } from "../../../src/autopilot/engine-origin.js";
import {
  asAgentTool,
  ConnectorError,
  type ConnectorRuntime,
  graphId,
  graphUrl,
  runConnectorTool,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import { parseProjectSessionKey } from "../../../src/projects/scope.js";
import { getProject } from "../../../src/projects/store.js";
import {
  type AttachmentIntakeInput,
  type AttachmentIntakeResult,
  intakeAttachment,
  recordAttachmentRefusal,
} from "../../../src/security/attachment-intake.js";
import { ATTACHMENT_MAX_BYTES } from "../../../src/security/attachment-policy.js";
import { SCOPES } from "./config.js";

export const ATTACHMENT_FETCH_TOOL = "m365_mail_attachment_fetch";

export type GraphAttachment = {
  "@odata.type"?: string;
  id: string;
  name?: string;
  size?: number;
  contentType?: string;
  isInline?: boolean;
};

const FILE_TYPE = "#microsoft.graph.fileAttachment";
const META_SELECT = "id,name,size,contentType,isInline";

// oxlint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]+/g;

/** A sender-chosen value for a header line: no control characters, bounded. */
function line(v: unknown, max = 120): string {
  const text = typeof v === "string" ? v : typeof v === "number" ? String(v) : "";
  return text.replace(CONTROL_RE, " ").trim().slice(0, max);
}

/** `<messageId>|<attachmentId>`: one token a routine can fan out over. */
export function attachmentRef(messageId: string, attachmentId: string): string {
  return `${messageId}|${attachmentId}`;
}

/** The lines m365_mail_read adds for a message's attachments (metadata only, never content). */
export function formatAttachmentList(messageId: string, list: GraphAttachment[]): string[] {
  return list.map(
    (a) =>
      `attachment: ${attachmentRef(messageId, a.id)} | name: ${line(a.name)} | size: ${Number(a.size) || 0} | contentType: ${line(a.contentType, 100)}`,
  );
}

/** Attachment metadata of a message (no contentBytes). */
export async function listAttachments(
  runtime: ConnectorRuntime,
  messagePath: string,
): Promise<GraphAttachment[]> {
  const page = await runtime.json<{ value?: GraphAttachment[] }>(
    {
      url: graphUrl(`/me/messages/${messagePath}/attachments`, { $select: META_SELECT, $top: 50 }),
      scopes: [SCOPES.mail],
    },
    256 * 1024,
  );
  return (page.value ?? []).filter((a) => typeof a?.id === "string").slice(0, 50);
}

export type AttachmentToolDeps = {
  runtime: ConnectorRuntime;
  ctx: ToolContext;
  /** Tests replace the intake (scanner fakes); the default is the core pipeline. */
  intake?: (input: AttachmentIntakeInput) => Promise<AttachmentIntakeResult>;
};

function projectOfSession(ctx: ToolContext): Project {
  const ref = parseProjectSessionKey(ctx.sessionKey);
  const project = ref ? getProject(ref.projectId) : null;
  if (!project || project.archived) {
    throw new ConnectorError(
      "unsupported",
      "not in a project session",
      undefined,
      "attachments can be fetched only from a Project chat (they are stored in the Project)",
    );
  }
  return project;
}

function parseIds(params: Record<string, unknown>): { messageId: string; attachmentId: string } {
  let messageId = typeof params.messageId === "string" ? params.messageId.trim() : "";
  let attachmentId = typeof params.attachmentId === "string" ? params.attachmentId.trim() : "";
  if (typeof params.ref === "string" && params.ref.includes("|")) {
    const [m, a] = params.ref.trim().split("|", 2);
    messageId ||= m ?? "";
    attachmentId ||= a ?? "";
  }
  if (!messageId || !attachmentId) {
    throw new ConnectorError(
      "bad_request",
      "messageId and attachmentId are required (or ref as messageId|attachmentId)",
    );
  }
  return { messageId, attachmentId };
}

export function createAttachmentFetchTool(deps: AttachmentToolDeps) {
  const { runtime, ctx } = deps;
  const intake = deps.intake ?? ((input) => intakeAttachment(input));
  return asAgentTool({
    name: ATTACHMENT_FETCH_TOOL,
    label: "Microsoft 365: fetch attachment",
    description:
      "Fetch one file attachment of a message (ids from m365_mail_read) into the Project: it is quarantined, checked and scanned for malware, and only a clean file is stored in inbox-attachments/. Returns the stored path and the file's text (untrusted content). Refused: executables, scripts, macros, encrypted files, archives in archives, unknown types, over 20 MB. Read-only on the mailbox.",
    parameters: Type.Object({
      messageId: Type.Optional(Type.String()),
      attachmentId: Type.Optional(Type.String()),
      ref: Type.Optional(
        Type.String({ description: "messageId|attachmentId, as listed by m365_mail_read" }),
      ),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "mail.attachment_fetch",
        async () => {
          const project = projectOfSession(ctx);
          const { messageId, attachmentId } = parseIds(params);
          const mPath = graphId(messageId, "message id");
          const aPath = graphId(attachmentId, "attachment id");
          const inv = currentEngineInvocation();
          const run =
            inv && inv.tool === ATTACHMENT_FETCH_TOOL && inv.sessionKey === ctx.sessionKey
              ? { routineId: inv.routineId, runId: inv.runId }
              : null;
          const base = {
            project,
            connector: runtime.id,
            messageId,
            attachmentId,
            actor: run ? `autopilot:${run.routineId}` : (ctx.agentId ?? "main"),
            sessionKey: ctx.sessionKey,
            run,
          };
          const meta = await runtime.json<GraphAttachment>(
            {
              url: graphUrl(`/me/messages/${mPath}/attachments/${aPath}`, { $select: META_SELECT }),
              scopes: [SCOPES.mail],
            },
            64 * 1024,
          );
          let result: AttachmentIntakeResult;
          const kind = meta["@odata.type"] ?? "";
          if (kind !== FILE_TYPE) {
            const code = /itemAttachment/i.test(kind)
              ? "item_attachment"
              : /referenceAttachment/i.test(kind)
                ? "reference_attachment"
                : "unsupported_attachment";
            result = recordAttachmentRefusal(base, {
              stage: "policy",
              code,
              reason:
                code === "item_attachment"
                  ? "the attachment is an attached Outlook item (message, event or contact), not a file"
                  : code === "reference_attachment"
                    ? "the attachment is a link to a cloud file, not a file"
                    : "the attachment is not a file attachment",
              size: Number(meta.size) || 0,
            });
          } else if ((Number(meta.size) || 0) > ATTACHMENT_MAX_BYTES) {
            result = recordAttachmentRefusal(base, {
              stage: "policy",
              code: "too_large",
              reason: "the attachment is larger than 20 MB",
              size: Number(meta.size) || 0,
            });
          } else {
            const bytes = await runtime.bytes(
              {
                url: graphUrl(`/me/messages/${mPath}/attachments/${aPath}/$value`),
                headers: { accept: "*/*" },
                scopes: [SCOPES.mail],
              },
              ATTACHMENT_MAX_BYTES,
            );
            result = await intake({ ...base, name: line(meta.name, 200) || "attachment", bytes });
          }
          const ref = attachmentRef(messageId, attachmentId);
          if (result.status === "refused") {
            return {
              value: { ids: [messageId, attachmentId], bytes: result.size, kind: "refused" },
              result: textResult(
                `Attachment ${ref} refused (${result.code}): ${result.reason}. Nothing was stored; a person can review it in Outlook.`,
                {
                  attachment: {
                    status: "refused",
                    stage: result.stage,
                    code: result.code,
                    messageId,
                    attachmentId,
                    sha256: result.sha256,
                    scanner: result.scanner,
                    verdict: result.verdict,
                  },
                },
              ),
            };
          }
          const header = [
            `attachment: ${ref}`,
            `stored: ${result.path}`,
            `kind: ${result.kind}`,
            `size: ${result.size}`,
            `sha256: ${result.sha256}`,
            `scan: ${result.verdict} (${result.scanner})`,
          ].join("\n");
          const body =
            result.text === null
              ? `[text not available: ${result.textError ?? "extraction failed"}]`
              : result.text;
          return {
            value: { ids: [messageId, attachmentId], bytes: result.size, kind: result.kind },
            result: textResult(wrapUntrusted(`${header}\n\n${body}`, { source: "email" }), {
              attachment: {
                status: "accepted",
                messageId,
                attachmentId,
                path: result.path,
                kind: result.kind,
                sha256: result.sha256,
                scanner: result.scanner,
                verdict: result.verdict,
              },
            }),
          };
        },
        (v) => ({ ids: v.ids, count: 1, bytes: v.bytes, kind: v.kind }),
      ),
  });
}
