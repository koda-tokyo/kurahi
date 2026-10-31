// `kurahi industrial …` — Industrial edition tools outside the gateway.
//
//   kurahi industrial providers [--json]             the modernisation provider registry
//   kurahi industrial import --project <id>          import exported vendor results
//        --provider <google-mat|aws-transform|ibm-z>
//        --bundle <path>                             the exported .zip or folder with its manifest
//        [--json]
//   kurahi industrial imports --project <id> [--json]  imports already in a Project
//
// The import runs the same pipeline as the modernise_import agent tool (registry gate, bundle
// limits, manifest hashes, malware scan with security.attachments, schema check, signed
// evidence). Exit codes: 0 imported or duplicate, 1 refused or failed, 2 usage.
import type { Command } from "commander";
import path from "node:path";
import { listProviders } from "../industrial/providers.js";
import { importVendorBundle, type VendorImportDeps } from "../industrial/vendor-import/pipeline.js";
import { listImportSummaries } from "../industrial/vendor-import/view.js";
import { getProject } from "../projects/store.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";

export const IMPORT_PROVIDERS = ["google-mat", "aws-transform", "ibm-z"] as const;

type Deps = { runtime?: RuntimeEnv; importDeps?: VendorImportDeps; actor?: string };

function usage(runtime: RuntimeEnv, message: string): void {
  runtime.error(`kurahi industrial: ${message}`);
  runtime.exit(2);
}

export function runIndustrialProviders(opts: { json?: boolean }, deps: Deps = {}): void {
  const runtime = deps.runtime ?? defaultRuntime;
  const providers = listProviders();
  if (opts.json) {
    runtime.log(JSON.stringify({ providers }, null, 2));
    return;
  }
  for (const p of providers) {
    runtime.log(`${p.provider_id}  ${p.access_mode}  ${p.status}  ${p.product_family}`);
    if (p.status === "DISABLED") {
      runtime.log(`  ${p.reason}`);
    }
    for (const f of p.formats) {
      runtime.log(`  ${f.id}  ${f.verification}  ${f.label}`);
      for (const d of f.docs) {
        runtime.log(`    ${d}`);
      }
    }
  }
}

export async function runIndustrialImport(
  opts: { project?: string; provider?: string; bundle?: string; json?: boolean },
  deps: Deps = {},
): Promise<void> {
  const runtime = deps.runtime ?? defaultRuntime;
  if (!opts.project || !opts.provider || !opts.bundle) {
    usage(runtime, "--project <id>, --provider <id> and --bundle <path> are required");
    return;
  }
  if (!(IMPORT_PROVIDERS as readonly string[]).includes(opts.provider)) {
    usage(runtime, `--provider must be one of ${IMPORT_PROVIDERS.join(", ")}`);
    return;
  }
  if (!getProject(opts.project, deps.importDeps?.home)) {
    usage(runtime, `no Project with id ${opts.project}`);
    return;
  }
  const r = await importVendorBundle(
    {
      projectId: opts.project,
      provider: opts.provider,
      bundle: path.resolve(opts.bundle),
      actor: deps.actor ?? "cli",
    },
    deps.importDeps,
  );
  if (opts.json) {
    runtime.log(
      JSON.stringify(
        r.status === "refused" ? r : { ...r, record: undefined, ...summaryOf(r.record) },
        null,
        2,
      ),
    );
  } else if (r.status === "refused") {
    runtime.error(`Refused at ${r.stage}: ${r.code}. ${r.reason}`);
    runtime.error(r.remediation);
    if (r.evidence) {
      runtime.error(`Evidence: ${r.evidence.bundle}`);
    }
  } else {
    const c = r.record.counts;
    runtime.log(
      `${r.status === "duplicate" ? "Already imported" : "Imported"} ${r.importId}: ${r.record.provider} ${r.record.format} (${r.record.verification}).`,
    );
    runtime.log(
      `Items ${c.items}, edges ${c.edges}, rules ${c.rules}, findings ${c.findings}. Unverified until reviewed.`,
    );
  }
  if (r.status === "refused") {
    runtime.exit(1);
  }
}

function summaryOf(rec: {
  provider: string;
  format: string;
  verification: string;
  counts: unknown;
  docs: string[];
}) {
  return {
    provider: rec.provider,
    format: rec.format,
    verification: rec.verification,
    counts: rec.counts,
    docs: rec.docs,
  };
}

export function runIndustrialImports(opts: { project?: string; json?: boolean }, deps: Deps = {}) {
  const runtime = deps.runtime ?? defaultRuntime;
  if (!opts.project) {
    usage(runtime, "--project <id> is required");
    return;
  }
  const list = listImportSummaries(opts.project, deps.importDeps?.home);
  if (opts.json) {
    runtime.log(JSON.stringify({ imports: list }, null, 2));
    return;
  }
  if (list.length === 0) {
    runtime.log("No vendor imports in this Project.");
  }
  for (const i of list) {
    runtime.log(
      `${i.importId}  ${i.provider}  ${i.format}  ${i.verification}  ${i.importedAt}  items ${i.counts.items} edges ${i.counts.edges} rules ${i.counts.rules}`,
    );
  }
}

export function registerIndustrialCli(program: Command) {
  const cmd = program
    .command("industrial")
    .description("Industrial edition: modernisation providers and vendor results import");

  cmd
    .command("providers")
    .description("List modernisation providers, their access modes, formats and status")
    .option("--json", "print JSON")
    .action((opts: { json?: boolean }) => runIndustrialProviders(opts));

  cmd
    .command("import")
    .description("Import results exported from a vendor modernisation tool into a Project")
    .option("--project <id>", "the Project that receives the import")
    .option("--provider <id>", IMPORT_PROVIDERS.join(", "))
    .option("--bundle <path>", "the exported .zip or folder with its kurahi-import.json manifest")
    .option("--json", "print JSON")
    .action(
      async (opts: { project?: string; provider?: string; bundle?: string; json?: boolean }) => {
        try {
          await runIndustrialImport(opts);
        } catch (err) {
          defaultRuntime.error(
            `kurahi industrial import: ${err instanceof Error ? err.message : String(err)}`,
          );
          defaultRuntime.exit(1);
        }
      },
    );

  cmd
    .command("imports")
    .description("List the vendor imports of a Project")
    .option("--project <id>", "the Project")
    .option("--json", "print JSON")
    .action((opts: { project?: string; json?: boolean }) => runIndustrialImports(opts));
}
