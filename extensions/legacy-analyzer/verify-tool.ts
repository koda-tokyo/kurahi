import { Type } from "@sinclair/typebox";
import fs from "node:fs";
import path from "node:path";
import { summarizeReport, verifyChange } from "../../src/modernisation/verify.js";
import { parseProjectSessionKey } from "../../src/projects/scope.js";
import { projectDataDir } from "../../src/projects/store.js";
import { failure, str } from "./results.js";

// modernise_verify: the modernisation verification engine (src/modernisation/) as an agent tool.
// Freezes the baseline and candidate folders as immutable snapshots, compiles both with the local
// toolchain (GnuCOBOL cobc, gfortran; PL/I reports NOT_RUN_COMPILER_UNAVAILABLE), runs them on
// the same fixtures in a scratch folder under limits, compares outputs deterministically and
// seals a signed evidence bundle for every outcome. Read-only on the sources: every path must be
// inside the workspace (the permission guard also classifies the call as reads of these paths);
// writes go only to the Project's data area (<KOLO_HOME>/projects/<id>/modernisation/), or the
// state directory outside a Project. It executes the compiled programs, so it is not offered in
// 参照 Read or 計画 Plan modes.

type Deps = {
  base: string;
  sessionKey: string | undefined;
  env: { stateDir: string };
};

export function verifyDataDir(sessionKey: string | undefined, stateDir: string): string {
  const ref = parseProjectSessionKey(sessionKey);
  return ref
    ? path.join(projectDataDir(ref.projectId), "modernisation")
    : path.join(stateDir, "modernisation");
}

function inside(base: string, raw: unknown, what: string, required: boolean): string | null {
  const p = str(raw);
  if (!p) {
    if (required) {
      throw new Error(`${what} is required`);
    }
    return null;
  }
  const real = (x: string) => (fs.existsSync(x) ? fs.realpathSync(x) : x);
  const root = real(path.resolve(base));
  const abs = real(path.resolve(base, p));
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`${what} must be inside the workspace (${base})`);
  }
  return abs;
}

export function verifyTools({ base, sessionKey, env }: Deps) {
  const pathDesc = (what: string) => Type.String({ description: `${what} (inside the workspace)` });
  return [
    {
      name: "modernise_verify",
      label: "Verify a modernisation change",
      description:
        "Verify a candidate against its baseline by execution: freezes both folders as immutable SHA-256 snapshots, " +
        "compiles them (COBOL with GnuCOBOL, FORTRAN with gfortran; PL/I has no compiler here and returns " +
        "NOT_RUN_COMPILER_UNAVAILABLE), runs both on the same fixtures (one sub-folder per case: stdin, args, files/, " +
        "golden/) in a scratch folder with a timeout, output caps and no network where the host allows, and compares " +
        "outputs: exact bytes by default, or per the change spec (record-wise text, fixed-position decimal and COMP-3 " +
        "fields with an explicit tolerance, declared intended differences). Verdicts: PASS, FAIL, INCONCLUSIVE, " +
        "NOT_RUN_COMPILER_UNAVAILABLE, NOT_RUN_NO_FIXTURES, TIMEOUT, CANCELLED; never PASS without a compiler, " +
        "fixtures or a finished run. Every outcome is sealed as signed evidence (kurahi evidence verify <bundle>). " +
        "A PASS shows equivalence on these fixtures only, not semantic correctness in general: say so.",
      parameters: Type.Object({
        baseline: pathDesc("Folder with the original sources"),
        candidate: pathDesc("Folder with the changed sources"),
        fixtures: Type.Optional(pathDesc("Folder of fixture cases")),
        change_spec: Type.Optional(
          pathDesc("Change spec JSON (comparators and intended differences)"),
        ),
        entry: Type.Optional(
          Type.String({ description: "Entry program path inside the snapshot, when ambiguous" }),
        ),
        dialect: Type.Optional(
          Type.String({ description: "COBOL dialect for cobc -std= (default: compiler default)" }),
        ),
        timeout_seconds: Type.Optional(
          Type.Number({ description: "Per compile/execution timeout, 1-600 (default 60)" }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>, signal?: AbortSignal) {
        try {
          const timeout =
            typeof params.timeout_seconds === "number" ? params.timeout_seconds : undefined;
          if (
            timeout !== undefined &&
            (!Number.isFinite(timeout) || timeout < 1 || timeout > 600)
          ) {
            throw new Error("timeout_seconds must be from 1 to 600");
          }
          const dialect = str(params.dialect);
          if (dialect && !/^[A-Za-z0-9._+-]{1,32}$/.test(dialect)) {
            throw new Error("dialect must be a cobc -std name such as ibm, mf or default");
          }
          const out = await verifyChange({
            dataDir: verifyDataDir(sessionKey, env.stateDir),
            baselineDir: inside(base, params.baseline, "baseline", true)!,
            candidateDir: inside(base, params.candidate, "candidate", true)!,
            fixturesDir: inside(base, params.fixtures, "fixtures", false),
            changeSpecFile: inside(base, params.change_spec, "change_spec", false),
            policy: {
              entry: str(params.entry) || null,
              dialect: dialect || null,
              ...(timeout
                ? {
                    limits: {
                      timeoutMs: timeout * 1000,
                      maxOutputBytes: 4 * 1024 * 1024,
                      cpuSeconds: Math.ceil(timeout),
                    },
                  }
                : {}),
            },
            signal,
          });
          const r = out.report;
          return {
            content: [
              { type: "text" as const, text: summarizeReport(r, out.bundleDir).join("\n") },
            ],
            details: {
              ok: true,
              verdict: r.verdict,
              runId: r.runId,
              bundle: out.bundleDir,
              counts: r.counts,
            },
          };
        } catch (err) {
          return failure(err);
        }
      },
    },
  ];
}
