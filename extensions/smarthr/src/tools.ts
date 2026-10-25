// SmartHR tools (read-only): employees (crews) list / get and departments list. Every crew request
// sends `fields=` with the configured allow-list, and every response is projected onto it again,
// so a sensitive field is neither requested nor returned even if the API sent it.
import { Type } from "@sinclair/typebox";
import { stringEnum } from "../../../src/agents/schema/typebox.js";
import {
  asAgentTool,
  ConnectorError,
  type ConnectorRuntime,
  intParam,
  runConnectorTool,
  strParam,
  textResult,
  type ToolContext,
  wrapUntrusted,
} from "../../../src/connectors/business/index.js";
import {
  apiBase,
  type CrewField,
  isAllowedCrewField,
  SCOPES,
  type SmartHRSettings,
} from "./config.js";

const ID = /^[A-Za-z0-9-]{1,64}$/;
const EMP_STATUS = ["employed", "absent", "retired"] as const;
export const MAX_PER_PAGE = 100;
/** Pages a single call may reach: 50 x 100 = 5,000 employees. */
export const MAX_PAGE = 50;

type Obj = Record<string, unknown>;

function idParam(v: unknown, label: string): string {
  if (typeof v !== "string" || !ID.test(v)) {
    throw new ConnectorError("bad_request", `invalid ${label}`);
  }
  return v;
}

/** Nested organisation objects reduced to ids and names. */
function org(v: unknown): unknown {
  const pick = (o: unknown) => {
    if (!o || typeof o !== "object") {
      return undefined;
    }
    const x = o as Obj;
    return {
      id: typeof x.id === "string" ? x.id : undefined,
      name: typeof x.name === "string" ? x.name : undefined,
      ...(typeof x.full_name === "string" ? { full_name: x.full_name } : {}),
      ...(typeof x.code === "string" ? { code: x.code } : {}),
    };
  };
  return Array.isArray(v) ? v.slice(0, 20).map(pick).filter(Boolean) : pick(v);
}

/** Only allow-listed fields, with nested objects reduced; anything else is dropped. */
export function projectCrew(fields: readonly CrewField[], crew: Obj): Obj {
  const out: Obj = {};
  for (const f of fields) {
    if (!isAllowedCrewField(f) || !(f in crew)) {
      continue;
    }
    const v = crew[f];
    out[f] =
      f === "employment_type" || f === "departments" || f === "positions"
        ? org(v)
        : typeof v === "string" || typeof v === "number" || v === null
          ? v
          : undefined;
  }
  return out;
}

function display(v: unknown): string {
  if (v === null || v === undefined) {
    return "";
  }
  if (Array.isArray(v)) {
    return v.map(display).filter(Boolean).join(", ");
  }
  if (typeof v === "object") {
    const o = v as Obj;
    return display(o.full_name ?? o.name ?? o.id);
  }
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean"
    ? String(v).replace(/[\r\n]+/g, " ")
    : "";
}

function formatCrew(c: Obj): string {
  return Object.entries(c)
    .map(([k, v], i) => `${i === 0 ? "- " : "  "}${k}: ${display(v)}`)
    .join("\n");
}

export type SmartHRToolDeps = {
  runtime: ConnectorRuntime;
  ctx: ToolContext;
  settings: SmartHRSettings;
};

