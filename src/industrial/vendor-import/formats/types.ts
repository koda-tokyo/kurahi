import type { ImportManifest } from "../manifest.js";
import type { NormalisedArtefacts } from "../model.js";

export type DataFile = { path: string; sha256: string; bytes: Buffer };

export type ParseInput = {
  manifest: ImportManifest;
  /** Files with role `data`, in manifest order. */
  data: DataFile[];
  /** The `mapping` file, when the manifest lists one. */
  mapping: DataFile | null;
};

export type ParseResult = {
  artefacts: NormalisedArtefacts;
  /** SHA-256 over the structural signature (record shapes, headings, columns), not the content. */
  fingerprint: string;
  fingerprintDetail: string[];
};
