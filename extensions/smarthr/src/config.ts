// SmartHR connector configuration: one tenant (https://<tenant>.smarthr.jp/api, or the sandbox
// https://<tenant>.daruma.space/api), an access token issued by a SmartHR administrator, and a
// strict field allow-list for employees (crews). Read-only: there are no write tools at all.
//
// Facts used here (SmartHR API docs, read 2026-10-25):
//   base URL, Bearer auth, page/per_page (max 100), rate limits
//     https://developer.smarthr.jp/api/about_api
//   sandbox domain daruma.space   https://developer.smarthr.jp/api/about_sandbox
//   GET /v1/crews `fields` (comma-separated item names), GET /v1/crews/{id}, GET /v1/departments,
//   and the Crew object's 144 properties: the API's Swagger document
//     https://app.smarthr.jp/api/v1/swagger_doc
import { intParam } from "../../../src/connectors/business/index.js";

export const CONNECTOR_ID = "smarthr";

/** Logical scope recorded at login and checked before every request. */
export const SCOPES = { read: "smarthr.read" } as const;

/**
 * The ONLY crew fields this connector ever requests or returns: identity at work (names, employee
 * code), employment status and organisation (department, position, employment type, entry date)
 * and, only if an administrator lists it, the e-mail address. Everything else in the Crew object
 * (My Number is not in the public API at all; bank accounts, insurance and pension numbers, pay,
 * tax, addresses, phone numbers, birth date, gender, residence card, nationality, identity and
 * handicap documents, dependants, custom fields, ...) is never requested and is dropped if a
 * response contains it.
 */
export const CREW_FIELD_CEILING = [
  "id",
  "emp_code",
  "last_name",
  "first_name",
  "last_name_yomi",
  "first_name_yomi",
  "business_last_name",
  "business_first_name",
  "business_last_name_yomi",
  "business_first_name_yomi",
  "emp_status",
  "employment_type",
  "department",
  "departments",
  "position",
  "positions",
  "entered_at",
  "email",
] as const;
export type CrewField = (typeof CREW_FIELD_CEILING)[number];

/** Default allow-list: the ceiling without e-mail addresses. */
export const DEFAULT_CREW_FIELDS: CrewField[] = CREW_FIELD_CEILING.filter((f) => f !== "email");

/**
 * A second, independent check: field names that look like sensitive personal data are refused
 * even if someone added them to the ceiling above. The test suite runs every Crew property of the
 * published schema through both lists.
 */
export const SENSITIVE_FIELD =
  /my_?number|individual_number|kojin|bank|account_number|insur|pension|premium|salary|income|wage|tax|birth|gender|tel|phone|address|emergency|resident|nationality|identity|card|handicap|widow|student|school|resume|custom_field|commutation|image|spouse|dependent|health|care_|child_care|contract|resign|biz_establishment/i;

export function isAllowedCrewField(name: string): name is CrewField {
  return (CREW_FIELD_CEILING as readonly string[]).includes(name) && !SENSITIVE_FIELD.test(name);
}

const TENANT = /^[a-z0-9][a-z0-9-]{1,62}$/;

export type SmartHRSettings = {
  tenant?: string;
  sandbox: boolean;
  crewFields: CrewField[];
  probeIntervalMinutes: number;
  ratePerSecond: number;
  fieldProblems: string[];
};

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

export function readSettings(raw: unknown): SmartHRSettings {
  const c = rec(raw);
  const problems: string[] = [];
  let crewFields: CrewField[] = DEFAULT_CREW_FIELDS;
  if (Array.isArray(c.crewFields)) {
    const listed = c.crewFields.filter((f): f is string => typeof f === "string");
    const refused = listed.filter((f) => !isAllowedCrewField(f));
    if (refused.length > 0) {
      problems.push(
        `crewFields may only name fields from the connector's allow-list (refused: ${refused.length})`,
      );
    }
    crewFields = [...new Set(["id", ...listed.filter(isAllowedCrewField)])] as CrewField[];
  }
  const tenant = typeof c.tenant === "string" ? c.tenant.trim().toLowerCase() : "";
  return {
    tenant: tenant || undefined,
    sandbox: c.sandbox === true,
    crewFields,
    probeIntervalMinutes: intParam(c.probeIntervalMinutes, 30, 5, 1440),
    // SmartHR allows 10 requests/second and 5,000/hour per token.
    ratePerSecond: intParam(c.ratePerSecond, 5, 1, 10),
    fieldProblems: problems,
  };
}

export function configProblems(s: SmartHRSettings): string[] {
  const problems: string[] = [];
  if (!s.tenant) {
    problems.push("tenant is not set");
  } else if (!TENANT.test(s.tenant)) {
    problems.push("tenant must be the SmartHR subdomain (letters, digits, hyphens)");
  }
  return [...problems, ...s.fieldProblems];
}

export function apiBase(s: SmartHRSettings): string {
  return `https://${s.tenant}.${s.sandbox ? "daruma.space" : "smarthr.jp"}/api/v1`;
}
