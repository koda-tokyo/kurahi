// Test fixtures for the runner (KIMS-014). A fixtures folder holds one sub-folder per case:
//
//   <case>/stdin        optional: bytes fed to standard input
//   <case>/args         optional: one program argument per line
//   <case>/files/       optional: input files placed in the run folder (flat)
//   <case>/golden/      optional: outputs the BASELINE must reproduce exactly (stdout, stderr,
//                       exit, or an output file name)
//
// The same fixtures feed baseline and candidate. Their digest is part of every report.
import fs from "node:fs";
import path from "node:path";
import { canonicalJson, sha256Hex } from "../continuity-suite/manifest.js";

export type FixtureCase = {
  name: string;
  stdin: Buffer | null;
  args: string[];
  files: Map<string, Buffer>;
  golden: Map<string, Buffer>;
};

export const FIXTURE_LIMITS = { maxCases: 200, maxFileBytes: 16 * 1024 * 1024, maxFiles: 64 };
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function readFlat(dir: string, what: string): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  if (!fs.existsSync(dir)) {
    return out;
  }
  for (const e of fs
    .readdirSync(dir, { withFileTypes: true })
    .toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!e.isFile() || !NAME_RE.test(e.name)) {
      throw new Error(`${what}: ${e.name} is not a plain file with a simple name`);
    }
    const abs = path.join(dir, e.name);
    if (fs.statSync(abs).size > FIXTURE_LIMITS.maxFileBytes) {
      throw new Error(`${what}: ${e.name} is over ${FIXTURE_LIMITS.maxFileBytes} bytes`);
    }
    out.set(e.name, fs.readFileSync(abs));
    if (out.size > FIXTURE_LIMITS.maxFiles) {
      throw new Error(`${what}: more than ${FIXTURE_LIMITS.maxFiles} files`);
    }
  }
  return out;
}

/** Load the cases of a fixtures folder; a missing or empty folder gives no cases. */
export function loadFixtures(dir: string | null): { cases: FixtureCase[]; digest: string } {
  const cases: FixtureCase[] = [];
  if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
    const subdirs = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name)
      .toSorted();
    if (subdirs.length > FIXTURE_LIMITS.maxCases) {
      throw new Error(`more than ${FIXTURE_LIMITS.maxCases} fixture cases`);
    }
    for (const name of subdirs) {
      if (!NAME_RE.test(name)) {
        throw new Error(`fixture case name ${name} is not a simple name`);
      }
      const root = path.join(dir, name);
      const stdinFile = path.join(root, "stdin");
      const argsFile = path.join(root, "args");
      cases.push({
        name,
        stdin: fs.existsSync(stdinFile) ? fs.readFileSync(stdinFile) : null,
        args: fs.existsSync(argsFile)
          ? fs
              .readFileSync(argsFile, "utf8")
              .split("\n")
              .map((l) => l.replace(/\r$/, ""))
              .filter(Boolean)
          : [],
        files: readFlat(path.join(root, "files"), `${name}/files`),
        golden: readFlat(path.join(root, "golden"), `${name}/golden`),
      });
    }
  }
  const digestOf = (m: Map<string, Buffer>) =>
    Object.fromEntries([...m].map(([k, v]) => [k, sha256Hex(v)]));
  const digest = sha256Hex(
    canonicalJson(
      cases.map((c) => ({
        name: c.name,
        stdin: c.stdin ? sha256Hex(c.stdin) : null,
        args: c.args,
        files: digestOf(c.files),
        golden: digestOf(c.golden),
      })),
    ),
  );
  return { cases, digest };
}
