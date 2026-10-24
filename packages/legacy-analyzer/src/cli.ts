// Command line: generate the design document or the wave plan for a folder of legacy sources.
//
//   node --import tsx packages/legacy-analyzer/src/cli.ts design-doc <path> [--lang ja|en]
//        [--section overview,jobs,programs,dictionary,crud,coverage] [--program NAME] [--out FILE]
//   node --import tsx packages/legacy-analyzer/src/cli.ts wave-plan <path> [--lang ja|en] [--out FILE]
//
// The sources are only read. Without --out the Markdown goes to standard output.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DOC_SECTIONS, type DocSection, designDoc } from "./design-doc.js";
import { parseLang } from "./doc-i18n.js";
import { buildIndex } from "./indexer.js";
import { renderWavePlan } from "./wave-plan-md.js";

const USAGE =
  "Usage: cli.ts <design-doc|wave-plan> <path> [--lang ja|en] [--section a,b] [--program NAME] [--out FILE]";

export type CliIo = { out: (s: string) => void; err: (s: string) => void };

export function runCli(argv: string[], io: CliIo): number {
  const [command, root, ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([a-z]+)(?:=(.*))?$/.exec(rest[i]);
    if (!m) {
      io.err(`Unexpected argument: ${rest[i]}\n${USAGE}`);
      return 2;
    }
    flags.set(m[1], m[2] ?? rest[++i] ?? "");
  }
  if (!command || !root || !["design-doc", "wave-plan"].includes(command)) {
    io.err(USAGE);
    return 2;
  }
  const lang = flags.has("lang") ? parseLang(flags.get("lang")) : "ja";
  if (!lang) {
    io.err(`--lang must be ja or en.\n${USAGE}`);
    return 2;
  }
  const sections = (flags.get("section") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const unknown = sections.filter((x) => !(DOC_SECTIONS as readonly string[]).includes(x));
  if (unknown.length > 0) {
    io.err(`Unknown section: ${unknown.join(", ")}. Known: ${DOC_SECTIONS.join(", ")}.`);
    return 2;
  }
  try {
    const index = buildIndex(path.resolve(root));
    const markdown =
      command === "design-doc"
        ? designDoc(index, {
            lang,
            sections: sections as DocSection[],
            program: flags.get("program"),
          }).markdown
        : renderWavePlan(index, lang);
    const out = flags.get("out");
    if (out) {
      fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
      fs.writeFileSync(path.resolve(out), markdown, "utf8");
      io.err(`Wrote ${out}`);
    } else {
      io.out(markdown);
    }
    return 0;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = runCli(process.argv.slice(2), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(`${s}\n`),
  });
}
