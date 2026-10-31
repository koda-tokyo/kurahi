import { Type, type TSchema } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { optionalStringEnum } from "../../src/agents/schema/typebox.js";
import { listProviders } from "../../src/industrial/providers.js";
import {
  importVendorBundle,
  type VendorImportDeps,
} from "../../src/industrial/vendor-import/pipeline.js";
import { listImportSummaries } from "../../src/industrial/vendor-import/view.js";
import { parseProjectSessionKey } from "../../src/projects/scope.js";
import { getProject, projectMode } from "../../src/projects/store.js";
import { failure, result, str } from "./results.js";

// modernise_import: vendor modernisation results (exported from the vendor's own tool) into the
// current Project, through the import pipeline (src/industrial/vendor-import/pipeline.ts):
// registry gate, bundle limits, manifest hashes, malware scan, per-format parser, signed
// evidence. The bundle must be inside the Project folder (the permission guard classifies the
// call as a read of `path`); the imported data goes to the Project's state, never the folder.
// Nothing is sent to any vendor: direct execution modes are listed as DISABLED.

type Deps = {
  pathParam: TSchema;
  sessionKey: () => string | undefined;
  agentId: () => string;
  /** Tests: scanner and configuration of the import pipeline. */
  importDeps?: VendorImportDeps;
};

function within(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function currentProject(sessionKey: string | undefined) {
  const ref = parseProjectSessionKey(sessionKey);
  const project = ref ? getProject(ref.projectId) : null;
  if (!project || project.archived) {
    throw new Error("vendor imports belong to a Project: open this conversation inside a Project.");
  }
  return project;
}

export function importTools({ sessionKey, agentId, importDeps }: Deps) {
  return [
    {
      name: "modernise_import",
      label: "Vendor results import",
      description:
        "Import modernisation results exported from a vendor tool into this Project, or list what is available. " +
        "action providers: the provider registry (offline import formats with their verification status and " +
        "documentation links; direct vendor execution is listed as disabled, never call it available). " +
        "action list: imports already in this Project. action import: path is the exported bundle (.zip or " +
        "folder inside the Project) with its kurahi-import.json manifest; provider is google-mat, aws-transform " +
        "or ibm-z. The bundle is checked (hashes, limits, malware scan, schema) and refused with a reason when it " +
        "fails. Imported items, edges and rules are the vendor's claims, unverified until reviewed: " +
        "modernise_inventory (kind imported) and modernise_impact show them separately, labelled. Plan or Act mode.",
      parameters: Type.Object({
        action: optionalStringEnum(["import", "list", "providers"] as const, {
          description: "import (default), list or providers",
        }),
        path: Type.Optional(
          Type.String({ description: "The exported bundle (.zip or folder) in the Project" }),
        ),
        provider: Type.Optional(Type.String({ description: "google-mat, aws-transform or ibm-z" })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        try {
          const action = str(params.action) || "import";
          if (action === "providers") {
            return result({ providers: listProviders() });
          }
          const project = currentProject(sessionKey());
          if (action === "list") {
            return result({ imports: listImportSummaries(project.id) });
          }
          if (action !== "import") {
            throw new Error('action must be "import", "list" or "providers".');
          }
          const mode = projectMode(project);
          if (mode === "read") {
            throw new Error(
              "the Project is in 参照 Read mode; importing needs 計画 Plan or 実行 Act mode.",
            );
          }
          const provider = str(params.provider);
          const rel = str(params.path);
          if (!provider || !rel) {
            throw new Error("path (the bundle) and provider are required.");
          }
          const folder = fs.realpathSync(project.folder);
          const target = path.resolve(folder, rel);
          let real: string;
          try {
            real = fs.realpathSync(target);
          } catch {
            throw new Error("the bundle path does not exist.");
          }
          if (!within(real, folder) || real !== target) {
            throw new Error("the bundle must be a plain path inside the Project folder.");
          }
          const r = await importVendorBundle(
            {
              projectId: project.id,
              provider,
              bundle: real,
              actor: agentId(),
              sessionKey: sessionKey(),
            },
            importDeps,
          );
          if (r.status === "refused") {
            return result(r);
          }
          return result({
            status: r.status,
            importId: r.importId,
            provider: r.record.provider,
            format: r.record.format,
            verification: r.record.verification,
            docs: r.record.docs,
            counts: r.record.counts,
            note: "Imported data is the vendor's claim, unverified until a person reviews it.",
          });
        } catch (err) {
          return failure(err);
        }
      },
    },
  ];
}