export function createSmartHRTools(deps: SmartHRToolDeps) {
  const { runtime, ctx, settings } = deps;
  const base = apiBase(settings);
  const fields = settings.crewFields.filter(isAllowedCrewField);
  const url = (path: string, query: Array<[string, string]>) => {
    const u = new URL(`${base}${path}`);
    for (const [k, v] of query) {
      u.searchParams.set(k, v);
    }
    return u.toString();
  };
  const read = [SCOPES.read];

  const list = asAgentTool({
    name: "smarthr_crews_list",
    label: "SmartHR: list employees",
    description: `List employees (crews) with work-related fields only (${fields.join(", ")}). Optional filters: employment status, department id, employee code, or a name/department/position search. Personal data (My Number, bank, insurance, pay, address, birth date, ...) is never read. Read-only.`,
    parameters: Type.Object({
      status: Type.Optional(stringEnum(EMP_STATUS)),
      departmentId: Type.Optional(Type.String()),
      empCode: Type.Optional(Type.String()),
      search: Type.Optional(
        Type.String({ description: "Name, business name, department or position" }),
      ),
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE })),
      perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PER_PAGE })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "crews.list",
        async () => {
          const perPage = intParam(params.perPage, 25, 1, MAX_PER_PAGE);
          const page = intParam(params.page, 1, 1, MAX_PAGE);
          const query: Array<[string, string]> = [
            ["fields", fields.join(",")],
            ["page", String(page)],
            ["per_page", String(perPage)],
          ];
          if (params.status !== undefined) {
            if (!EMP_STATUS.includes(params.status as (typeof EMP_STATUS)[number])) {
              throw new ConnectorError("bad_request", "invalid status");
            }
            query.push(["emp_status", params.status as string]);
          }
          if (params.departmentId !== undefined) {
            query.push(["department_id", idParam(params.departmentId, "department id")]);
          }
          const empCode = strParam(params.empCode, "empCode", { max: 64 });
          if (empCode) {
            query.push(["emp_code", empCode]);
          }
          // SmartHR's `q` matches names, business names, departments and positions only.
          const q = strParam(params.search, "search", { max: 100 });
          if (q) {
            query.push(["q", q]);
          }
          const crews = await runtime.json<Obj[]>({ url: url("/crews", query), scopes: read });
          const value = (Array.isArray(crews) ? crews : [])
            .slice(0, perPage)
            .map((c) => projectCrew(fields, c));
          const text = value.length
            ? wrapUntrusted(value.map(formatCrew).join("\n"), { source: "api" })
            : "No employees.";
          const more = value.length === perPage ? `\n(more may exist: page ${page + 1})` : "";
          return { value, result: textResult(`${text}${more}`, { count: value.length }) };
        },
        (v) => ({ ids: v.map((c) => display(c.id)), count: v.length }),
      ),
  });

  const get = asAgentTool({
    name: "smarthr_crew_get",
    label: "SmartHR: get employee",
    description:
      "Get one employee (crew) by id with the work-related allow-listed fields only. Read-only.",
    parameters: Type.Object({ id: Type.String() }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "crews.get",
        async () => {
          const id = idParam(params.id, "crew id");
          const crew = await runtime.json<Obj>({
            url: url(`/crews/${encodeURIComponent(id)}`, [["fields", fields.join(",")]]),
            scopes: read,
          });
          const value = projectCrew(fields, crew ?? {});
          return {
            value: id,
            result: textResult(wrapUntrusted(formatCrew(value), { source: "api" })),
          };
        },
        (id) => ({ ids: [id], count: 1 }),
      ),
  });

  const departments = asAgentTool({
    name: "smarthr_departments_list",
    label: "SmartHR: list departments",
    description: "List departments (id, name, full name, code, parent id). Read-only.",
    parameters: Type.Object({
      page: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE })),
      perPage: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PER_PAGE })),
    }),
    execute: (_id, params) =>
      runConnectorTool(
        runtime,
        ctx,
        "departments.list",
        async () => {
          const perPage = intParam(params.perPage, 50, 1, MAX_PER_PAGE);
          const page = intParam(params.page, 1, 1, MAX_PAGE);
          const rows = await runtime.json<Obj[]>({
            url: url("/departments", [
              ["page", String(page)],
              ["per_page", String(perPage)],
            ]),
            scopes: read,
          });
          const value = (Array.isArray(rows) ? rows : []).slice(0, perPage).map((d) => ({
            id: typeof d.id === "string" ? d.id : "",
            name: display(d.name),
            full_name: display(d.full_name),
            code: display(d.code),
            parent: d.parent && typeof d.parent === "object" ? display((d.parent as Obj).id) : "",
          }));
          const text = value.length
            ? wrapUntrusted(
                value
                  .map(
                    (d) =>
                      `- id: ${d.id}\n  name: ${d.full_name || d.name}\n  code: ${d.code}\n  parent: ${d.parent}`,
                  )
                  .join("\n"),
                { source: "api" },
              )
            : "No departments.";
          const more = value.length === perPage ? `\n(more may exist: page ${page + 1})` : "";
          return { value, result: textResult(`${text}${more}`, { count: value.length }) };
        },
        (v) => ({ ids: v.map((d) => d.id), count: v.length }),
      ),
  });

  return [list, get, departments];
}
