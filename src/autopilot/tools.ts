// Tools a routine's gather steps may call: READ tools only, declared per connector or plugin.
// Anything not in this catalogue is refused (fail closed), and so is a tool whose runtime
// metadata names a different plugin than the one that declared it (a look-alike tool name).
// Write tools are never callable from gather; actions go through the action catalogue.

export type ReadToolDef = {
  name: string;
  /** Plugin id that provides the tool, `core` for built-in tools, `engine` for in-process checks. */
  provider: string;
};

const CORE_READ_TOOLS: ReadToolDef[] = [
  ...[
    "m365_mail_list",
    "m365_mail_search",
    "m365_mail_read",
    // One file attachment: quarantined, policy-checked and malware-scanned before anything is
    // stored (src/security/attachment-intake.ts); a refusal flags the item malicious_attachment.
    "m365_mail_attachment_fetch",
    "m365_calendar_list",
    "m365_calendar_read",
    "m365_files_search",
    "m365_files_read",
    "m365_sites_search",
    // Guardian: Microsoft security alerts (Graph alerts_v2), summaries only.
    "m365_security_alerts",
  ].map((name) => ({ name, provider: "microsoft-365" })),
  ...["gmail_list", "gmail_search", "gmail_read"].map((name) => ({ name, provider: "gmail" })),
  ...[
    "entra_users_search",
    "entra_user_get",
    "entra_groups_search",
    "entra_group_members",
    "entra_user_groups",
  ].map((name) => ({ name, provider: "entra" })),
  // Japanese business SaaS connectors (extensions/<id>): read tools only.
  ...["kintone_apps_list", "kintone_records_query", "kintone_record_get"].map((name) => ({
    name,
    provider: "kintone",
  })),
  ...[
    "freee_companies_list",
    "freee_deals_list",
    "freee_deal_get",
    "freee_partners_list",
    "freee_account_items_list",
    "freee_receipts_list",
  ].map((name) => ({ name, provider: "freee" })),
  ...[
    "mf_invoice_billings_list",
    "mf_invoice_billing_get",
    "mf_invoice_quotes_list",
    "mf_invoice_partners_list",
  ].map((name) => ({ name, provider: "money-forward" })),
  ...["smarthr_crews_list", "smarthr_crew_get", "smarthr_departments_list"].map((name) => ({
    name,
    provider: "smarthr",
  })),
  ...["lineworks_channel_get", "lineworks_channel_members"].map((name) => ({
    name,
    provider: "line-works",
  })),
  // box_file_fetch stores into the Project only through the attachment intake (quarantine, policy,
  // malware scan), like m365_mail_attachment_fetch.
  ...["box_search", "box_file_metadata", "box_file_fetch"].map((name) => ({
    name,
    provider: "box",
  })),
  // legacy-analyzer: read-only on the sources (results are cached in the project's output/).
  ...[
    "legacy_index",
    "legacy_query",
    "legacy_rules",
    "legacy_dictionary",
    "legacy_impact",
    "legacy_wave_plan",
    "legacy_changes",
    "modernise_plan",
    "modernise_crud",
    "modernise_impact",
    "modernise_inventory",
  ].map((name) => ({ name, provider: "legacy-analyzer" })),
  // scholar-sources (Scholars): keyless literature APIs, read-only. scholar_fetch_pdf stores an
  // open-access PDF only through the attachment intake (quarantine, policy, malware scan) into
  // corpus-inbox/, like m365_mail_attachment_fetch; a refusal flags the item.
  ...[
    "scholar_search",
    "scholar_get",
    "scholar_cite_check",
    "scholar_fetch_pdf",
    "scholar_grant_deadlines",
  ].map((name) => ({ name, provider: "scholar-sources" })),
  { name: "web_search", provider: "core" },
  { name: "web_fetch", provider: "core" },
  // In-process deterministic checks (engine-tools.ts), the ops jobs' probes as tools.
  ...[
    "health_disk",
    "health_memory",
    "health_clock",
    "health_policy",
    "health_evidence",
    "workitems_linked",
    "workitems_po_ready",
    // Guardian (src/guardian): posture checks and the share scan.
    "guardian_backup",
    "guardian_restore_test",
    "guardian_secrets",
    "guardian_ports",
    "guardian_integrity",
    "guardian_credentials",
    "guardian_scan",
  ].map((name) => ({ name, provider: "engine" })),
  // Guardian: JPCERT/CC and IPA advisories from allow-listed feeds (src/guardian/advisories.ts).
  { name: "guardian_advisories", provider: "core" },
];

/** Known write tools: named in errors so a misconfigured routine says what is wrong. */
const KNOWN_WRITE_TOOLS = new Set([
  "m365_mail_send",
  "m365_mail_create_draft",
  "m365_mail_attach_to_draft",
  "m365_files_upload",
  "m365_calendar_create_event",
  "gmail_send",
  "kintone_record_comment_add",
  "kintone_record_create",
  "lineworks_message_send",
  "box_file_upload",
  "office_docx_create",
  "office_pptx_create",
  "office_xlsx_create",
  "office_quote_create",
  "office_po_create",
  "legacy_design_doc",
  "legacy_baseline_advance",
  "exec",
  "write",
  "edit",
  "apply_patch",
  "message",
]);

const registry = new Map<string, ReadToolDef>(CORE_READ_TOOLS.map((t) => [t.name, t]));

/** A plugin declares one of its tools as read-only for gather. It cannot claim another's. */
export function registerAutopilotReadTool(def: ReadToolDef): void {
  if (!/^[a-z][a-z0-9_]{1,63}$/.test(def.name)) {
    throw new Error(`autopilot read tool ${def.name}: invalid name`);
  }
  if (KNOWN_WRITE_TOOLS.has(def.name)) {
    throw new Error(`autopilot read tool ${def.name} is a write tool`);
  }
  const prior = registry.get(def.name);
  if (prior && prior.provider !== def.provider) {
    throw new Error(`autopilot read tool ${def.name} is already declared by ${prior.provider}`);
  }
  registry.set(def.name, def);
}

export function readToolDef(name: string): ReadToolDef | null {
  return registry.get(name) ?? null;
}

/** Why a gather step may not call `name`, or null when it may. */
export function gatherToolRefusal(name: string): string | null {
  if (registry.has(name)) {
    return null;
  }
  return KNOWN_WRITE_TOOLS.has(name)
    ? `${name} is a write tool; gather may only read`
    : `${name} is not a declared read tool`;
}
