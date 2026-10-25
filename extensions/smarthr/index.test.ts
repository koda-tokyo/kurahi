import { describe, expect, it } from "vitest";
import {
  type ConnectorAuditSink,
  ConnectorRuntime,
  staticTokenCredential,
} from "../../src/connectors/business/index.js";
import {
  jsonResponse,
  MemorySecretStore,
  mockFetch,
  noSleep,
  on,
  type Route,
} from "../../src/connectors/business/test-helpers.js";
import { createSmartHRToolsFor, probeSmartHR, smarthrSignIn } from "./index.js";
import {
  CREW_FIELD_CEILING,
  configProblems,
  DEFAULT_CREW_FIELDS,
  isAllowedCrewField,
  readSettings,
  SCOPES,
  SENSITIVE_FIELD,
} from "./src/config.js";

// Recorded SmartHR API responses only; no request reaches a real tenant.
const BASE = "https://example.smarthr.jp/api/v1";

// Every property of the Crew object in SmartHR's published Swagger document
// (https://app.smarthr.jp/api/v1/swagger_doc, read 2026-10-25).
const CREW_PROPERTIES = [
  "id",
  "user_id",
  "biz_establishment_id",
  "emp_code",
  "emp_type",
  "employment_type",
  "emp_status",
  "last_name",
  "first_name",
  "last_name_yomi",
  "first_name_yomi",
  "business_last_name",
  "business_first_name",
  "business_last_name_yomi",
  "business_first_name_yomi",
  "preferred_last_name",
  "preferred_first_name",
  "preferred_last_name_yomi",
  "preferred_first_name_yomi",
  "birth_at",
  "gender",
  "identity_card_image1",
  "identity_card_image2",
  "tel_number",
  "address",
  "address_image",
  "address_head_of_family",
  "address_relation_name",
  "email",
  "profile_images",
  "emergency_relation_name",
  "emergency_last_name",
  "emergency_first_name",
  "emergency_last_name_yomi",
  "emergency_first_name_yomi",
  "emergency_tel_number",
  "emergency_address",
  "resident_card_address",
  "resident_card_address_head_of_family",
  "resident_card_address_relation_name",
  "position",
  "positions",
  "grade",
  "job_category",
  "occupation",
  "entered_at",
  "resigned_at",
  "resigned_reason",
  "recruitment_type",
  "resume1",
  "resume2",
  "emp_ins_insured_person_number",
  "emp_ins_insured_person_number_image",
  "emp_ins_insured_person_number_unknown_reason_type",
  "emp_ins_qualified_at",
  "emp_ins_disqualified_at",
  "previous_workplace",
  "previous_employment_start_on",
  "previous_employment_end_on",
  "soc_ins_insured_person_number",
  "hel_ins_insured_person_number",
  "basic_pension_number",
  "basic_pension_number_image",
  "first_enrolling_in_emp_pns_ins_flag",
  "basic_pension_number_unknown_reason_type",
  "first_workplace",
  "first_workplace_address_text",
  "first_employment_start_on",
  "first_employment_end_on",
  "last_workplace",
  "last_workplace_address_text",
  "last_employment_start_on",
  "last_employment_end_on",
  "soc_ins_qualified_at",
  "soc_ins_disqualified_at",
  "employees_pension_insurance_qualified_at",
  "employees_pension_insurance_disqualified_at",
  "health_insurance_qualified_at",
  "health_insurance_disqualified_at",
  "insurance_premium_calculation_type",
  "health_insurance_premium_company",
  "health_insurance_premium_individual",
  "care_insurance_premium_company",
  "care_insurance_premium_individual",
  "child_care_support_fund_company",
  "child_care_support_fund_individual",
  "employees_pension_insurance_premium_company",
  "employees_pension_insurance_premium_individual",
  "child_care_contribution",
  "having_spouse",
  "spouse_yearly_income",
  "monthly_income_currency",
  "monthly_income_goods",
  "payment_period",
  "monthly_base_salary",
  "monthly_standard_income_updated_at",
  "monthly_standard_income_hel",
  "monthly_standard_income_pns",
  "nearest_station_and_line",
  "commutation_1_expenses",
  "commutation_1_period",
  "commutation_1_single_fare",
  "commutation_2_expenses",
  "commutation_2_period",
  "commutation_2_single_fare",
  "foreign_resident_last_name",
  "foreign_resident_first_name",
  "foreign_resident_middle_name",
  "foreign_resident_card_number",
  "foreign_resident_card_image1",
  "foreign_resident_card_image2",
  "nationality_code",
  "resident_status_type",
  "resident_status_other_reason",
  "resident_end_at",
  "having_ex_activity_permission",
  "other_be_workable_type",
  "bank_accounts",
  "department",
  "departments",
  "contract_type",
  "contract_start_on",
  "contract_end_on",
  "contract_renewal_type",
  "tax_cd",
  "handicapped_type",
  "handicapped_note_type",
  "handicapped_note_delivery_at",
  "handicapped_image",
  "working_student_flag",
  "school_name",
  "student_card_image",
  "enrolled_at",
  "working_student_income",
  "employment_income_flag",
  "business_income_flag",
  "devidend_income_flag",
  "estate_income_flag",
  "widow_type",
  "widow_reason_type",
  "widow_memo",
  "custom_fields",
  "created_at",
  "updated_at",
];

