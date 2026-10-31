// Normalised artefacts of a vendor import, as Kurahi's model holds them. Every record keeps its
// provenance (IMPORTED_VENDOR_ARTEFACT) and its confidence (UNVERIFIED until a person reviews
// it), and points back to the bundle file (path, SHA-256, line or record number) it came from.
// Vendor labels and relation names are kept verbatim; `relationNormalised` is set only when the
// vendor's label is literally one of Kurahi's edge names, never by interpretation.

export const IMPORT_PROVENANCE = "IMPORTED_VENDOR_ARTEFACT" as const;
export type ImportConfidence = "UNVERIFIED";

/** Kurahi's dependency edge vocabulary (spec section 3). */
export const KURAHI_EDGE_TYPES = [
  "CALLS",
  "INCLUDES",
  "READS",
  "WRITES",
  "QUERIES",
  "STARTS_JOB",
  "IMPLEMENTS_RULE",
  "VALIDATED_BY",
  "DERIVED_FROM",
  "AFFECTS",
  "GENERATED_BY",
] as const;

export type SourceRef = {
  file: string;
  sha256: string;
  line?: number;
  record?: number;
};

type Base = {
  id: string;
  provenance: typeof IMPORT_PROVENANCE;
  confidence: ImportConfidence;
  source: SourceRef;
};

export type ImportedItem = Base & {
  name: string;
  /** Where `name` came from (e.g. `id`, `properties.name`, `file name`, a mapped column). */
  nameFrom: string;
  /** Vendor kind or labels, verbatim (`Program`, `Program:Cobol`, `business-function`). */
  kind: string;
  properties: Record<string, string | number | boolean | null>;
};

export type ImportedEdge = Base & {
  from: string;
  to: string;
  fromName: string;
  toName: string;
  relation: string;
  relationNormalised: (typeof KURAHI_EDGE_TYPES)[number] | null;
  properties: Record<string, string | number | boolean | null>;
};

export type ImportedRule = Base & {
  vendorId: string | null;
  title: string | null;
  text: string;
  /** Program, business function or other subject the vendor attached the rule to. */
  subject: string | null;
  ruleType: string;
};

export type ImportedFinding = Base & {
  title: string;
  detail: string | null;
  severity: string | null;
  subject: string | null;
};

export type NormalisedArtefacts = {
  items: ImportedItem[];
  edges: ImportedEdge[];
  rules: ImportedRule[];
  findings: ImportedFinding[];
  /** Per-file notes from the parser (lines it could not classify, ignored files). */
  notes: string[];
};

export const emptyArtefacts = (): NormalisedArtefacts => ({
  items: [],
  edges: [],
  rules: [],
  findings: [],
  notes: [],
});

export function normaliseRelation(label: string): ImportedEdge["relationNormalised"] {
  const up = label.trim().toUpperCase();
  return (KURAHI_EDGE_TYPES as readonly string[]).includes(up)
    ? (up as (typeof KURAHI_EDGE_TYPES)[number])
    : null;
}

/** Scalar properties only, bounded, so a hostile export cannot blow up the store or a prompt. */
export function scalarProps(raw: unknown): Record<string, string | number | boolean | null> {
  const out: Record<string, string | number | boolean | null> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return out;
  }
  let n = 0;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (n >= 64) {
      break;
    }
    const key = k.slice(0, 80);
    if (typeof v === "string") {
      out[key] = v.slice(0, 2000);
    } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
      out[key] = v;
    } else {
      continue;
    }
    n++;
  }
  return out;
}

export const base = (id: string, source: SourceRef): Base => ({
  id,
  provenance: IMPORT_PROVENANCE,
  confidence: "UNVERIFIED",
  source,
});
