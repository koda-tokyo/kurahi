// Microsoft 365 calendar tools: list a time window and read one event (Calendars.Read);
// creating events is a separate opt-in (Calendars.ReadWrite) that always asks a person first.
import { Type } from "@sinclair/typebox";
import {
  type ApprovalAsk,
  asAgentTool,
  clip,
  ConnectorError,
  type ConnectorRuntime,
  emailListParam,
  type GraphPage,
  graphId,
  graphUrl,
  intParam,
  isoParam,
  requireWriteApproval,
  runConnectorTool,
  strParam,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import { SCOPES } from "./config.js";

type When = { dateTime?: string; timeZone?: string };
type Person = { emailAddress?: { name?: string; address?: string } };
type CalEvent = {
  id: string;
  subject?: string;
  start?: When;
  end?: When;
  isAllDay?: boolean;
  isCancelled?: boolean;
  location?: { displayName?: string };
  organizer?: Person;
  attendees?: Array<Person & { status?: { response?: string } }>;
  body?: { content?: string };
};

const MAX_WINDOW_DAYS = 62;
const DAY = 86_400_000;

function who(p?: Person): string {
  return p?.emailAddress?.address ?? p?.emailAddress?.name ?? "";
}

export function formatEvents(events: CalEvent[]): string {
  if (events.length === 0) {
    return "No events in this window.";
  }
  const lines = events.map((e, i) =>
    [
      `${i + 1}. id: ${e.id}`,
      `   when: ${e.start?.dateTime ?? ""} - ${e.end?.dateTime ?? ""} UTC${e.isAllDay ? " (all day)" : ""}${e.isCancelled ? " (cancelled)" : ""}`,
      `   subject: ${e.subject ?? ""}`,
      `   location: ${e.location?.displayName ?? ""}`,
      `   organizer: ${who(e.organizer)}`,
    ].join("\n"),
  );
  return wrapUntrusted(lines.join("\n"), { source: "api" });
}

export type CalendarToolDeps = {
  runtime: ConnectorRuntime;
  ctx: ToolContext;
  ask: ApprovalAsk;
  allowWrite: boolean;
  approvalTimeoutMs: number;
  now?: () => number;
};

export function createCalendarTools(deps: CalendarToolDeps) {
  const { runtime, ctx } = deps;
  const now = deps.now ?? Date.now;
  // With the write opt-in the grant is Calendars.ReadWrite, which covers reads.
  const readScope = SCOPES.calendar;

  const list = asAgentTool({
    name: "m365_calendar_list",
    label: "Microsoft 365: list events",
    description:
      "List calendar events between start and end (ISO 8601; default: now to 7 days ahead; at most 62 days). Times in UTC. Read-only.",
    parameters: Type.Object({
      start: Type.Optional(Type.String()),
      end: Type.Optional(Type.String()),
      top: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "calendar.list",
        async () => {
          const start = isoParam(params.start, "start") ?? new Date(now());
          const end = isoParam(params.end, "end") ?? new Date(start.getTime() + 7 * DAY);
          if (end <= start || end.getTime() - start.getTime() > MAX_WINDOW_DAYS * DAY) {
            throw new ConnectorError("bad_request", "end must be after start, within 62 days");
          }
          const page = await runtime.json<GraphPage<CalEvent>>({
            url: graphUrl("/me/calendarView", {
              startDateTime: start.toISOString(),
              endDateTime: end.toISOString(),
              $top: intParam(params.top, 50, 1, 100),
              $select: "id,subject,start,end,isAllDay,isCancelled,location,organizer",
              $orderby: "start/dateTime",
            }),
            headers: { prefer: 'outlook.timezone="UTC"' },
            scopes: [readScope],
          });
          const value = page.value ?? [];
          return { value, result: textResult(formatEvents(value), { count: value.length }) };
        },
        (v) => ({ ids: v.map((e) => e.id), count: v.length }),
      ),
  });

  const read = asAgentTool({
    name: "m365_calendar_read",
    label: "Microsoft 365: read event",
    description:
      "Read one calendar event by id: time, location, organizer, attendees and description (untrusted content). Read-only.",
    parameters: Type.Object({ id: Type.String() }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "calendar.read",
        async () => {
          const e = await runtime.json<CalEvent>({
            url: graphUrl(`/me/events/${graphId(params.id, "event id")}`, {
              $select:
                "id,subject,start,end,isAllDay,isCancelled,location,organizer,attendees,body",
            }),
            headers: { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' },
            scopes: [readScope],
          });
          const attendees = (e.attendees ?? [])
            .map((a) => `${who(a)}${a.status?.response ? ` (${a.status.response})` : ""}`)
            .join(", ");
          const text = wrapUntrusted(
            [
              formatEventsPlain(e),
              `attendees: ${attendees}`,
              "",
              clip(e.body?.content ?? "", 20000),
            ].join("\n"),
            { source: "api", subject: e.subject ?? "" },
          );
          return { value: e, result: textResult(text, { id: e.id }) };
        },
        (e) => ({ ids: [e.id], count: 1 }),
      ),
  });

  if (!deps.allowWrite) {
    return [list, read];
  }

  const create = asAgentTool({
    name: "m365_calendar_create_event",
    label: "Microsoft 365: create event",
    description:
      "Create a calendar event (and send invitations to attendees). A person must approve every event before it is created.",
    parameters: Type.Object({
      subject: Type.String({ maxLength: 255 }),
      start: Type.String({ description: "ISO 8601 date-time" }),
      end: Type.String({ description: "ISO 8601 date-time" }),
      attendees: Type.Optional(Type.Array(Type.String(), { maxItems: 50 })),
      location: Type.Optional(Type.String({ maxLength: 255 })),
      body: Type.Optional(Type.String({ maxLength: 20000 })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "calendar.create",
        async () => {
          const subject = strParam(params.subject, "subject", { required: true, max: 255 })!;
          const start = isoParam(params.start, "start");
          const end = isoParam(params.end, "end");
          if (!start || !end || end <= start) {
            throw new ConnectorError("bad_request", "start and end are required; end after start");
          }
          const attendees = emailListParam(params.attendees, "attendees", 50);
          const location = strParam(params.location, "location", { max: 255 });
          const body = typeof params.body === "string" ? params.body.slice(0, 20000) : "";
          await requireWriteApproval(
            {
              connectorId: runtime.id,
              tool: "m365_calendar_create_event",
              agentId: ctx.agentId ?? "main",
              sessionKey: ctx.sessionKey,
              preview: {
                subject,
                start: start.toISOString(),
                end: end.toISOString(),
                attendees,
                location,
              },
              timeoutMs: deps.approvalTimeoutMs,
            },
            deps.ask,
          );
          const created = await runtime.json<{ id: string }>({
            url: graphUrl("/me/events"),
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              subject,
              start: { dateTime: start.toISOString().slice(0, 19), timeZone: "UTC" },
              end: { dateTime: end.toISOString().slice(0, 19), timeZone: "UTC" },
              ...(location ? { location: { displayName: location } } : {}),
              body: { contentType: "Text", content: body },
              attendees: attendees.map((a) => ({ emailAddress: { address: a }, type: "required" })),
            }),
            scopes: [SCOPES.calendarWrite],
          });
          return { value: created, result: textResult(`Created event ${created.id}.`) };
        },
        (c) => ({ ids: [c.id], count: 1 }),
      ),
  });
  return [list, read, create];
}

function formatEventsPlain(e: CalEvent): string {
  return [
    `id: ${e.id}`,
    `when: ${e.start?.dateTime ?? ""} - ${e.end?.dateTime ?? ""} UTC${e.isAllDay ? " (all day)" : ""}${e.isCancelled ? " (cancelled)" : ""}`,
    `location: ${e.location?.displayName ?? ""}`,
    `organizer: ${who(e.organizer)}`,
  ].join("\n");
}
