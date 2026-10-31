// Modernisation provider capability registry (KIMS spec section 4; KIMS-020, KIMS-032).
//
// A vendor-neutral list of what each external modernisation provider can do *here*, by access
// mode. A capability is usable only when its descriptor says so; a provider's brand name never
// grants one. Every action passes requireProviderAction() before anything else runs, so an
// unavailable action fails with CAPABILITY_UNAVAILABLE before any outbound call (AC-031).
//
// Today only OFFLINE_IMPORT exists: customer-exported result bundles read from disk. Direct
// execution against a vendor (REMOTE_API, REMOTE_MCP) is listed as DISABLED with the reason, and
// no transport for it exists in this code base (AC-044).
//
// Format verification states the honesty rule of the importer:
//   VERIFIED_FROM_DOCS  the parser follows the vendor's public documentation of that output, and
//                       its fixtures follow the documented structure (`docs` links the pages;
//                       `verifiedScope` says exactly which part the documentation fixes)
//   UNVERIFIED_SCHEMA   the vendor does not publish the field-level schema: the bundle is read
//                       only through an explicit field mapping file the customer supplies
//                       (generic-mapped), never through a schema guessed here

export const ACCESS_MODES = [
  "NATIVE",
  "OFFLINE_IMPORT",
  "HUMAN_MEDIATED",
  "REMOTE_API",
  "REMOTE_MCP",
] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

export const PROVIDER_CAPABILITIES = [
  "SOURCE_ANALYSIS",
  "CODE_EXPLANATION",
  "BUSINESS_RULE_EXTRACTION",
  "IMPACT_ANALYSIS",
  "PATCH_PROPOSAL",
  "TRANSFORMATION",
  "VALIDATION",
  "TEST_EXECUTION",
  "DOCUMENT_EXPORT",
  "JOB_STATUS",
] as const;
export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export const PROVIDER_STATUSES = ["AVAILABLE", "IMPORT_ONLY", "UNVERIFIED", "DISABLED"] as const;
export type ProviderStatus = (typeof PROVIDER_STATUSES)[number];

export const PROVIDER_ERROR_CODES = [
  "NOT_ENTITLED",
  "UNAUTHORISED",
  "CAPABILITY_UNAVAILABLE",
  "POLICY_DENIED",
  "REGION_DENIED",
  "SCHEMA_REJECTED",
  "RATE_LIMIT",
  "TIMEOUT",
  "CANCELLED",
  "UNKNOWN_EXTERNAL_STATE",
  "VENDOR_FAILED",
  "ARTEFACT_INTEGRITY_FAILED",
] as const;
export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[number];

