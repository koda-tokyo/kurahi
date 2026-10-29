import { createHmac } from "node:crypto";
// Data subject requests (APPI 開示・訂正・利用停止等の請求), docs/security/data-governance.md.
//
// find     search every class for one identifier (email, phone, principal or free text) and
//          write a report: which records name it, which are under legal hold, which are kept by
//          law (evidence, audit). The report stores a keyed digest of the identifier, never the
//          identifier itself.
// execute  delete or anonymize the report's records, skipping every record under an active hold
//          and the classes that are never changed by a request (evidence bundles and the audit
//          log: signed, and part of the integrity chain). Anonymize replaces each occurrence with
//          a stable pseudonym; delete removes the record (closed work items only). The caller
//          repeats the identifier; it must match the report's digest.
import fs from "node:fs";
import path from "node:path";
import type { GovernanceDataClass } from "../config/types.governance.js";
import type { WorkItem } from "../workitems/types.js";
import { auditFileForMonth, listAuditMonths } from "../audit/audit-log.js";
import { sha256Hex } from "../continuity-suite/manifest.js";
import { withItemLock, writeWorkItem } from "../workitems/store.js";
import { holdsCovering, activeHolds, type DataRef } from "./holds.js";
import { foldWidth } from "./personal-data.js";
import { GovernanceRefused } from "./policy.js";
import { collectRecords, pseudonymizer, type GovRecord } from "./records.js";
import {
  auditDirOf,
  governanceDir,
  isGovernanceId,
  newGovernanceId,
  personalDataKey,
  readJsonFile,
  writeJsonAtomic,
} from "./store.js";
import { writeDeletionManifest, type ClassTally } from "./sweeper.js";

export const DSR_KINDS = ["email", "phone", "principal", "text"] as const;
export type DsrKind = (typeof DSR_KINDS)[number];

/** Classes a request may change. Evidence and audit are reported, never changed. */
const CHANGEABLE: ReadonlySet<GovernanceDataClass> = new Set([
  "transcripts",
  "workitems",
  "outputs",
  "memory",
]);
const SEARCHED: GovernanceDataClass[] = [
  "transcripts",
  "workitems",
  "outputs",
  "memory",
  "evidence",
];

export type DsrMatch = {
  class: GovernanceDataClass;
  id: string;
  projectId: string | null;
  workItemId: string | null;
  occurrences: number;
  /** deletable: may be changed; held: under hold; retained: kept by law or still open. */
  disposition: "deletable" | "held" | "retained";
  holdIds: string[];
  note?: string;
};

export type DsrReport = {
  id: string;
  createdAt: string;
  createdBy: string;
  reason: string;
  kind: DsrKind;
  identifierDigest: string;
  projectIds: string[] | null;
  matches: DsrMatch[];
  audit: { rows: number; disposition: "retained" };
  counts: { deletable: number; held: number; retained: number };
  executed?: {
    at: string;
    by: string;
    mode: "delete" | "anonymize";
    manifestId: string | null;
    changed: number;
    skipped: number;
  };
};

function dsrDir(home: string): string {
  return path.join(governanceDir(home), "dsr");
}

function digestOf(home: string, kind: DsrKind, identifier: string): string {
  return createHmac("sha256", personalDataKey(home))
    .update(`dsr:${kind}:${normalizeIdentifier(kind, identifier)}`)
    .digest("hex")
    .slice(0, 32);
}