/** The categories that must never leave SmartHR, whatever the configuration says. */
const NEVER = [
  "bank_accounts",
  "emp_ins_insured_person_number",
  "soc_ins_insured_person_number",
  "hel_ins_insured_person_number",
  "basic_pension_number",
  "health_insurance_premium_individual",
  "monthly_base_salary",
  "spouse_yearly_income",
  "tax_cd",
  "birth_at",
  "gender",
  "tel_number",
  "address",
  "emergency_tel_number",
  "resident_card_address",
  "foreign_resident_card_number",
  "nationality_code",
  "identity_card_image1",
  "handicapped_type",
  "custom_fields",
  "my_number",
];

function crewWithEverything(id: string) {
  const crew: Record<string, unknown> = {};
  for (const p of CREW_PROPERTIES) {
    crew[p] = `secret-${p}`;
  }
  crew.id = id;
  crew.last_name = "山田";
  crew.first_name = "太郎";
  crew.my_number = "123456789012";
  crew.bank_accounts = [{ account_number: "7654321" }];
  crew.departments = [
    { id: "d1", name: "営業部", full_name: "本社/営業部", code: "S", parent: {} },
  ];
  crew.employment_type = { id: "e1", name: "正社員", preset_type: "board_member" };
  return crew;
}

function setup(config: Record<string, unknown>, routes: Route[], grant = [SCOPES.read]) {
  const settings = readSettings({ tenant: "example", ...config });
  const secrets = new MemorySecretStore();
  const fetch = mockFetch(routes);
  const audit: Parameters<ConnectorAuditSink>[0][] = [];
  const runtime = new ConnectorRuntime(
    { id: "smarthr", credential: staticTokenCredential() },
    { secrets: () => secrets, fetch, sleep: noSleep, audit: (r) => void audit.push(r) },
  );
  runtime.tokens.save({
    accessToken: "shr_test_token_0123456789",
    expiresAt: Number.MAX_SAFE_INTEGER,
    scopes: grant,
    tokenType: "Bearer",
    obtainedAt: 0,
  });
  const tools = createSmartHRToolsFor(settings, runtime, { agentId: "main" });
  const tool = (name: string) => (params: Record<string, unknown>) =>
    tools.find((t) => t.name === name)!.execute("c", params) as Promise<{
      content: Array<{ text: string }>;
    }>;
  return { settings, runtime, tools, tool, fetch, audit };
}

describe("smarthr field allow-list", () => {
  it("allows only work-related fields of the published Crew schema", () => {
    const allowed = CREW_PROPERTIES.filter(isAllowedCrewField);
    expect(allowed.toSorted()).toEqual([...CREW_FIELD_CEILING].toSorted());
    for (const f of NEVER) {
      expect(isAllowedCrewField(f), f).toBe(false);
      expect(SENSITIVE_FIELD.test(f), f).toBe(true);
    }
    for (const f of CREW_FIELD_CEILING) {
      expect(SENSITIVE_FIELD.test(f), f).toBe(false);
    }
    expect(DEFAULT_CREW_FIELDS).not.toContain("email");
  });

  it("refuses a configuration that names a sensitive field", () => {
    const s = readSettings({ tenant: "example", crewFields: ["last_name", "bank_accounts"] });
    expect(configProblems(s)).toEqual([
      "crewFields may only name fields from the connector's allow-list (refused: 1)",
    ]);
    expect(s.crewFields).toEqual(["id", "last_name"]);
  });

  it("is read-only: three read tools, nothing else", () => {
    expect(setup({}, []).tools.map((t) => t.name)).toEqual([
      "smarthr_crews_list",
      "smarthr_crew_get",
      "smarthr_departments_list",
    ]);
  });
});