/** A typed provider error: stable code, sanitised message (no tokens, no source), remediation. */
export class ProviderError extends Error {
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    readonly remediation: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export type FormatVerification = "VERIFIED_FROM_DOCS" | "UNVERIFIED_SCHEMA";
export type FormatParser = "neo4j-jsonl" | "ears-requirements-md" | "docgen-md" | "generic-mapped";

export type ImportFormat = {
  id: string;
  label: string;
  parser: FormatParser;
  verification: FormatVerification;
  /** What the public documentation fixes, and what it leaves open. */
  verifiedScope: string;
  /** Official documentation pages the parser follows (or that show no schema is published). */
  docs: string[];
  capabilities: ProviderCapability[];
};

export type ProviderDescriptor = {
  provider_id: string;
  product_family: string;
  /** Product version the descriptor was checked against; null when the vendor does not version the export. */
  version: string | null;
  access_mode: AccessMode;
  capabilities: ProviderCapability[];
  formats: ImportFormat[];
  /** Date the descriptor was last checked against the vendor documentation. */
  verified_at: string;
  status: ProviderStatus;
  /** Why the status is what it is (always set for DISABLED). */
  reason: string;
  requires_human_approval: boolean;
};

const CHECKED = "2026-11-01";

const GOOGLE_MAT_EXPORT =
  "https://docs.cloud.google.com/mainframe-assessment-tool/docs/export-results";
const GOOGLE_MAT_MCP = "https://docs.cloud.google.com/mainframe-assessment-tool/docs/mcp-server";
const AWS_WORKFLOW =
  "https://docs.aws.amazon.com/transform/latest/userguide/transform-app-mainframe-workflow.html";
const AWS_OVERVIEW =
  "https://docs.aws.amazon.com/transform/latest/userguide/transform-app-mainframe.html";
const IBM_DOCGEN = "https://www.ibm.com/docs/en/SSK5UBS_2.0/understand/topics/Docgen_create.html";
const IBM_RULES = "https://www.ibm.com/docs/en/SSK5UBS_2.0/understand/topics/rules_intro.html";
const IBM_CHAT =
  "https://www.ibm.com/docs/en/watsonx/watsonx-code-assistant-4z/2.x?topic=chat-using-watsonx-code-assistant-z-extension";
const IBM_CONNECT =
  "https://www.ibm.com/docs/en/watsonx/watsonx-code-assistant-4z/2.x?topic=transform-connecting-watsonx-code-assistant-z-services";

const GENERIC_SCOPE =
  "No field-level schema is published. Imported only through a field mapping file supplied with the bundle; nothing is inferred.";

/** The registry. Changing a status here is a product claim: keep it backed by docs and tests. */
export const PROVIDER_DESCRIPTORS: readonly ProviderDescriptor[] = [
  {
    provider_id: "google-mat",
    product_family: "Google Cloud Mainframe Assessment Tool",
    version: null,
    access_mode: "OFFLINE_IMPORT",
    capabilities: ["SOURCE_ANALYSIS", "IMPACT_ANALYSIS", "CODE_EXPLANATION"],
    formats: [
      {
        id: "neo4j-jsonl",
        label: "Neo4j graph export (JSON Lines)",
        parser: "neo4j-jsonl",
        verification: "VERIFIED_FROM_DOCS",
        verifiedScope:
          "Record envelope documented: node {type:'node', id, labels[], properties{}} and relationship " +
          "{type:'relationship', start.id, end.id, label, properties{}}. Label values and property names " +
          "are not documented: they are kept verbatim, never interpreted.",
        docs: [GOOGLE_MAT_EXPORT],
        capabilities: ["SOURCE_ANALYSIS", "IMPACT_ANALYSIS"],
      },
      {
        id: "json-report",
        label: "JSON report (one file per program)",
        parser: "generic-mapped",
        verification: "UNVERIFIED_SCHEMA",
        verifiedScope: GENERIC_SCOPE,
        docs: [GOOGLE_MAT_EXPORT],
        capabilities: ["CODE_EXPLANATION"],
      },
    ],
    verified_at: CHECKED,
    status: "IMPORT_ONLY",
    reason: "Exported results are imported from a bundle; nothing is sent to the vendor.",
    requires_human_approval: false,
  },
  {
    provider_id: "aws-transform",
    product_family: "AWS Transform for mainframe",
    version: null,
    access_mode: "OFFLINE_IMPORT",
    capabilities: ["BUSINESS_RULE_EXTRACTION", "SOURCE_ANALYSIS", "DOCUMENT_EXPORT"],
    formats: [
      {
        id: "requirements-md",
        label: "Generated requirements (requirements.md per business function)",
        parser: "ears-requirements-md",
        verification: "VERIFIED_FROM_DOCS",
        verifiedScope:
          "Documented parts: title, global preconditions, numbered workflow sections each with a user story " +
          "and requirements in EARS format with a unique identifier. The exact Markdown syntax is not " +
          "documented: headings of any level are read, and lines that cannot be classified are reported.",
        docs: [AWS_WORKFLOW],
        capabilities: ["BUSINESS_RULE_EXTRACTION", "DOCUMENT_EXPORT"],
      },
      {
        id: "analysis-json",
        label:
          "Analysis outputs (business logic JSON, dependencies JSON, assets list, data analysis)",
        parser: "generic-mapped",
        verification: "UNVERIFIED_SCHEMA",
        verifiedScope: GENERIC_SCOPE,
        docs: [AWS_WORKFLOW, AWS_OVERVIEW],
        capabilities: ["SOURCE_ANALYSIS", "BUSINESS_RULE_EXTRACTION"],
      },
    ],
    verified_at: CHECKED,
    status: "IMPORT_ONLY",
    reason:
      "Outputs copied from the customer's S3 bucket are imported from a bundle; nothing is sent to the vendor.",
    requires_human_approval: false,
  },
  {
    provider_id: "ibm-z",
    product_family: "IBM watsonx Code Assistant for Z (Z Understand)",
    version: "2.x",
    access_mode: "OFFLINE_IMPORT",
    capabilities: ["CODE_EXPLANATION", "BUSINESS_RULE_EXTRACTION"],
    formats: [
      {
        id: "understand-docgen-md",
        label: "Z Understand documentation generation (Documentation folder, Markdown)",
        parser: "docgen-md",
        verification: "VERIFIED_FROM_DOCS",
        verifiedScope:
          "Documented layout: Documentation/application_document.md and Documentation/programs/<program_name>.md, " +
          "with the documented default section names (Purpose, Inputs, Outputs, Business Rules, Business " +
          "Variables, Processing Logic, Paragraphs, Dependencies, Constraints, Error Handling, Examples; and " +
          "for the application Overview, Processing Flow, Components). Heading syntax is not documented.",
        docs: [IBM_DOCGEN],
        capabilities: ["CODE_EXPLANATION", "BUSINESS_RULE_EXTRACTION"],
      },
      {
        id: "business-rules-export",
        label: "Business rule export (.json or .csv)",
        parser: "generic-mapped",
        verification: "UNVERIFIED_SCHEMA",
        verifiedScope: GENERIC_SCOPE,
        docs: [IBM_RULES],
        capabilities: ["BUSINESS_RULE_EXTRACTION"],
      },
    ],
    verified_at: CHECKED,
    status: "IMPORT_ONLY",
    reason:
      "Customer-exported artefacts are imported from a bundle; nothing is sent to the vendor.",
    requires_human_approval: false,
  },
  {
    provider_id: "ibm-z-remote",
    product_family: "IBM watsonx Code Assistant for Z (chat and MCP tools)",
    version: null,
    access_mode: "REMOTE_MCP",
    capabilities: [],
    formats: [],
    verified_at: CHECKED,
    status: "DISABLED",
    reason:
      "Not implemented. Remote access for a third-party client, its endpoints, auth, limits and licence " +
      "terms have not been verified in an authorised sandbox.",
    requires_human_approval: true,
  },
  {
    provider_id: "ibm-watsonx-ai",
    product_family: "IBM watsonx.ai model endpoint",
    version: null,
    access_mode: "REMOTE_API",
    capabilities: [],
    formats: [],
    verified_at: CHECKED,
    status: "DISABLED",
    reason:
      "Not configured here. A separately entitled model endpoint would use the existing model provider " +
      "mechanism after endpoint, region and model checks; it is not Code Assistant for Z.",
    requires_human_approval: true,
  },
  {
    provider_id: "aws-transform-remote",
    product_family: "AWS Transform for mainframe (job orchestration)",
    version: null,
    access_mode: "REMOTE_API",
    capabilities: [],
    formats: [],
    verified_at: CHECKED,
    status: "DISABLED",
    reason:
      "Planned, not active. Starting or controlling AWS Transform jobs from here is not implemented or verified.",
    requires_human_approval: true,
  },
  {
    provider_id: "google-mat-remote",
    product_family: "Google Cloud Mainframe Assessment Tool (MCP server)",
    version: null,
    access_mode: "REMOTE_MCP",
    capabilities: [],
    formats: [],
    verified_at: CHECKED,
    status: "DISABLED",
    reason:
      "Planned, not active. The vendor's MCP server is documented as Preview and needs specific enablement; " +
      `not implemented or verified here (${GOOGLE_MAT_MCP}).`,
    requires_human_approval: true,
  },
];

/** Every documentation link the registry cites, for the docs page and the report. */
export const PROVIDER_DOC_LINKS = { IBM_CHAT, IBM_CONNECT };

export function listProviders(
  registry: readonly ProviderDescriptor[] = PROVIDER_DESCRIPTORS,
): ProviderDescriptor[] {
  return registry.map((d) => ({ ...d }));
}

export function findProvider(
  id: string,
  registry: readonly ProviderDescriptor[] = PROVIDER_DESCRIPTORS,
): ProviderDescriptor | null {
  return registry.find((d) => d.provider_id === id) ?? null;
}

export type ProviderAction = {
  provider: string;
  mode: AccessMode;
  /** Import format id (OFFLINE_IMPORT only; omitted = check the provider and mode only). */
  format?: string;
  capability?: ProviderCapability;
};

/**
 * The gate every provider action passes first. Throws CAPABILITY_UNAVAILABLE for an unknown
 * provider, a DISABLED or UNVERIFIED descriptor, another access mode, a capability the descriptor
 * does not list, or an unknown format. Returns the descriptor (and format) on success.
 */
export function requireProviderAction(
  action: ProviderAction,
  registry: readonly ProviderDescriptor[] = PROVIDER_DESCRIPTORS,
): { descriptor: ProviderDescriptor; format: ImportFormat | null } {
  const known = registry.map((d) => d.provider_id).join(", ");
  const d = findProvider(action.provider, registry);
  if (!d) {
    throw new ProviderError(
      "CAPABILITY_UNAVAILABLE",
      `unknown provider "${action.provider}"`,
      `Use one of: ${known}.`,
    );
  }
  if (d.status === "DISABLED" || d.status === "UNVERIFIED") {
    throw new ProviderError(
      "CAPABILITY_UNAVAILABLE",
      `${d.provider_id} is ${d.status}: ${d.reason}`,
      "Use an offline import of exported results instead.",
    );
  }
  if (d.access_mode !== action.mode) {
    throw new ProviderError(
      "CAPABILITY_UNAVAILABLE",
      `${d.provider_id} supports ${d.access_mode} only, not ${action.mode}`,
      "Use an offline import of exported results instead.",
    );
  }
  if (action.capability && !d.capabilities.includes(action.capability)) {
    throw new ProviderError(
      "CAPABILITY_UNAVAILABLE",
      `${d.provider_id} does not provide ${action.capability} here`,
      `Available: ${d.capabilities.join(", ") || "none"}.`,
    );
  }
  let format: ImportFormat | null = null;
  // An import's format is known once its manifest is read: the pipeline calls the gate again then.
  if (action.mode === "OFFLINE_IMPORT" && action.format !== undefined) {
    format = d.formats.find((f) => f.id === action.format) ?? null;
    if (!format) {
      throw new ProviderError(
        "CAPABILITY_UNAVAILABLE",
        `${d.provider_id} has no import format "${action.format ?? ""}"`,
        `Formats: ${d.formats.map((f) => f.id).join(", ")}.`,
      );
    }
  }
  return { descriptor: d, format };
}

/** An outbound transport for remote modes. None exists in this code base; tests pass a spy. */
export type ProviderTransport = (request: {
  provider: string;
  capability: ProviderCapability;
  idempotencyKey: string;
  payload: unknown;
}) => Promise<unknown>;

/**
 * Run a remote provider action: the registry gate runs first, so a DISABLED descriptor never
 * reaches the transport. Kept as the single entry point a future verified adapter must use.
 */
export async function invokeRemoteProvider(
  action: { provider: string; mode: "REMOTE_API" | "REMOTE_MCP"; capability: ProviderCapability },
  request: { idempotencyKey: string; payload: unknown },
  transport: ProviderTransport,
  registry: readonly ProviderDescriptor[] = PROVIDER_DESCRIPTORS,
): Promise<unknown> {
  requireProviderAction(action, registry);
  if (!request.idempotencyKey) {
    throw new ProviderError(
      "POLICY_DENIED",
      "a remote action needs an idempotency key",
      "Pass the job's idempotency key.",
    );
  }
  return await transport({
    provider: action.provider,
    capability: action.capability,
    idempotencyKey: request.idempotencyKey,
    payload: request.payload,
  });
}
