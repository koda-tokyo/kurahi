// What the modernisation tools show of a Project's vendor imports. Imported data is never mixed
// into the analyser's own facts: it is returned in a separate `imported` block, each entry
// labelled with its provenance (IMPORTED_VENDOR_ARTEFACT), confidence (UNVERIFIED), vendor
// format and its verification status, and the bundle file it came from.

import type { ImportRecord } from "./store.js";
import { listImports, readImportArtefacts } from "./store.js";

export const IMPORTED_NOTE =
  "Imported from a vendor export: not checked by Kurahi's analyser and unverified until a person reviews it. " +
  "Cite it as the vendor's claim, with its file and line.";

const MAX_LIST = 500;

function summary(r: ImportRecord) {
  return {
    importId: r.importId,
    provider: r.provider,
    format: r.format,
    verification: r.verification,
    importedAt: r.importedAt,
    importedBy: r.importedBy,
    origin: {
      product: r.manifest.origin.product,
      productVersion: r.manifest.origin.productVersion,
      exportedAt: r.manifest.origin.exportedAt,
    },
    counts: r.counts,
  };
}

export function listImportSummaries(projectId: string, home?: string) {
  return listImports(projectId, home).map(summary);
}

/** Imported inventory: items (optionally those whose name matches `name`), with rules attached. */
export function importedInventory(projectId: string, name?: string, home?: string) {
  const needle = name?.trim().toLowerCase();
  const out = [];
  for (const r of listImports(projectId, home)) {
    const a = readImportArtefacts(projectId, r.importId, home);
    if (!a) {
      continue;
    }
    const items = a.items.filter((i) => !needle || i.name.toLowerCase() === needle);
    out.push({
      ...summary(r),
      items: items.slice(0, MAX_LIST),
      truncated: items.length > MAX_LIST,
      ...(needle
        ? {
            rules: a.rules.filter((x) => x.subject?.toLowerCase() === needle).slice(0, MAX_LIST),
            findings: a.findings.filter((x) => x.subject?.toLowerCase() === needle),
          }
        : {}),
    });
  }
  return { note: IMPORTED_NOTE, imports: out };
}

/**
 * Imported edges touching `target` (by item name, case-insensitive), one hop either way, plus
 * rules whose subject is the target. Null when the Project has no imports.
 */
export function importedImpact(projectId: string, target: string, home?: string) {
  const records = listImports(projectId, home);
  if (records.length === 0) {
    return null;
  }
  const t = target.trim().toLowerCase();
  const out = [];
  for (const r of records) {
    const a = readImportArtefacts(projectId, r.importId, home);
    if (!a) {
      continue;
    }
    const edges = a.edges.filter(
      (e) => e.fromName.toLowerCase() === t || e.toName.toLowerCase() === t,
    );
    const rules = a.rules.filter((x) => x.subject?.toLowerCase() === t);
    if (edges.length === 0 && rules.length === 0) {
      continue;
    }
    out.push({
      ...summary(r),
      upstream: edges.filter((e) => e.toName.toLowerCase() === t).slice(0, MAX_LIST),
      downstream: edges.filter((e) => e.fromName.toLowerCase() === t).slice(0, MAX_LIST),
      rules: rules.slice(0, MAX_LIST),
    });
  }
  return { note: IMPORTED_NOTE, target, imports: out };
}
