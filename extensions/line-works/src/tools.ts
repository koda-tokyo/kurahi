// LINE WORKS tools. Read (bot.read): channel information and members of the configured channels.
// LINE WORKS has no API to read message history, so there is no message read tool. Write
// (bot.message, opt-in): send one text message to a configured channel or user; a person approves
// every send. Standing (autopilot) approvals are not supported for this connector.
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../../src/agents/schema/typebox.js";
import {
  type ApprovalAsk,
  asAgentTool,
  assertScopes,
  ConnectorError,
  type ConnectorRuntime,
  intParam,
  requireWriteApproval,
  runConnectorTool,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import { API_BASE, isTargetId, type LineWorksSettings, MAX_TEXT, SCOPES } from "./config.js";

type Obj = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" || typeof v === "number" ? String(v).replace(/[\r\n]+/g, " ") : "";
}

export type LineWorksToolDeps = {
  runtime: ConnectorRuntime;
  ctx: ToolContext;
  ask: ApprovalAsk;
  settings: LineWorksSettings;
};

export function createLineWorksTools(deps: LineWorksToolDeps) {
  const { runtime, ctx, settings } = deps;
  const bot = `${API_BASE}/bots/${encodeURIComponent(settings.botId ?? "")}`;
  const channelParam = (v: unknown): string => {
    if (!isTargetId(v) || !settings.channels.includes(v)) {
      throw new ConnectorError(
        "forbidden",
        "channel not configured",
        undefined,
        "this channel is not in the connector's configured channel list",
      );
    }
    return v;
  };

  const channelGet = asAgentTool({
    name: "lineworks_channel_get",
    label: "LINE WORKS: channel info",
    description:
      "Information about one configured LINE WORKS channel the bot is in (title, type). LINE WORKS offers no API to read messages. Read-only.",
    parameters: Type.Object({ channelId: Type.String() }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "channels.get",
        async () => {
          const channelId = channelParam(params.channelId);
          const ch = await runtime.json<Obj>(
            { url: `${bot}/channels/${encodeURIComponent(channelId)}`, scopes: [SCOPES.read] },
            64 * 1024,
          );
          const type =
            ch.channelType && typeof ch.channelType === "object"
              ? (ch.channelType as Obj).type
              : "";
          return {
            value: channelId,
            result: textResult(
              wrapUntrusted(`channel ${channelId}: ${str(ch.title)} (type ${str(type)})`, {
                source: "api",
              }),
            ),
          };
        },
        (id) => ({ ids: [id], count: 1 }),
      ),
  });

  const members = asAgentTool({
    name: "lineworks_channel_members",
    label: "LINE WORKS: channel members",
    description:
      "List member user ids of one configured channel (at most 100 per call; pass the returned cursor for more). Read-only.",
    parameters: Type.Object({
      channelId: Type.String(),
      count: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      cursor: Type.Optional(Type.String()),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "channels.members",
        async () => {
          const channelId = channelParam(params.channelId);
          const u = new URL(`${bot}/channels/${encodeURIComponent(channelId)}/members`);
          u.searchParams.set("count", String(intParam(params.count, 50, 1, 100)));
          if (params.cursor !== undefined) {
            if (
              typeof params.cursor !== "string" ||
              !/^[A-Za-z0-9+/=_-]{1,512}$/.test(params.cursor)
            ) {
              throw new ConnectorError("bad_request", "invalid cursor");
            }
            u.searchParams.set("cursor", params.cursor);
          }
          const res = await runtime.json<{
            members?: unknown[];
            responseMetaData?: { nextCursor?: string };
          }>({ url: u.toString(), scopes: [SCOPES.read] }, 256 * 1024);
          const list = (res.members ?? []).map(str).filter(Boolean).slice(0, 100);
          const next = res.responseMetaData?.nextCursor;
          const text = list.length
            ? wrapUntrusted(list.map((m) => `- ${m}`).join("\n"), { source: "api" })
            : "No members.";
          return {
            value: { channelId, count: list.length },
            result: textResult(`${text}${next ? `\n(more: cursor ${str(next)})` : ""}`, {
              count: list.length,
            }),
          };
        },
        (v) => ({ ids: [v.channelId], count: v.count }),
      ),
  });

  const tools = [channelGet, members];
  if (!settings.send) {
    return tools;
  }

  tools.push(
    asAgentTool({
      name: "lineworks_message_send",
      label: "LINE WORKS: send message",
      description: `Send one plain-text message (at most ${MAX_TEXT} characters) from the bot to a configured channel or user. A person must approve every message before it is sent.`,
      parameters: Type.Object({
        to: stringEnum(["channel", "user"] as const),
        id: Type.String({ description: "Channel id or user id from the connector configuration" }),
        text: Type.String({ maxLength: MAX_TEXT }),
      }),
      execute: (_id, params) =>
        runConnectorTool(
          runtime,
          ctx,
          "messages.send",
          async () => {
            const kind = params.to === "channel" ? "channel" : params.to === "user" ? "user" : null;
            if (!kind) {
              throw new ConnectorError("bad_request", "to must be channel or user");
            }
            const allowed = kind === "channel" ? settings.channels : settings.users;
            if (!isTargetId(params.id) || !allowed.includes(params.id)) {
              throw new ConnectorError(
                "forbidden",
                "target not configured",
                undefined,
                `this ${kind} is not in the connector's configured list`,
              );
            }
            const text = typeof params.text === "string" ? params.text.trim() : "";
            if (!text || text.length > MAX_TEXT) {
              throw new ConnectorError("bad_request", `text must be 1 to ${MAX_TEXT} characters`);
            }
            // Refused before asking anyone when the grant cannot send anyway.
            assertScopes(runtime.grantedScopes() ?? [], [SCOPES.send]);
            await requireWriteApproval(
              {
                connectorId: runtime.id,
                tool: "lineworks_message_send",
                agentId: ctx.agentId ?? "main",
                sessionKey: ctx.sessionKey,
                preview: { to: kind, id: params.id, chars: text.length, text: text.slice(0, 500) },
                timeoutMs: settings.approvalTimeoutMs,
              },
              deps.ask,
            );
            const res = await runtime.request({
              url: `${bot}/${kind === "channel" ? "channels" : "users"}/${encodeURIComponent(params.id)}/messages`,
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ content: { type: "text", text } }),
              scopes: [SCOPES.send],
            });
            await res.body?.cancel().catch(() => {});
            return {
              value: params.id,
              result: textResult(`Message sent to the ${kind}.`),
            };
          },
          (id) => ({ ids: [id], count: 1 }),
        ),
    }),
  );
  return tools;
}
