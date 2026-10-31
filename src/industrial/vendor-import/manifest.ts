// The import manifest (`kurahi-import.json` at the bundle root): who exported what, from which
// product, and the SHA-256 and size of every file. The bundle must hold exactly the files the
// manifest lists (plus the manifest); a hash or size that differs, a missing file or an extra
// file is ARTEFACT_INTEGRITY_FAILED. File contents must be UTF-8 (an EBCDIC or binary export is
// SCHEMA_REJECTED, not transcoded by guess).

import { createHash } from "node:crypto";
import type { BundleFiles } from "./bundle.js";
import { ProviderError } from "../providers.js";
import { safeEntryName } from "./bundle.js";

export const MANIFEST_FILE = "kurahi-import.json";
export const MANIFEST_SCHEMA = "kurahi.vendor-import/1";
export const MAPPING_ROLE = "mapping";

export type ManifestFile = {
  path: string;
  sha256: string;
  bytes: number;
  /** `data` (default), `mapping` (generic-mapped field map) or `ignored` (e.g. a log). */
  role: "data" | "mapping" | "ignored";
};

export type ImportManifest = {
  schema: typeof MANIFEST_SCHEMA;
  provider: string;
  format: string;
  origin: {
    product: string;
    productVersion: string | null;
    exportedAt: string;
    exportedBy: string;
    /** Who authorised handing the export to Kurahi (recorded, shown, not verified here). */
    authorisedBy: string;
    sourceSystem: string | null;
  };
  files: ManifestFile[];
};

export const sha256Hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

const bad = (message: string) =>
  new ProviderError(
    "SCHEMA_REJECTED",
    `manifest: ${message}`,
    `Add a ${MANIFEST_FILE} that follows docs/industrial/vendor-import.md.`,
  );

const str = (v: unknown, field: string, max = 200): string => {
  if (typeof v !== "string" || !v.trim()) {
    throw bad(`${field} is required`);
  }
  return v.trim().slice(0, max);
};

const optStr = (v: unknown, max = 200): string | null =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

export function parseManifest(files: BundleFiles): ImportManifest {
  const raw = files.get(MANIFEST_FILE);
  if (!raw) {
    throw bad(`${MANIFEST_FILE} is missing at the bundle root`);
  }
  let json: unknown;
  try {
    json = JSON.parse(decodeUtf8(raw, MANIFEST_FILE));
  } catch (err) {
    throw err instanceof ProviderError ? err : bad("it is not valid JSON");
  }
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw bad("it must be a JSON object");
  }
  const m = json as Record<string, unknown>;
  if (m.schema !== MANIFEST_SCHEMA) {
    throw bad(`schema must be "${MANIFEST_SCHEMA}"`);
  }
  const origin = (m.origin && typeof m.origin === "object" ? m.origin : {}) as Record<
    string,
    unknown
  >;
  const exportedAt = str(origin.exportedAt, "origin.exportedAt", 40);
  if (Number.isNaN(Date.parse(exportedAt))) {
    throw bad("origin.exportedAt must be an ISO date");
  }
  if (!Array.isArray(m.files) || m.files.length === 0) {
    throw bad("files must list every file of the bundle");
  }
  const seen = new Set<string>();
  const list: ManifestFile[] = m.files.map((f: unknown, i: number) => {
    const e = (f && typeof f === "object" ? f : {}) as Record<string, unknown>;
    const p = str(e.path, `files[${i}].path`, 512);
    if (!safeEntryName(p) || p === MANIFEST_FILE) {
      throw bad(`files[${i}].path is not a plain relative path`);
    }
    if (seen.has(p)) {
      throw bad(`files[${i}].path is listed twice`);
    }
    seen.add(p);
    const sha = str(e.sha256, `files[${i}].sha256`, 64).toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(sha)) {
      throw bad(`files[${i}].sha256 must be 64 hex characters`);
    }
    if (typeof e.bytes !== "number" || !Number.isInteger(e.bytes) || e.bytes < 0) {
      throw bad(`files[${i}].bytes must be a whole number`);
    }
    const role = e.role === undefined ? "data" : e.role;
    if (role !== "data" && role !== MAPPING_ROLE && role !== "ignored") {
      throw bad(`files[${i}].role must be data, mapping or ignored`);
    }
    return { path: p, sha256: sha, bytes: e.bytes, role };
  });
  return {
    schema: MANIFEST_SCHEMA,
    provider: str(m.provider, "provider", 64),
    format: str(m.format, "format", 64),
    origin: {
      product: str(origin.product, "origin.product"),
      productVersion: optStr(origin.productVersion, 64),
      exportedAt,
      exportedBy: str(origin.exportedBy, "origin.exportedBy"),
      authorisedBy: str(origin.authorisedBy, "origin.authorisedBy"),
      sourceSystem: optStr(origin.sourceSystem),
    },
    files: list,
  };
}

/** Every listed file present with its size and hash; nothing unlisted in the bundle. */
export function verifyIntegrity(manifest: ImportManifest, files: BundleFiles): void {
  const fail = (message: string) =>
    new ProviderError(
      "ARTEFACT_INTEGRITY_FAILED",
      message,
      "Export the bundle again and import it unchanged; the manifest hashes must match the files.",
    );
  const listed = new Set(manifest.files.map((f) => f.path));
  for (const name of files.keys()) {
    if (name !== MANIFEST_FILE && !listed.has(name)) {
      throw fail(`a file in the bundle is not in the manifest (${name.slice(0, 120)})`);
    }
  }
  for (const f of manifest.files) {
    const data = files.get(f.path);
    if (!data) {
      throw fail(`a file in the manifest is missing from the bundle (${f.path.slice(0, 120)})`);
    }
    if (data.length !== f.bytes) {
      throw fail(`size mismatch for ${f.path.slice(0, 120)}`);
    }
    if (sha256Hex(data) !== f.sha256) {
      throw fail(`SHA-256 mismatch for ${f.path.slice(0, 120)}`);
    }
  }
}

/** Strict UTF-8 (a BOM is dropped); anything else is SCHEMA_REJECTED. */
export function decodeUtf8(data: Buffer, name: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    return text.startsWith("﻿") ? text.slice(1) : text;
  } catch {
    throw new ProviderError(
      "SCHEMA_REJECTED",
      `${name.slice(0, 120)} is not UTF-8 text`,
      "Export the results as UTF-8; EBCDIC or binary exports are not read.",
    );
  }
}