export function normalizeIdentifier(kind: DsrKind, identifier: string): string {
  const folded = foldWidth(identifier).trim();
  return kind === "phone" ? folded.replace(/\D/g, "") : folded.toLowerCase();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Spans of `identifier` in `text` (phone digits may be separated by spaces or dashes). */
export function findOccurrences(
  text: string,
  kind: DsrKind,
  identifier: string,
): Array<[number, number]> {
  const norm = normalizeIdentifier(kind, identifier);
  if (!norm) {
    return [];
  }
  const folded = foldWidth(text);
  const pattern =
    kind === "phone"
      ? new RegExp(`(?<!\\d)${norm.split("").map(escapeRe).join("[ -]?")}(?!\\d)`, "g")
      : new RegExp(escapeRe(norm), "gi");
  const out: Array<[number, number]> = [];
  for (const m of folded.matchAll(pattern)) {
    out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function replaceSpans(text: string, spans: Array<[number, number]>, replacement: string): string {
  let out = "";
  let at = 0;
  for (const [s, e] of spans) {
    out += text.slice(at, s) + replacement;
    at = e;
  }
  return out + text.slice(at);
}

/** Files of a record that carry content (for search and targeted anonymization). */
function contentFiles(rec: GovRecord): string[] {
  switch (rec.class) {
    case "workitems":
      return [path.join(rec.path, "item.json")];
    case "outputs": {
      try {
        return fs
          .readdirSync(rec.path)
          .toSorted()
          .map((n) => path.join(rec.path, n))
          .filter((f) => fs.statSync(f).isFile());
      } catch {
        return [];
      }
    }
    case "evidence":
      return [path.join(rec.path, "events.jsonl")];
    default:
      return [rec.path];
  }
}

/**
 * A work item is rewritten under its lock and through the store's atomic write, with its revision
 * bumped: an edit racing the request can then neither write the identifier back nor be lost, and
 * readers never see a half-written item.json.
 */
function anonymizeWorkItem(
  dir: string,
  home: string,
  kind: DsrKind,
  identifier: string,
  pseudonym: string,
): void {
  withItemLock(dir, () => {
    const text = readText(path.join(dir, "item.json"));
    const spans = findOccurrences(text, kind, identifier);
    if (spans.length === 0) {
      return;
    }
    // The pseudonym has no quotes or backslashes, so the JSON stays valid.
    const next = JSON.parse(replaceSpans(text, spans, pseudonym)) as WorkItem;
    next.revision = (typeof next.revision === "number" ? next.revision : 0) + 1;
    writeWorkItem(next, home);
  });
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

export function findSubjectData(
  home: string,
  input: { identifier: unknown; kind?: unknown; reason: unknown; projectIds?: unknown },
  by: string,
  now: Date = new Date(),
): DsrReport {
  const identifier = typeof input.identifier === "string" ? input.identifier.trim() : "";
  const kind = (input.kind ?? "text") as DsrKind;
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!DSR_KINDS.includes(kind)) {
    throw new GovernanceRefused("bad_kind", `kind must be one of ${DSR_KINDS.join(", ")}`);
  }
  if (normalizeIdentifier(kind, identifier).length < 4 || identifier.length > 300) {
    throw new GovernanceRefused("bad_identifier", "the identifier must have at least 4 characters");
  }
  if (reason.length < 2 || reason.length > 2000) {
    throw new GovernanceRefused("reason_required", "a written reason is required");
  }
  const projectIds = Array.isArray(input.projectIds)
    ? input.projectIds.filter((p): p is string => typeof p === "string")
    : null;
  const holds = activeHolds(home);
  const matches: DsrMatch[] = [];
  for (const rec of collectRecords({ home, classes: new Set(SEARCHED) })) {
    if (projectIds && !(rec.projectId && projectIds.includes(rec.projectId))) {
      continue;
    }
    let occurrences = 0;
    for (const file of contentFiles(rec)) {
      occurrences += findOccurrences(readText(file), kind, identifier).length;
    }
    if (
      kind === "principal" &&
      (rec.persons?.includes(identifier) || rec.custodians?.includes(identifier))
    ) {
      occurrences = Math.max(occurrences, 1);
    }
    if (occurrences === 0) {
      continue;
    }
    const covering = holdsCovering(holds, rec);
    let disposition: DsrMatch["disposition"] = "deletable";
    let note: string | undefined;
    if (!CHANGEABLE.has(rec.class)) {
      disposition = "retained";
      note = "evidence is signed and kept for its retention period; it is reported, not changed";
    } else if (covering.length > 0) {
      disposition = "held";
    } else if (rec.class === "workitems" && !rec.apply) {
      disposition = "retained";
      note = "open work item: close it first";
    }
    matches.push({
      class: rec.class,
      id: rec.id,
      projectId: rec.projectId ?? null,
      workItemId: rec.workItemId ?? null,
      occurrences,
      disposition,
      holdIds: covering.map((h) => h.id),
      ...(note ? { note } : {}),
    });
  }
  let auditRows = 0;
  const adir = auditDirOf(home);
  for (const month of listAuditMonths(adir)) {
    const text = readText(auditFileForMonth(adir, month));
    auditRows += findOccurrences(text, kind, identifier).length;
  }
  const counts = { deletable: 0, held: 0, retained: 0 };
  for (const m of matches) {
    counts[m.disposition] += 1;
  }
  const report: DsrReport = {
    id: newGovernanceId("dsr"),
    createdAt: now.toISOString(),
    createdBy: by,
    reason,
    kind,
    identifierDigest: digestOf(home, kind, identifier),
    projectIds,
    matches,
    audit: { rows: auditRows, disposition: "retained" },
    counts,
  };
  writeJsonAtomic(path.join(dsrDir(home), `${report.id}.json`), report);
  return report;
}

export function readDsrReport(home: string, id: unknown): DsrReport | null {
  if (!isGovernanceId(id, "dsr")) {
    return null;
  }
  return readJsonFile<DsrReport | null>(path.join(dsrDir(home), `${id}.json`), null);
}

export async function executeSubjectRequest(
  home: string,
  input: { reportId: unknown; identifier: unknown; mode: unknown; reason: unknown },
  by: string,
  now: Date = new Date(),
): Promise<DsrReport> {
  const report = readDsrReport(home, input.reportId);
  if (!report) {
    throw new GovernanceRefused("report_not_found", "data subject request report not found");
  }
  if (report.executed) {
    throw new GovernanceRefused("report_executed", "this request was already carried out");
  }
  const mode = input.mode;
  if (mode !== "delete" && mode !== "anonymize") {
    throw new GovernanceRefused("bad_mode", 'mode must be "delete" or "anonymize"');
  }
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 2) {
    throw new GovernanceRefused("reason_required", "a written reason is required");
  }
  const identifier = typeof input.identifier === "string" ? input.identifier : "";
  if (digestOf(home, report.kind, identifier) !== report.identifierDigest) {
    throw new GovernanceRefused("identifier_mismatch", "the identifier does not match the report");
  }
  const holds = activeHolds(home);
  const pseudonym = pseudonymizer(home)(
    `${report.kind}:${normalizeIdentifier(report.kind, identifier)}`,
  );
  const wanted = new Map(
    report.matches
      .filter((m) => m.disposition === "deletable")
      .map((m) => [`${m.class}:${m.id}`, m]),
  );
  const tallies: Partial<Record<GovernanceDataClass, ClassTally>> = {};
  const tally = (c: GovernanceDataClass) =>
    (tallies[c] ??= {
      deleted: 0,
      anonymized: 0,
      held: 0,
      failed: 0,
      idHashes: [],
      oldest: null,
      newest: null,
    });
  const manifestId = `gov-dsr-${report.id.slice(4)}`;
  let changed = 0;
  let skipped = 0;
  for (const rec of collectRecords({ home, classes: CHANGEABLE })) {
    if (!wanted.has(`${rec.class}:${rec.id}`)) {
      continue;
    }
    const t = tally(rec.class);
    // Re-checked now: a hold placed after the report wins.
    if (holdsCovering(holds, rec as DataRef).length > 0) {
      t.held += 1;
      skipped += 1;
      continue;
    }
    try {
      if (mode === "anonymize") {
        if (rec.class === "workitems") {
          anonymizeWorkItem(rec.path, home, report.kind, identifier, pseudonym);
        } else {
          for (const file of contentFiles(rec)) {
            const text = readText(file);
            const spans = findOccurrences(text, report.kind, identifier);
            // The pseudonym has no quotes or backslashes, so JSON files stay valid.
            if (spans.length > 0) {
              fs.writeFileSync(file, replaceSpans(text, spans, pseudonym), { mode: 0o600 });
            }
          }
        }
        t.anonymized += 1;
      } else {
        if (!rec.apply) {
          skipped += 1;
          continue;
        }
        await rec.apply("delete", {
          home,
          now,
          manifestId,
          cause: "dsr",
          pseudonym: pseudonymizer(home),
        });
        t.deleted += 1;
      }
      t.idHashes.push(sha256Hex(`${rec.class}:${rec.id}`));
      t.oldest = !t.oldest || rec.at < t.oldest ? rec.at : t.oldest;
      t.newest = !t.newest || rec.at > t.newest ? rec.at : t.newest;
      changed += 1;
    } catch {
      t.failed += 1;
    }
  }
  if (changed > 0) {
    writeDeletionManifest(
      home,
      manifestId,
      { at: now.toISOString(), classes: tallies as Record<GovernanceDataClass, ClassTally> },
      { kind: "governance.dsr", by, now, extra: { reportId: report.id, mode } },
    );
  }
  report.executed = {
    at: now.toISOString(),
    by,
    mode,
    manifestId: changed > 0 ? manifestId : null,
    changed,
    skipped,
  };
  writeJsonAtomic(path.join(dsrDir(home), `${report.id}.json`), report);
  return report;
}