describe("smarthr tools", () => {
  it("requests only allow-listed fields and drops everything else from the response", async () => {
    const { tool, fetch, audit } = setup({}, [
      on("GET", `${BASE}/crews?`, () =>
        jsonResponse([crewWithEverything("c-1"), crewWithEverything("c-2")]),
      ),
    ]);
    const res = await tool("smarthr_crews_list")({ status: "employed", perPage: 2 });
    const url = new URL(fetch.calls[0].url);
    const requested = url.searchParams.get("fields")!.split(",");
    expect(requested.toSorted()).toEqual([...DEFAULT_CREW_FIELDS].toSorted());
    for (const f of requested) {
      expect(SENSITIVE_FIELD.test(f)).toBe(false);
    }
    expect(url.searchParams.get("emp_status")).toBe("employed");
    expect(url.searchParams.get("per_page")).toBe("2");
    expect(fetch.calls[0].headers.authorization).toBe("Bearer shr_test_token_0123456789");
    const text = res.content[0].text;
    expect(text).toContain("山田");
    expect(text).toContain("本社/営業部");
    expect(text).toContain("正社員");
    expect(text).not.toMatch(/123456789012|7654321|board_member/);
    for (const p of CREW_PROPERTIES.filter((f) => !DEFAULT_CREW_FIELDS.includes(f as never))) {
      expect(text, p).not.toContain(`secret-${p}\n`);
      expect(text, p).not.toMatch(new RegExp(`^\\s*-?\\s*${p}:`, "m"));
    }
    expect(text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT>>>");
    expect(text).toContain("more may exist");
    expect(audit[0].detail).toMatchObject({ op: "crews.list", ids: ["c-1", "c-2"], count: 2 });
    expect(JSON.stringify(audit)).not.toMatch(/山田|営業部/);
  });

  it("gets one crew with the allow-list and refuses malformed ids before any request", async () => {
    const { tool, fetch } = setup({ crewFields: ["last_name", "email"] }, [
      on("GET", `${BASE}/crews/c-9?`, () => jsonResponse(crewWithEverything("c-9"))),
    ]);
    const res = await tool("smarthr_crew_get")({ id: "c-9" });
    expect(new URL(fetch.calls[0].url).searchParams.get("fields")).toBe("id,last_name,email");
    expect(res.content[0].text).toContain("secret-email");
    expect(res.content[0].text).not.toContain("secret-tel_number");
    expect(
      (await tool("smarthr_crew_get")({ id: "../bank_account_settings" })).content[0].text,
    ).toMatch(/^Error: bad_request/);
    expect(fetch.calls).toHaveLength(1);
  });

  it("bounds pagination", async () => {
    const { tool, fetch } = setup({}, [
      on("GET", `${BASE}/crews?`, () => jsonResponse([])),
      on("GET", `${BASE}/departments?`, () =>
        jsonResponse([
          { id: "d1", name: "営業部", full_name: "本社/営業部", code: "S", parent: { id: "d0" } },
        ]),
      ),
    ]);
    await tool("smarthr_crews_list")({ page: 9999, perPage: 1000 });
    const u = new URL(fetch.calls[0].url);
    expect(u.searchParams.get("page")).toBe("50");
    expect(u.searchParams.get("per_page")).toBe("100");
    const deps = await tool("smarthr_departments_list")({});
    expect(deps.content[0].text).toContain("parent: d0");
  });

  it("refuses without the read scope, before any request", async () => {
    const { tool, fetch } = setup({}, [], []);
    expect((await tool("smarthr_crews_list")({})).content[0].text).toMatch(/^Error: scope_missing/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("probe asks for crew ids only; login stores the token with the read scope", async () => {
    const { runtime, settings, fetch } = setup({}, [
      on("GET", `${BASE}/crews?`, () => jsonResponse([{ id: "c-1" }])),
    ]);
    await probeSmartHR(runtime, settings);
    expect(new URL(fetch.calls[0].url).searchParams.get("fields")).toBe("id");
    const t = await smarthrSignIn({ readSecret: async () => "shr_0123456789abcdef" });
    expect(t.scopes).toEqual([SCOPES.read]);
    await expect(smarthrSignIn({ readSecret: async () => "x y" })).rejects.toMatchObject({
      code: "bad_request",
    });
  });

  it("uses the sandbox domain only when configured", () => {
    expect(readSettings({ tenant: "t1", sandbox: true }).sandbox).toBe(true);
    expect(configProblems(readSettings({ tenant: "bad.domain" }))).toEqual([
      "tenant must be the SmartHR subdomain (letters, digits, hyphens)",
    ]);
  });
});
